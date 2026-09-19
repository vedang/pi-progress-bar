import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { extractionInput } from "../src/analysis/extractor";
import { gateRequest } from "../src/analysis/gate";
import { processObservation } from "../src/core/hybrid";
import {
  encodeCheckpoint,
  restoreCheckpoint,
} from "../src/core/hybrid-checkpoint";
import {
  emptyState,
  type HybridState,
  type Observation,
} from "../src/core/hybrid-state";
import {
  backend,
  initial,
  initialMessage,
  noPatch,
  observation,
} from "./fixtures/hybrid";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function restore(
  state: HybridState,
  messages: Observation[],
  context: Observation[] = [],
) {
  // Fourth argument is canonical-order authority, deliberately independent of
  // the stored proof. Current implementation ignores it; the repair must not.
  return Reflect.apply(restoreCheckpoint, undefined, [
    {
      ...encodeCheckpoint(emptyState("session:test")),
      state: structuredClone(state),
    },
    "session:test",
    (id: string) => messages.find((message) => message.id === id),
    () => context,
  ]);
}
async function journal(
  gate: "changed" | "unchanged",
  complete = "no",
  base?: HybridState,
  context: Observation[] = [],
) {
  const state = base ?? (await initial());
  const latest = observation(
    "third-review",
    "Report the state of all requested deliverables.",
    "assistant",
  );
  const saved: HybridState[] = [];
  await processObservation(
    state,
    latest,
    backend(noPatch(), {
      gate,
      complete,
      save: (value) => saved.push(structuredClone(value)),
    }),
    context,
  );
  return {
    state,
    latest,
    saved,
    messages: [initialMessage, ...context, latest],
  };
}

it.each(["label", "kind"])(
  "rejects changed-gate task %s mutations before extraction",
  async (field) => {
    const j = await journal("changed");
    const accepted = j.saved.find(
      (state) => state.pending?.phase === "extract",
    );
    if (!accepted?.tasks[0]) throw new Error("Missing accepted gate");
    expect(restore(accepted, j.messages)).toBeDefined();
    if (field === "label") accepted.tasks[0].label = "An unrelated deliverable";
    else accepted.tasks[0].kind = "response";
    expect(restore(accepted, j.messages)).toBeUndefined();
  },
);

it.each(["status", "active-set"])(
  "rejects unchanged-gate %s mutation",
  async (variant) => {
    const base = await initial();
    const archived = base.tasks[2];
    if (!archived) throw new Error("Missing archive candidate");
    if (variant === "active-set") archived.included = false;
    const j = await journal("unchanged", "no", base);
    const accepted = j.saved.find(
      (state) =>
        state.pending?.phase === "complete" &&
        !state.pending.journal.completions.flatMap((record) => record.chunkIds)
          .length,
    );
    if (!accepted?.tasks[0] || !accepted.tasks[2])
      throw new Error("Missing accepted unchanged gate");
    expect(restore(accepted, j.messages)).toBeDefined();
    if (variant === "status") accepted.tasks[0].status = "done";
    else accepted.tasks[2].included = true;
    expect(restore(accepted, j.messages)).toBeUndefined();
  },
);

it("reconstructs actual gate input rather than trusting a rehashed forged projection", async () => {
  const j = await journal("changed");
  const accepted = j.saved.find((state) => state.pending?.phase === "extract");
  const proof = accepted?.pending?.journal.gate;
  const forged = structuredClone(j.state);
  if (!accepted || !proof || !forged.tasks[0])
    throw new Error("Missing gate proof");
  forged.tasks[0].label = "Forged gate-only deliverable";
  proof.requestHash = hash(gateRequest(forged, j.latest, []));
  expect(restore(accepted, j.messages)).toBeUndefined();
});

it.each(["missing", "historical-substitute", "reordered-state"])(
  "binds exact completion event delta: %s",
  async (variant) => {
    const j = await journal("unchanged", "yes");
    const accepted = j.saved.find(
      (state) =>
        !!state.pending?.journal.completions.flatMap(
          (record) => record.chunkIds,
        ).length,
    );
    const proof = accepted?.pending?.journal.completions[0];
    if (!accepted || !proof || !accepted.events[0])
      throw new Error("Missing completion event fixture");
    expect(restore(accepted, j.messages)).toBeDefined();
    if (variant === "missing") accepted.events.splice(proof.undo.eventLength);
    else if (variant === "historical-substitute") {
      const event = accepted.events[proof.undo.eventLength];
      if (!event) throw new Error("Missing derived event");
      Object.assign(event, structuredClone(accepted.events[0]), {
        id: event.id,
      });
    } else accepted.events.reverse();
    expect(restore(accepted, j.messages)).toBeUndefined();
  },
);

it("preserves a genuine empty completion event delta", async () => {
  const j = await journal("unchanged");
  const accepted = j.saved.find(
    (state) =>
      !!state.pending?.journal.completions.flatMap((record) => record.chunkIds)
        .length,
  );
  if (!accepted) throw new Error("Missing completion fixture");
  expect(accepted.events).toEqual(j.state.events);
  expect(accepted.pending?.journal.completions[0]?.undo.eventLength).toBe(
    j.state.events.length,
  );
  expect(restore(accepted, j.messages)).toBeDefined();
});

it.each(["reordered", "inserted"])(
  "checks canonical context chronology when texts remain unchanged: %s",
  async (variant) => {
    const a = observation("earlier-a", "First clarification.");
    const b = observation("earlier-b", "Second clarification.", "assistant");
    const inserted = observation("inserted", "New intervening clarification.");
    const j = await journal("changed", "no", undefined, [a, b]);
    const accepted = j.saved.find(
      (state) => state.pending?.phase === "extract",
    );
    if (!accepted) throw new Error("Missing context fixture");
    expect(restore(accepted, j.messages, [a, b])).toBeDefined();
    const context = variant === "reordered" ? [b, a] : [b, inserted];
    expect(
      restore(accepted, [initialMessage, a, b, inserted, j.latest], context),
    ).toBeUndefined();
  },
);

it("binds every admitted archived extraction input and omitted count without duplicate projections", async () => {
  const base = await initial();
  const task = base.tasks[0],
    event = base.events[0];
  if (!task || !event) throw new Error("Missing seed");
  base.tasks = Array.from({ length: 200 }, (_, i) => ({
    ...structuredClone(task),
    id: `task:${i + 1}`,
    label: `${i} ${"界".repeat(230)}`,
    included: i === 199,
  }));
  base.events = base.tasks.map((item, i) => ({
    ...structuredClone(event),
    id: `event:${i + 1}`,
    taskId: item.id,
  }));
  base.nextTaskId = 201;
  const j = await journal("changed", "no", base);
  const accepted = j.saved.find((state) => !!state.pending?.journal.patch);
  const input = extractionInput(base, j.latest, []);
  expect(input.tasks.some((item) => !item.included)).toBe(true);
  const patch = accepted?.pending?.journal.patch;
  if (!accepted || !patch) throw new Error("Missing archive request record");
  expect(patch.requestHash).toBe(hash(input));
  expect(patch).not.toHaveProperty("tasks");
  expect(restore(accepted, j.messages)).toBeDefined();
  patch.requestHash = hash({
    ...input,
    omittedArchivedTasks: input.omittedArchivedTasks + 1,
  });
  expect(restore(accepted, j.messages)).toBeUndefined();
});
