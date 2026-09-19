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
const cwd = "/nonexistent-hybrid-test";
const goal = () =>
  branchEntry("goal", "Implement parser, add regression, and validate it.");
const blanks = (count = 200) =>
  Array.from({ length: count }, (_, i) =>
    branchEntry(`blank-${i}`, " ", "assistant"),
  );
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
async function fixture() {
  const entry = goal();
  const h = monitorHarness([entry]);
  running.push(h);
  h.start();
  await h.settle("goal");
  return { h, entry };
}
async function pendingFixture() {
  const { h, entry } = await fixture();
  const latest = observation(
    "target",
    "Work continues on parser.",
    "assistant",
  );
  const saved: HybridState[] = [];
  await processObservation(
    h.monitor.state,
    latest,
    backend(noPatch(), {
      gate: "unchanged",
      save: (state) => saved.push(structuredClone(state)),
    }),
    [observation(entry.id, entry.message.content)],
  );
  const state = saved.find(
    (value) =>
      value.pending?.journal.gate && !value.pending.journal.completions.length,
  );
  if (!state) throw new Error("Missing accepted gate");
  const metadata = monitorCheckpointMetadata(h.monitor.checkpoint());
  if (!metadata) throw new Error("Missing metadata");
  return {
    h,
    entry,
    latest,
    state,
    metadata,
    entries: [
      entry,
      ...blanks(),
      branchEntry(latest.id, latest.text, latest.role),
    ],
  };
}
async function finishRestore(work: Promise<void>) {
  let done = false;
  const completed = work.then(() => {
    done = true;
  });
  for (let step = 0; step < 2000 && !done; step++)
    await vi.advanceTimersByTimeAsync(1);
  expect(done).toBe(true);
  await completed;
}

it.each([false, true])(
  "OFF during bounded restore preserves target journal and overrides resume (old enabled=%s)",
  async (oldEnabled) => {
    const f = await pendingFixture();
    if (!oldEnabled) f.h.monitor.stop();
    // Change branch without triggering observe against old state.
    f.h.reader.mockImplementation(() => f.entries);
    f.h.save.mockClear();
    f.h.fetch.mockClear();
    f.h.extract.mockClear();
    const work = f.h.monitor.restore(
      cwd,
      encodeCheckpoint(f.state, f.metadata),
      oldEnabled,
      f.h.reader,
    );
    expect(f.h.monitor.enabled).toBe(false);
    f.h.monitor.turnOff();
    f.h.observe();
    f.h.monitor.modelSelected();
    await finishRestore(work);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.h.monitor.enabled).toBe(false);
    expect(f.h.monitor.state.pending?.journal).toEqual(
      f.state.pending?.journal,
    );
    expect(f.h.fetch).not.toHaveBeenCalled();
    expect(f.h.extract).not.toHaveBeenCalled();
    expect(f.h.save).toHaveBeenCalled();
    for (const [saved] of f.h.save.mock.calls) {
      expect(saved).toMatchObject({
        monitor: { enabled: false },
        state: { pending: { journal: f.state.pending?.journal } },
      });
    }
  },
);
it("restore promise does not resolve before exact context and target state are installed", async () => {
  const f = await pendingFixture();
  f.h.monitor.stop();
  f.h.reader.mockImplementation(() => f.entries);
  let done = false;
  const work = f.h.monitor
    .restore(
      cwd,
      encodeCheckpoint(f.state, { ...f.metadata, enabled: false }),
      false,
      f.h.reader,
    )
    .then(() => {
      done = true;
    });
  await Promise.resolve();
  expect(done).toBe(false);
  await finishRestore(work);
  expect(f.h.monitor.state.pending?.journal).toEqual(f.state.pending?.journal);
  expect(f.h.monitor.enabled).toBe(false);
});

it.each(["continuous", "reload", "off-on"])(
  "settled %s path uses exact prior context for next gate",
  async (mode) => {
    const { h, entry } = await fixture();
    if (mode === "reload")
      await finishRestore(
        h.monitor.restore(cwd, h.monitor.checkpoint(), false, h.reader),
      );
    if (mode === "off-on") {
      h.monitor.turnOff();
      h.monitor.turnOn(cwd);
    }
    h.append("after-control", "Current work update.");
    await h.settle("after-control");
    const gate = h.requests.find(
      (request) =>
        "gate" in request.questions &&
        (request.state as { latest?: { id?: string } }).latest?.id ===
          "after-control",
    );
    expect(
      (gate?.state as { earlier?: { id: string }[] })?.earlier?.map(
        (item) => item.id,
      ),
    ).toEqual([entry.id]);
  },
);
it("one ON command completes long pending context and never rebills accepted gate", async () => {
  const f = await pendingFixture();
  f.h.monitor.stop();
  f.h.reader.mockImplementation(() => f.entries);
  await finishRestore(
    f.h.monitor.restore(
      cwd,
      encodeCheckpoint(f.state, { ...f.metadata, enabled: false }),
      false,
      f.h.reader,
    ),
  );
  await vi.advanceTimersByTimeAsync(500);
  expect(f.h.monitor.state.pending?.journal).toEqual(f.state.pending?.journal);
  const original = f.h.fetch.getMockImplementation();
  if (!original) throw new Error("Missing transport");
  let release: (() => void) | undefined;
  let held = false;
  f.h.fetch.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    if (!held) {
      held = true;
      return new Promise<Response>((resolve) => {
        release = () => resolve(response);
      });
    }
    return response;
  });
  // First enable uses freshly restored complete context. OFF during held
  // completion then clears that context, making the next ON need continuation.
  f.h.monitor.turnOn(cwd);
  for (let step = 0; step < 100 && !release; step++)
    await vi.advanceTimersByTimeAsync(1);
  expect(release).toBeDefined();
  f.h.monitor.turnOff();
  f.h.requests.length = 0;
  f.h.monitor.turnOn(cwd);
  release?.();
  await vi.advanceTimersByTimeAsync(500);
  expect(f.h.monitor.enabled).toBe(true);
  expect(f.h.monitor.state.cursor?.id).toBe(f.latest.id);
  expect(f.h.requests.some((request) => "gate" in request.questions)).toBe(
    false,
  );
});

it.each([false, true])(
  "active result waits for complete immutable context reconciliation (changed=%s)",
  async (changed) => {
    const { h, entry } = await fixture();
    const original = h.fetch.getMockImplementation();
    if (!original) throw new Error("Missing transport");
    let release: (() => void) | undefined;
    let held = false;
    h.fetch.mockImplementation(async (url, init) => {
      const request = JSON.parse(String(init?.body));
      const response = await original(url, init);
      if (
        !held &&
        request.questions.gate &&
        request.state.latest.id === "active"
      ) {
        held = true;
        return new Promise<Response>((resolve) => {
          release = () => resolve(response);
        });
      }
      return response;
    });
    const active = branchEntry("active", "Working on parser.", "assistant");
    h.replace([entry, active]);
    for (let step = 0; step < 100 && !release; step++)
      await vi.advanceTimersByTimeAsync(1);
    expect(release).toBeDefined();
    h.save.mockClear();
    h.replace([
      entry,
      ...(changed
        ? [branchEntry("inserted", "A changed preceding instruction.")]
        : []),
      ...blanks(),
      active,
    ]);
    release?.();
    // Let the provider resolve, but do not advance continuation timers yet.
    for (let step = 0; step < 20; step++) await Promise.resolve();
    expect(
      h.save.mock.calls.some(([saved]) => {
        const state = (saved as { state?: HybridState }).state;
        return (
          state?.pending?.observation.entryId === "active" ||
          state?.cursor?.id === "active"
        );
      }),
    ).toBe(false);
    await h.settle("active");
    const gates = h.requests.filter(
      (request) =>
        "gate" in request.questions &&
        (request.state as { latest?: { id?: string } }).latest?.id === "active",
    );
    expect(gates).toHaveLength(changed ? 2 : 1);
  },
);

it("held full page plus structural append cannot spin a zero-progress continuation", async () => {
  const { h, entry } = await fixture();
  let reads = 0;
  const backlog = Array.from({ length: 70 }, (_, i) => ({
    type: "message",
    id: `backlog-${i}`,
    message: {
      role: "assistant",
      get content() {
        reads++;
        return `Progress report ${i}.`;
      },
    },
  }));
  const original = h.fetch.getMockImplementation();
  if (!original) throw new Error("Missing transport");
  let release: (() => void) | undefined;
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    const response = await original(url, init);
    if (request.questions.gate && request.state.latest.id === "backlog-0")
      return new Promise<Response>((resolve) => {
        release = () => resolve(response);
      });
    return response;
  });
  h.replace([entry, ...backlog]);
  for (let step = 0; step < 100 && !release; step++)
    await vi.advanceTimersByTimeAsync(1);
  expect(release).toBeDefined();
  await vi.advanceTimersByTimeAsync(20);
  // Establish terminal active context and a partial page; invalidate that
  // page synchronously before its continuation can discover a latest target.
  h.observe();
  h.replace([
    entry,
    ...backlog.slice(0, 30),
    branchEntry("inserted-backlog", "Inserted progress."),
    ...backlog.slice(30),
  ]);
  await vi.advanceTimersByTimeAsync(50);
  const settledReads = reads,
    readers = h.reader.mock.calls.length;
  await vi.advanceTimersByTimeAsync(200);
  expect(reads).toBe(settledReads);
  expect(h.reader).toHaveBeenCalledTimes(readers);
  h.fetch.mockImplementation(original);
  release?.();
  await h.settle("backlog-69");
});

it.each(["lower", "absent"])(
  "same-session tree restore with %s checkpoint cannot roll telemetry backward",
  async (mode) => {
    const { h } = await fixture();
    const before = h.monitor.presentationSnapshot();
    const metadata = monitorCheckpointMetadata(h.monitor.checkpoint());
    if (!metadata) throw new Error("Missing metadata");
    const lower = encodeCheckpoint(h.monitor.state, {
      ...metadata,
      lastJevCallAt: 1,
      lastExtractionCallAt: 1,
      usage: {
        jev: { calls: 1, inputTokens: 1, outputTokens: 1 },
        extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
      },
    });
    h.fetch.mockImplementation(() => new Promise<Response>(() => {}));
    await finishRestore(
      h.monitor.restore(
        cwd,
        mode === "lower" ? lower : undefined,
        true,
        h.reader,
      ),
    );
    const after = h.monitor.presentationSnapshot();
    expect(after.usage).toEqual(before.usage);
    expect(after.lastExtractionCallAt).toBeGreaterThanOrEqual(
      before.lastExtractionCallAt ?? 0,
    );
    expect(after.lastJevCallAt).toBeGreaterThanOrEqual(
      before.lastJevCallAt ?? 0,
    );
  },
);
it("terminal negative tail and later settled suffix clear catch-up and leave no idle scan", async () => {
  const { h, entry } = await fixture();
  h.replace([entry, ...blanks(1000)]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.monitor.presentationSnapshot().progress.catchup).toBeUndefined();
  const readers = h.reader.mock.calls.length,
    providers = h.requests.length;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.reader).toHaveBeenCalledTimes(readers);
  expect(h.requests).toHaveLength(providers);
  h.append("suffix", "Current work update.");
  await h.settle("suffix");
  expect(h.monitor.presentationSnapshot().progress.catchup).toBeUndefined();
});
