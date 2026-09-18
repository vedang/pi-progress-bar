import { describe, expect, it, vi } from "vitest";
import { type EvaluationRequest, JevGateway } from "../src/analysis/gateway";
import { AnalysisScheduler } from "../src/analysis/scheduler";

const request = (purpose: string, revision = 0): EvaluationRequest => ({
  model: "jev-1.13.0",
  state: { purpose, revision },
  questions: {
    result: {
      type: "choice",
      instructions: "Select a supplied label",
      criteria: { yes: "Supported", no: "Unsupported" },
    },
  },
});
const response = () =>
  Response.json({
    model: "jev-1.13.0",
    answers: {
      result: {
        type: "choice",
        choice: "yes",
        confidence: 1,
        probabilities: { yes: 1, no: 0 },
      },
    },
    usage: { input_tokens: 1, output_tokens: 0 },
  });

describe("shared analysis scheduling", () => {
  it("gives discovery and ordered reports turns despite continuously changing health", async () => {
    let now = 0;
    const dispatched: string[] = [];
    const gateway = new JevGateway({
      getApiKey: () => "test-key",
      now: () => now,
      fetch: async (_url, init) => {
        dispatched.push(JSON.parse(String(init?.body)).state.purpose);
        return response();
      },
    });
    gateway.enable("consented");
    const evaluate = vi.spyOn(gateway, "evaluate");
    const scheduler = new AnalysisScheduler(gateway, () => {});
    const admit = vi.fn();
    for (const purpose of ["health", "discovery", "reports"])
      scheduler.enqueue(purpose, {
        request: request(purpose),
        consentIdentity: "consented",
        admit,
      });
    for (let i = 0; i < 3; i++) {
      scheduler.enqueue("health", {
        request: request("health", i),
        consentIdentity: "consented",
        admit,
      });
      scheduler.startCycle(1);
      await evaluate.mock.results.at(-1)?.value;
      await Promise.resolve();
      now += 15000;
    }
    expect(dispatched).toEqual(["health", "discovery", "reports"]);
    expect(admit).toHaveBeenCalledTimes(3);
    scheduler.clear();
  });
  it("invalidating health alone does not cancel an in-flight report chunk", async () => {
    let finish!: (response: Response) => void;
    let signal: AbortSignal | null | undefined;
    const gateway = new JevGateway({
      getApiKey: () => "test-key",
      fetch: (_url, init) => {
        signal = init?.signal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    gateway.enable("consented");
    const evaluate = vi.spyOn(gateway, "evaluate");
    const scheduler = new AnalysisScheduler(gateway, () => {});
    const admit = vi.fn();
    scheduler.enqueue("reports", {
      request: request("reports"),
      consentIdentity: "consented",
      admit,
    });
    scheduler.startCycle(1);
    scheduler.discard("health");
    expect(signal?.aborted).toBe(false);
    finish(response());
    await evaluate.mock.results[0]?.value;
    await Promise.resolve();
    expect(admit).toHaveBeenCalledOnce();
    scheduler.clear();
  });
});
