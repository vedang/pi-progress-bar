import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SubtaskDiagnosticsSnapshot } from "../../src/core/monitor";
import type { SubtaskAccessSnapshot } from "../../src/core/subtask-access";
import { type SubtaskSnapshot, SubtaskStore } from "../../src/core/subtasks";
import { CoverageAdapter } from "../../src/sources/coverage";
import type { WidgetSnapshot } from "../../src/ui/widget";
import { coverageNames } from "./coverage";
import { subtaskAdmission, subtaskSource } from "./subtasks";
import { uxView } from "./ux-view";

export const coverageTheme = {
  fg: (_: string, text: string) => text,
  bg: (_: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
export type GenericBoardView = WidgetSnapshot & {
  subtasks: SubtaskSnapshot;
  subtaskAccess: SubtaskAccessSnapshot;
  subtaskDiagnostics: SubtaskDiagnosticsSnapshot;
};
/** Synthetic presentation facts, not semantic-provider acceptance evidence. */
export function coverageBoardView(): GenericBoardView {
  const base = uxView();
  const store = new SubtaskStore();
  const admission = {
    ...subtaskAdmission(coverageNames),
    complete: true,
    knownTotal: 22,
  };
  if (!store.admit(admission).accepted)
    throw new Error("Invalid generic UI fixture");
  const group = store.snapshot().groups[0];
  for (const [index, status] of [
    [0, "reported-completed"],
    [1, "reported-blocked"],
  ] as const) {
    if (
      !store.report({
        groupId: group.id,
        listRevision: group.listRevision,
        childIds: [group.children[index].id],
        source: subtaskSource(`report-${index}`),
        status,
      }).accepted
    )
      throw new Error("Invalid generic report fixture");
  }
  base.board.tasks[0].label = admission.parent.label;
  base.board.tasks[0].status = "OPEN";
  base.board.currentTask = { taskId: admission.parent.id, status: "OPEN" };
  base.presentation.progress = { done: 0, total: 1, kind: "current" };
  return {
    ...base,
    subtasks: store.snapshot(),
    subtaskAccess: {
      groups: [
        {
          groupId: group.id,
          parentTaskId: group.parentTaskId,
          parentRevision: group.parentRevision,
          listRevision: group.listRevision,
          children: group.children.map((child, index) => ({
            childId: child.id,
            status: index < 2 ? "observed" : "no-observation",
            activeCallHashes: [],
          })),
        },
      ],
      omissions: 0,
    },
    subtaskDiagnostics: {
      semanticOmissions: {
        total: 0,
        byReason: { "report-oversized": 0, coalesced: 0, capacity: 0 },
        saturated: false,
      },
      dispatches: 0,
      exhausted: false,
      parkedOwners: 0,
      permanentOwners: 0,
      adapter: new CoverageAdapter().snapshot(),
    },
  };
}
export const coverageKeys = {
  tab: "\t",
  up: "\u001b[A",
  down: "\u001b[B",
  end: "\u001b[F",
  home: "\u001b[H",
  pageDown: "\u001b[6~",
  pageUp: "\u001b[5~",
  escape: "\u001b",
};
