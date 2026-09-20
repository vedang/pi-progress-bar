import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { createBoard } from "../src/ui/board";
import { renderWidget } from "../src/ui/widget";
import { uxView } from "./fixtures/ux-view";

function palette() {
  const fg = vi.fn(
    (_tone: string, text: string) => `\u001b[36m${text}\u001b[39m`,
  );
  const bg = vi.fn(
    (_tone: string, text: string) => `\u001b[44m${text}\u001b[49m`,
  );
  return {
    fg,
    bg,
    theme: { fg, bg, bold: (text: string) => text } as unknown as Theme,
  };
}
it("uses theme accent/dim for real filled/empty bar cells without changing literal progress", () => {
  const h = palette();
  const lines = renderWidget(uxView(), false, 160, h.theme);
  expect(lines.map(stripVTControlCharacters)).toEqual([
    "Reported 7/12 · 58%  ███████░░░░░  Jev 10:03:12",
    "Current Task: (INPROG) Handle escaped delimiters in parser",
    "→ to inspect",
  ]);
  expect(h.fg).toHaveBeenCalledWith("accent", "███████");
  expect(h.fg).toHaveBeenCalledWith("dim", "░░░░░");
  expect(h.fg).toHaveBeenCalledWith("accent", "INPROG");
  expect(h.fg).toHaveBeenCalledWith("dim", "→ to inspect");
});
it.each([
  ["OPEN", "muted"],
  ["INPROG", "accent"],
  ["DONE", "dim"],
] as const)("widget styles %s by lifecycle only", (status, tone) => {
  const view = uxView();
  const task = view.board.tasks[0];
  if (!task || !view.board.currentTask) throw new Error("Missing task");
  task.status = view.board.currentTask.status = status;
  task.health.implementation = "contradicted";
  const h = palette();
  const lines = renderWidget(view, false, 160, h.theme);
  expect(h.fg).toHaveBeenCalledWith(tone, status);
  expect(lines.map(stripVTControlCharacters).join("\n")).toContain(
    `(${status})`,
  );
});
it("board styles typed statuses while retaining monochrome status text and selected contrast", () => {
  const view = uxView();
  const base = view.board.tasks[0];
  if (!base) throw new Error("Missing task");
  view.board.tasks = (["OPEN", "INPROG", "DONE", "ARCHIVED"] as const).map(
    (status, i) => ({
      ...structuredClone(base),
      taskId: `task:${i}`,
      status,
      included: status !== "ARCHIVED",
    }),
  );
  const h = palette();
  const board = createBoard(view, {
    theme: h.theme,
    screenRows: () => 40,
    isFocused: () => true,
    onClose: vi.fn(),
    requestRender: vi.fn(),
  });
  const lines = board.render(113);
  const plain = lines.map(stripVTControlCharacters).join("\n");
  for (const [status, tone] of [
    ["OPEN", "muted"],
    ["INPROG", "accent"],
    ["DONE", "dim"],
    ["ARCHIVED", "dim"],
  ]) {
    expect(h.fg).toHaveBeenCalledWith(tone, status);
    expect(plain).toContain(status);
  }
  expect(h.bg.mock.calls.some(([tone]) => tone === "selectedBg")).toBe(true);
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(113);
});
it("static polish has no clock-driven animation, timers or hidden usage", () => {
  vi.useFakeTimers();
  try {
    const h = palette();
    const view = uxView();
    const before = vi.getTimerCount();
    const first = renderWidget(view, false, 80, h.theme);
    vi.advanceTimersByTime(60_000);
    expect(renderWidget(view, false, 80, h.theme)).toEqual(first);
    expect(vi.getTimerCount()).toBe(before);
    expect(first.map(stripVTControlCharacters).join("\n")).not.toContain(
      "calls",
    );
  } finally {
    vi.useRealTimers();
  }
});
