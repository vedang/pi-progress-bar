import type { Ledger } from "../core/types";
import {
  type EvaluationRequest,
  MAX_REQUEST_BYTES,
  MODEL,
  type ValidatedResult,
} from "./gateway";

/** v1 rubric: independent questions share one bounded task-local state. */
const questions: EvaluationRequest["questions"] = {
  clarity: {
    type: "score",
    instructions:
      "Rate requirements clarity of `task` toward `goal`, considering `criteria`. Judge supplied context only, not implementation quality or completion.",
    criteria: [
      "Missing concrete target",
      "Consequential unresolved behavior",
      "Concrete behavior with minor ambiguity",
      "Concrete behavior and relevant boundaries resolved",
    ],
  },
  acceptance: {
    type: "choice",
    instructions:
      "Does the supplied `task` and its owned `criteria` define observable success conditions for `goal`? Do not infer tests exist or pass. Use unknown when context is insufficient, not-found-in-context when complete supplied context contains no observable conditions.",
    criteria: {
      explicit: "Observable success conditions explicitly cover the task",
      partial:
        "Some observable success conditions, but important conditions missing",
      "not-found-in-context":
        "No observable success conditions found in supplied context",
      unknown: "Insufficient context to assess acceptance conditions",
    },
  },
};
export interface HealthSnapshot {
  identity: string;
  observedAt: number;
  omissions: string[];
  request: EvaluationRequest;
}
export interface HealthResult {
  snapshot: HealthSnapshot;
  result: ValidatedResult;
  evaluatedAt: number;
}
export function healthSnapshot(
  ledger: Ledger | undefined,
  epoch: number,
  context?: string[],
): HealthSnapshot | undefined {
  const task = ledger?.tasks.find(
    (item) => item.id === ledger.currentTaskId && item.included,
  );
  if (!ledger || ledger.stale || !task?.text.trim()) return;
  const snapshot: HealthSnapshot = {
    identity: JSON.stringify([
      epoch,
      ledger.sourceId,
      ledger.scopeRevision,
      task.id,
      task.text,
      task.criteria,
      task.ref,
      context,
    ]),
    observedAt: Date.now(),
    omissions: context?.length
      ? [
          "Only confirmed source context and selected task supplied; other conversation, implementation and test execution omitted",
        ]
      : [
          "Other tasks, conversation, implementation and test execution omitted",
          "Goal is the explicitly selected task; broader project goal unavailable",
        ],
    request: {
      model: MODEL,
      state: {
        goal: context?.length ? context.join("\n") : task.text,
        goalScope: context?.length
          ? "Confirmed source goal/context (not an inferred broader project goal)"
          : "Selected task only",
        task: task.text,
        criteria: task.criteria,
        evidence: {
          ...task.ref,
          taskId: task.id,
          scopeRevision: ledger.scopeRevision,
        },
        coverage:
          "Complete selected task and owned criteria; only explicitly supplied source context supports goal claims",
      },
      questions,
    },
  };
  // Essential task/criteria never clipped to fit an outbound request.
  if (Buffer.byteLength(JSON.stringify(snapshot.request)) > MAX_REQUEST_BYTES)
    return;
  return snapshot;
}
