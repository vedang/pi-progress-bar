import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionVisibilitySnapshot } from "../src/core/execution-visibility";
import { createBoard } from "../src/ui/board";
import { renderWidget } from "../src/ui/widget";
import { uxView } from "./fixtures/ux-view";

const theme = {
  fg: (_: string, text: string) => text,
  bg: (_: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
function fixture() {
  const base = uxView();
  const task = {
    id: "task:1",
    label: base.board.tasks[0].label,
    revision: 1,
    sourceDigest: "a".repeat(64),
  };
  const visibility: ExecutionVisibilitySnapshot = {
    generation: 1,
    coverage: "since-monitoring-resumed",
    budgetRemaining: 1022,
    usage: { calls: 2, inputTokens: 80, outputTokens: 10, lastCallAt: 1000 },
    current: {
      kind: "reported",
      text: "Inspecting escaped delimiters",
      provisional: false,
      task,
    },
    actions: [
      {
        id: "action1",
        order: 1,
        task,
        candidate: {
          id: "candidate:1",
          liveToken: "live1",
          messageHash: "b".repeat(64),
          quoteHash: "c".repeat(64),
          start: 0,
          end: 30,
          quote: "Delimiter validation completed",
        },
      },
    ],
  };
  const view = { ...base, visibility };
  const board = createBoard(view, {
    theme,
    screenRows: () => 60,
    isFocused: () => true,
    onClose: vi.fn(),
    requestRender: vi.fn(),
  });
  return {
    view,
    board,
    text: () => board.render(160).map(stripVTControlCharacters).join("\n"),
  };
}
describe("detached execution visibility UX", () => {
  it("shows changing activity without changing reported completion", () => {
    const h = fixture();
    const text = renderWidget(h.view, false, 160, theme).join("\n");
    expect(text).toContain("Reported 7/12");
    expect(text).toContain("Agent says:");
    expect(text).toContain("Inspecting escaped delimiters");
    expect(h.view.presentation.progress).toEqual({
      done: 7,
      total: 12,
      kind: "current",
    });
  });
  it("renders one Summary, current activity and task-local reported history with qualification", () => {
    const h = fixture();
    const text = h.text();
    expect(text.match(/Summary:/g)).toHaveLength(1);
    expect(text).toContain("Current Activity");
    expect(text).toContain("Meaningful Actions");
    expect(text).toContain("Agent reported: Delimiter validation completed");
    expect(text).toContain("Since monitoring resumed");
    expect(text).toContain("history may be incomplete");
  });
  it("other-task activity is explicitly global and never inserted as selected-task history", () => {
    const h = fixture();
    const other = {
      ...h.view.visibility.actions[0].task,
      id: "task:2",
      label: "Authentication",
    };
    h.view.visibility.current = {
      kind: "reported",
      text: "Inspecting tokens",
      task: other,
    };
    h.view.visibility.actions[0].task = other;
    h.board.update(h.view);
    const text = h.text();
    expect(text).toContain("other task Authentication");
    expect(text).not.toContain(
      "Agent reported: Delimiter validation completed",
    );
  });
  it("unbound tool current remains task-unconfirmed and makes no history", () => {
    const h = fixture();
    h.view.visibility.current = { kind: "tool", text: "Editing code" };
    h.view.visibility.actions = [];
    h.board.update(h.view);
    const text = h.text();
    expect(text).toContain("Editing code");
    expect(text).toContain("task unconfirmed");
    expect(text).not.toContain("Agent reported:");
  });
  it("budget telemetry is separately labeled; exhausted history is explicit", () => {
    const h = fixture();
    h.view.visibility.usage.calls = 1024;
    h.view.visibility.budgetRemaining = 0;
    h.view.visibility.coverage = "incomplete";
    h.board.update(h.view);
    expect(h.text()).toContain("Visibility budget reached");
    expect(h.text()).toContain("history incomplete");
    const selected = renderWidget(h.view, true, 160, theme).join("\n");
    expect(selected).toContain("Visibility");
    expect(selected).toContain("1024");
    expect(h.view.presentation.usage.jev.calls).toBe(200);
  });
  it("terminal controls in reported prose cannot escape display", () => {
    const h = fixture();
    h.view.visibility.current = {
      kind: "reported",
      text: "Inspecting\u001b]52;c;SECRET\u0007 code",
      provisional: true,
    };
    h.board.update(h.view);
    const text = renderWidget(h.view, false, 160, theme).join("\n");
    expect(text).not.toContain("SECRET");
    expect(text).toContain("provisional");
    expect(text).toContain("task unconfirmed");
  });
});
