import { createHash } from "node:crypto";
import type { HealthCard } from "../../src/core/hybrid-checkpoint";
import type { HybridTask, Observation } from "../../src/core/hybrid-state";
import { observationRef } from "../../src/core/hybrid-state";

/** Trusted checkpoint fixture: exact source/report refs, bounded digest fields. */
export function fixtureHealthCard(
  task: HybridTask,
  report: Observation,
): HealthCard {
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  return {
    taskId: task.id,
    revision: task.revision,
    label: task.label,
    assessedAt: 1,
    health: {
      requirements: "Clear",
      acceptance: "explicit",
      newRedTest: "Not needed",
      redEvidence: "Not needed",
      implementation: "unverified",
    },
    provenance: {
      taskSource: { ...task.source },
      observation: observationRef(report),
      snapshotHash: hash("fixture snapshot"),
      requestHashes: [hash("fixture request")],
      evidenceHash: hash("[]"),
      codeRevision: 0,
    },
  };
}
