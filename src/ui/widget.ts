import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { BoardSnapshot } from "../core/board-projection";
import type { ExecutionVisibilitySnapshot } from "../core/execution-visibility";
import type { PresentationSnapshot } from "../core/monitor";

export interface WidgetSnapshot {
  presentation: PresentationSnapshot;
  board: BoardSnapshot;
  /** Optional while old host/test projections have no runtime visibility data. */
  visibility?: ExecutionVisibilitySnapshot;
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
/** Shared terminal-safe display boundary for detached, untrusted text. */
export const sanitizeTerminalText = (text: string) =>
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

/** Lifecycle, not health, owns task-status color. */
export const lifecycleTone = (status: string): "accent" | "muted" | "dim" => {
  if (status === "INPROG") return "accent";
  if (status === "DONE" || status === "ARCHIVED") return "dim";
  return "muted";
};

/** Wrap sanitized text without padding; replace one too-wide glyph at tiny widths. */
const wrap = (text: string, width: number) => {
  if (width < 1) return [""];
  const safe = sanitizeTerminalText(text);
  if (!safe) return [""];
  const lines: string[] = [];
  let line = "";
  for (const { segment } of new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(safe)) {
    const glyph = visibleWidth(segment) > width ? "?" : segment;
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
  const safe = sanitizeTerminalText(label);
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
  if (!current) return { text: "Current Task: not identified" };
  const status = sanitizeTerminalText(current.status);
  const task = board.tasks.find((item) => item.taskId === current.taskId);
  if (!task)
    return { text: `Current Task: (${status}) not identified`, status };
  const qualifier = current.qualifier
    ? ` · ${sanitizeTerminalText(current.qualifier)}`
    : "";
  return {
    text: `Current Task: (${status}) ${sanitizeTerminalText(task.label)}${qualifier}`,
    status,
  };
};

type WidgetLine = {
  text: string;
  tone?: "hint" | "warning";
  status?: string;
  bar?: { filled: string; empty: string };
  wrap?: boolean;
};

const styleStatus = (text: string, status: string, theme: Theme) => {
  const marker = `(${status})`;
  const markerStart = text.indexOf(marker);
  if (markerStart < 0) return text;
  const statusStart = markerStart + 1;
  return `${text.slice(0, statusStart)}${theme.fg(lifecycleTone(status), status)}${text.slice(statusStart + status.length)}`;
};

const styleBar = (
  text: string,
  bar: NonNullable<WidgetLine["bar"]>,
  theme: Theme,
) => {
  const cells = `${bar.filled}${bar.empty}`;
  const start = text.indexOf(cells);
  if (start < 0) return text;
  const end = start + cells.length;
  const filled = bar.filled ? theme.fg("accent", bar.filled) : "";
  const empty = bar.empty ? theme.fg("dim", bar.empty) : "";
  return `${text.slice(0, start)}${filled}${empty}${text.slice(end)}`;
};

const styleWidgetLine = (line: WidgetLine, text: string, theme: Theme) => {
  if (line.tone === "hint") return theme.fg("dim", text);
  if (line.tone === "warning") return theme.fg("warning", text);
  if (line.bar) return styleBar(text, line.bar, theme);
  return line.status ? styleStatus(text, line.status, theme) : text;
};

const usage = (snapshot: WidgetSnapshot) => {
  const { jev, extraction } = snapshot.presentation.usage;
  return `Jev · ↓ ${compact(jev.inputTokens)} · ↑ ${compact(jev.outputTokens)} tokens · ${jev.calls} calls • Extraction · ↓ ${compact(extraction.inputTokens)} · ↑ ${compact(extraction.outputTokens)} tokens · ${extraction.calls} calls`;
};

const visibilityUsage = (visibility: ExecutionVisibilitySnapshot) =>
  `Visibility · ↓ ${compact(visibility.usage.inputTokens)} · ↑ ${compact(visibility.usage.outputTokens)} tokens · ${visibility.usage.calls} calls · ${visibility.budgetRemaining} remaining · last ${time(visibility.usage.lastCallAt)}`;

const visibilityCurrent = (
  visibility: ExecutionVisibilitySnapshot,
  board: BoardSnapshot,
) => {
  const current = visibility.current;
  if (!current) return;
  const prefix =
    current.kind === "reported"
      ? current.provisional
        ? "Agent says (provisional)"
        : "Agent says"
      : "Agent current";
  const task = current.task;
  const knownTask =
    task &&
    board.tasks.some(
      (boardTask) =>
        boardTask.taskId === task.id &&
        boardTask.label === task.label &&
        boardTask.revision === task.revision &&
        boardTask.sourceDigest === task.sourceDigest,
    );
  const qualifier = knownTask
    ? ` · task ${sanitizeTerminalText(task.label)}${
        current.certainty === "maybe" ? " (MAYBE)" : ""
      }`
    : " · task unconfirmed";
  return `${prefix}: ${sanitizeTerminalText(current.text)}${qualifier}`;
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
  const header: WidgetLine = issue
    ? { text: issue, tone: "warning" }
    : presentation.progress.kind === "current" &&
        presentation.progress.total > 0
      ? (() => {
          const { done, total } = presentation.progress;
          const percent = Math.floor((done * 100) / total);
          const filled = Math.floor((done * 12) / total);
          const bar = {
            filled: "█".repeat(filled),
            empty: "░".repeat(12 - filled),
          };
          const clock = `Jev ${time(presentation.lastJevCallAt)}`;
          const counts = `Reported ${done}/${total}`;
          const full = `${counts} · ${percent}%  ${bar.filled}${bar.empty}  ${clock}`;
          if (visibleWidth(full) <= columns) return { text: full, bar };
          const noBar = `${counts} · ${percent}%  ${clock}`;
          return {
            text:
              visibleWidth(noBar) <= columns ? noBar : `${counts}  ${clock}`,
          };
        })()
      : presentation.progress.kind === "previous"
        ? {
            text: `Reported previous ${presentation.progress.done}/${presentation.progress.total}`,
          }
        : { text: "Progress: no current tasks" };
  const task = currentTask(snapshot.board);
  const current = snapshot.visibility
    ? visibilityCurrent(snapshot.visibility, snapshot.board)
    : undefined;
  const visibilityWarning =
    snapshot.visibility?.budgetRemaining === 0
      ? "Visibility budget reached · history incomplete"
      : undefined;
  const lines: WidgetLine[] = [
    header,
    ...(current ? [{ text: current, wrap: true }] : []),
    ...(visibilityWarning
      ? [{ text: visibilityWarning, tone: "warning" as const }]
      : []),
    task,
    ...(selected
      ? [
          { text: usage(snapshot), wrap: true },
          ...(snapshot.visibility
            ? [{ text: visibilityUsage(snapshot.visibility), wrap: true }]
            : []),
          { text: "enter to see board", tone: "hint" as const },
          ...(columns >= visibleWidth("Enter: task board · Left/Esc: back")
            ? [
                {
                  text: "Enter: task board · Left/Esc: back",
                  tone: "hint" as const,
                },
              ]
            : columns >= visibleWidth("Left/Esc: back")
              ? [{ text: "Left/Esc: back", tone: "hint" as const }]
              : []),
        ]
      : [{ text: "→ to inspect", tone: "hint" as const }]),
  ];
  return lines.flatMap((line) => {
    const safe = sanitizeTerminalText(line.text);
    const parts = line.wrap
      ? wrap(safe, columns)
      : [truncateToWidth(safe, columns)];
    return parts.map((part) => {
      const colored = styleWidgetLine(line, part, theme);
      // Host themes are trusted; ensure an unexpected formatter never widens rows.
      return visibleWidth(colored) <= columns ? colored : part;
    });
  });
}
