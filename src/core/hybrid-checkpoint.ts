import { createHash } from "node:crypto";
import { completionRequest } from "../analysis/completion";
import { extractionInput } from "../analysis/extractor";
import { gateRequest } from "../analysis/gate";
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

const VERSION = 6;
const MAX_TASKS = 200;
const MAX_ACTIVE_TASKS = 20;
const MAX_EVENTS = 1000;
export const MAX_CHECKPOINT_BYTES = 512 * 1024;
const MAX_COMPLETIONS = 20;
const focusSpecialChoices = new Set(["none", "concurrent", "uncertain"]);

export interface MonitorCheckpointMetadata {
  enabled: boolean;
  usage: {
    jev: { calls: number; inputTokens: number; outputTokens: number };
    extraction: { calls: number; inputTokens: number; outputTokens: number };
  };
  lastJevCallAt?: number;
  lastExtractionCallAt?: number;
  card?: {
    taskId: string;
    revision: number;
    label: string;
    retained: boolean;
    replacementPending: boolean;
    assessedAt: number;
    health: {
      requirements: string;
      acceptance: string;
      newRedTest: string;
      redEvidence: string;
      implementation: string;
    };
  };
}

interface Checkpoint {
  version: typeof VERSION;
  state: HybridState;
  monitor?: MonitorCheckpointMetadata;
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
const hashIsValid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const taskIdIsValid = (value: unknown): value is string =>
  typeof value === "string" && /^task:[1-9]\d*$/.test(value);
const eventIdIsValid = (value: unknown): value is string =>
  typeof value === "string" && /^event:[1-9]\d*$/.test(value);
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

function validMonitorMetadata(
  value: unknown,
  state: HybridState,
): value is MonitorCheckpointMetadata {
  if (
    !record(value) ||
    !exactKeys(
      value,
      ["enabled", "usage"],
      ["lastJevCallAt", "lastExtractionCallAt", "card"],
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
      !nonNegativeInteger(value.lastExtractionCallAt))
  )
    return false;
  if (!Object.hasOwn(value, "card")) return true;
  const card = value.card;
  if (
    !record(card) ||
    !exactKeys(card, [
      "taskId",
      "revision",
      "label",
      "retained",
      "replacementPending",
      "assessedAt",
      "health",
    ]) ||
    !taskIdIsValid(card.taskId) ||
    !positiveInteger(card.revision) ||
    !safeLabel(card.label) ||
    typeof card.retained !== "boolean" ||
    typeof card.replacementPending !== "boolean" ||
    !nonNegativeInteger(card.assessedAt) ||
    !record(card.health) ||
    !exactKeys(card.health, [
      "requirements",
      "acceptance",
      "newRedTest",
      "redEvidence",
      "implementation",
    ]) ||
    !Object.values(card.health).every(safeHealthLabel)
  )
    return false;
  return state.tasks.some((task) => task.id === card.taskId);
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

/** Exact encoded bytes after strict v6 shape validation, before capacity denial. */
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
    throw new Error("Hybrid checkpoint exceeds v6 bounds");
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
