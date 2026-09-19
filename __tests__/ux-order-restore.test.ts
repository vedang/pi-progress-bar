import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processObservation } from "../src/core/hybrid";
import {
  encodeCheckpoint,
  restoreCheckpoint,
} from "../src/core/hybrid-checkpoint";
import type { HybridState, HybridTask } from "../src/core/hybrid-state";
import * as stateModule from "../src/core/hybrid-state";
import {
  addPatch,
  backend,
  initial,
  initialMessage,
  noPatch,
  observation,
} from "./fixtures/hybrid";
import { monitorHarness } from "./fixtures/hybrid-monitor";

// U04 adds a pure display-order projection without duplicating durable ordinals.
function newest(state: HybridState): HybridTask[] {
  const fn = (
    stateModule as unknown as {
      tasksNewestFirst?: (state: HybridState) => HybridTask[];
    }
  ).tasksNewestFirst;
  expect(fn, "tasksNewestFirst uses validated create-event order").toBeTypeOf(
    "function",
  );
  if (!fn) throw new Error("Missing task-order projection");
  return fn(state);
}

describe("stable retained-task admission order", () => {
  it("uses create-event order rather than current array position and never mutates state", async () => {
    const state = await initial();
    state.tasks.reverse();
    const before = structuredClone(state);
    expect(newest(state).map((task) => task.id)).toEqual([
      "task:3",
      "task:2",
      "task:1",
    ]);
    expect(state).toEqual(before);
    expect(newest(state)).not.toBe(state.tasks);
  });

  it("keeps archived and completed tasks reachable without moving revised tasks to newest", async () => {
    const first = await initial(true);
    const message = observation(
      "revised",
      "Revise parser acceptance and archive regression.",
    );
    const state = await processObservation(
      first,
      message,
      backend({
        ...noPatch(),
        revise: [
          {
            id: "task:1",
            label: "Revise parser",
            requirementsChanged: true,
            quote: message.text,
          },
        ],
        archive: [{ id: "task:2", quote: message.text }],
      }),
    );
    expect(state.tasks.find((task) => task.id === "task:2")?.included).toBe(
      false,
    );
    expect(newest(state).map((task) => task.id)).toEqual([
      "task:3",
      "task:2",
      "task:1",
    ]);
  });

  it("keeps later multi-add, restore and current-version reload ordering exact", async () => {
    const first = await initial();
    const archived = observation("archived", "Archive parser.");
    const second = await processObservation(
      first,
      archived,
      backend({
        ...noPatch(),
        archive: [{ id: "task:1", quote: archived.text }],
      }),
    );
    const added = observation(
      "added",
      "Restore parser and add docs and examples.",
    );
    const third = await processObservation(
      second,
      added,
      backend({
        ...addPatch(added, ["Write docs", "Add examples"]),
        restore: [
          {
            id: "task:1",
            label: "Implement parser",
            requirementsChanged: false,
            quote: added.text,
          },
        ],
      }),
    );
    const messages = [initialMessage, archived, added];
    const restored = restoreCheckpoint(
      encodeCheckpoint(third),
      "session:test",
      (id) => messages.find((m) => m.id === id),
      () => [],
    );
    expect(restored).toBeDefined();
    if (!restored) throw new Error("Missing restored state");
    expect(newest(restored).map((task) => task.id)).toEqual([
      "task:5",
      "task:4",
      "task:3",
      "task:2",
      "task:1",
    ]);
    expect(newest(restored).map((task) => task.id)).toEqual(
      newest(third).map((task) => task.id),
    );
  });
});

const running: ReturnType<typeof monitorHarness>[] = [];
function fixture() {
  const h = monitorHarness();
  running.push(h);
  return h;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline-key");
});
afterEach(() => {
  for (const h of running.splice(0)) h.monitor.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("rejected storage never resets or rebills history", () => {
  it.each([0, 5, 7, 99])(
    "blocks unsupported version %s before save or dispatch",
    async (version) => {
      const h = fixture();
      const checkpoint = {
        ...encodeCheckpoint(stateModule.emptyState("session:test")),
        version,
      };
      const before = structuredClone(checkpoint);
      await h.monitor.restore(
        "/nonexistent-hybrid-test",
        checkpoint,
        false,
        h.reader,
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(h.monitor.enabled).toBe(false);
      expect(h.monitor.error).toMatch(/fresh session/i);
      expect(h.monitor.presentationSnapshot().service.code).toBe(
        "saved-state-unsupported",
      );
      expect(h.save).not.toHaveBeenCalled();
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.extract).not.toHaveBeenCalled();
      expect(checkpoint).toEqual(before);
    },
  );

  it.each([
    "null",
    "missing-state",
    "extra-key",
    "invalid-counter",
    "oversize",
  ])("blocks corrupt %s rather than treating it as absent", async (kind) => {
    const h = fixture();
    const valid = encodeCheckpoint(stateModule.emptyState("session:test"));
    const data =
      kind === "null"
        ? null
        : kind === "missing-state"
          ? { version: 6 }
          : kind === "extra-key"
            ? { ...valid, obsolete: true }
            : kind === "invalid-counter"
              ? { ...valid, state: { ...valid.state, nextTaskId: -1 } }
              : { ...valid, padding: "x".repeat(512 * 1024) };
    const before = structuredClone(data);
    await h.monitor.restore("/nonexistent-hybrid-test", data, false, h.reader);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.monitor.enabled).toBe(false);
    expect(h.monitor.presentationSnapshot().service.code).toBe(
      "saved-state-corrupt",
    );
    expect(h.monitor.error).toMatch(/fresh session/i);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.extract).not.toHaveBeenCalled();
    expect(data).toEqual(before);
  });

  it("ON/OFF, model change, observation and shutdown cannot bypass rejection or write a replacement", async () => {
    const h = fixture();
    const checkpoint = {
      ...encodeCheckpoint(stateModule.emptyState("session:test")),
      version: 5,
    };
    await h.monitor.restore(
      "/nonexistent-hybrid-test",
      checkpoint,
      false,
      h.reader,
    );
    h.monitor.turnOff();
    expect(h.monitor.turnOn("/nonexistent-hybrid-test")).toMatch(
      /fresh session/i,
    );
    h.observe();
    h.monitor.modelSelected();
    h.monitor.setActivity("Agent active");
    await vi.advanceTimersByTimeAsync(1000);
    h.monitor.stop();
    expect(h.monitor.enabled).toBe(false);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.extract).not.toHaveBeenCalled();
  });

  it("clears the rejected-format latch only on a new valid/absent restore boundary", async () => {
    const h = fixture();
    await h.monitor.restore(
      "/nonexistent-hybrid-test",
      { version: 5 },
      false,
      h.reader,
    );
    expect(h.monitor.enabled).toBe(false);
    expect(h.save).not.toHaveBeenCalled();
    await h.monitor.restore(
      "/nonexistent-hybrid-test",
      undefined,
      false,
      h.reader,
    );
    await h.settle("goal");
    expect(h.monitor.enabled).toBe(true);
    expect(h.monitor.state.tasks).toHaveLength(3);
    expect(h.extract).toHaveBeenCalledTimes(1);
  });

  it("keeps existing settled current-version no-rebilling semantics", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    const checkpoint = h.monitor.checkpoint();
    const tasks = structuredClone(h.monitor.state.tasks);
    const calls = h.fetch.mock.calls.length;
    const extractionCalls = h.extract.mock.calls.length;
    await h.monitor.restore(
      "/nonexistent-hybrid-test",
      checkpoint,
      false,
      h.reader,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(h.monitor.state.tasks).toEqual(tasks);
    expect(h.fetch).toHaveBeenCalledTimes(calls);
    expect(h.extract).toHaveBeenCalledTimes(extractionCalls);
  });
});
