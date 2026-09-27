import type { Observation } from "../../src/core/hybrid-state";
import { SubtaskStore } from "../../src/core/subtasks";
import {
  subtaskAdmission,
  subtaskHash,
  subtaskParent,
  subtaskSource,
} from "./subtasks";

export const reportChoices = [
  "completed-item",
  "completed-set",
  "retracted-item",
  "retracted-set",
  "blocked-item",
  "blocked-set",
  "unchanged",
  "uncertain",
] as const;

/** Synthetic mechanics only; no held-out examples or semantic quality claim. */
export function subtaskReportFixture(
  labels = Array.from({ length: 22 }, (_, i) => `Implement component ${i + 1}`),
  complete = true,
  text = "I completed all agreed obligations. Synthesis remains pending.",
) {
  const goalText = `Complete these agreed obligations: ${labels.join("; ")}.`;
  const parent = subtaskParent();
  parent.label = "Deliver the agreed plan";
  parent.source = subtaskSource("goal", goalText);
  const goal: Observation = {
    id: "goal",
    role: "user",
    text: goalText,
    hash: subtaskHash(goalText),
  };
  const report: Observation = {
    id: "report",
    role: "assistant",
    text,
    hash: subtaskHash(text),
  };
  const observations = new Map([
    [goal.id, goal],
    [report.id, report],
  ]);
  const store = new SubtaskStore();
  const admitted = store.admit({
    ...subtaskAdmission(labels),
    parent,
    source: parent.source,
    complete,
    ...(complete ? { knownTotal: labels.length } : {}),
    children: labels.map((label) => ({
      kind: "add" as const,
      label,
      source: parent.source,
    })),
  });
  if (!admitted.accepted)
    throw new Error(`Invalid report fixture: ${admitted.reason}`);
  return {
    store,
    observations,
    options: {
      parent,
      group: store.snapshot().groups[0],
      report,
      resolve: (id: string) => observations.get(id),
    },
  };
}
