import { stripVTControlCharacters } from "node:util";
import {
  type Terminal,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { createBoard } from "../src/ui/board";
import {
  coverageBoardView,
  coverageKeys as keys,
  coverageTheme as theme,
} from "./fixtures/coverage-board";

it.each([
  [80, 24],
  [140, 40],
])(
  "real TUI routes coverage navigation and clips overlay at%ix%i",
  async (columns, rows) => {
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
    const board = await createBoard(coverageBoardView(), {
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
        expect(stripVTControlCharacters(output)).toContain("Coverage"),
      );
      expect(tui.getFocusedComponent()).toBe(board);
      output = "";
      input?.(keys.tab);
      input?.(keys.tab);
      input?.(keys.end);
      tui.requestRender(true);
      await vi.waitFor(() =>
        expect(stripVTControlCharacters(output)).toContain("Lookup"),
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
        expect(stripVTControlCharacters(output)).toContain("Overview"),
      );
      input?.(keys.escape);
      expect(tui.hasOverlay()).toBe(false);
    } finally {
      board.dispose();
      tui.stop();
    }
  },
);
