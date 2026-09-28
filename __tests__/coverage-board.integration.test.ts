import { stripVTControlCharacters } from "node:util";
import {
  type Terminal,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { SubtaskStore } from "../src/core/subtasks";
import { createBoard } from "../src/ui/board";
import type { WidgetSnapshot } from "../src/ui/widget";
import {
  coverageBoardView,
  coverageKeys as keys,
  coverageTheme as theme,
} from "./fixtures/coverage-board";
import { subtaskAdmission } from "./fixtures/subtasks";
import { uxView } from "./fixtures/ux-view";

it.each([
  { columns: 80, rows: 24, kind: "22-child" },
  { columns: 140, rows: 40, kind: "22-child" },
  { columns: 80, rows: 24, kind: "no-file" },
  { columns: 140, rows: 40, kind: "no-file" },
])(
  "real TUI routes $kind subtask navigation and clips overlay at $columns x $rows",
  async ({ columns, rows, kind }) => {
    let input: ((data: string) => void) | undefined;
    let output = "";
    const terminal: Terminal = {
      columns,
      rows,
      kittyProtocolActive: false,
      start: (receive) => {
        input = receive;
      },
      stop: () => {},
      drainInput: async () => {},
      write: (data) => {
        output += data;
      },
      moveBy: () => {},
      hideCursor: () => {},
      showCursor: () => {},
      clearLine: () => {},
      clearFromCursor: () => {},
      clearScreen: () => {},
      setTitle: () => {},
      setProgress: () => {},
    };
    const tui = new TuiMainScreen(terminal);
    let close = () => {};
    let view: WidgetSnapshot;
    const firstLabel = kind === "22-child" ? "Overview" : "Compare options";
    const lastLabel = kind === "22-child" ? "Lookup" : "Recommend approach";
    if (kind === "22-child") view = coverageBoardView();
    else {
      const store = new SubtaskStore();
      expect(store.admit(subtaskAdmission([firstLabel, lastLabel]))).toEqual({
        accepted: true,
      });
      view = { ...uxView(), subtasks: store.snapshot() };
      view.board.tasks[0].label = "Recommend deployment approach";
      view.board.tasks[0].status = "OPEN";
      view.board.currentTask = { taskId: "task:1", status: "OPEN" };
      view.presentation.progress = { done: 0, total: 1, kind: "current" };
      expect(view.subtaskAccess).toBeUndefined();
    }
    const before = structuredClone(view);
    const board = await createBoard(view, {
      theme,
      screenRows: () => rows,
      isFocused: () => tui.getFocusedComponent() === board,
      onClose: () => close(),
      requestRender: () => tui.requestRender(),
    });
    tui.addChild({
      render: () => ["Underlying conversation"],
      invalidate: () => {},
    });
    tui.start();
    const overlay = tui.showOverlay(board, {
      width: "94%",
      maxHeight: "80%",
      anchor: "center",
    });
    close = () => overlay.hide();
    try {
      await vi.waitFor(() =>
        expect(stripVTControlCharacters(output)).toContain("Subtasks"),
      );
      expect(tui.getFocusedComponent()).toBe(board);
      output = "";
      input?.(keys.tab);
      input?.(keys.tab);
      input?.(keys.end);
      tui.requestRender(true);
      await vi.waitFor(() =>
        expect(stripVTControlCharacters(output)).toContain(lastLabel),
      );
      expect(
        stripVTControlCharacters(output)
          .split(/\r?\n/)
          .every((line) => visibleWidth(line) <= columns),
      ).toBe(true);
      output = "";
      input?.(keys.home);
      tui.requestRender(true);
      await vi.waitFor(() =>
        expect(stripVTControlCharacters(output)).toContain(firstLabel),
      );
      if (kind === "no-file") {
        expect(stripVTControlCharacters(output)).toMatch(/access unavailable/i);
        expect(stripVTControlCharacters(output)).not.toMatch(
          /0 observed access/i,
        );
      }
      expect(view).toEqual(before);
      input?.(keys.escape);
      expect(tui.hasOverlay()).toBe(false);
    } finally {
      board.dispose();
      tui.stop();
    }
  },
);
