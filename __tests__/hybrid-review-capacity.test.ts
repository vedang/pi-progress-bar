import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { processObservation } from "../src/core/hybrid";
import {
  encodeCheckpoint,
  type MonitorCheckpointMetadata,
} from "../src/core/hybrid-checkpoint";
import { type HybridState, observationRef } from "../src/core/hybrid-state";
import {
  backend,
  initial,
  initialMessage,
  noPatch,
  observation,
} from "./fixtures/hybrid";
import { branchEntry, monitorHarness } from "./fixtures/hybrid-monitor";

const running: ReturnType<typeof monitorHarness>[] = [];
const metadata: MonitorCheckpointMetadata = {
  enabled: false,
  usage: {
    jev: { calls: 0, inputTokens: 0, outputTokens: 0 },
    extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
  },
};
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
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

/** Exact legal byte pressure using bounded event count, not oversized text. */
async function settledAtBytes(target: number, withCard = false) {
  const seed = await initial();
  const meta = structuredClone(metadata);
  if (withCard)
    meta.card = {
      taskId: "task:1",
      revision: 1,
      label: "Implement parser",
      retained: false,
      replacementPending: false,
      assessedAt: 1,
      health: {
        requirements: "Clear",
        acceptance: "explicit",
        newRedTest: "Not needed",
        redEvidence: "Not needed",
        implementation: "unverified",
      },
    };
  function candidate(padding: number, remainder = 0) {
    const state = structuredClone(seed);
    const source = observation(
      `filler-${"h".repeat(padding)}`,
      "Historical report.",
      "assistant",
    );
    const tail = remainder
      ? observation(
          `${source.id}${"r".repeat(remainder)}`,
          source.text,
          source.role,
        )
      : source;
    for (let i = state.events.length; i < 900; i++)
      state.events.push({
        id: `event:${i + 1}`,
        kind: "revise",
        taskId: "task:1",
        revision: 1,
        source: observationRef(i === 899 ? tail : source),
      });
    state.cursor = { id: source.id, hash: source.hash, role: source.role };
    return { state, source, tail };
  }
  const zero = size(encodeCheckpoint(candidate(0).state, meta));
  const padding = Math.floor((target - zero) / 898); // 897 event refs + cursor.
  expect(padding).toBeGreaterThan(0);
  const partial = candidate(padding);
  const remainder = target - size(encodeCheckpoint(partial.state, meta));
  const result = candidate(padding, remainder);
  const checkpoint = encodeCheckpoint(result.state, meta);
  expect(size(checkpoint)).toBe(target);
  const messages = [
    initialMessage,
    ...(remainder ? [result.tail] : []),
    result.source,
  ];
  return { ...result, meta, checkpoint, messages };
}
async function restored(
  f: Awaited<ReturnType<typeof settledAtBytes>>,
  checkpoint: unknown = f.checkpoint,
  latest?: ReturnType<typeof observation>,
) {
  const messages = [...f.messages, ...(latest ? [latest] : [])];
  const h = monitorHarness(
    messages.map((message) =>
      branchEntry(message.id, message.text, message.role),
    ),
  );
  running.push(h);
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    checkpoint,
    false,
    h.reader,
  );
  expect(h.monitor.state.events.length).toBeGreaterThanOrEqual(900);
  return h;
}

it("denies gate dispatch when exact observation references alone exceed the 16KiB reserve", async () => {
  const f = await settledAtBytes(491 * 1024);
  const h = await restored(f);
  h.monitor.turnOn("/nonexistent-hybrid-test");
  // Legal gate request, but its accepted assessment and pending observation
  // each carry this exact ID; 24KiB growth exceeds the remaining 21KiB.
  h.append(`next-${"n".repeat(12 * 1024)}`, "Acknowledged.", "user");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.fetch).not.toHaveBeenCalled();
  expect(h.extract).not.toHaveBeenCalled();
  expect(h.monitor.state.cursor).toEqual(f.state.cursor);
  expect(h.monitor.checkpoint()).toHaveProperty("state.capacity", "limit");
  expect(h.monitor.presentationSnapshot().progress.kind).toBe("previous");
  expect(h.save.mock.calls.every(([saved]) => size(saved) <= 512 * 1024)).toBe(
    true,
  );
});

it("finalizes a fully accepted journal above 496KiB without rebilling providers", async () => {
  const f = await settledAtBytes(499 * 1024);
  const latest = observation(
    "accepted-final",
    "All requested deliverables are complete.",
    "assistant",
  );
  const saved: HybridState[] = [];
  await processObservation(
    f.state,
    latest,
    backend(noPatch(), {
      gate: "unchanged",
      complete: "yes",
      save: (state) => saved.push(structuredClone(state)),
    }),
    f.messages.slice(-2),
  );
  const accepted = saved.find(
    (state) =>
      state.pending?.journal.completions.flatMap((record) => record.chunkIds)
        .length === 3,
  );
  if (!accepted) throw new Error("Missing fully accepted journal");
  const checkpoint = encodeCheckpoint(accepted, f.meta);
  expect(size(checkpoint)).toBeGreaterThan(496 * 1024);
  expect(size(checkpoint)).toBeLessThanOrEqual(512 * 1024);
  const h = await restored(f, checkpoint, latest);
  h.monitor.turnOn("/nonexistent-hybrid-test");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.state.cursor?.id).toBe(latest.id);
  expect(h.monitor.state.pending).toBeUndefined();
  expect(h.fetch).not.toHaveBeenCalled();
  expect(h.extract).not.toHaveBeenCalled();
  expect(size(h.monitor.checkpoint())).toBeLessThan(size(checkpoint));
});

it("persists a fixed-size capacity marker at the byte edge and retains the old card", async () => {
  const f = await settledAtBytes(512 * 1024 - 2, true);
  const h = await restored(f);
  expect(h.monitor.presentationSnapshot().card?.retained).toBe(false);
  h.monitor.turnOn("/nonexistent-hybrid-test");
  h.append("edge-message", "Acknowledged.", "user");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.fetch).not.toHaveBeenCalled();
  expect(h.extract).not.toHaveBeenCalled();
  const checkpoint = h.monitor.checkpoint();
  expect(checkpoint).toHaveProperty("state.capacity", "limit");
  expect(size(checkpoint)).toBeLessThanOrEqual(size(f.checkpoint));
  expect(h.monitor.state.cursor).toEqual(f.state.cursor);
  expect(h.monitor.presentationSnapshot().progress.kind).toBe("previous");
  expect(h.monitor.presentationSnapshot().card?.retained).toBe(true);
  h.monitor.stop();
  const again = await restored(f, checkpoint);
  expect(again.monitor.checkpoint()).toHaveProperty("state.capacity", "limit");
  expect(again.monitor.presentationSnapshot().progress.kind).toBe("previous");
});

it("denies an entire paid health batch before dispatch when its metadata/card cannot fit", async () => {
  const f = await settledAtBytes(512 * 1024 - 2, true);
  const h = await restored(f);
  h.monitor.turnOn("/nonexistent-hybrid-test");
  // Fixture-only scheduling of already-canonical work; no extra user message.
  Reflect.apply(Reflect.get(h.monitor, "scheduleHealth"), h.monitor, [
    f.source,
  ]);
  h.observe();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.fetch).not.toHaveBeenCalled();
  expect(h.monitor.presentationSnapshot().usage).toEqual(metadata.usage);
  expect(h.monitor.checkpoint()).toHaveProperty("state.capacity", "limit");
  expect(h.monitor.presentationSnapshot().card?.retained).toBe(true);
  expect(h.save.mock.calls.every(([saved]) => size(saved) <= 512 * 1024)).toBe(
    true,
  );
});

it("accepts a limit-marked large completed journal and clears the marker during local finalization", async () => {
  const f = await settledAtBytes(499 * 1024);
  const latest = observation(
    "limited-final",
    "All requested deliverables are complete.",
    "assistant",
  );
  const saved: HybridState[] = [];
  await processObservation(
    f.state,
    latest,
    backend(noPatch(), {
      gate: "unchanged",
      complete: "yes",
      save: (state) => saved.push(structuredClone(state)),
    }),
    f.messages.slice(-2),
  );
  const accepted = saved.find(
    (state) =>
      state.pending?.phase === "complete" &&
      state.tasks.every((task) => task.status === "done"),
  );
  if (!accepted) throw new Error("Missing accepted journal");
  const checkpoint = encodeCheckpoint(accepted, f.meta);
  Reflect.set(checkpoint.state, "capacity", "limit");
  expect(size(checkpoint)).toBeGreaterThan(496 * 1024);
  expect(size(checkpoint)).toBeLessThanOrEqual(512 * 1024);
  const h = await restored(f, checkpoint, latest);
  h.monitor.turnOn("/nonexistent-hybrid-test");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.fetch).not.toHaveBeenCalled();
  expect(h.extract).not.toHaveBeenCalled();
  expect(h.monitor.state.pending).toBeUndefined();
  expect(h.monitor.state.cursor).toEqual({
    id: latest.id,
    hash: latest.hash,
    role: latest.role,
  });
  expect(h.monitor.checkpoint()).toHaveProperty("state.capacity", "clear");
  expect(size(h.monitor.checkpoint())).toBeLessThan(size(checkpoint));
});
