import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  subtaskReportBatches,
  subtaskReportOmissionIdentity,
} from "../src/analysis/subtask-report";
import * as codec from "../src/core/hybrid-checkpoint";
import { CanonicalPass } from "../src/sources/messages";
import { observation } from "./fixtures/hybrid";
import { subtaskMetadataMonitor } from "./fixtures/subtask-metadata-monitor";
import { subtaskSource } from "./fixtures/subtasks";

const running: ReturnType<typeof subtaskMetadataMonitor>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline-key");
});
afterEach(() => {
  for (const h of running.splice(0)) h.monitor.stop();
  vi.restoreAllMocks();
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
  return h;
}

it.each(["wallet", "bytes", "adaptive-bytes"])(
  "persists an explicit %s capacity refusal once without charging or retrying, including OFF/reload",
  async (limit) => {
    const h = await mapped();
    const saved = h.checkpoint();
    const component = saved.monitor?.subtasks;
    if (!component) throw new Error("Missing admitted generic component");
    if (limit === "wallet") {
      component.journal.usage.jev.calls += 1024 - component.journal.dispatches;
      component.journal.dispatches = 1024;
    }
    expect(codec.subtaskCheckpointStorageStatus(saved)).toBe("supported");
    await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
    await vi.advanceTimersByTimeAsync(100);
    const before = h.checkpoint().monitor?.subtasks?.journal;
    const callsBefore = h.counts();
    const measure = codec.canCommitSubtaskCheckpoint;
    const capacity = vi.spyOn(codec, "canCommitSubtaskCheckpoint");
    // Finished history is evictable; model storage whose remainder is all
    // protected, so no eviction can free a report's reserved final room.
    if (limit !== "wallet")
      capacity.mockImplementation((state, monitor, reserve) =>
        (reserve?.storeBytes ?? 0) > 0
          ? false
          : measure(state, monitor, reserve),
      );
    const text = "The workbook review has more unconfirmed work.".repeat(
      limit === "adaptive-bytes" ? 140 : 1,
    );
    if (limit === "adaptive-bytes") {
      const report = observation("capacity-report", text, "assistant");
      const pass = new CanonicalPass(h.reader());
      const batches = subtaskReportBatches({
        parent: h.monitor.state.tasks[0],
        group: h.monitor.subtaskSnapshot().groups[0],
        report,
        resolve: (id) => (id === report.id ? report : pass.observation(id)),
      });
      expect(batches.length).toBeGreaterThan(1);
      expect(batches[0]?.childIds.length).toBeLessThan(20);
      expect(batches.flatMap((batch) => batch.childIds)).toHaveLength(22);
    }
    const identity = subtaskReportOmissionIdentity({
      sourceId: h.monitor.state.sourceId,
      parent: h.monitor.state.tasks[0],
      group: h.monitor.subtaskSnapshot().groups[0],
      reportSource: {
        ...subtaskSource("capacity-report", text),
        role: "assistant",
      },
    });
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    h.append("capacity-report", text);
    await h.settle("capacity-report");
    expect(h.counts().report).toBe(0);
    const gateCalls = h.counts().gate - callsBefore.gate;
    expect(h.counts().proposal).toBe(callsBefore.proposal);
    // A refused report may yield to a distinct legitimate decomposition gate.
    // No report charge is allowed; independently observed gate calls still cost.
    expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(
      (before?.dispatches ?? 0) + gateCalls,
    );
    expect(h.checkpoint().monitor?.subtasks?.journal.usage.jev.calls).toBe(
      (before?.usage.jev.calls ?? 0) + gateCalls,
    );
    expect(h.checkpoint().monitor?.subtasks?.journal.usage.extraction).toEqual(
      before?.usage.extraction,
    );
    if (limit !== "wallet") {
      expect(
        capacity.mock.calls.some(
          ([, , reserve], i) =>
            (reserve?.storeBytes ?? 0) > 0 &&
            capacity.mock.results[i]?.value === false,
        ),
      ).toBe(true);
    }
    const summary = h.checkpoint().monitor?.subtaskOmissions;
    expect(summary).toEqual({
      entries: [
        {
          identity,
          reason: "capacity",
        },
      ],
      saturated: false,
    });
    h.save.mockClear();
    for (let n = 0; n < 3; n++) {
      h.observe();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(h.checkpoint().monitor?.subtaskOmissions).toEqual(summary);
    expect(h.save).not.toHaveBeenCalled();
    h.monitor.turnOff();
    await h.monitor.restore(
      "/nonexistent-hybrid-test",
      h.checkpoint(),
      false,
      h.reader,
    );
    expect(
      h.monitor.subtaskDiagnosticsSnapshot().semanticOmissions,
    ).toMatchObject({ total: 1, byReason: { capacity: 1 } });
    expect(h.counts().report).toBe(0);
  },
);

it.each(["credentials", "persistence", "off"])(
  "does not misclassify %s refusal or unchanged journal as capacity",
  async (kind) => {
    const h = await mapped();
    const before = h.checkpoint().monitor?.subtasks?.journal.dispatches;
    const gatesBefore = h.counts().gate;
    let refused = false;
    h.save.mockImplementation((raw: unknown) => {
      const saved = raw as ReturnType<typeof h.checkpoint>;
      if (kind === "persistence") {
        if (
          saved.monitor?.subtasks?.journal.reports.some(
            (job) => job.state === "dispatched",
          )
        ) {
          refused = true;
          throw new Error("Report dispatch persistence veto");
        }
      } else if (!refused && saved.state.cursor?.id === "control-report") {
        refused = true;
        if (kind === "credentials") vi.stubEnv("TYPESAFE_API_KEY", "");
        else h.monitor.turnOff();
      }
    });
    h.append(
      "control-report",
      "The workbook report still needs optional assessment.",
    );
    await h.settle("control-report");
    expect(refused).toBe(true);
    expect(h.counts().report).toBe(0);
    expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(
      (before ?? 0) + h.counts().gate - gatesBefore,
    );
    expect(h.checkpoint().monitor?.subtaskOmissions).toBeUndefined();
    expect(h.monitor.subtaskDiagnosticsSnapshot().semanticOmissions.total).toBe(
      0,
    );
  },
);

it("evicts oldest finished history so a long session keeps charging new gates and reports", async () => {
  const h = await mapped();
  const mappedJournal = h.checkpoint().monitor?.subtasks?.journal;
  const accepted = mappedJournal?.records.find(
    (record) => record.proposal?.outcome === "accepted",
  );
  if (!mappedJournal || !accepted) throw new Error("Missing accepted proof");
  const identities = (journal: typeof mappedJournal) => [
    ...journal.records.map((record) => record.identity),
    ...journal.reports.map((report) => report.identity),
  ];
  let older: ReturnType<typeof h.checkpoint> | undefined;
  let olderBranch: unknown[] = [];
  for (let n = 0; n < 16; n++) {
    const before = h.counts();
    h.append(`turn-${n}`, `Progress note ${n}: the workbook review continues.`);
    await h.settle(`turn-${n}`);
    // Each distinct turn is a new exact question; capacity never refuses it.
    expect(h.counts().gate - before.gate, `turn ${n} gate`).toBe(1);
    expect(
      h.counts().report - before.report,
      `turn ${n} report`,
    ).toBeGreaterThan(0);
    if (n === 0) {
      older = h.checkpoint();
      olderBranch = structuredClone(h.reader());
    }
  }

  const journal = h.checkpoint().monitor?.subtasks?.journal;
  const first = older?.monitor?.subtasks?.journal;
  if (!journal || !older || !first)
    throw new Error("Missing long-session journal");
  // Map-time and first-turn gate records and report jobs are the oldest.
  const oldest = identities(first).filter(
    (identity) => identity !== accepted.identity,
  );
  expect(first.reports.length).toBeGreaterThan(0);
  const calls = h.counts();
  const jevCalls = calls.gate + calls.report;
  // Lifetime wallet still counts every evicted receipt.
  expect(journal.dispatches).toBe(jevCalls + calls.proposal);
  expect(journal.usage).toEqual({
    jev: { calls: jevCalls, inputTokens: 2 * jevCalls, outputTokens: jevCalls },
    extraction: {
      calls: calls.proposal,
      inputTokens: 3 * calls.proposal,
      outputTokens: 2 * calls.proposal,
    },
  });
  const retained = identities(journal);
  expect(retained).toEqual(expect.not.arrayContaining(oldest));
  expect(journal.records).toContainEqual(accepted);
  expect(
    journal.records.flatMap((record) =>
      [record.gate, record.proposal].filter(Boolean),
    ).length + journal.reports.flatMap((report) => report.attempts).length,
  ).toBeLessThan(journal.dispatches);
  expect(h.monitor.subtaskSnapshot().groups[0]?.children).toHaveLength(22);
  expect(h.monitor.subtaskDiagnosticsSnapshot().semanticOmissions.total).toBe(
    0,
  );

  // Older same-source copy still holds evicted history; the merge re-applies
  // the same eviction instead of refusing or re-growing past capacity.
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    older,
    false,
    () => olderBranch,
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.state.cursor?.id).toBe("turn-0");
  const restored = h.checkpoint().monitor?.subtasks?.journal;
  expect(restored?.dispatches).toBeGreaterThanOrEqual(journal.dispatches);
  expect(restored?.usage.jev.calls).toBeGreaterThanOrEqual(jevCalls);
  // Restore may retire its authority, but never evicts the admitted group's proof.
  expect(
    restored?.records.find((record) => record.identity === accepted.identity),
  ).toMatchObject({ gate: accepted.gate, proposal: accepted.proposal });
}, 30000);

it("records an unfittable gate dispatch as a durable capacity omission instead of paying", async () => {
  const h = subtaskMetadataMonitor();
  running.push(h);
  h.start();
  await h.settle("goal");
  const before = h.checkpoint().monitor?.subtasks?.journal;
  const calls = h.counts();
  const measure = codec.canCommitSubtaskCheckpoint;
  // Everything retained is protected: no eviction leaves final-write room.
  vi.spyOn(codec, "canCommitSubtaskCheckpoint").mockImplementation(
    (state, monitor, reserve) =>
      (reserve?.journalBytes ?? 0) > 0
        ? false
        : measure(state, monitor, reserve),
  );
  h.append("gate-capacity", "Please also check the workbook formulas.", "user");
  await h.settle("gate-capacity");
  expect(h.counts()).toMatchObject({
    gate: calls.gate,
    proposal: calls.proposal,
    report: calls.report,
  });
  expect(h.checkpoint().monitor?.subtasks?.journal).toEqual(before);
  const summary = h.checkpoint().monitor?.subtaskOmissions;
  expect(summary?.entries).toEqual([
    { identity: expect.stringMatching(/^[a-f0-9]{64}$/), reason: "capacity" },
  ]);
  h.monitor.turnOff();
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    h.checkpoint(),
    false,
    h.reader,
  );
  expect(
    h.monitor.subtaskDiagnosticsSnapshot().semanticOmissions,
  ).toMatchObject({ total: 1, byReason: { capacity: 1 } });
});
