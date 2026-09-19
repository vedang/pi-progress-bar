import { completionDecisions, completionRequest } from "../analysis/completion";
import {
  extractionInput,
  groundPatch,
  hasDeferredLifecycleOperations,
  parsePatch,
} from "../analysis/extractor";
import { gateRequest, gateResult } from "../analysis/gate";
import type { EvaluationRequest, ValidatedResult } from "../analysis/gateway";
import { copyState, type HybridState, type Observation } from "./hybrid-state";

const MAX_ACTIVE_TASKS = 20;
const MAX_TOTAL_TASKS = 200;
const MAX_LATEST_MESSAGE_BYTES = 12 * 1024;

export interface HybridProviders {
  evaluate(request: EvaluationRequest): Promise<ValidatedResult>;
  extract(input: ReturnType<typeof extractionInput>): Promise<string>;
}

const validObservation = (observation: Observation) =>
  !!observation.id &&
  (observation.role === "user" || observation.role === "assistant") &&
  typeof observation.text === "string" &&
  /^[a-f0-9]{64}$/.test(observation.hash);

const focusTaskId = (state: HybridState) =>
  state.tasks.find((task) => task.included && task.status !== "done")?.id;

function clearTransientErrors(state: HybridState): HybridState {
  const {
    scopeError: _scopeError,
    completionError: _completionError,
    ...next
  } = state;
  return next;
}

async function applyScopePatch(
  state: HybridState,
  observation: Observation,
  providers: HybridProviders,
  preceding: readonly Observation[],
): Promise<HybridState> {
  try {
    const raw = await providers.extract(
      extractionInput(state, observation, preceding),
    );
    const patch = parsePatch(raw);
    const additions = groundPatch(
      patch,
      observation,
      new Set(state.tasks.map((task) => task.id)),
    );
    if (hasDeferredLifecycleOperations(patch))
      throw new Error(
        "Revise, archive and restore require H2 lifecycle support",
      );
    if (state.tasks.length + additions.length > MAX_TOTAL_TASKS)
      throw new Error("Task ledger exceeds 200 total tasks");
    const active = state.tasks.filter((task) => task.included).length;
    if (active + additions.length > MAX_ACTIVE_TASKS)
      throw new Error("Task ledger exceeds 20 active tasks");
    return {
      ...state,
      tasks: [
        ...state.tasks,
        ...additions.map((addition, index) => ({
          id: `task:${state.nextTaskId + index}`,
          label: addition.label,
          kind: addition.kind,
          basis: addition.basis,
          status: "not-started" as const,
          included: true,
          revision: 1,
          source: addition.source,
        })),
      ],
      nextTaskId: state.nextTaskId + additions.length,
      scopeUnresolved: patch.unresolved,
    };
  } catch (error) {
    return {
      ...state,
      scopeError:
        error instanceof Error ? error.message : "Scope extraction failed",
      scopeUnresolved: false,
    };
  }
}

async function applyCompletion(
  state: HybridState,
  observation: Observation,
  providers: HybridProviders,
): Promise<HybridState> {
  const tasks = state.tasks.filter((task) => task.included);
  if (!tasks.length) return state;
  if (Buffer.byteLength(observation.text) > MAX_LATEST_MESSAGE_BYTES)
    return {
      ...state,
      completionError: "Latest completion message exceeds 12KiB",
    };
  try {
    const decisions = completionDecisions(
      await providers.evaluate(completionRequest(observation, tasks)),
      observation,
      tasks,
    );
    const byId = new Map(
      decisions.map((decision) => [decision.taskId, decision]),
    );
    return {
      ...state,
      tasks: state.tasks.map((task) => {
        const decision = byId.get(task.id);
        return decision
          ? {
              ...task,
              status: decision.status,
              latestAssessment: decision.assessment,
            }
          : task;
      }),
    };
  } catch (error) {
    return {
      ...state,
      completionError:
        error instanceof Error ? error.message : "Completion evaluation failed",
    };
  }
}

/**
 * One immutable observation transaction. Gate and patch failure cannot block
 * independent focused completion, and task IDs remain reducer-owned.
 */
export async function processObservation(
  state: HybridState,
  observation: Observation,
  providers: HybridProviders,
  preceding: readonly Observation[] = [],
): Promise<HybridState> {
  if (!validObservation(observation)) throw new Error("Invalid observation");
  if (
    state.cursor?.id === observation.id &&
    state.cursor.hash === observation.hash
  )
    return state;

  let next = clearTransientErrors(copyState(state));
  next = {
    ...next,
    cursor: { id: observation.id, hash: observation.hash },
    scopeUnresolved: false,
  };
  if (Buffer.byteLength(observation.text) > MAX_LATEST_MESSAGE_BYTES) {
    next = {
      ...next,
      scopeError: "Latest scope message exceeds 12KiB",
    };
  } else {
    try {
      const gate = gateResult(
        await providers.evaluate(gateRequest(observation)),
        observation,
      );
      next = { ...next, scopeAssessment: gate.assessment };
      if (gate.decision !== "unchanged")
        next = await applyScopePatch(next, observation, providers, preceding);
    } catch (error) {
      next = {
        ...next,
        scopeError:
          error instanceof Error ? error.message : "Scope gate failed",
      };
    }
  }

  next = await applyCompletion(next, observation, providers);
  return { ...next, focusTaskId: focusTaskId(next) };
}
