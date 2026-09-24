import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HybridTask } from "../src/core/hybrid-state";
import { observation } from "./fixtures/hybrid";
import { monitorHarness } from "./fixtures/hybrid-monitor";

type Snapshot = {
  enabled: boolean;
  reason: string;
  tasks: Pick<
    HybridTask,
    "id" | "label" | "status" | "included" | "revision"
  >[];
};
type Harness = ReturnType<typeof monitorHarness>;
const running: Harness[] = [];
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
function fixture() {
  const h = monitorHarness();
  running.push(h);
  return h;
}
async function settled() {
  const h = fixture();
  h.start();
  await h.settle("goal");
  return h;
}
function snapshot(h: Harness): Snapshot {
  const method = Reflect.get(h.monitor, "advisorySettlementSnapshot");
  expect(method, "Missing passive advisory settlement snapshot").toBeTypeOf(
    "function",
  );
  return Reflect.apply(method, h.monitor, []);
}
// Isolate each private semantic blocker without dispatching synthetic work.
function withField(
  h: Harness,
  field: string,
  value: unknown,
  check: () => void,
) {
  const before = Reflect.get(h.monitor, field);
  Reflect.set(h.monitor, field, value);
  try {
    check();
  } finally {
    Reflect.set(h.monitor, field, before);
  }
}

it("reports disabled until master enablement and ready after semantic settlement", async () => {
  const h = fixture();
  expect(snapshot(h)).toEqual({
    enabled: false,
    reason: "disabled",
    tasks: [],
  });
  h.start();
  await h.settle("goal");
  expect(snapshot(h).reason).toBe("ready");
  h.monitor.turnOff();
  expect(snapshot(h)).toMatchObject({ enabled: false, reason: "disabled" });
});

it("returns all included rows, including completed rows, with no source or optional metadata", async () => {
  const h = await settled();
  h.monitor.state.tasks[0].included = false;
  h.monitor.state.tasks[1].status = "done";
  expect(snapshot(h)).toEqual({
    enabled: true,
    reason: "ready",
    tasks: h.monitor.state.tasks
      .filter((task) => task.included)
      .map(({ id, label, status, included, revision }) => ({
        id,
        label,
        status,
        included,
        revision,
      })),
  });
});

it("is passive, detached, and leaves v8 checkpoint bytes unchanged", async () => {
  const h = await settled();
  const checkpoint = JSON.stringify(h.monitor.checkpoint());
  const state = structuredClone(h.monitor.state);
  const counts = [
    h.reader.mock.calls.length,
    h.fetch.mock.calls.length,
    h.extract.mock.calls.length,
    h.save.mock.calls.length,
    h.changed.mock.calls.length,
    vi.getTimerCount(),
  ];
  const first = snapshot(h);
  first.tasks[0].label = "changed detached copy";
  first.tasks[0].status = "done";
  first.tasks.splice(1);
  expect(snapshot(h).tasks).toHaveLength(3);
  expect(h.monitor.state).toEqual(state);
  expect(JSON.stringify(h.monitor.checkpoint())).toBe(checkpoint);
  expect([
    h.reader.mock.calls.length,
    h.fetch.mock.calls.length,
    h.extract.mock.calls.length,
    h.save.mock.calls.length,
    h.changed.mock.calls.length,
    vi.getTimerCount(),
  ]).toEqual(counts);
  const second = snapshot(h);
  h.monitor.state.tasks[0].label = "later authority";
  expect(second.tasks[0].label).toBe(state.tasks[0].label);
});

it.each([
  ["controlWork", { kind: "restore" }, "canonical-scan"],
  ["pendingScan", {}, "canonical-scan"],
  ["canonicalWakeTimer", 123, "canonical-scan"],
  ["activeObservation", {}, "active-observation"],
  ["processing", true, "active-observation"],
  ["queued", [observation("next", "Additional work")], "queued-observation"],
  ["retryTimer", 123, "retry-timer"],
  ["waitingForWake", true, "model-wait"],
  ["blockedPending", { id: "goal", hash: "blocked" }, "blocked"],
])(
  "does not report ready with semantic blocker %s",
  async (field, value, reason) => {
    const h = await settled();
    withField(h, String(field), value, () =>
      expect(snapshot(h).reason).toBe(reason),
    );
    expect(snapshot(h).reason).toBe("ready");
  },
);

it("distinguishes unresolved scope and capacity, independent of human error strings", async () => {
  const h = await settled();
  h.monitor.error = "display-only error";
  expect(snapshot(h).reason).toBe("ready");
  h.monitor.state.scopeUnresolved = true;
  expect(snapshot(h).reason).toBe("unresolved");
  h.monitor.state.scopeUnresolved = false;
  h.monitor.state.capacity = "limit";
  expect(snapshot(h).reason).toBe("capacity");
});

it("waits for a real pending extraction journal and resumes readiness after commit", async () => {
  const h = fixture();
  const extract = h.extract.getMockImplementation();
  if (!extract) throw new Error("Missing fixture extraction");
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.extract.mockImplementation(async (...args) => {
    await wait;
    return extract(...args);
  });
  h.start();
  await vi.advanceTimersByTimeAsync(50);
  expect(h.monitor.state.pending).toBeDefined();
  expect(snapshot(h).reason).not.toBe("ready");
  // Journal alone must veto, even between active transport phases.
  withField(h, "activeObservation", undefined, () => {
    withField(h, "processing", false, () =>
      expect(snapshot(h).reason).toBe("pending-journal"),
    );
  });
  release();
  await h.settle("goal");
  expect(snapshot(h).reason).toBe("ready");
});

it.each([
  "healthObservation",
  "healthFlight",
  "detailFlight",
  "activityFlight",
  "activityQueued",
  "activityDeclaration",
  "activityFocus",
  "beadsInFlight",
])("ignores optional %s when semantic state is settled", async (field) => {
  const h = await settled();
  const before = snapshot(h);
  withField(h, field, { private: "optional enrichment" }, () =>
    expect(snapshot(h)).toEqual(before),
  );
});

it("restores semantic readiness without introducing checkpoint fields or paid reprocessing", async () => {
  const h = await settled();
  const data = h.monitor.checkpoint();
  const fetches = h.fetch.mock.calls.length;
  const extracts = h.extract.mock.calls.length;
  await h.monitor.restore("/nonexistent-hybrid-test", data, false, h.reader);
  await vi.advanceTimersByTimeAsync(50);
  expect(snapshot(h).reason).toBe("ready");
  expect(h.monitor.checkpoint()).toMatchObject({ version: 9 });
  expect(h.extract.mock.calls.length).toBe(extracts);
  // Optional health restoration may run; no semantic replay request is allowed.
  expect(
    h.requests
      .slice(fetches)
      .every(
        (request) =>
          !("gate" in request.questions) &&
          !Object.keys(request.questions).some((key) =>
            key.startsWith("complete:"),
          ),
      ),
  ).toBe(true);
});
