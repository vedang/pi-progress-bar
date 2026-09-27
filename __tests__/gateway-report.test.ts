import { afterEach, expect, it, vi } from "vitest";
import { JevGateway, MODEL } from "../src/analysis/gateway";

const request = {
  model: MODEL,
  state: { report: "Synthetic mechanics only" },
  questions: {
    child: {
      type: "choice" as const,
      instructions: "Assess the synthetic report.",
      criteria: { unchanged: "No transition", completed: "Reported complete" },
    },
  },
};
const result = {
  model: MODEL,
  answers: {
    child: {
      type: "choice",
      choice: "unchanged",
      confidence: 1,
      probabilities: { unchanged: 1, completed: 0 },
    },
  },
  usage: { input_tokens: 3, output_tokens: 5 },
};
function fixture(
  fetcher = vi.fn(async (): Promise<Response> => Response.json(result)),
) {
  let now = 0;
  let key: string | undefined = "fixture-key";
  const dispatch = vi.fn();
  const admission = vi.fn(() => true);
  const drains: Promise<void>[] = [];
  const gateway = new JevGateway({
    fetch: fetcher,
    getApiKey: () => key,
    now: () => now,
    beforeDispatch: admission,
    onDispatch: dispatch,
    onPhysicalFlight: (drain) => {
      drains.push(drain);
    },
  });
  gateway.enable("report");
  return {
    gateway,
    fetcher,
    dispatch,
    admission,
    drains,
    setTime: (time: number) => {
      now = time;
    },
    noKey: () => {
      key = undefined;
    },
  };
}
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});
it("returns validated result plus existing gateway accounting without changing evaluate", async () => {
  const h = fixture();
  expect(await h.gateway.evaluateWithOutcome(request, "report")).toEqual({
    kind: "result",
    result,
  });
  expect(h.dispatch).toHaveBeenCalledTimes(1);
  expect(h.gateway.lastOutcome).toBe("success");
  expect(await h.gateway.evaluate(request, "report", true)).toEqual(result);
  expect(h.dispatch).toHaveBeenCalledTimes(2);
});
it.each([408, 429, 500, 503, 529, 599])(
  "certifies observed HTTP%s only after one admitted fetch",
  async (status) => {
    const h = fixture(vi.fn(async () => new Response(null, { status })));
    expect(await h.gateway.evaluateWithOutcome(request, "report")).toEqual({
      kind: "retryable",
      retryAfterMs: 10000,
    });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(h.gateway.lastOutcome).toBe("retryable");
  },
);
it("retains 10s/20s/5min backoff and never wakes or retries internally", async () => {
  vi.useFakeTimers();
  const h = fixture(vi.fn(async () => new Response(null, { status: 503 })));
  expect(await h.gateway.evaluateWithOutcome(request, "report")).toEqual({
    kind: "retryable",
    retryAfterMs: 10000,
  });
  expect(await h.gateway.evaluateWithOutcome(request, "report")).toEqual({
    kind: "deferred",
    retryAfterMs: 10000,
  });
  expect(h.dispatch).toHaveBeenCalledTimes(1);
  h.setTime(10000);
  expect(await h.gateway.evaluateWithOutcome(request, "report")).toEqual({
    kind: "retryable",
    retryAfterMs: 20000,
  });
  h.setTime(30000);
  expect(await h.gateway.evaluateWithOutcome(request, "report")).toEqual({
    kind: "retryable",
    retryAfterMs: 300000,
  });
  h.setTime(330000);
  await vi.advanceTimersByTimeAsync(330000);
  expect(h.fetcher).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});
it.each([
  ["60", 60000],
  ["10.0001", 10001],
  ["Thu, 01 Jan 1970 00:01:00 GMT", 60000],
] as const)(
  "honors and rounds Retry-After %s without clamping",
  async (header, delay) => {
    const h = fixture(
      vi.fn(
        async () =>
          new Response(null, {
            status: 429,
            headers: { "retry-after": header },
          }),
      ),
    );
    expect(await h.gateway.evaluateWithOutcome(request, "report")).toEqual({
      kind: "retryable",
      retryAfterMs: delay,
    });
    expect(await h.gateway.evaluateWithOutcome(request, "report")).toEqual({
      kind: "deferred",
      retryAfterMs: delay,
    });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  },
);
it("refuses unrepresentable Retry-After instead of granting an earlier retry", async () => {
  const h = fixture(
    vi.fn(
      async () =>
        new Response(null, {
          status: 429,
          headers: { "retry-after": String(Number.MAX_SAFE_INTEGER) },
        }),
    ),
  );
  expect(await h.gateway.evaluateWithOutcome(request, "report")).toEqual({
    kind: "failed",
  });
  expect(h.dispatch).toHaveBeenCalledTimes(1);
});
it("does not certify a thrown network error despite legacy lastOutcome retryable", async () => {
  const h = fixture(
    vi.fn(async (): Promise<Response> => {
      throw new Error("Network unavailable");
    }),
  );
  expect(await h.gateway.evaluateWithOutcome(request, "report")).toEqual({
    kind: "failed",
  });
  expect(h.gateway.lastOutcome).toBe("retryable");
  expect(h.dispatch).toHaveBeenCalledTimes(1);
});
it.each([302, 400, 401, 403, 422])(
  "does not certify HTTP%s as retryable",
  async (status) => {
    const h = fixture(vi.fn(async () => new Response(null, { status })));
    expect(await h.gateway.evaluateWithOutcome(request, "report")).toEqual({
      kind: "failed",
    });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  },
);
it("returns unavailable without dispatch when credentials are absent", async () => {
  const h = fixture();
  h.noKey();
  expect(await h.gateway.evaluateWithOutcome(request, "report")).toEqual({
    kind: "unavailable",
  });
  expect(h.dispatch).not.toHaveBeenCalled();
  expect(h.fetcher).not.toHaveBeenCalled();
});
it("preserves predispatch admission veto and successful-request dedupe", async () => {
  const h = fixture();
  h.admission.mockReturnValueOnce(false);
  expect(await h.gateway.evaluateWithOutcome(request, "report")).toEqual({
    kind: "failed",
  });
  expect(h.dispatch).not.toHaveBeenCalled();
  expect(h.fetcher).not.toHaveBeenCalled();
  expect(await h.gateway.evaluateWithOutcome(request, "report")).toEqual({
    kind: "result",
    result,
  });
  expect(await h.gateway.evaluateWithOutcome(request, "report")).toEqual({
    kind: "failed",
  });
  expect(h.fetcher).toHaveBeenCalledTimes(1);
});
it("rejects malformed successful responses without certifying an HTTP retry", async () => {
  const h = fixture(
    vi.fn(async () => Response.json({ ...result, answers: {} })),
  );
  expect(await h.gateway.evaluateWithOutcome(request, "report")).toEqual({
    kind: "failed",
  });
  expect(h.gateway.lastOutcome).toBe("invalid");
  expect(h.dispatch).toHaveBeenCalledTimes(1);
});
it.each(["timeout", "invalidate"])(
  "keeps %s nonretryable while exposing abort-ignoring physical drain",
  async (mode) => {
    vi.useFakeTimers();
    let release!: () => void;
    const h = fixture(
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = () => resolve(new Response(null, { status: 503 }));
          }),
      ),
    );
    let drained = false;
    const pending = h.gateway.evaluateWithOutcome(request, "report");
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    void h.drains[0].then(() => {
      drained = true;
    });
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(10000);
    else h.gateway.invalidate();
    expect(await pending).toEqual({ kind: "failed" });
    expect(drained).toBe(false);
    release();
    await h.drains[0];
    expect(drained).toBe(true);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  },
);
it("isolates each result from a concurrent busy classification", async () => {
  let release!: () => void;
  const h = fixture(
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response(null, { status: 503 }));
        }),
    ),
  );
  const active = h.gateway.evaluateWithOutcome(request, "report");
  const busy = await h.gateway.evaluateWithOutcome(request, "report");
  expect(busy).toEqual({ kind: "failed" });
  expect(h.gateway.lastOutcome).toBe("busy");
  release();
  expect(await active).toEqual({ kind: "retryable", retryAfterMs: 10000 });
  expect(h.fetcher).toHaveBeenCalledTimes(1);
});
