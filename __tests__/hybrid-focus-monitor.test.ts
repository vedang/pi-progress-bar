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
function fixture(focus = "task:2", complete: string[] = []) {
  const h = monitorHarness();
  running.push(h);
  const original = h.fetch.getMockImplementation();
  if (!original) throw new Error("Missing transport");
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    const response = await original(url, init);
    if (request.state.latest?.id === "goal") return response;
    const body = (await response.json()) as {
      answers: Record<string, unknown>;
    };
    for (const [key, question] of Object.entries(request.questions)) {
      const answer =
        key === "focus"
          ? request.state.latest?.id === "held"
            ? "task:1"
            : focus
          : complete.includes(key)
            ? "yes"
            : undefined;
      if (!answer) continue;
      const criteria = (question as { criteria: Record<string, string> })
        .criteria;
      body.answers[key] = {
        type: "choice",
        choice: answer,
        confidence: 1,
        probabilities: Object.fromEntries(
          Object.keys(criteria).map((k) => [k, k === answer ? 1 : 0]),
        ),
      };
    }
    return Response.json(body);
  });
  return h;
}
it("health follows new open focus B rather than just-completed old focus A", async () => {
  const h = fixture("task:2", ["complete:task:1"]);
  h.start();
  await h.settle("goal");
  expect(h.monitor.presentationSnapshot().card?.taskId).toBe("task:1");
  h.append(
    "switch",
    "Parser implementation finished. I am now writing the regression.",
  );
  await h.settle("switch");
  expect(h.monitor.state.focusTaskId).toBe("task:2");
  expect(h.monitor.presentationSnapshot().card).toMatchObject({
    taskId: "task:2",
    retained: false,
    replacementPending: false,
  });
  expect(h.monitor.evidenceLink()).toBeUndefined();
});
it.each(["none", "concurrent", "uncertain"])(
  "refreshes health with %s activity without inferring current focus",
  async (focus) => {
    const h = fixture(focus);
    h.start();
    await h.settle("goal");
    const before = h.monitor.presentationSnapshot().card;
    const calls = h.requests.filter((r) => "clarity" in r.questions).length;
    h.append("ambiguous", "Work is paused or distributed across tasks.");
    await h.settle("ambiguous");
    expect(h.monitor.state.focusTaskId).toBeUndefined();
    expect(h.requests.filter((r) => "clarity" in r.questions)).toHaveLength(
      calls + 3,
    );
    expect(h.monitor.presentationSnapshot().card).toMatchObject({
      taskId: before?.taskId,
      retained: true,
      replacementPending: false,
      health: before?.health,
    });
  },
);
it("preserves all-done retained card while clearing current focus", async () => {
  const h = fixture("none", [
    "complete:task:1",
    "complete:task:2",
    "complete:task:3",
  ]);
  h.start();
  await h.settle("goal");
  const before = h.monitor.presentationSnapshot().card;
  h.append("done", "All requested parser work is complete.");
  await h.settle("done");
  expect(h.monitor.state.focusTaskId).toBeUndefined();
  expect(h.monitor.presentationSnapshot().card).toMatchObject({
    taskId: before?.taskId,
    retained: true,
    replacementPending: false,
  });
});
it("retains B's own health replacement-pending after A completes until B refresh is admitted", async () => {
  const h = fixture("task:2", ["complete:task:1"]);
  h.start();
  await h.settle("goal");
  const original = h.fetch.getMockImplementation();
  if (!original) throw new Error("Missing fake");
  let release: (() => void) | undefined;
  let hold = true;
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    const response = await original(url, init);
    if (request.questions.clarity && hold)
      return new Promise<Response>((resolve) => {
        release = () => {
          hold = false;
          resolve(response);
        };
      });
    return response;
  });
  h.append("switch", "Parser complete. I am now writing the regression.");
  await h.settle("switch");
  expect(release).toBeDefined();
  expect(h.monitor.state.focusTaskId).toBe("task:2");
  expect(h.monitor.presentationSnapshot().card).toMatchObject({
    taskId: "task:2",
    retained: true,
    replacementPending: true,
  });
  const saved = h.monitor.checkpoint();
  expect(saved).toMatchObject({
    monitor: {
      healthCards: expect.arrayContaining([
        expect.objectContaining({ taskId: "task:1" }),
      ]),
    },
  });
  expect(saved).not.toHaveProperty("monitor.card");
  release?.();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.presentationSnapshot().card).toMatchObject({
    taskId: "task:2",
    retained: false,
    replacementPending: false,
  });
  h.monitor.stop();
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  expect(h.monitor.presentationSnapshot().card).toMatchObject({
    taskId: "task:2",
    retained: true,
    replacementPending: true,
  });
});

it("late health for A cannot replace selected B and tool callbacks never own focus", async () => {
  const h = fixture();
  h.start();
  await h.settle("goal");
  const original = h.fetch.getMockImplementation();
  if (!original) throw new Error("Missing fake");
  let release: (() => void) | undefined;
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    const response = await original(url, init);
    if (
      request.questions.clarity &&
      JSON.stringify(request.state).includes("Held health")
    )
      return new Promise<Response>((resolve) => {
        release = () => resolve(response);
      });
    return response;
  });
  h.append("held", "Held health update: I am now implementing the parser.");
  for (let i = 0; i < 200 && !release; i++)
    await vi.advanceTimersByTimeAsync(1);
  expect(release).toBeDefined();
  h.append("switch", "Still working on the regression.");
  release?.();
  await h.settle("switch");
  expect(h.monitor.presentationSnapshot().card?.taskId).toBe("task:2");
  const before = h.monitor.state.focusTaskId;
  h.monitor.observeToolStart("unowned", "bash", { command: "npm test" });
  h.monitor.observeToolEnd(
    "unowned",
    "bash",
    { content: [{ type: "text", text: "passed" }] },
    false,
  );
  await vi.advanceTimersByTimeAsync(50);
  expect(h.monitor.state.focusTaskId).toBe(before);
  expect(h.monitor.evidenceLink()).toBeUndefined();
});
