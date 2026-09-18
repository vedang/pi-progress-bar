import {
  type ExtensionContext,
  truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { implementationFromResult } from "../analysis/implementation";
import { countReported } from "../core/ledger";
import type { Monitor } from "../core/monitor";
import { redEvidenceLabel } from "../sources/evidence";

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

function signals(monitor: Monitor): string[] {
  const clarity = monitor.health?.result.answers.clarity;
  const acceptance = monitor.health?.result.answers.acceptance;
  const applicability = monitor.health?.result.answers.redApplicability;
  const report = monitor.health?.result.answers.redReport;
  const applicabilityLabel =
    applicability?.type === "choice"
      ? applicability.choice === "not-needed"
        ? "Not needed"
        : applicability.choice === "needed"
          ? "Needed"
          : "Unknown"
      : "Unknown";
  const red = redEvidenceLabel({
    reported: report?.type === "choice" && report.choice === "reported-red",
    contradiction:
      report?.type === "choice" && report.choice === "contradicted",
    observed: monitor.evidence.redObservation(monitor.evidenceLink()),
  });
  const task = monitor.ledger?.tasks.find(
    (item) =>
      item.id === monitor.ledger?.currentTaskId &&
      item.included &&
      item.status !== "cancelled",
  );
  const implementation = task
    ? implementationFromResult(
        task.criteria,
        monitor.health?.result,
        monitor.evidence.snapshot(monitor.evidenceLink()),
        monitor.evidence.codeRevision(),
        monitor.health?.snapshot.implementationEvidenceComplete ?? false,
      )
    : "unverified";
  return [
    `Requirements: ${clarity?.type === "score" ? clarityLabel(clarity.score) : "unknown"}`,
    `Acceptance: ${acceptance?.type === "choice" ? acceptance.choice : "unknown"}`,
    `New red test: ${applicabilityLabel}`,
    `Red evidence: ${red}`,
    `Implementation: ${implementation}`,
  ];
}

export function paint(ctx: ExtensionContext, monitor: Monitor) {
  if (ctx.mode !== "tui" || !monitor.enabled) return;
  ctx.ui.setWidget(widgetName, (_tui, theme) => ({
    render(width) {
      if (width < 2) return [""];
      const count = countReported(monitor.ledger);
      const label = monitor.ledger
        ? `Reported ${count.done}/${count.total}${count.percent === null ? " • unknown percentage" : ` • ${count.percent}%`}${monitor.ledger.stale ? " • stale" : ""}`
        : `Progress: ${monitor.conversation.discoveryStatus}`;
      const filled = Math.floor((count.percent ?? 0) / 10);
      const bar =
        count.percent === null
          ? ""
          : `[${"#".repeat(filled)}${"-".repeat(10 - filled)}] `;
      const task = monitor.ledger?.tasks.find(
        (item) =>
          item.id === monitor.ledger?.currentTaskId &&
          item.included &&
          item.status !== "cancelled",
      );
      const lines = [
        theme.fg("accent", bar + label),
        theme.fg(
          "muted",
          `Task: ${plain(task?.text ?? "unknown").slice(0, 160)}${task?.beads ? ` • Beads ${plain(task.beads.id)}${task.beads.conflict ? " (export disagreement)" : ""}` : ""}`,
        ),
        theme.fg(
          "muted",
          `${monitor.activity} • analysis every ${monitor.interval}s • ${plain(monitor.error ?? monitor.gateway.status)}`,
        ),
        ...signals(monitor).map((line) => theme.fg("muted", plain(line))),
      ];
      return lines.flatMap(
        (line) => truncateToVisualLines(line, 2, width, 0).visualLines,
      );
    },
    invalidate() {},
  }));
}
