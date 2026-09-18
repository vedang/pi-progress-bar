import {
  type ExtensionContext,
  truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { countReported } from "../core/ledger";
import type { Monitor } from "../core/monitor";

export const widgetName = "pi-progress-bar";
// Do not let source text supply terminal escape sequences.
export const plain = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, " ");
export function paint(ctx: ExtensionContext, monitor: Monitor) {
  if (ctx.mode !== "tui") return;
  ctx.ui.setWidget(widgetName, (_tui, theme) => ({
    render(width) {
      if (width < 2) return [""];
      const count = countReported(monitor.ledger);
      const label = monitor.ledger
        ? `Reported ${count.done}/${count.total}${count.percent === null ? " • Unknown percentage" : ` • ${count.percent}%`}${monitor.ledger.stale ? " • Stale" : ""}`
        : "Progress: select a plan source with /progress";
      const filled = Math.floor((count.percent ?? 0) / 10);
      const bar =
        count.percent === null
          ? ""
          : `[${"#".repeat(filled)}${"-".repeat(10 - filled)}] `;
      const task = monitor.ledger?.tasks.find(
        (item) => item.id === monitor.ledger?.currentTaskId,
      );
      const lines = [
        theme.fg("accent", bar + label),
        theme.fg(
          "muted",
          `Source: ${plain(monitor.ledger?.sourceId ?? "None")} • Task: ${plain(task?.text ?? "Unknown")}`,
        ),
        theme.fg(
          "muted",
          `${monitor.activity} • Refresh ${monitor.interval}s${monitor.error ? ` • ${monitor.error}` : ""}`,
        ),
      ];
      return lines.flatMap(
        (line) =>
          truncateToVisualLines(line, Number.MAX_SAFE_INTEGER, width, 0)
            .visualLines,
      );
    },
    invalidate() {},
  }));
}
export async function details(ctx: ExtensionContext, monitor: Monitor) {
  if (!ctx.hasUI) return;
  const ledger = monitor.ledger;
  const lines = [
    "Reported completion only; not verified correctness.",
    `Source: ${monitor.source ? plain(`${monitor.source.path}${monitor.source.section ? `#${monitor.source.section}` : ""}`) : "None"}`,
    `Refresh: ${monitor.interval}s • ${monitor.activity}`,
    monitor.error ?? "Local file markers; no remote analysis.",
    `Current task: ${plain(ledger?.tasks.find((task) => task.id === ledger.currentTaskId)?.text ?? "Unknown")}`,
    ...(ledger?.tasks.map(
      (task, i) =>
        `${i + 1}. ${task.included ? "Included" : "Excluded"} • ${task.status} • ${plain(task.text)}`,
    ) ?? []),
  ];
  await ctx.ui.select("Progress details (read-only)", lines);
}
