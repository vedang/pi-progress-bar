import { stripVTControlCharacters } from "node:util";

import {
  type ExtensionContext,
  truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import type { PresentationSnapshot } from "../core/monitor";

export const widgetName = "pi-progress-bar";
const plain = (text: string) =>
  stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, " ");

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

const clipVisualLine = (line: string, width: number) => {
  const visualLines = truncateToVisualLines(line, 1000, width, 0).visualLines;
  return visualLines.length ? [visualLines[0] ?? ""] : [""];
};
const timestamp = (value: number | undefined) => {
  if (value === undefined) return "never";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "unknown";
};

/** Render copied presentation data only; no monitor or branch capability enters UI. */
export function paint(ctx: ExtensionContext, view: PresentationSnapshot) {
  if (ctx.mode !== "tui" || !view.enabled) return;
  ctx.ui.setWidget(widgetName, (_tui, theme) => ({
    render(width) {
      if (width < 2) return [""];
      const { progress, card } = view;
      const current = progress.kind === "current";
      const percent =
        current && progress.total
          ? Math.floor((progress.done * 100) / progress.total)
          : undefined;
      const filled = Math.floor((percent ?? 0) / 10);
      const progressLine = current
        ? `${percent === undefined ? "" : `[${"#".repeat(filled)}${"-".repeat(10 - filled)}] `}Reported ${progress.done}/${progress.total}${percent === undefined ? "" : ` • ${percent}%`}`
        : progress.kind === "previous"
          ? `Reported previous ${progress.done}/${progress.total}`
          : "Progress: no current tasks";
      const provenance = card
        ? [
            `Task assessment: ${card.retained ? "retained" : "current"}`,
            `As-of: ${timestamp(card.assessedAt)}`,
            ...(card.replacementPending
              ? ["Replacement assessment pending"]
              : []),
          ]
        : [];
      const health = card
        ? [
            `Requirements: ${card.health.requirements}`,
            `Acceptance: ${card.health.acceptance}`,
            `New red test: ${card.health.newRedTest}`,
            `Red evidence: ${card.health.redEvidence}`,
            `Implementation: ${card.health.implementation}`,
          ]
        : [
            "Requirements: unknown",
            "Acceptance: unknown",
            "New red test: Unknown",
            "Red evidence: Unknown",
            "Implementation: unverified",
          ];
      const lines = [
        theme.fg("accent", plain(progressLine)),
        ...provenance.map((line) => theme.fg("muted", plain(line))),
        ...(card ? [theme.fg("muted", plain(`Task: ${card.label}`))] : []),
        theme.fg("muted", plain(`${view.activity} • ${view.service.label}`)),
        theme.fg(
          "muted",
          plain(
            `Last Jev dispatch: ${timestamp(view.lastJevCallAt)} • Last extraction dispatch: ${timestamp(view.lastExtractionCallAt)}`,
          ),
        ),
        theme.fg(
          "muted",
          plain(
            `Jev ${view.usage.jev.inputTokens}/${view.usage.jev.outputTokens} tokens • extraction ${view.usage.extraction.inputTokens}/${view.usage.extraction.outputTokens} tokens`,
          ),
        ),
        ...health.map((line) => theme.fg("muted", plain(line))),
      ];
      return lines.flatMap((line) => clipVisualLine(line, width));
    },
    invalidate() {},
  }));
}
