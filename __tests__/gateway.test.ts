import { afterEach, describe, expect, it, vi } from "vitest";
import { JevGateway } from "../src/analysis/gateway";

const request = {
  model: "jev-1.13.0",
  state: { task: "Describe required behavior" },
  questions: {
    acceptance: {
      type: "choice" as const,
      instructions: "Are criteria explicit in state.task?",
      criteria: {
        explicit: "Observable success condition",
        unknown: "Not enough evidence",
      },
    },
  },
};
const result = {
  model: request.model,
  answers: {
    acceptance: {
      type: "choice",
      choice: "explicit",
      probabilities: { explicit: 1, unknown: 0 },
      confidence: 1,
    },
  },
  usage: { input_tokens: 100, output_tokens: 0 },
};
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
describe("shared Jev gateway", () => {
  it("requires explicit consent and a key, and never sends unchanged successful state twice", async () => {
    let now = 0;
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json(result),
    );
    const gateway = new JevGateway({
      fetch: fetcher,
      getApiKey: () => "test-key",
      now: () => now,
    });
    expect(await gateway.evaluate(request, "scope-a")).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    gateway.enable("scope-a");
    expect(await gateway.evaluate(request, "scope-a")).toMatchObject(result);
    now = 20_000;
    expect(await gateway.evaluate(request, "scope-a")).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.typesafe.ai/v1/systemone",
    );
    const missing = new JevGateway({
      fetch: fetcher,
      getApiKey: () => undefined,
    });
    missing.enable("scope-a");
    expect(await missing.evaluate(request, "scope-a")).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ explicit: 0.66, unknown: 0.33 }, true],
    [{ explicit: 0.67, unknown: 0.34 }, true],
    [{ explicit: 0.7, unknown: 0.1 }, false],
    [{ explicit: 0.999, unknown: 0.02 }, false],
  ])(
    "accepts only bounded rounded probability totals: %j",
    async (probabilities, accepted) => {
      const rounded = {
        ...result,
        answers: {
          acceptance: { ...result.answers.acceptance, probabilities },
        },
      };
      const fetcher = vi.fn(async () => Response.json(rounded));
      const gateway = new JevGateway({
        fetch: fetcher,
        getApiKey: () => "fixture",
      });
      gateway.enable("scope");
      const value = await gateway.evaluate(request, "scope");
      if (accepted) {
        expect(value).toMatchObject(rounded);
        await gateway.evaluate(request, "scope");
        expect(fetcher).toHaveBeenCalledTimes(1);
      } else expect(value).toBeUndefined();
    },
  );

  it("allows only one in flight and discards a late result after pause or identity change", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(
      (_url: string, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const gateway = new JevGateway({
      fetch: fetcher,
      getApiKey: () => "test-key",
    });
    gateway.enable("scope-a");
    const first = gateway.evaluate(request, "scope-a");
    expect(
      await gateway.evaluate({ ...request, state: { task: "new" } }, "scope-a"),
    ).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    gateway.pause();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    finish(Response.json(result));
    expect(await first).toBeUndefined();
    expect(await gateway.evaluate(request, "scope-b")).toBeUndefined();
  });

  it("retries malformed responses with bounded backoff then a five-minute cooldown", async () => {
    let now = 0;
    const fetcher = vi.fn(async () =>
      Response.json({
        ...result,
        answers: {
          acceptance: { ...result.answers.acceptance, choice: "invented" },
        },
      }),
    );
    const gateway = new JevGateway({
      fetch: fetcher,
      getApiKey: () => "test-key",
      now: () => now,
    });
    gateway.enable("scope-a");
    for (const at of [0, 60_000, 180_000]) {
      now = at;
      expect(await gateway.evaluate(request, "scope-a")).toBeUndefined();
    }
    now = 240_000;
    expect(await gateway.evaluate(request, "scope-a")).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(gateway.status).toMatch(/cooldown|error|offline|invalid/i);
    now = 480_000;
    expect(await gateway.evaluate(request, "scope-a")).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("enforces request size and question caps before transport", async () => {
    const fetcher = vi.fn(async () => Response.json(result));
    const gateway = new JevGateway({
      fetch: fetcher,
      getApiKey: () => "test-key",
    });
    gateway.enable("scope-a");
    expect(
      await gateway.evaluate(
        { ...request, state: "x".repeat(25 * 1024) },
        "scope-a",
      ),
    ).toBeUndefined();
    expect(
      await gateway.evaluate(
        {
          ...request,
          questions: Object.fromEntries(
            Array.from({ length: 21 }, (_, i) => [
              String(i),
              request.questions.acceptance,
            ]),
          ),
        },
        "scope-a",
      ),
    ).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("continues beyond sixty successful requests without a lifetime wall", async () => {
    let now = 0;
    const fetcher = vi.fn(async () => Response.json(result));
    const gateway = new JevGateway({
      fetch: fetcher,
      getApiKey: () => "test-key",
      now: () => now,
    });
    gateway.enable("scope-a");
    for (let i = 0; i < 65; i++) {
      now = i * 1_000;
      expect(
        await gateway.evaluate(
          { ...request, state: { task: String(i) } },
          "scope-a",
        ),
      ).toBeDefined();
    }
    expect(fetcher).toHaveBeenCalledTimes(65);
    expect(gateway.status).toBe("Current");
  });

  it("respects Retry-After even for changed state", async () => {
    let now = 0;
    const fetcher = vi
      .fn(async () => Response.json(result))
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { "retry-after": "60" } }),
      );
    const gateway = new JevGateway({
      fetch: fetcher,
      getApiKey: () => "test-key",
      now: () => now,
    });
    gateway.enable("scope-a");
    await gateway.evaluate(request, "scope-a");
    now = 20_000;
    const changed = { ...request, state: { task: "new evidence" } };
    expect(await gateway.evaluate(changed, "scope-a")).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 60_000;
    expect(await gateway.evaluate(changed, "scope-a")).toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("cancels a stalled response stream when the deadline expires", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const gateway = new JevGateway({
      fetch: vi.fn(async () => new Response(new ReadableStream({ cancel }))),
      getApiKey: () => "test-key",
    });
    gateway.enable("scope-a");
    const pending = gateway.evaluate(request, "scope-a");
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await pending).toBeUndefined();
    expect(cancel).toHaveBeenCalled();
  });

  it("times out even when transport ignores abort", async () => {
    vi.useFakeTimers();
    const gateway = new JevGateway({
      fetch: vi.fn(() => new Promise<Response>(() => {})),
      getApiKey: () => "test-key",
    });
    gateway.enable("scope-a");
    const pending = gateway.evaluate(request, "scope-a");
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await pending).toBeUndefined();
    expect(gateway.status).toMatch(/timeout|offline|error/i);
  });
});
