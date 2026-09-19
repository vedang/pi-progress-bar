import { describe, expect, it } from "vitest";
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
  addPatch,
  backend,
  initial,
  initialMessage,
  noPatch,
  observation,
} from "./fixtures/hybrid";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

const resolver = (messages: Observation[]) => (id: string) =>
  messages.find((message) => message.id === id);
function restore(state: HybridState, messages = [initialMessage]) {
  const restored = restoreCheckpoint(
    encodeCheckpoint(state),
    "session:test",
    resolver(messages),
    () => [],
  );
  expect(restored).toBeDefined();
  if (!restored) throw new Error("Expected checkpoint restoration");
  return restored;
}

describe("strict hybrid v6 checkpoint", () => {
  it("round-trips generated labels and evidence, without full source context", async () => {
    const state = await initial(true);
    const checkpoint = encodeCheckpoint(state);
    expect(checkpoint).toMatchObject({ version: 7 });
    expect(JSON.stringify(checkpoint)).toContain("Implement parser");
    expect(JSON.stringify(checkpoint)).not.toContain(
      "PRIVATE_CONTEXT_SENTINEL",
    );
    const restored = restore(state);
    expect(restored).toEqual(state);
    required(restored.tasks[0]).label = "consumer mutation";
    expect(state.tasks[0]?.label).toBe("Implement parser");
    expect(JSON.stringify(checkpoint)).not.toContain("consumer mutation");
  });
  it.each([1, 2, 3, 4, 5, 7])(
    "rejects obsolete or unknown checkpoint version %i",
    async (version) => {
      const checkpoint = { ...encodeCheckpoint(await initial()), version };
      expect(
        restoreCheckpoint(
          checkpoint,
          "session:test",
          resolver([initialMessage]),
          () => [],
        ),
      ).toBeUndefined();
    },
  );
  it("rejects malformed schema, wrong session and unavailable or modified canonical source", async () => {
    const checkpoint = encodeCheckpoint(await initial());
    expect(
      restoreCheckpoint(
        { ...checkpoint, interval: 15 },
        "session:test",
        resolver([initialMessage]),
        () => [],
      ),
    ).toBeUndefined();
    expect(
      restoreCheckpoint(
        checkpoint,
        "another-session",
        resolver([initialMessage]),
        () => [],
      ),
    ).toBeUndefined();
    expect(
      restoreCheckpoint(
        checkpoint,
        "session:test",
        () => undefined,
        () => [],
      ),
    ).toBeUndefined();
    expect(
      restoreCheckpoint(
        checkpoint,
        "session:test",
        resolver([observation(initialMessage.id, "different source")]),
        () => [],
      ),
    ).toBeUndefined();
  });
  it.each([
    "label",
    "tasks",
    "events",
    "counter",
    "duplicate-id",
    "quote-hash",
  ])(
    "rejects invalid/cap-exceeding state before writing: %s",
    async (variant) => {
      const state = await initial();
      if (variant === "label") required(state.tasks[0]).label = "x".repeat(241);
      if (variant === "tasks")
        state.tasks = Array.from({ length: 201 }, (_, i) => ({
          ...required(state.tasks[0]),
          id: `task:${i + 1}`,
        }));
      if (variant === "events")
        state.events = Array.from({ length: 1001 }, (_, i) => ({
          ...required(state.events[0]),
          id: `event:${i}`,
        }));
      if (variant === "counter") state.nextTaskId = 1;
      if (variant === "duplicate-id") required(state.tasks[1]).id = "task:1";
      if (variant === "quote-hash")
        required(state.tasks[0]).source.quoteHash = "invalid";
      expect(() => encodeCheckpoint(state)).toThrow();
    },
  );
});

describe("accepted-phase durable resume", () => {
  it("saves gate/patch before cursor and resumes each phase without rebilling", async () => {
    const snapshots: HybridState[] = [];
    const p = backend(addPatch(initialMessage), {
      save: (state) => snapshots.push(structuredClone(state)),
    });
    const final = await processObservation(
      emptyState("session:test"),
      initialMessage,
      p,
    );
    const gated = snapshots.find(
      (state) =>
        state.scopeAssessment &&
        state.tasks.length === 0 &&
        state.cursor?.id !== initialMessage.id,
    );
    const patched = snapshots.find(
      (state) =>
        state.tasks.length === 3 && state.cursor?.id !== initialMessage.id,
    );
    expect(gated).toBeDefined();
    expect(patched).toBeDefined();
    if (!gated || !patched)
      throw new Error("Missing accepted-phase journal snapshots");
    const afterGate = backend(addPatch(initialMessage));
    const resumedGate = await processObservation(
      restore(gated),
      initialMessage,
      afterGate,
    );
    expect(
      afterGate.evaluate.mock.calls.every(
        ([request]) => !("gate" in request.questions),
      ),
    ).toBe(true);
    expect(afterGate.extract).toHaveBeenCalledTimes(1);
    expect(resumedGate.tasks).toEqual(final.tasks);
    const afterPatch = backend();
    const resumedPatch = await processObservation(
      restore(patched),
      initialMessage,
      afterPatch,
    );
    expect(afterPatch.extract).not.toHaveBeenCalled();
    expect(
      afterPatch.evaluate.mock.calls.every(
        ([request]) => !("gate" in request.questions),
      ),
    ).toBe(true);
    expect(resumedPatch.tasks).toEqual(final.tasks);
    expect(resumedPatch.events).toEqual(final.events);
    const committed = backend();
    await processObservation(restore(final), initialMessage, committed);
    expect(committed.evaluate).not.toHaveBeenCalled();
    expect(committed.extract).not.toHaveBeenCalled();
  });
  it("journals independent completion chunks and resumes only unfinished chunks", async () => {
    const messages: Observation[] = [];
    let state = emptyState("session:test");
    for (let batch = 0; batch < 4; batch++) {
      const message = observation(
        `batch-${batch}`,
        `Add tasks from batch ${batch}.`,
      );
      messages.push(message);
      const names = Array.from(
        { length: 5 },
        (_, i) =>
          `Task ${batch * 5 + i + 1}: ${"specific requirement ".repeat(10)}`,
      );
      state = await processObservation(
        state,
        message,
        backend(addPatch(message, names)),
      );
    }
    expect(state.tasks).toHaveLength(20);
    const delivery = observation(
      "all-delivered",
      `All twenty requested tasks are completed. ${"Detailed supporting report. ".repeat(350)}`,
      "assistant",
    );
    messages.push(delivery);
    const snapshots: HybridState[] = [];
    const p = backend(noPatch(), {
      gate: "unchanged",
      complete: "yes",
      save: (saved) => snapshots.push(structuredClone(saved)),
    });
    const final = await processObservation(state, delivery, p);
    expect(final.tasks.every((task) => task.status === "done")).toBe(true);
    const chunks = p.evaluate.mock.calls.filter(
      ([request]) => !("gate" in request.questions),
    );
    expect(chunks.length).toBeGreaterThan(1);
    const middle = snapshots.find(
      (saved) =>
        saved.tasks.some((task) => task.status === "done") &&
        saved.tasks.some((task) => task.status !== "done") &&
        saved.cursor?.id !== delivery.id,
    );
    expect(middle).toBeDefined();
    if (!middle) throw new Error("No durable middle chunk");
    const acceptedIds = middle.tasks
      .filter((task) => task.status === "done")
      .map((task) => task.id);
    const resumed = backend(noPatch(), { gate: "unchanged", complete: "yes" });
    const result = await processObservation(
      restore(middle, messages),
      delivery,
      resumed,
    );
    expect(resumed.extract).not.toHaveBeenCalled();
    const questions = resumed.evaluate.mock.calls.flatMap(([request]) =>
      Object.keys(request.questions),
    );
    expect(questions).not.toContain("gate");
    for (const id of acceptedIds)
      expect(questions.some((key) => key.endsWith(`:${id}`))).toBe(false);
    expect(result.tasks).toEqual(final.tasks);
    expect(result.events).toEqual(final.events);
  });
});
