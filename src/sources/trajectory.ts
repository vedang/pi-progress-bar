import { createHash } from "node:crypto";

const MAX_ENTRIES = 512;
const MAX_TRAJECTORY_BYTES = 256 * 1024;
const CANDIDATE_CHUNK_BYTES = 16 * 1024;
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

/** Finalized visible current-branch text; keeps newest bounded working window. */
export function collectTrajectory(entries: readonly unknown[]): Trajectory {
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
  const hasOriginal = (id: string) =>
    entries.some((entry) => record(entry) && entry.id === id);
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
    if (typeof entry.parentId === "string" && !hasOriginal(entry.parentId))
      gap("Missing original ancestral entry");
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
    result.messages.push({ id: entry.id, role: message.role, text, hash });
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
    result.messages = result.messages.slice(start);
    result.omissions.push(
      "Earlier originals are outside the current rolling history window",
    );
  }
  return result;
}

function spansFor(message: Observation): Span[] {
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
      const sentences = [...text.matchAll(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)];
      if (sentences.length > 1)
        for (const sentence of sentences)
          add(
            (paragraph.index ?? 0) + (sentence.index ?? 0),
            sentence[0],
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
        text: message.text.slice(start, end),
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
