import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { monitorHarness } from "./fixtures/hybrid-monitor";

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

it("refreshes task health from a later explicit report without requiring a scope change", async () => {
  const h = fixture();
  const original = h.fetch.getMockImplementation();
  if (!original) throw new Error("Missing fake");
  const report =
    "I wrote and observed a failing regression test for the parser.";
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    const response = await original(url, init);
    if (!request.questions.redReport) return response;
    const body = (await response.json()) as {
      answers: Record<string, unknown>;
    };
    const choice = JSON.stringify(request.state).includes(report)
      ? "reported-red"
      : "not-found";
    body.answers.redReport = {
      type: "choice",
      choice,
      confidence: 1,
      probabilities: Object.fromEntries(
        Object.keys(request.questions.redReport.criteria).map((key) => [
          key,
          key === choice ? 1 : 0,
        ]),
      ),
    };
    return Response.json(body);
  });
  h.start();
  await h.settle("goal");
  const before = h.monitor.presentationSnapshot().card;
  expect(before?.health.redEvidence).not.toBe("Reported red");
  h.append("red-report", report);
  await h.settle("red-report");
  const after = h.monitor.presentationSnapshot().card;
  expect(after?.taskId).toBe(before?.taskId);
  expect(after?.revision).toBe(before?.revision);
  expect(after?.health.redEvidence).toBe("Reported red");
  expect(h.extract).toHaveBeenCalledTimes(1);
  expect(h.monitor.state.tasks.every((task) => task.status !== "done")).toBe(
    true,
  );
});

it("qualifies the last health card as retained when its focused task completes", async () => {
  const h = fixture();
  h.start();
  await h.settle("goal");
  const before = h.monitor.presentationSnapshot().card;
  const original = h.fetch.getMockImplementation();
  if (!original) throw new Error("Missing fake");
  h.fetch.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    const body = (await response.json()) as {
      answers: Record<string, unknown>;
    };
    if (body.answers["complete:task:1"])
      body.answers["complete:task:1"] = {
        type: "choice",
        choice: "yes",
        confidence: 1,
        probabilities: { yes: 1, no: 0, uncertain: 0 },
      };
    return Response.json(body);
  });
  h.append(
    "focused-done",
    "The parser is implemented; the other tasks remain open.",
  );
  await h.settle("focused-done");
  expect(h.monitor.state.tasks[0]?.status).toBe("done");
  expect(h.monitor.state.focusTaskId).toBe(before?.taskId);
  expect(h.monitor.presentationSnapshot().card).toMatchObject({
    taskId: before?.taskId,
    label: before?.label,
    retained: true,
    replacementPending: false,
  });
});
