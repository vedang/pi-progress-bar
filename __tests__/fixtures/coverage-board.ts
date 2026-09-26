import type { Theme } from "@earendil-works/pi-coding-agent";
import { CoverageStore } from "../../src/core/coverage";
import type { WidgetSnapshot } from "../../src/ui/widget";
import { coverageInventory, coverageParent, coverageSource } from "./coverage";
import { uxView } from "./ux-view";

export const coverageTheme = {
  fg: (_: string, text: string) => text,
  bg: (_: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
export function coverageBoardView(): WidgetSnapshot {
  const view: WidgetSnapshot = uxView();
  const parent = coverageParent();
  const store = new CoverageStore();
  store.admit({
    parent,
    intent: parent.source,
    inventory: coverageInventory(),
  });
  const group = store.snapshot().groups[0];
  store.report({
    groupId: group.id,
    inventoryRevision: 1,
    childIds: [group.children[0].id],
    source: coverageSource("review"),
    status: "reported-reviewed",
  });
  store.report({
    groupId: group.id,
    inventoryRevision: 1,
    childIds: [group.children[1].id],
    source: coverageSource("blocker"),
    status: "reported-blocked",
  });
  store.access({
    groupId: group.id,
    inventoryRevision: 1,
    childIds: [group.children[0].id, group.children[1].id],
    source: {
      entryId: "access",
      messageHash: "a".repeat(64),
      callId: "read-1",
    },
  });
  view.board.tasks[0].label = parent.label;
  view.board.tasks[0].status = "OPEN";
  view.board.currentTask = { taskId: parent.id, status: "OPEN" };
  view.presentation.progress = { done: 0, total: 1, kind: "current" };
  view.coverage = {
    ...store.snapshot(),
    current: [],
    pendingCount: 0,
    pendingBytes: 0,
    omissions: 0,
    exhausted: false,
  };
  return view;
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
