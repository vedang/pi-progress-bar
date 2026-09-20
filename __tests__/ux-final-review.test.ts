import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  checkpointBytes,
  MAX_CHECKPOINT_BYTES,
  monitorCheckpointMetadata,
} from "../src/core/hybrid-checkpoint";
import { normalizedChoiceAssessment } from "../src/core/hybrid-proof";
import { noPatch, observation } from "./fixtures/hybrid";
import { branchEntry, monitorHarness } from "./fixtures/hybrid-monitor";
import {
  detailAddExtraction,
  isDetailRequest,
  required,
  savedDetails,
} from "./fixtures/task-details";

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
function fixture(
  details = false,
  text = "Implement parser, add regression, and validate it.",
) {
  const h = monitorHarness(
    [branchEntry("goal", text)],
    details
      ? {
          richDetailsEnabled: true,
          extractionText: (input) =>
            JSON.stringify(
              input.latest.id === "goal" ? detailAddExtraction() : noPatch(),
            ),
        }
      : {},
  );
  running.push(h);
  return h;
}
const tool = (id: string) => ({
  type: "toolCall",
  id,
  name: "read",
  arguments: { path: "src/parser.ts" },
});
const declared = (id: string) => ({ role: "assistant", content: [tool(id)] });
function chooseActivity(h: ReturnType<typeof fixture>) {
  const transport = required(h.fetch.getMockImplementation());
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    const response = await transport(url, init);
    if (!request.questions.activityFocus) return response;
    const body = (await response.json()) as {
      answers: Record<string, unknown>;
    };
    body.answers.activityFocus = {
      type: "choice",
      choice: "task:1",
      confidence: 1,
      probabilities: Object.fromEntries(
        Object.keys(request.questions.activityFocus.criteria).map((key) => [
          key,
          key === "task:1" ? 1 : 0,
        ]),
      ),
    };
    return Response.json(body);
  });
}
it("canonical amendment re-enables optional activity gateway after replay", async () => {
  const h = fixture();
  chooseActivity(h);
  h.start();
  await h.settle("goal");
  const text =
    "Implement parser, add regression, and validate it. Amended requirements.";
  h.replace([branchEntry("goal", text)]);
  await vi.advanceTimersByTimeAsync(100);
  await h.settle("goal");
  expect(h.monitor.state.cursor?.hash).toBe(observation("goal", text).hash);
  h.monitor.observeActivityDeclaration(declared("after-amend"));
  await vi.advanceTimersByTimeAsync(50);
  expect(
    h.requests.filter((request) => "activityFocus" in request.questions),
  ).toHaveLength(1);
  expect(h.monitor.boardSnapshot().currentTask).toMatchObject({
    taskId: "task:1",
    status: "INPROG",
  });
});
it("boundary-uncertain tool reconciliation cannot resurrect prior semantic INPROG", async () => {
  const h = fixture();
  chooseActivity(h);
  h.start();
  await h.settle("goal");
  expect(h.monitor.boardSnapshot().currentTask?.status).toBe("INPROG");
  h.monitor.observeActivityDeclaration(declared("declared"));
  const started = tool("unexpected");
  h.monitor.observeActivityStart(started.id, started.name, started.arguments);
  h.monitor.observeActivityTurnEnd(declared("declared"));
  await vi.advanceTimersByTimeAsync(50);
  expect(
    h.monitor.boardSnapshot().tasks.every((task) => task.status !== "INPROG"),
  ).toBe(true);
});
it("new declared tools immediately supersede retained idle DONE without changing reported completion", async () => {
  const h = fixture();
  const transport = required(h.fetch.getMockImplementation());
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    const response = await transport(url, init);
    const body = (await response.json()) as {
      answers: Record<string, unknown>;
    };
    for (const [key, question] of Object.entries(request.questions)) {
      const choice = key.startsWith("complete:") ? "yes" : undefined;
      if (choice)
        body.answers[key] = {
          type: "choice",
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys((question as { criteria: object }).criteria).map(
              (key) => [key, key === choice ? 1 : 0],
            ),
          ),
        };
    }
    return Response.json(body);
  });
  // Establish a displayed open task before reporting all completed.
  const normal = required(h.fetch.getMockImplementation());
  h.fetch.mockImplementation(transport);
  h.start();
  await h.settle("goal");
  h.fetch.mockImplementation(normal);
  h.append("completed-all", "All deliverables are complete.");
  await h.settle("completed-all");
  expect(h.monitor.boardSnapshot().currentTask?.status).toBe("DONE");
  h.monitor.observeActivityDeclaration(declared("new-work"));
  expect(h.monitor.boardSnapshot().currentTask?.status).not.toBe("DONE");
  expect(h.monitor.presentationSnapshot().progress).toMatchObject({
    done: 3,
    total: 3,
  });
});
it("accepted rich details survive unrelated observations and every publication after source cache ages out", async () => {
  const h = fixture(true);
  h.start();
  await h.settle("goal");
  const details = structuredClone(
    required(h.monitor.boardSnapshot().tasks[0]?.details),
  );
  const calls = h.requests.filter(isDetailRequest).length;
  const publications: unknown[] = [];
  h.changed.mockImplementation(() =>
    publications.push(h.monitor.boardSnapshot().tasks[0]?.details),
  );
  for (let i = 0; i < 5; i++) {
    const id = `unrelated-${i}`;
    h.append(id, `Progress commentary ${i}; no new task.`);
    await h.settle(id);
  }
  expect(h.monitor.boardSnapshot().tasks[0]?.details).toEqual(details);
  expect(publications.length).toBeGreaterThan(0);
  for (const value of publications) expect(value).toEqual(details);
  expect(h.requests.filter(isDetailRequest)).toHaveLength(calls);
});
it("valid long canonical context admits all detail keys with bounded requests and receipts", async () => {
  const text = `Implement parser, add regression, and validate it. ${"Context prose. ".repeat(480)}`;
  expect(Buffer.byteLength(text)).toBeLessThan(12 * 1024);
  const h = fixture(true, text);
  h.start();
  await h.settle("goal");
  await vi.advanceTimersByTimeAsync(300);
  const requests = h.requests.filter(isDetailRequest);
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests)
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(
      24 * 1024,
    );
  const expected = [
    "detail:title",
    "detail:description",
    "detail:acceptance:0",
  ];
  expect(requests.flatMap((request) => Object.keys(request.questions))).toEqual(
    expected,
  );
  expect(
    savedDetails(h.monitor.checkpoint())[0]?.receipts.flatMap(
      (receipt) => receipt.candidateKeys,
    ),
  ).toEqual(expected.map((key) => key.slice(7)));
});
it("failed optional receipt persistence rolls back accepted tokens together with the receipt", async () => {
  const h = fixture(true);
  const transport = required(h.fetch.getMockImplementation());
  let before:
    | ReturnType<typeof h.monitor.presentationSnapshot>["usage"]["jev"]
    | undefined;
  h.fetch.mockImplementation(async (url, init) => {
    if (isDetailRequest(JSON.parse(String(init?.body))))
      before = structuredClone(h.monitor.presentationSnapshot().usage.jev);
    return transport(url, init);
  });
  h.save.mockImplementation((cp) => {
    if (savedDetails(cp).some((record) => record.receipts.length))
      throw new Error("Synthetic optional receipt save failure");
  });
  h.start();
  await h.settle("goal");
  expect(before).toBeDefined();
  // Other optional health can follow; compare saved detail usage transaction at failure.
  expect(savedDetails(h.monitor.checkpoint())[0]?.receipts).toEqual([]);
  const failed = h.save.mock.calls.find(([cp]) =>
    savedDetails(cp).some((record) => record.receipts.length),
  );
  expect(failed).toBeDefined();
  h.save.mockImplementation(() => {});
  const counters = required(before);
  const detailResultTokens = h.monitor.presentationSnapshot().usage.jev;
  const healthAfter = h.requests.filter(
    (request) => !isDetailRequest(request),
  ).length;
  expect(detailResultTokens.inputTokens).toBe(healthAfter * 2);
  expect(detailResultTokens.outputTokens).toBe(healthAfter);
  expect(detailResultTokens.calls).toBeGreaterThanOrEqual(counters.calls);
  expect(h.monitor.state.capacity).toBe("clear");
});

it("detail admission reserves long normalized fractional assessment bytes, not shortest yes/1 outcomes", async () => {
  const h = fixture(true);
  h.start();
  await h.settle("goal");
  const record = structuredClone(
    required(savedDetails(h.monitor.checkpoint())[0]),
  );
  record.receipts = [];
  const maximum = Reflect.apply(
    Reflect.get(h.monitor, "maximumDetailRecord"),
    h.monitor,
    [record],
  );
  const metadata = required(monitorCheckpointMetadata(h.monitor.checkpoint()));
  metadata.taskDetails = [maximum];
  h.monitor.state.scopeError = "";
  const shortSize = checkpointBytes(h.monitor.state, metadata);
  const legal = structuredClone(record);
  legal.receipts = [
    {
      requestHash: "f".repeat(64),
      candidateKeys: legal.candidates.map((c) => c.key),
      validatedAt: Number.MAX_SAFE_INTEGER,
      assessments: legal.candidates.map((candidate) =>
        required(
          normalizedChoiceAssessment(
            "uncertain",
            0.12345678901234568,
            0.23456789012345677,
            {
              entryId: candidate.source.entryId,
              messageHash: candidate.source.messageHash,
              role: candidate.source.role,
            },
            new Set(["yes", "no", "uncertain"]),
          ),
        ),
      ),
    },
  ];
  metadata.taskDetails = [legal];
  const legalSize = checkpointBytes(h.monitor.state, metadata);
  // At minimum the advertised maximum must dominate every valid receipt.
  expect(shortSize).toBeGreaterThanOrEqual(legalSize);
  h.monitor.state.scopeError = "x".repeat(MAX_CHECKPOINT_BYTES - legalSize + 1);
  expect(
    Reflect.apply(Reflect.get(h.monitor, "admitDetails"), h.monitor, [record]),
  ).toBe(false);
  expect(h.monitor.state.capacity).toBe("clear");
});
