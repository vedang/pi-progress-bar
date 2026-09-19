import { expect, it, vi } from "vitest";
import { processObservation } from "../src/core/hybrid";
import type { HybridState } from "../src/core/hybrid-state";
import { backend, initial, noPatch, observation } from "./fixtures/hybrid";

// Required stage-two provider hook. Production Monitor supplies the proven
// envelope; these pure-core tests verify denial is respected before billing.
it.each(["gate", "extraction", "completion"])(
  "honors %s admission denial before its provider call",
  async (phase) => {
    const state = await initial();
    const latest = observation(
      "admission",
      "Report current work.",
      "assistant",
    );
    const snapshots: HybridState[] = [];
    const providers = Object.assign(
      backend(noPatch(), {
        gate: phase === "completion" ? "unchanged" : "changed",
        save: (value) => snapshots.push(structuredClone(value)),
      }),
      { admit: vi.fn((plan: { phase: string }) => plan.phase !== phase) },
    );
    const result = await processObservation(state, latest, providers);
    expect(providers.admit).toHaveBeenCalledWith(
      expect.objectContaining({ phase }),
    );
    expect(providers.evaluate).toHaveBeenCalledTimes(phase === "gate" ? 0 : 1);
    expect(providers.extract).not.toHaveBeenCalled();
    expect(result.cursor).toEqual(state.cursor);
    expect(result.tasks).toEqual(state.tasks);
    expect(result.events).toEqual(state.events);
    expect(result).toHaveProperty("capacity", "limit");
    if (phase !== "gate") {
      expect(result.pending?.phase).toBe(
        phase === "extraction" ? "extract" : "complete",
      );
      const calls = providers.evaluate.mock.calls.length;
      const repeated = await processObservation(result, latest, providers);
      expect(providers.evaluate).toHaveBeenCalledTimes(calls);
      expect(repeated.pending).toEqual(result.pending);
    }
  },
);

it("preserves an accepted completion prefix when the next chunk is denied", async () => {
  const state = await initial();
  const seed = state.tasks[0],
    event = state.events[0];
  if (!seed || !event) throw new Error("Missing seed");
  state.tasks = Array.from({ length: 20 }, (_, i) => ({
    ...structuredClone(seed),
    id: `task:${i + 1}`,
    label: `${i} ${"界".repeat(220)}`,
  }));
  state.events = state.tasks.map((task, i) => ({
    ...structuredClone(event),
    id: `event:${i + 1}`,
    taskId: task.id,
  }));
  state.nextTaskId = 21;
  let chunks = 0;
  const providers = Object.assign(
    backend(noPatch(), { gate: "unchanged", complete: "yes" }),
    {
      admit: vi.fn(
        (plan: { phase: string }) =>
          plan.phase !== "completion" || ++chunks === 1,
      ),
    },
  );
  const latest = observation(
    "prefix-denial",
    "All deliverables are complete.",
    "assistant",
  );
  const result = await processObservation(state, latest, providers);
  const done = result.tasks.filter((task) => task.status === "done");
  expect(done.length).toBeGreaterThan(0);
  expect(done.length).toBeLessThan(20);
  expect(providers.evaluate).toHaveBeenCalledTimes(2); // gate + first chunk
  expect(result).toHaveProperty("capacity", "limit");
  expect(result.cursor).toEqual(state.cursor);
  const persisted = structuredClone(result);
  const resumed = await processObservation(result, latest, providers);
  expect(providers.evaluate).toHaveBeenCalledTimes(2);
  expect(resumed.pending).toEqual(persisted.pending);
  expect(resumed.tasks).toEqual(persisted.tasks);
  expect(resumed.events).toEqual(persisted.events);
});
