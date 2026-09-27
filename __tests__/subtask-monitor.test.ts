import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EvaluationRequest } from "../src/analysis/gateway";
import type { SubtaskProposalRequest } from "../src/analysis/subtask-proposal";
import {
  branchEntry,
  jevReply,
  monitorHarness,
} from "./fixtures/hybrid-monitor";

const running: ReturnType<typeof monitorHarness>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline");
});
afterEach(() => {
  for (const h of running.splice(0)) h.monitor.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("runs generic decomposition after unchanged mandatory semantics without tools or a second parent extraction", async () => {
  const text = "Compare operating costs and risks, then recommend deployment.";
  let need = false;
  const proposeSubtasks = vi.fn(
    async (
      request: SubtaskProposalRequest,
      signal: AbortSignal,
      onDispatch?: (at: number) => boolean,
      onPhysicalFlight?: (drain: Promise<void>) => void,
    ) => {
      expect(onPhysicalFlight).toBeTypeOf("function");
      onPhysicalFlight?.(Promise.resolve());
      if (onDispatch?.(Date.now()) === false || signal.aborted)
        throw new Error("vetoed");
      const contextIndex = request.input.context.findIndex(
        (item) => item.text === text,
      );
      return {
        provider: "fixture",
        model: "selected",
        requestHash: request.requestHash,
        usage: { inputTokens: 1, outputTokens: 1 },
        text: JSON.stringify({
          proposals: [
            {
              parentIndex: 0,
              complete: false,
              removals: [],
              children: [
                "Compare operating costs",
                "Assess deployment risks",
              ].map((label) => ({
                kind: "add",
                label,
                evidence: [{ contextIndex, start: 0, end: text.length }],
              })),
            },
          ],
        }),
      };
    },
  );
  const h = monitorHarness([branchEntry("goal", text)], {
    extractionText: () =>
      JSON.stringify({
        add: [
          {
            label: "Recommend deployment",
            kind: "response",
            basis: "explicit",
            quote: text,
          },
        ],
        revise: [],
        archive: [],
        restore: [],
        unresolved: false,
      }),
    monitorOptions: {
      selectedModel: () => "fixture/selected",
      proposeSubtasks,
    },
  });
  running.push(h);
  h.fetch.mockImplementation(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as EvaluationRequest;
    const response = (await jevReply(request).json()) as {
      answers: Record<string, unknown>;
    };
    if (request.questions["subtask:0"])
      response.answers["subtask:0"] = {
        type: "choice",
        choice: need ? "yes" : "no",
        confidence: 1,
        probabilities: { yes: need ? 1 : 0, no: need ? 0 : 1, uncertain: 0 },
      };
    return Response.json(response);
  });
  h.start();
  await h.settle("goal");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.state.tasks).toHaveLength(1);
  expect(proposeSubtasks).not.toHaveBeenCalled();
  const tasks = structuredClone(h.monitor.state.tasks);
  const extractionCalls = h.extract.mock.calls.length;
  need = true;
  h.append("clarification", "Explain the tradeoffs in separate steps.", "user");
  await h.settle("clarification");
  await vi.advanceTimersByTimeAsync(200);
  expect(h.extract).toHaveBeenCalledTimes(extractionCalls);
  expect(proposeSubtasks).toHaveBeenCalledTimes(1);
  expect(h.monitor.subtaskSnapshot().groups[0]?.children).toHaveLength(2);
  expect(h.monitor.state.tasks).toEqual(tasks);
  const saved = h.monitor.checkpoint();
  expect(saved).toMatchObject({ version: 11 });
  h.observe();
  h.observe();
  await vi.advanceTimersByTimeAsync(200);
  expect(proposeSubtasks).toHaveBeenCalledTimes(1);
});
