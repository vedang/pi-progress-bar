import { createHash } from "node:crypto";
import type { CoverageInventory } from "../core/coverage";

const MAX_PENDING = 16;
const MAX_RETAINED_RECEIPTS = 16;
const MAX_MAPPINGS = 64;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 32 * 1024;
const MAX_SHEETS = 64;
const MAX_LABEL_SCALARS = 240;

export interface CoverageToolStart {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface CoverageToolEnd {
  toolCallId: string;
  toolName: string;
}

interface CoverageAccess {
  resourceKey: string;
  itemKeys: string[];
  /** Final canonical result only; source bodies/paths remain adapter-local. */
  source: {
    entryId: string;
    messageHash: string;
    callId: string;
  };
}

export interface CoverageActivity {
  callId: string;
  resourceKey: string;
  itemKeys: string[];
}

export interface CoverageAdapterResult {
  inventories: CoverageInventory[];
  access: CoverageAccess[];
  omissions: number;
}

export interface CoverageAdapterSnapshot {
  pendingCount: number;
  omissions: number;
}

/** Names-only passive metadata; it never assigns or completes generic subtasks. */
export interface SubtaskEvidence {
  resources: Array<{
    resourceKey: string;
    revision: number;
    complete: boolean;
    knownTotal?: number;
    items: Array<{ key: string; label: string }>;
    source: { entryId: string; messageHash: string; callHash: string };
  }>;
  omissions: number;
}

/** Names-only access facts; mapping paths and tool payloads remain private. */
export interface SubtaskAccessEvidence {
  mapped: Array<{ resourceKey: string; itemKeys: string[] }>;
  active: Array<{
    callHash: string;
    resourceKey: string;
    itemKeys: string[];
  }>;
  confirmed: Array<{
    resourceKey: string;
    itemKeys: string[];
    source: { entryId: string; messageHash: string; callHash: string };
  }>;
  omissions: number;
}

interface SubtaskEvidenceAttestation {
  current: () => boolean;
}

/** Original snapshots alone receive this non-serializable adapter attestation. */
const subtaskEvidenceAttestations = new WeakMap<
  object,
  SubtaskEvidenceAttestation
>();

/** True only for an unchanged original snapshot issued by its adapter. */
export const isCurrentSubtaskEvidence = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  try {
    return subtaskEvidenceAttestations.get(value)?.current() === true;
  } catch {
    return false;
  }
};

/** Access snapshots use an independent proof because activity is not semantic. */
const subtaskAccessEvidenceAttestations = new WeakMap<
  object,
  SubtaskEvidenceAttestation
>();

/** True only for an unchanged original access snapshot issued by its adapter. */
export const isCurrentSubtaskAccessEvidence = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  try {
    return subtaskAccessEvidenceAttestations.get(value)?.current() === true;
  } catch {
    return false;
  }
};

const deepFreeze = <Value>(
  value: Value,
  seen = new WeakSet<object>(),
): Value => {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

interface CanonicalHeader {
  entryId: string;
  callId: string;
  toolName: string;
  order: number;
  message: Record<string, unknown>;
}

interface CanonicalResult {
  entryId: string;
  callId: string;
  toolName: string;
  order: number;
  valid: boolean;
  content?: string;
  contentHash?: string;
}

interface CanonicalFrontier {
  order: number;
  prefix: string;
}

interface CanonicalIndex {
  results: Map<string, CanonicalResult[]>;
  duplicateEntryIds: ReadonlySet<string>;
  prefixes: ReadonlyMap<number, string>;
  terminal?: CanonicalFrontier;
}

interface ToolReceipt {
  callId: string;
  toolName: string;
  entryId: string;
  contentHash: string;
  bindingDigest: string;
  order: number;
  startOrder: number;
}

interface Manifest extends ToolReceipt {
  resourcePath: string;
  resourceKey: string;
  revision: number;
  items: Array<{ key: string; label: string }>;
}

interface ScriptDeclaration extends ToolReceipt {
  scriptPath: string;
  contentDigest: string;
}

interface ScriptRead extends ToolReceipt {
  scriptPath: string;
  declarationDigest: string;
}

interface Listing extends ToolReceipt {
  resourcePath: string;
  scriptPath: string;
  manifestDigest: string;
  scriptReadDigest: string;
  files: Array<{ path: string; itemKey: string }>;
}

interface ContentActivity {
  resourceKey: string;
  itemKeys: string[];
  listingDigest: string;
  files: string[];
}

/** Private receipt retains enough mapping provenance for canonical revalidation. */
interface AccessReceipt extends ToolReceipt {
  resourceKey: string;
  itemKeys: string[];
  listingDigest: string;
  /** Private source paths bind the names-only fact to its exact mapping. */
  files: string[];
}

interface CandidateBase {
  callId: string;
  toolName: "bash" | "write" | "edit" | "read";
  startOrder: number;
  ended: boolean;
}

type Candidate =
  | (CandidateBase & {
      kind: "manifest";
      toolName: "bash";
      resourcePath: string;
    })
  | (CandidateBase & {
      kind: "script-write";
      toolName: "write" | "edit";
      scriptPath: string;
      contentDigest: string;
    })
  | (CandidateBase & {
      kind: "script-read";
      toolName: "read";
      scriptPath: string;
    })
  | (CandidateBase & {
      kind: "listing";
      toolName: "bash";
      scriptPath: string;
      resourcePath: string;
    })
  | (CandidateBase & {
      kind: "content-read";
      toolName: "bash" | "read";
      activity: ContentActivity;
    });

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const uniqueItemKeys = (itemKeys: readonly string[]) => [...new Set(itemKeys)];

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const byteLength = (value: unknown) => {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const safeText = (value: unknown, maxBytes = 1024): value is string =>
  typeof value === "string" &&
  !!value &&
  Buffer.byteLength(value, "utf8") <= maxBytes &&
  !/[\p{Cc}\p{Cf}]/u.test(value);

/** Normalized repository-relative identity; no filesystem lookup occurs. */
const repoPath = (value: unknown): string | undefined => {
  if (
    !safeText(value) ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("//")
  )
    return;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)) return;
  const parts = value.split("/");
  return parts.every(
    (part) => !!part && part !== "." && part !== ".." && part.trim() === part,
  )
    ? value
    : undefined;
};

const workbookPath = (value: unknown) => {
  const path = repoPath(value);
  return path && /\.xlsx$/iu.test(path) ? path : undefined;
};

const words = (command: unknown): string[] | undefined => {
  if (
    !safeText(command, 4096) ||
    command.trim() !== command ||
    command.includes("  ") ||
    !/^[\x20-\x7e]+$/u.test(command)
  )
    return;
  return command.split(" ");
};

const commandOf = (args: unknown) =>
  record(args) && typeof args.command === "string" ? args.command : undefined;

const manifestCommand = (args: unknown) => {
  const value = words(commandOf(args));
  if (!value) return;
  const offset = value[2] === "--" ? 3 : 2;
  if (
    value[0] !== "unzip" ||
    value[1] !== "-p" ||
    value.length !== offset + 2 ||
    value[offset + 1] !== "xl/workbook.xml"
  )
    return;
  return workbookPath(value[offset]);
};

const listingCommand = (args: unknown) => {
  const value = words(commandOf(args));
  if (!value) return;
  if (value.length !== 3 || value[0] !== "bash" || !repoPath(value[1])) return;
  const resourcePath = workbookPath(value[2]);
  return resourcePath ? { scriptPath: value[1], resourcePath } : undefined;
};

const contentReadCommand = (args: unknown) => {
  const value = words(commandOf(args));
  if (!value) return;
  if (value[0] === "cat" && value.length > 1) return value.slice(1);
  if (
    value[0] === "sed" &&
    value[1] === "-n" &&
    value.length >= 4 &&
    /^'[1-9]\d*,[1-9]\d*p'$/u.test(value[2])
  )
    return value.slice(3);
};

const textContent = (content: unknown): string | undefined => {
  if (!Array.isArray(content) || !content.length) return;
  const text: string[] = [];
  let bytes = 0;
  for (const part of content) {
    if (!record(part) || part.type !== "text" || typeof part.text !== "string")
      return;
    const nextBytes =
      Buffer.byteLength(part.text, "utf8") + (text.length ? 1 : 0);
    if (bytes + nextBytes > MAX_PAYLOAD_BYTES) return;
    text.push(part.text);
    bytes += nextBytes;
  }
  return text.join("\n");
};

const resultHeader = (
  entry: unknown,
  order: number,
): CanonicalHeader | undefined => {
  if (
    !record(entry) ||
    entry.type !== "message" ||
    typeof entry.id !== "string"
  )
    return;
  const message = record(entry.message) ? entry.message : undefined;
  if (!message) return;
  if (
    message.role !== "toolResult" ||
    typeof message.toolCallId !== "string" ||
    !message.toolCallId ||
    typeof message.toolName !== "string" ||
    !message.toolName
  )
    return;
  return {
    entryId: entry.id,
    callId: message.toolCallId,
    toolName: message.toolName,
    order,
    message,
  };
};

/** Materializes only a pending or retained-receipt payload after header indexing. */
const materializeResult = (header: CanonicalHeader): CanonicalResult => {
  const details = record(header.message.details)
    ? header.message.details
    : undefined;
  const truncation =
    details && record(details.truncation) ? details.truncation : undefined;
  const content = textContent(header.message.content);
  const valid =
    !header.message.isError &&
    !header.message.excludeFromContext &&
    truncation?.truncated !== true &&
    content !== undefined;
  return {
    entryId: header.entryId,
    callId: header.callId,
    toolName: header.toolName,
    order: header.order,
    valid,
    ...(content === undefined ? {} : { content, contentHash: sha256(content) }),
  };
};

const canonicalResults = (
  entries: readonly unknown[],
  targetCallIds: ReadonlySet<string>,
  frontierOrder?: number,
): CanonicalIndex => {
  const duplicateEntryIds = new Set<string>();
  const entryIds = new Set<string>();
  const prefixes = new Map<number, string>();
  const targetHeaders: CanonicalHeader[] = [];
  let prefix = sha256("coverage-canonical-frontier/v1");
  let terminal: CanonicalFrontier | undefined;
  for (const [order, entry] of entries.entries()) {
    const value = record(entry) ? entry : undefined;
    const id = typeof value?.id === "string" ? value.id : "";
    if (id && entryIds.has(id)) duplicateEntryIds.add(id);
    else if (id) entryIds.add(id);
    prefix = sha256(JSON.stringify([prefix, id, value?.type ?? ""]));
    terminal = { order, prefix };
    if (
      order === frontierOrder ||
      targetCallIds.has(resultHeader(entry, order)?.callId ?? "")
    )
      prefixes.set(order, prefix);
    const header = resultHeader(entry, order);
    if (header && targetCallIds.has(header.callId)) targetHeaders.push(header);
  }
  const results = new Map<string, CanonicalResult[]>();
  for (const header of targetHeaders) {
    const result = materializeResult(header);
    if (duplicateEntryIds.has(result.entryId)) result.valid = false;
    const matching = results.get(result.callId) ?? [];
    matching.push(result);
    results.set(result.callId, matching);
  }
  return {
    results,
    duplicateEntryIds,
    prefixes,
    ...(terminal ? { terminal } : {}),
  };
};

const namedEntity = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

/** Narrow attribute decoder; never expands declarations or external entities. */
const decodeXml = (value: string): string | undefined => {
  let decoded = "";
  let index = 0;
  for (const match of value.matchAll(
    /&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/gu,
  )) {
    const start = match.index ?? 0;
    const raw = match[0];
    if (value.slice(index, start).includes("&")) return;
    decoded += value.slice(index, start);
    const entity = raw.slice(1, -1);
    if (namedEntity.has(entity)) decoded += namedEntity.get(entity);
    else {
      const numeric = entity.startsWith("#x")
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (
        !Number.isSafeInteger(numeric) ||
        numeric <= 0 ||
        numeric > 0x10ffff ||
        (numeric >= 0xd800 && numeric <= 0xdfff)
      )
        return;
      decoded += String.fromCodePoint(numeric);
    }
    index = start + raw.length;
  }
  if (value.slice(index).includes("&")) return;
  return decoded + value.slice(index);
};

const attributes = (value: string): Map<string, string> | undefined => {
  const found = new Map<string, string>();
  const attribute = /\s+([A-Za-z_][\w:.-]*)="([^"<]*)"/gy;
  let index = 0;
  while (index < value.length) {
    attribute.lastIndex = index;
    const match = attribute.exec(value);
    if (!match || match.index !== index) return;
    const decoded = decodeXml(match[2]);
    if (decoded === undefined || found.has(match[1])) return;
    found.set(match[1], decoded);
    index = attribute.lastIndex;
  }
  return found;
};

const boundedAttributes = (value: string) => {
  const parsed = attributes(value);
  return parsed && parsed.size <= 16 ? parsed : undefined;
};

const sheetNames = (sheets: string): string[] | undefined => {
  const names: string[] = [];
  const sheet = /\s*<sheet((?:\s+[A-Za-z_][\w:.-]*="[^"<]*")*)\s*\/>/gy;
  let index = 0;
  while (index < sheets.length) {
    sheet.lastIndex = index;
    const match = sheet.exec(sheets);
    if (!match || match.index !== index) {
      if (/^\s*$/u.test(sheets.slice(index))) break;
      return;
    }
    const values = boundedAttributes(match[1]);
    if (!values?.has("name")) return;
    for (const key of values.keys())
      if (!["name", "sheetId", "state", "r:id"].includes(key)) return;
    const name = values.get("name");
    if (
      !safeText(name, MAX_LABEL_SCALARS * 4) ||
      Array.from(name).length > MAX_LABEL_SCALARS ||
      names.includes(name)
    )
      return;
    names.push(name);
    if (names.length > MAX_SHEETS) return;
    index = sheet.lastIndex;
  }
  return names.length ? names : undefined;
};

const workbookViewsAreValid = (body: string) => {
  const view = /\s*<workbookView((?:\s+[A-Za-z_][\w:.-]*="[^"<]*")*)\s*\/>/gy;
  let index = 0;
  let count = 0;
  while (index < body.length) {
    view.lastIndex = index;
    const match = view.exec(body);
    if (!match || match.index !== index)
      return /^\s*$/u.test(body.slice(index)) && count > 0;
    if (!boundedAttributes(match[1])) return false;
    count++;
    if (count > MAX_SHEETS) return false;
    index = view.lastIndex;
  }
  return count > 0;
};

const definedNamesAreValid = (body: string) => {
  const name =
    /\s*<definedName((?:\s+[A-Za-z_][\w:.-]*="[^"<]*")*)>([^<]*)<\/definedName>/gy;
  let index = 0;
  let count = 0;
  while (index < body.length) {
    name.lastIndex = index;
    const match = name.exec(body);
    if (!match || match.index !== index)
      return /^\s*$/u.test(body.slice(index));
    const values = boundedAttributes(match[1]);
    if (!values?.has("name") || decodeXml(match[2]) === undefined) return false;
    count++;
    if (count > MAX_SHEETS) return false;
    index = name.lastIndex;
  }
  return true;
};

/**
 * Direct sheet names plus bounded normal OOXML workbook metadata only. Formula,
 * defined-name, relationship, and view bodies are validated then discarded.
 */
const manifestNames = (body: string): string[] | undefined => {
  if (Buffer.byteLength(body, "utf8") > MAX_PAYLOAD_BYTES || /<!/u.test(body))
    return;
  let xml = body.trim();
  if (xml.startsWith("<?xml")) {
    const end = xml.indexOf("?>");
    if (
      end < 0 ||
      !/^<\?xml version="1\.0"(?: encoding="(?:UTF-8|utf-8)")?(?: standalone="(?:yes|no)")?\?>$/u.test(
        xml.slice(0, end + 2),
      )
    )
      return;
    xml = xml.slice(end + 2).trimStart();
  }
  const outer =
    /^<workbook((?:\s+[A-Za-z_][\w:.-]*="[^"<]*")*)>([\s\S]*)<\/workbook>$/u.exec(
      xml,
    );
  if (!outer) return;
  const rootAttributes = boundedAttributes(outer[1]);
  if (!rootAttributes) return;
  for (const key of rootAttributes.keys())
    if (key !== "xmlns" && key !== "xmlns:r") return;
  const children = outer[2];
  const seen = new Set<string>();
  let names: string[] | undefined;
  let index = 0;
  const selfClosing =
    /<(fileVersion|workbookPr|calcPr)((?:\s+[A-Za-z_][\w:.-]*="[^"<]*")*)\s*\/>/y;
  while (index < children.length) {
    const whitespace = /^\s*/u.exec(children.slice(index))?.[0] ?? "";
    index += whitespace.length;
    if (index === children.length) break;
    selfClosing.lastIndex = index;
    const simple = selfClosing.exec(children);
    if (simple && simple.index === index) {
      if (seen.has(simple[1]) || !boundedAttributes(simple[2])) return;
      seen.add(simple[1]);
      index = selfClosing.lastIndex;
      continue;
    }
    const known = ["bookViews", "sheets", "definedNames"].find((tag) =>
      children.startsWith(`<${tag}>`, index),
    );
    if (!known || seen.has(known)) return;
    const start = index + known.length + 2;
    const end = children.indexOf(`</${known}>`, start);
    if (end < 0) return;
    const inner = children.slice(start, end);
    let valid: boolean;
    if (known === "sheets") {
      names = sheetNames(inner);
      valid = !!names;
    } else if (known === "bookViews") valid = workbookViewsAreValid(inner);
    else valid = definedNamesAreValid(inner);
    if (!valid) return;
    seen.add(known);
    index = end + known.length + 3;
  }
  return seen.has("sheets") ? names : undefined;
};

const listingRecords = (
  body: string,
  manifest: Manifest,
): Array<{ path: string; itemKey: string }> | undefined => {
  if (Buffer.byteLength(body, "utf8") > MAX_PAYLOAD_BYTES) return;
  const items = new Map(manifest.items.map((item) => [item.label, item.key]));
  const files = new Set<string>();
  const records: Array<{ path: string; itemKey: string }> = [];
  for (const line of body.split("\n")) {
    if (!line) continue;
    const match = /^(.+) rows ([1-9]\d*) nonempty rows (\d+) file (.+)$/u.exec(
      line,
    );
    if (!match || Array.from(match[1]).length > MAX_LABEL_SCALARS) return;
    const path = repoPath(match[4]);
    const itemKey = items.get(match[1]);
    if (!path || !itemKey || files.has(path)) return;
    const rows = Number(match[2]);
    const nonempty = Number(match[3]);
    if (
      !Number.isSafeInteger(rows) ||
      !Number.isSafeInteger(nonempty) ||
      nonempty > rows
    )
      return;
    files.add(path);
    records.push({ path, itemKey });
    if (records.length > MAX_SHEETS) return;
  }
  return records.length ? records : undefined;
};

const receipt = (
  result: CanonicalResult,
  startOrder: number,
  metadata: readonly string[],
): ToolReceipt | undefined =>
  result.contentHash
    ? {
        callId: result.callId,
        toolName: result.toolName,
        entryId: result.entryId,
        contentHash: result.contentHash,
        bindingDigest: sha256(
          JSON.stringify([result.callId, result.toolName, ...metadata]),
        ),
        order: result.order,
        startOrder,
      }
    : undefined;

const sameReceipt = (value: ToolReceipt, index: CanonicalIndex) => {
  const matching = index.results.get(value.callId);
  const current = matching?.length === 1 ? matching[0] : undefined;
  if (!current?.valid || index.duplicateEntryIds.has(value.entryId))
    return false;
  return (
    current.toolName === value.toolName &&
    current.entryId === value.entryId &&
    current.contentHash === value.contentHash
  );
};

/**
 * Passive, profile-specific workbook observer. Candidate tool events gain no
 * authority until their final result appears uniquely on canonical branch.
 */
export class CoverageAdapter {
  private epoch: number | undefined;
  /** Legacy aggregate omissions still drive existing coverage reporting. */
  private omissions = 0;
  private semanticOmissions = 0;
  private accessOmissions = 0;
  /** Rotated when any metadata-visible canonical fact changes. */
  private evidenceToken = {};
  /** Activity/mapping/receipt proof changes never stale semantic metadata. */
  private accessEvidenceToken = {};
  private nextStartOrder = 1;
  private readonly pending = new Map<string, Candidate>();
  /** One hash-bound canonical frontier blocks reacceptance without call-ID history. */
  private frontier: CanonicalFrontier | undefined;
  private readonly manifests = new Map<string, Manifest>();
  private readonly declarations = new Map<string, ScriptDeclaration>();
  private readonly scriptReads = new Map<string, ScriptRead>();
  private readonly listings = new Map<string, Listing>();
  private readonly accessReceipts = new Map<string, AccessReceipt>();
  private readonly fileMappings = new Map<
    string,
    { resourceKey: string; itemKey: string; listingDigest: string }
  >();
  private readonly ambiguousFiles = new Set<string>();

  start(input: CoverageToolStart, epoch: number) {
    if (!this.acceptsEpoch(epoch) || !safeText(input.toolCallId, 512)) return;
    if (this.pending.has(input.toolCallId)) return;
    const candidate = this.candidate(input, this.nextStartOrder++);
    if (!candidate) return;
    if (this.pending.size >= MAX_PENDING || !this.fitsAdditional(candidate)) {
      this.omit(candidate.kind === "manifest" ? "semantic" : "access");
      return;
    }
    this.pending.set(input.toolCallId, candidate);
    if (candidate.kind === "content-read") this.invalidateAccessEvidence();
  }

  end(input: CoverageToolEnd, epoch: number) {
    if (epoch !== this.epoch) return;
    const candidate = this.pending.get(input.toolCallId);
    if (!candidate || candidate.toolName !== input.toolName) return;
    candidate.ended = true;
    if (candidate.kind === "content-read") this.invalidateAccessEvidence();
  }

  confirm(entries: readonly unknown[], epoch: number): CoverageAdapterResult {
    if (epoch !== this.epoch) return this.result();
    const index = canonicalResults(
      entries,
      this.targetCallIds(),
      this.frontier?.order,
    );
    if (!this.frontierCurrent(index)) {
      this.clearAuthority(index);
      return this.result();
    }
    this.revalidate(index);
    const accepted: CoverageAdapterResult = {
      inventories: [],
      access: [],
      omissions: this.omissions,
    };
    const ready: Array<{ candidate: Candidate; result: CanonicalResult }> = [];
    for (const [callId, candidate] of [...this.pending]) {
      if (!candidate.ended) continue;
      const matching = index.results.get(callId);
      if (!matching?.length) continue; // preappend: terminal listener has no canonical result yet.
      this.pending.delete(callId);
      const current = matching.length === 1 ? matching[0] : undefined;
      if (!current?.valid || current.toolName !== candidate.toolName) {
        this.omit(candidate.kind === "manifest" ? "semantic" : "access");
        continue;
      }
      ready.push({ candidate, result: current });
    }
    ready.sort((left, right) => left.result.order - right.result.order);
    for (const item of ready)
      this.accept(item.candidate, item.result, index, accepted);
    accepted.omissions = this.omissions;
    return accepted;
  }

  activity(): CoverageActivity[] {
    return [...this.pending.values()].flatMap((candidate) =>
      candidate.kind === "content-read" && !candidate.ended
        ? [
            {
              callId: candidate.callId,
              resourceKey: candidate.activity.resourceKey,
              itemKeys: [...candidate.activity.itemKeys],
            },
          ]
        : [],
    );
  }

  snapshot(): CoverageAdapterSnapshot {
    return { pendingCount: this.pending.size, omissions: this.omissions };
  }

  /**
   * Return only current resource/item access facts. Internal paths, scripts,
   * bodies, and raw call IDs never leave this adapter.
   */
  accessEvidence(): SubtaskAccessEvidence {
    const mapped = new Map<string, string[]>();
    for (const mapping of this.fileMappings.values()) {
      const itemKeys = mapped.get(mapping.resourceKey) ?? [];
      if (!itemKeys.includes(mapping.itemKey)) itemKeys.push(mapping.itemKey);
      mapped.set(mapping.resourceKey, itemKeys);
    }
    const evidence = deepFreeze({
      mapped: [...mapped].map(([resourceKey, itemKeys]) => ({
        resourceKey,
        itemKeys,
      })),
      active: [...this.pending.values()].flatMap((candidate) =>
        candidate.kind === "content-read" && !candidate.ended
          ? [
              {
                callHash: sha256(candidate.callId),
                resourceKey: candidate.activity.resourceKey,
                itemKeys: uniqueItemKeys(candidate.activity.itemKeys),
              },
            ]
          : [],
      ),
      confirmed: [...this.accessReceipts.values()].map((receipt) => ({
        resourceKey: receipt.resourceKey,
        itemKeys: [...receipt.itemKeys],
        source: {
          entryId: receipt.entryId,
          messageHash: receipt.contentHash,
          callHash: sha256(receipt.callId),
        },
      })),
      omissions: this.accessOmissions,
    });
    const token = this.accessEvidenceToken;
    subtaskAccessEvidenceAttestations.set(evidence, {
      current: () => this.accessEvidenceToken === token,
    });
    return evidence;
  }

  /**
   * Return only current confirmed manifest names and scalar receipts. Adapter
   * paths, raw call IDs, raw tool bodies, mappings, and activity stay private.
   */
  metadata(): SubtaskEvidence | undefined {
    if (!this.manifests.size) return;
    const evidence = deepFreeze({
      resources: [...this.manifests.values()].map((manifest) => ({
        resourceKey: manifest.resourceKey,
        revision: manifest.revision,
        complete: true,
        items: manifest.items.map((item) => ({
          key: item.key,
          label: item.label,
        })),
        source: {
          entryId: manifest.entryId,
          messageHash: manifest.contentHash,
          callHash: sha256(manifest.callId),
        },
      })),
      omissions: this.semanticOmissions,
    });
    if (byteLength(evidence) > MAX_METADATA_BYTES) return;
    const token = this.evidenceToken;
    subtaskEvidenceAttestations.set(evidence, {
      current: () => this.evidenceToken === token && this.manifests.size > 0,
    });
    return evidence;
  }

  reset(epoch: number) {
    this.invalidateEvidence();
    this.invalidateAccessEvidence();
    this.epoch = epoch;
    this.omissions = 0;
    this.semanticOmissions = 0;
    this.accessOmissions = 0;
    this.nextStartOrder = 1;
    this.pending.clear();
    this.frontier = undefined;
    this.manifests.clear();
    this.declarations.clear();
    this.scriptReads.clear();
    this.listings.clear();
    this.accessReceipts.clear();
    this.fileMappings.clear();
    this.ambiguousFiles.clear();
  }

  private acceptsEpoch(epoch: number) {
    if (!Number.isSafeInteger(epoch) || epoch < 0) return false;
    if (this.epoch === undefined) this.epoch = epoch;
    return this.epoch === epoch;
  }

  private candidate(
    input: CoverageToolStart,
    startOrder: number,
  ): Candidate | undefined {
    if (input.toolName === "bash") {
      const resourcePath = manifestCommand(input.args);
      if (resourcePath)
        return {
          kind: "manifest",
          callId: input.toolCallId,
          toolName: "bash",
          startOrder,
          resourcePath,
          ended: false,
        };
      const listing = listingCommand(input.args);
      if (listing)
        return {
          kind: "listing",
          callId: input.toolCallId,
          toolName: "bash",
          startOrder,
          ...listing,
          ended: false,
        };
      const files = contentReadCommand(input.args);
      if (!files?.length || new Set(files).size !== files.length) return;
      const mapped = files.map((path) => this.fileMappings.get(path));
      if (
        mapped.some((value) => !value) ||
        !mapped.every(
          (value) =>
            value?.resourceKey === mapped[0]?.resourceKey &&
            value?.listingDigest === mapped[0]?.listingDigest,
        )
      )
        return;
      return {
        kind: "content-read",
        callId: input.toolCallId,
        toolName: "bash",
        startOrder,
        activity: {
          resourceKey: mapped[0]?.resourceKey ?? "",
          itemKeys: mapped.flatMap((value) => (value ? [value.itemKey] : [])),
          listingDigest: mapped[0]?.listingDigest ?? "",
          files: [...files],
        },
        ended: false,
      };
    }
    if (input.toolName === "write" || input.toolName === "edit") {
      // Standard edit patches do not declare complete final content, so only a
      // whole-content declaration can attest a later exact script read.
      const args = record(input.args) ? input.args : undefined;
      const scriptPath = repoPath(args?.path);
      if (!scriptPath || typeof args?.content !== "string") return;
      if (Buffer.byteLength(args.content, "utf8") > MAX_PAYLOAD_BYTES) return;
      return {
        kind: "script-write",
        callId: input.toolCallId,
        toolName: input.toolName,
        startOrder,
        scriptPath,
        contentDigest: sha256(args.content),
        ended: false,
      };
    }
    if (input.toolName === "read") {
      const args = record(input.args) ? input.args : undefined;
      const path = repoPath(args?.path);
      const mapping = path && this.fileMappings.get(path);
      if (path && mapping)
        return {
          kind: "content-read",
          callId: input.toolCallId,
          toolName: "read",
          startOrder,
          activity: {
            resourceKey: mapping.resourceKey,
            itemKeys: [mapping.itemKey],
            listingDigest: mapping.listingDigest,
            files: [path],
          },
          ended: false,
        };
      return path
        ? {
            kind: "script-read",
            callId: input.toolCallId,
            toolName: "read",
            startOrder,
            scriptPath: path,
            ended: false,
          }
        : undefined;
    }
  }

  private accept(
    candidate: Candidate,
    result: CanonicalResult,
    index: CanonicalIndex,
    accepted: CoverageAdapterResult,
  ) {
    if (candidate.kind === "manifest") {
      const names = result.content ? manifestNames(result.content) : undefined;
      if (!names) return this.omit();
      const resourceKey = sha256(candidate.resourcePath);
      if (!this.canAcceptCall(result, index)) return this.omit();
      const prior = this.manifests.get(candidate.resourcePath);
      const nextReceipt = receipt(result, candidate.startOrder, [
        "workbook-manifest-xml/v1",
        resourceKey,
      ]);
      if (!nextReceipt) return this.omit();
      const next: Manifest = {
        ...nextReceipt,
        resourcePath: candidate.resourcePath,
        resourceKey,
        revision: (prior?.revision ?? 0) + 1,
        items: names.map((label) => ({
          key: sha256(`${resourceKey}\u0000${label}`),
          label,
        })),
      };
      if (
        (!prior && this.manifests.size >= MAX_RETAINED_RECEIPTS) ||
        !this.fitsReplacement(prior, next)
      )
        return this.omit();
      this.manifests.set(candidate.resourcePath, next);
      this.invalidateEvidence();
      this.rememberAcceptedCall(result, index);
      this.listings.delete(candidate.resourcePath);
      this.rebuildMappings();
      accepted.inventories.push({
        resourceKey,
        revision: next.revision,
        complete: true,
        source: {
          entryId: result.entryId,
          messageHash: result.contentHash ?? "",
          callId: result.callId,
        },
        items: next.items.map((item) => ({ ...item })),
      });
      return;
    }
    if (candidate.kind === "script-write") {
      if (!this.canAcceptCall(result, index)) return this.omit("access");
      const prior = this.declarations.get(candidate.scriptPath);
      const nextReceipt = receipt(result, candidate.startOrder, [
        "worksheet-extraction-list/v1",
        candidate.scriptPath,
        candidate.contentDigest,
      ]);
      if (!nextReceipt) return this.omit("access");
      const next: ScriptDeclaration = {
        ...nextReceipt,
        scriptPath: candidate.scriptPath,
        contentDigest: candidate.contentDigest,
      };
      if (
        (!prior && this.declarations.size >= MAX_RETAINED_RECEIPTS) ||
        !this.fitsReplacement(prior, next)
      )
        return this.omit("access");
      this.declarations.set(candidate.scriptPath, next);
      this.rememberAcceptedCall(result, index);
      this.scriptReads.delete(candidate.scriptPath);
      for (const [resourcePath, listing] of this.listings)
        if (listing.scriptPath === candidate.scriptPath)
          this.listings.delete(resourcePath);
      this.rebuildMappings();
      return;
    }
    if (candidate.kind === "script-read") {
      const declaration = this.declarations.get(candidate.scriptPath);
      if (
        !declaration ||
        !result.content ||
        sha256(result.content) !== declaration.contentDigest ||
        declaration.order >= result.order ||
        declaration.startOrder >= candidate.startOrder ||
        !this.canAcceptCall(result, index)
      )
        return this.omit("access");
      const prior = this.scriptReads.get(candidate.scriptPath);
      const nextReceipt = receipt(result, candidate.startOrder, [
        "worksheet-extraction-list/v1",
        candidate.scriptPath,
        declaration.bindingDigest,
      ]);
      if (!nextReceipt) return this.omit("access");
      const next: ScriptRead = {
        ...nextReceipt,
        scriptPath: candidate.scriptPath,
        declarationDigest: declaration.bindingDigest,
      };
      if (
        (!prior && this.scriptReads.size >= MAX_RETAINED_RECEIPTS) ||
        !this.fitsReplacement(prior, next)
      )
        return this.omit("access");
      this.scriptReads.set(candidate.scriptPath, next);
      this.rememberAcceptedCall(result, index);
      for (const [resourcePath, listing] of this.listings)
        if (listing.scriptPath === candidate.scriptPath)
          this.listings.delete(resourcePath);
      this.rebuildMappings();
      return;
    }
    if (candidate.kind === "listing") {
      const manifest = this.manifests.get(candidate.resourcePath);
      const declaration = this.declarations.get(candidate.scriptPath);
      const scriptRead = this.scriptReads.get(candidate.scriptPath);
      if (
        !manifest ||
        !declaration ||
        !scriptRead ||
        scriptRead.declarationDigest !== declaration.bindingDigest ||
        manifest.order >= result.order ||
        manifest.startOrder >= candidate.startOrder ||
        declaration.order >= scriptRead.order ||
        declaration.startOrder >= scriptRead.startOrder ||
        scriptRead.order >= result.order ||
        scriptRead.startOrder >= candidate.startOrder ||
        !this.canAcceptCall(result, index)
      )
        return this.omit("access");
      const files = result.content
        ? listingRecords(result.content, manifest)
        : undefined;
      if (!files) return this.omit("access");
      const prior = this.listings.get(candidate.resourcePath);
      const currentMappings = this.mappingCount() - (prior?.files.length ?? 0);
      const nextReceipt = receipt(result, candidate.startOrder, [
        "worksheet-extraction-list/v1",
        manifest.resourceKey,
        candidate.scriptPath,
        manifest.bindingDigest,
        scriptRead.bindingDigest,
      ]);
      if (
        !nextReceipt ||
        currentMappings + files.length > MAX_MAPPINGS ||
        (!prior && this.listings.size >= MAX_RETAINED_RECEIPTS)
      )
        return this.omit("access");
      const next: Listing = {
        ...nextReceipt,
        resourcePath: candidate.resourcePath,
        scriptPath: candidate.scriptPath,
        manifestDigest: manifest.bindingDigest,
        scriptReadDigest: scriptRead.bindingDigest,
        files,
      };
      if (!this.fitsReplacement(prior, next)) return this.omit("access");
      this.listings.set(candidate.resourcePath, next);
      this.rememberAcceptedCall(result, index);
      this.rebuildMappings();
      accepted.access.push({
        resourceKey: manifest.resourceKey,
        itemKeys: files.map((file) => file.itemKey),
        source: {
          entryId: result.entryId,
          messageHash: result.contentHash ?? "",
          callId: result.callId,
        },
      });
      return;
    }
    const listing = [...this.listings.values()].find(
      (item) => item.bindingDigest === candidate.activity.listingDigest,
    );
    if (
      !listing ||
      !this.contentActivityCurrent(candidate) ||
      !this.canAcceptCall(result, index) ||
      !candidate.activity.files.every((path, index) => {
        const mapping = this.fileMappings.get(path);
        return (
          mapping?.resourceKey === candidate.activity.resourceKey &&
          mapping.listingDigest === candidate.activity.listingDigest &&
          mapping.itemKey === candidate.activity.itemKeys[index]
        );
      })
    )
      return this.omit("access");
    const itemKeys = uniqueItemKeys(candidate.activity.itemKeys);
    const nextReceipt = receipt(result, candidate.startOrder, [
      "worksheet-content-read/v1",
      candidate.activity.resourceKey,
      candidate.activity.listingDigest,
      ...itemKeys,
    ]);
    if (
      !nextReceipt ||
      !this.retainAccessReceipt({
        ...nextReceipt,
        resourceKey: candidate.activity.resourceKey,
        itemKeys,
        listingDigest: candidate.activity.listingDigest,
        files: [...candidate.activity.files],
      })
    )
      return this.omit("access");
    this.rememberAcceptedCall(result, index);
    accepted.access.push({
      resourceKey: candidate.activity.resourceKey,
      itemKeys: [...candidate.activity.itemKeys],
      source: {
        entryId: result.entryId,
        messageHash: result.contentHash ?? "",
        callId: result.callId,
      },
    });
  }

  private revalidate(index: CanonicalIndex) {
    let metadataChanged = false;
    for (const [path, manifest] of this.manifests)
      if (!sameReceipt(manifest, index)) {
        this.manifests.delete(path);
        metadataChanged = true;
      }
    for (const [path, declaration] of this.declarations)
      if (!sameReceipt(declaration, index)) this.declarations.delete(path);
    for (const [path, scriptRead] of this.scriptReads) {
      const declaration = this.declarations.get(path);
      if (
        !sameReceipt(scriptRead, index) ||
        !declaration ||
        scriptRead.declarationDigest !== declaration.bindingDigest ||
        declaration.order >= scriptRead.order ||
        declaration.startOrder >= scriptRead.startOrder
      )
        this.scriptReads.delete(path);
    }
    for (const [resourcePath, listing] of this.listings) {
      const manifest = this.manifests.get(resourcePath);
      const scriptRead = this.scriptReads.get(listing.scriptPath);
      if (
        !sameReceipt(listing, index) ||
        !manifest ||
        !scriptRead ||
        listing.manifestDigest !== manifest.bindingDigest ||
        listing.scriptReadDigest !== scriptRead.bindingDigest ||
        manifest.order >= listing.order ||
        manifest.startOrder >= listing.startOrder ||
        scriptRead.order >= listing.order ||
        scriptRead.startOrder >= listing.startOrder
      )
        this.listings.delete(resourcePath);
    }
    if (metadataChanged) this.invalidateEvidence();
    this.rebuildMappings();
    this.revalidateAccessReceipts(index);
    this.clearInvalidPendingActivities();
  }

  private mappingFingerprint() {
    return JSON.stringify({
      mappings: [...this.fileMappings.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
      ambiguous: [...this.ambiguousFiles].sort(),
    });
  }

  private rebuildMappings() {
    const before = this.mappingFingerprint();
    this.fileMappings.clear();
    this.ambiguousFiles.clear();
    for (const listing of this.listings.values()) {
      const manifest = this.manifests.get(listing.resourcePath);
      if (!manifest) continue;
      for (const file of listing.files) {
        if (this.ambiguousFiles.has(file.path)) continue;
        const current = this.fileMappings.get(file.path);
        if (current && current.resourceKey !== manifest.resourceKey) {
          this.fileMappings.delete(file.path);
          this.ambiguousFiles.add(file.path);
          continue;
        }
        this.fileMappings.set(file.path, {
          resourceKey: manifest.resourceKey,
          itemKey: file.itemKey,
          listingDigest: listing.bindingDigest,
        });
      }
    }
    if (before !== this.mappingFingerprint()) this.invalidateAccessEvidence();
    this.dropAccessReceiptsWithoutCurrentMapping();
  }

  private accessReceiptMappingCurrent(receipt: AccessReceipt) {
    const listing = [...this.listings.values()].find(
      (item) => item.bindingDigest === receipt.listingDigest,
    );
    const manifest = listing && this.manifests.get(listing.resourcePath);
    return (
      !!listing &&
      manifest?.resourceKey === receipt.resourceKey &&
      receipt.files.every((path) => {
        const mapping = this.fileMappings.get(path);
        return (
          mapping?.resourceKey === receipt.resourceKey &&
          mapping.listingDigest === receipt.listingDigest &&
          receipt.itemKeys.includes(mapping.itemKey)
        );
      })
    );
  }

  private dropAccessReceiptsWithoutCurrentMapping() {
    let changed = false;
    for (const [callId, receipt] of this.accessReceipts)
      if (!this.accessReceiptMappingCurrent(receipt)) {
        this.accessReceipts.delete(callId);
        changed = true;
      }
    if (changed) this.invalidateAccessEvidence();
  }

  private revalidateAccessReceipts(index: CanonicalIndex) {
    let changed = false;
    for (const [callId, receipt] of this.accessReceipts)
      if (
        !sameReceipt(receipt, index) ||
        !this.accessReceiptMappingCurrent(receipt)
      ) {
        this.accessReceipts.delete(callId);
        changed = true;
      }
    if (changed) this.invalidateAccessEvidence();
  }

  private contentActivityCurrent(
    candidate: Extract<Candidate, { kind: "content-read" }>,
  ) {
    return candidate.activity.files.every((path, index) => {
      const mapping = this.fileMappings.get(path);
      return (
        mapping?.resourceKey === candidate.activity.resourceKey &&
        mapping.listingDigest === candidate.activity.listingDigest &&
        mapping.itemKey === candidate.activity.itemKeys[index]
      );
    });
  }

  private clearInvalidPendingActivities() {
    let changed = false;
    for (const [callId, candidate] of this.pending)
      if (
        candidate.kind === "content-read" &&
        !this.contentActivityCurrent(candidate)
      ) {
        this.pending.delete(callId);
        changed = true;
      }
    if (changed) this.invalidateAccessEvidence();
  }

  private retainAccessReceipt(next: AccessReceipt) {
    const nextItems = new Set(next.itemKeys);
    const dominated = [...this.accessReceipts.values()].filter(
      (current) =>
        current.resourceKey === next.resourceKey &&
        current.itemKeys.every((itemKey) => nextItems.has(itemKey)),
    );
    if (this.accessReceipts.size - dominated.length >= MAX_RETAINED_RECEIPTS)
      return false;
    if (!this.fitsReplacements(dominated, next)) return false;
    for (const current of dominated) this.accessReceipts.delete(current.callId);
    this.accessReceipts.set(next.callId, next);
    this.invalidateAccessEvidence();
    return true;
  }

  private mappingCount() {
    return [...this.listings.values()].reduce(
      (count, listing) => count + listing.files.length,
      0,
    );
  }

  /** Header index is whole-branch; only these bounded known calls read payload text. */
  private targetCallIds() {
    return new Set([
      ...[...this.pending.values()]
        .filter((candidate) => candidate.ended)
        .map((candidate) => candidate.callId),
      ...[...this.manifests.values()].map((receipt) => receipt.callId),
      ...[...this.declarations.values()].map((receipt) => receipt.callId),
      ...[...this.scriptReads.values()].map((receipt) => receipt.callId),
      ...[...this.listings.values()].map((receipt) => receipt.callId),
      ...[...this.accessReceipts.values()].map((receipt) => receipt.callId),
    ]);
  }

  private frontierCurrent(index: CanonicalIndex) {
    return (
      !this.frontier ||
      index.prefixes.get(this.frontier.order) === this.frontier.prefix
    );
  }

  private clearAuthority(index: CanonicalIndex) {
    this.pending.clear();
    this.manifests.clear();
    this.declarations.clear();
    this.scriptReads.clear();
    this.listings.clear();
    this.accessReceipts.clear();
    this.fileMappings.clear();
    this.ambiguousFiles.clear();
    this.frontier = index.terminal;
    this.omit("both");
  }

  private canAcceptCall(result: CanonicalResult, index: CanonicalIndex) {
    if (
      !result.contentHash ||
      index.duplicateEntryIds.has(result.entryId) ||
      !this.frontierCurrent(index)
    )
      return false;
    return !this.frontier || result.order > this.frontier.order;
  }

  private rememberAcceptedCall(result: CanonicalResult, index: CanonicalIndex) {
    const prefix = index.prefixes.get(result.order);
    if (prefix) this.frontier = { order: result.order, prefix };
  }

  private invalidateEvidence() {
    this.evidenceToken = {};
  }

  private invalidateAccessEvidence() {
    this.accessEvidenceToken = {};
  }

  private metadataBytes() {
    return byteLength({
      pending: [...this.pending.values()],
      ...(this.frontier ? { frontier: this.frontier } : {}),
      manifests: [...this.manifests.values()],
      declarations: [...this.declarations.values()],
      scriptReads: [...this.scriptReads.values()],
      listings: [...this.listings.values()],
      accessReceipts: [...this.accessReceipts.values()],
    });
  }

  private fitsAdditional(value: unknown) {
    return this.metadataBytes() + byteLength(value) <= MAX_METADATA_BYTES;
  }

  private fitsReplacement(current: unknown, next: unknown) {
    return this.fitsReplacements(current === undefined ? [] : [current], next);
  }

  private fitsReplacements(currents: readonly unknown[], next: unknown) {
    return (
      this.metadataBytes() -
        currents.reduce<number>(
          (bytes, current) => bytes + byteLength(current),
          0,
        ) +
        byteLength(next) <=
      MAX_METADATA_BYTES
    );
  }

  private omit(scope: "semantic" | "access" | "both" = "semantic") {
    this.omissions++;
    if (scope === "semantic" || scope === "both") {
      this.semanticOmissions++;
      this.invalidateEvidence();
    }
    if (scope === "access" || scope === "both") {
      this.accessOmissions++;
      this.invalidateAccessEvidence();
    }
  }

  private result(): CoverageAdapterResult {
    return { inventories: [], access: [], omissions: this.omissions };
  }
}
