import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { processObservation } from "../src/core/hybrid";
import {
  encodeCheckpoint,
  monitorCheckpointMetadata,
} from "../src/core/hybrid-checkpoint";
import type { HybridState } from "../src/core/hybrid-state";
import { backend, noPatch, observation } from "./fixtures/hybrid";
import { branchEntry, monitorHarness } from "./fixtures/hybrid-monitor";

const running: ReturnType<typeof monitorHarness>[] = [];
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

it.each([false, true])(
  "bounds blank/thinking candidate payload work and discovers eventual visible suffix (initial suffix=%s)",
  async (withSuffix) => {
    const goal = branchEntry(
      "goal",
      "Implement parser, add regression, and validate it.",
    );
    const h = monitorHarness([goal]);
    running.push(h);
    h.start();
    await h.settle("goal");
    let reads = 0,
      boundaryStart = 0,
      maximumBoundaryReads = 0;
    const reader = h.reader.getMockImplementation();
    if (!reader) throw new Error("Missing reader");
    h.reader.mockImplementation(() => {
      boundaryStart = reads;
      return reader();
    });
    const tail = Array.from({ length: 10_000 }, (_, index) => ({
      type: "message",
      id: `invisible-${index}`,
      message: {
        role: "assistant",
        get content() {
          reads++;
          maximumBoundaryReads = Math.max(
            maximumBoundaryReads,
            reads - boundaryStart,
          );
          return index % 2
            ? [
                { type: "thinking", thinking: "private" },
                { type: "toolCall", name: "read", arguments: {} },
              ]
            : [{ type: "text", text: "   " }];
        },
      },
    }));
    const suffix = branchEntry("suffix", "Please report current work.", "user");
    h.replace([goal, ...tail, ...(withSuffix ? [suffix] : [])]);
    // Header scans may inspect metadata; payload materialization must yield.
    expect(reads).toBeLessThanOrEqual(256);
    for (let step = 0; step < 1000; step++) {
      await vi.advanceTimersByTimeAsync(1);
      expect(maximumBoundaryReads).toBeLessThanOrEqual(256);
      if (withSuffix && h.monitor.state.cursor?.id === "suffix") break;
    }
    if (!withSuffix) {
      const before = reads;
      h.observe();
      expect(reads - before).toBeLessThanOrEqual(256);
      h.append("suffix", "Please report current work.", "user");
    }
    await h.settle("suffix");
    const gates = h.requests.filter(
      (request) =>
        "gate" in request.questions &&
        (request.state as { latest?: { id?: string } }).latest?.id === "suffix",
    );
    expect(gates).toHaveLength(1);
    const calls = h.requests.length;
    const before = reads;
    h.observe();
    await vi.advanceTimersByTimeAsync(20);
    expect(reads - before).toBeLessThanOrEqual(256);
    expect(h.requests).toHaveLength(calls);
  },
);

it("restores exact pending context across skipped candidates without unbounded reads or rebilling the gate", async () => {
  const goal = branchEntry(
    "goal",
    "Implement parser, add regression, and validate it.",
  );
  const h = monitorHarness([goal]);
  running.push(h);
  h.start();
  await h.settle("goal");
  const latest = observation(
    "pending-after-skips",
    "Work continues on the parser.",
    "assistant",
  );
  const saved: HybridState[] = [];
  await processObservation(
    h.monitor.state,
    latest,
    backend(noPatch(), {
      gate: "unchanged",
      save: (value) => saved.push(structuredClone(value)),
    }),
    [observation(goal.id, goal.message.content)],
  );
  const pending = saved.find(
    (value) =>
      value.pending?.journal.gate && !value.pending.journal.completions.length,
  );
  if (!pending) throw new Error("Missing accepted gate");
  const checkpoint = encodeCheckpoint(
    pending,
    monitorCheckpointMetadata(h.monitor.checkpoint()),
  );
  h.monitor.stop();
  let reads = 0,
    boundaryStart = 0,
    maximumBoundaryReads = 0;
  const reader = h.reader.getMockImplementation();
  if (!reader) throw new Error("Missing reader");
  h.reader.mockImplementation(() => {
    boundaryStart = reads;
    return reader();
  });
  const tail = Array.from({ length: 10_000 }, (_, index) => ({
    type: "message",
    id: `skip-before-context-${index}`,
    message: {
      role: "assistant",
      get content() {
        reads++;
        maximumBoundaryReads = Math.max(
          maximumBoundaryReads,
          reads - boundaryStart,
        );
        return " ";
      },
    },
  }));
  h.replace([goal, ...tail, branchEntry(latest.id, latest.text, latest.role)]);
  h.requests.length = 0;
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    checkpoint,
    false,
    h.reader,
  );
  expect(maximumBoundaryReads).toBeLessThanOrEqual(256);
  await h.settle(latest.id);
  expect(h.requests.some((request) => "gate" in request.questions)).toBe(false);
  expect(maximumBoundaryReads).toBeLessThanOrEqual(256);
});

it("restoring an amended same-source branch preserves saved billing telemetry", async () => {
  const goal = branchEntry(
    "goal",
    "Implement parser, add regression, and validate it.",
  );
  const h = monitorHarness([goal]);
  running.push(h);
  h.start();
  await h.settle("goal");
  const saved = h.monitor.checkpoint();
  const before = h.monitor.presentationSnapshot();
  h.monitor.stop();
  goal.message.content += " Changed while extension was stopped.";
  h.fetch.mockImplementation(() => new Promise<Response>(() => {}));
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  const after = h.monitor.presentationSnapshot();
  expect(h.monitor.state.tasks).toHaveLength(0);
  expect(after.card).toBeUndefined();
  expect(after.usage).toEqual(before.usage);
  expect(after.lastExtractionCallAt).toBe(before.lastExtractionCallAt);
  expect(after.lastJevCallAt).toBeGreaterThanOrEqual(before.lastJevCallAt ?? 0);
});

it("a true source replacement resets old session billing telemetry", async () => {
  const h = monitorHarness();
  running.push(h);
  h.start();
  await h.settle("goal");
  h.monitor.turnOff();
  Reflect.set(
    Reflect.get(h.monitor, "options"),
    "sourceId",
    () => "session:replacement",
  );
  h.fetch.mockImplementation(() => new Promise<Response>(() => {}));
  h.monitor.turnOn("/nonexistent-hybrid-test");
  expect(h.monitor.state.sourceId).toBe("session:replacement");
  expect(h.monitor.presentationSnapshot().usage).toEqual({
    jev: { calls: 0, inputTokens: 0, outputTokens: 0 },
    extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
  });
  expect(h.monitor.presentationSnapshot().lastExtractionCallAt).toBeUndefined();
});

it("same-source canonical amendment preserves incurred usage and dispatch timestamps", async () => {
  const goal = branchEntry(
    "goal",
    "Implement parser, add regression, and validate it.",
  );
  const h = monitorHarness([goal]);
  running.push(h);
  h.start();
  await h.settle("goal");
  const before = h.monitor.presentationSnapshot();
  expect(before.usage.jev.calls).toBeGreaterThan(0);
  expect(before.usage.extraction.calls).toBeGreaterThan(0);
  expect(before.lastJevCallAt).toBeDefined();
  expect(before.lastExtractionCallAt).toBeDefined();
  // Hold the next transport: compare the reconciliation boundary, not later costs.
  const fetch = h.fetch.getMockImplementation();
  if (!fetch) throw new Error("Missing transport");
  let release: (() => void) | undefined;
  h.fetch.mockImplementation(async (url, init) => {
    const response = await fetch(url, init);
    return new Promise<Response>((resolve) => {
      release = () => resolve(response);
    });
  });
  goal.message.content += " Updated canonical requirement.";
  h.observe();
  const reset = h.monitor.presentationSnapshot();
  expect(h.monitor.state.tasks).toHaveLength(0);
  expect(reset.usage).toEqual(before.usage);
  expect(reset.lastExtractionCallAt).toBe(before.lastExtractionCallAt);
  // The next real Jev dispatch may replace its timestamp; it must never vanish.
  expect(reset.lastJevCallAt).toBeGreaterThanOrEqual(before.lastJevCallAt ?? 0);
  for (let step = 0; step < 100 && !release; step++)
    await vi.advanceTimersByTimeAsync(1);
  expect(release).toBeDefined();
  h.fetch.mockImplementation(fetch);
  release?.();
  await h.settle("goal");
  const after = h.monitor.presentationSnapshot();
  expect(after.usage.jev.calls).toBeGreaterThan(before.usage.jev.calls);
  expect(after.usage.extraction.calls).toBeGreaterThan(
    before.usage.extraction.calls,
  );
  expect(after.usage.jev.inputTokens).toBeGreaterThan(
    before.usage.jev.inputTokens,
  );
  expect(after.usage.extraction.inputTokens).toBeGreaterThan(
    before.usage.extraction.inputTokens,
  );
});
