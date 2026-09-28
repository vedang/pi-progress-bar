import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { createBoard } from "../src/ui/board";
import { renderWidget } from "../src/ui/widget";
import {
  coverageBoardView,
  type GenericBoardView,
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
function active(view: GenericBoardView, indices: number[]) {
  view.subtaskAccess.groups[0].children.forEach((child, index) => {
    child.activeCallHashes = indices.includes(index) ? ["a".repeat(64)] : [];
  });
}
it.each(["OPEN", "DONE"] as const)(
  "shows reported completion separately from access and parent%s",
  async (status) => {
    const h = await fixture();
    h.view.board.tasks[0].status = status;
    h.view.presentation.progress.done = status === "DONE" ? 1 : 0;
    h.view.board.currentTask = { taskId: h.view.board.tasks[0].taskId, status };
    h.board.update(h.view);
    const output = h.text();
    expect(output).toMatch(/reported complete\b[^\n]*1\s*\/\s*22/i);
    expect(output).not.toMatch(/optional review|reported reviewed/i);
    expect(renderWidget(h.view, false, 200, theme).join("\n")).not.toMatch(
      /optional review|reported reviewed/i,
    );
    expect(output).toMatch(
      /(?:2\s+(?:observed\s+)?access(?:ed)?\b|(?:observed\s+)?access(?:ed)?\s*:?\s*2\b)/i,
    );
    expect(output).toMatch(/(?:1\s+blocked|blocked\s*:?\s*1)/i);
    expect(output).toMatch(/(?:20\s+pending|pending\s*:?\s*20)/i);
    expect(output).toMatch(/(?:source|origin|provenance)[^\n]*user/i);
    expect(output).toContain(status);
    expect(h.view).not.toHaveProperty("coverage");
    if (status === "DONE") {
      expect(output).toMatch(/subtasks[^\n]*(?:incomplete|unconfirmed)/i);
      const widget = renderWidget(h.view, false, 120, theme).join("\n");
      expect(widget).toMatch(/subtasks[^\n]*(?:incomplete|unconfirmed)/i);
      expect(widget).toContain("1/1");
      expect(h.view.board.tasks[0].status).toBe("DONE");
    }
    expect(h.view.presentation.progress).toEqual({
      done: status === "DONE" ? 1 : 0,
      total: 1,
      kind: "current",
    });
    h.board.dispose();
  },
);
it("keeps unknown scope visibly unknown while retaining the actual tracked denominator", async () => {
  const h = await fixture();
  const group = h.view.subtasks.groups[0];
  group.complete = false;
  delete group.knownTotal;
  h.board.update(h.view);
  expect(h.text()).toMatch(
    /(?:unknown[^\n]*(?:total|denominator|scope)|(?:total|denominator|scope)[^\n]*unknown)/i,
  );
  expect(h.text()).toMatch(/1\s*\/\s*22/);
  expect(h.text()).not.toMatch(/\d+(?:\.\d+)?%/);
  h.board.dispose();
});
it("scrolls subtasks independently and preserves position through active access changes", async () => {
  const h = await fixture(24);
  const before = structuredClone(h.view.board);
  h.board.handleInput(keys.tab);
  h.board.handleInput(keys.tab);
  h.board.handleInput(keys.end);
  expect(h.text(120)).toContain("Lookup");
  expect(h.text(120)).not.toContain("Overview");
  active(h.view, [0]);
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
it("anchors a mid-list child while active access rows appear and disappear", async () => {
  const h = await fixture(24);
  h.text(120);
  h.board.handleInput(keys.tab);
  h.board.handleInput(keys.tab);
  h.board.handleInput(keys.pageDown);
  const firstVisibleChild = () => {
    for (const line of h.text(120).split("\n")) {
      const child = h.view.subtasks.groups[0].children.find((item) =>
        line.includes(`• ${item.label} ·`),
      );
      if (child) return child.id;
    }
  };
  const anchor = firstVisibleChild();
  expect(anchor).toBeDefined();
  expect(anchor).not.toBe(h.view.subtasks.groups[0].children[0].id);
  active(h.view, [0]);
  h.board.update(h.view);
  expect(firstVisibleChild()).toBe(anchor);
  active(h.view, []);
  h.board.update(h.view);
  expect(firstVisibleChild()).toBe(anchor);
  h.board.dispose();
});
it("anchors by child ID when a new list revision prepends a child", async () => {
  const h = await fixture(24);
  const group = h.view.subtasks.groups[0];
  h.text(120);
  h.board.handleInput(keys.tab);
  h.board.handleInput(keys.tab);
  h.board.handleInput(keys.pageDown);
  const firstVisibleChild = () => {
    for (const line of h.text(120).split("\n")) {
      const child = group.children.find((item) =>
        line.includes(`• ${item.label} ·`),
      );
      if (child) return child.id;
    }
  };
  const anchor = firstVisibleChild();
  expect(anchor).toBeDefined();
  expect(anchor).not.toBe(group.children[0].id);
  group.children.unshift({
    id: "subtask-child:23",
    label: "Newly named obligation",
    status: "pending",
    source: { ...group.source },
  });
  group.knownTotal = 23;
  group.listRevision++;
  h.board.update(h.view);
  expect(firstVisibleChild()).toBe(anchor);
  h.board.dispose();
});
it("renders active access separately from durable reported completion", async () => {
  const h = await fixture();
  active(h.view, [1, 2]);
  h.board.update(h.view);
  expect(h.text()).toMatch(/active[^\n]*access/i);
  expect(h.text()).toMatch(/active[^\n]*Phase 1[^\n]*Phase 2/i);
  expect(h.text()).toMatch(/reported complete\b[^\n]*1\s*\/\s*22/i);
  h.board.dispose();
});
it("shows active-access and group-omission rows only once within the subtask pane", async () => {
  const h = await fixture();
  active(h.view, [1, 2]);
  h.view.subtasks.groups[0].omissions.push("Optional context omitted");
  h.board.update(h.view);
  h.board.handleInput(keys.tab);
  h.board.handleInput(keys.tab);
  const text = h.text();
  expect(text.match(/Active access:/g)).toHaveLength(1);
  expect(text.match(/Optional context omitted/g)).toHaveLength(1);
  expect(text).toContain("Phase 1");
  expect(text).toContain("Phase 2");
  h.board.dispose();
});
it("shows exhausted subtasks even without an admitted group", async () => {
  const h = await fixture();
  h.view.subtasks.groups = [];
  h.view.subtaskDiagnostics.dispatches = 1024;
  h.view.subtaskDiagnostics.exhausted = true;
  h.board.update(h.view);
  expect(h.text()).toMatch(/subtasks[^\n]*exhausted|exhausted[^\n]*subtasks/i);
  expect(h.text()).not.toMatch(/optional review/i);
  expect(renderWidget(h.view, true, 200, theme).join("\n")).not.toMatch(
    /optional review/i,
  );
  expect(renderWidget(h.view, true, 120, theme).join("\n")).toMatch(
    /subtasks[^\n]*exhausted|exhausted[^\n]*subtasks/i,
  );
  h.board.dispose();
});
it("keeps every child reachable when subtask headers and health values exceed the viewport", async () => {
  const h = await fixture(18);
  const health = h.view.board.tasks[0].health;
  for (const key of Object.keys(health) as Array<keyof typeof health>)
    health[key] = "Long health explanation ".repeat(10);
  h.board.update(h.view);
  h.text(56);
  h.board.handleInput(keys.tab);
  h.board.handleInput(keys.tab);
  h.board.handleInput(keys.end);
  expect(h.text(56)).toContain("Lookup");
  h.board.handleInput(keys.home);
  expect(h.text(56)).toContain("Overview");
  h.board.dispose();
});
it("keeps global exhaustion and omission warnings visible in the subtask pane", async () => {
  const h = await fixture();
  h.view.subtaskDiagnostics.dispatches = 1024;
  h.view.subtaskDiagnostics.exhausted = true;
  h.view.subtaskDiagnostics.adapter.omissions = 3;
  h.view.subtaskDiagnostics.semanticOmissions = {
    total: 9,
    byReason: { "report-oversized": 2, coalesced: 3, capacity: 4 },
    saturated: false,
  };
  h.board.update(h.view);
  h.board.handleInput(keys.tab);
  h.board.handleInput(keys.tab);
  expect(h.text()).toMatch(/exhausted/i);
  expect(h.text()).toMatch(/3[^\n]*omitted/i);
  const widget = renderWidget(h.view, false, 120, theme).join("\n");
  expect(widget).toMatch(/exhausted/i);
  expect(widget).toMatch(/3[^\n]*omitted/i);
  expect(h.text()).toMatch(/9[^\n]*reports?[^\n]*(?:omitted|skipped)/i);
  expect(widget).toMatch(/9[^\n]*reports?[^\n]*(?:omitted|skipped)/i);
  h.board.dispose();
});
it("does not carry one parent's subtask scroll into another parent", async () => {
  const h = await fixture(24);
  h.view.board.tasks.push({
    ...structuredClone(h.view.board.tasks[0]),
    taskId: "task:2",
    label: "Other plan",
  });
  const second = structuredClone(h.view.subtasks.groups[0]);
  second.id = "subtask-group:2";
  second.parentTaskId = "task:2";
  second.children.forEach((child, index) => {
    child.id = `subtask-child:${index + 23}`;
    child.label = `Second ${child.label}`;
  });
  h.view.subtasks.groups.push(second);
  h.board.update(h.view);
  h.board.handleInput(keys.tab);
  h.board.handleInput(keys.tab);
  h.board.handleInput(keys.end);
  expect(h.text(120)).toContain("Lookup");
  h.board.handleInput(keys.tab);
  h.board.handleInput(keys.down);
  h.board.handleInput(keys.tab);
  h.board.handleInput(keys.tab);
  expect(h.text(120)).toContain("Second Overview");
  expect(h.text(120)).not.toContain("Second Lookup");
  h.board.dispose();
});
it("keeps scroll for same-revision wording/source changes but resets for a new revision", async () => {
  const h = await fixture(24);
  h.board.handleInput(keys.tab);
  h.board.handleInput(keys.tab);
  h.board.handleInput(keys.end);
  expect(h.text(120)).toContain("Lookup");
  h.view.board.tasks[0].label = "Reworded parent";
  h.view.board.tasks[0].sourceDigest = "b".repeat(64);
  h.view.subtasks.groups[0].parentSourceDigest = "b".repeat(64);
  h.board.update(h.view);
  expect(h.text(120)).toContain("Lookup");
  h.view.board.tasks[0].revision = 2;
  h.view.subtasks.groups[0].parentRevision = 2;
  h.board.update(h.view);
  expect(h.text(120)).toContain("Overview");
  expect(h.text(120)).not.toContain("Lookup");
  h.board.dispose();
});
it.each([false, true])(
  "shows known scope1000 without inventing named children (count-only:%s)",
  async (countOnly) => {
    const h = await fixture();
    const group = h.view.subtasks.groups[0];
    group.complete = false;
    group.knownTotal = 1000;
    if (countOnly) group.children = [];
    h.board.update(h.view);
    h.board.handleInput(keys.tab);
    h.board.handleInput(keys.tab);
    const text = h.text();
    expect(text).toMatch(/(?:known[^\n]*1[,]?000|1[,]?000[^\n]*known)/i);
    if (countOnly) {
      expect(text).toMatch(/(?:0[^\n]*tracked|tracked[^\n]*0|no named)/i);
      expect(text).not.toContain("Overview");
    } else expect(text).toMatch(/1\s*\/\s*22/);
    expect(text).not.toMatch(/\d+(?:\.\d+)?%/);
    expect(group.children).toHaveLength(countOnly ? 0 : 22);
    h.board.dispose();
  },
);
it("shows omission diagnostics without a group or exhausted wallet", async () => {
  const h = await fixture();
  h.view.subtasks.groups = [];
  h.view.subtaskDiagnostics.adapter.omissions = 7;
  h.board.update(h.view);
  for (const text of [
    h.text(),
    renderWidget(h.view, false, 120, theme).join("\n"),
  ]) {
    expect(text).toMatch(/7[^\n]*omitted/i);
    expect(text).not.toMatch(/exhausted/i);
  }
  h.board.dispose();
});
it.each([
  { total: 5, saturated: false, empty: false },
  { total: 64, saturated: true, empty: false },
  { total: 0, saturated: true, empty: false },
  { total: 0, saturated: false, empty: false },
  { total: 5, saturated: false, empty: true },
  { total: 0, saturated: true, empty: true },
])(
  "shows durable omission counts with no group while OFF (retained=$total, saturated=$saturated, empty=$empty)",
  async ({ total, saturated, empty }) => {
    const h = await fixture();
    h.view.subtasks.groups = [];
    h.view.subtaskDiagnostics.semanticOmissions = {
      total,
      byReason: { "report-oversized": total, coalesced: 0, capacity: 0 },
      saturated,
    };
    h.view.presentation.enabled = false;
    if (empty) {
      h.view.board.tasks = [];
      delete h.view.board.currentTask;
      h.view.presentation.progress = { done: 0, total: 0, kind: "current" };
    }
    const before = structuredClone(h.view);
    h.board.update(h.view);
    const detail = h.text();
    h.board.handleInput(keys.tab);
    h.board.handleInput(keys.tab);
    const pane = h.text();
    for (const text of [
      detail,
      pane,
      renderWidget(h.view, false, 120, theme).join("\n"),
    ]) {
      if (total > 0)
        expect(text).toMatch(
          new RegExp(`${total}[^\\n]*reports?[^\\n]*(?:omitted|skipped)`, "i"),
        );
      if (saturated) {
        expect(text).toMatch(
          /omission[^\n]*(?:summary|history)[^\n]*incomplete/i,
        );
        if (total > 0) expect(text).toMatch(/at least\s+64|64\+/i);
        else
          expect(text).not.toMatch(
            /\b0\s+(?:reports?|omissions?)[^\n]*(?:omitted|skipped)/i,
          );
      }
      if (total === 0 && !saturated)
        expect(text).not.toMatch(
          /omission[^\n]*(?:summary|history)|reports?[^\n]*(?:omitted|skipped)/i,
        );
      expect(text).not.toMatch(/exhausted/i);
    }
    expect(h.view).toEqual(before);
    h.board.dispose();
  },
);
it.each(["group", "parent", "revision", "list", "child"])(
  "does not present foreign %s access as observed",
  async (kind) => {
    const h = await fixture();
    const access = h.view.subtaskAccess.groups[0];
    if (kind === "group") access.groupId = "subtask-group:999";
    if (kind === "parent") access.parentTaskId = "task:999";
    if (kind === "revision") access.parentRevision++;
    if (kind === "list") access.listRevision++;
    if (kind === "child") access.children[0].childId = "subtask-child:999";
    h.board.update(h.view);
    expect(h.text()).not.toMatch(
      /(?:2\s+(?:observed\s+)?access(?:ed)?\b|(?:observed\s+)?access(?:ed)?\s*:?\s*2\b)/i,
    );
    expect(h.text()).toMatch(/reported complete\b[^\n]*1\s*\/\s*22/i);
    h.board.dispose();
  },
);
it("distinguishes unavailable access from observed zero and keeps semantic completion", async () => {
  const h = await fixture();
  h.view.subtaskAccess.groups = [];
  h.board.update(h.view);
  expect(h.text()).toMatch(/access[^\n]*unavailable|unavailable[^\n]*access/i);
  expect(h.text()).not.toMatch(/(?:0\s+observed|observed\s*:?\s*0)/i);
  expect(h.text()).toMatch(/reported complete\b[^\n]*1\s*\/\s*22/i);
  h.board.dispose();
});
it.each([
  "unavailable",
  "mixed",
  "no-observation",
  "partial-positive",
] as const)(
  "distinguishes full-roster %s access from known observed zero",
  async (mode) => {
    const h = await fixture();
    h.view.subtaskAccess.groups[0].children.forEach((child, index) => {
      child.status =
        mode === "partial-positive" && index === 0
          ? "observed"
          : mode === "no-observation" || (mode === "mixed" && index === 0)
            ? "no-observation"
            : "unavailable";
    });
    h.board.update(h.view);
    const text = h.text();
    if (mode === "no-observation") expect(text).toMatch(/0 observed access/i);
    else if (mode === "partial-positive")
      expect(text).toMatch(/1 observed access/i);
    else {
      expect(text).toMatch(/access[^\n]*unavailable|unavailable[^\n]*access/i);
      expect(text).not.toMatch(/0 observed access/i);
    }
    expect(text).toMatch(/reported complete\b[^\n]*1\s*\/\s*22/i);
    h.board.dispose();
  },
);
it.each([56, 80, 160])(
  "clips sanitized subtasks at%i columns without changing snapshots",
  async (width) => {
    const h = await fixture(32);
    const group = h.view.subtasks.groups[0];
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
