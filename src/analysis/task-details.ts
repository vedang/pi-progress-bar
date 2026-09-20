import { createHash } from "node:crypto";
import { normalizedChoiceAssessment, requestHash } from "../core/hybrid-proof";
import type {
  Assessment,
  HybridState,
  NormalizedPatch,
  Observation,
  ObservationRef,
  SourceRef,
} from "../core/hybrid-state";
import { exactQuoteSource, type GroundedDetailDraft } from "./extractor";
import type { EvaluationRequest, ValidatedResult } from "./gateway";

export type DetailKey =
  | "title"
  | "description"
  | `acceptance:${0 | 1 | 2 | 3 | 4 | 5}`;

export interface DetailCandidate {
  key: DetailKey;
  source: SourceRef;
}

export interface DetailBatchReceipt {
  requestHash: string;
  candidateKeys: DetailKey[];
  assessments: Assessment[];
  validatedAt: number;
}

/** Durable optional facts; quote text remains canonical-only. */
export interface TaskDetailRecord {
  taskId: string;
  revision: number;
  label: string;
  taskSource: SourceRef;
  candidates: DetailCandidate[];
  receipts: DetailBatchReceipt[];
}

export type DetailObservationResolver = (
  entryId: string,
) => Observation | undefined;

const detailChoices = new Set(["yes", "no", "uncertain"]);
const keyOrder = (key: DetailKey) =>
  key === "title" ? 0 : key === "description" ? 1 : 2 + Number(key.slice(11));

export const detailQuestionKeys = (request: EvaluationRequest) =>
  Object.keys(request.questions).filter((key) => key.startsWith("detail:"));

export const isDetailRequest = (request: EvaluationRequest) =>
  detailQuestionKeys(request).length > 0;

const sourceMatches = (left: SourceRef, right: SourceRef) =>
  left.entryId === right.entryId &&
  left.messageHash === right.messageHash &&
  left.role === right.role &&
  left.start === right.start &&
  left.end === right.end &&
  left.quoteHash === right.quoteHash;

const taskFor = (
  draft: GroundedDetailDraft,
  before: HybridState,
  outcome: NormalizedPatch,
  patched: HybridState,
) => {
  const id =
    draft.operation === "add"
      ? outcome.add[draft.index]
        ? `task:${before.nextTaskId + draft.index}`
        : undefined
      : draft.operation === "revise"
        ? outcome.revise[draft.index]?.id
        : outcome.restore[draft.index]?.id;
  return id ? patched.tasks.find((task) => task.id === id) : undefined;
};

/** Bind optional parser drafts only after mandatory patch reduction succeeds. */
export function bindTaskDetailOffers(
  grounded: readonly GroundedDetailDraft[],
  before: HybridState,
  outcome: NormalizedPatch,
  patched: HybridState,
): TaskDetailRecord[] {
  return grounded.flatMap((draft) => {
    const task = taskFor(draft, before, outcome, patched);
    if (!task || !draft.candidates.length) return [];
    const candidates = [...draft.candidates]
      .sort((left, right) => keyOrder(left.key) - keyOrder(right.key))
      .map((candidate) => ({
        key: candidate.key,
        source: { ...candidate.source },
      }));
    if (
      candidates.length > 8 ||
      new Set(candidates.map((candidate) => candidate.key)).size !==
        candidates.length
    )
      return [];
    return [
      {
        taskId: task.id,
        revision: task.revision,
        label: task.label,
        taskSource: { ...task.source },
        candidates,
        receipts: [],
      },
    ];
  });
}

const resolvedQuote = (
  candidate: DetailCandidate,
  resolve: DetailObservationResolver,
) => {
  const observation = resolve(candidate.source.entryId);
  if (
    !observation ||
    observation.hash !== candidate.source.messageHash ||
    observation.role !== candidate.source.role ||
    candidate.source.start < 0 ||
    candidate.source.end > observation.text.length ||
    candidate.source.end <= candidate.source.start
  )
    return;
  const quote = observation.text.slice(
    candidate.source.start,
    candidate.source.end,
  );
  if (
    createHash("sha256").update(quote).digest("hex") !==
    candidate.source.quoteHash
  )
    return;
  try {
    const exact = exactQuoteSource(quote, observation);
    return exact.start === candidate.source.start &&
      exact.end === candidate.source.end
      ? quote
      : undefined;
  } catch {
    return;
  }
};

/** Build one bounded task-local Jev request from canonical spans only. */
export function taskDetailRequest(
  record: TaskDetailRecord,
  candidateKeys: readonly DetailKey[],
  resolve: DetailObservationResolver,
): EvaluationRequest | undefined {
  if (!candidateKeys.length || candidateKeys.length > 20) return;
  const candidates = candidateKeys.map((key) => {
    const candidate = record.candidates.find((item) => item.key === key);
    const quote = candidate && resolvedQuote(candidate, resolve);
    return candidate && quote ? { candidate, quote } : undefined;
  });
  if (candidates.some((candidate) => !candidate)) return;
  const safe = candidates as { candidate: DetailCandidate; quote: string }[];
  const request: EvaluationRequest = {
    model: "jev-1.13.0",
    state: {
      task: {
        id: record.taskId,
        label: record.label,
        revision: record.revision,
      },
      candidates: safe.map(({ candidate, quote }) => ({
        key: candidate.key,
        quote,
      })),
    },
    questions: Object.fromEntries(
      safe.map(({ candidate, quote }) => [
        `detail:${candidate.key}`,
        {
          type: "choice" as const,
          instructions:
            "Is this an exact, task-local requested detail? Answer yes only for the supplied exact quote; never paraphrase or infer.",
          criteria: {
            yes: `Exact task-local quote: ${quote}`,
            no: "Not an exact requested task detail",
            uncertain: "Insufficiently grounded",
          },
        },
      ]),
    ),
  };
  return Buffer.byteLength(JSON.stringify(request)) <= 24 * 1024
    ? request
    : undefined;
}

const candidatePrefix = (record: TaskDetailRecord) =>
  record.receipts.flatMap((receipt) => receipt.candidateKeys);

export const uncoveredDetailKeys = (record: TaskDetailRecord) =>
  record.candidates
    .map((candidate) => candidate.key)
    .slice(candidatePrefix(record).length);

/** Normalized outcome contains no provider envelope or source quote text. */
export function detailReceipt(
  record: TaskDetailRecord,
  request: EvaluationRequest,
  result: ValidatedResult,
  validatedAt: number,
): DetailBatchReceipt | undefined {
  if (!Number.isSafeInteger(validatedAt) || validatedAt < 0) return;
  const keys = detailQuestionKeys(request).map((key) =>
    key.slice("detail:".length),
  ) as DetailKey[];
  if (!keys.length || keys.length > 20) return;
  const candidates = keys.map((key) =>
    record.candidates.find((candidate) => candidate.key === key),
  );
  if (candidates.some((candidate) => !candidate)) return;
  const safeCandidates = candidates as DetailCandidate[];
  const assessments = safeCandidates.map((candidate, index) => {
    const answer = result.answers[`detail:${keys[index]}`];
    return answer?.type === "choice"
      ? normalizedChoiceAssessment(
          answer.choice,
          answer.confidence,
          answer.probabilities[answer.choice],
          {
            entryId: candidate.source.entryId,
            messageHash: candidate.source.messageHash,
            role: candidate.source.role,
          } satisfies ObservationRef,
          detailChoices,
        )
      : undefined;
  });
  if (assessments.some((assessment) => !assessment)) return;
  return {
    requestHash: requestHash(request),
    candidateKeys: [...keys],
    assessments: assessments as Assessment[],
    validatedAt,
  };
}

interface MaterializedDetailValue {
  text: string;
  provenance: {
    role: Observation["role"];
    validatedAt: number;
    confidence: number;
    probability: number;
  };
}

export interface MaterializedTaskDetails {
  title?: MaterializedDetailValue;
  description?: MaterializedDetailValue;
  acceptanceCriteria?: MaterializedDetailValue[];
}

/** Resolve accepted spans only at projection time; no text enters checkpoint state. */
export function materializeTaskDetails(
  record: TaskDetailRecord,
  resolve: DetailObservationResolver,
): MaterializedTaskDetails | undefined {
  const accepted = new Map<DetailKey, DetailBatchReceipt>();
  for (const receipt of record.receipts)
    receipt.candidateKeys.forEach((key, index) => {
      const assessment = receipt.assessments[index];
      if (assessment?.reason === "accepted" && assessment.rawChoice === "yes")
        accepted.set(key, receipt);
    });
  const values = record.candidates.flatMap((candidate) => {
    const receipt = accepted.get(candidate.key);
    const index = receipt?.candidateKeys.indexOf(candidate.key) ?? -1;
    const assessment = index >= 0 ? receipt?.assessments[index] : undefined;
    const text =
      receipt && assessment ? resolvedQuote(candidate, resolve) : undefined;
    return receipt && assessment && text
      ? [
          {
            key: candidate.key,
            value: {
              text,
              provenance: {
                role: candidate.source.role,
                validatedAt: receipt.validatedAt,
                confidence: assessment.confidence,
                probability: assessment.probability,
              },
            },
          },
        ]
      : [];
  });
  const title = values.find((value) => value.key === "title")?.value;
  const description = values.find(
    (value) => value.key === "description",
  )?.value;
  const acceptanceCriteria = values
    .filter((value) => value.key.startsWith("acceptance:"))
    .map((value) => value.value);
  return title || description || acceptanceCriteria.length
    ? {
        ...(title
          ? { title: { ...title, provenance: { ...title.provenance } } }
          : {}),
        ...(description
          ? {
              description: {
                ...description,
                provenance: { ...description.provenance },
              },
            }
          : {}),
        ...(acceptanceCriteria.length
          ? {
              acceptanceCriteria: acceptanceCriteria.map((value) => ({
                ...value,
                provenance: { ...value.provenance },
              })),
            }
          : {}),
      }
    : undefined;
}

export const detailRecordMatchesTask = (
  record: TaskDetailRecord,
  task: { id: string; revision: number; label: string; source: SourceRef },
) =>
  record.taskId === task.id &&
  record.revision === task.revision &&
  record.label === task.label &&
  sourceMatches(record.taskSource, task.source);
