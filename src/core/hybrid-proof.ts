import { createHash } from "node:crypto";

import type {
  Assessment,
  HybridState,
  HybridTask,
  Observation,
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
