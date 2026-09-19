import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { extractionInput } from "../src/analysis/extractor";
import { RetryableProviderError } from "../src/core/hybrid";
import { emptyState } from "../src/core/hybrid-state";
import { selectedModelExtractor } from "../src/core/selected-model";
import { initialMessage } from "./fixtures/hybrid";
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

it("records actual failed Jev dispatch and honors pending-only Retry-After without idle polling", async () => {
  const h = fixture();
  h.fetch.mockResolvedValueOnce(
    new Response("unavailable", {
      status: 429,
      headers: { "retry-after": "5" },
    }),
  );
  const dispatchedAt = Date.now();
  h.start();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.fetch).toHaveBeenCalledTimes(1);
  expect(h.monitor.presentationSnapshot().lastJevCallAt).toBe(dispatchedAt);
  expect(h.monitor.presentationSnapshot().service.code).not.toBe(
    "model-unavailable",
  );
  await vi.advanceTimersByTimeAsync(4899);
  expect(h.fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(101);
  await h.settle("goal");
  const calls = h.fetch.mock.calls.length;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.fetch).toHaveBeenCalledTimes(calls);
});

it("retries a transient completion failure without rebilling accepted gate or extraction", async () => {
  const h = fixture();
  const original = h.fetch.getMockImplementation();
  if (!original) throw new Error("Missing fake");
  let failed = false;
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (
      !failed &&
      Object.keys(request.questions).some((key) => key.startsWith("complete:"))
    ) {
      failed = true;
      return new Response("unavailable", { status: 503 });
    }
    return original(url, init);
  });
  h.start();
  await vi.advanceTimersByTimeAsync(10_000);
  await h.settle("goal");
  expect(failed).toBe(true);
  expect(h.extract).toHaveBeenCalledTimes(1);
  const requests = h.fetch.mock.calls.map(([, init]) =>
    JSON.parse(String(init?.body)),
  );
  expect(requests.filter((r) => r.questions.gate)).toHaveLength(1);
  expect(
    requests.filter((r) =>
      Object.keys(r.questions).some((key) => key.startsWith("complete:")),
    ),
  ).toHaveLength(2);
});

it("OFF cancels a pending retry and a permanent auth failure stays OFF", async () => {
  const h = fixture();
  h.fetch.mockResolvedValueOnce(
    new Response("unavailable", {
      status: 429,
      headers: { "retry-after": "5" },
    }),
  );
  h.start();
  await vi.advanceTimersByTimeAsync(50);
  h.monitor.turnOff();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.fetch).toHaveBeenCalledTimes(1);
  h.fetch.mockResolvedValueOnce(
    new Response("PRIVATE_AUTH_ERROR", { status: 401 }),
  );
  h.monitor.turnOn("/nonexistent-hybrid-test");
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.fetch).toHaveBeenCalledTimes(2);
  expect(h.monitor.enabled).toBe(false);
  expect(JSON.stringify(h.monitor.checkpoint())).not.toContain(
    "PRIVATE_AUTH_ERROR",
  );
});

it("OFF/ON during held extraction does not let the old epoch poison the new eligible wake", async () => {
  const h = fixture();
  const original = h.extract.getMockImplementation();
  if (!original) throw new Error("Missing fake");
  let release: (() => void) | undefined;
  h.extract.mockImplementationOnce(
    (input, signal) =>
      new Promise((resolve) => {
        release = () => {
          void original(input, signal).then(resolve);
        };
      }),
  );
  h.start();
  await vi.advanceTimersByTimeAsync(20);
  expect(release).toBeDefined();
  h.monitor.turnOff();
  h.monitor.turnOn("/nonexistent-hybrid-test");
  release?.();
  await h.settle("goal");
  expect(h.monitor.enabled).toBe(true);
  expect(h.extract).toHaveBeenCalledTimes(2);
  expect(h.requests.filter((r) => "gate" in r.questions)).toHaveLength(1);
});

function adapter(complete: ReturnType<typeof vi.fn>) {
  const ctx = {
    model: { id: "offline-model", provider: "offline" },
    modelRegistry: { complete },
  } as unknown as Pick<ExtensionContext, "model" | "modelRegistry">;
  return selectedModelExtractor(() => ctx);
}
const input = () =>
  extractionInput(emptyState("session:test"), initialMessage, []);

it("owns the 60s model deadline even when transport ignores timeout and abort", async () => {
  const complete = vi.fn(() => new Promise<never>(() => {}));
  const extract = adapter(complete);
  let settled = false;
  const result = extract(input(), new AbortController().signal).catch(
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  await vi.advanceTimersByTimeAsync(59_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBeInstanceOf(RetryableProviderError);
  expect(complete).toHaveBeenCalledTimes(1);
  expect((complete.mock.calls as unknown[][])[0]?.[2]).toMatchObject({
    maxTokens: 2048,
    maxRetries: 0,
    timeoutMs: 60_000,
  });
});

it("releases cancelled model work without waiting a full deadline for an abort-ignoring provider", async () => {
  const complete = vi.fn(() => new Promise<never>(() => {}));
  const controller = new AbortController();
  let settled = false;
  const result = adapter(complete)(input(), controller.signal).catch(
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  controller.abort();
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(true);
  expect(await result).toBeInstanceOf(RetryableProviderError);
});

it("does not dispatch a model request with an already-aborted signal", async () => {
  const complete = vi.fn(async () => ({
    stopReason: "stop",
    content: [],
    usage: {},
  }));
  const controller = new AbortController();
  controller.abort();
  await expect(
    adapter(complete)(input(), controller.signal),
  ).rejects.toBeInstanceOf(RetryableProviderError);
  expect(complete).not.toHaveBeenCalled();
});

it("classifies host error envelopes as transport failure rather than accepted invalid scope", async () => {
  const complete = vi.fn(async () => ({
    stopReason: "error",
    content: [],
    usage: {},
    errorMessage: "PRIVATE_PROVIDER_ERROR",
  }));
  await expect(
    adapter(complete)(input(), new AbortController().signal),
  ).rejects.toBeInstanceOf(RetryableProviderError);
});

it("publishes actual Jev dispatch while the response is still held", async () => {
  const h = fixture();
  h.fetch.mockImplementationOnce(() => new Promise<Response>(() => {}));
  const at = Date.now();
  h.start();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.fetch).toHaveBeenCalledTimes(1);
  expect(h.monitor.presentationSnapshot().lastJevCallAt).toBe(at);
  expect(h.monitor.presentationSnapshot().service.code).not.toBe(
    "model-unavailable",
  );
});
