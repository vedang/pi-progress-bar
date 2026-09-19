import { afterEach, describe, expect, it, vi } from "vitest";
import { Monitor } from "../src/core/monitor";
import { collectTrajectory } from "../src/sources/trajectory";

const message = (id: string, text: string, parentId: string | null = null) => ({
  type: "message",
  id,
  parentId,
  message: { role: "user", content: text },
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("automatic monitor lifecycle", () => {
  it("has no interval property and refuses to turn on without a key", () => {
    delete process.env.TYPESAFE_API_KEY;
    const monitor = new Monitor(vi.fn(), vi.fn());
    expect(monitor).not.toHaveProperty("interval");
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
      version: 4,
      enabled: true,
    });
    expect(checkpoint).not.toHaveProperty("interval");
    expect(JSON.stringify(checkpoint)).not.toContain("Private alpha");
    expect(JSON.stringify(checkpoint)).not.toContain("secret-key");
    monitor.turnOff();
    expect(persist.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false });
    monitor.stop();
  });

  it("restores an evolved task from its live referenced observation", async () => {
    const branch = [
      message("goal", "Plan:\n1. Alpha"),
      message("evolved", "Beta replaces Alpha", "goal"),
    ];
    const trajectory = collectTrajectory(branch, {
      chronological: true,
      unbounded: true,
    }).messages;
    const goal = trajectory[0];
    const evolved = trajectory[1];
    if (!goal || !evolved) throw new Error("fixture trajectory missing");
    const prefix = "scope";
    const alphaId = "task:alpha";
    const betaId = "task:beta";
    const monitor = new Monitor(vi.fn(), vi.fn());
    monitor.observe(() => branch);
    await monitor.restore("/workspace", {
      version: 4,
      enabled: false,
      source: {
        kind: "conversation",
        entryId: goal.id,
        hash: goal.hash,
        spans: [
          {
            id: `${goal.id}:9:14`,
            start: 9,
            end: 14,
            workKind: "action",
            criteria: [],
          },
        ],
        context: [[0, 5]],
      },
      sourceRevision: goal.hash,
      scopeRevision: `${prefix}:2`,
      conversation: {
        cursor: { id: evolved.id, hash: evolved.hash },
        discoveryCursor: { id: evolved.id, hash: evolved.hash },
        order: 0,
        proofs: [],
      },
      mappings: [],
      tasks: [
        {
          id: alphaId,
          workKind: "action",
          status: "not-started",
          included: false,
          revision: goal.hash,
          ref: {
            sourceId: `conversation:${goal.id}`,
            entryId: goal.id,
            start: 9,
            end: 14,
            provenance: "user",
          },
        },
        {
          id: betaId,
          workKind: "action",
          status: "in-progress",
          included: true,
          revision: evolved.hash,
          ref: {
            sourceId: `conversation:${evolved.id}`,
            entryId: evolved.id,
            start: 0,
            end: 4,
            provenance: "user",
          },
        },
      ],
      currentTaskId: betaId,
      nextTaskId: 3,
      usage: { calls: 2, inputTokens: 10, outputTokens: 4 },
    });
    expect(monitor.ledger?.tasks).toMatchObject([
      { id: alphaId, text: "Alpha", included: false },
      { id: betaId, text: "Beta", status: "in-progress", included: true },
    ]);
    expect(monitor.ledger?.currentTaskId).toBe(betaId);
  });

  it("clears passive evidence across restored session/tree state", async () => {
    const monitor = new Monitor(vi.fn(), vi.fn());
    monitor.evidence.start("red", "bash", { command: "bun test" }, 1);
    monitor.evidence.finish(
      "red",
      "bash",
      {
        content: [{ type: "text", text: "FAIL AssertionError" }],
        isError: true,
      },
      2,
    );
    expect(monitor.evidence.redObservation()).toBeDefined();
    monitor.observe(() => []);
    await monitor.restore("/workspace", undefined, true);
    expect(monitor.evidence.redObservation()).toBeUndefined();
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
    expect(monitor).not.toHaveProperty("interval");
    monitor.turnOff();
    await monitor.restore("/workspace", undefined, true);
    expect(monitor.enabled).toBe(false);
    expect(monitor.checkpoint()).not.toHaveProperty("interval");
  });
});
