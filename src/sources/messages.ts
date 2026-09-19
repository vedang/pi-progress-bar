import { createHash } from "node:crypto";

import type { Observation, ObservationRole } from "../core/hybrid-state";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function visibleText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return;
  const text: string[] = [];
  for (const block of content) {
    if (!record(block)) continue;
    if (block.type === "text" && typeof block.text === "string")
      text.push(block.text);
  }
  return text.join("");
}

/**
 * Return only whole visible user/assistant messages. Tool, custom, failed and
 * aborted records never become semantic input.
 */
export function canonicalMessages(entries: readonly unknown[]): Observation[] {
  const messages: Observation[] = [];
  for (const entry of entries) {
    if (
      !record(entry) ||
      entry.type !== "message" ||
      typeof entry.id !== "string"
    )
      continue;
    if (!entry.id) continue;
    if (!record(entry.message)) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    if (
      entry.message.stopReason === "error" ||
      entry.message.stopReason === "aborted"
    )
      continue;
    const text = visibleText(entry.message.content);
    if (text === undefined) continue;
    messages.push({
      id: entry.id,
      role: role as ObservationRole,
      text,
      hash: hash(text),
    });
  }
  return messages;
}
