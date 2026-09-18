import type { EvaluationRequest, ValidatedResult } from "../analysis/gateway";
import { MODEL } from "../analysis/gateway";
import type { Ledger, SourceTask, Task } from "../core/types";

type ScopeRelation =
  | `same:${string}`
  | `revised:${string}`
  | "new"
  | "context"
  | "ambiguous";
export interface ScopeAnswers {
  [key: number]: ScopeRelation;
  current: string | "unknown";
  scope: "continue" | "new-goal" | "ambiguous";
}

export function scopeRequest(
  ledger: Ledger,
  candidates: SourceTask[],
): EvaluationRequest {
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
  return {
    model: MODEL,
    state: {
      goal: ledger.tasks
        .filter((task) => task.included)
        .map(({ id, text, criteria, status }) => ({
          id,
          text,
          criteria,
          status,
        })),
      candidates: candidates.map(({ text, criteria, ref }, index) => ({
        index,
        text,
        criteria,
        ref,
      })),
    },
    questions: {
      ...Object.fromEntries(
        candidates.map((candidate, index) => [
          String(index),
          {
            type: "choice" as const,
            instructions: `Relate exact candidate ${JSON.stringify(candidate.text)} to current goal tasks. Similar wording alone is insufficient. Same requires same work and boundaries; revised means prior completion cannot transfer. Quotes, alternatives and hypotheticals are context.`,
            criteria: {
              ...meanings,
              new: "New committed work in the current goal",
              context: "Not committed work",
              ambiguous: "Identity or commitment is unresolved",
            },
          },
        ]),
      ),
      current: {
        type: "choice",
        instructions:
          "Infer current task only from actual user direction or assistant present-work statement. Never default to first unchecked.",
        criteria: {
          ...Object.fromEntries(
            ledger.tasks
              .filter((task) => task.included)
              .map((task) => [task.id, task.text]),
          ),
          unknown: "No unambiguous current task",
        },
      },
      scope: {
        type: "choice",
        instructions:
          "Does supplied candidate continue current conversational goal, clearly establish a new goal, or leave scope ambiguous?",
        criteria: {
          continue: "Continues current goal",
          "new-goal": "Clear new user goal replacing active denominator",
          ambiguous: "Cannot safely determine goal boundary",
        },
      },
    },
  };
}

export function scopeAnswers(
  candidates: SourceTask[],
  result: ValidatedResult,
): ScopeAnswers {
  const answer = (id: string) => {
    const value = result.answers[id];
    if (value?.type !== "choice") throw new Error("Incomplete scope result");
    return value.choice;
  };
  return Object.assign(
    Object.fromEntries(
      candidates.map((_, index) => [index, answer(String(index))]),
    ),
    { current: answer("current"), scope: answer("scope") },
  ) as ScopeAnswers;
}

export function applyScopeRelations(
  ledger: Ledger,
  candidates: SourceTask[],
  answers: ScopeAnswers,
): Ledger {
  const tasks = ledger.tasks.map((task) => ({ ...task }));
  const existing = new Map(tasks.map((task) => [task.id, task]));
  let nextTaskId = ledger.nextTaskId;
  let changed = answers.scope === "new-goal";
  if (answers.scope === "new-goal")
    for (const task of tasks) task.included = false;

  for (const [index, candidate] of candidates.entries()) {
    const relation = answers[index];
    if (!relation || relation === "context" || relation === "ambiguous")
      continue;
    if (relation === "new") {
      const id = `${ledger.sourceId}:task:${nextTaskId++}`;
      const added: Task = { ...candidate, id, included: true };
      tasks.push(added);
      existing.set(id, added);
      changed = true;
      continue;
    }
    const [kind, id] = relation.split(":", 2);
    const prior = id ? existing.get(id) : undefined;
    if (!prior?.included) throw new Error("Unknown scope relation task");
    if (kind === "revised") {
      Object.assign(prior, candidate, {
        id: prior.id,
        included: true,
        status: "not-started",
      });
      changed = true;
    } else if (kind !== "same") throw new Error("Invalid scope relation");
  }

  const activeCurrent = tasks.find(
    (task) => task.id === answers.current && task.included,
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
