import { createHash } from "node:crypto";

const MAX_TASKS = 200;

import type {
  Ledger,
  ReportBatch,
  ReportState,
  SourceSnapshot,
  Task,
} from "./types";

const states = new Set<ReportState>([
  "done",
  "reopened",
  "not-started",
  "in-progress",
  "cancelled",
  "unknown",
  "conflict",
]);
const identity = (task: {
  text: string;
  anchor?: string;
  workKind?: "action" | "response";
}) => {
  const workKind = task.workKind ?? "action";
  return task.anchor
    ? `anchor:${task.anchor}:${workKind}`
    : `text:${task.text}:${workKind}`;
};
const structure = (tasks: Task[]) =>
  JSON.stringify(
    tasks
      .map(({ id, text, workKind, included }) => [id, text, workKind, included])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );

/** Reconcile complete observations only. No mutation, fuzzy matching, or implicit current task. */
export function reconcileLedger(
  previous: Ledger | undefined,
  snapshot: SourceSnapshot,
  selection?: { includedIds?: string[]; currentTaskId?: string },
): Ledger {
  const old =
    previous?.sourceId === snapshot.sourceId && previous.kind === snapshot.kind
      ? previous
      : undefined;
  const prefix = createHash("sha256")
    .update(`${snapshot.kind}:${snapshot.sourceId}`)
    .digest("hex");
  const empty: Ledger = {
    sourceId: snapshot.sourceId,
    kind: snapshot.kind,
    sourceRevision: "",
    scopeRevision: `${prefix}:0`,
    tasks: [],
    stale: true,
    reportOrder: 0,
    reports: [],
    nextTaskId: 1,
    explicitSelection: false,
  };
  if (!snapshot.complete) return { ...(old ?? empty), stale: true };
  if (!snapshot.sourceId || snapshot.tasks.length > MAX_TASKS)
    throw new Error("Invalid source or scope exceeds 200 tasks");
  const seen = new Set<string>();
  for (const task of snapshot.tasks) {
    const key = identity(task);
    if (
      !task.text.trim() ||
      (task.workKind !== undefined &&
        task.workKind !== "action" &&
        task.workKind !== "response") ||
      !states.has(task.status) ||
      task.ref.sourceId !== snapshot.sourceId ||
      seen.has(key)
    )
      throw new Error("Invalid or ambiguous source task");
    seen.add(key);
  }
  const priorTasks = new Map(old?.tasks.map((task) => [identity(task), task]));
  let nextTaskId = old?.nextTaskId ?? 1;
  const explicitSelection =
    selection?.includedIds !== undefined || (old?.explicitSelection ?? false);
  const tasks: Task[] = snapshot.tasks.map((task) => {
    const prior = priorTasks.get(identity(task));
    return {
      ...task,
      workKind: task.workKind ?? "action",
      criteria: [...task.criteria],
      ...(task.criterionRefs
        ? { criterionRefs: task.criterionRefs.map((ref) => ({ ...ref })) }
        : {}),
      revision: task.revision ?? snapshot.revision,
      ref: { ...task.ref },
      id: prior?.id ?? `${prefix}:task:${nextTaskId++}`,
      included: prior?.included ?? !explicitSelection,
      // Conversation reports own status after initialization; checklist markers always report afresh.
      status:
        snapshot.kind === "conversation" && prior ? prior.status : task.status,
    };
  });
  if (selection?.includedIds !== undefined) {
    const ids = new Set(selection.includedIds);
    if (
      ids.size !== selection.includedIds.length ||
      [...ids].some((id) => !tasks.some((task) => task.id === id))
    )
      throw new Error("Unknown or duplicate selected task");
    for (const task of tasks) task.included = ids.has(task.id);
  }
  const currentTaskId = selection?.currentTaskId ?? old?.currentTaskId;
  if (
    selection?.currentTaskId !== undefined &&
    !tasks.some((task) => task.id === currentTaskId && task.included)
  )
    throw new Error("Current task is outside selected scope");
  const scopeChanged = !old || structure(old.tasks) !== structure(tasks);
  const scopeNumber = Number(old?.scopeRevision.split(":").at(-1) ?? 0) + 1;
  return {
    sourceId: snapshot.sourceId,
    kind: snapshot.kind,
    sourceRevision: snapshot.revision,
    scopeRevision: scopeChanged
      ? `${prefix}:${scopeNumber}`
      : old.scopeRevision,
    tasks,
    ...(tasks.some((task) => task.id === currentTaskId && task.included)
      ? { currentTaskId }
      : {}),
    stale: false,
    reportOrder: old?.reportOrder ?? 0,
    reports: [...(old?.reports ?? [])],
    nextTaskId,
    explicitSelection,
  };
}

export function countReported(ledger: Ledger | undefined): {
  done: number;
  total: number;
  percent: number | null;
} {
  const included =
    ledger?.tasks.filter(
      (task) => task.included && task.status !== "cancelled",
    ) ?? [];
  const done = included.filter((task) => task.status === "done").length;
  return {
    done,
    total: included.length,
    percent: included.length
      ? Math.floor((done * 100) / included.length)
      : null,
  };
}

/** Validate the complete batch before creating any changed task or cursor. */
export function applyReportBatch(ledger: Ledger, batch: ReportBatch): Ledger {
  if (
    ledger.kind !== "conversation" ||
    ledger.stale ||
    batch.sourceId !== ledger.sourceId ||
    batch.scopeRevision !== ledger.scopeRevision
  )
    throw new Error(
      "Report source or scope mismatch, stale ledger, or non-conversation owner",
    );
  if (
    !Number.isSafeInteger(batch.order) ||
    batch.order <= ledger.reportOrder ||
    !batch.entryId.trim() ||
    ledger.reports.some((report) => report.entryId === batch.entryId)
  )
    throw new Error("Invalid or out-of-order report");
  if (
    !batch.states ||
    typeof batch.states !== "object" ||
    Array.isArray(batch.states)
  )
    throw new Error("Invalid report states");
  const updates = Object.entries(batch.states);
  if (
    !updates.length ||
    updates.some(
      ([id, state]) =>
        !states.has(state) ||
        !ledger.tasks.some((task) => task.id === id && task.included),
    )
  )
    throw new Error("Invalid report task or state");
  const validated: ReportBatch = { ...batch, states: { ...batch.states } };
  const tasks = ledger.tasks.map((task) =>
    Object.hasOwn(validated.states, task.id)
      ? { ...task, status: validated.states[task.id] as ReportState }
      : task,
  );
  const current = tasks.find((task) => task.id === ledger.currentTaskId);
  return {
    ...ledger,
    tasks,
    ...(current?.status === "cancelled"
      ? { currentTaskId: undefined }
      : { currentTaskId: ledger.currentTaskId }),
    reportOrder: batch.order,
    reports: [...ledger.reports, validated],
  };
}
