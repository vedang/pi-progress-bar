import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { subtaskReportOmissionIdentity } from "../src/analysis/subtask-report";
import * as codec from "../src/core/hybrid-checkpoint";
import type { SubtaskPhaseRecord } from "../src/core/subtask-journal";
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

it.each(["wallet", "bytes"])(
  "persists an explicit %s capacity refusal once without charging or retrying, including OFF/reload",
  async (limit) => {
    const h = await mapped();
    const saved = h.checkpoint();
    const component = saved.monitor?.subtasks;
    if (!component) throw new Error("Missing admitted generic component");
    if (limit === "wallet") {
      component.journal.usage.jev.calls += 1024 - component.journal.dispatches;
      component.journal.dispatches = 1024;
    } else {
      const base = component.journal.records[0];
      if (!base) throw new Error("Missing real phase record");
      // Supplied terminal diagnostic history, not forged dispatch/admission proof.
      const {
        gate: _gate,
        proposal: _proposal,
        parkedUntil: _parked,
        ...fields
      } = base;
      for (
        let n = 1;
        Buffer.byteLength(JSON.stringify(component)) < 60000;
        n++
      ) {
        if (n > 190) throw new Error("Fixture failed to reach byte boundary");
        const record: SubtaskPhaseRecord = {
          ...fields,
          identity: n.toString(16).padStart(64, "0"),
          phase: "gate-ready",
          state: "superseded",
        };
        component.journal.records.push(record);
      }
    }
    expect(codec.subtaskCheckpointStorageStatus(saved)).toBe("supported");
    await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
    await vi.advanceTimersByTimeAsync(100);
    const before = h.checkpoint().monitor?.subtasks?.journal;
    const callsBefore = h.counts();
    const capacity = vi.spyOn(codec, "canCommitSubtaskCheckpoint"); // observe real predicate
    const text = "The workbook review has more unconfirmed work.";
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
    if (limit === "bytes") {
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
