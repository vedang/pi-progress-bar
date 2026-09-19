import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { processObservation } from "../src/core/hybrid";
import {
  checkpointBytes,
  encodeCheckpoint,
  type MonitorCheckpointMetadata,
} from "../src/core/hybrid-checkpoint";
import { type HybridState, observationRef } from "../src/core/hybrid-state";
import { fixtureHealthCard } from "./fixtures/health-card";
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
async function settledAtBytes(
  target: number,
  withCard = false,
  tasks = 3,
  enabled = false,
) {
  const seed = await initial();
  if (tasks !== 3) {
    const first = seed.tasks[0];
    if (!first) throw new Error("Missing seed task");
    seed.tasks = Array.from({ length: tasks }, (_, index) => ({
      ...structuredClone(first),
      id: `task:${index + 1}`,
      label: `${index} ${"界".repeat(220)}`,
    }));
    const event = seed.events[0];
    if (!event) throw new Error("Missing seed event");
    seed.events = seed.tasks.map((task, index) => ({
      ...structuredClone(event),
      id: `event:${index + 1}`,
      taskId: task.id,
    }));
    seed.nextTaskId = tasks + 1;
  }
  const meta = structuredClone(metadata);
  meta.enabled = enabled;
  if (withCard) {
    const task = seed.tasks[0];
    if (!task) throw new Error("Missing seed task");
    meta.healthCards = [fixtureHealthCard(task, initialMessage)];
  }
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
  const padding = Math.floor((target - zero) / (900 - seed.events.length + 1)); // Filler event refs + cursor.
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

it.each([false, true])(
  "restored ON-only exact-edge checkpoint remains safely OFF with unchanged accepted work (pending=%s)",
  async (pending) => {
    const latest = observation(
      "edge-pending",
      "Report current work.",
      "assistant",
    );
    const f = await settledAtBytes(
      pending ? 500 * 1024 : 512 * 1024,
      false,
      3,
      true,
    );
    let state = f.state;
    if (pending) {
      const acceptGate = async () => {
        const saved: HybridState[] = [];
        const p = Object.assign(
          backend(noPatch(), {
            gate: "unchanged",
            save: (value) => saved.push(structuredClone(value)),
          }),
          { admit: (plan: { phase: string }) => plan.phase !== "completion" },
        );
        await processObservation(f.state, latest, p, f.messages.slice(-2));
        const accepted = saved.find((value) => value.pending?.journal.gate);
        if (!accepted) throw new Error("Missing accepted gate");
        return accepted;
      };
      const unpadded = await acceptGate();
      const extra = 512 * 1024 - checkpointBytes(unpadded, f.meta);
      expect(extra).toBeGreaterThan(0);
      // Change exactly one historical event ref, not cursor/context refs whose
      // repeated byte growth makes iterative target padding oscillate.
      const event = f.state.events[3];
      if (!event) throw new Error("Missing filler event");
      event.source.entryId += "x".repeat(extra);
      f.messages.unshift(
        observation(event.source.entryId, f.source.text, f.source.role),
      );
      state = await acceptGate();
    }
    const checkpoint = encodeCheckpoint(state, f.meta);
    expect(size(checkpoint)).toBe(512 * 1024);
    expect(checkpointBytes(state, { ...f.meta, enabled: false })).toBe(
      512 * 1024 + 1,
    );
    const prefix = JSON.stringify(state.pending?.journal);
    const h = await restored(f, checkpoint, pending ? latest : undefined);
    expect(h.monitor.enabled).toBe(false);
    expect(h.monitor.state.tasks).toEqual(state.tasks);
    expect(JSON.stringify(h.monitor.state.pending?.journal)).toBe(prefix);
    h.monitor.turnOff();
    h.monitor.turnOn("/nonexistent-hybrid-test");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.monitor.enabled).toBe(false);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.extract).not.toHaveBeenCalled();
    expect(JSON.stringify(h.monitor.state.pending?.journal)).toBe(prefix);
    for (const [saved] of h.save.mock.calls) {
      expect(size(saved)).toBeLessThanOrEqual(512 * 1024);
      expect(saved).toHaveProperty("monitor.enabled", false);
    }
    h.monitor.stop();
    const restart = await restored(f, checkpoint, pending ? latest : undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(restart.monitor.enabled).toBe(false);
    expect(restart.fetch).not.toHaveBeenCalled();
    expect(restart.extract).not.toHaveBeenCalled();
    expect(JSON.stringify(restart.monitor.state.pending?.journal)).toBe(prefix);
  },
);

it("provider-free commit cannot create a state too large for OFF control", async () => {
  const small = await settledAtBytes(480 * 1024, false, 3, true);
  const h = await restored(small);
  const previous = structuredClone(h.monitor.state);
  const edge = await settledAtBytes(512 * 1024, false, 3, true);
  expect(() =>
    Reflect.apply(Reflect.get(h.monitor, "commit"), h.monitor, [edge.state]),
  ).toThrow();
  expect(h.monitor.state.tasks).toEqual(previous.tasks);
  expect(h.monitor.state.events).toEqual(previous.events);
  h.monitor.turnOff();
  const last = h.save.mock.calls.at(-1)?.[0];
  expect(last).toHaveProperty("monitor.enabled", false);
  expect(size(last)).toBeLessThanOrEqual(512 * 1024);
});

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
  // Restored assessments have no re-established live request/evidence identity.
  expect(h.monitor.presentationSnapshot().card?.retained).toBe(true);
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
  // [ref:ux_optional_isolation] Health denial cannot block semantic tracking.
  expect(h.monitor.checkpoint()).toHaveProperty("state.capacity", "clear");
  expect(h.monitor.state.tasks).toEqual(f.state.tasks);
  expect(h.monitor.state.cursor).toEqual(f.state.cursor);
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

it.each([480, 499])(
  "resumes a %iKiB partial accepted journal without rebilling its prefix",
  async (kib) => {
    const f = await settledAtBytes(kib * 1024, false, 20);
    const latest = observation(
      "partial-prefix",
      "All deliverables are complete.",
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
      (state) => state.pending?.journal.completions.length === 1,
    );
    if (!accepted?.pending) throw new Error("Missing accepted prefix");
    const ids = accepted.pending.journal.completions.flatMap(
      (record) => record.chunkIds,
    );
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(20);
    const checkpoint = encodeCheckpoint(accepted, f.meta);
    if (kib === 499) expect(size(checkpoint)).toBeGreaterThan(496 * 1024);
    const h = await restored(f, checkpoint, latest);
    h.monitor.turnOn("/nonexistent-hybrid-test");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.extract).not.toHaveBeenCalled();
    expect(h.requests.some((request) => "gate" in request.questions)).toBe(
      false,
    );
    const questioned = h.requests.flatMap((request) =>
      Object.keys(request.questions)
        .filter(
          (key) => key.startsWith("complete:") || key.startsWith("withdraw:"),
        )
        .map((key) => key.slice(key.indexOf(":") + 1)),
    );
    expect(questioned.some((id) => ids.includes(id))).toBe(false);
    if (kib === 480) expect(questioned.length).toBeGreaterThan(0);
    if (!questioned.length) {
      expect(h.monitor.checkpoint()).toHaveProperty("state.capacity", "limit");
      expect(h.monitor.state.pending).toEqual(accepted.pending);
      expect(h.monitor.state.tasks).toEqual(accepted.tasks);
      expect(h.monitor.state.events).toEqual(accepted.events);
      expect(h.monitor.state.scopeUnresolved).toBe(accepted.scopeUnresolved);
    } else if (!h.monitor.state.pending) {
      expect(h.monitor.state.cursor?.id).toBe(latest.id);
      expect(h.monitor.checkpoint()).toHaveProperty("state.capacity", "clear");
    }
    expect(
      h.save.mock.calls.every(([value]) => size(value) <= 512 * 1024),
    ).toBe(true);
  },
);
