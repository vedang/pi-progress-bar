import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { monitorHarness } from "./fixtures/hybrid-monitor";

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
function method(
  h: ReturnType<typeof monitorHarness>,
  name: string,
  ...args: unknown[]
) {
  const fn = Reflect.get(h.monitor, name);
  expect(fn, name).toBeTypeOf("function");
  return Reflect.apply(fn, h.monitor, args);
}
function readSnapshot(h: ReturnType<typeof monitorHarness>) {
  return method(h, "correctionSnapshot") as {
    tasks: Array<{ red?: { choice: string; revision: number } }>;
  };
}
async function fixture() {
  const h = monitorHarness();
  running.push(h);
  const emit = vi.fn();
  Reflect.get(h.monitor, "options").onCorrection = emit;
  h.start();
  await h.settle("goal");
  const transport = h.fetch.getMockImplementation();
  if (!transport) throw new Error("transport");
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (
      !Object.keys(request.questions).some((key) => key.startsWith("correct:"))
    )
      return transport(url, init);
    return Response.json({
      model: "jev-1.13.0",
      usage: { input_tokens: 2, output_tokens: 1 },
      answers: Object.fromEntries(
        Object.keys(request.questions).map((key) => [
          key,
          {
            type: "choice",
            choice: key === "correct:task:1" ? "nudge" : "unrelated",
            confidence: 1,
            probabilities: {
              nudge: key === "correct:task:1" ? 1 : 0,
              required: 0,
              unrelated: key === "correct:task:1" ? 0 : 1,
              unknown: 0,
            },
          },
        ]),
      ),
    });
  });
  return { ...h, emit };
}
const attempt = {
  kind: "test",
  id: "write-1",
  toolName: "write",
  path: "__tests__/parser.test.ts",
};
it("exposes detached runtime-only existing health facts and full included board", async () => {
  const h = await fixture();
  const checkpoint = JSON.stringify(h.monitor.checkpoint());
  const snapshot = readSnapshot(h);
  expect(snapshot.tasks).toHaveLength(3);
  expect(snapshot.tasks[0].red).toMatchObject({
    choice: "not-needed",
    revision: 1,
  });
  const red = snapshot.tasks[0].red;
  if (!red) throw new Error("Missing health fact");
  red.choice = "needed";
  expect(readSnapshot(h).tasks[0].red?.choice).toBe("not-needed");
  expect(JSON.stringify(h.monitor.checkpoint())).toBe(checkpoint);
});
it("classifies started test using existing health, accounts dispatch, and emits no task mutation", async () => {
  const h = await fixture();
  const before = structuredClone(h.monitor.state.tasks);
  const calls = h.monitor.usage.jev.calls;
  await method(h, "observeCorrectionAttempt", attempt);
  expect(h.emit).toHaveBeenCalledTimes(1);
  expect(h.emit.mock.calls[0][0]).toMatchObject({
    kind: "test-correction",
    attemptId: "write-1",
  });
  expect(h.monitor.usage.jev.calls).toBe(calls + 1);
  expect(h.monitor.state.tasks).toEqual(before);
  await method(h, "observeCorrectionAttempt", attempt);
  expect(h.emit).toHaveBeenCalledTimes(1);
});
it("never uses health from an older task revision", async () => {
  const h = await fixture();
  h.monitor.state.tasks[0].revision++;
  const calls = h.fetch.mock.calls.length;
  await method(h, "observeCorrectionAttempt", attempt);
  expect(h.emit).not.toHaveBeenCalled();
  expect(h.fetch.mock.calls.length).toBe(calls);
});
it("OFF fences a classification already in flight", async () => {
  const h = await fixture();
  const transport = h.fetch.getMockImplementation();
  if (!transport) throw new Error("transport");
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.fetch.mockImplementation(async (...args) => {
    await wait;
    return transport(...args);
  });
  const work = method(h, "observeCorrectionAttempt", attempt);
  await Promise.resolve();
  h.monitor.turnOff();
  release();
  await work;
  expect(h.emit).not.toHaveBeenCalled();
});
it("new external input invalidates old health/attempt authority without persisting it", async () => {
  const h = await fixture();
  method(h, "invalidateCorrections");
  await method(h, "observeCorrectionAttempt", attempt);
  expect(h.emit).not.toHaveBeenCalled();
  expect(
    readSnapshot(h).tasks.every((task: { red?: unknown }) => !task.red),
  ).toBe(true);
});
