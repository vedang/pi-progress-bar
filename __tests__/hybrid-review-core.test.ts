import { expect, it } from "vitest";
import { extractionInput } from "../src/analysis/extractor";
import { gateRequest } from "../src/analysis/gate";
import { processObservation } from "../src/core/hybrid";
import {
  encodeCheckpoint,
  restoreCheckpoint,
} from "../src/core/hybrid-checkpoint";
import { emptyState, type HybridState } from "../src/core/hybrid-state";
import {
  addPatch,
  backend,
  initial,
  initialMessage,
  noPatch,
  observation,
} from "./fixtures/hybrid";

async function ledger(total: number, active: number, long = false) {
  const state = await initial();
  const task = state.tasks[0];
  const event = state.events[0];
  if (!task || !event) throw new Error("Missing seed");
  state.tasks = Array.from({ length: total }, (_, i) => ({
    ...structuredClone(task),
    id: `task:${i + 1}`,
    label: long ? `${i} ${"界".repeat(230)}` : `Deliverable ${i + 1}`,
    included: i >= total - active,
  }));
  state.events = state.tasks.map((task, i) => ({
    ...structuredClone(event),
    id: `event:${i + 1}`,
    taskId: task.id,
  }));
  state.nextTaskId = total + 1;
  // This is a legal bounded checkpoint, not a malformed oversized input.
  expect(
    restoreCheckpoint(
      encodeCheckpoint(state),
      "session:test",
      () => initialMessage,
      () => [],
    ),
  ).toBeDefined();
  return state;
}

it.each([
  [20, 20],
  [200, 1],
])(
  "keeps rejected %i-total/%i-active capacity explicitly unresolved and uncommitted",
  async (total, active) => {
    const state = await ledger(total, active);
    const message = observation("new-work", "Deliver a separate new report.");
    const result = await processObservation(
      state,
      message,
      backend(addPatch(message, ["Deliver new report"])),
    );
    expect(result.tasks.map(({ id, status }) => ({ id, status }))).toEqual(
      state.tasks.map(({ id, status }) => ({ id, status })),
    );
    expect(result.cursor).toEqual(state.cursor);
    expect(result.pending?.phase).toBe("extract");
    expect(result.pending?.block).toEqual({
      present: true,
      value: "task-capacity",
    });
  },
);

it("rejects malformed extraction visibly instead of presenting the previous ledger as current", async () => {
  const state = await initial();
  const p = backend();
  p.extract.mockResolvedValue("not JSON");
  const result = await processObservation(
    state,
    observation("bad-patch", "Also produce the report."),
    p,
  );
  expect(result.tasks.map((task) => task.id)).toEqual(
    state.tasks.map((task) => task.id),
  );
  expect(result.scopeUnresolved).toBe(state.scopeUnresolved);
  expect(result.pending?.block).toEqual({
    present: true,
    value: "invalid-patch",
  });
});

it("gate construction overflow cannot masquerade as an accepted completion phase", async () => {
  const state = await ledger(20, 20, true);
  const p = backend();
  const result = await processObservation(
    state,
    observation("gate-overflow", "x".repeat(11 * 1024)),
    p,
  );
  expect(p.evaluate).not.toHaveBeenCalled();
  expect(result.scopeUnresolved).toBe(true);
  expect(result.pending?.phase).not.toBe("complete");
});

it("projects legal archived ledgers within 8KiB archive and 24KiB request budgets", async () => {
  const state = await ledger(200, 1, true);
  const input = extractionInput(
    state,
    observation("next", "Continue current work."),
    [],
  );
  const archived = input.tasks.filter((task) => !task.included);
  expect(
    input.tasks.filter((task) => task.included).map((task) => task.id),
  ).toEqual(["task:200"]);
  expect(archived.length).toBeGreaterThan(0);
  expect(archived.map((task) => task.id)).toContain("task:199");
  expect(archived.map((task) => task.id)).not.toContain("task:1");
  expect(Buffer.byteLength(JSON.stringify(archived))).toBeLessThanOrEqual(
    8 * 1024,
  );
  expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(
    24 * 1024,
  );
  expect(input).toHaveProperty("omittedArchivedTasks", 199 - archived.length);
  expect(state.tasks).toHaveLength(200);
});

it("does not restore an omitted archive target by guessing its identity", async () => {
  const state = await ledger(200, 1, true);
  const message = observation(
    "old-restore",
    "Restore the very first deliverable.",
  );
  const p = backend({
    ...noPatch(),
    restore: [
      {
        id: "task:1",
        label: "Old deliverable",
        requirementsChanged: false,
        quote: message.text,
      },
    ],
  });
  const result = await processObservation(state, message, p);
  expect(p.extract).toHaveBeenCalledTimes(1);
  expect(result.tasks[0]?.included).toBe(false);
  expect(result.pending?.block).toEqual({
    present: true,
    value: "invalid-patch",
  });
});

async function snapshots() {
  const saved: HybridState[] = [];
  await processObservation(
    emptyState("session:test"),
    initialMessage,
    backend(addPatch(initialMessage), {
      save: (state) => saved.push(structuredClone(state)),
    }),
  );
  return saved;
}

it.each([
  "missing-gate",
  "wrong-gate",
  "forged-phase",
  "wrong-patch",
  "wrong-completion",
])(
  "rejects an internally inconsistent accepted-phase proof: %s",
  async (variant) => {
    const saved = await snapshots();
    const state = saved.find((item) =>
      variant === "wrong-completion"
        ? !!item.pending?.journal.completions.flatMap(
            (record) => record.chunkIds,
          ).length
        : variant === "wrong-patch"
          ? item.pending?.phase === "complete" && item.tasks.length > 0
          : item.pending?.phase === "extract",
    );
    if (!state) throw new Error("Missing accepted journal fixture");
    const checkpoint = encodeCheckpoint(state);
    const pending = checkpoint.state.pending;
    if (!pending) throw new Error("Missing pending phase");
    if (variant === "missing-gate")
      Reflect.deleteProperty(pending.journal, "gate");
    if (variant === "wrong-gate")
      pending.journal.gate.requestHash = "a".repeat(64);
    if (variant === "forged-phase") pending.phase = "complete";
    if (variant === "wrong-patch") {
      if (!pending.journal.patch) throw new Error("Missing patch record");
      pending.journal.patch.requestHash = "b".repeat(64);
    }
    if (variant === "wrong-completion") {
      const completion = pending.journal.completions[0];
      if (!completion) throw new Error("Missing completion record");
      completion.requestHash = "c".repeat(64);
    }
    expect(
      restoreCheckpoint(
        checkpoint,
        "session:test",
        () => initialMessage,
        () => [],
      ),
    ).toBeUndefined();
  },
);

it("exposes extraction construction overflow even when the smaller gate request fits", async () => {
  const state = await ledger(20, 20, true);
  let target: ReturnType<typeof observation> | undefined;
  for (let size = 64; size <= 12 * 1024; size += 64) {
    const message = observation("extract-overflow", "x".repeat(size));
    try {
      gateRequest(state, message, []);
    } catch {
      continue;
    }
    try {
      extractionInput(state, message, []);
    } catch {
      target = message;
      break;
    }
  }
  if (!target)
    throw new Error("Fixture must fit gate but exceed extraction input bound");
  const p = backend();
  const result = await processObservation(state, target, p);
  expect(p.extract).not.toHaveBeenCalled();
  expect(result.scopeUnresolved).toBe(state.scopeUnresolved);
  expect(result.pending?.block).toEqual({
    present: true,
    value: "input-overflow",
  });
});

it.each(["label", "kind", "completed-label", "completion-event"])(
  "binds accepted unchanged-gate and completion phases to semantic inputs: %s",
  async (variant) => {
    const state = await initial();
    const latest = observation(
      "proof-report",
      "All three requested deliverables are complete.",
      "assistant",
    );
    const saved: HybridState[] = [];
    await processObservation(
      state,
      latest,
      backend(noPatch(), {
        gate: "unchanged",
        complete: "yes",
        save: (state) => saved.push(structuredClone(state)),
      }),
    );
    const partial = saved.find(
      (state) =>
        state.pending?.phase === "complete" &&
        (variant.startsWith("complet")
          ? !!state.pending.journal.completions.flatMap(
              (record) => record.chunkIds,
            ).length
          : !state.pending.journal.completions.flatMap(
              (record) => record.chunkIds,
            ).length),
    );
    if (!partial) throw new Error("Missing accepted unchanged journal");
    const checkpoint = encodeCheckpoint(partial);
    const task = checkpoint.state.tasks[0];
    if (!task) throw new Error("Missing task");
    if (variant === "label" || variant === "completed-label")
      task.label = "Produce an unrelated report";
    if (variant === "kind") task.kind = "response";
    if (variant === "completion-event") {
      const event = checkpoint.state.events.find(
        (event) => event.kind === "complete",
      );
      if (!event) throw new Error("Missing completion mutation");
      event.kind = "withdraw";
    }
    expect(
      restoreCheckpoint(
        checkpoint,
        "session:test",
        (id) => [initialMessage, latest].find((message) => message.id === id),
        () => [],
      ),
    ).toBeUndefined();
  },
);

it("binds an accepted gate to the canonical earlier context used by its request", async () => {
  const context = observation(
    "context-authority",
    "The parser means the streaming parser.",
    "assistant",
  );
  const latest = observation("context-question", "Explain that parser.");
  const saved: HybridState[] = [];
  await processObservation(
    await initial(),
    latest,
    backend(noPatch(), { save: (state) => saved.push(structuredClone(state)) }),
    [context],
  );
  const gated = saved.find((state) => state.pending?.phase === "extract");
  if (!gated) throw new Error("Missing gate snapshot");
  const checkpoint = encodeCheckpoint(gated);
  const amended = observation(
    context.id,
    "The parser means the batch parser.",
    "assistant",
  );
  expect(
    restoreCheckpoint(
      checkpoint,
      "session:test",
      (id) =>
        [initialMessage, amended, latest].find((message) => message.id === id),
      () => [],
    ),
  ).toBeUndefined();
});
