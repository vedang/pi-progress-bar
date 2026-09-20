import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { monitorHarness } from "./fixtures/hybrid-monitor";

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
function fixture() {
  const h = monitorHarness();
  running.push(h);
  return h;
}
it("counts a dispatched Jev request immediately, before its response", async () => {
  const h = fixture();
  h.fetch.mockImplementation(() => new Promise<Response>(() => {}));
  h.start();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.fetch).toHaveBeenCalledTimes(1);
  expect(h.monitor.presentationSnapshot().usage.jev.calls).toBe(1);
});
it("counts failed Jev attempts and retries separately, not successful responses", async () => {
  const h = fixture();
  h.fetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
  h.start();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.monitor.presentationSnapshot().usage.jev.calls).toBe(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.fetch.mock.calls.length).toBeGreaterThan(1);
  expect(h.monitor.presentationSnapshot().usage.jev.calls).toBe(
    h.fetch.mock.calls.length,
  );
});
it("counts dispatched extraction failure, but never a local pre-dispatch failure", async () => {
  const h = fixture();
  h.extract.mockImplementationOnce(async (_input, _signal, dispatch) => {
    dispatch?.(Date.now());
    throw new Error("remote failure");
  });
  h.start();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.presentationSnapshot().usage.extraction.calls).toBe(1);
  h.extract.mockImplementationOnce(async () => {
    throw new Error("local preflight failure");
  });
  h.monitor.modelSelected();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.presentationSnapshot().usage.extraction.calls).toBe(1);
});
it("counts batches once and leaves counts unchanged on projection/publication/reload", async () => {
  const h = fixture();
  h.start();
  await h.settle("goal");
  const view = h.monitor.presentationSnapshot();
  expect(
    h.requests.some((request) => Object.keys(request.questions).length > 1),
  ).toBe(true);
  expect(view.usage.jev.calls).toBe(h.fetch.mock.calls.length);
  expect(view.usage.extraction.calls).toBe(h.extract.mock.calls.length);
  for (let i = 0; i < 20; i++) {
    h.monitor.presentationSnapshot();
    h.monitor.boardSnapshot();
    h.monitor.setActivity(`Idle ${i}`);
  }
  expect(h.monitor.presentationSnapshot().usage).toEqual(view.usage);
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    h.monitor.checkpoint(),
    false,
    h.reader,
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.presentationSnapshot().usage).toEqual(view.usage);
});
