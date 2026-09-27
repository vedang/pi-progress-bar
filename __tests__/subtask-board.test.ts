import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { SubtaskStore } from "../src/core/subtasks";
import { createBoard } from "../src/ui/board";
import { renderWidget } from "../src/ui/widget";
import { coverageTheme } from "./fixtures/coverage-board";
import { subtaskAdmission } from "./fixtures/subtasks";
import { uxView } from "./fixtures/ux-view";

it("renders generic children without resource inventory or parent completion authority", async () => {
  const store = new SubtaskStore();
  expect(store.admit(subtaskAdmission())).toEqual({ accepted: true });
  const view = { ...uxView(), subtasks: store.snapshot() };
  view.board.tasks[0].status = "OPEN";
  view.board.currentTask = {
    taskId: view.board.tasks[0].taskId,
    status: "OPEN",
  };
  view.presentation.progress = { done: 0, total: 1, kind: "current" };
  const parentBoard = structuredClone(view.board);
  const board = await createBoard(view, {
    theme: coverageTheme,
    screenRows: () => 60,
    isFocused: () => true,
    onClose: vi.fn(),
    requestRender: vi.fn(),
  });
  try {
    const text = board.render(160).map(stripVTControlCharacters).join("\n");
    for (const child of view.subtasks.groups[0].children)
      expect(text).toContain(child.label);
    expect(text).toMatch(/pending/i);
    expect(renderWidget(view, false, 160, coverageTheme).join("\n")).toContain(
      "0/1",
    );
    expect(view.board).toEqual(parentBoard);
    for (const line of board.render(40))
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  } finally {
    board.dispose();
  }
});
