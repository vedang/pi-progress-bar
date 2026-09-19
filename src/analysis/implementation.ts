import type { PassiveEvidence } from "../sources/evidence";
import type { ValidatedResult } from "./gateway";

export type ImplementationLabel =
  | "appears complete"
  | "partial"
  | "contradicted"
  | "not-needed"
  | "unverified";

type CriterionAnswer =
  | "supports"
  | "partial"
  | "contradicts"
  | "insufficient"
  | "not-needed";

const recognizedAnswer = (answer: string): answer is CriterionAnswer =>
  ["supports", "partial", "contradicts", "insufficient", "not-needed"].includes(
    answer,
  );

const currentPassiveEvidence = (
  evidence: PassiveEvidence[],
  codeRevision: number,
) =>
  evidence.some(
    (item) =>
      item.revision === codeRevision &&
      (item.kind === "code-change" || item.kind === "test-pass"),
  );

/**
 * Local aggregation never assigns evidence to a task. It only prevents a
 * positive Jev judgment from escaping without current passive candidates.
 */
export function aggregateImplementation(
  criteria: string[],
  answers: string[],
  evidence: PassiveEvidence[],
  codeRevision: number,
  evidenceComplete = true,
): ImplementationLabel {
  if (!criteria.length) return "unverified";
  const bounded = criteria.map((_, index) =>
    answers[index] && recognizedAnswer(answers[index])
      ? answers[index]
      : "insufficient",
  );
  if (bounded.includes("contradicts")) return "contradicted";
  const applicable = bounded.filter((answer) => answer !== "not-needed");
  if (!applicable.length) return "not-needed";
  if (!currentPassiveEvidence(evidence, codeRevision)) return "unverified";
  if (evidenceComplete && applicable.every((answer) => answer === "supports"))
    return "appears complete";
  if (
    applicable.some((answer) => answer === "supports" || answer === "partial")
  )
    return "partial";
  return "unverified";
}

const acceptedChoice = (result: ValidatedResult | undefined, index: number) => {
  const answer = result?.answers[`criterion:${index}`];
  if (
    answer?.type !== "choice" ||
    !recognizedAnswer(answer.choice) ||
    answer.confidence < 0.5 ||
    (answer.probabilities[answer.choice] ?? 0) < 0.8
  )
    return "insufficient" as const;
  return answer.choice;
};

export function implementationFromResult(
  criteria: string[],
  result: ValidatedResult | undefined,
  evidence: PassiveEvidence[],
  codeRevision: number,
  evidenceComplete = true,
): ImplementationLabel {
  return aggregateImplementation(
    criteria,
    criteria.map((_, index) => acceptedChoice(result, index)),
    evidence,
    codeRevision,
    evidenceComplete,
  );
}
