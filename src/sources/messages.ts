import { createHash } from "node:crypto";

import type { Observation, ObservationRole } from "../core/hybrid-state";

const MAX_CANONICAL_PAGE_MESSAGES = 64;
const MAX_CANONICAL_PAGE_BYTES = 256 * 1024;
const MAX_PRECEDING_BYTES = 4 * 1024;

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

/** Captured metadata. Role/message accessors are read once when a pass begins. */
export interface CanonicalHeader {
  id: string;
  role: ObservationRole;
  message: Record<string, unknown>;
}

function canonicalHeader(entry: unknown): CanonicalHeader | undefined {
  if (!record(entry) || entry.type !== "message") return;
  const id = entry.id;
  if (typeof id !== "string" || !id) return;
  const message = entry.message;
  if (!record(message)) return;
  const role = message.role;
  if (role !== "user" && role !== "assistant") return;
  const stopReason = message.stopReason;
  if (stopReason === "error" || stopReason === "aborted") return;
  return { id, role, message };
}

/** Scan IDs/roles without materializing every historical text payload. */
function canonicalHeaders(entries: readonly unknown[]): CanonicalHeader[] {
  return entries.flatMap((entry) => {
    const header = canonicalHeader(entry);
    return header ? [header] : [];
  });
}

/** Materialize one whole visible message after bounded page admission. */
function canonicalObservation(
  header: CanonicalHeader,
): Observation | undefined {
  const text = visibleText(header.message.content);
  if (text === undefined || !text.trim()) return;
  return {
    id: header.id,
    role: header.role,
    text,
    hash: hash(text),
  };
}

export interface CanonicalPage {
  page: Observation[];
  hasMore: boolean;
  afterValid: boolean;
}

/**
 * One immutable host snapshot. It captures headers once and materializes every
 * requested payload at most once, including invalid/blank candidates.
 */
export class CanonicalPass {
  readonly entries: readonly unknown[];
  readonly headers: readonly CanonicalHeader[];
  private readonly byId = new Map<string, CanonicalHeader>();
  private readonly duplicateIds = new Set<string>();
  private readonly materialized = new Map<string, Observation | undefined>();

  constructor(entries: readonly unknown[]) {
    this.entries = [...entries];
    this.headers = canonicalHeaders(this.entries);
    for (const header of this.headers) {
      if (this.byId.has(header.id)) this.duplicateIds.add(header.id);
      else this.byId.set(header.id, header);
    }
  }

  observation(id: string): Observation | undefined {
    if (this.duplicateIds.has(id)) {
      this.materialized.set(id, undefined);
      return;
    }
    if (this.materialized.has(id)) return this.materialized.get(id);
    const header = this.byId.get(id);
    const observation = header ? canonicalObservation(header) : undefined;
    this.materialized.set(id, observation);
    return observation;
  }

  indexOf(id: string) {
    if (this.duplicateIds.has(id)) return -1;
    return this.headers.findIndex((header) => header.id === id);
  }

  preceding(entryId: string, includeTarget = false): Observation[] {
    const index = this.indexOf(entryId);
    if (index < 0) return [];
    const context: Observation[] = [];
    let bytes = 0;
    for (
      let cursor = includeTarget ? index : index - 1;
      cursor >= 0 && context.length < 2;
      cursor--
    ) {
      const header = this.headers[cursor];
      if (!header) continue;
      const observation = this.observation(header.id);
      if (!observation) continue;
      const size = Buffer.byteLength(JSON.stringify(observation));
      if (bytes + size > MAX_PRECEDING_BYTES) break;
      context.unshift(observation);
      bytes += size;
    }
    return context;
  }

  latestAfter(after?: { id: string; hash: string }) {
    const afterIndex = after ? this.indexOf(after.id) : -1;
    if (after && afterIndex < 0) return;
    for (let index = this.headers.length - 1; index > afterIndex; index--) {
      const header = this.headers[index];
      if (!header) continue;
      const observation = this.observation(header.id);
      if (observation) return observation;
    }
  }

  page(after?: { id: string; hash: string }): CanonicalPage {
    let afterIndex = -1;
    if (after) {
      afterIndex = this.indexOf(after.id);
      const current = afterIndex < 0 ? undefined : this.observation(after.id);
      if (!current || current.hash !== after.hash)
        return { page: [], hasMore: false, afterValid: false };
    }
    const page: Observation[] = [];
    let bytes = 0;
    let hasMore = false;
    for (let index = afterIndex + 1; index < this.headers.length; index++) {
      const header = this.headers[index];
      if (!header) continue;
      const observation = this.observation(header.id);
      if (!observation) continue;
      const size = Buffer.byteLength(observation.text);
      if (
        page.length &&
        (page.length >= MAX_CANONICAL_PAGE_MESSAGES ||
          bytes + size > MAX_CANONICAL_PAGE_BYTES)
      ) {
        hasMore = true;
        break;
      }
      page.push(observation);
      bytes += size;
    }
    return { page, hasMore, afterValid: true };
  }
}

/**
 * Return only whole visible user/assistant messages. Tool, custom, failed and
 * aborted records never become semantic input. Use CanonicalPass for monitor
 * boundaries so payload reads stay coherent.
 */
export function canonicalMessages(entries: readonly unknown[]): Observation[] {
  return canonicalHeaders(entries).flatMap((header) => {
    const observation = canonicalObservation(header);
    return observation ? [observation] : [];
  });
}
