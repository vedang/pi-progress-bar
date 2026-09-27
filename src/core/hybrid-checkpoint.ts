import { createHash } from "node:crypto";
import { completionRequest } from "../analysis/completion";
import type {
  CoverageIntentDispatchReceipt,
  CoverageIntentJob,
  CoverageIntentJournal,
} from "../analysis/coverage-intent";
import { extractionInput } from "../analysis/extractor";
import { gateRequest } from "../analysis/gate";
import type {
  DetailBatchReceipt,
  DetailCandidate,
  DetailKey,
  TaskDetailRecord,
} from "../analysis/task-details";
import {
  type CoverageCheckpoint,
  coverageCheckpointIsValid,
  MAX_COVERAGE_CHECKPOINT_BYTES,
} from "./coverage";
import {
  acceptedCompletionIds,
  applyCompletionRecord,
  applyFocusRecord,
  applyGate,
  applyPatch,
  completionChunks,
  completionUndo,
  patchUndo,
} from "./hybrid";
import {
  gateDecision,
  normalizedChoiceAssessment,
  optionalPresence,
  originHash,
  replayCore,
  requestHash,
  sameJson,
} from "./hybrid-proof";
import {
  type Assessment,
  type Cursor,
  copyState,
  type GateRecord,
  type HybridState,
  type HybridTask,
  type MutationEvent,
  type NormalizedPatch,
  type Observation,
  type ObservationRef,
  type ObservationRole,
  type PatchUndo,
  type PendingBlock,
  type PendingObservation,
  type Presence,
  type SourceRef,
  type TaskStatus,
  taskLabelIsValid,
} from "./hybrid-state";
import {
  restoreSubtaskJournal,
  type SubtaskJournalCheckpoint,
  type SubtaskPhaseRecord,
  subtaskJournalIsValid,
} from "./subtask-journal";
import {
  type SubtaskCheckpoint,
  type SubtaskGroupSnapshot,
  SubtaskStore,
  subtaskCheckpointIsValid,
} from "./subtasks";

const VERSION = 10;
const SUBTASK_VERSION = 11;
const MAX_SUBTASK_OPTIONAL_BYTES = 64 * 1024;
const MAX_TASKS = 200;
const MAX_ACTIVE_TASKS = 20;
const MAX_EVENTS = 1000;
export const MAX_CHECKPOINT_BYTES = 512 * 1024;
const MAX_COMPLETIONS = 20;
const MAX_HEALTH_COVERAGE_REFERENCES = 16;
const healthCoverageOmissions = new Set([
  "Older canonical reports omitted after 16 retained observations",
  "Canonical report coverage scan reached bounded page limit",
  "Older canonical report omitted because full report context exceeded 4 KiB",
  "Target canonical report omitted because it exceeded 4 KiB",
]);
const focusSpecialChoices = new Set(["none", "concurrent", "uncertain"]);

export interface HealthFields {
  requirements: string;
  acceptance: string;
  newRedTest: string;
  redEvidence: string;
  implementation: string;
}

/**
 * Durable bounded report-coverage receipt. It binds detached canonical refs and
 * selector outcome, never report text or the runtime report array.
 */
export interface HealthCoverage {
  target: ObservationRef;
  references: ObservationRef[];
  complete: boolean;
  omissions: string[];
  coverageDigest: string;
}

/** Durable task-local assessment fact. Raw prompts, answers and evidence stay out. */
export interface HealthCard {
  taskId: string;
  revision: number;
  label: string;
  assessedAt: number;
  health: HealthFields;
  provenance: {
    taskSource: SourceRef;
    observation: ObservationRef;
    coverage: HealthCoverage;
    snapshotHash: string;
    requestHashes: string[];
    evidenceHash: string;
    codeRevision: number;
  };
}

export interface CoverageReportJobCheckpoint {
  version: 1;
  identity: string;
  parentTaskId: string;
  parentRevision: number;
  parentSourceDigest: string;
  groupId: string;
  inventoryRevision: number;
  source: SourceRef;
  state: "ready" | "parked" | "permanent" | "complete";
  parkedUntil?: number;
}

export interface CoverageQueueCheckpoint {
  kind: "intent" | "report";
  /** Intent uses a digest; report uses exact parent task ID. */
  key: string;
}

export interface CoverageReportDispatchCheckpoint {
  jobIdentity: string;
  requestHash: string;
  groupId: string;
  inventoryRevision: number;
  source: SourceRef;
  childIds: string[];
  assessments: Array<{
    childId: string;
    choice: "reviewed" | "retracted" | "blocked" | "unchanged" | "uncertain";
    confidence: number;
    probability: number;
  }>;
  dispatch: number;
  at: number;
  usage: { inputTokens: number; outputTokens: number };
  outcome: "accepted";
}

interface CoverageCheckpointMetadata {
  state: CoverageCheckpoint;
  dispatches: number;
  usage: {
    jev: { calls: number; inputTokens: number; outputTokens: number };
    extraction: { calls: number; inputTokens: number; outputTokens: number };
  };
  /** Durable optional omissions; never infer semantic scope from them. */
  omissions?: number;
  intents?: CoverageIntentJournal;
  intentJobs?: CoverageIntentJob[];
  intentReceipts?: CoverageIntentDispatchReceipt[];
  queue?: CoverageQueueCheckpoint[];
  jobs?: CoverageReportJobCheckpoint[];
  reportReceipts?: CoverageReportDispatchCheckpoint[];
}

export interface MonitorCheckpointMetadata {
  enabled: boolean;
  usage: {
    jev: { calls: number; inputTokens: number; outputTokens: number };
    extraction: { calls: number; inputTokens: number; outputTokens: number };
  };
  lastJevCallAt?: number;
  lastExtractionCallAt?: number;
  /** Exact completed task eligible for qualified idle display; no health payload. */
  idleDoneTaskId?: string;
  /** At most one exact accepted health fact for every retained task. */
  healthCards?: HealthCard[];
  /** Optional exact source spans and normalized field assessments; never quote text. */
  /** Validated at storage boundary; public type stays broad for checkpoint readers. */
  taskDetails?: unknown[];
  /** Optional durable coverage state; no host ingress or classifier result is implied. */
  coverage?: CoverageCheckpointMetadata;
}

interface Checkpoint {
  version: typeof VERSION;
  state: HybridState;
  monitor?: MonitorCheckpointMetadata;
}

interface SubtaskCheckpointMetadata {
  state: SubtaskCheckpoint;
  journal: SubtaskJournalCheckpoint;
}

/** v11 staged monitor projection. It deliberately has no legacy coverage field. */
interface SubtaskMonitorCheckpointMetadata {
  enabled: boolean;
  usage: {
    jev: { calls: number; inputTokens: number; outputTokens: number };
    extraction: { calls: number; inputTokens: number; outputTokens: number };
  };
  lastJevCallAt?: number;
  lastExtractionCallAt?: number;
  idleDoneTaskId?: string;
  healthCards?: HealthCard[];
  taskDetails?: unknown[];
  subtasks?: SubtaskCheckpointMetadata;
}

interface SubtaskCheckpointEnvelope {
  version: typeof SUBTASK_VERSION;
  state: HybridState;
  monitor?: SubtaskMonitorCheckpointMetadata;
}

/** Structural storage result only; canonical replay/amendment is checked separately. */
export type CheckpointStorageStatus =
  | "absent"
  | "supported"
  | "unsupported"
  | "corrupt";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) => {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
};
const MAX_NUMERIC_ID_CODE_UNITS = 32;
const hashIsValid = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length === 64 &&
  /^[a-f0-9]{64}$/.test(value);
const numericIdIsValid = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" &&
  value.length <= MAX_NUMERIC_ID_CODE_UNITS &&
  pattern.test(value);
const taskIdIsValid = (value: unknown): value is string =>
  numericIdIsValid(value, /^task:[1-9]\d*$/);
const eventIdIsValid = (value: unknown): value is string =>
  numericIdIsValid(value, /^event:[1-9]\d*$/);
const roleIsValid = (value: unknown): value is ObservationRole =>
  value === "user" || value === "assistant" || value === "intercom";
const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const unit = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;
const positiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1;
const nonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const safeLabel = taskLabelIsValid;
const safeHealthLabel = (value: unknown) =>
  typeof value === "string" &&
  value.length <= 128 &&
  !/[\p{Cc}\p{Cf}]/u.test(value);

function validObservationRef(value: unknown): value is ObservationRef {
  return (
    record(value) &&
    exactKeys(value, ["entryId", "messageHash", "role"]) &&
    typeof value.entryId === "string" &&
    !!value.entryId &&
    hashIsValid(value.messageHash) &&
    roleIsValid(value.role)
  );
}

function validSourceRef(value: unknown): value is SourceRef {
  if (
    !record(value) ||
    !exactKeys(value, [
      "entryId",
      "messageHash",
      "role",
      "start",
      "end",
      "quoteHash",
    ])
  )
    return false;
  return (
    typeof value.entryId === "string" &&
    !!value.entryId &&
    hashIsValid(value.messageHash) &&
    roleIsValid(value.role) &&
    Number.isSafeInteger(value.start) &&
    (value.start as number) >= 0 &&
    positiveInteger(value.end) &&
    (value.end as number) > (value.start as number) &&
    hashIsValid(value.quoteHash)
  );
}

function validAssessment(value: unknown): value is Assessment {
  return (
    record(value) &&
    exactKeys(value, [
      "rawChoice",
      "confidence",
      "probability",
      "reason",
      "source",
    ]) &&
    (value.rawChoice === "changed" ||
      value.rawChoice === "unchanged" ||
      value.rawChoice === "uncertain" ||
      value.rawChoice === "none" ||
      value.rawChoice === "concurrent" ||
      value.rawChoice === "yes" ||
      value.rawChoice === "no" ||
      value.rawChoice === "invalid" ||
      taskIdIsValid(value.rawChoice)) &&
    unit(value.confidence) &&
    unit(value.probability) &&
    (value.reason === "accepted" ||
      value.reason === "semantic-unknown" ||
      value.reason === "threshold-abstention") &&
    validObservationRef(value.source)
  );
}

function validPresence<T>(
  value: unknown,
  valid: (candidate: unknown) => candidate is T,
): value is Presence<T> {
  return (
    (record(value) &&
      exactKeys(value, ["present"]) &&
      value.present === false) ||
    (record(value) &&
      exactKeys(value, ["present", "value"]) &&
      value.present === true &&
      valid(value.value))
  );
}

function validTaskStatus(value: unknown): value is TaskStatus {
  return value === "not-started" || value === "reopened" || value === "done";
}

function validTask(value: unknown): value is HybridTask {
  return (
    record(value) &&
    exactKeys(
      value,
      [
        "id",
        "label",
        "kind",
        "basis",
        "status",
        "included",
        "revision",
        "source",
      ],
      ["latestAssessment"],
    ) &&
    taskIdIsValid(value.id) &&
    safeLabel(value.label) &&
    (value.kind === "action" || value.kind === "response") &&
    (value.basis === "explicit" || value.basis === "derived") &&
    validTaskStatus(value.status) &&
    typeof value.included === "boolean" &&
    positiveInteger(value.revision) &&
    validSourceRef(value.source) &&
    (!Object.hasOwn(value, "latestAssessment") ||
      validAssessment(value.latestAssessment))
  );
}

function validEvent(value: unknown): value is MutationEvent {
  return (
    record(value) &&
    exactKeys(value, ["id", "kind", "taskId", "revision", "source"]) &&
    eventIdIsValid(value.id) &&
    (value.kind === "create" ||
      value.kind === "revise" ||
      value.kind === "archive" ||
      value.kind === "restore" ||
      value.kind === "complete" ||
      value.kind === "withdraw") &&
    taskIdIsValid(value.taskId) &&
    positiveInteger(value.revision) &&
    validObservationRef(value.source)
  );
}

function validCursor(value: unknown): value is Cursor {
  return (
    record(value) &&
    exactKeys(value, ["id", "hash", "role"]) &&
    typeof value.id === "string" &&
    !!value.id &&
    hashIsValid(value.hash) &&
    roleIsValid(value.role)
  );
}

function validPatch(value: unknown): value is NormalizedPatch {
  if (
    !record(value) ||
    !exactKeys(value, ["add", "revise", "archive", "restore", "unresolved"])
  )
    return false;
  const add = value.add;
  const revise = value.revise;
  const archive = value.archive;
  const restore = value.restore;
  if (
    !Array.isArray(add) ||
    add.length > 6 ||
    !Array.isArray(revise) ||
    revise.length > 12 ||
    !Array.isArray(archive) ||
    archive.length > 12 ||
    !Array.isArray(restore) ||
    restore.length > 12 ||
    typeof value.unresolved !== "boolean"
  )
    return false;
  if (
    !add.every(
      (operation) =>
        record(operation) &&
        exactKeys(operation, ["label", "kind", "basis", "source"]) &&
        safeLabel(operation.label) &&
        (operation.kind === "action" || operation.kind === "response") &&
        (operation.basis === "explicit" || operation.basis === "derived") &&
        validSourceRef(operation.source),
    )
  )
    return false;
  if (
    !revise.every(
      (operation) =>
        record(operation) &&
        exactKeys(operation, [
          "id",
          "label",
          "requirementsChanged",
          "source",
        ]) &&
        taskIdIsValid(operation.id) &&
        safeLabel(operation.label) &&
        typeof operation.requirementsChanged === "boolean" &&
        validSourceRef(operation.source),
    )
  )
    return false;
  if (
    !archive.every(
      (operation) =>
        record(operation) &&
        exactKeys(operation, ["id", "source"]) &&
        taskIdIsValid(operation.id) &&
        validSourceRef(operation.source),
    )
  )
    return false;
  if (
    !restore.every(
      (operation) =>
        record(operation) &&
        exactKeys(operation, [
          "id",
          "label",
          "requirementsChanged",
          "source",
        ]) &&
        taskIdIsValid(operation.id) &&
        safeLabel(operation.label) &&
        typeof operation.requirementsChanged === "boolean" &&
        validSourceRef(operation.source),
    )
  )
    return false;
  const ids = [...revise, ...archive, ...restore].map(
    (operation) => operation.id,
  );
  return (
    new Set(ids).size === ids.length &&
    (!value.unresolved ||
      !(add.length || revise.length || archive.length || restore.length)) &&
    new Set(add.map((operation) => `${operation.kind}:${operation.label}`))
      .size === add.length
  );
}

function validPatchUndo(
  value: unknown,
  outcome: NormalizedPatch,
): value is PatchUndo {
  if (
    !record(value) ||
    !exactKeys(value, [
      "revise",
      "archive",
      "restore",
      "nextTaskId",
      "focusTaskId",
      "scopeUnresolved",
      "eventLength",
    ])
  )
    return false;
  if (
    !Array.isArray(value.revise) ||
    value.revise.length !== outcome.revise.length ||
    !Array.isArray(value.archive) ||
    value.archive.length !== outcome.archive.length ||
    !Array.isArray(value.restore) ||
    value.restore.length !== outcome.restore.length
  )
    return false;
  return (
    value.revise.every(
      (undo) =>
        record(undo) &&
        exactKeys(undo, ["index", "label", "status", "revision", "source"]) &&
        nonNegativeInteger(undo.index) &&
        safeLabel(undo.label) &&
        validTaskStatus(undo.status) &&
        positiveInteger(undo.revision) &&
        validSourceRef(undo.source),
    ) &&
    value.archive.every(
      (undo) =>
        record(undo) &&
        exactKeys(undo, ["index", "included"]) &&
        nonNegativeInteger(undo.index) &&
        typeof undo.included === "boolean",
    ) &&
    value.restore.every(
      (undo) =>
        record(undo) &&
        exactKeys(undo, [
          "index",
          "label",
          "status",
          "included",
          "revision",
          "source",
        ]) &&
        nonNegativeInteger(undo.index) &&
        safeLabel(undo.label) &&
        validTaskStatus(undo.status) &&
        typeof undo.included === "boolean" &&
        positiveInteger(undo.revision) &&
        validSourceRef(undo.source),
    ) &&
    positiveInteger(value.nextTaskId) &&
    validPresence(value.focusTaskId, taskIdIsValid) &&
    typeof value.scopeUnresolved === "boolean" &&
    nonNegativeInteger(value.eventLength)
  );
}

function validFocusRecord(value: unknown) {
  return (
    record(value) &&
    exactKeys(value, ["assessment", "priorFocusTaskId"]) &&
    validAssessment(value.assessment) &&
    validPresence(value.priorFocusTaskId, taskIdIsValid)
  );
}

function validGate(value: unknown): value is GateRecord {
  return (
    record(value) &&
    exactKeys(value, [
      "originHash",
      "requestHash",
      "context",
      "assessment",
      "priorScopeAssessment",
    ]) &&
    hashIsValid(value.originHash) &&
    hashIsValid(value.requestHash) &&
    Array.isArray(value.context) &&
    value.context.length <= 2 &&
    value.context.every(validObservationRef) &&
    new Set(value.context.map((item) => item.entryId)).size ===
      value.context.length &&
    validAssessment(value.assessment) &&
    validPresence(value.priorScopeAssessment, validAssessment)
  );
}

function validPending(value: unknown): value is PendingObservation {
  if (
    !record(value) ||
    !exactKeys(value, ["observation", "phase", "block", "journal"]) ||
    !validObservationRef(value.observation) ||
    (value.phase !== "extract" && value.phase !== "complete") ||
    !validPresence(
      value.block,
      (block): block is PendingBlock =>
        block === "invalid-patch" ||
        block === "input-overflow" ||
        block === "task-capacity" ||
        block === "event-capacity" ||
        block === "completion-build",
    ) ||
    !record(value.journal) ||
    !exactKeys(value.journal, ["gate", "completions"], ["patch"]) ||
    !validGate(value.journal.gate) ||
    !Array.isArray(value.journal.completions) ||
    value.journal.completions.length > MAX_COMPLETIONS
  )
    return false;
  const observation = value.observation;
  const gate = value.journal.gate;
  if (!sameRef(gate.assessment.source, observation)) return false;
  if (
    gate.priorScopeAssessment.present &&
    !validAssessment(gate.priorScopeAssessment.value)
  )
    return false;
  if (value.journal.patch) {
    if (
      !record(value.journal.patch) ||
      !exactKeys(value.journal.patch, ["requestHash", "outcome", "undo"]) ||
      !hashIsValid(value.journal.patch.requestHash) ||
      !validPatch(value.journal.patch.outcome) ||
      !validPatchUndo(value.journal.patch.undo, value.journal.patch.outcome)
    )
      return false;
  }
  const ids = new Set<string>();
  let count = 0;
  for (const [
    completionIndex,
    completion,
  ] of value.journal.completions.entries()) {
    if (
      !record(completion) ||
      !exactKeys(
        completion,
        ["requestHash", "chunkIds", "assessments", "undo"],
        ["focus"],
      ) ||
      !hashIsValid(completion.requestHash) ||
      !Array.isArray(completion.chunkIds) ||
      completion.chunkIds.length < 1 ||
      completion.chunkIds.length > MAX_COMPLETIONS ||
      !completion.chunkIds.every(taskIdIsValid) ||
      !Array.isArray(completion.assessments) ||
      completion.assessments.length !== completion.chunkIds.length ||
      !completion.assessments.every(validAssessment) ||
      !record(completion.undo) ||
      !exactKeys(completion.undo, ["tasks", "eventLength"]) ||
      !Array.isArray(completion.undo.tasks) ||
      completion.undo.tasks.length !== completion.chunkIds.length ||
      !completion.undo.tasks.every(
        (undo) =>
          record(undo) &&
          exactKeys(undo, ["status", "latestAssessment"]) &&
          validTaskStatus(undo.status) &&
          validPresence(undo.latestAssessment, validAssessment),
      ) ||
      !nonNegativeInteger(completion.undo.eventLength) ||
      (Object.hasOwn(completion, "focus") &&
        !validFocusRecord(completion.focus))
    )
      return false;
    if (Object.hasOwn(completion, "focus") && completionIndex !== 0)
      return false;
    for (const id of completion.chunkIds) {
      count++;
      if (ids.has(id)) return false;
      ids.add(id);
    }
    if (
      !completion.assessments.every((assessment) =>
        sameRef(assessment.source, observation),
      )
    )
      return false;
  }
  return count <= MAX_COMPLETIONS;
}

function sameRef(left: ObservationRef, right: ObservationRef) {
  return (
    left.entryId === right.entryId &&
    left.messageHash === right.messageHash &&
    left.role === right.role
  );
}

function validState(value: unknown): value is HybridState {
  if (
    !record(value) ||
    !exactKeys(
      value,
      [
        "sourceId",
        "capacity",
        "tasks",
        "events",
        "nextTaskId",
        "scopeUnresolved",
      ],
      [
        "cursor",
        "pending",
        "focusTaskId",
        "scopeAssessment",
        "scopeError",
        "scopeFailure",
        "completionError",
      ],
    ) ||
    typeof value.sourceId !== "string" ||
    !value.sourceId.trim() ||
    (value.capacity !== "clear" && value.capacity !== "limit") ||
    !Array.isArray(value.tasks) ||
    !Array.isArray(value.events) ||
    !positiveInteger(value.nextTaskId) ||
    typeof value.scopeUnresolved !== "boolean" ||
    value.tasks.length > MAX_TASKS ||
    value.events.length > MAX_EVENTS ||
    !value.tasks.every(validTask) ||
    !value.events.every(validEvent)
  )
    return false;
  const state = value as unknown as HybridState;
  if (
    (Object.hasOwn(state, "cursor") && !validCursor(state.cursor)) ||
    (Object.hasOwn(state, "pending") && !validPending(state.pending)) ||
    (Object.hasOwn(state, "focusTaskId") &&
      state.focusTaskId !== undefined &&
      state.focusTaskId !== null &&
      !taskIdIsValid(state.focusTaskId)) ||
    (Object.hasOwn(state, "scopeAssessment") &&
      !validAssessment(state.scopeAssessment)) ||
    (Object.hasOwn(state, "scopeError") &&
      typeof state.scopeError !== "string") ||
    (Object.hasOwn(state, "scopeFailure") &&
      state.scopeFailure !== "capacity" &&
      state.scopeFailure !== "invalid" &&
      state.scopeFailure !== "overflow") ||
    (Object.hasOwn(state, "completionError") &&
      typeof state.completionError !== "string")
  )
    return false;
  const taskIds = new Set(state.tasks.map((task) => task.id));
  if (
    taskIds.size !== state.tasks.length ||
    state.tasks.filter((task) => task.included).length > MAX_ACTIVE_TASKS
  )
    return false;
  const maxTaskId = Math.max(
    0,
    ...state.tasks.map((task) => Number(task.id.slice("task:".length))),
  );
  if (state.nextTaskId <= maxTaskId) return false;
  if (
    state.events.some(
      (event, index) =>
        event.id !== `event:${index + 1}` ||
        !taskIds.has(event.taskId) ||
        event.revision >
          (state.tasks.find((task) => task.id === event.taskId)?.revision ?? 0),
    )
  )
    return false;
  if (typeof state.focusTaskId === "string") {
    const focused = state.tasks.find((task) => task.id === state.focusTaskId);
    if (!focused?.included || focused.status === "done") return false;
  }
  if (
    state.events.some(
      (event) =>
        event.kind === "create" &&
        state.events.filter(
          (candidate) =>
            candidate.kind === "create" && candidate.taskId === event.taskId,
        ).length !== 1,
    ) ||
    state.tasks.some(
      (task) =>
        state.events.filter(
          (event) => event.kind === "create" && event.taskId === task.id,
        ).length !== 1,
    )
  )
    return false;
  if (
    state.pending &&
    state.cursor &&
    sameRef(
      {
        entryId: state.cursor.id,
        messageHash: state.cursor.hash,
        role: state.cursor.role,
      },
      state.pending.observation,
    )
  )
    return false;
  return true;
}

const detailKeyIsValid = (value: unknown): value is DetailKey =>
  value === "title" ||
  value === "description" ||
  (typeof value === "string" && /^acceptance:[0-5]$/.test(value));
const detailOrder = (key: DetailKey) =>
  key === "title" ? 0 : key === "description" ? 1 : 2 + Number(key.slice(11));
const detailChoices = new Set(["yes", "no", "uncertain"]);

function validDetailCandidate(value: unknown): value is DetailCandidate {
  return (
    record(value) &&
    exactKeys(value, ["key", "source"]) &&
    detailKeyIsValid(value.key) &&
    validSourceRef(value.source)
  );
}

function validDetailReceipt(value: unknown): value is DetailBatchReceipt {
  if (
    !record(value) ||
    !exactKeys(value, [
      "requestHash",
      "candidateKeys",
      "assessments",
      "validatedAt",
    ]) ||
    !hashIsValid(value.requestHash) ||
    !Array.isArray(value.candidateKeys) ||
    value.candidateKeys.length < 1 ||
    value.candidateKeys.length > 20 ||
    !value.candidateKeys.every(detailKeyIsValid) ||
    !Array.isArray(value.assessments) ||
    value.assessments.length !== value.candidateKeys.length ||
    !value.assessments.every(validAssessment) ||
    !nonNegativeInteger(value.validatedAt)
  )
    return false;
  return value.assessments.every((assessment) =>
    matchesNormalizedAssessment(assessment, detailChoices),
  );
}

function validTaskDetailRecord(value: unknown): value is TaskDetailRecord {
  if (
    !record(value) ||
    !exactKeys(value, [
      "taskId",
      "revision",
      "label",
      "taskSource",
      "candidates",
      "receipts",
    ]) ||
    !taskIdIsValid(value.taskId) ||
    !positiveInteger(value.revision) ||
    !safeLabel(value.label) ||
    !validSourceRef(value.taskSource) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length < 1 ||
    value.candidates.length > 8 ||
    !value.candidates.every(validDetailCandidate) ||
    !Array.isArray(value.receipts) ||
    !value.receipts.every(validDetailReceipt)
  )
    return false;
  const candidates = value.candidates as DetailCandidate[];
  const receipts = value.receipts as DetailBatchReceipt[];
  const keys = candidates.map((candidate) => candidate.key);
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key, index) => {
      const previous = keys[index - 1];
      return !!previous && detailOrder(key) <= detailOrder(previous);
    })
  )
    return false;
  const prefix = receipts.flatMap((receipt) => receipt.candidateKeys);
  if (
    prefix.length > keys.length ||
    prefix.some((key, index) => key !== keys[index])
  )
    return false;
  return receipts.every((receipt) =>
    receipt.assessments.every((assessment, index) => {
      const candidate = candidates.find(
        (item) => item.key === receipt.candidateKeys[index],
      );
      return (
        !!candidate &&
        assessment.source.entryId === candidate.source.entryId &&
        assessment.source.messageHash === candidate.source.messageHash &&
        assessment.source.role === candidate.source.role
      );
    }),
  );
}

function validCoverageUsage(
  value: unknown,
): value is CoverageCheckpointMetadata["usage"] {
  if (!record(value) || !exactKeys(value, ["jev", "extraction"])) return false;
  return [value.jev, value.extraction].every(
    (item) =>
      record(item) &&
      exactKeys(item, ["calls", "inputTokens", "outputTokens"]) &&
      nonNegativeInteger(item.calls) &&
      nonNegativeInteger(item.inputTokens) &&
      nonNegativeInteger(item.outputTokens),
  );
}

const coverageJobIdIsValid = (value: unknown): value is string =>
  numericIdIsValid(value, /^coverage-group:[1-9]\d*$/);
const coverageChildIdIsValid = (value: unknown): value is string =>
  numericIdIsValid(value, /^coverage-child:[1-9]\d*$/);
const coverageChoices = new Set([
  "reviewed",
  "retracted",
  "blocked",
  "unchanged",
  "uncertain",
]);
const MAX_COVERAGE_PENDING_JOBS = 20;
/** Adaptive 24KiB requests can legally shrink to one of 200 retained children. */
const MAX_COVERAGE_REPORT_RECEIPTS = 200;
const MAX_COVERAGE_INTENT_RECEIPTS = 40;

function validCoverageIntentJournal(
  value: unknown,
): value is CoverageIntentJournal {
  if (
    !record(value) ||
    !exactKeys(value, ["accepted", "negative"]) ||
    !Array.isArray(value.accepted) ||
    value.accepted.length > 20 ||
    !Array.isArray(value.negative) ||
    value.negative.length > 20
  )
    return false;
  const acceptedKeys = new Set<string>();
  const acceptedIdentities = new Set<string>();
  for (const receipt of value.accepted) {
    if (
      !record(receipt) ||
      !exactKeys(receipt, [
        "identity",
        "parentTaskId",
        "parentRevision",
        "parentSourceDigest",
        "resourceKey",
        "source",
      ]) ||
      !hashIsValid(receipt.identity) ||
      !taskIdIsValid(receipt.parentTaskId) ||
      !positiveInteger(receipt.parentRevision) ||
      !hashIsValid(receipt.parentSourceDigest) ||
      !hashIsValid(receipt.resourceKey) ||
      !validSourceRef(receipt.source)
    )
      return false;
    const key = JSON.stringify([
      receipt.identity,
      receipt.parentTaskId,
      receipt.parentRevision,
      receipt.parentSourceDigest,
      receipt.resourceKey,
      receipt.source,
    ]);
    if (acceptedKeys.has(key)) return false;
    acceptedKeys.add(key);
    acceptedIdentities.add(receipt.identity);
  }
  const negative = new Set<string>();
  for (const receipt of value.negative) {
    if (
      !record(receipt) ||
      !exactKeys(receipt, ["identity", "source"]) ||
      !hashIsValid(receipt.identity) ||
      !validObservationRef(receipt.source) ||
      negative.has(receipt.identity)
    )
      return false;
    negative.add(receipt.identity);
  }
  return ![...acceptedIdentities].some((identity) => negative.has(identity));
}

function validCoverageIntentJob(value: unknown): value is CoverageIntentJob {
  if (
    !record(value) ||
    !exactKeys(
      value,
      [
        "version",
        "identity",
        "targetKey",
        "source",
        "owners",
        "parents",
        "state",
      ],
      ["parkedUntil"],
    ) ||
    value.version !== 1 ||
    !hashIsValid(value.identity) ||
    !hashIsValid(value.targetKey) ||
    !validObservationRef(value.source) ||
    !Array.isArray(value.owners) ||
    value.owners.length < 1 ||
    value.owners.length > 20 ||
    !value.owners.every(
      (owner) =>
        record(owner) &&
        exactKeys(owner, ["id", "revision", "sourceDigest"]) &&
        taskIdIsValid(owner.id) &&
        positiveInteger(owner.revision) &&
        hashIsValid(owner.sourceDigest),
    ) ||
    new Set(value.owners.map((owner) => owner.id)).size !==
      value.owners.length ||
    hash(JSON.stringify(value.owners)) !== value.targetKey ||
    !Array.isArray(value.parents) ||
    value.parents.length < 1 ||
    value.parents.length > 20 ||
    !value.parents.every(
      (parent) =>
        record(parent) &&
        exactKeys(parent, ["id", "revision", "sourceDigest"]) &&
        taskIdIsValid(parent.id) &&
        positiveInteger(parent.revision) &&
        hashIsValid(parent.sourceDigest),
    ) ||
    new Set(value.parents.map((parent) => parent.id)).size !==
      value.parents.length ||
    value.owners.some(
      (owner) =>
        !(
          value.parents as Array<{
            id: unknown;
            revision: unknown;
            sourceDigest: unknown;
          }>
        ).some(
          (parent) =>
            parent.id === owner.id &&
            parent.revision === owner.revision &&
            parent.sourceDigest === owner.sourceDigest,
        ),
    ) ||
    (value.state !== "ready" &&
      value.state !== "parked" &&
      value.state !== "permanent") ||
    (Object.hasOwn(value, "parkedUntil") &&
      (!nonNegativeInteger(value.parkedUntil) || value.state !== "parked"))
  )
    return false;
  return value.state === "parked"
    ? Object.hasOwn(value, "parkedUntil")
    : !Object.hasOwn(value, "parkedUntil");
}

function validCoverageIntentReceipt(
  value: unknown,
): value is CoverageIntentDispatchReceipt {
  return !!(
    record(value) &&
    exactKeys(value, [
      "identity",
      "requestHash",
      "dispatch",
      "at",
      "usage",
      "outcome",
    ]) &&
    hashIsValid(value.identity) &&
    hashIsValid(value.requestHash) &&
    positiveInteger(value.dispatch) &&
    value.dispatch <= 1024 &&
    nonNegativeInteger(value.at) &&
    record(value.usage) &&
    exactKeys(value.usage, ["inputTokens", "outputTokens"]) &&
    nonNegativeInteger(value.usage.inputTokens) &&
    nonNegativeInteger(value.usage.outputTokens) &&
    (value.outcome === "dispatched" || value.outcome === "accepted")
  );
}

function validCoverageQueue(value: unknown): value is CoverageQueueCheckpoint {
  return !!(
    record(value) &&
    exactKeys(value, ["kind", "key"]) &&
    ((value.kind === "intent" && hashIsValid(value.key)) ||
      (value.kind === "report" && taskIdIsValid(value.key)))
  );
}

function validCoverageReportJob(
  value: unknown,
): value is CoverageReportJobCheckpoint {
  if (
    !record(value) ||
    !exactKeys(
      value,
      [
        "version",
        "identity",
        "parentTaskId",
        "parentRevision",
        "parentSourceDigest",
        "groupId",
        "inventoryRevision",
        "source",
        "state",
      ],
      ["parkedUntil"],
    ) ||
    value.version !== 1 ||
    !hashIsValid(value.identity) ||
    !taskIdIsValid(value.parentTaskId) ||
    !positiveInteger(value.parentRevision) ||
    !hashIsValid(value.parentSourceDigest) ||
    !coverageJobIdIsValid(value.groupId) ||
    !positiveInteger(value.inventoryRevision) ||
    !validSourceRef(value.source) ||
    (value.state !== "ready" &&
      value.state !== "parked" &&
      value.state !== "permanent" &&
      value.state !== "complete") ||
    (Object.hasOwn(value, "parkedUntil") &&
      (!nonNegativeInteger(value.parkedUntil) || value.state !== "parked"))
  )
    return false;
  return value.state === "parked"
    ? Object.hasOwn(value, "parkedUntil")
    : !Object.hasOwn(value, "parkedUntil");
}

function validCoverageReportReceipt(
  value: unknown,
): value is CoverageReportDispatchCheckpoint {
  if (
    !record(value) ||
    !exactKeys(value, [
      "jobIdentity",
      "requestHash",
      "groupId",
      "inventoryRevision",
      "source",
      "childIds",
      "assessments",
      "dispatch",
      "at",
      "usage",
      "outcome",
    ]) ||
    !hashIsValid(value.jobIdentity) ||
    !hashIsValid(value.requestHash) ||
    !coverageJobIdIsValid(value.groupId) ||
    !positiveInteger(value.inventoryRevision) ||
    !validSourceRef(value.source) ||
    !Array.isArray(value.childIds) ||
    value.childIds.length < 1 ||
    value.childIds.length > 20 ||
    !value.childIds.every(coverageChildIdIsValid) ||
    new Set(value.childIds).size !== value.childIds.length ||
    !Array.isArray(value.assessments) ||
    value.assessments.length !== value.childIds.length ||
    !value.assessments.every(
      (assessment, index) =>
        record(assessment) &&
        exactKeys(assessment, [
          "childId",
          "choice",
          "confidence",
          "probability",
        ]) &&
        assessment.childId === (value.childIds as unknown[])[index] &&
        coverageChoices.has(assessment.choice as string) &&
        unit(assessment.confidence) &&
        unit(assessment.probability),
    ) ||
    !positiveInteger(value.dispatch) ||
    value.dispatch > 1024 ||
    !nonNegativeInteger(value.at) ||
    !record(value.usage) ||
    !exactKeys(value.usage, ["inputTokens", "outputTokens"]) ||
    !nonNegativeInteger(value.usage.inputTokens) ||
    !nonNegativeInteger(value.usage.outputTokens) ||
    value.outcome !== "accepted"
  )
    return false;
  return true;
}

function validCoverageMetadata(
  value: unknown,
): value is CoverageCheckpointMetadata {
  if (
    !record(value) ||
    !exactKeys(
      value,
      ["state", "dispatches", "usage"],
      [
        "omissions",
        "intents",
        "intentJobs",
        "intentReceipts",
        "queue",
        "jobs",
        "reportReceipts",
      ],
    ) ||
    !coverageCheckpointIsValid(value.state) ||
    byteLength(value) > MAX_COVERAGE_CHECKPOINT_BYTES ||
    !nonNegativeInteger(value.dispatches) ||
    value.dispatches > 1024 ||
    !validCoverageUsage(value.usage)
  )
    return false;
  const intents = value.intents;
  const intentJobs = value.intentJobs ?? [];
  const intentReceipts = value.intentReceipts ?? [];
  const queue = value.queue ?? [];
  const jobs = value.jobs ?? [];
  const receipts = value.reportReceipts ?? [];
  if (
    (value.omissions !== undefined && !nonNegativeInteger(value.omissions)) ||
    (intents !== undefined && !validCoverageIntentJournal(intents)) ||
    !Array.isArray(intentJobs) ||
    intentJobs.length > MAX_COVERAGE_PENDING_JOBS ||
    !intentJobs.every(validCoverageIntentJob) ||
    new Set(intentJobs.map((job) => job.targetKey)).size !==
      intentJobs.length ||
    !Array.isArray(intentReceipts) ||
    intentReceipts.length > MAX_COVERAGE_INTENT_RECEIPTS ||
    !intentReceipts.every(validCoverageIntentReceipt) ||
    new Set(intentReceipts.map((receipt) => receipt.identity)).size !==
      intentReceipts.length ||
    intentReceipts.some(
      (receipt) => receipt.dispatch > (value.dispatches as number),
    ) ||
    !Array.isArray(queue) ||
    queue.length > MAX_COVERAGE_PENDING_JOBS ||
    !queue.every(validCoverageQueue) ||
    new Set(queue.map((item) => `${item.kind}:${item.key}`)).size !==
      queue.length ||
    !Array.isArray(jobs) ||
    jobs.length > MAX_COVERAGE_PENDING_JOBS ||
    !jobs.every(validCoverageReportJob) ||
    new Set(jobs.map((job) => job.identity)).size !== jobs.length ||
    new Set(jobs.map((job) => job.parentTaskId)).size !== jobs.length ||
    !Array.isArray(receipts) ||
    receipts.length > MAX_COVERAGE_REPORT_RECEIPTS ||
    !receipts.every(validCoverageReportReceipt) ||
    new Set(receipts.map((receipt) => receipt.requestHash)).size !==
      receipts.length ||
    receipts.some((receipt) => receipt.dispatch > (value.dispatches as number))
  )
    return false;
  // Legacy v10 checkpoints may omit queue; restore reconstructs canonical order.
  if (value.queue !== undefined) {
    const queuedIntent = new Map(intentJobs.map((job) => [job.targetKey, job]));
    const queuedReport = new Map(jobs.map((job) => [job.parentTaskId, job]));
    const owners = new Set<string>();
    for (const item of queue) {
      const bindings =
        item.kind === "intent"
          ? queuedIntent.get(item.key)?.owners
          : (() => {
              const job = queuedReport.get(item.key);
              return job
                ? [
                    {
                      id: job.parentTaskId,
                      revision: job.parentRevision,
                      sourceDigest: job.parentSourceDigest,
                    },
                  ]
                : undefined;
            })();
      if (
        !bindings ||
        (item.kind === "intent"
          ? queuedIntent.get(item.key)?.state === "permanent"
          : queuedReport.get(item.key)?.state === "permanent" ||
            queuedReport.get(item.key)?.state === "complete")
      )
        return false;
      for (const binding of bindings) {
        const key = `${binding.id}:${binding.revision}:${binding.sourceDigest}`;
        if (owners.has(key)) return false;
        owners.add(key);
      }
    }
  }
  return (
    value.dispatches === value.usage.jev.calls + value.usage.extraction.calls
  );
}

function validMonitorMetadata(
  value: unknown,
  state: HybridState,
): value is MonitorCheckpointMetadata {
  if (
    !record(value) ||
    !exactKeys(
      value,
      ["enabled", "usage"],
      [
        "lastJevCallAt",
        "lastExtractionCallAt",
        "idleDoneTaskId",
        "healthCards",
        "taskDetails",
        "coverage",
      ],
    ) ||
    typeof value.enabled !== "boolean" ||
    !record(value.usage) ||
    !exactKeys(value.usage, ["jev", "extraction"]) ||
    ![value.usage.jev, value.usage.extraction].every(
      (usage) =>
        record(usage) &&
        exactKeys(usage, ["calls", "inputTokens", "outputTokens"]) &&
        nonNegativeInteger(usage.calls) &&
        nonNegativeInteger(usage.inputTokens) &&
        nonNegativeInteger(usage.outputTokens),
    ) ||
    (Object.hasOwn(value, "lastJevCallAt") &&
      !nonNegativeInteger(value.lastJevCallAt)) ||
    (Object.hasOwn(value, "lastExtractionCallAt") &&
      !nonNegativeInteger(value.lastExtractionCallAt)) ||
    (Object.hasOwn(value, "idleDoneTaskId") &&
      !taskIdIsValid(value.idleDoneTaskId))
  )
    return false;
  if (
    Object.hasOwn(value, "coverage") &&
    !validCoverageMetadata(value.coverage)
  )
    return false;
  if (Object.hasOwn(value, "healthCards")) {
    if (
      !Array.isArray(value.healthCards) ||
      value.healthCards.length > MAX_TASKS ||
      !value.healthCards.every(validHealthCard) ||
      new Set(value.healthCards.map((card) => card.taskId)).size !==
        value.healthCards.length ||
      !value.healthCards.every((card) =>
        state.tasks.some((task) => task.id === card.taskId),
      )
    )
      return false;
  }
  if (
    Object.hasOwn(value, "taskDetails") &&
    (!Array.isArray(value.taskDetails) ||
      value.taskDetails.length > MAX_TASKS ||
      !value.taskDetails.every(validTaskDetailRecord) ||
      new Set(value.taskDetails.map((record) => record.taskId)).size !==
        value.taskDetails.length ||
      !value.taskDetails.every((record) => {
        const task = state.tasks.find((item) => item.id === record.taskId);
        return (
          !!task &&
          task.revision === record.revision &&
          task.label === record.label &&
          validSourceRef(record.taskSource) &&
          task.source.entryId === record.taskSource.entryId &&
          task.source.messageHash === record.taskSource.messageHash &&
          task.source.role === record.taskSource.role &&
          task.source.start === record.taskSource.start &&
          task.source.end === record.taskSource.end &&
          task.source.quoteHash === record.taskSource.quoteHash
        );
      }))
  )
    return false;
  return (
    !Object.hasOwn(value, "idleDoneTaskId") ||
    state.tasks.some(
      (task) =>
        task.id === value.idleDoneTaskId &&
        task.included &&
        task.status === "done",
    )
  );
}

function validHealthCoverage(value: unknown): value is HealthCoverage {
  return (
    record(value) &&
    exactKeys(value, [
      "target",
      "references",
      "complete",
      "omissions",
      "coverageDigest",
    ]) &&
    validObservationRef(value.target) &&
    Array.isArray(value.references) &&
    value.references.length <= MAX_HEALTH_COVERAGE_REFERENCES &&
    value.references.every(validObservationRef) &&
    new Set(
      value.references.map(
        (reference) =>
          `${reference.entryId}:${reference.messageHash}:${reference.role}`,
      ),
    ).size === value.references.length &&
    typeof value.complete === "boolean" &&
    Array.isArray(value.omissions) &&
    value.omissions.every(
      (omission) =>
        typeof omission === "string" && healthCoverageOmissions.has(omission),
    ) &&
    value.omissions.length <= 1 &&
    (value.complete
      ? value.omissions.length === 0
      : value.omissions.length > 0) &&
    hashIsValid(value.coverageDigest)
  );
}

function validHealthCard(value: unknown): value is HealthCard {
  if (
    !record(value) ||
    !exactKeys(value, [
      "taskId",
      "revision",
      "label",
      "assessedAt",
      "health",
      "provenance",
    ]) ||
    !taskIdIsValid(value.taskId) ||
    !positiveInteger(value.revision) ||
    !safeLabel(value.label) ||
    !nonNegativeInteger(value.assessedAt) ||
    !record(value.health) ||
    !exactKeys(value.health, [
      "requirements",
      "acceptance",
      "newRedTest",
      "redEvidence",
      "implementation",
    ]) ||
    !Object.values(value.health).every(safeHealthLabel) ||
    !record(value.provenance) ||
    !exactKeys(value.provenance, [
      "taskSource",
      "observation",
      "coverage",
      "snapshotHash",
      "requestHashes",
      "evidenceHash",
      "codeRevision",
    ]) ||
    !validSourceRef(value.provenance.taskSource) ||
    !validObservationRef(value.provenance.observation) ||
    !validHealthCoverage(value.provenance.coverage) ||
    !hashIsValid(value.provenance.snapshotHash) ||
    !Array.isArray(value.provenance.requestHashes) ||
    value.provenance.requestHashes.length < 1 ||
    value.provenance.requestHashes.length > 20 ||
    !value.provenance.requestHashes.every(hashIsValid) ||
    !hashIsValid(value.provenance.evidenceHash) ||
    !nonNegativeInteger(value.provenance.codeRevision)
  )
    return false;
  return true;
}

function validCheckpoint(value: unknown): value is Checkpoint {
  return (
    record(value) &&
    exactKeys(value, ["version", "state"], ["monitor"]) &&
    value.version === VERSION &&
    validState(value.state) &&
    (!Object.hasOwn(value, "monitor") ||
      validMonitorMetadata(value.monitor, value.state))
  );
}

/**
 * Classify persisted shape before source/reference replay. A current-shape
 * checkpoint whose canonical conversation changed remains `supported`; restore
 * reconciles that accepted amendment without being misreported as corruption.
 */
export function checkpointStorageStatus(
  data: unknown,
): CheckpointStorageStatus {
  if (data === undefined) return "absent";
  if (!record(data)) return "corrupt";
  if (typeof data.version === "number" && data.version !== VERSION)
    return "unsupported";
  try {
    return validCheckpoint(data) && byteLength(data) <= MAX_CHECKPOINT_BYTES
      ? "supported"
      : "corrupt";
  } catch {
    return "corrupt";
  }
}

function canonicalObservation(
  reference: ObservationRef,
  resolve: (entryId: string) => Observation | undefined,
) {
  const observation = resolve(reference.entryId);
  return observation &&
    sameRef(reference, {
      entryId: observation.id,
      messageHash: observation.hash,
      role: observation.role,
    }) &&
    hash(observation.text) === observation.hash
    ? observation
    : undefined;
}

function canonicalSource(
  source: SourceRef,
  resolve: (entryId: string) => Observation | undefined,
) {
  const observation = canonicalObservation(source, resolve);
  return observation &&
    source.end <= observation.text.length &&
    hash(observation.text.slice(source.start, source.end)) === source.quoteHash
    ? observation
    : undefined;
}

function journalReferencesResolve(
  pending: PendingObservation,
  resolve: (entryId: string) => Observation | undefined,
) {
  const refs: ObservationRef[] = [
    ...pending.journal.gate.context,
    pending.journal.gate.assessment.source,
    ...(pending.journal.gate.priorScopeAssessment.present
      ? [pending.journal.gate.priorScopeAssessment.value.source]
      : []),
    ...pending.journal.completions.flatMap((completion) => [
      ...completion.assessments.map((assessment) => assessment.source),
      ...(completion.focus ? [completion.focus.assessment.source] : []),
      ...completion.undo.tasks.flatMap((undo) =>
        undo.latestAssessment.present
          ? [undo.latestAssessment.value.source]
          : [],
      ),
    ]),
  ];
  if (!refs.every((reference) => canonicalObservation(reference, resolve)))
    return false;
  const patch = pending.journal.patch;
  if (!patch) return true;
  const outcomeSources = [
    ...patch.outcome.add.map((operation) => operation.source),
    ...patch.outcome.revise.map((operation) => operation.source),
    ...patch.outcome.archive.map((operation) => operation.source),
    ...patch.outcome.restore.map((operation) => operation.source),
  ];
  // Patch output is grounded only in pending latest source. Undo fields are
  // historical sources but still require their exact stored span to resolve.
  return (
    outcomeSources.every(
      (source) =>
        sameRef(source, pending.observation) &&
        canonicalSource(source, resolve),
    ) &&
    [...patch.undo.revise, ...patch.undo.restore].every((operation) =>
      canonicalSource(operation.source, resolve),
    )
  );
}

function referencesResolve(
  state: HybridState,
  resolve: (entryId: string) => Observation | undefined,
) {
  if (!state.tasks.every((task) => canonicalSource(task.source, resolve)))
    return false;
  if (
    !state.events.every((event) => canonicalObservation(event.source, resolve))
  )
    return false;
  if (
    state.tasks.some(
      (task) =>
        task.latestAssessment &&
        !canonicalObservation(task.latestAssessment.source, resolve),
    )
  )
    return false;
  if (
    state.scopeAssessment &&
    (!canonicalObservation(state.scopeAssessment.source, resolve) ||
      !matchesNormalizedAssessment(state.scopeAssessment, GATE_CHOICES))
  )
    return false;
  if (
    state.tasks.some(
      (task) =>
        task.latestAssessment &&
        !matchesNormalizedAssessment(task.latestAssessment, COMPLETION_CHOICES),
    )
  )
    return false;
  if (
    state.pending &&
    (!canonicalObservation(state.pending.observation, resolve) ||
      !journalReferencesResolve(state.pending, resolve))
  )
    return false;
  if (
    state.cursor &&
    !canonicalObservation(
      {
        entryId: state.cursor.id,
        messageHash: state.cursor.hash,
        role: state.cursor.role,
      },
      resolve,
    )
  )
    return false;
  return true;
}

function checkpointState(state: HybridState): HybridState {
  const snapshot = copyState(state);
  if (
    Object.hasOwn(snapshot, "focusTaskId") &&
    snapshot.focusTaskId === undefined
  )
    (snapshot as unknown as { focusTaskId?: string | null }).focusTaskId = null;
  return snapshot;
}

/** Exact encoded bytes after strict v10 shape validation, before capacity denial. */
export function checkpointBytes(
  state: HybridState,
  monitor?: MonitorCheckpointMetadata,
) {
  if (!validState(state)) throw new Error("Invalid hybrid checkpoint state");
  const checkpoint: Checkpoint = {
    version: VERSION,
    state: checkpointState(state),
    ...(monitor ? { monitor } : {}),
  };
  if (!validCheckpoint(checkpoint))
    throw new Error("Invalid hybrid checkpoint");
  return byteLength(checkpoint);
}

/** Encode only bounded derived state; source text and provider envelopes never persist. */
export function encodeCheckpoint(
  state: HybridState,
  monitor?: MonitorCheckpointMetadata,
): Checkpoint {
  if (checkpointBytes(state, monitor) > MAX_CHECKPOINT_BYTES)
    throw new Error("Hybrid checkpoint exceeds v10 bounds");
  return JSON.parse(
    JSON.stringify({
      version: VERSION,
      state: checkpointState(state),
      ...(monitor ? { monitor } : {}),
    }),
  ) as Checkpoint;
}

/** Read only validated monitor-owned metadata; unknown checkpoint fields fail closed. */
export function monitorCheckpointMetadata(
  data: unknown,
): MonitorCheckpointMetadata | undefined {
  if (!validCheckpoint(data) || !data.monitor) return;
  return structuredClone(data.monitor);
}

const operationCount = (outcome: NormalizedPatch) =>
  outcome.add.length +
  outcome.revise.length +
  outcome.archive.length +
  outcome.restore.length;

function restorePresence<T>(
  state: HybridState,
  key: "focusTaskId" | "scopeAssessment",
  value: Presence<T>,
) {
  if (value.present)
    Object.assign(state, { [key]: structuredClone(value.value) });
  else delete (state as unknown as Record<string, unknown>)[key];
}

function reversePatch(
  state: HybridState,
  record: NonNullable<PendingObservation["journal"]["patch"]>,
) {
  const { outcome, undo } = record;
  if (state.events.length !== undo.eventLength + operationCount(outcome))
    throw new Error("Patch event suffix mismatch");
  const additions = outcome.add.length;
  const expectedAdditions = outcome.add.map(
    (_, index) => `task:${undo.nextTaskId + index}`,
  );
  if (
    state.tasks.length < additions ||
    (additions > 0 &&
      !sameJson(
        state.tasks.slice(-additions).map((task) => task.id),
        expectedAdditions,
      ))
  )
    throw new Error("Patch added tail mismatch");
  const base = state.tasks.slice(0, state.tasks.length - additions);
  const indexes = new Set<number>();
  const at = (index: number, id: string) => {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= base.length ||
      indexes.has(index) ||
      base[index]?.id !== id
    )
      throw new Error("Patch undo target mismatch");
    indexes.add(index);
    return base[index] as HybridTask;
  };
  outcome.revise.forEach((operation, index) => {
    const prior = undo.revise[index];
    if (!prior) throw new Error("Patch revise undo missing");
    const task = at(prior.index, operation.id);
    if (!task.included) throw new Error("Patch revise lifecycle mismatch");
    base[prior.index] = {
      ...task,
      label: prior.label,
      status: prior.status,
      revision: prior.revision,
      source: structuredClone(prior.source),
    };
  });
  outcome.archive.forEach((operation, index) => {
    const prior = undo.archive[index];
    if (!prior) throw new Error("Patch archive undo missing");
    const task = at(prior.index, operation.id);
    if (task.included || !prior.included)
      throw new Error("Patch archive lifecycle mismatch");
    base[prior.index] = { ...task, included: prior.included };
  });
  outcome.restore.forEach((operation, index) => {
    const prior = undo.restore[index];
    if (!prior) throw new Error("Patch restore undo missing");
    const task = at(prior.index, operation.id);
    if (!task.included || prior.included)
      throw new Error("Patch restore lifecycle mismatch");
    base[prior.index] = {
      ...task,
      label: prior.label,
      status: prior.status,
      included: prior.included,
      revision: prior.revision,
      source: structuredClone(prior.source),
    };
  });
  state.tasks = base;
  state.events = state.events.slice(0, undo.eventLength);
  state.nextTaskId = undo.nextTaskId;
  restorePresence(state, "focusTaskId", undo.focusTaskId);
  state.scopeUnresolved = undo.scopeUnresolved;
}

function reversePending(finalState: HybridState): HybridState {
  const state = copyState(finalState);
  const pending = state.pending;
  if (!pending) return state;
  delete state.pending;
  delete state.scopeError;
  delete state.scopeFailure;
  delete state.completionError;
  for (const completion of [...pending.journal.completions].reverse()) {
    if (completion.focus)
      restorePresence(state, "focusTaskId", completion.focus.priorFocusTaskId);
    if (state.events.length < completion.undo.eventLength)
      throw new Error("Completion event length invalid");
    completion.chunkIds.forEach((id, index) => {
      const taskIndex = state.tasks.findIndex((task) => task.id === id);
      const task = state.tasks[taskIndex];
      const undo = completion.undo.tasks[index];
      if (!task || !undo) throw new Error("Completion undo target missing");
      const restored = { ...task, status: undo.status };
      if (undo.latestAssessment.present)
        restored.latestAssessment = structuredClone(
          undo.latestAssessment.value,
        );
      else delete restored.latestAssessment;
      state.tasks[taskIndex] = restored;
    });
    state.events = state.events.slice(0, completion.undo.eventLength);
  }
  if (pending.journal.patch) reversePatch(state, pending.journal.patch);
  restorePresence(
    state,
    "scopeAssessment",
    pending.journal.gate.priorScopeAssessment,
  );
  return state;
}

function patchTargetsMatchInput(
  input: ReturnType<typeof extractionInput>,
  outcome: NormalizedPatch,
) {
  const ids = new Set(input.tasks.map((task) => task.id));
  return [...outcome.revise, ...outcome.archive, ...outcome.restore].every(
    (operation) => ids.has(operation.id),
  );
}

function sameContext(
  expected: readonly ObservationRef[],
  actual: readonly Observation[],
) {
  return (
    expected.length === actual.length &&
    expected.every((reference, index) =>
      sameRef(reference, {
        entryId: actual[index]?.id ?? "",
        messageHash: actual[index]?.hash ?? "",
        role: actual[index]?.role ?? "user",
      }),
    )
  );
}

const GATE_CHOICES = new Set(["changed", "unchanged", "uncertain"]);
const COMPLETION_CHOICES = new Set(["yes", "no", "uncertain"]);

function matchesNormalizedAssessment(
  assessment: Assessment,
  choices: ReadonlySet<string>,
) {
  const normalized = normalizedChoiceAssessment(
    assessment.rawChoice,
    assessment.confidence,
    assessment.probability,
    assessment.source,
    choices,
  );
  return !!normalized && sameJson(normalized, assessment);
}

function replayPending(
  finalState: HybridState,
  resolve: (entryId: string) => Observation | undefined,
  preceding: (entryId: string) => readonly Observation[],
) {
  const pending = finalState.pending;
  if (!pending) return true;
  const latest = canonicalObservation(pending.observation, resolve);
  if (!latest) return false;
  const context = [...preceding(latest.id)];
  if (
    !context.every((item) =>
      canonicalObservation(
        { entryId: item.id, messageHash: item.hash, role: item.role },
        resolve,
      ),
    ) ||
    !sameContext(pending.journal.gate.context, context)
  )
    return false;
  const state = reversePending(finalState);
  const gate = pending.journal.gate;
  if (originHash(state) !== gate.originHash) return false;
  const gateRequestValue = gateRequest(state, latest, context);
  if (requestHash(gateRequestValue) !== gate.requestHash) return false;
  if (
    !sameRef(gate.assessment.source, pending.observation) ||
    !matchesNormalizedAssessment(gate.assessment, GATE_CHOICES) ||
    (gate.priorScopeAssessment.present &&
      !matchesNormalizedAssessment(
        gate.priorScopeAssessment.value,
        GATE_CHOICES,
      ))
  )
    return false;
  let replayed = applyGate(state, gate.assessment);
  const decision = gateDecision(gate.assessment);
  const patch = pending.journal.patch;
  if (patch) {
    if (decision === "unchanged" || pending.phase !== "complete") return false;
    const input = extractionInput(replayed, latest, context);
    if (
      requestHash(input) !== patch.requestHash ||
      !patchTargetsMatchInput(input, patch.outcome) ||
      !sameJson(patchUndo(replayed, patch.outcome), patch.undo)
    )
      return false;
    replayed = applyPatch(replayed, patch.outcome);
  } else if (
    (decision === "unchanged" && pending.phase !== "complete") ||
    (decision !== "unchanged" && pending.phase !== "extract")
  )
    return false;
  if (pending.block.present) {
    if (pending.block.value === "completion-build") {
      if (pending.phase !== "complete") return false;
    } else if (pending.block.value === "event-capacity") {
      if (pending.phase !== "extract" && pending.phase !== "complete")
        return false;
      if (
        pending.phase === "extract" &&
        (patch || pending.journal.completions.length > 0)
      )
        return false;
    } else if (
      pending.phase !== "extract" ||
      patch ||
      pending.journal.completions.length > 0
    )
      return false;
  }
  if (pending.phase === "extract" && pending.journal.completions.length)
    return false;
  for (const [
    completionIndex,
    completion,
  ] of pending.journal.completions.entries()) {
    if (pending.phase !== "complete") return false;
    const accepted = new Set(
      acceptedCompletionIds({
        ...pending,
        journal: {
          ...pending.journal,
          completions: pending.journal.completions.slice(0, completionIndex),
        },
      }),
    );
    const remaining = replayed.tasks.filter(
      (task) => task.included && !accepted.has(task.id),
    );
    const focusCandidates =
      completionIndex === 0
        ? replayed.tasks.filter(
            (task) => task.included && task.status !== "done",
          )
        : [];
    const chunk = completionChunks(
      latest,
      remaining,
      context,
      focusCandidates,
    )[0];
    if (
      !chunk ||
      !sameJson(
        chunk.map((task) => task.id),
        completion.chunkIds,
      )
    )
      return false;
    const request = completionRequest(latest, chunk, context, focusCandidates);
    if (
      requestHash(request) !== completion.requestHash ||
      !sameJson(completionUndo(replayed, chunk), completion.undo)
    )
      return false;
    if (
      !completion.assessments.every(
        (assessment) =>
          sameRef(assessment.source, pending.observation) &&
          matchesNormalizedAssessment(assessment, COMPLETION_CHOICES),
      )
    )
      return false;
    const requiresFocus = focusCandidates.length > 0;
    if (requiresFocus !== !!completion.focus) return false;
    if (completion.focus) {
      const focus = completion.focus;
      const allowed = new Set([
        ...focusCandidates.map((candidate) => candidate.id),
        ...focusSpecialChoices,
      ]);
      if (
        !matchesNormalizedAssessment(focus.assessment, allowed) ||
        !sameRef(focus.assessment.source, pending.observation) ||
        !sameJson(
          optionalPresence(replayed.focusTaskId),
          focus.priorFocusTaskId,
        )
      )
        return false;
    }
    replayed = applyCompletionRecord(
      replayed,
      completion.chunkIds,
      completion.assessments,
    );
    if (completion.focus)
      replayed = applyFocusRecord(
        replayed,
        focusCandidates,
        completion.focus.assessment,
      );
  }
  return sameJson(replayCore(replayed), replayCore(finalState));
}

/**
 * Fail closed on malformed storage, missing canonical source, or journal whose
 * real gate/extraction/completion builders cannot reproduce its request hashes.
 */
export function restoreCheckpoint(
  data: unknown,
  sourceId: string,
  resolve: (entryId: string) => Observation | undefined,
  preceding: (entryId: string) => readonly Observation[],
): HybridState | undefined {
  try {
    if (
      !validCheckpoint(data) ||
      byteLength(data) > MAX_CHECKPOINT_BYTES ||
      data.state.sourceId !== sourceId ||
      !referencesResolve(data.state, resolve) ||
      !replayPending(data.state, resolve, preceding)
    )
      return;
    const state = structuredClone(data.state);
    if ((state as HybridState & { focusTaskId?: unknown }).focusTaskId === null)
      state.focusTaskId = undefined;
    return copyState(state);
  } catch {
    return;
  }
}

const MAX_STRICT_DATA_ARRAY_ITEMS = 8192;
const MAX_STRICT_DATA_OBJECT_KEYS = 64;
const MAX_STRICT_DATA_STRING_CODE_UNITS = MAX_CHECKPOINT_BYTES;
const MAX_STRICT_DATA_NODES = 100_000;
const MAX_STRICT_DATA_DEPTH = 64;
const STRICT_DATA_REJECTED = Symbol("strict-data-rejected");

/**
 * Copy only enumerable own data properties before staged-v11 validation. This
 * keeps legacy validators reusable without allowing input hooks to run first.
 */
function strictDetachedData(
  value: unknown,
  budget = { nodes: 0 },
  depth = 0,
): unknown | typeof STRICT_DATA_REJECTED {
  budget.nodes += 1;
  if (budget.nodes > MAX_STRICT_DATA_NODES || depth > MAX_STRICT_DATA_DEPTH)
    return STRICT_DATA_REJECTED;
  if (typeof value === "string")
    return value.length <= MAX_STRICT_DATA_STRING_CODE_UNITS
      ? value
      : STRICT_DATA_REJECTED;
  if (
    value === undefined ||
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (!value || typeof value !== "object") return STRICT_DATA_REJECTED;

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype)
      return STRICT_DATA_REJECTED;
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !length ||
      !("value" in length) ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0 ||
      length.value > MAX_STRICT_DATA_ARRAY_ITEMS
    )
      return STRICT_DATA_REJECTED;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length.value + 1 || !keys.includes("length"))
      return STRICT_DATA_REJECTED;
    const detached: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        return STRICT_DATA_REJECTED;
      const child = strictDetachedData(descriptor.value, budget, depth + 1);
      if (child === STRICT_DATA_REJECTED) return STRICT_DATA_REJECTED;
      detached.push(child);
    }
    return detached;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype)
    return STRICT_DATA_REJECTED;
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_STRICT_DATA_OBJECT_KEYS) return STRICT_DATA_REJECTED;
  const detached: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string") return STRICT_DATA_REJECTED;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      return STRICT_DATA_REJECTED;
    const child = strictDetachedData(descriptor.value, budget, depth + 1);
    if (child === STRICT_DATA_REJECTED) return STRICT_DATA_REJECTED;
    Object.defineProperty(detached, key, {
      value: child,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return detached;
}

/** Serialize detached staged data without consulting any caller serialization hook. */
function subtaskInertProjection(value: unknown): unknown {
  if (Array.isArray(value)) {
    const projection: unknown[] = [];
    for (let index = 0; index < value.length; index += 1)
      projection.push(subtaskInertProjection(value[index]));
    Object.defineProperty(projection, "toJSON", {
      value: undefined,
      enumerable: false,
    });
    return projection;
  }
  if (value && typeof value === "object") {
    const projection = Object.create(null) as Record<string, unknown>;
    for (const [key, child] of Object.entries(value))
      projection[key] = subtaskInertProjection(child);
    return projection;
  }
  return value;
}

function subtaskInertJson(value: object) {
  return JSON.stringify(subtaskInertProjection(value)) as string;
}

function subtaskByteLength(value: object) {
  return Buffer.byteLength(subtaskInertJson(value), "utf8");
}

function detachSubtaskData<T extends object>(value: T): T {
  return JSON.parse(subtaskInertJson(value)) as T;
}

function validSubtaskMonitorMetadata(
  value: unknown,
  state: HybridState,
): value is SubtaskMonitorCheckpointMetadata {
  if (
    !record(value) ||
    !exactKeys(
      value,
      ["enabled", "usage"],
      [
        "lastJevCallAt",
        "lastExtractionCallAt",
        "idleDoneTaskId",
        "healthCards",
        "taskDetails",
        "subtasks",
      ],
    ) ||
    typeof value.enabled !== "boolean" ||
    !record(value.usage) ||
    !exactKeys(value.usage, ["jev", "extraction"]) ||
    ![value.usage.jev, value.usage.extraction].every(
      (usage) =>
        record(usage) &&
        exactKeys(usage, ["calls", "inputTokens", "outputTokens"]) &&
        nonNegativeInteger(usage.calls) &&
        nonNegativeInteger(usage.inputTokens) &&
        nonNegativeInteger(usage.outputTokens),
    ) ||
    (Object.hasOwn(value, "lastJevCallAt") &&
      !nonNegativeInteger(value.lastJevCallAt)) ||
    (Object.hasOwn(value, "lastExtractionCallAt") &&
      !nonNegativeInteger(value.lastExtractionCallAt)) ||
    (Object.hasOwn(value, "idleDoneTaskId") &&
      !taskIdIsValid(value.idleDoneTaskId))
  )
    return false;

  if (Object.hasOwn(value, "subtasks")) {
    if (
      !record(value.subtasks) ||
      !exactKeys(value.subtasks, ["state", "journal"]) ||
      !subtaskCheckpointIsValid(value.subtasks.state) ||
      !subtaskJournalIsValid(value.subtasks.journal) ||
      subtaskByteLength(value.subtasks) > MAX_SUBTASK_OPTIONAL_BYTES
    )
      return false;
  }
  if (Object.hasOwn(value, "healthCards")) {
    if (
      !Array.isArray(value.healthCards) ||
      value.healthCards.length > MAX_TASKS ||
      !value.healthCards.every(validHealthCard) ||
      new Set(value.healthCards.map((card) => card.taskId)).size !==
        value.healthCards.length ||
      !value.healthCards.every((card) =>
        state.tasks.some((task) => task.id === card.taskId),
      )
    )
      return false;
  }
  if (
    Object.hasOwn(value, "taskDetails") &&
    (!Array.isArray(value.taskDetails) ||
      value.taskDetails.length > MAX_TASKS ||
      !value.taskDetails.every(validTaskDetailRecord) ||
      new Set(value.taskDetails.map((detail) => detail.taskId)).size !==
        value.taskDetails.length ||
      !value.taskDetails.every((detail) => {
        const task = state.tasks.find((item) => item.id === detail.taskId);
        return (
          !!task &&
          task.revision === detail.revision &&
          task.label === detail.label &&
          task.source.entryId === detail.taskSource.entryId &&
          task.source.messageHash === detail.taskSource.messageHash &&
          task.source.role === detail.taskSource.role &&
          task.source.start === detail.taskSource.start &&
          task.source.end === detail.taskSource.end &&
          task.source.quoteHash === detail.taskSource.quoteHash
        );
      }))
  )
    return false;
  return (
    !Object.hasOwn(value, "idleDoneTaskId") ||
    state.tasks.some(
      (task) =>
        task.id === value.idleDoneTaskId &&
        task.included &&
        task.status === "done",
    )
  );
}

function validSubtaskCheckpointEnvelope(
  value: unknown,
): value is SubtaskCheckpointEnvelope {
  return (
    record(value) &&
    exactKeys(value, ["version", "state"], ["monitor"]) &&
    value.version === SUBTASK_VERSION &&
    validState(value.state) &&
    (!Object.hasOwn(value, "monitor") ||
      validSubtaskMonitorMetadata(value.monitor, value.state))
  );
}

/** Read only validated strict-v11 metadata; never accepts a legacy envelope. */
export function subtaskMonitorCheckpointMetadata(
  data: unknown,
): SubtaskMonitorCheckpointMetadata | undefined {
  try {
    const detached = strictDetachedData(data);
    if (
      detached === STRICT_DATA_REJECTED ||
      !detached ||
      !validSubtaskCheckpointEnvelope(detached) ||
      !detached.monitor
    )
      return;
    return detachSubtaskData(detached.monitor);
  } catch {
    return;
  }
}

/** Staged v11 classification only. It intentionally has no legacy fallback. */
export function subtaskCheckpointStorageStatus(
  data: unknown,
): CheckpointStorageStatus {
  if (data === undefined) return "absent";
  try {
    const detached = strictDetachedData(data);
    if (detached === STRICT_DATA_REJECTED || !detached || !record(detached))
      return "corrupt";
    if (
      typeof detached.version === "number" &&
      detached.version !== SUBTASK_VERSION
    )
      return "unsupported";
    return validSubtaskCheckpointEnvelope(detached) &&
      subtaskByteLength(detached) <= MAX_CHECKPOINT_BYTES
      ? "supported"
      : "corrupt";
  } catch {
    return "corrupt";
  }
}

function stagedSubtaskCheckpoint(
  state: HybridState,
  monitor?: SubtaskMonitorCheckpointMetadata,
): SubtaskCheckpointEnvelope {
  const detachedState = strictDetachedData(state);
  const detachedMonitor =
    monitor === undefined ? undefined : strictDetachedData(monitor);
  if (
    detachedState === STRICT_DATA_REJECTED ||
    !validState(detachedState) ||
    (monitor !== undefined &&
      (detachedMonitor === STRICT_DATA_REJECTED ||
        !validSubtaskMonitorMetadata(detachedMonitor, detachedState)))
  )
    throw new Error("Invalid hybrid subtask checkpoint");

  const checkpoint: SubtaskCheckpointEnvelope = {
    version: SUBTASK_VERSION,
    state: checkpointState(detachedState),
    ...(monitor === undefined
      ? {}
      : { monitor: detachedMonitor as SubtaskMonitorCheckpointMetadata }),
  };
  if (!validSubtaskCheckpointEnvelope(checkpoint))
    throw new Error("Invalid hybrid subtask checkpoint");
  return checkpoint;
}

/** Exact v11 byte count before capacity denial; it never invokes v10 codecs. */
export function subtaskCheckpointBytes(
  state: HybridState,
  monitor?: SubtaskMonitorCheckpointMetadata,
) {
  return subtaskByteLength(stagedSubtaskCheckpoint(state, monitor));
}

/**
 * Encode strict v11 staged data without changing the active v10 codec or
 * reserving optional bytes when no optional projection is present.
 */
export function encodeSubtaskCheckpoint(
  state: HybridState,
  monitor?: SubtaskMonitorCheckpointMetadata,
): SubtaskCheckpointEnvelope {
  const checkpoint = stagedSubtaskCheckpoint(state, monitor);
  if (subtaskByteLength(checkpoint) > MAX_CHECKPOINT_BYTES)
    throw new Error("Hybrid subtask checkpoint exceeds v11 bounds");
  return detachSubtaskData(checkpoint);
}

/** [ref:subtask_independent_trigger] Currentness belongs to this restore candidate. */
export interface SubtaskRestoreContext {
  state: HybridState;
  group?: SubtaskGroupSnapshot;
}

type SubtaskJobCurrentness = (
  record: SubtaskPhaseRecord,
  candidate: SubtaskRestoreContext,
) => boolean;

function journalRecordIsCurrent(
  record: SubtaskPhaseRecord,
  state: HybridState,
  groups: ReadonlyMap<string, SubtaskGroupSnapshot>,
  resolve: (entryId: string) => Observation | undefined,
  isCurrentJob: SubtaskJobCurrentness | undefined,
) {
  const parent = state.tasks.find((task) => task.id === record.parentTaskId);
  if (!parent) return false;
  const acceptedProposal = record.proposal?.outcome === "accepted";
  const requiredListRevision = acceptedProposal
    ? record.proposal?.listRevision
    : record.listRevision;
  const group = groups.get(record.parentTaskId);
  const actualListRevision = group?.listRevision;
  const listRevisionIsCurrent = acceptedProposal
    ? actualListRevision !== undefined &&
      actualListRevision === requiredListRevision
    : (actualListRevision ?? 0) === requiredListRevision;
  if (
    !parent.included ||
    parent.revision !== record.parentRevision ||
    !canonicalSource(record.source, resolve) ||
    !listRevisionIsCurrent ||
    typeof isCurrentJob !== "function"
  )
    return false;
  try {
    return (
      isCurrentJob(
        detachSubtaskData(record),
        detachSubtaskData({ state, ...(group === undefined ? {} : { group }) }),
      ) === true
    );
  } catch {
    return false;
  }
}

/**
 * Restore v11 mandatory state exactly, then locally prune stale optional facts.
 * It never routes a v11 payload through the active v10 reader.
 */
export function restoreSubtaskCheckpoint(
  data: unknown,
  sourceId: string,
  resolve: (entryId: string) => Observation | undefined,
  preceding: (entryId: string) => readonly Observation[],
  isCurrentJob?: SubtaskJobCurrentness,
):
  | { state: HybridState; monitor?: SubtaskMonitorCheckpointMetadata }
  | undefined {
  try {
    const detached = strictDetachedData(data);
    if (
      detached === STRICT_DATA_REJECTED ||
      !detached ||
      !validSubtaskCheckpointEnvelope(detached) ||
      subtaskByteLength(detached) > MAX_CHECKPOINT_BYTES ||
      detached.state.sourceId !== sourceId ||
      !referencesResolve(detached.state, resolve) ||
      !replayPending(detached.state, resolve, preceding)
    )
      return;

    const state = detachSubtaskData(detached.state);
    if ((state as HybridState & { focusTaskId?: unknown }).focusTaskId === null)
      state.focusTaskId = undefined;
    const restoredState = copyState(state);
    if (!detached.monitor) return { state: restoredState };

    const monitor = detachSubtaskData(detached.monitor);
    if (monitor.subtasks) {
      const store = SubtaskStore.restore(monitor.subtasks.state, {
        parents: restoredState.tasks,
        sourceCurrent: (source) => !!canonicalSource(source, resolve),
      });
      if (!store) return;
      const groups = new Map(
        store.snapshot().groups.map((group) => [group.parentTaskId, group]),
      );
      const journal = restoreSubtaskJournal(
        monitor.subtasks.journal,
        (record) =>
          journalRecordIsCurrent(
            record,
            restoredState,
            groups,
            resolve,
            isCurrentJob,
          ),
      );
      if (!journal) return;
      monitor.subtasks = { state: store.checkpoint(), journal };
    }
    return { state: restoredState, monitor: detachSubtaskData(monitor) };
  } catch {
    return;
  }
}

/**
 * Persist one detached v11 candidate. Storage callback owns external atomicity;
 * this boundary never publishes a candidate when it returns false or throws.
 */
export function commitSubtaskCheckpoint(
  state: HybridState,
  monitor: SubtaskMonitorCheckpointMetadata | undefined,
  save: (candidate: SubtaskCheckpointEnvelope) => boolean,
): SubtaskCheckpointEnvelope | undefined {
  let candidate: SubtaskCheckpointEnvelope;
  try {
    candidate = encodeSubtaskCheckpoint(state, monitor);
  } catch {
    return;
  }
  if (typeof save !== "function") return;
  try {
    if (candidate.monitor?.enabled)
      encodeSubtaskCheckpoint(candidate.state, {
        ...candidate.monitor,
        enabled: false,
      });
    if (save(detachSubtaskData(candidate)) !== true) return;
    return detachSubtaskData(candidate);
  } catch {
    return;
  }
}
