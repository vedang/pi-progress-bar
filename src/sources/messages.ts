import { createHash } from "node:crypto";

import {
  type Observation,
  type ObservationRef,
  type ObservationRole,
  observationRef,
} from "../core/hybrid-state";

const MAX_CANONICAL_PAGE_MESSAGES = 64;
const MAX_CANONICAL_PAGE_BYTES = 256 * 1024;
const MAX_PRECEDING_BYTES = 4 * 1024;
/** Health preserves whole reports, never truncates them into evidence. */
const MAX_HEALTH_REPORT_OBSERVATIONS = 16;
const MAX_HEALTH_REPORT_BYTES = 4 * 1024;
/** Exploratory payloads yield after the same bounded message quantum as a page. */
const MAX_EXPLORATORY_HEADERS = MAX_CANONICAL_PAGE_MESSAGES;

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

/** Captured metadata. Content remains lazy until one eligible observation needs it. */
export interface CanonicalHeader {
  id: string;
  role: ObservationRole;
  contentOwner: Record<string, unknown>;
}

function canonicalHeader(entry: unknown): CanonicalHeader | undefined {
  if (!record(entry)) return;
  const id = entry.id;
  if (typeof id !== "string" || !id) return;
  if (entry.type === "custom_message") {
    if (entry.customType !== "intercom_message") return;
    return { id, role: "intercom", contentOwner: entry };
  }
  if (entry.type !== "message") return;
  const message = entry.message;
  if (!record(message)) return;
  const role = message.role;
  if (role !== "user" && role !== "assistant") return;
  const stopReason = message.stopReason;
  if (stopReason === "error" || stopReason === "aborted") return;
  return { id, role, contentOwner: message };
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
  const text = visibleText(header.contentOwner.content);
  if (text === undefined || !text.trim()) return;
  return {
    id: header.id,
    role: header.role,
    text,
    hash: hash(text),
  };
}

export interface CanonicalFrontier {
  kind: "page" | "preceding";
  anchorId?: string;
  anchorIndex: number;
  includeTarget?: boolean;
  index: number;
  /** Unambiguous header-tuple digest through this exclusive prefix. */
  prefix: string;
  prefixLength: number;
  terminal?: true;
}

export interface CanonicalPage {
  page: Observation[];
  hasMore: boolean;
  afterValid: boolean;
  /** Only this outcome may schedule one more exploratory wake. */
  progress: "terminal" | "scan-needed" | "page-full";
  /** Prior page accumulation was structurally stale and must be dropped. */
  invalidated?: true;
  frontier: CanonicalFrontier;
}

export interface CanonicalPreceding {
  context: Observation[];
  complete: boolean;
  /** Caller-supplied partial context was structurally stale and was dropped. */
  invalidated?: true;
  frontier?: CanonicalFrontier;
}

/**
 * Detached bounded health-report evidence. `complete` means every canonical
 * report through `target` was retained. Any bounded gap is explicit so a
 * consumer cannot turn omitted evidence into a negative finding.
 */
interface CanonicalHealthCoverage {
  target: ObservationRef;
  references: ObservationRef[];
  complete: boolean;
  omissions: string[];
  coverageDigest: string;
}

export interface CanonicalHealthReportContext extends CanonicalHealthCoverage {
  /** Runtime-only report text. Durable cards retain only CanonicalHealthCoverage. */
  reports: Observation[];
}

/**
 * One immutable host snapshot. It captures headers once and materializes every
 * requested payload at most once. Direct authoritative refs are unrestricted;
 * exploratory scans yield after one bounded candidate quantum.
 */
export class CanonicalPass {
  readonly entries: readonly unknown[];
  readonly headers: readonly CanonicalHeader[];
  private readonly byId = new Map<string, CanonicalHeader>();
  private readonly duplicateIds = new Set<string>();
  private readonly materialized = new Map<string, Observation | undefined>();
  private exploratoryReads = 0;

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

  /** JSON array tuples avoid delimiter ambiguity in arbitrary host IDs. */
  private prefix(index: number) {
    return hash(
      JSON.stringify(
        this.headers.slice(0, index).map((header) => [header.id, header.role]),
      ),
    );
  }

  private accepts(
    frontier: CanonicalFrontier | undefined,
    kind: CanonicalFrontier["kind"],
    anchorId: string | undefined,
    includeTarget = false,
  ) {
    return (
      !!frontier &&
      frontier.kind === kind &&
      frontier.anchorId === anchorId &&
      frontier.includeTarget ===
        (kind === "preceding" ? includeTarget : undefined) &&
      frontier.anchorIndex >= -1 &&
      frontier.anchorIndex < this.headers.length &&
      this.headers[frontier.anchorIndex]?.id === anchorId &&
      frontier.index >= -1 &&
      frontier.index <= this.headers.length &&
      frontier.prefixLength >= 0 &&
      frontier.prefixLength <= this.headers.length &&
      frontier.prefix === this.prefix(frontier.prefixLength) &&
      true
    );
  }

  private frontier(
    kind: CanonicalFrontier["kind"],
    anchorId: string | undefined,
    anchorIndex: number,
    index: number,
    terminal = false,
    includeTarget = false,
  ): CanonicalFrontier {
    // Page continuation pays only inspected prefix; preceding must bind every
    // header through target so an insertion near target invalidates its cache.
    const prefixLength = kind === "preceding" ? anchorIndex + 1 : index;
    return {
      kind,
      ...(anchorId ? { anchorId } : {}),
      anchorIndex,
      ...(kind === "preceding" ? { includeTarget } : {}),
      index,
      prefix: this.prefix(prefixLength),
      prefixLength,
      ...(terminal ? { terminal: true as const } : {}),
    };
  }

  private exploratory(header: CanonicalHeader) {
    this.exploratoryReads++;
    return this.observation(header.id);
  }

  /**
   * Selects chronological newest-fitting canonical reports through one target.
   * This is a bounded exploratory read: at most 16 retained reports, 4 KiB of
   * serialized report references/text, and one canonical page of headers.
   */
  healthReportContext(
    entryId: string,
  ): CanonicalHealthReportContext | undefined {
    const targetIndex = this.indexOf(entryId);
    const target = targetIndex < 0 ? undefined : this.observation(entryId);
    if (!target) return;
    const reports: Observation[] = [];
    // Digest every observation inspected by the selector, including one that
    // could not fit. This detects an amendment at an omitted count/byte
    // boundary without durable report text or unbounded history reads.
    const examined: ObservationRef[] = [];
    const omissions: string[] = [];
    let bytes = 0;
    let scanned = 0;
    let index = targetIndex;
    while (index >= 0) {
      if (reports.length >= MAX_HEALTH_REPORT_OBSERVATIONS) {
        const boundary = this.headers[index];
        const observation = boundary
          ? this.observation(boundary.id)
          : undefined;
        if (observation) examined.push(observationRef(observation));
        omissions.push(
          `Older canonical reports omitted after ${MAX_HEALTH_REPORT_OBSERVATIONS} retained observations`,
        );
        break;
      }
      if (scanned >= MAX_EXPLORATORY_HEADERS) {
        omissions.push(
          "Canonical report coverage scan reached bounded page limit",
        );
        break;
      }
      const header = this.headers[index];
      index--;
      scanned++;
      if (!header) continue;
      // Health coverage has its own bounded read allowance. Its answer must
      // not depend on preceding exploratory page/preceding-context reads.
      const observation = this.observation(header.id);
      if (!observation) continue;
      const reference = observationRef(observation);
      examined.push(reference);
      const size = Buffer.byteLength(JSON.stringify(observation));
      if (bytes + size > MAX_HEALTH_REPORT_BYTES) {
        omissions.push(
          reports.length
            ? "Older canonical report omitted because full report context exceeded 4 KiB"
            : "Target canonical report omitted because it exceeded 4 KiB",
        );
        break;
      }
      reports.unshift(observation);
      bytes += size;
    }
    const references = reports.map(observationRef);
    const complete = omissions.length === 0 && index < 0;
    const targetRef = observationRef(target);
    return {
      target: targetRef,
      reports: reports.map((report) => ({ ...report })),
      references,
      complete,
      omissions,
      coverageDigest: hash(
        JSON.stringify({
          target: targetRef,
          references,
          examined,
          complete,
          omissions,
        }),
      ),
    };
  }

  precedingResult(
    entryId: string,
    includeTarget = false,
    frontier?: CanonicalFrontier,
    prior: readonly Observation[] = [],
  ): CanonicalPreceding {
    const target = this.indexOf(entryId);
    if (target < 0) return { context: [], complete: true };
    const accepted = this.accepts(
      frontier,
      "preceding",
      entryId,
      includeTarget,
    );
    const invalidated = !!frontier && !accepted;
    let index = accepted
      ? (frontier?.index ?? -1)
      : includeTarget
        ? target
        : target - 1;
    const context = (invalidated ? [] : prior).map((observation) => ({
      ...observation,
    }));
    let bytes = context.reduce(
      (total, observation) =>
        total + Buffer.byteLength(JSON.stringify(observation)),
      0,
    );
    if (accepted && frontier?.terminal)
      return { context, complete: true, frontier };
    while (index >= 0 && context.length < 2) {
      if (this.exploratoryReads >= MAX_EXPLORATORY_HEADERS)
        return {
          context,
          complete: false,
          ...(invalidated ? { invalidated: true as const } : {}),
          frontier: this.frontier(
            "preceding",
            entryId,
            target,
            index,
            false,
            includeTarget,
          ),
        };
      const header = this.headers[index];
      index--;
      if (!header) continue;
      const observation = this.exploratory(header);
      if (!observation) continue;
      const size = Buffer.byteLength(JSON.stringify(observation));
      if (bytes + size > MAX_PRECEDING_BYTES) break;
      context.unshift(observation);
      bytes += size;
    }
    return {
      context,
      complete: true,
      ...(invalidated ? { invalidated: true as const } : {}),
      frontier: this.frontier(
        "preceding",
        entryId,
        target,
        index,
        true,
        includeTarget,
      ),
    };
  }

  page(
    after?: { id: string; hash: string },
    frontier?: CanonicalFrontier,
    admitted: readonly Observation[] = [],
    admittedBytes = 0,
  ): CanonicalPage {
    let afterIndex = -1;
    const anchor = after?.id;
    if (after) {
      afterIndex = this.indexOf(after.id);
      const current = afterIndex < 0 ? undefined : this.observation(after.id);
      if (!current || current.hash !== after.hash)
        return {
          page: [],
          hasMore: false,
          afterValid: false,
          progress: "terminal",
          frontier: this.frontier("page", anchor, afterIndex, afterIndex, true),
        };
    }
    const accepted = this.accepts(frontier, "page", anchor);
    const invalidated = !!frontier && !accepted;
    let index = accepted ? (frontier?.index ?? afterIndex + 1) : afterIndex + 1;
    if (accepted && frontier?.terminal) {
      if (this.headers.length === frontier.prefixLength)
        return {
          page: [],
          hasMore: false,
          afterValid: true,
          progress: "terminal",
          frontier,
        };
      index = frontier.index;
    }
    const retained = invalidated ? [] : admitted;
    const page: Observation[] = [];
    let bytes = invalidated ? 0 : admittedBytes;
    const result = (
      progress: CanonicalPage["progress"],
      hasMore: boolean,
      at: number,
      terminal = false,
    ): CanonicalPage => ({
      page,
      hasMore,
      afterValid: true,
      progress,
      ...(invalidated ? { invalidated: true as const } : {}),
      frontier: this.frontier("page", anchor, afterIndex, at, terminal),
    });
    while (index < this.headers.length) {
      if (
        retained.length + page.length >= MAX_CANONICAL_PAGE_MESSAGES ||
        bytes >= MAX_CANONICAL_PAGE_BYTES
      )
        return result("page-full", true, index);
      if (this.exploratoryReads >= MAX_EXPLORATORY_HEADERS)
        return result("scan-needed", true, index);
      const header = this.headers[index];
      if (!header) {
        index++;
        continue;
      }
      const observation = this.exploratory(header);
      if (!observation) {
        index++;
        continue;
      }
      const size = Buffer.byteLength(observation.text);
      if (
        retained.length + page.length &&
        (retained.length + page.length >= MAX_CANONICAL_PAGE_MESSAGES ||
          bytes + size > MAX_CANONICAL_PAGE_BYTES)
      )
        // Candidate was read but cannot be admitted. Resume at its header.
        return result("page-full", true, index);
      index++;
      page.push(observation);
      bytes += size;
    }
    return result("terminal", false, index, true);
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
