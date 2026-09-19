import { describe, expect, it } from "vitest";
import { completionRequest } from "../src/analysis/completion";
import { processObservation } from "../src/core/hybrid";
import {
  checkpointBytes,
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

const latest = observation(
  "activity",
  "I am now writing the parser regression; implementation is paused.",
  "assistant",
);
const restore = (checkpoint: unknown) =>
  restoreCheckpoint(
    checkpoint,
    "session:test",
    (id) => [initialMessage, latest].find((o) => o.id === id),
    () => [],
  );
async function switched(options: Parameters<typeof backend>[1] = {}) {
  const state = await initial();
  const p = backend(noPatch(), {
    gate: "unchanged",
    focus: "task:2",
    ...options,
  });
  const next = await processObservation(state, latest, p);
  return { state, next, p };
}
async function captured() {
  const saved: HybridState[] = [];
  await switched({ save: (state) => saved.push(structuredClone(state)) });
  const state = saved.find((s) => s.pending?.journal.completions.length);
  expect(state).toBeDefined();
  if (!state) throw new Error("No accepted completion record");
  return state;
}
function object(value: unknown): Record<string, unknown> {
  expect(value).toBeDefined();
  if (!value || typeof value !== "object")
    throw new Error("Missing focus journal");
  return value as Record<string, unknown>;
}

describe("Jev-selected current task focus", () => {
  it("bounds real combined focus outcomes including long decimal abstentions", async () => {
    const state = await initial();
    state.tasks = state.tasks.slice(0, 1);
    state.events = state.events.slice(0, 1);
    const saved: HybridState[] = [];
    const p = backend(noPatch(), {
      gate: "unchanged",
      complete: "yes",
      focus: "concurrent",
      focusConfidence: 0.30000000000000004,
      focusProbability: 0.30000000000000004,
      save: (value) => saved.push(structuredClone(value)),
    });
    let admittedBytes = 0;
    p.admit.mockImplementation((...args: unknown[]) => {
      const plan = object(args[0]);
      if (plan.phase === "completion")
        admittedBytes =
          checkpointBytes(plan.candidate as HybridState) +
          Number(plan.schemaBytes);
      return true;
    });
    const original = p.evaluate.getMockImplementation();
    if (!original) throw new Error("Missing evaluator");
    p.evaluate.mockImplementation(async (request) => {
      const result = await original(request);
      for (const [key, answer] of Object.entries(result.answers)) {
        if (!key.startsWith("complete:") || answer.type !== "choice") continue;
        answer.confidence = 0.5000000000000001;
        answer.probabilities = {
          yes: 0.8000000000000002,
          no: 0.0999999999999999,
          uncertain: 0.0999999999999999,
        };
      }
      return result;
    });
    await processObservation(state, latest, p);
    const accepted = saved.find((s) => s.pending?.journal.completions.length);
    expect(accepted).toBeDefined();
    if (!accepted) throw new Error("No accepted result");
    expect(checkpointBytes(accepted)).toBeLessThanOrEqual(admittedBytes);
  });
  it.each([false, true])(
    "fits all twenty full-label focus candidates without needless duplication (unicode=%s)",
    async (unicode) => {
      const seed = (await initial()).tasks[0];
      if (!seed) throw new Error("Missing seed");
      const tasks = Array.from({ length: 20 }, (_, index) => ({
        ...structuredClone(seed),
        id: `task:${index + 1}`,
        label: `${index} ${unicode ? "界".repeat(220) : "specific requirement ".repeat(10)}`,
      }));
      const report = observation(
        "large",
        unicode
          ? "Working on the last task."
          : `Working on the last task. ${"Detailed supporting report. ".repeat(350)}`,
        "assistant",
      );
      const first = tasks[0];
      if (!first) throw new Error("Missing candidate");
      const request = completionRequest(report, [first], [], tasks);
      expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(
        24 * 1024,
      );
      const question = request.questions.focus;
      expect(question?.type).toBe("choice");
      expect(Object.keys(question?.criteria ?? {})).toHaveLength(23);
      for (const task of tasks)
        expect(JSON.stringify(request.state)).toContain(task.label);
    },
  );
  it("switches between existing open tasks without scope changes or completion", async () => {
    const { state, next, p } = await switched();
    expect(next.focusTaskId).toBe("task:2");
    expect(next.tasks.map((t) => t.status)).toEqual(
      state.tasks.map((t) => t.status),
    );
    expect(next.events).toEqual(state.events);
    expect(p.extract).not.toHaveBeenCalled();
  });
  it("batches one focus Choice with completion over all open candidates and no extra call", async () => {
    const { p } = await switched();
    const calls = p.evaluate.mock.calls.map(([request]) => request);
    expect(calls).toHaveLength(2);
    const combined = calls.find((r) => "complete:task:1" in r.questions);
    expect(combined?.questions.focus).toMatchObject({ type: "choice" });
    const question = combined?.questions.focus;
    if (question?.type !== "choice") throw new Error("Missing focus Choice");
    expect(Object.keys(question.criteria).sort()).toEqual(
      ["task:1", "task:2", "task:3", "none", "concurrent", "uncertain"].sort(),
    );
    expect(JSON.stringify(combined?.state)).not.toContain("focusTaskId");
  });
  it.each([
    { focus: "none" },
    { focus: "concurrent" },
    { focus: "uncertain" },
    { focus: "task:2", focusConfidence: 0.49 },
    { focus: "task:2", focusProbability: 0.79 },
  ])("clears stale exclusive focus for %j", async (options) => {
    const { next } = await switched(options);
    expect(next.focusTaskId).toBeUndefined();
    expect(next.tasks.every((t) => t.status === "not-started")).toBe(true);
  });
  it("does not let first newly added task steal current work", async () => {
    const state = await initial();
    const next = await processObservation(
      state,
      latest,
      backend(addPatch(latest, ["Prepare handoff"]), { focus: "task:2" }),
    );
    expect(next.focusTaskId).toBe("task:2");
    expect(next.tasks).toHaveLength(4);
  });
  it("completes A while independently selecting open B", async () => {
    const { next } = await switched({ complete: { "task:1": "yes" } });
    expect(next.tasks[0]?.status).toBe("done");
    expect(next.focusTaskId).toBe("task:2");
  });
  it("clears a selected task completed by the same response rather than falling back", async () => {
    const { next } = await switched({
      focus: "task:1",
      complete: { "task:1": "yes" },
    });
    expect(next.focusTaskId).toBeUndefined();
  });
  it("clears focus when all included tasks complete", async () => {
    const { next } = await switched({ complete: "yes" });
    expect(next.tasks.every((t) => t.status === "done")).toBe(true);
    expect(next.focusTaskId).toBeUndefined();
  });
  it("uses a strict new checkpoint schema without legacy focus protocol branches", async () => {
    const state = await captured();
    const checkpoint = encodeCheckpoint(state);
    expect(checkpoint.version).toBe(6);
    expect(restore({ ...checkpoint, version: 5 })).toBeUndefined();
    expect(JSON.stringify(checkpoint)).not.toContain("focusProtocol");
  });
  it("journals selected assessment and exact focus undo, then resumes without rebilling", async () => {
    const state = await captured();
    const record = object(state.pending?.journal.completions[0]);
    expect(record.focus).toMatchObject({
      assessment: {
        rawChoice: "task:2",
        reason: "accepted",
        source: { entryId: latest.id },
      },
      priorFocusTaskId: { present: true, value: "task:1" },
    });
    const restored = restore(encodeCheckpoint(state));
    expect(restored?.focusTaskId).toBe("task:2");
    if (!restored) throw new Error("Cannot restore accepted focus");
    const p = backend();
    const next = await processObservation(restored, latest, p);
    expect(p.evaluate).not.toHaveBeenCalled();
    expect(p.extract).not.toHaveBeenCalled();
    expect(next.focusTaskId).toBe("task:2");
  });
  it.each(["missing", "hash", "choice", "source", "undo"])(
    "rejects corrupt %s focus proof",
    async (kind) => {
      const checkpoint = encodeCheckpoint(await captured());
      const state = object(checkpoint.state);
      const journal = object(object(state.pending).journal);
      const record = object((journal.completions as unknown[])[0]);
      const focus = object(record.focus);
      if (kind === "missing") delete record.focus;
      if (kind === "hash") record.requestHash = "0".repeat(64);
      if (kind === "choice") object(focus.assessment).rawChoice = "task:999";
      if (kind === "source")
        object(object(focus.assessment).source).entryId = initialMessage.id;
      if (kind === "undo") focus.priorFocusTaskId = { present: false };
      expect(restore(checkpoint)).toBeUndefined();
    },
  );
  it("admits the worst legal combined focus record before provider dispatch", async () => {
    const p = backend(noPatch(), { gate: "unchanged", focus: "task:2" });
    p.admit.mockImplementation((...args: unknown[]) => {
      const plan = object(args[0]);
      if (plan.phase !== "completion") return true;
      expect(JSON.stringify(plan)).toContain('"priorFocusTaskId"');
      return false;
    });
    const next = await processObservation(await initial(), latest, p);
    expect(p.evaluate).toHaveBeenCalledTimes(1);
    expect(next.capacity).toBe("limit");
    expect(next.focusTaskId).toBe("task:1");
  });
  it("asks focus once across bounded chunks and never rebills accepted focus after interruption", async () => {
    let state = emptyState("session:test");
    const sources: ReturnType<typeof observation>[] = [];
    for (let i = 0; i < 4; i++) {
      const source = observation(`batch-${i}`, `Add batch ${i}`);
      sources.push(source);
      state = await processObservation(
        state,
        source,
        backend(
          addPatch(
            source,
            Array.from(
              { length: 5 },
              (_, j) =>
                `Task ${i * 5 + j}: ${"specific requirement ".repeat(9)}`,
            ),
          ),
        ),
      );
    }
    const update = observation(
      "long-activity",
      `I am working on task twenty. ${"Detailed activity report. ".repeat(300)}`,
      "assistant",
    );
    sources.push(update);
    const p = backend(noPatch(), { gate: "unchanged", focus: "task:20" });
    let chunks = 0;
    p.admit.mockImplementation(
      (...args: unknown[]) =>
        object(args[0]).phase !== "completion" || ++chunks < 2,
    );
    const pending = await processObservation(state, update, p);
    expect(chunks).toBe(2);
    const first = p.evaluate.mock.calls.find(
      ([r]) => "focus" in r.questions,
    )?.[0];
    expect(first?.questions.focus).toBeDefined();
    if (first?.questions.focus.type !== "choice")
      throw new Error("No first focus request");
    expect(first.questions.focus.criteria).toHaveProperty("task:20");
    expect(Object.keys(first.questions).length).toBeLessThanOrEqual(20);
    const restored = restoreCheckpoint(
      encodeCheckpoint(pending),
      "session:test",
      (id) => sources.find((o) => o.id === id),
      () => [],
    );
    expect(restored).toBeDefined();
    if (!restored) throw new Error("No partial resume");
    const resume = backend(noPatch(), { focus: "task:20" });
    const next = await processObservation(restored, update, resume);
    expect(
      resume.evaluate.mock.calls.some(
        ([r]) => "focus" in r.questions || "gate" in r.questions,
      ),
    ).toBe(false);
    expect(next.focusTaskId).toBe("task:20");
  });
});
