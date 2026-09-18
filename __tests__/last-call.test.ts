import { describe, expect, it, vi } from "vitest";
import { JevGateway } from "../src/analysis/gateway";

const request = {
  model: "jev-1.13.0",
  state: { task: "one" },
  questions: {
    q: {
      type: "choice" as const,
      instructions: "Choose",
      criteria: { yes: "Yes", no: "No" },
    },
  },
};
const result = {
  model: request.model,
  answers: {
    q: {
      type: "choice",
      choice: "yes",
      confidence: 1,
      probabilities: { yes: 1, no: 0 },
    },
  },
  usage: { input_tokens: 1, output_tokens: 1 },
};

describe("actual Jev dispatch timestamp", () => {
  it("updates on real dispatch, not cache hits or redraw/scheduling", async () => {
    let now = 1000;
    const fetch = vi.fn(async () => Response.json(result));
    const gateway = new JevGateway({
      fetch,
      getApiKey: () => "test",
      now: () => now,
    });
    expect(gateway.lastCallAt).toBeUndefined();
    gateway.enable("session");
    expect(gateway.lastCallAt).toBeUndefined();
    await gateway.evaluate(request, "session");
    expect(gateway.lastCallAt).toBe(1000);
    now = 2000;
    await gateway.evaluate(request, "session");
    expect(gateway.lastCallAt).toBe(1000);
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 3000;
    await gateway.evaluate({ ...request, state: { task: "two" } }, "session");
    expect(gateway.lastCallAt).toBe(3000);
  });
  it("records a failed attempt but does not advance during retry backoff", async () => {
    let now = 1000;
    const fetch = vi.fn(async () => new Response(null, { status: 503 }));
    const gateway = new JevGateway({
      fetch,
      getApiKey: () => "test",
      now: () => now,
    });
    gateway.enable("session");
    await gateway.evaluate(request, "session");
    expect(gateway.lastCallAt).toBe(1000);
    now = 2000;
    await gateway.evaluate(request, "session");
    expect(gateway.lastCallAt).toBe(1000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not invent a call timestamp when credentials or consent prevent dispatch", async () => {
    const fetch = vi.fn(async () => Response.json(result));
    const gateway = new JevGateway({
      fetch,
      getApiKey: () => undefined,
      now: () => 1000,
    });
    await gateway.evaluate(request, "session");
    gateway.enable("session");
    await gateway.evaluate(request, "session");
    expect(gateway.lastCallAt).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
