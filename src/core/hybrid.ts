import { completionDecisions, completionRequest } from "../analysis/completion";
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
  type SourceRef,
} from "./hybrid-state";

const MAX_ACTIVE_TASKS = 20;
const MAX_TOTAL_TASKS = 200;
const MAX_EVENTS = 1000;
const MAX_LATEST_MESSAGE_BYTES = 12 * 1024;
const MAX_SCHEMA_LABEL = "\ud800".repeat(240);

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
  (observation.role === "user" || observation.role === "assistant") &&
  typeof observation.text === "string" &&
  /^[a-f0-9]{64}$/.test(observation.hash);

const focusTaskId = (state: HybridState) =>
  Object.hasOwn(state, "focusTaskId")
    ? state.focusTaskId
    : state.tasks.find((task) => task.included && task.status !== "done")?.id;

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
    focusTaskId: focusTaskId(committed),
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
  const archivedFocus = outcome.archive.some(
    (operation) => operation.id === state.focusTaskId,
  );
  const nextFocus = additions[0]?.id ?? outcome.restore[0]?.id;
  return {
    ...next,
    ...(nextFocus
      ? { focusTaskId: nextFocus }
      : archivedFocus
        ? { focusTaskId: undefined }
        : {}),
  };
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
): HybridTask[][] {
  const chunks: HybridTask[][] = [];
  let current: HybridTask[] = [];
  for (const task of tasks) {
    try {
      completionRequest(observation, [...current, task], preceding);
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
  return {
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

function maximumAssessment(observation: Observation): Assessment {
  return {
    rawChoice: "yes",
    confidence: 0.30000000000000004,
    probability: 0.30000000000000004,
    reason: "accepted",
    source: observationRef(observation),
  };
}

function maximumSource(observation: Observation): SourceRef {
  return {
    ...observationRef(observation),
    start: 0,
    end: Math.max(1, observation.text.length),
    quoteHash: observation.hash,
  };
}

function gateAdmissionPlan(
  state: HybridState,
  observation: Observation,
  context: readonly Observation[],
  request: EvaluationRequest,
): AdmissionPlan {
  const assessment = {
    ...maximumAssessment(observation),
    rawChoice: "unchanged",
    reason: "semantic-unknown" as const,
  };
  const record: GateRecord = {
    originHash: originHash(state),
    requestHash: requestHash(request),
    context: context.map(observationRef),
    assessment,
    priorScopeAssessment: optionalPresence(state.scopeAssessment),
  };
  const candidate = {
    ...applyGate(state, assessment),
    pending: pending(observation, "extract", record),
  };
  return { phase: "gate", candidate, request, schemaBytes: 0 };
}

function maximumPatch(state: HybridState, observation: Observation) {
  const source = maximumSource(observation);
  const additions = Math.min(
    6,
    MAX_TOTAL_TASKS - state.tasks.length,
    MAX_ACTIVE_TASKS - state.tasks.filter((task) => task.included).length,
  );
  return {
    add: Array.from({ length: additions }, (_, index) => ({
      // Parser forbids same kind/label additions. Preserve 240 code points
      // while making every maximum-schema addition lifecycle-legal.
      label: `${MAX_SCHEMA_LABEL.slice(0, -1)}${index}`,
      kind: "action" as const,
      basis: "explicit" as const,
      source,
    })),
    // A revise repeats both new and undo labels/source, so it upper-bounds
    // archive/restore choices for each currently mutable task.
    revise: state.tasks
      .filter((task) => task.included)
      .slice(0, 12)
      .map((task) => ({
        id: task.id,
        label: MAX_SCHEMA_LABEL,
        requirementsChanged: true,
        source,
      })),
    archive: [],
    restore: [],
    unresolved: false,
  } satisfies NormalizedPatch;
}

function extractionAdmissionPlan(
  state: HybridState,
  observation: Observation,
  input: ExtractionInput,
): AdmissionPlan {
  try {
    const outcome = maximumPatch(state, observation);
    const undo = patchUndo(state, outcome);
    const patched = applyPatch(state, outcome);
    const candidate = {
      ...patched,
      pending: pending(
        observation,
        "complete",
        state.pending?.journal.gate ??
          (() => {
            throw new Error("Accepted gate journal is required");
          })(),
        { requestHash: requestHash(input), outcome, undo },
      ),
    };
    return { phase: "extraction", candidate, request: input, schemaBytes: 0 };
  } catch {
    // A legal maximum that already violates a structural cap cannot be paid.
    return {
      phase: "extraction",
      candidate: copyState(state),
      request: input,
      schemaBytes: Number.POSITIVE_INFINITY,
    };
  }
}

function completionAdmissionPlan(
  state: HybridState,
  observation: Observation,
  chunk: readonly HybridTask[],
  request: EvaluationRequest,
): AdmissionPlan {
  const assessments = chunk.map(() => maximumAssessment(observation));
  const undo = completionUndo(state, chunk);
  const committed = applyCompletionRecord(
    state,
    chunk.map((task) => task.id),
    assessments,
  );
  const journal = state.pending?.journal;
  if (!journal) throw new Error("Accepted gate journal is required");
  const record: CompletionRecord = {
    requestHash: requestHash(request),
    chunkIds: chunk.map((task) => task.id),
    assessments,
    undo,
  };
  return {
    phase: "completion",
    candidate: {
      ...committed,
      pending: pending(observation, "complete", journal.gate, journal.patch, [
        ...journal.completions,
        record,
      ]),
    },
    request,
    schemaBytes: 0,
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
        focusTaskId: focusTaskId(next),
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
      const chunk = completionChunks(observation, remaining, context)[0];
      if (!chunk) break;
      if (next.events.length + chunk.length > MAX_EVENTS)
        return blockPending(next, "event-capacity", "capacity");
      const request = completionRequest(observation, chunk, context);
      if (
        !admissionAllowed(
          providers,
          completionAdmissionPlan(next, observation, chunk, request),
        )
      )
        return blockPending(next, "completion-build", "capacity", true);
      const decisions = completionDecisions(
        await providers.evaluate(request),
        observation,
        chunk,
      );
      const assessments = decisions.map((decision) => decision.assessment);
      const undo = completionUndo(next, chunk);
      const committed = applyCompletionRecord(
        next,
        chunk.map((task) => task.id),
        assessments,
      );
      const record: CompletionRecord = {
        requestHash: requestHash(request),
        chunkIds: chunk.map((task) => task.id),
        assessments: structuredClone(assessments),
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
