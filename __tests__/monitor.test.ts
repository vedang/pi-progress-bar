import { afterEach, describe, expect, it, vi } from "vitest";
import { Monitor } from "../src/core/monitor";

const message = (id: string, text: string) => ({
  type: "message",
  id,
  parentId: null,
  message: { role: "user", content: text },
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("automatic monitor lifecycle", () => {
  it("defaults to 60 seconds and refuses to turn on without a key", () => {
    delete process.env.TYPESAFE_API_KEY;
    const monitor = new Monitor(vi.fn(), vi.fn());
    expect(monitor.interval).toBe(60);
    expect(monitor.turnOn("/workspace")).toMatch(/TYPESAFE_API_KEY.*OFF/i);
    expect(monitor.enabled).toBe(false);
  });

  it("persists only versioned references and controls, never source text or key", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TYPESAFE_API_KEY", "secret-key");
    const persist = vi.fn();
    const branch = [
      message("goal", "Plan:\n1. Private alpha\n2. Private beta"),
    ];
    const monitor = new Monitor(vi.fn(), persist);
    monitor.observe(() => branch);
    monitor.turnOn("/workspace");
    const checkpoint = monitor.checkpoint();
    expect(checkpoint).toMatchObject({
      version: 2,
      enabled: true,
      interval: 60,
    });
    expect(JSON.stringify(checkpoint)).not.toContain("Private alpha");
    expect(JSON.stringify(checkpoint)).not.toContain("secret-key");
    monitor.turnOff();
    expect(persist.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false });
    monitor.stop();
  });

  it("ignores old manual checkpoints and preserves current controls on tree navigation", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TYPESAFE_API_KEY", "unit-key");
    const monitor = new Monitor(vi.fn(), vi.fn());
    monitor.observe(() => []);
    await monitor.restore(
      "/workspace",
      { version: 1, interval: 15, source: { path: "plan.md" } },
      false,
    );
    expect(monitor.enabled).toBe(true);
    expect(monitor.interval).toBe(60);
    monitor.setInterval(7, "/workspace");
    monitor.turnOff();
    await monitor.restore("/workspace", undefined, true);
    expect(monitor.enabled).toBe(false);
    expect(monitor.interval).toBe(7);
  });
});
