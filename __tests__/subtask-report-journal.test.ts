import { expect, it, vi } from "vitest";
import { MODEL } from "../src/analysis/gateway";
import {
  restoreSubtaskJournal,
  type SubtaskJournalCheckpoint,
  type SubtaskPhaseRecord,
  type SubtaskReportJob,
  subtaskJournalIsValid,
} from "../src/core/subtask-journal";
import { subtaskHash, subtaskSource } from "./fixtures/subtasks";

function job(): SubtaskReportJob {
  return {
    identity: subtaskHash("report-job"),
    parentTaskId: "task:1",
    parentRevision: 1,
    parentSourceDigest: subtaskHash("current-parent"),
    groupId: "subtask-group:1",
    listRevision: 1,
    source: {
      ...subtaskSource("report", "I completed the agreed work."),
      role: "assistant",
    },
    model: MODEL,
    childIds: Array.from({ length: 22 }, (_, i) => `subtask-child:${i + 1}`),
    state: "ready",
    attempts: [],
  };
}
function attempt(
  childIds: string[],
  dispatch: number,
  outcome: "decided" | "dispatched" | "retryable" | "failed" = "decided",
) {
  return {
    identity: subtaskHash(`chunk:${childIds.join(",")}`),
    requestHash: subtaskHash(`request:${childIds.join(",")}`),
    childIds,
    dispatch,
    at: dispatch * 10,
    outcome,
    usage: { inputTokens: 1, outputTokens: 2 },
    ...(outcome === "decided"
      ? {
          assessments: childIds.map((childId) => ({
            childId,
            choice: "unchanged" as const,
            scope: "none" as const,
            confidence: 1,
            probability: 1,
            accepted: false,
          })),
        }
      : {}),
  };
}
function journal(report = job()): SubtaskJournalCheckpoint {
  return {
    version: 1,
    records: [],
    reports: [report],
    dispatches: report.attempts.length,
    usage: {
      jev: {
        calls: report.attempts.length,
        inputTokens: report.attempts.reduce(
          (n, item) => n + item.usage.inputTokens,
          0,
        ),
        outputTokens: report.attempts.reduce(
          (n, item) => n + item.usage.outputTokens,
          0,
        ),
      },
      extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
    },
  };
}
function complete() {
  const report = job();
  report.attempts = [
    attempt(report.childIds.slice(0, 20), 1),
    attempt(report.childIds.slice(20), 2),
  ];
  report.state = "complete";
  return journal(report);
}
function gate(parentTaskId = "task:1"): SubtaskPhaseRecord {
  return {
    identity: subtaskHash("decomposition"),
    parentTaskId,
    parentRevision: 1,
    parentSourceDigest: subtaskHash("current-parent"),
    listRevision: 0,
    source: subtaskSource(),
    contextHash: subtaskHash("context"),
    triggerHash: subtaskHash("trigger"),
    gateModel: MODEL,
    selectedModel: "fixture/selected",
    phase: "gate-ready",
    state: "ready",
  };
}
it("requires explicit reports field, with no missing-field fallback", () => {
  const data = journal();
  expect(subtaskJournalIsValid(data)).toBe(true);
  Reflect.deleteProperty(data, "reports");
  expect(subtaskJournalIsValid(data)).toBe(false);
  expect(
    restoreSubtaskJournal(
      data,
      () => true,
      () => true,
    ),
  ).toBeUndefined();
});
it("restores 20 assessed children and leaves only two uncovered despite negative decisions", () => {
  const report = job();
  report.attempts = [attempt(report.childIds.slice(0, 20), 1)];
  const data = journal(report);
  const restored = restoreSubtaskJournal(
    data,
    () => true,
    () => true,
  );
  expect(restored).toEqual(data);
  const covered = new Set(
    restored?.reports[0].attempts.flatMap(
      (item) => item.assessments?.map((assessment) => assessment.childId) ?? [],
    ),
  );
  expect(
    restored?.reports[0].childIds.filter((id) => !covered.has(id)),
  ).toEqual(report.childIds.slice(20));
  expect(
    restoreSubtaskJournal(
      complete(),
      () => true,
      () => true,
    ),
  ).toEqual(complete());
});
it("retains certified failed chunk and new retry ordinal without overlapping assessed coverage", () => {
  const report = job();
  report.attempts = [
    attempt(report.childIds.slice(0, 20), 1),
    attempt(report.childIds.slice(20), 2, "retryable"),
  ];
  report.state = "parked";
  report.parkedUntil = 10020;
  const parked = journal(report);
  expect(subtaskJournalIsValid(parked)).toBe(true);
  expect(
    restoreSubtaskJournal(
      parked,
      () => true,
      () => true,
    ),
  ).toEqual(parked);
  report.attempts.push(attempt(report.childIds.slice(20), 3));
  report.state = "complete";
  delete report.parkedUntil;
  const done = journal(report);
  expect(subtaskJournalIsValid(done)).toBe(true);
  expect(done.dispatches).toBe(3);
  expect(done.reports[0].attempts[1].identity).toBe(
    done.reports[0].attempts[2].identity,
  );
  expect(
    restoreSubtaskJournal(
      done,
      () => true,
      () => true,
    ),
  ).toEqual(done);
});
it("preserves predispatch deferral with no fabricated charge or attempt", () => {
  const report = job();
  report.state = "parked";
  report.parkedUntil = 10000;
  const data = journal(report);
  expect(subtaskJournalIsValid(data)).toBe(true);
  expect(
    restoreSubtaskJournal(
      data,
      () => true,
      () => true,
    ),
  ).toEqual(data);
  expect(data.dispatches).toBe(0);
});
it("restores unknown dispatched report as permanent, retaining exact charge", () => {
  const report = job();
  report.state = "dispatched";
  report.attempts = [attempt(report.childIds.slice(0, 20), 1, "dispatched")];
  const data = journal(report);
  const restored = restoreSubtaskJournal(
    data,
    () => true,
    () => true,
  );
  expect(restored?.reports[0]).toEqual({ ...report, state: "permanent" });
  expect(restored?.dispatches).toBe(1);
  expect(restored?.usage).toEqual(data.usage);
});
it.each(["false", "throw"])(
  "retires noncurrent report as history on callback %s",
  (mode) => {
    const data = complete();
    const restored = restoreSubtaskJournal(
      data,
      () => true,
      () => {
        if (mode === "throw") throw new Error("unavailable");
        return false;
      },
    );
    expect(restored?.reports).toEqual(
      data.reports.map((report) => ({ ...report, state: "superseded" })),
    );
    expect(restored?.usage).toEqual(data.usage);
    const callback = vi.fn(() => true);
    expect(restoreSubtaskJournal(restored, () => true, callback)).toEqual(
      restored,
    );
    expect(callback).not.toHaveBeenCalled();
  },
);
it("absent report currentness grants no restored authority but preserves history", () => {
  const data = complete();
  expect(restoreSubtaskJournal(data, () => true)?.reports).toEqual(
    data.reports.map((report) => ({ ...report, state: "superseded" })),
  );
});
it("isolates callback mutations of caller and callback report snapshots", () => {
  const data = complete();
  const before = structuredClone(data);
  const restored = restoreSubtaskJournal(
    data,
    () => true,
    (report) => {
      report.childIds.length = 0;
      data.reports.length = 0;
      data.dispatches = 0;
      data.usage.jev.calls = 0;
      return true;
    },
  );
  expect(restored).toEqual(before);
});
it.each([
  "duplicate-decided",
  "foreign",
  "unordered",
  "missing-assessment",
  "assessment-order",
  "accepted-negative",
  "selected-model",
  "unknown-field",
  "complete-gap",
  "ready-covered",
  "wrong-retry-request",
  "unknown-retry",
  "extra-deadline",
])("rejects invalid report history: %s", (mode) => {
  const data = complete();
  const report = data.reports[0];
  if (mode === "duplicate-decided") {
    report.attempts[1] = attempt(report.childIds.slice(0, 20), 2);
    report.state = "ready";
  }
  if (mode === "foreign") report.attempts[1].childIds[0] = "subtask-child:99";
  if (mode === "unordered") {
    report.attempts[0].childIds.reverse();
    report.attempts[0].assessments?.reverse();
  }
  if (mode === "missing-assessment") report.attempts[0].assessments?.pop();
  if (mode === "assessment-order") report.attempts[0].assessments?.reverse();
  if (mode === "accepted-negative")
    Object.assign(report.attempts[0].assessments?.[0] ?? {}, {
      accepted: true,
    });
  if (mode === "selected-model")
    Object.assign(report, { selectedModel: "not-report-authority" });
  if (mode === "unknown-field")
    Object.assign(report, { rawPrompt: "forbidden" });
  if (mode === "complete-gap") report.attempts.pop();
  if (mode === "ready-covered") report.state = "ready";
  if (mode === "extra-deadline") report.parkedUntil = 10;
  if (mode === "wrong-retry-request" || mode === "unknown-retry") {
    report.attempts[1] = attempt(
      report.childIds.slice(20),
      2,
      mode === "unknown-retry" ? "dispatched" : "retryable",
    );
    const retried = attempt(report.childIds.slice(20), 3);
    if (mode === "wrong-retry-request")
      retried.requestHash = subtaskHash("different request");
    report.attempts.push(retried);
    data.dispatches = 3;
    data.usage.jev = { calls: 3, inputTokens: 3, outputTokens: 6 };
  }
  expect(subtaskJournalIsValid(data)).toBe(false);
  expect(
    restoreSubtaskJournal(
      data,
      () => true,
      () => true,
    ),
  ).toBeUndefined();
});
it("shares unfinished parent ownership across decomposition and reporting", () => {
  const data = journal();
  data.records.push(gate());
  expect(subtaskJournalIsValid(data)).toBe(false);
  data.records[0].parentTaskId = "task:2";
  expect(subtaskJournalIsValid(data)).toBe(true);
  data.records[0].parentTaskId = "task:1";
  data.reports = complete().reports;
  data.dispatches = 2;
  data.usage = complete().usage;
  expect(subtaskJournalIsValid(data)).toBe(true);
});
it("counts report owners toward the shared twenty-owner limit", () => {
  const data = journal();
  data.reports = Array.from({ length: 20 }, (_, i) => ({
    ...job(),
    identity: subtaskHash(`job:${i}`),
    parentTaskId: `task:${i + 1}`,
    groupId: `subtask-group:${i + 1}`,
  }));
  expect(subtaskJournalIsValid(data)).toBe(true);
  data.records.push(gate("task:21"));
  expect(subtaskJournalIsValid(data)).toBe(false);
});
it("shares ordinals and Jev token wallet across gate and report receipts", () => {
  const data = complete();
  const record = gate("task:2");
  record.state = "dispatched";
  record.gate = {
    requestHash: subtaskHash("gate"),
    dispatch: 3,
    at: 30,
    outcome: "dispatched",
    usage: { inputTokens: 2, outputTokens: 3 },
  };
  data.records.push(record);
  data.dispatches = 3;
  data.usage.jev = { calls: 3, inputTokens: 4, outputTokens: 7 };
  expect(subtaskJournalIsValid(data)).toBe(true);
  record.gate.dispatch = 1;
  expect(subtaskJournalIsValid(data)).toBe(false);
  record.gate.dispatch = 3;
  data.usage.jev.outputTokens--;
  expect(subtaskJournalIsValid(data)).toBe(false);
});
it("counts every retryable report attempt against the global 200-receipt and 1024-call bounds", () => {
  const report = job();
  report.childIds = ["subtask-child:1"];
  report.state = "parked";
  report.parkedUntil = 10000;
  report.attempts = Array.from({ length: 200 }, (_, i) =>
    attempt([...report.childIds], i + 1, "retryable"),
  );
  const data = journal(report);
  expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(65536);
  expect(subtaskJournalIsValid(data)).toBe(true);
  data.dispatches = 1024;
  data.usage.jev.calls = 1024;
  expect(subtaskJournalIsValid(data)).toBe(true);
  data.dispatches = 1025;
  data.usage.jev.calls = 1025;
  expect(subtaskJournalIsValid(data)).toBe(false);
  data.dispatches = 1024;
  data.usage.jev.calls = 1024;
  data.reports[0].attempts.push(
    attempt([...report.childIds], 201, "retryable"),
  );
  data.usage.jev.inputTokens++;
  data.usage.jev.outputTokens += 2;
  expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(65536);
  expect(subtaskJournalIsValid(data)).toBe(false);
});
it("rejects report getters without executing caller code", () => {
  const data = journal();
  let reads = 0;
  Object.defineProperty(data.reports[0], "attempts", {
    enumerable: true,
    get() {
      reads++;
      return [];
    },
  });
  expect(subtaskJournalIsValid(data)).toBe(false);
  expect(reads).toBe(0);
});
