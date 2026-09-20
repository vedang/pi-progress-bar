import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { createBoard as create } from "../src/ui/board";
import { monitorHarness } from "./fixtures/hybrid-monitor";
import { uxView } from "./fixtures/ux-view";

type Snapshot = ReturnType<typeof uxView>;
function tasks(count: number): Snapshot {
  const view = uxView();
  const base = view.board.tasks[0];
  if (!base) throw new Error("Missing fixture task");
  view.board.tasks = Array.from({ length: count }, (_, index) => ({
    ...structuredClone(base),
    taskId: `task:${index}`,
    label: `Unique task ${index}`,
    status: "OPEN" as const,
    transitions: Array.from({ length: 60 }, (_, step) => ({
      kind: `transition-${index}-${step}`,
    })),
  }));
  delete view.board.currentTask;
  return view;
}
async function fixture(view = tasks(200), rows = 40) {
  let focused = true;
  let screenRows = rows;
  const onClose = vi.fn();
  const requestRender = vi.fn();
  const theme = {
    fg: (_: string, text: string) => text,
    bg: (_: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  const board = await create(view, {
    theme,
    screenRows: () => screenRows,
    isFocused: () => focused,
    onClose,
    requestRender,
  });
  const text = (width = 113) =>
    board.render(width).map(stripVTControlCharacters).join("\n");
  text();
  return {
    board,
    view,
    text,
    onClose,
    requestRender,
    resize: (next: number) => {
      screenRows = next;
    },
    blur: () => {
      focused = false;
    },
  };
}
const keys = {
  down: "\u001b[B",
  up: "\u001b[A",
  right: "\u001b[C",
  left: "\u001b[D",
  end: "\u001b[F",
  home: "\u001b[H",
  pageDown: "\u001b[6~",
  pageUp: "\u001b[5~",
};
const summary = [
  "Requirements",
  "Acceptance",
  "New red test",
  "Red evidence",
  "Implementation",
];

it.each([0, 1, 200])(
  "renders %i retained tasks without fabricating activity",
  async (count) => {
    const h = await fixture(tasks(count));
    expect(h.board.viewState().selectedId).toBe(count ? "task:0" : undefined);
    if (count) {
      for (const label of summary) expect(h.text()).toContain(label);
      expect(h.text()).toContain("OPEN");
      expect(h.text()).not.toContain("INPROG");
    } else expect(h.text()).toMatch(/no .*tasks/i);
  },
);
it("defaults to the exact displayed task but keeps user selection on live focus changes", async () => {
  const view = tasks(20);
  view.board.currentTask = { taskId: "task:8", status: "INPROG" };
  const h = await fixture(view);
  expect(h.board.viewState().selectedId).toBe("task:8");
  h.board.handleInput(keys.down);
  expect(h.board.viewState().selectedId).toBe("task:9");
  view.board.currentTask.taskId = "task:2";
  h.board.update(view);
  expect(h.board.viewState().selectedId).toBe("task:9");
});
it("reaches every retained task and clamps both page boundaries", async () => {
  const h = await fixture();
  const visited = new Set([h.board.viewState().selectedId]);
  for (let i = 0; i < 205; i++) {
    h.board.handleInput(keys.down);
    h.text();
    visited.add(h.board.viewState().selectedId);
  }
  expect(visited.size).toBe(200);
  expect(h.board.viewState().selectedId).toBe("task:199");
  expect(h.board.viewState().listOffset).toBeGreaterThan(0);
  h.board.handleInput(keys.home);
  expect(h.board.viewState().selectedId).toBe("task:0");
  h.board.handleInput(keys.pageDown);
  const page = Number(h.board.viewState().selectedId?.split(":")[1]);
  expect(page).toBeGreaterThan(1);
  expect(page).toBeLessThan(199);
  h.board.handleInput(keys.pageUp);
  expect(h.board.viewState().selectedId).toBe("task:0");
  h.board.handleInput(keys.up);
  expect(h.board.viewState().selectedId).toBe("task:0");
  h.board.handleInput(keys.end);
  expect(h.board.viewState().selectedId).toBe("task:199");
});
it("preserves task identity on newest insertion, uses same-index neighbor on removal", async () => {
  const h = await fixture(tasks(8));
  h.board.handleInput(keys.down);
  h.board.handleInput(keys.down);
  const extra = structuredClone(h.view.board.tasks[0]);
  if (!extra) throw new Error("Missing task");
  extra.taskId = "newest";
  h.view.board.tasks.unshift(extra);
  h.board.update(h.view);
  expect(h.board.viewState().selectedId).toBe("task:2");
  h.view.board.tasks = h.view.board.tasks.filter(
    (task) => task.taskId !== "task:2",
  );
  h.board.update(h.view);
  expect(h.board.viewState().selectedId).toBe("task:3");
  h.board.handleInput(keys.end);
  h.view.board.tasks.pop();
  h.board.update(h.view);
  expect(h.board.viewState().selectedId).toBe("task:6");
});
it("shows exact status and safe assessment provenance without cross-linking duplicate labels", async () => {
  const view = tasks(2);
  const [a, b] = view.board.tasks;
  if (!a || !b) throw new Error("Missing tasks");
  a.label = b.label = "Same label";
  a.health.requirements = "FIRST HEALTH";
  b.health.requirements = "SECOND HEALTH";
  b.status = "ARCHIVED";
  b.included = false;
  b.provenance = {
    state: "retained",
    role: "assistant",
    assessedAt: Date.parse("2026-09-20T10:03:12Z"),
  };
  const h = await fixture(view);
  expect(h.text()).toContain("FIRST HEALTH");
  expect(h.text()).not.toContain("SECOND HEALTH");
  h.board.handleInput(keys.down);
  expect(h.text()).toContain("SECOND HEALTH");
  expect(h.text()).not.toContain("FIRST HEALTH");
  expect(h.text()).toContain("ARCHIVED");
  expect(h.text()).toContain("retained");
  expect(h.text()).toContain("10:03:12");
  expect(h.text()).toContain("assistant");
  b.status = "DONE";
  b.included = true;
  h.board.update(view);
  expect(h.text()).toContain("DONE");
});
it("keeps service and all five Summary fields outside the toggled task debugger", async () => {
  const view = tasks(2);
  view.board.service = view.presentation.service = {
    code: "jev-unavailable",
    label: "Jev service unavailable",
  };
  const h = await fixture(view);
  expect(h.text()).toContain("Jev service unavailable");
  expect(h.text()).not.toContain("transition-0-0");
  h.board.handleInput("d");
  expect(h.board.viewState().debugger).toBe(true);
  for (const label of summary) expect(h.text()).toContain(label);
  expect(h.text()).toContain("Jev service unavailable");
  expect(h.text()).toContain("transition-0-0");
  expect(h.text()).not.toContain("transition-1-0");
  expect(h.text()).toMatch(/global.*(?:calls|usage|counter)/i);
  h.board.handleInput("d");
  expect(h.board.viewState().debugger).toBe(false);
  expect(h.text()).not.toContain("transition-0-0");
});
it("scrolls detail independently while pinning Summary and service, then resets on task change", async () => {
  const h = await fixture();
  h.board.handleInput("d");
  h.board.handleInput(keys.right);
  expect(h.board.viewState().pane).toBe("detail");
  const before = h.board.viewState();
  for (let i = 0; i < 10; i++) h.board.handleInput(keys.pageDown);
  expect(h.board.viewState().detailOffset).toBeGreaterThan(0);
  expect(h.board.viewState().selectedId).toBe(before.selectedId);
  expect(h.board.viewState().listOffset).toBe(before.listOffset);
  for (const label of summary) expect(h.text()).toContain(label);
  expect(h.text()).toContain("transition-0-59");
  h.board.handleInput(keys.left);
  h.board.handleInput(keys.down);
  expect(h.board.viewState().selectedId).toBe("task:1");
  expect(h.board.viewState().detailOffset).toBe(0);
  expect(h.text()).not.toContain("transition-0-");
});
it.each([
  [113, 40],
  [75, 24],
  [56, 20],
  [37, 16],
  [1, 2],
])(
  "bounds rows/columns at overlay width %i and screen rows %i",
  async (width, rows) => {
    const view = tasks(3);
    const task = view.board.tasks[0];
    if (!task) throw new Error("Missing task");
    task.label = "日本語 👩‍💻 é ".repeat(60);
    const h = await fixture(view, rows);
    h.board.handleInput("d");
    const lines = h.board.render(width);
    expect(lines.length).toBeLessThanOrEqual(
      Math.max(0, Math.min(Math.floor(rows * 0.8), rows - 2)),
    );
    for (const line of lines)
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    if (width >= 56)
      for (const label of summary) expect(h.text(width)).toContain(label);
    else if (rows >= 16) expect(h.text(width)).toMatch(/(?:too small|resize)/i);
    h.board.handleInput("\u001b");
    expect(h.onClose).toHaveBeenCalledTimes(1);
  },
);
it("resizing preserves selection and recovers from the explicit size notice", async () => {
  const h = await fixture();
  h.board.handleInput(keys.end);
  h.resize(16);
  expect(h.text(37)).toMatch(/(?:too small|resize)/i);
  h.resize(40);
  h.text();
  expect(h.board.viewState().selectedId).toBe("task:199");
  for (const label of summary) expect(h.text()).toContain(label);
});
it("clones snapshots and exposes detached view state without modifying semantic input", async () => {
  const view = tasks(3);
  const original = structuredClone(view);
  const h = await fixture(view);
  h.board.handleInput(keys.down);
  h.board.handleInput("d");
  h.text();
  expect(view).toEqual(original);
  const local = h.board.viewState();
  local.selectedId = "forged";
  expect(h.board.viewState().selectedId).toBe("task:1");
  const task = view.board.tasks[1];
  if (task) task.label = "unpublished mutation";
  expect(h.text()).not.toContain("unpublished mutation");
  h.board.update(view);
  expect(h.text()).toContain("unpublished mutation");
});
it("ignores release events, sibling focus and callbacks after disposal", async () => {
  const h = await fixture();
  h.board.handleInput("\u001b[100;1:3u");
  expect(h.board.viewState().debugger).toBe(false);
  h.blur();
  h.board.handleInput(keys.down);
  h.board.handleInput("d");
  h.board.handleInput("\u001b");
  expect(h.board.viewState().selectedId).toBe("task:0");
  expect(h.onClose).not.toHaveBeenCalled();
  h.board.dispose();
  h.board.dispose();
  const renders = h.requestRender.mock.calls.length;
  h.board.handleInput("\u001b");
  h.board.update(tasks(5));
  h.text();
  expect(h.onClose).not.toHaveBeenCalled();
  expect(h.requestRender).toHaveBeenCalledTimes(renders);
});

it("UI navigation/render/debugger/resize has zero canonical, save, provider or timer effects", async () => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline-key");
  const m = monitorHarness();
  try {
    m.start();
    await m.settle("goal");
    const snapshot = {
      presentation: m.monitor.presentationSnapshot(),
      board: m.monitor.boardSnapshot(),
    };
    const receipt = () => ({
      state: structuredClone(m.monitor.state),
      saves: m.save.mock.calls.length,
      reads: m.reader.mock.calls.length,
      fetches: m.fetch.mock.calls.length,
      extracts: m.extract.mock.calls.length,
      timers: vi.getTimerCount(),
      presentation: m.monitor.presentationSnapshot(),
      board: m.monitor.boardSnapshot(),
    });
    const before = receipt();
    const h = await fixture(snapshot);
    for (let i = 0; i < 40; i++) {
      for (const key of [
        keys.down,
        "d",
        keys.right,
        keys.pageDown,
        keys.left,
        keys.up,
      ])
        h.board.handleInput(key);
      h.resize(i % 2 ? 20 : 40);
      h.text(i % 2 ? 56 : 113);
      h.board.update(snapshot);
    }
    h.board.handleInput("\u001b");
    h.board.dispose();
    expect(receipt()).toEqual(before);
  } finally {
    m.monitor.stop();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});
it("removes whole untrusted terminal sequences before trusted theme styling", async () => {
  const view = tasks(1);
  const task = view.board.tasks[0];
  if (!task) throw new Error("Missing task");
  task.label =
    "\u001b]8;;https://hidden.invalid\u0007VISIBLE\u001b]8;;\u0007\u009b31m";
  task.health.requirements = "\u001b[31mUnassessed\u001b[0m";
  const theme = {
    fg: (_: string, text: string) => `\u001b[36m${text}\u001b[39m`,
    bg: (_: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  const board = await create(view, {
    theme,
    screenRows: () => 40,
    isFocused: () => true,
    onClose: vi.fn(),
    requestRender: vi.fn(),
  });
  const lines = board.render(113);
  const text = lines.map(stripVTControlCharacters).join("\n");
  expect(text).toContain("VISIBLE");
  expect(text).not.toContain("hidden.invalid");
  expect(text).not.toContain("]8;;");
  expect(text).not.toContain("31m");
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(113);
});

it("resets task-local scroll when a publication removes the inspected task", async () => {
  const h = await fixture(tasks(3));
  h.board.handleInput("d");
  h.board.handleInput(keys.right);
  h.board.handleInput(keys.end);
  h.text();
  expect(h.board.viewState().detailOffset).toBeGreaterThan(0);
  h.view.board.tasks.shift();
  h.board.update(h.view);
  expect(h.board.viewState().selectedId).toBe("task:1");
  expect(h.board.viewState().detailOffset).toBe(0);
  expect(h.text()).toContain("transition-1-0");
});

it.each([false, true])(
  "keeps complete required details reachable at 56x20 (debugger=%s)",
  async (debuggerOpen) => {
    const view = tasks(1);
    const task = view.board.tasks[0];
    if (!task) throw new Error("Missing task");
    const words = Array.from(
      { length: 26 },
      (_, i) => `label${String(i).padStart(2, "0")}`,
    );
    task.label = words.join(" ");
    task.health.acceptance = "not-found-in-context";
    task.health.implementation = "appears complete";
    task.provenance = {
      state: "retained",
      role: "assistant",
      assessedAt: Date.parse("2026-09-20T10:03:12Z"),
    };
    view.board.service = view.presentation.service = {
      code: "saved-state-corrupt",
      label: "Saved progress state is corrupt; start a fresh session",
    };
    const h = await fixture(view, 20);
    h.text(56);
    if (debuggerOpen) h.board.handleInput("d");
    h.board.handleInput(keys.right);
    const frames: string[] = [];
    for (let i = 0; i < 180; i++) {
      const lines = h.board.render(56).map(stripVTControlCharacters);
      expect(lines.length).toBeLessThanOrEqual(16);
      for (const line of lines)
        expect(visibleWidth(line)).toBeLessThanOrEqual(56);
      // Left pane is 22 columns plus one gap at this exact geometry; ASCII fixture.
      const right = lines.slice(0, -1).map((line) => line.slice(23));
      const frame = right.join("\n");
      for (const label of summary) expect(frame).toContain(label);
      expect(frame).toContain("Service:");
      frames.push(frame.replace(/\s+/g, ""));
      h.board.handleInput(keys.down);
    }
    for (const value of [
      ...words,
      "not-found-in-context",
      "appears complete",
      "retained",
      "assistant",
      "10:03:12",
      "start a fresh session",
    ])
      expect(
        frames.some((frame) => frame.includes(value.replace(/\s+/g, ""))),
        `Unreachable detail: ${value}`,
      ).toBe(true);
    h.board.handleInput(keys.home);
    expect(h.board.viewState().detailOffset).toBe(0);
  },
);

it("keeps health values, not just empty Summary labels, pinned while details scroll", async () => {
  const view = tasks(1);
  const task = view.board.tasks[0];
  if (!task) throw new Error("Missing task");
  task.health = {
    requirements: "clear",
    acceptance: "explicit",
    newRedTest: "not-needed",
    redEvidence: "not-found-in-context",
    implementation: "appears complete",
  };
  const h = await fixture(view);
  h.board.handleInput("d");
  h.board.handleInput(keys.right);
  h.board.handleInput(keys.end);
  const text = h.text();
  for (const [label, value] of [
    ["Requirements", "clear"],
    ["Acceptance", "explicit"],
    ["New red test", "not-needed"],
    ["Red evidence", "not-found-in-context"],
    ["Implementation", "appears complete"],
  ])
    expect(text).toContain(`${label}: ${value}`);
});

it("renders full service text on an empty narrow board", async () => {
  const view = tasks(0);
  view.board.service = view.presentation.service = {
    code: "retry-waiting",
    label: "Waiting to retry progress analysis",
  };
  const h = await fixture(view, 20);
  const lines = h.board.render(56).map(stripVTControlCharacters);
  const right = lines
    .slice(0, -1)
    .map((line) => line.slice(23))
    .join("")
    .replace(/\s+/g, "");
  expect(right).toContain("Waitingtoretryprogressanalysis");
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(56);
});
it("wraps spacing-mark graphemes atomically at narrow pane boundaries", async () => {
  const view = tasks(1);
  const task = view.board.tasks[0];
  if (!task) throw new Error("Missing task");
  task.label = `${"a".repeat(26)}का`;
  const h = await fixture(view, 20);
  const lines = h.board.render(56).map(stripVTControlCharacters);
  const right = lines.slice(0, -1).map((line) => line.slice(23));
  expect(right.some((line) => line.includes("का"))).toBe(true);
  expect(right.some((line) => line.trimStart().startsWith("ा"))).toBe(false);
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(56);
});

it.each([113, 56])(
  "renders each Summary field once at width %i, with diagnostics hidden",
  async (width) => {
    const h = await fixture(tasks(1), width === 56 ? 20 : 40);
    const text = h.text(width);
    for (const label of [...summary, "Service", "Summary"])
      expect(
        text.match(new RegExp(`${label}:`, "g")) ?? [],
        `${label} must appear once`,
      ).toHaveLength(1);
    expect(text).not.toContain("Identity:");
    expect(text).not.toContain("Debugger: off");
  },
);
it("does not duplicate Summary when task debugger is enabled", async () => {
  const h = await fixture(tasks(1));
  h.board.handleInput("d");
  const text = h.text();
  for (const label of [...summary, "Service", "Summary"])
    expect(text.match(new RegExp(`${label}:`, "g")) ?? []).toHaveLength(1);
  expect(text).toContain("transition-0-0");
});

it.each([180, 56])(
  "rich field provenance remains reachable at width %i without enabling debugger",
  async (width) => {
    const view = tasks(1);
    const task = view.board.tasks[0];
    if (!task) throw new Error("Missing task");
    const value = (
      text: string,
      role: string,
      second: string,
      confidence: number,
      probability: number,
    ) => ({
      text,
      provenance: {
        role,
        validatedAt: Date.parse(`2026-09-20T10:00:${second}Z`),
        confidence,
        probability,
      },
    });
    Object.assign(task, {
      details: {
        title: value("Exact title", "user", "01", 0.5, 0.8),
        description: value("Exact description", "assistant", "02", 0.6, 0.9),
        acceptanceCriteria: [
          value("Exact condition", "intercom", "03", 0.7, 1),
        ],
      },
    });
    const h = await fixture(view, width === 56 ? 20 : 60);
    h.board.handleInput(keys.right);
    let seen = "";
    for (let page = 0; page < 60; page++) {
      const lines = h.board.render(width).map(stripVTControlCharacters);
      for (const line of lines)
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      seen += lines.join("").replace(/\s+/g, "");
      h.board.handleInput(keys.pageDown);
    }
    for (const token of [
      "user",
      "assistant",
      "intercom",
      "10:00:01",
      "10:00:02",
      "10:00:03",
      "50%",
      "60%",
      "70%",
      "80%",
      "90%",
      "100%",
    ])
      expect(seen).toContain(token);
    expect(seen).not.toMatch(/quoteHash|messageHash|entryId/);
  },
);

it("renders accepted rich sections once without duplicating Summary or replacing tracked Task", async () => {
  const view = tasks(1);
  const task = view.board.tasks[0];
  if (!task) throw new Error("Missing task");
  const value = (text: string) => ({
    text,
    provenance: {
      role: "user",
      validatedAt: 1,
      confidence: 0.5,
      probability: 0.8,
    },
  });
  Object.assign(task, {
    details: {
      title: value("Grounded title"),
      description: value("Grounded description"),
      acceptanceCriteria: [value("Explicit condition")],
    },
  });
  const h = await fixture(view, 60);
  const text = h.text(160);
  for (const label of [
    "Task Title",
    "Description",
    "Acceptance Criteria",
    "Summary",
    "Service",
    ...summary,
  ])
    expect(text.match(new RegExp(`${label}:`, "g")) ?? []).toHaveLength(1);
  expect(text).toContain(`Task: ${task.label}`);
  for (const value of [
    "Grounded title",
    "Grounded description",
    "Explicit condition",
  ])
    expect(text).toContain(value);
});
it("rich Unicode detail tail remains reachable at 56x20 with debugger on or off", async () => {
  const view = tasks(1);
  const task = view.board.tasks[0];
  if (!task) throw new Error("Missing task");
  const text = `${"काफ़ी 😀 ".repeat(65)}DETAIL-END`;
  Object.assign(task, {
    details: {
      description: {
        text,
        provenance: {
          role: "user",
          validatedAt: 1,
          confidence: 1,
          probability: 1,
        },
      },
    },
  });
  const h = await fixture(view, 20);
  for (const debug of [false, true]) {
    if (debug) h.board.handleInput("d");
    h.board.handleInput(keys.right);
    h.board.handleInput(keys.home);
    let reached = false;
    for (let page = 0; page < 80; page++) {
      const lines = h.board.render(56).map(stripVTControlCharacters);
      for (const line of lines)
        expect(visibleWidth(line)).toBeLessThanOrEqual(56);
      if (lines.join("").replace(/\s+/g, "").includes("DETAIL-END"))
        reached = true;
      h.board.handleInput(keys.pageDown);
    }
    expect(reached).toBe(true);
  }
});
