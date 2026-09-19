import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { paint } from "../src/ui/widget";

function fixture(kind = "current", total = 3) {
  return {
    enabled: true,
    progress: { done: total ? 2 : 0, total, kind },
    card: {
      taskId: "task:1",
      revision: 1,
      label: `LONGTITLE ${"日本語 café 🧪 ".repeat(15)}`,
      retained: true,
      replacementPending: true,
      assessedAt: 1000,
      health: {
        requirements: "mostly clear",
        acceptance: "explicit",
        newRedTest: "Not needed",
        redEvidence: "Reported red",
        implementation: "unverified",
      },
    },
    activity: "Idle",
    service: { code: "ready", label: "Ready" },
    usage: {
      jev: { inputTokens: 1, outputTokens: 1 },
      extraction: { inputTokens: 1, outputTokens: 1 },
    },
    lastJevCallAt: 1000,
    lastExtractionCallAt: 900,
  };
}
function render(
  view: ReturnType<typeof fixture>,
  width: number,
  colored = false,
) {
  let component:
    | { render(width: number): string[]; invalidate(): void }
    | undefined;
  const ctx = {
    mode: "tui",
    ui: {
      setWidget: (
        _name: string,
        factory: (tui: unknown, theme: unknown) => typeof component,
      ) => {
        component = factory(
          {},
          {
            fg: (_color: string, text: string) =>
              colored ? `\u001b[38;2;90;128;128m${text}\u001b[39m` : text,
            bold: (text: string) => text,
          },
        );
      },
    },
  } as unknown as ExtensionContext;
  paint(ctx, view as unknown as Parameters<typeof paint>[1]);
  if (!component) throw new Error("Widget not installed");
  const lines = component.render(width);
  component.invalidate();
  expect(component.render(width)).toEqual(lines);
  return lines;
}
it.each([40, 80])(
  "protects provenance and every health field at width %i without controller access",
  (width) => {
    const view = fixture();
    const before = structuredClone(view);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const lines = render(view, width);
    const text = lines.join("\n");
    expect(text).toMatch(/2\/3/);
    for (const label of [
      "Requirements",
      "Acceptance",
      "New red test",
      "Red evidence",
      "Implementation",
    ])
      expect(text).toContain(label);
    expect(text).toMatch(/retained/i);
    expect(text).toMatch(/as.of/i);
    expect(text).toMatch(/pending/i);
    expect(text.toLowerCase().indexOf("retained")).toBeLessThan(
      text.indexOf("LONGTITLE"),
    );
    expect(text).not.toMatch(/Progress state:|diagnostics:|task:1/);
    for (const line of lines)
      expect(truncateToVisualLines(line, 1, width, 0).visualLines).toEqual([
        line,
      ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(view).toEqual(before);
  },
);
it("shows actual Jev dispatch freshness rather than an opaque Ready label", () => {
  const lines = render(fixture(), 80);
  const freshness = lines.find((line) => /last.*jev|jev.*last/i.test(line));
  expect(freshness).toBeDefined();
  expect(freshness).toMatch(/00:00:01|1\/1\/1970|1970-01-01/);
});
it.each([40, 80])(
  "preserves trusted ANSI color sequences without exposing their marker text at width %i",
  (width) => {
    const lines = render(fixture(), width, true);
    expect(lines.some((line) => line.includes("\u001b["))).toBe(true);
    const visible = stripVTControlCharacters(lines.join("\n"));
    expect(visible).not.toMatch(/\[(?:38;2;|39m)/);
    expect(visible).toContain("Requirements:");
    expect(visible).toContain("retained");
    for (const line of lines)
      expect(truncateToVisualLines(line, 1, width, 0).visualLines).toEqual([
        line,
      ]);
  },
);
it.each(["previous", "empty"])(
  "does not render current percentages for %s progress",
  (kind) => {
    const text = render(fixture(kind, kind === "empty" ? 0 : 3), 80).join("\n");
    expect(text).not.toMatch(/\d+%/);
    expect(text).not.toContain("[####");
  },
);
