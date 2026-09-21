import type { Ledger } from "../core/types";
import type { PassiveEvidence } from "../sources/evidence";
import { type EvaluationRequest, MAX_REQUEST_BYTES, MODEL } from "./gateway";

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
      "Would adding a NEW failing regression test provide long-term, durable task-specific protection against a future regression? Do not automatically exempt small code changes. Choose needed when durable regression protection is valuable or when current applicable authority explicitly requires a new test, even if durable value is otherwise low. Choose not-needed only when a new test adds no durable protection (for example, disposable one-off work, documentation, or planning) and no applicable authority requires it. If policy is contradictory, or policy authority or precedence is unknown, choose unknown rather than resolve it; also choose unknown when durable value cannot be grounded. This assesses only a NEW test: not-needed never permits skipping required existing tests or validation.",
    criteria: {
      needed:
        "Durable task-specific future-regression protection is valuable, or an explicit applicable requirement requires a new failing regression test even without that value",
      "not-needed":
        "A new failing regression test adds no durable protection and no applicable explicit test requirement; never permits skipping existing required tests or validation",
      unknown:
        "Durable protection cannot be grounded, or test policy is contradictory or its authority or precedence is unknown",
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
  /** Validated local task/revision binding for presentation-only retention. */
  taskId: string;
  taskRevision: string;
  observedAt: number;
  omissions: string[];
  /** First resumable request, retained for existing callers/preview. */
  request: EvaluationRequest;
  /** Core plus every criterion batch; all must settle before implementation is shown. */
  requests: EvaluationRequest[];
  implementationEvidenceComplete: boolean;
}
const requestFits = (request: EvaluationRequest) =>
  Object.keys(request.questions).length <= 20 &&
  Buffer.byteLength(JSON.stringify(request)) <= MAX_REQUEST_BYTES;
const criterionQuestion = (criterion: string) => ({
  type: "choice" as const,
  instructions: `First determine whether this task requires creating or changing an implementation artifact such as code or configuration. A request only to explain, report status, or provide information is not-needed even without passive evidence. Not-needed does not mean implementation work is unfinished. Only when implementation is required should missing passive evidence lead to insufficient. Assess exact criterion ${JSON.stringify(criterion)} for this exact task revision. Passive facts are CANDIDATES, not task ownership: establish concrete support and relevance from canonical requirements, latest report, and candidate facts. Bare agent self-report alone is insufficient. Missing, stale, truncated, unrelated, or unlinked facts are insufficient; explicit contrary current evidence contradicts. Choose partial for explicit incomplete support.`,
  criteria: {
    supports:
      "When implementation is required, current concrete candidate evidence supports this complete criterion",
    partial:
      "When implementation is required, current concrete candidate evidence supports only part of this criterion",
    contradicts:
      "When implementation is required, current concrete candidate evidence contradicts this criterion",
    insufficient:
      "When implementation is required, evidence is missing, stale, incomplete, unrelated, or unlinked",
    "not-needed":
      "No implementation artifact is required for this criterion in supplied context",
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
  const candidateEvidence = {
    ...evidence,
    candidateFacts:
      "Passive facts are candidates only; no local focus/path/keyword ownership is inferred",
    evidenceComplete: bounded.complete,
  };
  const commonState = {
    goal: context?.length ? context.join("\n") : task.text,
    goalScope: context?.length
      ? "Confirmed source goal/context (not an inferred broader project goal)"
      : "Selected task only",
    task: task.text,
    criteria: task.criteria,
    evidence: candidateEvidence,
    coverage:
      "Complete selected task and owned criteria; only explicitly supplied canonical source context supports goal claims",
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
          goal: commonState.goal,
          task: task.text,
          criteria: nextIndexes.map((i) => task.criteria[i]),
          criterionIndexes: nextIndexes,
          evidence: candidateEvidence,
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
    task.workKind ?? "action",
    task.text,
    task.criteria,
    task.ref,
    bounded.evidence,
    bounded.complete,
    codeRevision,
  ]);
  return {
    identity: JSON.stringify([taskIdentity, context]),
    taskIdentity,
    taskId: task.id,
    taskRevision: task.revision ?? ledger.sourceRevision,
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
