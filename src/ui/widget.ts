import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { BoardSnapshot } from "../core/board-projection";
import type { PresentationSnapshot } from "../core/monitor";

export interface WidgetSnapshot {
  presentation: PresentationSnapshot;
  board: BoardSnapshot;
}

/** Existing safe health-label utility; board owns where it is displayed. */
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

const esc = String.fromCharCode(27);
// Unterminated OSC tails have no visible label content. Drop before the proven
// VT sanitizer, which handles complete OSC/CSI/C1 sequences and partial CSI.
const incompleteOsc = new RegExp(
  `(?:${esc}\\]|${String.fromCharCode(157)})(?:(?!${esc}\\\\|${String.fromCharCode(156)}|${String.fromCharCode(7)})[\\s\\S])*$`,
  "g",
);
const untrusted = (text: string) =>
  stripVTControlCharacters(text.replace(incompleteOsc, ""))
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .trim();

const time = (value: number | undefined) => {
  if (value === undefined) return "never";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toISOString().slice(11, 19)
    : "unknown";
};

const compact = (value: number) => {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value < 10_000) return `${Math.floor(value)}`;
  return `${(Math.round(value / 100) / 10).toFixed(1)}K`;
};

/** Wrap sanitized text without padding; replace one too-wide glyph at tiny widths. */
const wrap = (text: string, width: number) => {
  if (width < 1) return [""];
  const safe = untrusted(text);
  if (!safe) return [""];
  const lines: string[] = [];
  let line = "";
  for (const point of Array.from(safe)) {
    const glyph = visibleWidth(point) > width ? "?" : point;
    if (line && visibleWidth(line + glyph) > width) {
      lines.push(line);
      line = "";
    }
    line += glyph;
  }
  if (line || !lines.length) lines.push(line);
  return lines;
};

const shortWarning = (code: string, label: string, width: number) => {
  const safe = untrusted(label);
  if (visibleWidth(safe) <= width) return safe;
  const alternatives = code.startsWith("saved-state-")
    ? ["Start fresh session", "New chat"]
    : code === "capacity-exhausted"
      ? ["Capacity reached", "Capacity"]
      : code === "previous"
        ? ["Previous progress", "Previous"]
        : code === "catchup"
          ? ["Catching up", "Catch-up"]
          : code === "analysis-active"
            ? ["Analyzing", "Working"]
            : code === "retry-waiting"
              ? ["Retry waiting", "Waiting"]
              : ["Service unavailable", "Offline"];
  return alternatives.find((text) => visibleWidth(text) <= width) ?? "!";
};

const warning = (snapshot: WidgetSnapshot, width: number) => {
  const { presentation, board } = snapshot;
  const { service, progress } = presentation;
  if (
    service.code === "saved-state-corrupt" ||
    service.code === "saved-state-unsupported"
  )
    return shortWarning(service.code, service.label, width);
  if (service.code === "capacity-exhausted")
    return shortWarning(service.code, service.label, width);
  if (progress.kind === "previous")
    return shortWarning(
      "previous",
      `Reported previous ${progress.done}/${progress.total}`,
      width,
    );
  if (progress.catchup) return shortWarning("catchup", progress.catchup, width);
  if (
    service.code === "jev-unavailable" ||
    service.code === "model-unavailable"
  )
    return shortWarning(service.code, service.label, width);
  if (service.code !== "ready" || board.service.code !== "ready")
    return shortWarning(service.code, service.label, width);
  if (
    ["Extracting tasks", "Assessing progress", "Analyzing progress"].includes(
      presentation.activity,
    )
  )
    return shortWarning("analysis-active", presentation.activity, width);
};

const currentTask = (board: BoardSnapshot) => {
  const current = board.currentTask;
  if (!current) return "Current Task: not identified";
  const task = board.tasks.find((item) => item.taskId === current.taskId);
  if (!task) return `Current Task: (${current.status}) not identified`;
  const qualifier = current.qualifier ? ` · ${current.qualifier}` : "";
  return `Current Task: (${current.status}) ${task.label}${qualifier}`;
};

const usage = (snapshot: WidgetSnapshot) => {
  const { jev, extraction } = snapshot.presentation.usage;
  return `Jev · ↓ ${compact(jev.inputTokens)} · ↑ ${compact(jev.outputTokens)} tokens · ${jev.calls} calls • Extraction · ↓ ${compact(extraction.inputTokens)} · ↑ ${compact(extraction.outputTokens)} tokens · ${extraction.calls} calls`;
};

/**
 * Pure compact view over detached monitor snapshots. It owns neither a monitor
 * nor a host capability; wrapping/theme work cannot read history or dispatch.
 */
export function renderWidget(
  snapshot: WidgetSnapshot,
  selected: boolean,
  width: number,
  theme: Theme,
): string[] {
  const columns = Math.max(1, Math.floor(width));
  const { presentation } = snapshot;
  const issue = warning(snapshot, columns);
  const header = issue
    ? issue
    : presentation.progress.kind === "current" &&
        presentation.progress.total > 0
      ? (() => {
          const { done, total } = presentation.progress;
          const percent = Math.floor((done * 100) / total);
          const filled = Math.floor((done * 12) / total);
          const clock = `Jev ${time(presentation.lastJevCallAt)}`;
          const counts = `Reported ${done}/${total}`;
          const full = `${counts} · ${percent}%  ${"█".repeat(filled)}${"░".repeat(12 - filled)}  ${clock}`;
          if (visibleWidth(full) <= columns) return full;
          const noBar = `${counts} · ${percent}%  ${clock}`;
          return visibleWidth(noBar) <= columns ? noBar : `${counts}  ${clock}`;
        })()
      : presentation.progress.kind === "previous"
        ? `Reported previous ${presentation.progress.done}/${presentation.progress.total}`
        : "Progress: no current tasks";
  const lines = [
    header,
    currentTask(snapshot.board),
    ...(selected
      ? [
          usage(snapshot),
          "enter to see board",
          ...(columns >= visibleWidth("Enter: task board · Left/Esc: back")
            ? ["Enter: task board · Left/Esc: back"]
            : columns >= visibleWidth("Left/Esc: back")
              ? ["Left/Esc: back"]
              : []),
        ]
      : ["→ to inspect"]),
  ];
  return lines.flatMap((line, index) =>
    (selected && index === 2
      ? wrap(line, columns)
      : [truncateToWidth(untrusted(line), columns)]
    ).map((part) => {
      const colored = theme.fg("muted", part);
      // Host themes are trusted; ensure an unexpected formatter never widens rows.
      return visibleWidth(colored) <= columns ? colored : part;
    }),
  );
}
