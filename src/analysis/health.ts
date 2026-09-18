import type { Ledger } from "../core/types";
import type { PassiveEvidence } from "../sources/evidence";
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
  redApplicability: {
    type: "choice",
    instructions:
      "Would adding a NEW failing regression test provide meaningful task-specific value? Documentation/planning may be not-needed; small code changes are not automatically exempt. Respect only supplied explicit policy.",
    criteria: {
      needed: "A new failing regression test is useful or required",
      "not-needed": "A new failing regression test adds no meaningful value",
      unknown: "Applicability or policy is insufficiently grounded",
    },
  },
  redReport: {
    type: "choice",
    instructions:
      "Does visible task-linked conversation context contain an explicit actual assertion that a failing regression test was written or observed for this exact task revision? An explicit actual assertion is sufficient for Reported red without observed execution; do not demand a run. Quotes, intentions and hypotheticals do not qualify.",
    criteria: {
      "reported-red": "Explicit actual task-linked failing-test assertion",
      contradicted: "Current task-linked claims contradict each other",
      "not-found": "No explicit actual assertion in supplied complete context",
      unknown: "Context or linkage is insufficient",
    },
  },
};
export interface HealthSnapshot {
  identity: string;
  /** Task/evidence identity. Unlike fresh conversation context, it gates batches. */
  taskIdentity: string;
  observedAt: number;
  omissions: string[];
  /** First resumable request, retained for existing callers/preview. */
  request: EvaluationRequest;
  /** Core plus every criterion batch; all must settle before implementation is shown. */
  requests: EvaluationRequest[];
  implementationEvidenceComplete: boolean;
}
export interface HealthResult {
  snapshot: HealthSnapshot;
  result: ValidatedResult;
  evaluatedAt: number;
}

const requestFits = (request: EvaluationRequest) =>
  Object.keys(request.questions).length <= 20 &&
  Buffer.byteLength(JSON.stringify(request)) <= MAX_REQUEST_BYTES;
const criterionQuestion = (criterion: string) => ({
  type: "choice" as const,
  instructions: `Assess whether bounded passive implementation evidence supports exact criterion ${JSON.stringify(criterion)}. Agent self-report alone is insufficient. Missing, stale, truncated or unlinked evidence is insufficient; explicit contrary current evidence contradicts.`,
  criteria: {
    supports: "Current linked passive evidence supports this criterion",
    contradicts: "Current linked passive evidence contradicts this criterion",
    insufficient: "Evidence is missing, stale, unlinked, or incomplete",
  },
});

function boundedEvidence(evidence: PassiveEvidence[]) {
  const kept: PassiveEvidence[] = [];
  let bytes = 0;
  for (const item of evidence) {
    const copy = {
      ...item,
      ...(item.link ? { link: { ...item.link } } : {}),
    };
    const size = Buffer.byteLength(JSON.stringify(copy));
    if (bytes + size > 12 * 1024) return { evidence: kept, complete: false };
    kept.push(copy);
    bytes += size;
  }
  return { evidence: kept, complete: true };
}

/**
 * Builds independent criterion batches instead of silently dropping a suffix.
 * An oversized core rubric is Unknown, while its exact criterion spans still
 * continue through resumable bounded batches.
 */
export function healthSnapshot(
  ledger: Ledger | undefined,
  epoch: number,
  context?: string[],
  passiveEvidence: PassiveEvidence[] = [],
  codeRevision = 0,
): HealthSnapshot | undefined {
  const task = ledger?.tasks.find(
    (item) =>
      item.id === ledger.currentTaskId &&
      item.included &&
      item.status !== "cancelled",
  );
  if (!ledger || ledger.stale || !task?.text.trim()) return;
  const bounded = boundedEvidence(passiveEvidence);
  const evidence = {
    ...task.ref,
    taskId: task.id,
    taskRevision: task.revision ?? ledger.sourceRevision,
    scopeRevision: ledger.scopeRevision,
    passive: bounded.evidence,
    codeRevision,
  };
  const commonState = {
    goal: context?.length ? context.join("\n") : task.text,
    goalScope: context?.length
      ? "Confirmed source goal/context (not an inferred broader project goal)"
      : "Selected task only",
    task: task.text,
    criteria: task.criteria,
    evidence,
    coverage:
      "Complete selected task and owned criteria; only explicitly supplied source context supports goal claims",
  };
  const coreQuestions: EvaluationRequest["questions"] = { ...questions };
  const core: EvaluationRequest = {
    model: MODEL,
    state: commonState,
    questions: coreQuestions,
  };
  const requests: EvaluationRequest[] = [];
  let firstCriterion = 0;
  // The core batch can carry up to 16 criterion questions (four core rows).
  if (requestFits(core)) {
    for (; firstCriterion < task.criteria.length; firstCriterion++) {
      const candidate: EvaluationRequest = {
        ...core,
        questions: {
          ...core.questions,
          [`criterion:${firstCriterion}`]: criterionQuestion(
            task.criteria[firstCriterion] ?? "",
          ),
        },
      };
      if (!requestFits(candidate)) break;
      core.questions = candidate.questions;
    }
    requests.push(core);
  }

  for (let start = firstCriterion; start < task.criteria.length; ) {
    const indexes: number[] = [];
    let batch: EvaluationRequest | undefined;
    for (let index = start; index < task.criteria.length; index++) {
      const nextIndexes = [...indexes, index];
      const request: EvaluationRequest = {
        model: MODEL,
        state: {
          task: task.text,
          criteria: nextIndexes.map((i) => task.criteria[i]),
          criterionIndexes: nextIndexes,
          evidence,
          coverage: {
            totalCriteria: task.criteria.length,
            suppliedIndexes: nextIndexes,
            evidenceComplete: bounded.complete,
          },
        },
        questions: Object.fromEntries(
          nextIndexes.map((i) => [
            `criterion:${i}`,
            criterionQuestion(task.criteria[i] ?? ""),
          ]),
        ),
      };
      if (!requestFits(request)) {
        if (!indexes.length) return;
        break;
      }
      indexes.push(index);
      batch = request;
    }
    if (!batch) return;
    requests.push(batch);
    start += indexes.length;
  }
  const request = requests[0];
  if (!request) return;
  const taskIdentity = JSON.stringify([
    epoch,
    ledger.sourceId,
    ledger.scopeRevision,
    task.id,
    task.revision ?? ledger.sourceRevision,
    task.text,
    task.criteria,
    task.ref,
    passiveEvidence,
    codeRevision,
  ]);
  return {
    identity: JSON.stringify([taskIdentity, context]),
    taskIdentity,
    observedAt: Date.now(),
    omissions: [
      ...(context?.length
        ? [
            "Only confirmed source context and selected task supplied; other conversation, implementation and test execution omitted",
          ]
        : [
            "Other tasks, conversation, implementation and test execution omitted",
            "Goal is the explicitly selected task; broader project goal unavailable",
          ]),
      ...(bounded.complete
        ? []
        : [
            "Passive evidence exceeded the bounded request context; implementation cannot appear complete",
          ]),
      ...(requests.length > 1
        ? [
            `Implementation criteria are being evaluated in ${requests.length} resumable bounded batches`,
          ]
        : []),
    ],
    request,
    requests,
    implementationEvidenceComplete: bounded.complete,
  };
}
