import { createHash } from "node:crypto";
import {
  completionProof,
  gateProof,
  patchProof,
  validCompletionResultHash,
  validRequestProofHash,
} from "./hybrid-proof";
import {
  type Assessment,
  copyState,
  type HybridState,
  type HybridTask,
  type MutationEvent,
  type Observation,
  type ObservationRef,
  type PendingObservation,
  type RequestProof,
  type SourceRef,
  type TaskProjection,
} from "./hybrid-state";

const VERSION = 5;
const MAX_TASKS = 200;
const MAX_ACTIVE_TASKS = 20;
const MAX_EVENTS = 1000;
const MAX_LABEL_CHARACTERS = 240;
const MAX_BYTES = 512 * 1024;

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
const roleIsValid = (value: unknown): value is "user" | "assistant" =>
  value === "user" || value === "assistant";
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
const safeLabel = (value: unknown) =>
  typeof value === "string" &&
  !!value.trim() &&
  Array.from(value).length <= MAX_LABEL_CHARACTERS &&
  !/[\p{Cc}\p{Cf}]/u.test(value);
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
  const { start, end } = value;
  return (
    typeof value.entryId === "string" &&
    !!value.entryId &&
    hashIsValid(value.messageHash) &&
    roleIsValid(value.role) &&
    Number.isSafeInteger(start) &&
    (start as number) >= 0 &&
    positiveInteger(end) &&
    (end as number) > (start as number) &&
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
    typeof value.rawChoice === "string" &&
    unit(value.confidence) &&
    unit(value.probability) &&
    (value.reason === "accepted" ||
      value.reason === "semantic-unknown" ||
      value.reason === "threshold-abstention") &&
    validObservationRef(value.source)
  );
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
    typeof value.label === "string" &&
    !!value.label.trim() &&
    Array.from(value.label).length <= MAX_LABEL_CHARACTERS &&
    (value.kind === "action" || value.kind === "response") &&
    (value.basis === "explicit" || value.basis === "derived") &&
    (value.status === "not-started" ||
      value.status === "reopened" ||
      value.status === "done") &&
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

function validTaskProjection(value: unknown): value is TaskProjection {
  return (
    record(value) &&
    exactKeys(
      value,
      ["id", "label", "kind", "basis", "status", "included", "revision"],
      ["source"],
    ) &&
    taskIdIsValid(value.id) &&
    safeLabel(value.label) &&
    (value.kind === "action" || value.kind === "response") &&
    (value.basis === "explicit" || value.basis === "derived") &&
    (value.status === "not-started" ||
      value.status === "reopened" ||
      value.status === "done") &&
    typeof value.included === "boolean" &&
    positiveInteger(value.revision) &&
    (!Object.hasOwn(value, "source") || validSourceRef(value.source))
  );
}

function validRequestProof(
  value: unknown,
  observation: Observation,
): value is RequestProof {
  return (
    record(value) &&
    exactKeys(value, [
      "phase",
      "requestHash",
      "inputHash",
      "context",
      "tasks",
    ]) &&
    (value.phase === "gate" ||
      value.phase === "patch" ||
      value.phase === "completion") &&
    hashIsValid(value.requestHash) &&
    hashIsValid(value.inputHash) &&
    Array.isArray(value.context) &&
    value.context.length <= 2 &&
    value.context.every(validObservationRef) &&
    Array.isArray(value.tasks) &&
    value.tasks.length <= MAX_ACTIVE_TASKS &&
    value.tasks.every(validTaskProjection) &&
    new Set(value.tasks.map((task) => task.id)).size === value.tasks.length &&
    validRequestProofHash(value as unknown as RequestProof, observation)
  );
}

function validPending(value: unknown): value is PendingObservation {
  return (
    record(value) &&
    exactKeys(
      value,
      ["observation", "phase", "completedTaskIds", "completionHashes"],
      ["gateHash", "patchHash", "proofs"],
    ) &&
    validObservationRef(value.observation) &&
    (value.phase === "extract" || value.phase === "complete") &&
    Array.isArray(value.completedTaskIds) &&
    value.completedTaskIds.every(taskIdIsValid) &&
    new Set(value.completedTaskIds).size === value.completedTaskIds.length &&
    Array.isArray(value.completionHashes) &&
    value.completionHashes.length <= MAX_EVENTS &&
    value.completionHashes.every(hashIsValid) &&
    (!Object.hasOwn(value, "gateHash") || hashIsValid(value.gateHash)) &&
    (!Object.hasOwn(value, "patchHash") || hashIsValid(value.patchHash)) &&
    (!Object.hasOwn(value, "proofs") ||
      (record(value.proofs) &&
        exactKeys(value.proofs, ["completions"], ["gate", "patch"]) &&
        Array.isArray(value.proofs.completions) &&
        value.proofs.completions.length <= MAX_EVENTS))
  );
}

const projectionMatchesTask = (projection: TaskProjection, task: HybridTask) =>
  projection.id === task.id &&
  projection.label === task.label &&
  projection.kind === task.kind &&
  projection.basis === task.basis &&
  projection.included === task.included &&
  projection.revision === task.revision &&
  JSON.stringify(projection.source) === JSON.stringify(task.source);

function validCompletionJournalProof(
  value: unknown,
  observation: Observation,
): boolean {
  if (
    !record(value) ||
    !exactKeys(value, [
      "phase",
      "requestHash",
      "inputHash",
      "context",
      "tasks",
      "taskIds",
      "resultHash",
      "results",
      "events",
    ]) ||
    value.phase !== "completion" ||
    !hashIsValid(value.requestHash) ||
    !hashIsValid(value.inputHash) ||
    !Array.isArray(value.context) ||
    value.context.length > 2 ||
    !value.context.every(validObservationRef) ||
    !Array.isArray(value.tasks) ||
    value.tasks.length > MAX_ACTIVE_TASKS ||
    !value.tasks.every(validTaskProjection) ||
    !Array.isArray(value.taskIds) ||
    !value.taskIds.every(taskIdIsValid) ||
    new Set(value.taskIds).size !== value.taskIds.length ||
    !hashIsValid(value.resultHash) ||
    !Array.isArray(value.results) ||
    !value.results.every(
      (result) =>
        record(result) &&
        exactKeys(result, ["taskId", "status", "assessment"]) &&
        taskIdIsValid(result.taskId) &&
        (result.status === "not-started" ||
          result.status === "reopened" ||
          result.status === "done") &&
        validAssessment(result.assessment),
    ) ||
    !Array.isArray(value.events) ||
    !value.events.every(validEvent)
  )
    return false;
  const proof =
    value as unknown as import("./hybrid-state").CompletionJournalProof;
  return (
    proof.taskIds.length === proof.tasks.length &&
    proof.taskIds.every((id, index) => id === proof.tasks[index]?.id) &&
    proof.results.length === proof.taskIds.length &&
    proof.results.every(
      (result, index) => result.taskId === proof.taskIds[index],
    ) &&
    validRequestProofHash(proof, observation) &&
    validCompletionResultHash(proof)
  );
}

function pendingProofsAreConsistent(state: HybridState) {
  const pending = state.pending;
  if (!pending) return true;
  const observation: Observation = {
    id: pending.observation.entryId,
    hash: pending.observation.messageHash,
    role: pending.observation.role,
    text: "",
  };
  const assessment = state.scopeAssessment;
  const unacceptedGate =
    pending.phase === "extract" &&
    !!state.scopeFailure &&
    !assessment &&
    !pending.gateHash;
  if (unacceptedGate)
    return (
      pending.completedTaskIds.length === 0 &&
      pending.completionHashes.length === 0 &&
      !pending.patchHash &&
      !pending.proofs
    );
  if (
    !assessment ||
    !pending.gateHash ||
    pending.gateHash !== gateProof(assessment) ||
    assessment.source.entryId !== pending.observation.entryId ||
    assessment.source.messageHash !== pending.observation.messageHash ||
    assessment.source.role !== pending.observation.role ||
    !pending.proofs?.gate ||
    pending.proofs.gate.phase !== "gate" ||
    !validRequestProof(pending.proofs.gate, observation)
  )
    return false;
  const requiresPatch = !(
    assessment.rawChoice === "unchanged" && assessment.reason === "accepted"
  );
  if (
    !requiresPatch &&
    pending.proofs.gate.tasks.some((projection) => {
      const task = state.tasks.find(
        (candidate) => candidate.id === projection.id,
      );
      return !task || !projectionMatchesTask(projection, task);
    })
  )
    return false;
  if (pending.phase === "extract")
    return (
      requiresPatch &&
      !pending.patchHash &&
      pending.completedTaskIds.length === 0 &&
      pending.completionHashes.length === 0 &&
      pending.proofs.completions.length === 0
    );
  if (requiresPatch) {
    if (
      !pending.patchHash ||
      pending.patchHash !== patchProof(state) ||
      !pending.proofs.patch ||
      pending.proofs.patch.phase !== "patch" ||
      !validRequestProof(pending.proofs.patch, observation)
    )
      return false;
  } else if (pending.patchHash || pending.proofs.patch) return false;
  if (
    !pending.proofs.completions.every((proof) =>
      validCompletionJournalProof(proof, observation),
    )
  )
    return false;
  const completedByProof = pending.proofs.completions.flatMap(
    (proof) => proof.taskIds,
  );
  if (
    completedByProof.length !== pending.completedTaskIds.length ||
    completedByProof.some((id, index) => id !== pending.completedTaskIds[index])
  )
    return false;
  for (const proof of pending.proofs.completions) {
    if (
      proof.tasks.some((projection) => {
        const task = state.tasks.find(
          (candidate) => candidate.id === projection.id,
        );
        return !task || !projectionMatchesTask(projection, task);
      }) ||
      proof.events.some(
        (proofEvent) =>
          !state.events.some(
            (event) => JSON.stringify(event) === JSON.stringify(proofEvent),
          ),
      )
    )
      return false;
    for (const result of proof.results) {
      const task = state.tasks.find(
        (candidate) => candidate.id === result.taskId,
      );
      if (
        !task ||
        task.status !== result.status ||
        JSON.stringify(task.latestAssessment) !==
          JSON.stringify(result.assessment)
      )
        return false;
    }
  }
  if (pending.completedTaskIds.length !== pending.completionHashes.length)
    return false;
  return pending.completedTaskIds.every((id, index) => {
    const task = state.tasks.find((candidate) => candidate.id === id);
    return (
      !!task &&
      !!task.latestAssessment &&
      task.latestAssessment.source.entryId === pending.observation.entryId &&
      task.latestAssessment.source.messageHash ===
        pending.observation.messageHash &&
      task.latestAssessment.source.role === pending.observation.role &&
      pending.completionHashes[index] ===
        completionProof(task, {
          id: pending.observation.entryId,
          hash: pending.observation.messageHash,
          role: pending.observation.role,
        })
    );
  });
}

function validCursor(value: unknown): value is { id: string; hash: string } {
  return (
    record(value) &&
    exactKeys(value, ["id", "hash"]) &&
    typeof value.id === "string" &&
    !!value.id &&
    hashIsValid(value.hash)
  );
}

function validState(value: unknown): value is HybridState {
  if (
    !record(value) ||
    !exactKeys(
      value,
      ["sourceId", "tasks", "events", "nextTaskId", "scopeUnresolved"],
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
  if (taskIds.size !== state.tasks.length) return false;
  if (!pendingProofsAreConsistent(state)) return false;
  if (state.tasks.filter((task) => task.included).length > MAX_ACTIVE_TASKS)
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
  if (typeof state.focusTaskId === "string" && !taskIds.has(state.focusTaskId))
    return false;
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
    ((state.pending.phase === "extract" &&
      (state.pending.completedTaskIds.length > 0 ||
        state.pending.completionHashes.length > 0)) ||
      state.pending.completionHashes.length >
        state.pending.completedTaskIds.length ||
      state.pending.completedTaskIds.some((id) => !taskIds.has(id)) ||
      (state.cursor &&
        state.cursor.id === state.pending.observation.entryId &&
        state.cursor.hash === state.pending.observation.messageHash))
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

function canonicalObservation(
  reference: ObservationRef,
  resolve: (entryId: string) => Observation | undefined,
) {
  const observation = resolve(reference.entryId);
  return observation &&
    observation.id === reference.entryId &&
    observation.role === reference.role &&
    observation.hash === reference.messageHash &&
    hash(observation.text) === observation.hash
    ? observation
    : undefined;
}

function canonicalSource(
  source: SourceRef,
  resolve: (entryId: string) => Observation | undefined,
) {
  const observation = canonicalObservation(source, resolve);
  return (
    observation &&
    source.end <= observation.text.length &&
    hash(observation.text.slice(source.start, source.end)) === source.quoteHash
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
    !canonicalObservation(state.scopeAssessment.source, resolve)
  )
    return false;
  if (
    state.pending &&
    !canonicalObservation(state.pending.observation, resolve)
  )
    return false;
  if (
    state.pending?.proofs &&
    [
      state.pending.proofs.gate,
      state.pending.proofs.patch,
      ...state.pending.proofs.completions,
    ].some(
      (proof) =>
        !!proof &&
        proof.context.some(
          (reference) => !canonicalObservation(reference, resolve),
        ),
    )
  )
    return false;
  if (state.cursor) {
    const observation = resolve(state.cursor.id);
    if (
      !observation ||
      observation.id !== state.cursor.id ||
      observation.hash !== state.cursor.hash ||
      hash(observation.text) !== observation.hash
    )
      return false;
  }
  return true;
}

function checkpointState(state: HybridState): HybridState {
  const snapshot = copyState(state);
  if (
    Object.hasOwn(snapshot, "focusTaskId") &&
    snapshot.focusTaskId === undefined
  )
    (snapshot as unknown as { focusTaskId: null }).focusTaskId = null;
  return snapshot;
}

/** Encode only bounded derived state; source text and provider envelopes never persist. */
export function encodeCheckpoint(
  state: HybridState,
  monitor?: MonitorCheckpointMetadata,
): Checkpoint {
  if (!validState(state)) throw new Error("Invalid hybrid checkpoint state");
  const checkpoint: Checkpoint = {
    version: VERSION,
    state: checkpointState(state),
    ...(monitor ? { monitor } : {}),
  };
  if (!validCheckpoint(checkpoint) || byteLength(checkpoint) > MAX_BYTES)
    throw new Error("Hybrid checkpoint exceeds v5 bounds");
  return JSON.parse(JSON.stringify(checkpoint)) as Checkpoint;
}

/** Read only validated monitor-owned metadata; unknown checkpoint fields fail closed. */
export function monitorCheckpointMetadata(
  data: unknown,
): MonitorCheckpointMetadata | undefined {
  if (!validCheckpoint(data) || !data.monitor) return;
  return JSON.parse(JSON.stringify(data.monitor)) as MonitorCheckpointMetadata;
}

/** Fail closed on malformed storage or references absent from canonical active history. */
export function restoreCheckpoint(
  data: unknown,
  sourceId: string,
  resolve: (entryId: string) => Observation | undefined,
): HybridState | undefined {
  try {
    if (
      !validCheckpoint(data) ||
      byteLength(data) > MAX_BYTES ||
      data.state.sourceId !== sourceId ||
      !referencesResolve(data.state, resolve)
    )
      return;
    const state = JSON.parse(JSON.stringify(data.state)) as HybridState;
    if ((state as HybridState & { focusTaskId?: unknown }).focusTaskId === null)
      state.focusTaskId = undefined;
    return copyState(state);
  } catch {
    return;
  }
}
