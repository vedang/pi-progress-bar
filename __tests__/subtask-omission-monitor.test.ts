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
async function mapped() {
  const h = subtaskMetadataMonitor();
  running.push(h);
  h.start();
  await h.settle("goal");
  await h.map();
  expect(h.monitor.subtaskSnapshot().groups[0]?.children).toHaveLength(22);
  expect(h.counts().report).toBe(0);
  return h;
}

it("persists one oversized report omission through OFF/reload without a report call or raw body", async () => {
  const h = await mapped();
  const text = `PRIVATE_OVERSIZED_REPORT ${"measured evidence ".repeat(800)}`;
  expect(Buffer.byteLength(text)).toBeGreaterThan(12 * 1024);
  h.append("oversized-report", text);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.counts().report).toBe(0);
  const saved = h.checkpoint();
  expect(saved.monitor?.subtaskOmissions).toEqual({
    entries: [
      {
        identity: expect.stringMatching(/^[0-9a-f]{64}$/),
        reason: "report-oversized",
      },
    ],
    saturated: false,
  });
  expect(JSON.stringify(saved)).not.toContain("PRIVATE_OVERSIZED_REPORT");
  const summary = structuredClone(saved.monitor?.subtaskOmissions);
  for (let i = 0; i < 3; i++) {
    h.observe();
    h.monitor.modelSelected();
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(h.checkpoint().monitor?.subtaskOmissions).toEqual(summary);
  h.monitor.turnOff();
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    h.checkpoint(),
    false,
    h.reader,
  );
  expect(h.checkpoint().monitor?.subtaskOmissions).toEqual(summary);
  expect(h.monitor.subtaskDiagnosticsSnapshot()).toMatchObject({
    semanticOmissions: {
      total: 1,
      byReason: { "report-oversized": 1, coalesced: 0, capacity: 0 },
      saturated: false,
    },
  });
  expect(h.counts().report).toBe(0);
});

it("restores summary-only saturated metadata as passive diagnostics without inventing a group", async () => {
  const h = subtaskMetadataMonitor();
  running.push(h);
  const saved = h.checkpoint();
  if (!saved.monitor) throw new Error("Missing Monitor metadata");
  saved.monitor.enabled = false;
  saved.monitor.subtaskOmissions = { entries: [], saturated: true };
  const before = h.counts();
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  expect(h.checkpoint().monitor?.subtaskOmissions).toEqual({
    entries: [],
    saturated: true,
  });
  expect(h.monitor.subtaskSnapshot().groups).toEqual([]);
  expect(h.monitor.subtaskDiagnosticsSnapshot()).toMatchObject({
    semanticOmissions: { total: 0, saturated: true },
  });
  expect(h.counts()).toEqual(before);
});
