import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { continuationAuthorityFixture } from "./fixtures/continuation";
import { branchEntry, monitorHarness } from "./fixtures/hybrid-monitor";

type Projection = ReturnType<
  typeof import("../src/advisory/continuation-authority").projectContinuationAuthority
>;
type Harness = ReturnType<typeof monitorHarness>;
const active: Harness[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline-key");
});
afterEach(() => {
  for (const h of active.splice(0)) h.monitor.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
function binding() {
  const { input } = continuationAuthorityFixture();
  const {
    receipt,
    policy,
    originalRunId,
    sessionEpoch,
    branchEpoch,
    controlEpoch,
    model,
  } = input;
  return {
    receipt,
    policy,
    originalRunId,
    sessionEpoch,
    branchEpoch,
    controlEpoch,
    model,
  };
}
function project(h: Harness): Projection {
  const method = Reflect.get(h.monitor, "continuationAuthority");
  expect(method, "Missing dedicated canonical authority projection").toBeTypeOf(
    "function",
  );
  return Reflect.apply(method, h.monitor, [binding()]);
}
async function fixture() {
  const h = monitorHarness();
  active.push(h);
  h.start();
  await h.settle("goal");
  return h;
}
function withReply(h: Harness) {
  const { question, reply } = continuationAuthorityFixture();
  h.replace([
    branchEntry("goal", "Implement parser, add regression, and validate it."),
    { ...question, parentId: "goal" },
    reply,
  ]);
}

it("does not mistake an older ready board for the accepted reply frontier", async () => {
  const h = await fixture();
  expect(h.monitor.advisorySettlementSnapshot().reason).toBe("ready");
  expect(project(h).available).toBe(false);
  withReply(h);
  expect(project(h).available).toBe(false);
  await h.settle("reply");
  expect(project(h).available).toBe(true);
});

it("projects current canonical history without mutating state, checkpoint or optional/provider work", async () => {
  const h = await fixture();
  withReply(h);
  await h.settle("reply");
  const state = structuredClone(h.monitor.state);
  const checkpoint = JSON.stringify(h.monitor.checkpoint());
  const counts = [
    h.fetch.mock.calls.length,
    h.extract.mock.calls.length,
    h.save.mock.calls.length,
    h.changed.mock.calls.length,
    vi.getTimerCount(),
  ];
  const result = project(h);
  expect(result.available).toBe(true);
  if (!result.available) throw new Error("Expected canonical projection");
  expect(result.context.map((item) => item.id)).toEqual(["goal", "reply"]);
  expect(result.tasks).toHaveLength(3);
  result.tasks[0].label = "Changed detached result";
  expect(h.monitor.state).toEqual(state);
  expect(JSON.stringify(h.monitor.checkpoint())).toBe(checkpoint);
  expect([
    h.fetch.mock.calls.length,
    h.extract.mock.calls.length,
    h.save.mock.calls.length,
    h.changed.mock.calls.length,
    vi.getTimerCount(),
  ]).toEqual(counts);
});

it("drops continuation authority immediately on OFF", async () => {
  const h = await fixture();
  withReply(h);
  await h.settle("reply");
  expect(project(h).available).toBe(true);
  h.monitor.turnOff();
  expect(project(h).available).toBe(false);
});
