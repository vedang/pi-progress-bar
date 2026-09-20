import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { BoardSnapshot } from "../core/board-projection";
import type { PresentationSnapshot } from "../core/monitor";

export const widgetName = "pi-progress-bar";

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

const ansiSequence = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);
const untrusted = (text: string) =>
  text
    .replace(ansiSequence, "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/[\r\n\t]/g, " ")
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

const warning = (snapshot: WidgetSnapshot) => {
  const { presentation, board } = snapshot;
  const { service, progress } = presentation;
  if (
    service.code === "saved-state-corrupt" ||
    service.code === "saved-state-unsupported"
  )
    return service.label;
  if (service.code === "capacity-exhausted") return service.label;
  if (progress.kind === "previous")
    return `Reported previous ${progress.done}/${progress.total}`;
  if (progress.catchup) return progress.catchup;
  if (
    service.code === "jev-unavailable" ||
    service.code === "model-unavailable"
  )
    return service.label;
  if (service.code !== "ready" || board.service.code !== "ready")
    return service.label;
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
  const issue = warning(snapshot);
  const header = issue
    ? issue
    : presentation.progress.kind === "current" &&
        presentation.progress.total > 0
      ? (() => {
          const { done, total } = presentation.progress;
          const percent = Math.floor((done * 100) / total);
          const filled = Math.floor((done * 12) / total);
          return `Reported ${done}/${total} · ${percent}%  ${"█".repeat(filled)}${"░".repeat(12 - filled)}  Jev ${time(presentation.lastJevCallAt)}`;
        })()
      : presentation.progress.kind === "previous"
        ? `Reported previous ${presentation.progress.done}/${presentation.progress.total}`
        : "Progress: no current tasks";
  const lines = [
    header,
    currentTask(snapshot.board),
    ...(selected ? [usage(snapshot), "enter to see board"] : ["→ to inspect"]),
  ];
  return lines.flatMap((line) =>
    wrap(line, columns).map((part) => {
      const colored = theme.fg("muted", part);
      // Host themes are trusted; ensure an unexpected formatter never widens rows.
      return visibleWidth(colored) <= columns ? colored : part;
    }),
  );
}
