import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import * as widget from "../src/ui/widget";
import { uxView } from "./fixtures/ux-view";

function render(
  view = uxView(),
  width = 160,
  selected = false,
  color = false,
): string[] {
  const fn = Reflect.get(widget, "renderWidget");
  expect(fn, "pure renderWidget(snapshot,selected,width,theme)").toBeTypeOf(
    "function",
  );
  const theme = {
    fg: (_: string, text: string) =>
      color ? `\u001b[36m${text}\u001b[39m` : text,
    bold: (text: string) => text,
  } as Theme;
  return Reflect.apply(fn, undefined, [view, selected, width, theme]);
}
it("renders exact compact ready fixture, with hidden usage and no health rows", () => {
  expect(render()).toEqual([
    "Reported 7/12 · 58%  ███████░░░░░  Jev 10:03:12",
    "Current Task: (INPROG) Handle escaped delimiters in parser",
    "→ to inspect",
  ]);
});
it("shows both actual request counts and direction-labelled tokens only when selected", () => {
  const lines = render(uxView(), 160, true);
  expect(lines).toContain(
    "Jev · ↓ 10.4K · ↑ 765 tokens · 200 calls • Extraction · ↓ 1425 · ↑ 194 tokens · 20 calls",
  );
  expect(lines.join("\n")).toContain("enter to see board");
  expect(render().join("\n")).not.toMatch(
    /tokens|calls|Extraction|Requirements|Acceptance|Implementation/,
  );
});
it.each([
  [0, 12, 0],
  [1, 100, 0],
  [1, 12, 1],
  [7, 12, 7],
  [11, 12, 11],
  [12, 12, 12],
])("fills twelve cells directly for %i/%i", (done, total, filled) => {
  const view = uxView();
  view.presentation.progress = { done, total, kind: "current" };
  expect(render(view)[0]).toContain(
    "█".repeat(filled) + "░".repeat(12 - filled),
  );
});
it.each([
  [9999, "9999"],
  [10000, "10.0K"],
  [10449, "10.4K"],
  [10450, "10.5K"],
])("formats %i input tokens as %s", (tokens, text) => {
  const view = uxView();
  view.presentation.usage.jev.inputTokens = tokens;
  expect(render(view, 160, true).join("\n")).toContain(`Jev · ↓ ${text} ·`);
});
it.each(["OPEN", "INPROG", "DONE"] as const)(
  "renders one actual status %s",
  (status) => {
    const view = uxView();
    view.board.currentTask = {
      taskId: "task:1",
      status,
      ...(status === "DONE" ? { qualifier: "Last reported · idle" } : {}),
    };
    const text = render(view).join("\n");
    expect(text).toContain(`Current Task: (${status})`);
    if (status === "DONE") expect(text).toContain("Last reported · idle");
    expect(text).not.toContain("OPEN|INPROG|DONE");
  },
);
it("never substitutes newest or health-card task when display identity is absent", () => {
  const view = uxView();
  delete view.board.currentTask;
  const text = render(view).join("\n");
  expect(text).toMatch(/Current Task:.*not identified/i);
  expect(text).not.toContain(view.board.tasks[0]?.label);
});
it.each(["previous", "empty"] as const)(
  "omits misleading percentage/bar for %s",
  (kind) => {
    const view = uxView();
    view.presentation.progress.kind = kind;
    if (kind === "empty")
      view.presentation.progress = { kind, done: 0, total: 0 };
    expect(render(view)[0]).not.toMatch(/\d+%|[█░]/);
    expect(render(view)[0]).toMatch(
      kind === "previous" ? /previous/i : /no.*tasks|empty/i,
    );
  },
);
it("restore warning outranks scope/catchup/progress in both snapshot sources", () => {
  const view = uxView();
  view.presentation.progress.kind = "previous";
  view.presentation.progress.catchup = "Catching up history";
  view.presentation.service = view.board.service = {
    code: "saved-state-corrupt",
    label: "Saved progress needs a fresh session",
  };
  const line = render(view, 80)[0];
  expect(line).toMatch(/fresh session/i);
  expect(line).not.toMatch(/58%|Catching up|Ready|█/);
});
it.each([1, 2, 8, 20, 40, 80, 120])(
  "bounds every rendered line by %i display columns",
  (width) => {
    const view = uxView();
    const task = view.board.tasks[0];
    if (!task) throw new Error("Missing task");
    task.label = `日本語 café 🧪 ${"界".repeat(120)}\u001b[31mUNTRUSTED\u001b[0m\nspoof`;
    const before = structuredClone(view);
    for (const selected of [false, true]) {
      const lines = render(view, width, selected, true);
      for (const line of lines)
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(stripVTControlCharacters(lines.join("\n"))).not.toMatch(
        /\[31m|\[0m/,
      );
    }
    expect(view).toEqual(before);
  },
);
it.each([40, 80, 120])(
  "keeps both providers and counters reachable at width %i",
  (width) => {
    const text = render(uxView(), width, true).join(" ");
    expect(text).toContain("Jev");
    expect(text).toContain("Extraction");
    expect(text).toContain("200 calls");
    expect(text).toContain("20 calls");
  },
);
it("render, resize and theme handling are pure", () => {
  const view = uxView();
  const before = structuredClone(view);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  for (const width of [40, 120, 80, 40]) render(view, width, true);
  expect(view).toEqual(before);
  expect(fetch).not.toHaveBeenCalled();
});
