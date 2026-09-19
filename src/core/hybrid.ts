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
  completionJournalProof,
  completionProof,
  gateProof,
  patchProof,
  requestProof,
} from "./hybrid-proof";
import {
  copyState,
  type HybridState,
  type HybridTask,
  type MutationEvent,
  type Observation,
  type ObservationRef,
  observationRef,
  type PendingObservation,
  type ScopeFailure,
  type SourceRef,
} from "./hybrid-state";

const MAX_ACTIVE_TASKS = 20;
const MAX_TOTAL_TASKS = 200;
const MAX_EVENTS = 1000;
const MAX_LATEST_MESSAGE_BYTES = 12 * 1024;

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

const sourceRef = (source: SourceRef): ObservationRef => ({
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

const pending = (
  observation: Observation,
  phase: PendingObservation["phase"],
  completedTaskIds: string[] = [],
  journal: Pick<
    PendingObservation,
    "completionHashes" | "gateHash" | "patchHash" | "proofs"
  > = { completionHashes: [] },
): PendingObservation => ({
  observation: observationRef(observation),
  phase,
  completedTaskIds,
  completionHashes: [...journal.completionHashes],
  ...(journal.gateHash ? { gateHash: journal.gateHash } : {}),
  ...(journal.patchHash ? { patchHash: journal.patchHash } : {}),
  ...(journal.proofs ? { proofs: journal.proofs } : {}),
});

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
    cursor: { id: observation.id, hash: observation.hash },
    focusTaskId: focusTaskId(committed),
  };
}

function validateLifecyclePatch(
  state: HybridState,
  patch: ReturnType<typeof groundPatch>,
) {
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

/** Apply a fully grounded patch atomically after every lifecycle target is valid. */
async function applyScopePatch(
  state: HybridState,
  observation: Observation,
  providers: HybridProviders,
  preceding: readonly Observation[],
  suppliedInput?: ExtractionInput,
): Promise<HybridState> {
  try {
    const input =
      suppliedInput ?? extractionInput(state, observation, preceding);
    const raw = await providers.extract(input);
    const patch = groundPatch(
      parsePatch(raw),
      observation,
      new Set(input.tasks.map((task) => task.id)),
    );
    validateLifecyclePatch(state, patch);

    const revisions = new Map(
      patch.revise.map((operation) => [operation.id, operation]),
    );
    const archives = new Map(
      patch.archive.map((operation) => [operation.id, operation]),
    );
    const restores = new Map(
      patch.restore.map((operation) => [operation.id, operation]),
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
          source: revise.source,
        };
      const archive = archives.get(task.id);
      if (archive) return { ...task, included: false };
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
          source: restore.source,
        };
      return task;
    });
    const additions = patch.add.map((addition, index) => ({
      id: `task:${state.nextTaskId + index}`,
      label: addition.label,
      kind: addition.kind,
      basis: addition.basis,
      status: "not-started" as const,
      included: true,
      revision: 1,
      source: addition.source,
    }));
    const withAdditions = [...tasks, ...additions];
    let next: HybridState = {
      ...state,
      tasks: withAdditions,
      nextTaskId: state.nextTaskId + additions.length,
      scopeUnresolved: patch.unresolved,
    };
    const events = [
      ...patch.add.map((addition, index) =>
        event(
          next,
          "create",
          `task:${state.nextTaskId + index}`,
          1,
          sourceRef(addition.source),
        ),
      ),
      ...patch.revise.map((operation) => {
        const changed = operation.requirementsChanged;
        const previous = state.tasks.find((task) => task.id === operation.id);
        if (!previous) throw new Error("Extraction target does not exist");
        return event(
          next,
          "revise",
          operation.id,
          changed ? previous.revision + 1 : previous.revision,
          sourceRef(operation.source),
        );
      }),
      ...patch.archive.map((operation) => {
        const previous = state.tasks.find((task) => task.id === operation.id);
        if (!previous) throw new Error("Extraction target does not exist");
        return event(
          next,
          "archive",
          operation.id,
          previous.revision,
          sourceRef(operation.source),
        );
      }),
      ...patch.restore.map((operation) => {
        const previous = state.tasks.find((task) => task.id === operation.id);
        if (!previous) throw new Error("Extraction target does not exist");
        return event(
          next,
          "restore",
          operation.id,
          operation.requirementsChanged
            ? previous.revision + 1
            : previous.revision,
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
    const archivedFocus = patch.archive.some(
      (operation) => operation.id === state.focusTaskId,
    );
    const focusTaskId = additions[0]?.id ?? patch.restore[0]?.id;
    return {
      ...next,
      ...(focusTaskId
        ? { focusTaskId }
        : archivedFocus
          ? { focusTaskId: undefined }
          : {}),
    };
  } catch (error) {
    if (
      error instanceof RetryableProviderError ||
      error instanceof DurabilityCapacityError
    )
      throw error;
    const rejection =
      error instanceof ScopeRejection
        ? error
        : error instanceof ExtractionInputOverflowError
          ? new ScopeRejection("overflow", error.message)
          : new ScopeRejection(
              "invalid",
              error instanceof Error
                ? error.message
                : "Scope extraction failed",
            );
    return {
      ...state,
      scopeError: rejection.message,
      scopeFailure: rejection.failure,
      scopeUnresolved: true,
    };
  }
}

function completionChunks(
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

async function applyCompletion(
  state: HybridState,
  observation: Observation,
  providers: HybridProviders,
  preceding: readonly Observation[],
): Promise<HybridState> {
  const completedTaskIds = new Set(state.pending?.completedTaskIds ?? []);
  const tasks = state.tasks.filter(
    (task) => task.included && !completedTaskIds.has(task.id),
  );
  if (!tasks.length) return state;
  if (Buffer.byteLength(observation.text) > MAX_LATEST_MESSAGE_BYTES)
    return {
      ...state,
      completionError: "Latest completion message exceeds 12KiB",
    };
  let next = state;
  try {
    for (const chunk of completionChunks(observation, tasks, preceding)) {
      // Every task can emit one mutation; reject before a billed completion call.
      if (next.events.length + chunk.length > MAX_EVENTS)
        return {
          ...next,
          scopeUnresolved: true,
          scopeFailure: "capacity",
          completionError: "Task mutation event capacity exceeds 1000",
        };
      const request = completionRequest(observation, chunk, preceding);
      const decisions = completionDecisions(
        await providers.evaluate(request),
        observation,
        chunk,
      );
      const byId = new Map(
        decisions.map((decision) => [decision.taskId, decision]),
      );
      const events: MutationEvent[] = [];
      const updated = next.tasks.map((task) => {
        const decision = byId.get(task.id);
        if (!decision) return task;
        if (decision.status !== task.status)
          events.push(
            event(
              {
                ...next,
                events: [...next.events, ...events],
              },
              task.status === "done" ? "withdraw" : "complete",
              task.id,
              task.revision,
              observationRef(observation),
            ),
          );
        return {
          ...task,
          status: decision.status,
          latestAssessment: decision.assessment,
        };
      });
      if (next.events.length + events.length > MAX_EVENTS)
        return {
          ...next,
          scopeUnresolved: true,
          scopeFailure: "capacity",
          completionError: "Task mutation event capacity exceeds 1000",
        };
      const accepted = [
        ...(next.pending?.completedTaskIds ?? []),
        ...chunk.map((task) => task.id),
      ];
      const journal = next.pending;
      const acceptedTasks = new Map(updated.map((task) => [task.id, task]));
      const completionHashes = accepted.map((id) => {
        const task = acceptedTasks.get(id);
        if (!task) throw new Error("Accepted completion task is missing");
        return completionProof(task, observation);
      });
      const committed = {
        ...next,
        tasks: updated,
        events: [...next.events, ...events],
      };
      next = {
        ...committed,
        pending: pending(observation, "complete", accepted, {
          completionHashes,
          ...(journal?.gateHash ? { gateHash: journal.gateHash } : {}),
          ...(journal?.patchHash ? { patchHash: patchProof(committed) } : {}),
          proofs: {
            ...(journal?.proofs?.gate ? { gate: journal.proofs.gate } : {}),
            ...(journal?.proofs?.patch ? { patch: journal.proofs.patch } : {}),
            completions: [
              ...(journal?.proofs?.completions ?? []),
              completionJournalProof(
                request,
                observation,
                [...preceding],
                chunk,
                decisions.map((decision) => ({
                  taskId: decision.taskId,
                  status: decision.status,
                  assessment: decision.assessment,
                })),
                events,
              ),
            ],
          },
        }),
      };
      saveAccepted(next, providers);
    }
    return next;
  } catch (error) {
    if (
      error instanceof RetryableProviderError ||
      error instanceof DurabilityCapacityError
    )
      throw error;
    return {
      ...next,
      completionError:
        error instanceof Error ? error.message : "Completion evaluation failed",
    };
  }
}

/**
 * One immutable observation transaction. Accepted gate, patch and completion
 * chunks save before cursor commit, so a restored pending observation resumes
 * without repeating completed provider stages.
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
    prior.cursor.hash === observation.hash
  )
    return state;

  let next = clearTransientErrors(prior);
  if (!resuming) {
    if (Buffer.byteLength(observation.text) > MAX_LATEST_MESSAGE_BYTES)
      return {
        ...next,
        cursor: { id: observation.id, hash: observation.hash },
        focusTaskId: focusTaskId(next),
        scopeUnresolved: true,
        scopeFailure: "overflow",
        scopeError: "Latest message exceeds 12KiB unresolved overflow",
      };
    else {
      try {
        const request = gateRequest(next, observation, preceding);
        const gate = gateResult(await providers.evaluate(request), observation);
        next = {
          ...next,
          scopeAssessment: gate.assessment,
          pending: pending(
            observation,
            gate.decision === "unchanged" ? "complete" : "extract",
            [],
            {
              completionHashes: [],
              gateHash: gateProof(gate.assessment),
              proofs: {
                gate: requestProof(
                  request,
                  "gate",
                  observation,
                  [...preceding],
                  next.tasks.filter((task) => task.included),
                ),
                completions: [],
              },
            },
          ),
        };
        saveAccepted(next, providers);
      } catch (error) {
        if (
          error instanceof RetryableProviderError ||
          error instanceof DurabilityCapacityError
        )
          throw error;
        const { scopeAssessment: _scopeAssessment, ...unassessed } = next;
        const rejection =
          error instanceof GateRequestOverflowError
            ? new ScopeRejection("overflow", error.message)
            : new ScopeRejection(
                "invalid",
                error instanceof Error ? error.message : "Scope gate failed",
              );
        return {
          ...unassessed,
          pending: pending(observation, "extract"),
          scopeError: rejection.message,
          scopeFailure: rejection.failure,
          scopeUnresolved: true,
        };
      }
    }
  }

  if (next.pending?.phase === "extract") {
    let input: ExtractionInput;
    try {
      input = extractionInput(next, observation, preceding);
    } catch (error) {
      if (error instanceof ExtractionInputOverflowError)
        return {
          ...next,
          scopeUnresolved: true,
          scopeFailure: "overflow",
          scopeError: error.message,
        };
      throw error;
    }
    const patchRequest = requestProof(
      input,
      "patch",
      observation,
      [...preceding],
      next.tasks.filter((task) => task.included),
    );
    next = await applyScopePatch(
      next,
      observation,
      providers,
      preceding,
      input,
    );
    // Capacity and construction overflow have not applied accepted scope work.
    // Keep extract pending for an explicit eligible retry without cursor commit.
    if (next.scopeFailure === "capacity" || next.scopeFailure === "overflow")
      return next;
    next = {
      ...next,
      pending: pending(observation, "complete", [], {
        completionHashes: [],
        ...(next.pending?.gateHash ? { gateHash: next.pending.gateHash } : {}),
        patchHash: patchProof(next),
        proofs: {
          ...(next.pending?.proofs?.gate
            ? { gate: next.pending.proofs.gate }
            : {}),
          patch: patchRequest,
          completions: [],
        },
      }),
    };
    saveAccepted(next, providers);
  }

  next = await applyCompletion(next, observation, providers, preceding);
  if (next.completionError) return { ...next, focusTaskId: focusTaskId(next) };
  const committed = completeTransaction(next, observation);
  saveAccepted(committed, providers);
  return committed;
}
