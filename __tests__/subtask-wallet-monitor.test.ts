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

it("cannot refund real generic report charges by navigating to an older same-source checkpoint", async () => {
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
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    older,
    true,
    () => olderBranch,
  );
  const restored = h.checkpoint().monitor?.subtasks?.journal;
  expect(restored?.dispatches).toBe(charged.dispatches);
  expect(restored?.usage).toEqual(charged.usage);
  expect(h.counts()).toEqual(calls);
});
