import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { createBoard } from "../src/ui/board";
import { renderWidget } from "../src/ui/widget";
import {
  coverageBoardView,
  coverageKeys as keys,
  coverageTheme as theme,
} from "./fixtures/coverage-board";

async function fixture(rows = 60) {
  const view = coverageBoardView();
  const onClose = vi.fn();
  const board = await createBoard(view, {
    theme,
    screenRows: () => rows,
    isFocused: () => true,
    onClose,
    requestRender: vi.fn(),
  });
  const text = (width = 200) =>
    board.render(width).map(stripVTControlCharacters).join("\n");
  text();
  return { view, board, text, onClose };
}
it.each(["OPEN", "DONE"] as const)(
  "shows reported review separately from access and parent%s",
  async (status) => {
    const h = await fixture();
    h.view.board.tasks[0].status = status;
    h.view.presentation.progress.done = status === "DONE" ? 1 : 0;
    h.board.update(h.view);
    const output = h.text();
    expect(output).toMatch(/reported reviewed[^\n]*1\s*\/\s*22/i);
    expect(output).toMatch(/(?:2\s+accessed|accessed\s*:?\s*2)/i);
    expect(output).toMatch(/(?:1\s+blocked|blocked\s*:?\s*1)/i);
    expect(output).toMatch(/(?:20\s+pending|pending\s*:?\s*20)/i);
    expect(output).toMatch(/intent[^\n]*user/i);
    expect(output).toContain(status);
    expect(h.view.presentation.progress).toEqual({
      done: status === "DONE" ? 1 : 0,
      total: 1,
      kind: "current",
    });
    h.board.dispose();
  },
);
it("keeps an unknown denominator visibly unknown, never a review percentage", async () => {
  const h = await fixture();
  const group = h.view.coverage?.groups[0];
  if (!group) throw new Error("Missing group");
  group.complete = false;
  delete group.knownTotal;
  h.board.update(h.view);
  expect(h.text()).toMatch(
    /(?:unknown[^\n]*(?:total|denominator)|(?:total|denominator)[^\n]*unknown)/i,
  );
  expect(h.text()).not.toMatch(/\d+(?:\.\d+)?%/);
  h.board.dispose();
});
it("scrolls coverage independently and preserves position through runtime current changes", async () => {
  const h = await fixture(24);
  const before = structuredClone(h.view.board);
  h.board.handleInput(keys.tab);
  h.board.handleInput(keys.tab);
  h.board.handleInput(keys.end);
  expect(h.text(120)).toContain("Lookup");
  expect(h.text(120)).not.toContain("Overview");
  const coverage = h.view.coverage;
  if (!coverage) throw new Error("Missing coverage");
  coverage.current = [
    {
      groupId: coverage.groups[0].id,
      childIds: [coverage.groups[0].children[0].id],
    },
  ];
  h.board.update(h.view);
  expect(h.text(120)).toContain("Lookup");
  h.board.handleInput(keys.home);
  expect(h.text(120)).toContain("Overview");
  h.board.handleInput(keys.pageDown);
  h.board.handleInput(keys.pageUp);
  expect(h.text(120)).toContain("Overview");
  expect(h.view.board).toEqual(before);
  for (const heading of [
    "Requirements",
    "Acceptance",
    "New red test",
    "Red evidence",
    "Implementation",
  ])
    expect(h.text(120).split(heading)).toHaveLength(2);
  h.board.handleInput(keys.escape);
  expect(h.onClose).toHaveBeenCalledOnce();
});
it("renders runtime current batch separately from durable reviewed status", async () => {
  const h = await fixture();
  const coverage = h.view.coverage;
  if (!coverage) throw new Error("Missing coverage");
  coverage.current = [
    {
      groupId: coverage.groups[0].id,
      childIds: coverage.groups[0].children
        .slice(1, 3)
        .map((child) => child.id),
    },
  ];
  h.board.update(h.view);
  expect(h.text()).toMatch(/current[^\n]*(?:batch|items)/i);
  expect(h.text()).toMatch(/reported reviewed[^\n]*1\s*\/\s*22/i);
  h.board.dispose();
});
it("shows exhausted/incomplete coverage even without an admitted group", async () => {
  const h = await fixture();
  if (!h.view.coverage) throw new Error("Missing coverage");
  h.view.coverage.groups = [];
  h.view.coverage.exhausted = true;
  h.board.update(h.view);
  expect(h.text()).toMatch(/coverage[^\n]*exhausted|exhausted[^\n]*coverage/i);
  expect(renderWidget(h.view, true, 120, theme).join("\n")).toMatch(
    /coverage[^\n]*exhausted|exhausted[^\n]*coverage/i,
  );
  h.board.dispose();
});
it.each([56, 80, 160])(
  "clips sanitized coverage at%i columns without changing snapshots",
  async (width) => {
    const h = await fixture(32);
    const group = h.view.coverage?.groups[0];
    if (!group) throw new Error("Missing group");
    group.children[0].label = `Overview\u001b]52;c;SECRET\u0007 ${"界".repeat(40)}`;
    h.board.update(h.view);
    group.children[0].label = "CALLER_MUTATION";
    h.board.handleInput(keys.tab);
    h.board.handleInput(keys.tab);
    const lines = h.board.render(width);
    expect(lines.length).toBeLessThanOrEqual(25);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(lines.join("\n")).not.toMatch(/SECRET|CALLER_MUTATION/);
    expect(lines.join("\n")).not.toContain("\u001b]52");
    h.board.handleInput(keys.end);
    expect(h.text(width)).toContain("Lookup");
    h.board.dispose();
  },
);
