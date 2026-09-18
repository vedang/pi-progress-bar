import { createHash } from "node:crypto";

const MAX_ENTRIES = 512;
const MAX_TRAJECTORY_BYTES = 256 * 1024;
const MAX_CANDIDATES = 12;
export const hashText = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export interface Observation {
  id: string;
  role: "user" | "assistant";
  text: string;
  hash: string;
}
export interface Trajectory {
  messages: Observation[];
  complete: boolean;
  omissions: string[];
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

/** Only finalized visible user/assistant text from getBranch(), never tool-name trust. */
export function collectTrajectory(entries: readonly unknown[]): Trajectory {
  const result: Trajectory = {
    messages: [],
    complete: true,
    omissions: [
      "System, thinking, shell, tool bodies, summaries and monitor metadata excluded",
      "Interactive user-answer coverage excluded: no verified live provenance adapter; tool names do not establish authorship",
    ],
  };
  const gap = (why: string) => {
    result.complete = false;
    if (!result.omissions.includes(why)) result.omissions.push(why);
  };
  const seen = new Map<string, string>();
  const boundedIds = new Set<string>();
  const hasOriginal = (id: string) =>
    entries.some((e) => record(e) && e.id === id);
  let bytes = 0;
  let count = 0;
  for (const entry of entries) {
    if (!record(entry)) {
      gap("Malformed branch entry");
      continue;
    }
    // Monitor checkpoints carry no authoritative text and do not consume history budget.
    if (entry.type === "custom" && entry.customType === "pi-progress-bar")
      continue;
    if (typeof entry.id !== "string" || !entry.id || entry.id.length > 200) {
      gap("Branch entry missing a bounded ID");
      continue;
    }
    if (!boundedIds.has(entry.id)) {
      if (++count > MAX_ENTRIES) {
        gap(
          "Trajectory exceeds 512 entries / 256 KiB; narrow source or recover original history",
        );
        break;
      }
      boundedIds.add(entry.id);
    }
    if (typeof entry.parentId === "string" && !hasOriginal(entry.parentId))
      gap("Missing original ancestral entry");
    // Summary records are never authority. Their presence alone is not a gap:
    // modern Pi retains original ancestors (including retainedTail compactions).
    if (
      entry.type === "compaction" &&
      typeof entry.firstKeptEntryId === "string" &&
      !hasOriginal(entry.firstKeptEntryId)
    )
      gap("Compacted original history unavailable");
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
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_TRAJECTORY_BYTES) {
      gap(
        "Trajectory exceeds 512 entries / 256 KiB; narrow source or recover original history",
      );
      continue;
    }
    result.messages.push({ id: entry.id, role: message.role, text, hash });
  }
  return result;
}

/** Enumerate exact offsets, not generated plan/task text. Semantic authority comes later. */
export function findCandidates(trajectory: Trajectory): Candidate[] {
  const candidates: Candidate[] = [];
  const priority = (message: Observation) =>
    /(?:^|\n)\s*(?:\d+[.)]\s+|[-*+]\s+\[[ xX]\]\s+)/.test(message.text)
      ? 3
      : /(?:^|\n)(?:#{1,6}\s|\s*[-*+]\s)/.test(message.text)
        ? 2
        : /\b(plan|tasks?|implement|build|finish|review)\b/i.test(message.text)
          ? 1
          : 0;
  // Lexical ranking only limits enumeration; Jev still decides semantic plan suitability.
  const messages = trajectory.messages
    .map((message, index) => ({ message, index }))
    .sort(
      (a, b) => priority(b.message) - priority(a.message) || b.index - a.index,
    );
  for (const { message } of messages) {
    if (candidates.length === MAX_CANDIDATES) break;
    const spans: Span[] = [];
    const add = (start: number, text: string, kind: Span["kind"]) => {
      if (!text.trim()) return;
      spans.push({
        id: `${message.id}:${start}:${start + text.length}`,
        text,
        start,
        end: start + text.length,
        kind,
      });
    };
    const lines = [...message.text.matchAll(/[^\n]+/g)];
    const structured = lines.some((m) =>
      /^\s*(?:\d+[.)]\s+|[-*+]\s+\[[ xX]\]\s+)/.test(m[0]),
    );
    // Ordinary bullets still need separate exact spans, but retain semantic
    // classification rather than the numbered/checklist direct-scope shortcut.
    if (structured || lines.some((m) => /^\s*[-*+]\s+/.test(m[0]))) {
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
          add(
            (line.index ?? 0) + (item[1]?.length ?? 0),
            item[2] ?? "",
            "list",
          );
        else if (/^#{1,6}\s|^\S.*:\s*$/.test(line[0]))
          add(line.index ?? 0, line[0], "heading");
        else add(line.index ?? 0, line[0], "paragraph");
      }
    } else {
      for (const paragraph of message.text.matchAll(
        /[^\n]+(?:\n(?!\n)[^\n]+)*/g,
      )) {
        const text = paragraph[0];
        if (/^#{1,6}\s/.test(text)) add(paragraph.index ?? 0, text, "heading");
        else {
          const sentences = [...text.matchAll(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)];
          if (sentences.length > 1)
            for (const sentence of sentences)
              add(
                (paragraph.index ?? 0) + (sentence.index ?? 0),
                sentence[0],
                "sentence",
              );
          else
            add(
              paragraph.index ?? 0,
              text,
              /^\s*[-*+]\s/.test(text) ? "list" : "paragraph",
            );
        }
      }
    }
    if (spans.length)
      candidates.push({
        id: `candidate:${message.id}`,
        entryId: message.id,
        text: message.text,
        hash: message.hash,
        role: message.role,
        spans,
        structured,
      });
  }
  return candidates;
}
