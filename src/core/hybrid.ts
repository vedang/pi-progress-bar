import {
  completionDecisions,
  completionRequest,
  focusAssessment,
  focusSpecialChoices,
} from "../analysis/completion";
import {
  type ExtractionInput,
  ExtractionInputOverflowError,
  extractionInput,
  groundPatch,
  parsePatch,
} from "../analysis/extractor";
import {
  GateRequestOverflowError,
  gateRequest,
  gateResult,
} from "../analysis/gate";
import type { EvaluationRequest, ValidatedResult } from "../analysis/gateway";
import {
  absent,
  completionStatus,
  gateDecision,
  optionalPresence,
  originHash,
  present,
  requestHash,
} from "./hybrid-proof";
import {
  type Assessment,
  type CompletionRecord,
  copyState,
  type GateRecord,
  type HybridState,
  type HybridTask,
  type MutationEvent,
  type NormalizedPatch,
  type Observation,
  type ObservationRef,
  observationRef,
  type PatchRecord,
  type PatchUndo,
  type PendingBlock,
  type PendingObservation,
  type ScopeFailure,
} from "./hybrid-state";

const MAX_ACTIVE_TASKS = 20;
const MAX_TOTAL_TASKS = 200;
const MAX_EVENTS = 1000;
const MAX_LATEST_MESSAGE_BYTES = 12 * 1024;
const MAX_SCHEMA_LABEL_BYTES = 2 + 6 * 240;
const MAX_SAFE_JSON_INTEGER_BYTES = 16;
const MAX_UNIT_JSON_BYTES = 24;
const MAX_HASH_JSON_BYTES = 66;
const MAX_BOOLEAN_JSON_BYTES = 5;

type AdmissionPhase = "gate" | "extraction" | "completion";

/**
 * Exact candidate state for one paid phase plus any conservative schema
 * supplement that cannot be represented as one lifecycle-legal candidate.
 */
export interface AdmissionPlan {
  phase: AdmissionPhase;
  candidate: HybridState;
  request: EvaluationRequest | ExtractionInput;
  schemaBytes: number;
}

/** Transport failed before a semantic result; retain accepted journal for explicit wake. */
export class RetryableProviderError extends Error {
  constructor() {
    super("Provider transport unavailable");
    this.name = "RetryableProviderError";
  }
}

/** Snapshot must encode before monitor may accept an in-memory transaction. */
export class DurabilityCapacityError extends Error {
  constructor() {
    super("Hybrid checkpoint exceeds durable capacity");
    this.name = "DurabilityCapacityError";
  }
}

export interface HybridProviders {
  evaluate(request: EvaluationRequest): Promise<ValidatedResult>;
  extract(input: ReturnType<typeof extractionInput>): Promise<string>;
  /** Required synchronous capacity authority before any provider dispatch. */
  admit?(plan: AdmissionPlan): boolean;
  /** Durably writes immutable snapshots after every accepted transaction phase. */
  save?(state: HybridState): void;
}

const validObservation = (observation: Observation) =>
  !!observation.id &&
  (observation.role === "user" ||
    observation.role === "assistant" ||
    observation.role === "intercom") &&
  typeof observation.text === "string" &&
  /^[a-f0-9]{64}$/.test(observation.hash);

const openTasks = (state: HybridState) =>
  state.tasks.filter((task) => task.included && task.status !== "done");

/** Focus is a Jev judgment, never a first-open display heuristic. */
const retainedFocusTaskId = (state: HybridState) => {
  const task = state.tasks.find(
    (candidate) => candidate.id === state.focusTaskId,
  );
  return task?.included && task.status !== "done" ? task.id : undefined;
};

const sameObservation = (reference: ObservationRef, observation: Observation) =>
  reference.entryId === observation.id &&
  reference.messageHash === observation.hash &&
  reference.role === observation.role;

const sourceRef = (source: ObservationRef): ObservationRef => ({
  entryId: source.entryId,
  messageHash: source.messageHash,
  role: source.role,
});

class ScopeRejection extends Error {
  constructor(
    readonly failure: ScopeFailure,
    message: string,
  ) {
    super(message);
    this.name = "ScopeRejection";
  }
}

function saveAccepted(state: HybridState, providers: HybridProviders) {
  providers.save?.(copyState(state));
}

function clearTransientErrors(state: HybridState): HybridState {
  const {
    scopeError: _scopeError,
    scopeFailure: _scopeFailure,
    completionError: _completionError,
    ...next
  } = state;
  return next;
}

function completeTransaction(state: HybridState, observation: Observation) {
  const { pending: _pending, ...committed } = state;
  return {
    ...committed,
    capacity: "clear" as const,
    cursor: {
      id: observation.id,
      hash: observation.hash,
      role: observation.role,
    },
    focusTaskId: retainedFocusTaskId(committed),
  };
}

function validateLifecyclePatch(state: HybridState, patch: NormalizedPatch) {
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  const task = (id: string) => {
    const current = tasks.get(id);
    if (!current)
      throw new ScopeRejection("invalid", "Extraction target does not exist");
    return current;
  };
  for (const operation of patch.revise) {
    if (!task(operation.id).included)
      throw new Error("Cannot revise an archived task");
  }
  for (const operation of patch.archive) {
    if (!task(operation.id).included)
      throw new Error("Cannot archive an archived task");
  }
  for (const operation of patch.restore) {
    if (task(operation.id).included)
      throw new Error("Cannot restore an active task");
  }
  if (state.tasks.length + patch.add.length > MAX_TOTAL_TASKS)
    throw new ScopeRejection("capacity", "Task ledger exceeds 200 total tasks");
  if (state.nextTaskId > Number.MAX_SAFE_INTEGER - patch.add.length)
    throw new ScopeRejection(
      "capacity",
      "Task ID capacity exceeds safe integer",
    );
  if (
    [...patch.revise, ...patch.restore].some((operation) => {
      const current = task(operation.id);
      return (
        operation.requirementsChanged &&
        current.revision === Number.MAX_SAFE_INTEGER
      );
    })
  )
    throw new ScopeRejection(
      "capacity",
      "Task revision capacity exceeds safe integer",
    );
  const active =
    state.tasks.filter((task) => task.included).length +
    patch.add.length -
    patch.archive.length +
    patch.restore.length;
  if (active > MAX_ACTIVE_TASKS)
    throw new ScopeRejection("capacity", "Task ledger exceeds 20 active tasks");
  const mutations =
    patch.add.length +
    patch.revise.length +
    patch.archive.length +
    patch.restore.length;
  if (state.events.length + mutations > MAX_EVENTS)
    throw new ScopeRejection(
      "capacity",
      "Task mutation event capacity exceeds 1000",
    );
}

const normalizedPatch = (
  patch: ReturnType<typeof groundPatch>,
): NormalizedPatch => ({
  add: patch.add.map(({ label, kind, basis, source }) => ({
    label,
    kind,
    basis,
    source,
  })),
  revise: patch.revise.map(({ id, label, requirementsChanged, source }) => ({
    id,
    label,
    requirementsChanged,
    source,
  })),
  archive: patch.archive.map(({ id, source }) => ({ id, source })),
  restore: patch.restore.map(({ id, label, requirementsChanged, source }) => ({
    id,
    label,
    requirementsChanged,
    source,
  })),
  unresolved: patch.unresolved,
});

/** Exact pre-reducer fields; journal never copies full task/event projections. */
export function patchUndo(
  state: HybridState,
  outcome: NormalizedPatch,
): PatchUndo {
  const at = (id: string) => {
    const index = state.tasks.findIndex((task) => task.id === id);
    const task = state.tasks[index];
    if (!task || index < 0) throw new Error("Extraction target does not exist");
    return { index, task };
  };
  return {
    revise: outcome.revise.map((operation) => {
      const { index, task } = at(operation.id);
      return {
        index,
        label: task.label,
        status: task.status,
        revision: task.revision,
        source: structuredClone(task.source),
      };
    }),
    archive: outcome.archive.map((operation) => {
      const { index, task } = at(operation.id);
      return { index, included: task.included };
    }),
    restore: outcome.restore.map((operation) => {
      const { index, task } = at(operation.id);
      return {
        index,
        label: task.label,
        status: task.status,
        included: task.included,
        revision: task.revision,
        source: structuredClone(task.source),
      };
    }),
    nextTaskId: state.nextTaskId,
    focusTaskId: optionalPresence(state.focusTaskId),
    scopeUnresolved: state.scopeUnresolved,
    eventLength: state.events.length,
  };
}

const event = (
  state: HybridState,
  kind: MutationEvent["kind"],
  taskId: string,
  revision: number,
  source: ObservationRef,
): MutationEvent => ({
  id: `event:${state.events.length + 1}`,
  kind,
  taskId,
  revision,
  source,
});

/** Shared pure patch reducer for live work and restore replay. */
export function applyPatch(
  state: HybridState,
  outcome: NormalizedPatch,
): HybridState {
  validateLifecyclePatch(state, outcome);
  const revisions = new Map(
    outcome.revise.map((operation) => [operation.id, operation]),
  );
  const archives = new Map(
    outcome.archive.map((operation) => [operation.id, operation]),
  );
  const restores = new Map(
    outcome.restore.map((operation) => [operation.id, operation]),
  );
  const tasks = state.tasks.map((task) => {
    const revise = revisions.get(task.id);
    if (revise)
      return {
        ...task,
        label: revise.label,
        revision: revise.requirementsChanged
          ? task.revision + 1
          : task.revision,
        status: revise.requirementsChanged
          ? ("not-started" as const)
          : task.status,
        source: structuredClone(revise.source),
      };
    if (archives.has(task.id)) return { ...task, included: false };
    const restore = restores.get(task.id);
    if (restore)
      return {
        ...task,
        label: restore.label,
        included: true,
        revision: restore.requirementsChanged
          ? task.revision + 1
          : task.revision,
        status: restore.requirementsChanged
          ? ("not-started" as const)
          : task.status,
        source: structuredClone(restore.source),
      };
    return structuredClone(task);
  });
  const additions: HybridTask[] = outcome.add.map((addition, index) => ({
    id: `task:${state.nextTaskId + index}`,
    label: addition.label,
    kind: addition.kind,
    basis: addition.basis,
    status: "not-started",
    included: true,
    revision: 1,
    source: structuredClone(addition.source),
  }));
  let next: HybridState = {
    ...state,
    tasks: [...tasks, ...additions],
    nextTaskId: state.nextTaskId + additions.length,
    scopeUnresolved: outcome.unresolved,
  };
  const events = [
    ...outcome.add.map((addition, index) =>
      event(
        next,
        "create",
        `task:${state.nextTaskId + index}`,
        1,
        sourceRef(addition.source),
      ),
    ),
    ...outcome.revise.map((operation) => {
      const prior = state.tasks.find((task) => task.id === operation.id);
      if (!prior) throw new Error("Extraction target does not exist");
      return event(
        next,
        "revise",
        operation.id,
        operation.requirementsChanged ? prior.revision + 1 : prior.revision,
        sourceRef(operation.source),
      );
    }),
    ...outcome.archive.map((operation) => {
      const prior = state.tasks.find((task) => task.id === operation.id);
      if (!prior) throw new Error("Extraction target does not exist");
      return event(
        next,
        "archive",
        operation.id,
        prior.revision,
        sourceRef(operation.source),
      );
    }),
    ...outcome.restore.map((operation) => {
      const prior = state.tasks.find((task) => task.id === operation.id);
      if (!prior) throw new Error("Extraction target does not exist");
      return event(
        next,
        "restore",
        operation.id,
        operation.requirementsChanged ? prior.revision + 1 : prior.revision,
        sourceRef(operation.source),
      );
    }),
  ];
  next = {
    ...next,
    events: [
      ...state.events,
      ...events.map((item, index) => ({
        ...item,
        id: `event:${state.events.length + index + 1}`,
      })),
    ],
  };
  // Scope patches never claim current activity. Preserve only an existing
  // open semantic focus; additions/restores must await the combined Jev answer.
  return { ...next, focusTaskId: retainedFocusTaskId(next) };
}

/** Shared pure gate reducer; journal records outcome separately. */
export function applyGate(
  state: HybridState,
  assessment: Assessment,
): HybridState {
  return { ...state, scopeAssessment: structuredClone(assessment) };
}

/** Completion chunks are production selection order and replay authority. */
export function completionChunks(
  observation: Observation,
  tasks: readonly HybridTask[],
  preceding: readonly Observation[],
  focusCandidates: readonly HybridTask[] = [],
): HybridTask[][] {
  const chunks: HybridTask[][] = [];
  let current: HybridTask[] = [];
  for (const task of tasks) {
    try {
      completionRequest(
        observation,
        [...current, task],
        preceding,
        chunks.length === 0 ? focusCandidates : [],
      );
      current.push(task);
    } catch (error) {
      if (!current.length) throw error;
      chunks.push(current);
      current = [task];
      completionRequest(observation, current, preceding);
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export function completionUndo(
  state: HybridState,
  tasks: readonly HybridTask[],
): CompletionRecord["undo"] {
  return {
    tasks: tasks.map((task) => ({
      status: task.status,
      latestAssessment: optionalPresence(task.latestAssessment),
    })),
    eventLength: state.events.length,
  };
}

/** Shared pure completion reducer; statuses derive only from normalized assessments. */
export function applyCompletionRecord(
  state: HybridState,
  chunkIds: readonly string[],
  assessments: readonly Assessment[],
): HybridState {
  if (chunkIds.length !== assessments.length)
    throw new Error("Completion cardinality mismatch");
  const byId = new Map(
    chunkIds.map((id, index) => [id, assessments[index]] as const),
  );
  const events: MutationEvent[] = [];
  const tasks = state.tasks.map((task) => {
    const assessment = byId.get(task.id);
    if (!assessment) return structuredClone(task);
    const status = completionStatus(task.status, assessment);
    if (status !== task.status)
      events.push(
        event(
          { ...state, events: [...state.events, ...events] },
          task.status === "done" ? "withdraw" : "complete",
          task.id,
          task.revision,
          sourceRef(assessment.source),
        ),
      );
    return { ...task, status, latestAssessment: structuredClone(assessment) };
  });
  if (state.events.length + events.length > MAX_EVENTS)
    throw new ScopeRejection(
      "capacity",
      "Task mutation event capacity exceeds 1000",
    );
  const next = {
    ...state,
    tasks,
    events: [
      ...state.events,
      ...events.map((item, index) => ({
        ...item,
        id: `event:${state.events.length + index + 1}`,
      })),
    ],
  };
  // A later completion chunk may settle the task selected in first chunk.
  return { ...next, focusTaskId: retainedFocusTaskId(next) };
}

/** Apply one first-chunk current-activity assessment after completion. */
export function applyFocusRecord(
  state: HybridState,
  candidates: readonly HybridTask[],
  assessment: Assessment,
): HybridState {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const selected =
    assessment.reason === "accepted" &&
    !focusSpecialChoices.has(assessment.rawChoice) &&
    candidateIds.has(assessment.rawChoice)
      ? state.tasks.find(
          (task) =>
            task.id === assessment.rawChoice &&
            task.included &&
            task.status !== "done",
        )?.id
      : undefined;
  return { ...state, focusTaskId: selected };
}

export const acceptedCompletionIds = (
  pending: PendingObservation | undefined,
) => pending?.journal.completions.flatMap((record) => record.chunkIds) ?? [];

function pending(
  observation: Observation,
  phase: PendingObservation["phase"],
  gate: GateRecord,
  patch?: PatchRecord,
  completions: CompletionRecord[] = [],
  block = absent<PendingBlock>(),
): PendingObservation {
  return {
    observation: observationRef(observation),
    phase,
    block,
    journal: {
      gate: structuredClone(gate),
      ...(patch ? { patch: structuredClone(patch) } : {}),
      completions: structuredClone(completions),
    },
  };
}

function blockPending(
  state: HybridState,
  block: PendingBlock,
  failure: ScopeFailure,
  capacityLimited = false,
): HybridState {
  const current = state.pending;
  if (!current)
    throw new Error("Accepted gate journal is required before block");
  return {
    ...state,
    ...(capacityLimited ? { capacity: "limit" as const } : {}),
    pending: {
      ...current,
      block: present(block),
    },
    scopeFailure: failure,
  };
}

function capacityLimited(state: HybridState): HybridState {
  return { ...state, capacity: "limit" };
}

function admissionAllowed(providers: HybridProviders, plan: AdmissionPlan) {
  return typeof providers.admit === "function" && providers.admit(plan);
}

/** Serializer algebra for upper-bound occurrence accounting. */
const jsonBytes = (value: string) => Buffer.byteLength(JSON.stringify(value));
const digits = (value: number) => Buffer.byteLength(String(value));
const fieldBytes = (key: string, value: number) =>
  1 + jsonBytes(key) + 1 + value;
const objectBytes = (fields: readonly [string, number][]) =>
  2 + fields.reduce((total, [key, value]) => total + fieldBytes(key, value), 0);
const arrayBytes = (values: readonly number[]) =>
  2 + values.reduce((total, value) => total + 1 + value, 0);
const longest = (values: readonly number[]) => Math.max(0, ...values);
const MAX_REASON_JSON_BYTES = longest(
  ["accepted", "semantic-unknown", "threshold-abstention"].map(jsonBytes),
);

/** Exact observation-derived maximum for a source span produced this phase. */
function sourceSchemaBytes(observation: Observation) {
  const offset = digits(Math.max(1, observation.text.length));
  return objectBytes([
    ["entryId", jsonBytes(observation.id)],
    ["messageHash", MAX_HASH_JSON_BYTES],
    ["role", jsonBytes(observation.role)],
    ["start", offset],
    ["end", offset],
    ["quoteHash", MAX_HASH_JSON_BYTES],
  ]);
}

function observationRefSchemaBytes(observation: Observation) {
  return objectBytes([
    ["entryId", jsonBytes(observation.id)],
    ["messageHash", MAX_HASH_JSON_BYTES],
    ["role", jsonBytes(observation.role)],
  ]);
}

function assessmentSchemaBytes(
  observation: Observation,
  rawChoiceBytes: number,
) {
  return objectBytes([
    ["rawChoice", rawChoiceBytes],
    ["confidence", MAX_UNIT_JSON_BYTES],
    ["probability", MAX_UNIT_JSON_BYTES],
    ["reason", MAX_REASON_JSON_BYTES],
    ["source", observationRefSchemaBytes(observation)],
  ]);
}

function taskSchemaBytes(idBytes: number, sourceBytes: number, assessment = 0) {
  return objectBytes([
    ["id", idBytes],
    ["label", MAX_SCHEMA_LABEL_BYTES],
    ["kind", jsonBytes("response")],
    ["basis", jsonBytes("explicit")],
    ["status", jsonBytes("not-started")],
    ["included", MAX_BOOLEAN_JSON_BYTES],
    ["revision", MAX_SAFE_JSON_INTEGER_BYTES],
    ["source", sourceBytes],
    ...(assessment
      ? [["latestAssessment", assessment] as [string, number]]
      : []),
  ]);
}

function eventSchemaBytes(
  idBytes: number,
  taskIdBytes: number,
  observation: Observation,
) {
  return objectBytes([
    ["id", idBytes],
    ["kind", jsonBytes("withdraw")],
    ["taskId", taskIdBytes],
    ["revision", MAX_SAFE_JSON_INTEGER_BYTES],
    ["source", observationRefSchemaBytes(observation)],
  ]);
}

function largestTaskIdBytes(tasks: readonly HybridTask[], nextTaskId: number) {
  return longest([
    jsonBytes(`task:${nextTaskId}`),
    ...tasks.map((task) => jsonBytes(task.id)),
  ]);
}

function largestEventIdBytes(state: HybridState) {
  return jsonBytes(
    `event:${Math.min(Number.MAX_SAFE_INTEGER, state.events.length + 42)}`,
  );
}

function presenceSchemaBytes(valueBytes: number) {
  return objectBytes([
    ["present", MAX_BOOLEAN_JSON_BYTES],
    ["value", valueBytes],
  ]);
}

function fixedBlockSchemaBytes() {
  return (
    fieldBytes("scopeFailure", jsonBytes("capacity")) +
    fieldBytes(
      "scopeError",
      jsonBytes("Task mutation event capacity exceeds 1000"),
    ) +
    fieldBytes(
      "completionError",
      jsonBytes("Completion request exceeds 24KiB"),
    ) +
    fieldBytes("block", presenceSchemaBytes(jsonBytes("completion-build")))
  );
}

function gateAdmissionPlan(
  state: HybridState,
  observation: Observation,
  context: readonly Observation[],
  request: EvaluationRequest,
): AdmissionPlan {
  const rawChoice = longest(
    ["changed", "unchanged", "uncertain"].map(jsonBytes),
  );
  const assessment = assessmentSchemaBytes(observation, rawChoice);
  const cursor = objectBytes([
    ["id", jsonBytes(observation.id)],
    ["hash", MAX_HASH_JSON_BYTES],
    ["role", jsonBytes(observation.role)],
  ]);
  // Base remains exact current state. Two independent persisted assessment
  // copies and all phase-final/block fields are counted without a sampled one.
  return {
    phase: "gate",
    candidate: copyState(state),
    request,
    schemaBytes:
      2 * assessment +
      fieldBytes("cursor", cursor) +
      fixedBlockSchemaBytes() +
      fieldBytes(
        "pending",
        objectBytes([
          ["observation", observationRefSchemaBytes(observation)],
          ["phase", jsonBytes("extract")],
          ["block", presenceSchemaBytes(jsonBytes("completion-build"))],
          [
            "journal",
            objectBytes([
              [
                "gate",
                objectBytes([
                  ["originHash", MAX_HASH_JSON_BYTES],
                  ["requestHash", MAX_HASH_JSON_BYTES],
                  [
                    "context",
                    arrayBytes(context.map(observationRefSchemaBytes)),
                  ],
                  ["assessment", assessment],
                  ["priorScopeAssessment", presenceSchemaBytes(assessment)],
                ]),
              ],
              ["completions", arrayBytes([])],
            ]),
          ],
        ]),
      ),
  };
}

function patchSchemaBytes(state: HybridState, observation: Observation) {
  const active = state.tasks.filter((task) => task.included);
  const archived = state.tasks.filter((task) => !task.included);
  const adds = Math.min(
    6,
    MAX_TOTAL_TASKS - state.tasks.length,
    Math.max(MAX_ACTIVE_TASKS - active.length, Math.min(active.length, 6)),
    Number.MAX_SAFE_INTEGER - state.nextTaskId,
  );
  const revises = Math.min(12, active.length);
  const archives = Math.min(12, active.length);
  const restores = Math.min(12, archived.length);
  const source = sourceSchemaBytes(observation);
  const id = largestTaskIdBytes(state.tasks, state.nextTaskId + adds);
  const eventId = largestEventIdBytes(state);
  const event = eventSchemaBytes(eventId, id, observation);
  const add = objectBytes([
    ["label", MAX_SCHEMA_LABEL_BYTES],
    ["kind", jsonBytes("response")],
    ["basis", jsonBytes("explicit")],
    ["source", source],
  ]);
  const revise = objectBytes([
    ["id", id],
    ["label", MAX_SCHEMA_LABEL_BYTES],
    ["requirementsChanged", MAX_BOOLEAN_JSON_BYTES],
    ["source", source],
  ]);
  const archive = objectBytes([
    ["id", id],
    ["source", source],
  ]);
  const restore = revise;
  const reviseUndo = objectBytes([
    ["index", MAX_SAFE_JSON_INTEGER_BYTES],
    ["label", MAX_SCHEMA_LABEL_BYTES],
    ["status", jsonBytes("not-started")],
    ["revision", MAX_SAFE_JSON_INTEGER_BYTES],
    ["source", source],
  ]);
  const archiveUndo = objectBytes([
    ["index", MAX_SAFE_JSON_INTEGER_BYTES],
    ["included", MAX_BOOLEAN_JSON_BYTES],
  ]);
  const restoreUndo = objectBytes([
    ["index", MAX_SAFE_JSON_INTEGER_BYTES],
    ["label", MAX_SCHEMA_LABEL_BYTES],
    ["status", jsonBytes("not-started")],
    ["included", MAX_BOOLEAN_JSON_BYTES],
    ["revision", MAX_SAFE_JSON_INTEGER_BYTES],
    ["source", source],
  ]);
  const outcome = objectBytes([
    ["add", arrayBytes(Array.from({ length: adds }, () => add))],
    ["revise", arrayBytes(Array.from({ length: revises }, () => revise))],
    ["archive", arrayBytes(Array.from({ length: archives }, () => archive))],
    ["restore", arrayBytes(Array.from({ length: restores }, () => restore))],
    ["unresolved", MAX_BOOLEAN_JSON_BYTES],
  ]);
  const undo = objectBytes([
    ["revise", arrayBytes(Array.from({ length: revises }, () => reviseUndo))],
    [
      "archive",
      arrayBytes(Array.from({ length: archives }, () => archiveUndo)),
    ],
    [
      "restore",
      arrayBytes(Array.from({ length: restores }, () => restoreUndo)),
    ],
    ["nextTaskId", MAX_SAFE_JSON_INTEGER_BYTES],
    ["focusTaskId", presenceSchemaBytes(id)],
    ["scopeUnresolved", MAX_BOOLEAN_JSON_BYTES],
    ["eventLength", MAX_SAFE_JSON_INTEGER_BYTES],
  ]);
  const record = objectBytes([
    ["requestHash", MAX_HASH_JSON_BYTES],
    ["outcome", outcome],
    ["undo", undo],
  ]);
  // Operations are independently summed on purpose. Their overlap is a
  // conservative occurrence bound, not a lifecycle outcome search.
  return (
    fieldBytes("patch", record) +
    adds * (1 + taskSchemaBytes(id, source)) +
    (revises + restores) * taskSchemaBytes(id, source) +
    archives * fieldBytes("included", MAX_BOOLEAN_JSON_BYTES) +
    (adds + revises + archives + restores) * (1 + event) +
    fieldBytes("nextTaskId", MAX_SAFE_JSON_INTEGER_BYTES) +
    fieldBytes(
      "cursor",
      objectBytes([
        ["id", jsonBytes(observation.id)],
        ["hash", MAX_HASH_JSON_BYTES],
        ["role", jsonBytes(observation.role)],
      ]),
    ) +
    fieldBytes("phase", jsonBytes("complete")) +
    fieldBytes("scopeUnresolved", MAX_BOOLEAN_JSON_BYTES) +
    fixedBlockSchemaBytes()
  );
}

function extractionAdmissionPlan(
  state: HybridState,
  observation: Observation,
  input: ExtractionInput,
): AdmissionPlan {
  return {
    phase: "extraction",
    candidate: copyState(state),
    request: input,
    schemaBytes: patchSchemaBytes(state, observation),
  };
}

function completionAdmissionPlan(
  state: HybridState,
  observation: Observation,
  chunk: readonly HybridTask[],
  focusCandidates: readonly HybridTask[],
  request: EvaluationRequest,
): AdmissionPlan {
  const journal = state.pending?.journal;
  if (!journal) throw new Error("Accepted gate journal is required");
  // Candidate is one ordinary valid phase shape only. It is not a maximum;
  // schemaBytes below independently bounds every legal persisted occurrence.
  const baseAssessment: Assessment = {
    rawChoice: "uncertain",
    confidence: 0,
    probability: 0,
    reason: "threshold-abstention",
    source: observationRef(observation),
  };
  const baseFocus = focusCandidates.length
    ? {
        assessment: {
          ...baseAssessment,
          rawChoice: "none",
        },
        priorFocusTaskId: optionalPresence(state.focusTaskId),
      }
    : undefined;
  const completed = applyCompletionRecord(
    state,
    chunk.map((task) => task.id),
    chunk.map(() => baseAssessment),
  );
  const candidate = baseFocus
    ? applyFocusRecord(completed, focusCandidates, baseFocus.assessment)
    : completed;
  const baseRecord: CompletionRecord = {
    requestHash: requestHash(request),
    chunkIds: chunk.map((task) => task.id),
    assessments: chunk.map(() => baseAssessment),
    ...(baseFocus ? { focus: baseFocus } : {}),
    undo: completionUndo(state, chunk),
  };
  const taskId = largestTaskIdBytes(state.tasks, state.nextTaskId);
  const assessment = assessmentSchemaBytes(
    observation,
    longest(["yes", "no", "uncertain"].map(jsonBytes)),
  );
  const event = eventSchemaBytes(
    largestEventIdBytes(state),
    taskId,
    observation,
  );
  const undo = objectBytes([
    ["status", jsonBytes("not-started")],
    ["latestAssessment", presenceSchemaBytes(assessment)],
  ]);
  const focusChoice = longest([
    ...focusCandidates.map((task) => jsonBytes(task.id)),
    ...["none", "concurrent", "uncertain"].map(jsonBytes),
  ]);
  const focus = focusCandidates.length
    ? objectBytes([
        ["assessment", assessmentSchemaBytes(observation, focusChoice)],
        ["priorFocusTaskId", presenceSchemaBytes(taskId)],
      ])
    : 0;
  const record = objectBytes([
    ["requestHash", MAX_HASH_JSON_BYTES],
    ["chunkIds", arrayBytes(chunk.map((task) => jsonBytes(task.id)))],
    ["assessments", arrayBytes(chunk.map(() => assessment))],
    ...(focus ? [["focus", focus] as [string, number]] : []),
    [
      "undo",
      objectBytes([
        ["tasks", arrayBytes(chunk.map(() => undo))],
        ["eventLength", MAX_SAFE_JSON_INTEGER_BYTES],
      ]),
    ],
  ]);
  return {
    phase: "completion",
    candidate: {
      ...candidate,
      pending: pending(observation, "complete", journal.gate, journal.patch, [
        ...journal.completions,
        baseRecord,
      ]),
    },
    request,
    schemaBytes:
      // One record and one task latestAssessment per task, plus every possible
      // event. Focus selection and top-level focus presence are independent.
      fieldBytes("completions", 1 + record) +
      chunk.length *
        (taskSchemaBytes(taskId, sourceSchemaBytes(observation), assessment) +
          1 +
          event) +
      (focus ? fieldBytes("focusTaskId", taskId) : 0) +
      fieldBytes(
        "cursor",
        objectBytes([
          ["id", jsonBytes(observation.id)],
          ["hash", MAX_HASH_JSON_BYTES],
          ["role", jsonBytes(observation.role)],
        ]),
      ) +
      fixedBlockSchemaBytes(),
  };
}

function patchBlock(error: unknown): PendingBlock {
  if (error instanceof ScopeRejection && error.failure === "capacity")
    return /event/.test(error.message) ? "event-capacity" : "task-capacity";
  return "invalid-patch";
}

function validPatchTargets(input: ExtractionInput, outcome: NormalizedPatch) {
  const ids = new Set(input.tasks.map((task) => task.id));
  return [...outcome.revise, ...outcome.archive, ...outcome.restore].every(
    (operation) => ids.has(operation.id),
  );
}

/**
 * One immutable observation transaction. Accepted gate, patch and completion
 * chunks save before cursor commit, so a restored pending observation resumes
 * without repeating accepted provider stages.
 */
export async function processObservation(
  state: HybridState,
  observation: Observation,
  providers: HybridProviders,
  preceding: readonly Observation[] = [],
): Promise<HybridState> {
  if (!validObservation(observation)) throw new Error("Invalid observation");
  const prior = copyState(state);
  const resuming = prior.pending;
  if (resuming && !sameObservation(resuming.observation, observation))
    throw new Error("Pending observation must resume before a new observation");
  if (
    !resuming &&
    prior.cursor?.id === observation.id &&
    prior.cursor.hash === observation.hash &&
    prior.cursor.role === observation.role
  )
    return state;

  let next = clearTransientErrors(prior);
  if (resuming?.block.present) return next;
  // A durable limit never permits a fresh paid transaction. A replay-valid
  // pending observation may still finish locally below without provider work.
  if (!resuming && next.capacity === "limit") return next;
  const context = preceding.slice(-2);
  if (!resuming) {
    if (Buffer.byteLength(observation.text) > MAX_LATEST_MESSAGE_BYTES)
      return {
        ...next,
        cursor: {
          id: observation.id,
          hash: observation.hash,
          role: observation.role,
        },
        focusTaskId: retainedFocusTaskId(next),
        scopeUnresolved: true,
        scopeFailure: "overflow",
        scopeError: "Latest message exceeds 12KiB unresolved overflow",
      };
    try {
      const beforeGate = copyState(next);
      const request = gateRequest(beforeGate, observation, context);
      if (
        !admissionAllowed(
          providers,
          gateAdmissionPlan(beforeGate, observation, context, request),
        )
      )
        return capacityLimited(next);
      const gate = gateResult(await providers.evaluate(request), observation);
      const record: GateRecord = {
        originHash: originHash(beforeGate),
        requestHash: requestHash(request),
        context: context.map(observationRef),
        assessment: structuredClone(gate.assessment),
        priorScopeAssessment: optionalPresence(beforeGate.scopeAssessment),
      };
      next = applyGate(beforeGate, gate.assessment);
      next = {
        ...next,
        pending: pending(
          observation,
          gateDecision(gate.assessment) === "unchanged"
            ? "complete"
            : "extract",
          record,
        ),
      };
      saveAccepted(next, providers);
    } catch (error) {
      if (
        error instanceof RetryableProviderError ||
        error instanceof DurabilityCapacityError
      )
        throw error;
      const rejection =
        error instanceof GateRequestOverflowError
          ? new ScopeRejection("overflow", error.message)
          : new ScopeRejection("invalid", "Scope gate failed");
      return {
        ...next,
        scopeError: rejection.message,
        scopeFailure: rejection.failure,
        scopeUnresolved: true,
      };
    }
  }

  if (next.pending?.phase === "extract") {
    let input: ExtractionInput;
    try {
      input = extractionInput(next, observation, context);
    } catch (error) {
      if (error instanceof ExtractionInputOverflowError)
        return blockPending(next, "input-overflow", "overflow");
      throw error;
    }
    try {
      if (
        !admissionAllowed(
          providers,
          extractionAdmissionPlan(next, observation, input),
        )
      )
        return blockPending(next, "event-capacity", "capacity", true);
      const outcome = normalizedPatch(
        groundPatch(
          parsePatch(await providers.extract(input)),
          observation,
          new Set(input.tasks.map((task) => task.id)),
        ),
      );
      if (!validPatchTargets(input, outcome))
        throw new ScopeRejection(
          "invalid",
          "Extraction target omitted from input",
        );
      const undo = patchUndo(next, outcome);
      const patched = applyPatch(next, outcome);
      const patch: PatchRecord = {
        requestHash: requestHash(input),
        outcome,
        undo,
      };
      next = {
        ...patched,
        pending: pending(
          observation,
          "complete",
          next.pending.journal.gate,
          patch,
        ),
      };
      saveAccepted(next, providers);
    } catch (error) {
      if (
        error instanceof RetryableProviderError ||
        error instanceof DurabilityCapacityError
      )
        throw error;
      return blockPending(
        next,
        patchBlock(error),
        error instanceof ScopeRejection ? error.failure : "invalid",
      );
    }
  }

  if (next.pending?.phase !== "complete" || next.pending.block.present)
    return next;
  if (Buffer.byteLength(observation.text) > MAX_LATEST_MESSAGE_BYTES)
    return blockPending(next, "completion-build", "overflow");
  try {
    for (;;) {
      const accepted = new Set(acceptedCompletionIds(next.pending));
      const remaining = next.tasks.filter(
        (task) => task.included && !accepted.has(task.id),
      );
      if (!remaining.length) break;
      // Only the first completion request has all pre-completion open tasks
      // available for an independent current-activity judgment.
      const completionJournal = next.pending?.journal;
      if (!completionJournal)
        throw new Error("Accepted gate journal is required");
      const focusCandidates = completionJournal.completions.length
        ? []
        : openTasks(next);
      const chunk = completionChunks(
        observation,
        remaining,
        context,
        focusCandidates,
      )[0];
      if (!chunk) break;
      if (next.events.length + chunk.length > MAX_EVENTS)
        return blockPending(next, "event-capacity", "capacity");
      const request = completionRequest(
        observation,
        chunk,
        context,
        focusCandidates,
      );
      if (
        !admissionAllowed(
          providers,
          completionAdmissionPlan(
            next,
            observation,
            chunk,
            focusCandidates,
            request,
          ),
        )
      )
        // Keep accepted prefixes byte-identical when near-capacity admission
        // declines a later chunk; `capacity` is durable typed presentation.
        return capacityLimited(next);
      const result = await providers.evaluate(request);
      const decisions = completionDecisions(result, observation, chunk);
      const assessments = decisions.map((decision) => decision.assessment);
      const focus = focusCandidates.length
        ? {
            assessment: focusAssessment(result, observation, focusCandidates),
            priorFocusTaskId: optionalPresence(next.focusTaskId),
          }
        : undefined;
      const undo = completionUndo(next, chunk);
      const completed = applyCompletionRecord(
        next,
        chunk.map((task) => task.id),
        assessments,
      );
      const committed = focus
        ? applyFocusRecord(completed, focusCandidates, focus.assessment)
        : completed;
      const record: CompletionRecord = {
        requestHash: requestHash(request),
        chunkIds: chunk.map((task) => task.id),
        assessments: structuredClone(assessments),
        ...(focus ? { focus: structuredClone(focus) } : {}),
        undo,
      };
      const journal = next.pending?.journal;
      if (!journal) throw new Error("Accepted gate journal is required");
      next = {
        ...committed,
        pending: pending(observation, "complete", journal.gate, journal.patch, [
          ...journal.completions,
          record,
        ]),
      };
      saveAccepted(next, providers);
    }
  } catch (error) {
    if (
      error instanceof RetryableProviderError ||
      error instanceof DurabilityCapacityError
    )
      throw error;
    return blockPending(next, "completion-build", "invalid");
  }
  const committed = completeTransaction(next, observation);
  saveAccepted(committed, providers);
  return committed;
}
