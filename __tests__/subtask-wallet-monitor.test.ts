import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { subtaskMetadataMonitor } from "./fixtures/subtask-metadata-monitor";

const running: ReturnType<typeof subtaskMetadataMonitor>[] = [];
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

it.each([false, true])(
  "preserves real charges on older same-source restore (enabled=%s)",
  async (enabled) => {
    const h = subtaskMetadataMonitor();
    running.push(h);
    h.start();
    await h.settle("goal");
    await h.map();
    expect(h.monitor.subtaskSnapshot().groups[0]?.children).toHaveLength(22);
    const older = h.checkpoint();
    const beforeReport = h.counts();
    const olderBranch = structuredClone(h.reader());
    h.append(
      "wallet-report",
      "I reviewed the workbook; the remaining checks are still pending.",
    );
    await h.settle("wallet-report");
    expect(h.counts()).toMatchObject({
      report: 2,
      gate: beforeReport.gate + 1,
      proposal: beforeReport.proposal,
    });
    const charged = h.checkpoint().monitor?.subtasks?.journal;
    if (!charged || !older.monitor?.subtasks)
      throw new Error("Missing public-ingress journal");
    expect(charged.dispatches).toBe(
      older.monitor.subtasks.journal.dispatches + 3,
    );
    expect(charged.usage.jev.calls + charged.usage.extraction.calls).toBe(
      charged.dispatches,
    );
    const calls = h.counts();
    older.monitor.enabled = enabled;
    await h.monitor.restore(
      "/nonexistent-hybrid-test",
      older,
      false,
      () => olderBranch,
    );
    const restored = h.checkpoint().monitor?.subtasks?.journal;
    expect(restored?.dispatches).toBe(charged.dispatches + Number(enabled));
    if (!restored) throw new Error("Missing restored journal");
    expect(restored.records.map((record) => record.identity)).toEqual(
      expect.arrayContaining(charged.records.map((record) => record.identity)),
    );
    expect(restored.reports.map((job) => job.identity)).toEqual(
      expect.arrayContaining(charged.reports.map((job) => job.identity)),
    );
    expect(restored.usage.extraction).toEqual(charged.usage.extraction);
    if (!enabled) {
      expect(restored.usage).toEqual(charged.usage);
      expect(h.counts()).toEqual(calls);
      return;
    }
    // Restore drops ephemeral metadata: goal + current group + no metadata is a
    // genuinely new gate context, not permission to replay an old paid identity.
    const prior = new Set(charged.records.map((record) => record.identity));
    const fresh = restored.records.filter(
      (record) => !prior.has(record.identity),
    );
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({
      source: { entryId: "goal" },
      listRevision: older.monitor.subtasks.state.groups[0].listRevision,
      gate: { dispatch: charged.dispatches + 1, choice: "no" },
    });
    const admission = charged.records.find(
      (record) => record.gate?.choice === "yes",
    );
    expect(admission).toBeDefined();
    expect(fresh[0].triggerHash).not.toBe(admission?.triggerHash);
    expect(charged.records.map((record) => record.contextHash)).not.toContain(
      fresh[0].contextHash,
    );
    expect(restored.usage.jev.calls).toBe(charged.usage.jev.calls + 1);
    expect(restored.usage.jev.inputTokens).toBeGreaterThanOrEqual(
      charged.usage.jev.inputTokens,
    );
    expect(restored.usage.jev.outputTokens).toBeGreaterThanOrEqual(
      charged.usage.jev.outputTokens,
    );
    expect(h.counts()).toEqual({ ...calls, gate: calls.gate + 1 });
    const afterRestore = h.counts();
    for (let i = 0; i < 3; i++) {
      h.monitor.observe(() => olderBranch);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(h.counts()).toEqual(afterRestore);
    expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(
      restored.dispatches,
    );
  },
);
