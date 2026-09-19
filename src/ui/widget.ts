import {
  type ExtensionContext,
  truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { countReported } from "../core/ledger";
import type { Monitor, PresentationTaskCard } from "../core/monitor";
import { gatewayStatusLabel, lastJevCallLabel } from "./freshness";

export const widgetName = "pi-progress-bar";
const plain = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, " ");

export function clarityLabel(score: unknown): string {
  if (
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > 3
  )
    return "unknown";
  if (score < 1) return "unclear";
  if (score < 2) return "partly clear";
  if (score < 3) return "mostly clear";
  return "clear";
}

function signals(card: PresentationTaskCard | undefined): string[] {
  const assessment = card?.assessment;
  return [
    `Requirements: ${assessment?.requirements ?? "unknown"}`,
    `Acceptance: ${assessment?.acceptance ?? "unknown"}`,
    `New red test: ${assessment?.newRedTest ?? "Unknown"}`,
    `Red evidence: ${assessment?.redEvidence ?? "Unknown"}`,
    `Implementation: ${assessment?.implementation ?? "unverified"}`,
  ];
}

export function paint(ctx: ExtensionContext, monitor: Monitor) {
  if (ctx.mode !== "tui" || !monitor.enabled) return;
  ctx.ui.setWidget(widgetName, (_tui, theme) => ({
    render(width) {
      if (width < 2) return [""];
      const count = countReported(monitor.ledger);
      const unresolvedScope = monitor.scopeIsUnresolved();
      const label = monitor.ledger
        ? unresolvedScope
          ? `Reported ${count.done}/${count.total} • historical; scope unresolved`
          : `Reported ${count.done}/${count.total}${count.percent === null ? " • unknown percentage" : ` • ${count.percent}%`}${monitor.ledger.stale ? " • stale" : ""}`
        : `Progress: ${monitor.progressState()}`;
      const filled = Math.floor((count.percent ?? 0) / 10);
      const bar =
        unresolvedScope || count.percent === null
          ? ""
          : `[${"#".repeat(filled)}${"-".repeat(10 - filled)}] `;
      const card = monitor.taskCard();
      const task = card?.task;
      const taskLabel = card?.current
        ? "Task"
        : card?.selected
          ? "Selected task (current unknown)"
          : "Last task";
      const retained = card?.retained
        ? ` • retained last assessed${card.assessedAt ? ` as-of ${new Date(card.assessedAt).toISOString()}` : ""}${card.replacementPending ? " • replacement assessment pending" : ""}`
        : card?.current && !card.assessment
          ? " • assessment pending"
          : "";
      const lines = [
        theme.fg("accent", bar + label),
        theme.fg(
          "muted",
          `${taskLabel}: ${plain(task?.text ?? "unknown").slice(0, 160)}${retained}${task?.beads ? ` • Beads ${plain(task.beads.id)}${task.beads.conflict ? " (export disagreement)" : ""}` : ""}`,
        ),
        theme.fg(
          "muted",
          `${monitor.activity} • event-driven analysis • Last Jev call: ${lastJevCallLabel(monitor.gateway.lastCallAt)} • ${plain(monitor.error ?? gatewayStatusLabel(monitor.gateway.status))}`,
        ),
        theme.fg(
          "muted",
          `Progress state: ${monitor.progressState()} • diagnostics: ${monitor.diagnosticSummary()}`,
        ),
        ...signals(card).map((line) => theme.fg("muted", plain(line))),
      ];
      return lines.flatMap(
        (line) => truncateToVisualLines(line, 2, width, 0).visualLines,
      );
    },
    invalidate() {},
  }));
}
