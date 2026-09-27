import { expect, it, vi } from "vitest";
import { subtaskReportBatches } from "../src/analysis/subtask-report";
import { processObservation } from "../src/core/hybrid";
import {
  encodeSubtaskCheckpoint,
  restoreSubtaskCheckpoint,
  type SubtaskRestoreContext,
} from "../src/core/hybrid-checkpoint";
import type {
  SubtaskJournalCheckpoint,
  SubtaskReportJob,
} from "../src/core/subtask-journal";
import {
  type SubtaskRuntimeCurrent,
  subtaskRuntimeReportIsCurrent,
} from "../src/core/subtask-runtime";
import { SubtaskStore } from "../src/core/subtasks";
import {
  backend,
  initial,
  initialMessage,
  noPatch,
  observation,
} from "./fixtures/hybrid";
import {
  subtaskAdmission,
  subtaskHash,
  subtaskSource,
} from "./fixtures/subtasks";

async function fixture() {
  const report = observation(
    "report",
    "I completed the generic step.",
    "assistant",
  );
  const later = observation("later", "Unrelated later conversation.", "user");
  const state = await processObservation(
    await initial(),
    report,
    backend(noPatch(), { gate: "unchanged" }),
  );
  const parent = state.tasks[0];
  const store = new SubtaskStore();
  expect(
    store.admit({
      ...subtaskAdmission(),
      parent,
      source: parent.source,
      children: [{ kind: "add", label: "Generic step", source: parent.source }],
    }),
  ).toEqual({ accepted: true });
  const group = store.snapshot().groups[0];
  const observations = new Map(
    [initialMessage, report, later].map((item) => [item.id, item]),
  );
  const resolve = (id: string) => observations.get(id);
  const batch = subtaskReportBatches({ parent, group, report, resolve })[0];
  if (!batch) throw new Error("Missing real report binding");
  const job: SubtaskReportJob = {
    identity: batch.jobIdentity,
    parentTaskId: parent.id,
    parentRevision: parent.revision,
    parentSourceDigest: batch.parentSourceDigest,
    groupId: group.id,
    listRevision: group.listRevision,
    source: { ...batch.source },
    model: batch.request.model,
    childIds: [...batch.childIds],
    state: "parked",
    parkedUntil: 10000,
    attempts: [
      {
        identity: batch.identity,
        requestHash: batch.requestHash,
        childIds: [...batch.childIds],
        dispatch: 1,
        at: 0,
        outcome: "retryable",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    ],
  };
  const journal: SubtaskJournalCheckpoint = {
    version: 1,
    dispatches: 1,
    usage: {
      jev: { calls: 1, inputTokens: 0, outputTokens: 0 },
      extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
    },
    records: [],
    reports: [job],
  };
  const monitor = {
    enabled: true,
    usage: {
      jev: { calls: 0, inputTokens: 0, outputTokens: 0 },
      extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
    },
    subtasks: { state: store.checkpoint(), journal },
  };
  // Deliberately not the candidate's parent ledger/latest source. The restore
  // bridge must use detached candidate authority, not old live Monitor state.
  const current: SubtaskRuntimeCurrent = {
    sourceId: state.sourceId,
    enabled: true,
    parents: [],
    latest: later,
    earlier: [],
    omissions: [],
    resolve,
  };
  return {
    state,
    monitor,
    group,
    job,
    current,
    observations,
    resolve,
    preceding: () => [initialMessage],
  };
}
it("retains parked owner through the actual v11 envelope with saved source and no proposal model", async () => {
  const h = await fixture();
  const callback = vi.fn(
    (
      job: SubtaskReportJob,
      candidate: { state: typeof h.state; group?: typeof h.group },
    ) => subtaskRuntimeReportIsCurrent(job, h.current, candidate),
  );
  const restored = restoreSubtaskCheckpoint(
    encodeSubtaskCheckpoint(h.state, h.monitor),
    h.state.sourceId,
    h.resolve,
    h.preceding,
    undefined,
    callback,
  );
  expect(callback).toHaveBeenCalledTimes(1);
  expect(callback.mock.calls[0]).toEqual([
    h.job,
    { state: h.state, group: h.group },
  ]);
  expect(restored?.monitor?.subtasks?.journal).toEqual(
    h.monitor.subtasks.journal,
  );
});
it.each(["absent", "false", "throw"])(
  "report callback %s retains superseded history and exact wallet",
  async (mode) => {
    const h = await fixture();
    const callback =
      mode === "absent"
        ? undefined
        : () => {
            if (mode === "throw") throw new Error("Unavailable context");
            return false;
          };
    const restored = restoreSubtaskCheckpoint(
      encodeSubtaskCheckpoint(h.state, h.monitor),
      h.state.sourceId,
      h.resolve,
      h.preceding,
      undefined,
      callback,
    );
    const retired = structuredClone(h.job);
    retired.state = "superseded";
    delete retired.parkedUntil;
    expect(restored?.monitor?.subtasks?.journal).toMatchObject({
      dispatches: 1,
      usage: h.monitor.subtasks.journal.usage,
      reports: [retired],
    });
    expect(
      restored?.monitor?.subtasks?.journal.reports[0].parkedUntil,
    ).toBeUndefined();
  },
);
it("detaches callback job/candidate and original input mutations from restored report facts", async () => {
  const h = await fixture();
  const raw = encodeSubtaskCheckpoint(h.state, h.monitor);
  const before = structuredClone(raw);
  const restored = restoreSubtaskCheckpoint(
    raw,
    h.state.sourceId,
    h.resolve,
    h.preceding,
    undefined,
    (job: SubtaskReportJob, candidate: SubtaskRestoreContext) => {
      job.childIds.length = 0;
      candidate.state.tasks.length = 0;
      if (candidate.group)
        Reflect.set(candidate.group.children[0], "label", "mutated callback");
      raw.monitor?.subtasks?.journal.reports.splice(0);
      return true;
    },
  );
  expect(restored).toEqual({ state: before.state, monitor: before.monitor });
});
it.each([
  "parent",
  "parent-source",
  "group",
  "list",
  "roster",
  "model",
  "identity",
  "saved-source",
])("shared report bridge rejects %s drift", async (mode) => {
  const h = await fixture();
  const candidate = structuredClone({ state: h.state, group: h.group });
  const job = structuredClone(h.job);
  if (mode === "parent") candidate.state.tasks[0].revision++;
  if (mode === "parent-source")
    job.parentSourceDigest = subtaskHash("different current parent source");
  if (mode === "group") job.groupId = "subtask-group:999";
  if (mode === "list") job.listRevision++;
  if (mode === "roster") job.childIds = ["subtask-child:999"];
  if (mode === "model") job.model = "other-model";
  if (mode === "identity") job.identity = subtaskHash("different rubric/job");
  if (mode === "saved-source")
    h.observations.set(
      "report",
      observation("report", "Edited report.", "assistant"),
    );
  expect(subtaskRuntimeReportIsCurrent(job, h.current, candidate)).toBe(false);
});
it("preserves immutable group provenance while matching the current parent source binding", async () => {
  const h = await fixture();
  const candidate = structuredClone({ state: h.state, group: h.group });
  const restatement = observation(
    "parent-restatement",
    "The same generic step remains required.",
  );
  h.observations.set(restatement.id, restatement);
  candidate.state.tasks[0].source = subtaskSource(
    restatement.id,
    restatement.text,
  );
  const report = h.observations.get(h.job.source.entryId);
  if (!report) throw new Error("Missing canonical report");
  const batch = subtaskReportBatches({
    parent: candidate.state.tasks[0],
    group: candidate.group,
    report,
    resolve: h.resolve,
  })[0];
  if (!batch) throw new Error("Missing current-parent report binding");
  const job: SubtaskReportJob = {
    ...h.job,
    identity: batch.jobIdentity,
    parentSourceDigest: batch.parentSourceDigest,
    state: "ready",
    attempts: [],
  };
  delete job.parkedUntil;
  expect(job.parentSourceDigest).not.toBe(candidate.group.parentSourceDigest);
  expect(subtaskRuntimeReportIsCurrent(job, h.current, candidate)).toBe(true);
});
it("shared bridge accepts exact binding independently of current latest and live parent state", async () => {
  const h = await fixture();
  expect(
    subtaskRuntimeReportIsCurrent(h.job, h.current, {
      state: h.state,
      group: h.group,
    }),
  ).toBe(true);
});
