import { createHash } from "node:crypto";

const MAX_ENTRIES = 512;
const MAX_TRAJECTORY_BYTES = 256 * 1024;
const CANDIDATE_CHUNK_BYTES = 16 * 1024;
export const hashText = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export interface Observation {
  id: string;
  role: "user" | "assistant";
  /** Original UTF-16 offset when one oversized entry is windowed. */
  offset?: number;
  text: string;
  /** Hash always covers the complete original entry, never only this window. */
  hash: string;
}
export interface Trajectory {
  messages: Observation[];
  complete: boolean;
  omissions: string[];
  /** True when a chronological caller must request the next bounded window. */
  hasMore?: boolean;
}
export interface CollectOptions {
  /**
   * Return the next chronological bounded window. The default remains the
   * newest diagnostic window used by pure callers and the widget.
   */
  chronological?: boolean;
  after?: { id: string; hash: string; offset?: number };
  /** Only transient reference rehydration may use the complete live branch. */
  unbounded?: boolean;
  /** Keep an oversized report entry whole so it can fail closed, never clip. */
  wholeEntries?: boolean;
  /** Bounded appended suffix has an external parent; do not call it a history gap. */
  detached?: boolean;
}
export interface Span {
  id: string;
  text: string;
  start: number;
  end: number;
  kind: "heading" | "list" | "paragraph" | "sentence";
}
export interface Candidate {
  id: string;
  entryId: string;
  text: string;
  hash: string;
  role: Observation["role"];
  spans: Span[];
  structured: boolean;
}
const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);

/** Splits only retained working windows; references retain original offsets/hash. */
function windowObservation(message: Observation): Observation[] {
  if (Buffer.byteLength(message.text) <= CANDIDATE_CHUNK_BYTES)
    return [message];
  const chunks: Observation[] = [];
  let start = 0;
  while (start < message.text.length) {
    let low = start + 1;
    let high = Math.min(message.text.length, start + CANDIDATE_CHUNK_BYTES);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (
        Buffer.byteLength(message.text.slice(start, middle)) <=
        CANDIDATE_CHUNK_BYTES
      )
        low = middle;
      else high = middle - 1;
    }
    let end = low;
    const lineEnd = message.text.lastIndexOf("\n", end - 1);
    if (lineEnd >= start) end = lineEnd + 1;
    if (end <= start) end = low;
    if (
      end < message.text.length &&
      /[\uDC00-\uDFFF]/.test(message.text[end] ?? "")
    )
      end--;
    if (end <= start) end = Math.min(message.text.length, start + 1);
    chunks.push({
      ...message,
      offset: (message.offset ?? 0) + start,
      text: message.text.slice(start, end),
    });
    start = end;
  }
  return chunks;
}

/**
 * Finalized visible current-branch text. Normal callers receive a newest
 * bounded diagnostic window; incremental consumers opt into chronological
 * windows and commit a cursor only after their work has committed.
 */
export function collectTrajectory(
  entries: readonly unknown[],
  options: CollectOptions = {},
): Trajectory {
  const result: Trajectory = {
    messages: [],
    complete: true,
    omissions: [
      "System, thinking, shell, tool bodies, summaries and monitor metadata excluded",
      "Interactive answers require a verified tool-call/result adapter",
    ],
  };
  const gap = (why: string) => {
    result.complete = false;
    if (!result.omissions.includes(why)) result.omissions.push(why);
  };
  const seen = new Map<string, string>();
  const originalIds = new Set(
    entries.flatMap((entry) =>
      record(entry) && typeof entry.id === "string" ? [entry.id] : [],
    ),
  );
  const hasOriginal = (id: string) => originalIds.has(id);
  for (const entry of entries) {
    if (!record(entry)) {
      gap("Malformed branch entry");
      continue;
    }
    if (entry.type === "custom" && entry.customType === "pi-progress-bar")
      continue;
    if (typeof entry.id !== "string" || !entry.id || entry.id.length > 200) {
      gap("Branch entry missing a bounded ID");
      continue;
    }
    if (!options.detached) {
      if (typeof entry.parentId === "string" && !hasOriginal(entry.parentId))
        gap("Missing original ancestral entry");
      if (
        entry.type === "compaction" &&
        typeof entry.firstKeptEntryId === "string" &&
        !hasOriginal(entry.firstKeptEntryId)
      )
        gap("Compacted original history unavailable");
    }
    if (entry.type !== "message" || !record(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (
      message.excludeFromContext === true ||
      message.stopReason === "aborted" ||
      message.stopReason === "error"
    )
      continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter(record)
              .filter(
                (part) => part.type === "text" && typeof part.text === "string",
              )
              .map((part) => part.text as string)
              .join("\n")
          : "";
    if (!text.trim()) continue;
    const hash = hashText(text);
    const prior = seen.get(entry.id);
    if (prior) {
      if (prior !== hash) gap("Conflicting duplicate entry ID");
      continue;
    }
    seen.set(entry.id, hash);
    result.messages.push({ id: entry.id, role: message.role, text, hash });
  }

  // Do not retain an oversized original in a rolling working window. Full
  // originals are only materialized transiently for checked rehydration.
  if (!options.unbounded && !options.wholeEntries)
    result.messages = result.messages.flatMap(windowObservation);

  if (options.chronological) {
    let start = 0;
    if (options.after) {
      const cursor = result.messages.findIndex(
        (message, index, messages) =>
          message.id === options.after?.id &&
          message.hash === options.after?.hash &&
          (options.after?.offset === undefined
            ? !messages
                .slice(index + 1)
                .some(
                  (later) =>
                    later.id === options.after?.id &&
                    later.hash === options.after?.hash,
                )
            : message.offset === options.after.offset),
      );
      if (cursor < 0) {
        result.complete = false;
        result.omissions.push(
          "Committed incremental cursor original unavailable",
        );
        result.messages = [];
        return result;
      }
      start = cursor + 1;
    }
    const window: Observation[] = [];
    let bytes = 0;
    for (let index = start; index < result.messages.length; index++) {
      const message = result.messages[index];
      if (!message) continue;
      const next = bytes + Buffer.byteLength(message.text);
      if (
        !options.unbounded &&
        window.length &&
        (window.length >= MAX_ENTRIES || next > MAX_TRAJECTORY_BYTES)
      ) {
        result.hasMore = true;
        break;
      }
      // One original is retained rather than silently clipped. Its candidate
      // spans are still request-chunked with exact offsets downstream.
      window.push(message);
      bytes = next;
    }
    result.messages = window;
    if (result.hasMore)
      result.omissions.push(
        "More visible originals remain after this chronological bounded window",
      );
    return result;
  }

  let bytes = 0;
  let start = result.messages.length;
  while (start > 0 && result.messages.length - start < MAX_ENTRIES) {
    const message = result.messages[start - 1];
    if (!message) break;
    const next = bytes + Buffer.byteLength(message.text);
    if (next > MAX_TRAJECTORY_BYTES && start < result.messages.length) break;
    bytes = next;
    start--;
  }
  if (start > 0) {
    const earlier = result.messages.slice(0, start);
    const pinnedGoal = earlier.find((message) =>
      /(?:^|\n)\s*(?:plan\s*:|\d+[.)]\s+|[-*+]\s+)/i.test(message.text),
    );
    const tail = result.messages.slice(start);
    result.messages = pinnedGoal
      ? [pinnedGoal, ...tail.slice(-(MAX_ENTRIES - 1))]
      : tail;
    result.omissions.push(
      "Earlier originals are outside the current rolling history window; earliest task-bearing goal is pinned when available",
    );
  }
  return result;
}

function spansFor(message: Observation): Span[] {
  const spans: Span[] = [];
  const offset = message.offset ?? 0;
  const add = (start: number, text: string, kind: Span["kind"]) => {
    if (!text.trim()) return;
    const absoluteStart = offset + start;
    spans.push({
      id: `${message.id}:${absoluteStart}:${absoluteStart + text.length}`,
      text,
      start: absoluteStart,
      end: absoluteStart + text.length,
      kind,
    });
  };
  const lines = [...message.text.matchAll(/[^\n]+/g)];
  const listed = lines.some((line) =>
    /^\s*(?:\d+[.)]\s+|[-*+]\s+)/.test(line[0]),
  );
  if (listed) {
    let fenced = false;
    for (const line of lines) {
      if (/^\s*(```|~~~)/.test(line[0])) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
      const item = /^(\s*(?:\d+[.)]\s+|[-*+]\s+(?:\[[ xX]\]\s+)?))(.+)$/.exec(
        line[0],
      );
      if (item)
        add((line.index ?? 0) + (item[1]?.length ?? 0), item[2] ?? "", "list");
      else if (/^#{1,6}\s|^\S.*:\s*$/.test(line[0]))
        add(line.index ?? 0, line[0], "heading");
      else add(line.index ?? 0, line[0], "paragraph");
    }
  } else {
    for (const paragraph of message.text.matchAll(
      /[^\n]+(?:\n(?!\n)[^\n]+)*/g,
    )) {
      const text = paragraph[0];
      const sentences: { start: number; text: string }[] = [];
      let start = 0;
      for (const boundary of text.matchAll(/[.!?]+(?=\s|$)/g)) {
        const end = (boundary.index ?? start) + boundary[0].length;
        sentences.push({ start, text: text.slice(start, end) });
        start = end;
      }
      if (start < text.length)
        sentences.push({ start, text: text.slice(start) });
      if (sentences.length > 1)
        for (const sentence of sentences)
          add(
            (paragraph.index ?? 0) + sentence.start,
            sentence.text,
            "sentence",
          );
      else add(paragraph.index ?? 0, text, "paragraph");
    }
  }
  return spans;
}

/** Mechanical exact-offset candidates. Every bounded batch remains reachable. */
export function findCandidates(trajectory: Trajectory): Candidate[] {
  const candidates: Candidate[] = [];
  for (const message of trajectory.messages) {
    const all = spansFor(message);
    let group: Span[] = [];
    const emit = () => {
      if (!group.length) return;
      const start = group[0]?.start ?? 0;
      const end = group.at(-1)?.end ?? start;
      candidates.push({
        id: `candidate:${message.id}:${start}`,
        entryId: message.id,
        text: message.text.slice(
          start - (message.offset ?? 0),
          end - (message.offset ?? 0),
        ),
        hash: message.hash,
        role: message.role,
        spans: group,
        structured: group.some((span) => span.kind === "list"),
      });
      group = [];
    };
    for (const span of all) {
      const next = [...group, span];
      const start = next[0]?.start ?? 0;
      const end = next.at(-1)?.end ?? start;
      if (
        group.length &&
        Buffer.byteLength(message.text.slice(start, end)) >
          CANDIDATE_CHUNK_BYTES
      )
        emit();
      group.push(span);
    }
    emit();
  }
  return candidates;
}
