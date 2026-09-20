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
const call = (id: string, path = "src/a.ts") => ({
  type: "toolCall",
  id,
  name: "read",
  arguments: { path, secret: "PRIVATE_ARG_SENTINEL" },
});
const declared = (...calls: ReturnType<typeof call>[]) => ({
  role: "assistant",
  content: [{ type: "text", text: "PRIVATE_TEXT_SENTINEL" }, ...calls],
});
function event(
  h: ReturnType<typeof monitorHarness>,
  name: string,
  ...args: unknown[]
) {
  const fn = Reflect.get(h.monitor, name);
  expect(fn, `Missing activity event ${name}`).toBeTypeOf("function");
  return Reflect.apply(fn, h.monitor, args);
}
async function fixture() {
  const h = monitorHarness();
  running.push(h);
  h.start();
  await h.settle("goal");
  const transport = h.fetch.getMockImplementation();
  if (!transport) throw new Error("Missing transport");
  const requests: unknown[] = [];
  let choice = "task:2";
  let hold = false;
  const releases: (() => void)[] = [];
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (!request.questions.activityFocus) return transport(url, init);
    requests.push(request);
    const selected = choice;
    if (hold) await new Promise<void>((resolve) => releases.push(resolve));
    return Response.json({
      model: "jev-1.13.0",
      usage: { input_tokens: 2, output_tokens: 1 },
      answers: {
        activityFocus: {
          type: "choice",
          choice: selected,
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(request.questions.activityFocus.criteria).map((key) => [
              key,
              key === selected ? 1 : 0,
            ]),
          ),
        },
      },
    });
  });
  const start = (item: ReturnType<typeof call>) =>
    event(h, "observeActivityStart", item.id, item.name, item.arguments);
  const begin = (...items: ReturnType<typeof call>[]) =>
    event(h, "observeActivityDeclaration", declared(...items));
  const end = (...items: ReturnType<typeof call>[]) =>
    event(h, "observeActivityTurnEnd", declared(...items));
  return Object.assign(h, {
    requests,
    releases,
    start,
    begin,
    end,
    choose: (value: string) => {
      choice = value;
    },
    hold: () => {
      hold = true;
    },
  });
}
it("dispatches immediate declared batch before starts without mutating semantic state", async () => {
  const h = await fixture();
  const state = structuredClone(h.monitor.state);
  const calls = h.monitor.presentationSnapshot().usage.jev.calls;
  h.begin(call("PRIVATE_ID_SENTINEL"), call("b", "src/b.ts"));
  await vi.advanceTimersByTimeAsync(10);
  expect(h.requests).toHaveLength(1);
  expect(JSON.stringify(h.requests)).toContain("src/a.ts");
  expect(JSON.stringify(h.requests)).toContain("src/b.ts");
  expect(JSON.stringify(h.requests)).not.toContain("SENTINEL");
  expect(h.monitor.state).toEqual(state);
  expect(h.monitor.boardSnapshot().currentTask).toMatchObject({
    taskId: "task:2",
    status: "INPROG",
  });
  expect(h.monitor.presentationSnapshot().usage.jev.calls).toBe(calls + 1);
  expect(JSON.stringify(h.monitor.checkpoint())).not.toContain("SENTINEL");
});
it.each([false, true])(
  "unchanged finalized list never duplicates provisional request (held=%s)",
  async (hold) => {
    const h = await fixture();
    if (hold) h.hold();
    const a = call("a"),
      b = call("b", "src/b.ts");
    h.begin(a, b);
    await vi.advanceTimersByTimeAsync(10);
    h.start(a);
    h.start(b);
    h.end(a, b);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.requests).toHaveLength(1);
    for (const release of h.releases) release();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.requests).toHaveLength(1);
  },
);
it("changed list gets one correction and late provisional response cannot win", async () => {
  const h = await fixture();
  h.hold();
  const a = call("a"),
    b = call("b", "src/b.ts");
  h.begin(a);
  await vi.advanceTimersByTimeAsync(10);
  h.choose("task:3");
  h.start(a);
  h.start(b);
  h.end(a, b);
  expect(h.monitor.boardSnapshot().currentTask?.status).not.toBe("INPROG");
  h.releases[0]?.();
  await vi.advanceTimersByTimeAsync(10);
  expect(h.requests).toHaveLength(2);
  expect(h.monitor.boardSnapshot().currentTask?.status).not.toBe("INPROG");
  h.releases[1]?.();
  await vi.advanceTimersByTimeAsync(10);
  expect(h.monitor.boardSnapshot().currentTask).toMatchObject({
    taskId: "task:3",
    status: "INPROG",
  });
});
it("one active flight retains only the latest queued batch", async () => {
  const h = await fixture();
  h.hold();
  h.begin(call("a"));
  await vi.advanceTimersByTimeAsync(10);
  h.begin(call("b", "src/b.ts"));
  h.begin(call("c", "src/c.ts"));
  await vi.advanceTimersByTimeAsync(10);
  expect(h.requests).toHaveLength(1);
  h.releases[0]?.();
  await vi.advanceTimersByTimeAsync(10);
  expect(h.requests).toHaveLength(2);
  expect(JSON.stringify(h.requests[1])).toContain("src/c.ts");
  expect(JSON.stringify(h.requests[1])).not.toContain("src/b.ts");
  h.releases[1]?.();
  await vi.advanceTimersByTimeAsync(10);
});
it.each(["none", "concurrent", "uncertain"])(
  "%s activity clears prior exclusivity without inventing completion",
  async (choice) => {
    const h = await fixture();
    h.begin(call("a"));
    await vi.advanceTimersByTimeAsync(10);
    expect(h.monitor.boardSnapshot().currentTask?.status).toBe("INPROG");
    h.choose(choice);
    h.begin(call("b"));
    await vi.advanceTimersByTimeAsync(10);
    expect(h.monitor.boardSnapshot().currentTask?.status).not.toBe("INPROG");
    expect(h.monitor.state.tasks.every((task) => task.status !== "done")).toBe(
      true,
    );
  },
);
it("overflow never dispatches a sampled list", async () => {
  const h = await fixture();
  h.begin({ ...call("a"), name: "界".repeat(1400) });
  await vi.advanceTimersByTimeAsync(10);
  expect(h.requests).toHaveLength(0);
  expect(h.monitor.boardSnapshot().currentTask?.status).not.toBe("INPROG");
  expect(h.monitor.state.capacity).toBe("clear");
});
it.each(["turnOff", "stop", "modelSelected"])(
  "%s fences active activity results",
  async (method) => {
    const h = await fixture();
    h.hold();
    h.begin(call("a"));
    await vi.advanceTimersByTimeAsync(10);
    expect(h.requests).toHaveLength(1);
    const calls = h.monitor.presentationSnapshot().usage.jev.calls;
    event(h, method);
    h.releases[0]?.();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.monitor.boardSnapshot().currentTask?.taskId).not.toBe("task:2");
    expect(h.monitor.presentationSnapshot().usage.jev.calls).toBe(calls);
  },
);
it("semantic preemption rejects old active result and obsolete queued work", async () => {
  const h = await fixture();
  h.hold();
  h.begin(call("a"));
  await vi.advanceTimersByTimeAsync(10);
  h.begin(call("b"));
  h.append("new-work", "Revise the parser task scope.", "user");
  await vi.advanceTimersByTimeAsync(50);
  h.releases[0]?.();
  await vi.advanceTimersByTimeAsync(50);
  expect(h.requests).toHaveLength(1);
  expect(h.monitor.boardSnapshot().currentTask?.taskId).not.toBe("task:2");
});
it("optional metadata denial skips activity without limiting semantic tracking", async () => {
  const h = await fixture();
  const state = structuredClone(h.monitor.state);
  Reflect.set(h.monitor, "admitActivity", () => false);
  h.begin(call("a"));
  await vi.advanceTimersByTimeAsync(10);
  expect(h.requests).toHaveLength(0);
  expect(h.monitor.state).toEqual(state);
  expect(h.monitor.state.capacity).toBe("clear");
});
it.each(["close", "revise", "archive"])(
  "%s invalidates exact active task eligibility",
  async (change) => {
    const h = await fixture();
    h.hold();
    h.begin(call("a"));
    await vi.advanceTimersByTimeAsync(10);
    const task = h.monitor.state.tasks.find((task) => task.id === "task:2");
    if (!task) throw new Error("Missing task");
    if (change === "close") task.status = "done";
    if (change === "revise") task.revision++;
    if (change === "archive") task.included = false;
    h.releases[0]?.();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.monitor.boardSnapshot().currentTask?.taskId).not.toBe("task:2");
  },
);

it("restore clears ephemeral activity and fences the old transport result", async () => {
  const h = await fixture();
  const checkpoint = h.monitor.checkpoint();
  h.hold();
  h.begin(call("a"));
  await vi.advanceTimersByTimeAsync(10);
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    checkpoint,
    false,
    h.reader,
  );
  h.releases[0]?.();
  await vi.advanceTimersByTimeAsync(20);
  expect(h.monitor.boardSnapshot().currentTask?.taskId).not.toBe("task:2");
  expect(JSON.stringify(h.monitor.checkpoint())).not.toContain(
    "PRIVATE_ARG_SENTINEL",
  );
});
it("failed optional request counts dispatch without automatic activity retry", async () => {
  const h = await fixture();
  const calls = h.monitor.presentationSnapshot().usage.jev.calls;
  h.fetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
  h.begin(call("a"));
  await vi.advanceTimersByTimeAsync(10);
  expect(h.monitor.presentationSnapshot().usage.jev.calls).toBe(calls + 1);
  const dispatched = h.fetch.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.fetch).toHaveBeenCalledTimes(dispatched);
  expect(h.monitor.state.capacity).toBe("clear");
});
it("low-confidence activity does not become exclusive or disable mandatory tracking", async () => {
  const h = await fixture();
  h.fetch.mockResolvedValueOnce(
    Response.json({
      model: "jev-1.13.0",
      usage: { input_tokens: 2, output_tokens: 1 },
      answers: {
        activityFocus: {
          type: "choice",
          choice: "task:2",
          confidence: 0.4,
          probabilities: { "task:2": 0.99, none: 0.01 },
        },
      },
    }),
  );
  h.begin(call("a"));
  await vi.advanceTimersByTimeAsync(10);
  expect(h.monitor.boardSnapshot().currentTask?.status).not.toBe("INPROG");
  expect(h.monitor.enabled).toBe(true);
});

it("mandatory semantic flight prevents optional dispatch until eligible or superseded", async () => {
  const h = await fixture();
  const previous = h.fetch.getMockImplementation();
  if (!previous) throw new Error("Missing transport");
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.questions.gate) await held;
    return previous(url, init);
  });
  h.append("pending-semantic", "Now change the requested work.", "user");
  await vi.advanceTimersByTimeAsync(1);
  h.begin(call("a"));
  await vi.advanceTimersByTimeAsync(10);
  expect(h.requests).toHaveLength(0);
  release();
  await vi.advanceTimersByTimeAsync(100);
});
it("already-applied activity proof expires when its task revision changes", async () => {
  const h = await fixture();
  h.begin(call("a"));
  await vi.advanceTimersByTimeAsync(10);
  expect(h.monitor.boardSnapshot().currentTask).toMatchObject({
    taskId: "task:2",
    status: "INPROG",
  });
  const task = h.monitor.state.tasks.find((task) => task.id === "task:2");
  if (!task) throw new Error("Missing task");
  task.revision++;
  expect(
    h.monitor.boardSnapshot().tasks.find((task) => task.taskId === "task:2")
      ?.status,
  ).not.toBe("INPROG");
});
