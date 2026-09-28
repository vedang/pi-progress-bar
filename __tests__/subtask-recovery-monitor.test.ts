import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EvaluationRequest } from "../src/analysis/gateway";
import type { SubtaskProposalRequest } from "../src/analysis/subtask-proposal";
import {
  type encodeSubtaskCheckpoint,
  subtaskCheckpointStorageStatus,
} from "../src/core/hybrid-checkpoint";
import {
  branchEntry,
  jevReply,
  monitorHarness,
} from "./fixtures/hybrid-monitor";

type Envelope = ReturnType<typeof encodeSubtaskCheckpoint>;
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

it.each(["transport", "malformed", "persistence"])(
  "recovers a charged %s proposal only under a new selected-model identity without re-extracting parents or refunding history",
  async (failure) => {
    const goal =
      "Compare operating costs and deployment risks, then recommend deployment.";
    let model = "fixture/selected";
    let failed = false;
    const network = vi.fn();
    const requests: EvaluationRequest[] = [];
    const h = monitorHarness([branchEntry("goal", goal)], {
      extractionText: (input) =>
        JSON.stringify({
          add: input.tasks.length
            ? []
            : [
                {
                  label: "Recommend deployment",
                  kind: "response",
                  basis: "explicit",
                  quote: goal,
                },
              ],
          revise: [],
          archive: [],
          restore: [],
          unresolved: false,
        }),
      monitorOptions: {
        selectedModel: () => model,
        proposeSubtasks: async (
          request: SubtaskProposalRequest,
          signal: AbortSignal,
          onDispatch?: (at: number) => boolean,
          onPhysicalFlight?: (drain: Promise<void>) => void,
        ) => {
          if (onDispatch?.(Date.now()) !== true || signal.aborted)
            throw new Error("Vetoed");
          onPhysicalFlight?.(Promise.resolve());
          network();
          const contextIndex = request.input.context.findIndex(
            (entry) => entry.id === "goal" && entry.text === goal,
          );
          expect(contextIndex).toBeGreaterThanOrEqual(0);
          let text = JSON.stringify({
            proposals: [
              {
                parentIndex: 0,
                complete: true,
                knownTotal: 2,
                removals: [],
                children: [
                  "Compare operating costs",
                  "Assess deployment risks",
                ].map((label) => ({
                  kind: "add",
                  label,
                  evidence: [{ contextIndex, start: 0, end: goal.length }],
                })),
              },
            ],
          });
          if (!failed && failure !== "persistence") {
            failed = true;
            if (failure === "transport")
              throw new Error("Unknown dispatched failure");
            text = "{invalid-json";
          }
          return {
            provider: "fixture",
            model: request.input.selectedModel.slice("fixture/".length),
            requestHash: request.requestHash,
            usage: { inputTokens: 3, outputTokens: 2 },
            text,
          };
        },
      },
    });
    running.push(h);
    h.fetch.mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as EvaluationRequest;
      requests.push(request);
      const response = (await jevReply(request).json()) as {
        answers: Record<string, unknown>;
      };
      if (request.questions["subtask:0"])
        response.answers["subtask:0"] = {
          type: "choice",
          choice: "yes",
          confidence: 1,
          probabilities: { yes: 1, no: 0, uncertain: 0 },
        };
      return Response.json(response);
    });
    if (failure === "persistence")
      h.save.mockImplementation((value) => {
        if (
          !failed &&
          (value as Envelope).monitor?.subtasks?.state.groups.length
        ) {
          failed = true;
          throw new Error("Accepted group publication refused");
        }
      });
    function checkpoint() {
      const saved = h.monitor.checkpoint();
      expect(subtaskCheckpointStorageStatus(saved)).toBe("supported");
      return saved as Envelope;
    }
    const counts = () => ({
      extraction: h.extract.mock.calls.length,
      gate: requests.filter((request) => request.questions["subtask:0"]).length,
      mandatory: requests.filter((request) => !request.questions["subtask:0"])
        .length,
      proposal: network.mock.calls.length,
    });
    h.start();
    await h.settle("goal");
    await vi.advanceTimersByTimeAsync(100);
    expect(failed).toBe(true);
    expect(h.monitor.subtaskSnapshot().groups).toEqual([]);
    expect(network).toHaveBeenCalledTimes(1);
    const previous = checkpoint().monitor?.subtasks?.journal;
    const owner = previous?.records.find((record) => record.proposal);
    if (!previous || !owner)
      throw new Error("Missing real charged proposal history");
    expect(previous.dispatches).toBe(2);
    expect(owner.proposal?.dispatch).toBe(2);
    const before = counts();

    // Named wake alone cannot replay unknown/invalid/unpublished work.
    h.monitor.modelSelected();
    await vi.advanceTimersByTimeAsync(200);
    expect(counts()).toEqual(before);
    expect(checkpoint().monitor?.subtasks?.journal.dispatches).toBe(2);

    model = "fixture/recovered";
    h.monitor.modelSelected();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.monitor.subtaskSnapshot().groups[0]?.children).toHaveLength(2);
    expect(counts()).toEqual({
      ...before,
      gate: before.gate + 1,
      proposal: before.proposal + 1,
    });
    const recovered = checkpoint().monitor?.subtasks?.journal;
    expect(recovered?.dispatches).toBe(4);
    expect(
      recovered?.records.find((record) => record.identity === owner.identity),
    ).toMatchObject({
      state: "superseded",
      gate: owner.gate,
      proposal: owner.proposal,
    });
    expect(recovered?.usage.extraction.calls).toBe(
      previous.usage.extraction.calls + 1,
    );
    const after = counts();
    h.monitor.modelSelected();
    await vi.advanceTimersByTimeAsync(200);
    expect(counts()).toEqual(after);
    expect(checkpoint().monitor?.subtasks?.journal.dispatches).toBe(4);
  },
);
