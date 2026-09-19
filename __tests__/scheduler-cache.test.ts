import { expect, it, vi } from "vitest";
import { type EvaluationRequest, JevGateway } from "../src/analysis/gateway";
import { AnalysisScheduler } from "../src/analysis/scheduler";

const request = (id: number): EvaluationRequest => ({
  model: "jev-1.13.0",
  state: { id },
  questions: {
    result: {
      type: "choice",
      instructions: "Choose the supplied answer",
      criteria: { yes: "Yes", no: "No" },
    },
  },
});
const answer = () =>
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
    usage: { input_tokens: 1, output_tokens: 1 },
  });

it("admits exact work even after more than 200 other successful identities", async () => {
  const fetcher = vi.fn(async () => answer());
  const gateway = new JevGateway({
    getApiKey: () => "offline-key",
    fetch: fetcher,
  });
  gateway.enable("runtime");
  const scheduler = new AnalysisScheduler(gateway, () => {});
  try {
    for (let id = 0; id < 201; id++)
      await new Promise<void>((resolve) => {
        scheduler.enqueue("discovery", {
          request: request(id),
          consentIdentity: "runtime",
          admit: () => resolve(),
        });
      });
    const admit = vi.fn();
    scheduler.enqueue("discovery", {
      request: request(0),
      consentIdentity: "runtime",
      admit,
    });
    await vi.waitFor(() => expect(admit).toHaveBeenCalledOnce(), {
      timeout: 200,
    });
    // Bounded eviction may re-evaluate; suppressing a request without its result may not strand its owner.
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(202);
  } finally {
    scheduler.clear();
    gateway.pause();
  }
});

it("shares one exact concurrent request across purposes without dropping either admission", async () => {
  let finish: ((value: Response) => void) | undefined;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const gateway = new JevGateway({
    getApiKey: () => "offline-key",
    fetch: fetcher,
  });
  gateway.enable("runtime");
  const scheduler = new AnalysisScheduler(gateway, () => {});
  const first = vi.fn();
  const second = vi.fn();
  try {
    scheduler.enqueue("fresh", {
      request: request(0),
      consentIdentity: "runtime",
      admit: first,
    });
    scheduler.tick();
    scheduler.enqueue("historical", {
      request: request(0),
      consentIdentity: "runtime",
      admit: second,
    });
    finish?.(answer());
    await vi.waitFor(
      () => {
        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledOnce();
      },
      { timeout: 200 },
    );
    expect(fetcher).toHaveBeenCalledOnce();
  } finally {
    scheduler.clear();
    gateway.pause();
  }
});
