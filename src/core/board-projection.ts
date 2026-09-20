import type { HealthCard } from "./hybrid-checkpoint";
import {
  type HybridState,
  type HybridTask,
  tasksNewestFirst,
} from "./hybrid-state";

type BoardTaskStatus = "OPEN" | "INPROG" | "DONE" | "ARCHIVED";
type BoardHealthProvenance =
  | "unassessed"
  | "current"
  | "retained"
  | "stale"
  | "replacement-pending";

interface BoardHealth {
  requirements: string;
  acceptance: string;
  newRedTest: string;
  redEvidence: string;
  implementation: string;
}

interface BoardTask {
  taskId: string;
  label: string;
  revision: number;
  kind: string;
  included: boolean;
  status: BoardTaskStatus;
  health: BoardHealth;
  provenance: {
    state: BoardHealthProvenance;
    assessedAt?: number;
    role?: string;
  };
  /** Safe lifecycle names only; source payloads never enter presentation. */
  transitions: { kind: string }[];
}

export interface BoardSnapshot {
  tasks: BoardTask[];
  currentTask?: {
    taskId: string;
    status: "OPEN" | "INPROG" | "DONE";
    qualifier?: string;
  };
  service: { code: string; label: string };
}

const unassessed = (): BoardHealth => ({
  requirements: "Unassessed",
  acceptance: "Unassessed",
  newRedTest: "Unassessed",
  redEvidence: "Unassessed",
  implementation: "Unassessed",
});

const sameSource = (task: HybridTask, card: HealthCard) =>
  task.revision === card.revision &&
  task.label === card.label &&
  task.source.entryId === card.provenance.taskSource.entryId &&
  task.source.messageHash === card.provenance.taskSource.messageHash &&
  task.source.role === card.provenance.taskSource.role &&
  task.source.start === card.provenance.taskSource.start &&
  task.source.end === card.provenance.taskSource.end &&
  task.source.quoteHash === card.provenance.taskSource.quoteHash;

const statusFor = (
  task: HybridTask,
  focusedTaskId: string | undefined,
): BoardTaskStatus => {
  if (!task.included) return "ARCHIVED" as const;
  if (task.status === "done") return "DONE" as const;
  return task.id === focusedTaskId ? "INPROG" : ("OPEN" as const);
};

/**
 * Projection boundary for task board. It accepts detached state/metadata only
 * and neither owns nor receives a monitor/history/provider capability.
 */
export function projectBoard(input: {
  state: HybridState;
  healthCards: ReadonlyMap<string, HealthCard>;
  service: { code: string; label: string };
  unsettled: boolean;
  /** Live proof exists only in this monitor epoch; restored cards stay retained. */
  currentHealthTaskId?: string;
  /** Accepted replacement is pending; old health stays visible but never current. */
  pendingHealthTaskId?: string;
  lastDisplayedTaskId?: string;
}): BoardSnapshot {
  const focusedTaskId = input.unsettled ? undefined : input.state.focusTaskId;
  const transitions = new Map<string, { kind: string }[]>();
  for (const event of input.state.events) {
    const items = transitions.get(event.taskId) ?? [];
    items.push({ kind: event.kind });
    transitions.set(event.taskId, items);
  }
  const tasks = tasksNewestFirst(input.state).map((task) => {
    const card = input.healthCards.get(task.id);
    const sourceMatches = !!card && sameSource(task, card);
    const status = statusFor(task, focusedTaskId);
    const health = sourceMatches ? { ...card.health } : unassessed();
    const provenance = !card
      ? { state: "unassessed" as const }
      : !sourceMatches
        ? { state: "stale" as const }
        : input.pendingHealthTaskId === task.id
          ? {
              state: "replacement-pending" as const,
              assessedAt: card.assessedAt,
              role: card.provenance.observation.role,
            }
          : status === "INPROG" && input.currentHealthTaskId === task.id
            ? {
                state: "current" as const,
                assessedAt: card.assessedAt,
                role: card.provenance.observation.role,
              }
            : {
                state: "retained" as const,
                assessedAt: card.assessedAt,
                role: card.provenance.observation.role,
              };
    return {
      taskId: task.id,
      label: task.label,
      revision: task.revision,
      kind: task.kind,
      included: task.included,
      status,
      health,
      provenance,
      transitions: (transitions.get(task.id) ?? []).map((item) => ({
        ...item,
      })),
    };
  });
  const allDone =
    tasks.length > 0 &&
    tasks
      .filter((task) => task.included)
      .every((task) => task.status === "DONE");
  const focused = focusedTaskId
    ? tasks.find(
        (task) => task.taskId === focusedTaskId && task.status === "INPROG",
      )
    : undefined;
  const retainedDone =
    !input.unsettled && allDone && input.lastDisplayedTaskId
      ? tasks.find(
          (task) =>
            task.taskId === input.lastDisplayedTaskId && task.status === "DONE",
        )
      : undefined;
  return {
    tasks,
    ...(focused
      ? { currentTask: { taskId: focused.taskId, status: "INPROG" as const } }
      : retainedDone
        ? {
            currentTask: {
              taskId: retainedDone.taskId,
              status: "DONE" as const,
              qualifier: "Last reported · idle",
            },
          }
        : {}),
    service: { ...input.service },
  };
}
