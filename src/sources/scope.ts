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
// [tag:response_identity_transfer] A settled answer cannot satisfy fresh response work.
// Jev still chooses new/revised/context; this only excludes an invalid identity transfer.
const workKindOf = (task: Pick<SourceTask, "workKind">) =>
  task.workKind ?? "action";
const sameIsAllowed = (task: SourceTask) =>
  workKindOf(task) !== "response" ||
  (task.status !== "done" && task.status !== "cancelled");

function scopeRequest(
  ledger: Ledger,
  candidates: SourceTask[],
  indexes = candidates.map((_, index) => index),
): EvaluationRequest {
  if (indexes.length !== candidates.length)
    throw new Error("Invalid scope candidate indexes");
  const meaningsFor = (candidate: SourceTask) =>
    Object.fromEntries(
      ledger.tasks
        .filter(
          (task) => task.included && workKindOf(task) === workKindOf(candidate),
        )
        .flatMap((task) => [
          ...(sameIsAllowed(task)
            ? [
                [
                  `same:${task.id}`,
                  workKindOf(candidate) === "action"
                    ? `Same requested deliverable or answer and boundaries as ${JSON.stringify(task.text)} with criteria ${JSON.stringify(task.criteria)}; shared project topic alone is not same`
                    : `Same outstanding response outcome: ${JSON.stringify(task.text)}; not merely the same topic`,
                ],
              ]
            : []),
          [
            `revised:${task.id}`,
            workKindOf(candidate) === "action"
              ? `Same deliverable or answer materially changed from ${JSON.stringify(task.text)}; prior completion cannot transfer`
              : `Changed requirements of this exact bounded task, not added work under a broad goal or repeat delivery: ${JSON.stringify(task.text)} [${task.status}]`,
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
        .map(({ id, text, workKind, criteria, status, revision }) => ({
          id,
          text,
          workKind,
          criteria,
          status,
          revision,
        })),
      allCurrentTasksSettled: ledger.tasks
        .filter((task) => task.included)
        .every((task) => task.status === "done" || task.status === "cancelled"),
      candidates: candidates.map(
        ({ text, workKind, criteria, ref, revision }, index) => ({
          index: indexes[index],
          text,
          workKind: workKind ?? "action",
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
                // Distinct Jev-derived deliverables use separate identity rubrics.
                instructions:
                  workKindOf(candidate) === "action"
                    ? `Relate exact candidate ${JSON.stringify(candidate.text)} to current goal tasks. Similar wording alone is insufficient. A substantive user question, request for explanation/status/plan or correction requiring its own answer is distinct new work in the continued goal, even when it refers to an existing task; do not turn that request into a status mutation of the existing task. When state.allCurrentTasksSettled is true, a distinct fresh user assignment is new rather than same/revised merely because it shares a project topic. A short approval or clarification that only refers to existing work is context, not a duplicate task. Same requires same work and boundaries; revised means prior completion cannot transfer. A new request for another answer does not inherit an earlier task's completion. Quotes, alternatives, reports and hypotheticals are context. Uncertain identity is ambiguous.`
                    : `Relate exact candidate ${JSON.stringify(candidate.text)} to current goal tasks. Similar wording alone is insufficient. A substantive user question, request for explanation/status/plan or correction requiring its own answer is distinct new work in the continued goal, even when it refers to an existing task; do not turn that request into a status mutation of the existing task. For a response candidate, a fresh user request after matching response work is done needs a new delivery even if question/topic wording is identical: choose new, never same/revised, because the historical answer cannot satisfy this later request. When state.allCurrentTasksSettled is true, a distinct fresh user assignment is new rather than same/revised merely because it shares a project topic. A short approval or clarification that only refers to existing work is context, not a duplicate task. Same requires same currently outstanding work and boundaries; revised means prior completion cannot transfer. Quotes, alternatives, reports and hypotheticals are context. Uncertain identity is ambiguous.`,
                criteria: {
                  ...meaningsFor(candidate),
                  new:
                    workKindOf(candidate) === "action"
                      ? "Distinct requested deliverable or answer, whether in continued work or a fresh goal"
                      : "New bounded outcome, including distinct added work after a completed goal or another delivery of a previously completed answer; can continue the goal",
                  context:
                    "Background, acknowledgement, boundary, report or other text with no requested action or answer",
                  ambiguous: "Identity or commitment is unresolved",
                },
              },
            ],
            [
              `status:${candidateIndex}`,
              {
                type: "choice" as const,
                instructions: `Does this same supplied observation contain an explicit actual status assertion for candidate ${JSON.stringify(candidate.text)} itself? This applies only to the candidate's requested work, never an underlying existing task it mentions. Do not infer status from activity, plans, quotations, examples or intentions.`,
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
          "Infer current task only from actual user direction or assistant present-work statement. When a fresh direct user assignment is distinct and state.allCurrentTasksSettled is true, choose its supplied candidate rather than a completed historical task. Never default to first unchecked. Unknown remains unknown.",
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
          "Does supplied candidate continue current conversational goal, clearly establish a new goal, or leave scope ambiguous? When state.allCurrentTasksSettled is true and every substantive candidate is distinct new work, choose new-goal: do not continue a broad historical goal or retain its denominator. A related status question must not archive unfinished implementation. Approval or clarification alone normally continues existing work. Uncertainty must remain ambiguous.",
        criteria: {
          continue:
            "Continues unfinished current goal, including a separate requested answer while active work remains",
          "new-goal":
            "Fresh user assignment after current goal is settled, or explicit replacement; replaces the old denominator",
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
    // Low-confidence status is no status: only an explicit, sufficiently
    // concentrated ambiguous answer may transfer conflict to an existing task.
    const answer = result.answers[`status:${index}`];
    const probability =
      answer?.type === "choice"
        ? (answer.probabilities[answer.choice] ?? 0)
        : 0;
    if (
      answer?.type !== "choice" ||
      answer.confidence < 0.5 ||
      probability < 0.8 ||
      answer.choice === "not-a-report"
    ) {
      states[index] = undefined;
      continue;
    }
    states[index] =
      answer.choice === "ambiguous"
        ? "conflict"
        : reportStates.has(answer.choice as ReportState)
          ? (answer.choice as ReportState)
          : undefined;
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

/** True only when every candidate relation can commit as one scope transaction. */
export function scopeTransactionIsAdmissible(
  ledger: Ledger,
  candidates: SourceTask[],
  answers: ScopeAnswers,
): boolean {
  if (answers.scope === "ambiguous") return false;
  let newTasks = 0;
  for (const [index, candidate] of candidates.entries()) {
    const relation = answers[index];
    if (!relation || relation === "ambiguous") return false;
    if (relation === "new") {
      newTasks++;
      continue;
    }
    if (relation === "context") continue;
    const separator = relation.indexOf(":");
    const kind = relation.slice(0, separator);
    const id = relation.slice(separator + 1);
    const existing = ledger.tasks.find(
      (task) => task.id === id && task.included,
    );
    // [ref:response_identity_transfer] Enforce the option constraint at admission too.
    if (
      (kind !== "same" && kind !== "revised") ||
      !id ||
      !existing ||
      workKindOf(existing) !== workKindOf(candidate) ||
      (kind === "same" && !sameIsAllowed(existing))
    )
      return false;
    if (answers.scope === "new-goal") return false;
  }
  return answers.scope !== "new-goal" || newTasks > 0;
}

/**
 * Applies one complete validated scope transaction. Unresolved relations never
 * add work, archive work, transfer completion, or pick current work.
 */
export function applyScopeRelations(
  ledger: Ledger,
  candidates: SourceTask[],
  answers: ScopeAnswers,
): Ledger {
  if (!scopeTransactionIsAdmissible(ledger, candidates, answers))
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
  let nextTaskId = ledger.nextTaskId;
  let changed = answers.scope === "new-goal";
  if (answers.scope === "new-goal")
    for (const task of tasks) task.included = false;

  const candidateIds = new Map<number, string>();
  for (const [index, candidate] of candidates.entries()) {
    const relation = answers[index];
    if (relation === "context") continue;
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
      const separator = relation.indexOf(":");
      const kind = relation.slice(0, separator);
      const id = relation.slice(separator + 1);
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
