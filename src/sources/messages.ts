import { createHash } from "node:crypto";

import type { Observation, ObservationRole } from "../core/hybrid-state";

export const MAX_CANONICAL_PAGE_MESSAGES = 64;
export const MAX_CANONICAL_PAGE_BYTES = 256 * 1024;

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

/** Metadata-only canonical candidate. Reading this never touches message content. */
export interface CanonicalHeader {
  entry: Record<string, unknown>;
  id: string;
  role: ObservationRole;
}

function canonicalHeader(entry: unknown): CanonicalHeader | undefined {
  if (
    !record(entry) ||
    entry.type !== "message" ||
    typeof entry.id !== "string" ||
    !entry.id ||
    !record(entry.message)
  )
    return;
  const role = entry.message.role;
  if (role !== "user" && role !== "assistant") return;
  if (
    entry.message.stopReason === "error" ||
    entry.message.stopReason === "aborted"
  )
    return;
  return { entry, id: entry.id, role };
}

/** Scan IDs/roles without materializing every historical text payload. */
export function canonicalHeaders(
  entries: readonly unknown[],
): CanonicalHeader[] {
  return entries.flatMap((entry) => {
    const header = canonicalHeader(entry);
    return header ? [header] : [];
  });
}

/** Materialize one whole visible message after bounded page admission. */
export function canonicalObservation(
  header: CanonicalHeader,
): Observation | undefined {
  const message = header.entry.message;
  if (!record(message) || message.role !== header.role) return;
  const text = visibleText(message.content);
  if (text === undefined || !text.trim()) return;
  return {
    id: header.id,
    role: header.role,
    text,
    hash: hash(text),
  };
}

/**
 * Return only whole visible user/assistant messages. Tool, custom, failed and
 * aborted records never become semantic input. Use paged APIs for monitoring.
 */
export function canonicalMessages(entries: readonly unknown[]): Observation[] {
  return canonicalHeaders(entries).flatMap((header) => {
    const observation = canonicalObservation(header);
    return observation ? [observation] : [];
  });
}
