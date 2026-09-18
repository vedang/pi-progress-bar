import type { PassiveEvidence } from "../sources/evidence";
import type { ValidatedResult } from "./gateway";

export type ImplementationLabel =
  | "appears complete"
  | "partial"
  | "contradicted"
  | "unverified";

type CriterionAnswer = "supports" | "contradicts" | "insufficient";
export function aggregateImplementation(
  criteria: string[],
  answers: string[],
  evidence: PassiveEvidence[],
  codeRevision: number,
): ImplementationLabel {
  if (!criteria.length) return "unverified";
  const bounded = answers.slice(0, criteria.length);
  if (bounded.includes("contradicts")) return "contradicted";
  const currentEvidence = evidence.some(
    (item) => item.revision === codeRevision && item.kind !== "observed-red",
  );
  if (!currentEvidence) return "unverified";
  if (
    bounded.length === criteria.length &&
    bounded.every((answer) => answer === "supports")
  )
    return "appears complete";
  if (bounded.some((answer) => answer === "supports")) return "partial";
  return "unverified";
}

export function implementationFromResult(
  criteria: string[],
  result: ValidatedResult | undefined,
  evidence: PassiveEvidence[],
  codeRevision: number,
): ImplementationLabel {
  const answers: CriterionAnswer[] = criteria.flatMap((_, index) => {
    const answer = result?.answers[`criterion:${index}`];
    return answer?.type === "choice" &&
      ["supports", "contradicts", "insufficient"].includes(answer.choice)
      ? [answer.choice as CriterionAnswer]
      : [];
  });
  return aggregateImplementation(criteria, answers, evidence, codeRevision);
}
