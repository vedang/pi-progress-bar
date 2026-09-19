import { createHash } from "node:crypto";

import type {
  Assessment,
  CompletionJournalProof,
  HybridState,
  HybridTask,
  MutationEvent,
  Observation,
  ObservationRef,
  RequestProof,
  TaskProjection,
  TaskStatus,
} from "./hybrid-state";

const proofHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const gateProof = (assessment: Assessment) => proofHash(assessment);

export const patchProof = (state: HybridState) =>
  proofHash({
    tasks: state.tasks,
    events: state.events,
    scopeUnresolved: state.scopeUnresolved,
  });

/** Binds each skipped completion decision to its task revision and observation. */
export const completionProof = (
  task: HybridTask,
  observation: Pick<Observation, "id" | "hash" | "role">,
) =>
  proofHash({
    observation: {
      id: observation.id,
      hash: observation.hash,
      role: observation.role,
    },
    task: {
      id: task.id,
      revision: task.revision,
      status: task.status,
      latestAssessment: task.latestAssessment,
    },
  });

const observationRef = (observation: Observation): ObservationRef => ({
  entryId: observation.id,
  messageHash: observation.hash,
  role: observation.role,
});

const taskProjection = (task: HybridTask): TaskProjection => ({
  id: task.id,
  label: task.label,
  kind: task.kind,
  basis: task.basis,
  status: task.status,
  included: task.included,
  revision: task.revision,
  ...(task.source ? { source: { ...task.source } } : {}),
});

const inputHash = (
  phase: RequestProof["phase"],
  requestHash: string,
  observation: Observation,
  context: ObservationRef[],
  tasks: TaskProjection[],
) =>
  proofHash({
    phase,
    requestHash,
    observation: observationRef(observation),
    context,
    tasks,
  });

/** Persists bounded, replayable evidence for an accepted model request. */
export const requestProof = (
  request: unknown,
  phase: RequestProof["phase"],
  observation: Observation,
  preceding: Observation[],
  tasks: HybridTask[],
): RequestProof => {
  const context = preceding.map(observationRef);
  const projections = tasks.map(taskProjection);
  const requestHash = proofHash(request);
  return {
    phase,
    requestHash,
    inputHash: inputHash(phase, requestHash, observation, context, projections),
    context,
    tasks: projections,
  };
};

export const validRequestProofHash = (
  proof: RequestProof,
  observation: Observation,
) =>
  proof.inputHash ===
  inputHash(
    proof.phase,
    proof.requestHash,
    observation,
    proof.context,
    proof.tasks,
  );

export const completionJournalProof = (
  request: unknown,
  observation: Observation,
  preceding: Observation[],
  tasks: HybridTask[],
  results: { taskId: string; status: TaskStatus; assessment: Assessment }[],
  events: MutationEvent[],
): CompletionJournalProof => ({
  ...requestProof(request, "completion", observation, preceding, tasks),
  taskIds: tasks.map((task) => task.id),
  resultHash: proofHash(results),
  results,
  events: events.map((event) => ({ ...event })),
});

export const validCompletionResultHash = (proof: CompletionJournalProof) =>
  proof.resultHash === proofHash(proof.results);
