import type { EvaluationRequest, ValidatedResult } from "../analysis/gateway";
import { MODEL } from "../analysis/gateway";
import type { Ledger, ReportState, SourceTask, Task } from "../core/types";
import { fits } from "./candidates";

type ScopeRelation =
  | `same:${string}`
  | `revised:${string}`
  | "new"
  | "context"
  | "ambiguous";
const reportStates = new Set<ReportState>([
  "done",
  "reopened",
  "not-started",
  "in-progress",
  "cancelled",
  "unknown",
  "conflict",
]);

export interface ScopeAnswers {
  [key: number]: ScopeRelation;
  current: string | "unknown";
  scope: "continue" | "new-goal" | "ambiguous";
  states?: Record<number, ReportState | undefined>;
}
export interface ScopeChunk {
  indexes: number[];
  request: EvaluationRequest;
}

const sufficientChoice = (
  result: ValidatedResult,
  id: string,
  fallback: string,
): string => {
  const answer = result.answers[id];
  if (answer?.type !== "choice") return fallback;
  const probability = answer.probabilities[answer.choice] ?? 0;
  return answer.confidence >= 0.5 && probability >= 0.8
    ? answer.choice
    : fallback;
};

/**
 * Builds one complete relation transaction request. Each candidate has both a
 * relation and same-observation status question, so scopeChunks keeps it below
 * the 20-question/24KiB gateway bounds.
 */
function scopeRequest(
  ledger: Ledger,
  candidates: SourceTask[],
  indexes = candidates.map((_, index) => index),
): EvaluationRequest {
  if (indexes.length !== candidates.length)
    throw new Error("Invalid scope candidate indexes");
  const meanings = Object.fromEntries(
    ledger.tasks
      .filter((task) => task.included)
      .flatMap((task) => [
        [
          `same:${task.id}`,
          `Same bounded work as ${JSON.stringify(task.text)} with criteria ${JSON.stringify(task.criteria)}`,
        ],
        [
          `revised:${task.id}`,
          `Materially expanded or changed version of ${JSON.stringify(task.text)}`,
        ],
      ]),
  );
  const candidateChoices = Object.fromEntries(
    candidates.map((candidate, index) => [
      `candidate:${indexes[index]}`,
      `Newly supplied candidate ${JSON.stringify(candidate.text)}`,
    ]),
  );
  return {
    model: MODEL,
    state: {
      goal: ledger.tasks
        .filter((task) => task.included)
        .map(({ id, text, criteria, status, revision }) => ({
          id,
          text,
          criteria,
          status,
          revision,
        })),
      candidates: candidates.map(
        ({ text, criteria, ref, revision }, index) => ({
          index: indexes[index],
          text,
          criteria,
          ref,
          revision,
        }),
      ),
    },
    questions: {
      ...Object.fromEntries(
        candidates.flatMap((candidate, index) => {
          const candidateIndex = indexes[index];
          return [
            [
              String(candidateIndex),
              {
                type: "choice" as const,
                instructions: `Relate exact candidate ${JSON.stringify(candidate.text)} to current goal tasks. Similar wording alone is insufficient. Same requires same work and boundaries; revised means prior completion cannot transfer. Quotes, alternatives and hypotheticals are context. Uncertain identity is ambiguous.`,
                criteria: {
                  ...meanings,
                  new: "New committed work in the current goal",
                  context: "Not committed work",
                  ambiguous: "Identity or commitment is unresolved",
                },
              },
            ],
            [
              `status:${candidateIndex}`,
              {
                type: "choice" as const,
                instructions: `Does this same supplied observation contain an explicit actual status assertion for candidate ${JSON.stringify(candidate.text)}? Do not infer status from activity, plans, quotations, examples or intentions.`,
                criteria: {
                  done: "Explicitly reports this work finished",
                  reopened: "Explicitly reopens this work",
                  cancelled: "Explicitly cancels this work",
                  "not-started": "Explicitly reports this work not started",
                  "in-progress": "Explicitly reports this work in progress",
                  unknown: "Explicitly reports this work status unknown",
                  "not-a-report": "No explicit actual status assertion",
                  ambiguous: "Conflicting or ambiguous status assertion",
                },
              },
            ],
          ];
        }),
      ),
      current: {
        type: "choice",
        instructions:
          "Infer current task only from actual user direction or assistant present-work statement. Never default to first unchecked. Unknown remains unknown.",
        criteria: {
          ...Object.fromEntries(
            ledger.tasks
              .filter((task) => task.included)
              .map((task) => [task.id, task.text]),
          ),
          ...candidateChoices,
          unknown: "No unambiguous current task",
        },
      },
      scope: {
        type: "choice",
        instructions:
          "Does supplied candidate continue current conversational goal, clearly establish a new goal, or leave scope ambiguous? Uncertainty must remain ambiguous.",
        criteria: {
          continue: "Continues current goal",
          "new-goal": "Clear new user goal replacing active denominator",
          ambiguous: "Cannot safely determine goal boundary",
        },
      },
    },
  };
}

/** Every candidate eventually gets a transaction question; no first-page cutoff. */
export function scopeChunks(
  ledger: Ledger,
  candidates: SourceTask[],
): ScopeChunk[] {
  const chunks: ScopeChunk[] = [];
  let group: SourceTask[] = [];
  let indexes: number[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const next = [...group, candidate];
    const nextIndexes = [...indexes, index];
    const request = scopeRequest(ledger, next, nextIndexes);
    if (!fits(request)) {
      if (!group.length)
        throw new Error("Essential scope evidence exceeds request limits");
      chunks.push({ indexes, request: scopeRequest(ledger, group, indexes) });
      group = [candidate];
      indexes = [index];
      if (!fits(scopeRequest(ledger, group, indexes)))
        throw new Error("Essential scope evidence exceeds request limits");
    } else {
      group = next;
      indexes = nextIndexes;
    }
  }
  if (group.length)
    chunks.push({ indexes, request: scopeRequest(ledger, group, indexes) });
  return chunks;
}

export function scopeAnswers(
  candidates: SourceTask[],
  result: ValidatedResult,
  indexes = candidates.map((_, index) => index),
): ScopeAnswers {
  const states: Record<number, ReportState | undefined> = {};
  const relations = Object.fromEntries(
    indexes.map((index) => [
      index,
      sufficientChoice(result, String(index), "ambiguous") as ScopeRelation,
    ]),
  );
  for (const index of indexes) {
    const answer = sufficientChoice(result, `status:${index}`, "ambiguous");
    states[index] =
      answer === "not-a-report"
        ? undefined
        : answer === "ambiguous"
          ? "conflict"
          : reportStates.has(answer as ReportState)
            ? (answer as ReportState)
            : "conflict";
  }
  const current = sufficientChoice(result, "current", "unknown");
  const scope = sufficientChoice(result, "scope", "ambiguous");
  return {
    ...relations,
    current,
    scope:
      scope === "continue" || scope === "new-goal" || scope === "ambiguous"
        ? scope
        : "ambiguous",
    states,
  } as ScopeAnswers;
}

/**
 * Applies a fully validated scope transaction. Ambiguous/global-inconsistent
 * answers cannot add work, remove work, transfer completion, or pick current.
 */
export function applyScopeRelations(
  ledger: Ledger,
  candidates: SourceTask[],
  answers: ScopeAnswers,
): Ledger {
  if (answers.scope === "ambiguous")
    return { ...ledger, currentTaskId: undefined };

  const tasks = ledger.tasks.map((task) => ({
    ...task,
    criteria: [...task.criteria],
    ...(task.criterionRefs
      ? { criterionRefs: task.criterionRefs.map((ref) => ({ ...ref })) }
      : {}),
    ref: { ...task.ref },
  }));
  const existing = new Map(tasks.map((task) => [task.id, task]));
  // A clear new goal may not also silently retain a relation to the archived
  // goal. Treat that contradictory answer as uncertainty before mutation.
  if (
    answers.scope === "new-goal" &&
    candidates.some((_, index) => {
      const relation = answers[index];
      return relation?.startsWith("same:") || relation?.startsWith("revised:");
    })
  )
    return { ...ledger, currentTaskId: undefined };

  let nextTaskId = ledger.nextTaskId;
  let changed = answers.scope === "new-goal";
  if (answers.scope === "new-goal")
    for (const task of tasks) task.included = false;

  const candidateIds = new Map<number, string>();
  for (const [index, candidate] of candidates.entries()) {
    const relation = answers[index];
    if (!relation || relation === "context" || relation === "ambiguous")
      continue;
    let target: Task | undefined;
    if (relation === "new") {
      const id = `${ledger.sourceId}:task:${nextTaskId++}`;
      target = {
        ...candidate,
        criteria: [...candidate.criteria],
        ...(candidate.criterionRefs
          ? {
              criterionRefs: candidate.criterionRefs.map((ref) => ({ ...ref })),
            }
          : {}),
        ref: { ...candidate.ref },
        id,
        included: true,
      };
      tasks.push(target);
      existing.set(id, target);
      candidateIds.set(index, id);
      changed = true;
    } else {
      const [kind, id] = relation.split(":", 2);
      const prior = id ? existing.get(id) : undefined;
      if (!prior?.included) return { ...ledger, currentTaskId: undefined };
      target = prior;
      candidateIds.set(index, prior.id);
      if (kind === "revised") {
        Object.assign(prior, candidate, {
          criteria: [...candidate.criteria],
          ...(candidate.criterionRefs
            ? {
                criterionRefs: candidate.criterionRefs.map((ref) => ({
                  ...ref,
                })),
              }
            : {}),
          ref: { ...candidate.ref },
          id: prior.id,
          included: true,
          status: "not-started",
        });
        changed = true;
      } else if (kind !== "same")
        return { ...ledger, currentTaskId: undefined };
    }
    const status = answers.states?.[index];
    if (target && status) target.status = status;
  }

  const requestedCurrent = answers.current.startsWith("candidate:")
    ? candidateIds.get(Number(answers.current.slice("candidate:".length)))
    : answers.current;
  const activeCurrent = tasks.find(
    (task) =>
      task.id === requestedCurrent &&
      task.included &&
      task.status !== "cancelled",
  );
  const revision = Number(ledger.scopeRevision.split(":").at(-1) ?? 0) + 1;
  return {
    ...ledger,
    tasks,
    nextTaskId,
    scopeRevision: changed
      ? `${ledger.scopeRevision.replace(/:\d+$/, "")}:${revision}`
      : ledger.scopeRevision,
    ...(activeCurrent
      ? { currentTaskId: activeCurrent.id }
      : { currentTaskId: undefined }),
  };
}
