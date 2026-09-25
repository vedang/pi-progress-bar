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

interface CanonicalResult {
  entryId: string;
  callId: string;
  toolName: string;
  valid: boolean;
  content?: string;
  contentHash?: string;
}

interface ToolReceipt {
  callId: string;
  toolName: string;
  entryId: string;
  contentHash: string;
  bindingDigest: string;
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

type Candidate =
  | {
      kind: "manifest";
      callId: string;
      toolName: "bash";
      resourcePath: string;
      ended: boolean;
    }
  | {
      kind: "script-write";
      callId: string;
      toolName: "write" | "edit";
      scriptPath: string;
      contentDigest: string;
      ended: boolean;
    }
  | {
      kind: "script-read";
      callId: string;
      toolName: "read";
      scriptPath: string;
      ended: boolean;
    }
  | {
      kind: "listing";
      callId: string;
      toolName: "bash";
      scriptPath: string;
      resourcePath: string;
      ended: boolean;
    }
  | {
      kind: "content-read";
      callId: string;
      toolName: "bash";
      activity: ContentActivity;
      ended: boolean;
    };

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

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
    value.length > 4 &&
    /^'[1-9]\d*,[1-9]\d*p'$/u.test(value[2])
  )
    return value.slice(3);
};

const textContent = (content: unknown): string | undefined => {
  if (!Array.isArray(content) || !content.length) return;
  const text: string[] = [];
  for (const part of content) {
    if (!record(part) || part.type !== "text" || typeof part.text !== "string")
      return;
    text.push(part.text);
  }
  const joined = text.join("\n");
  return Buffer.byteLength(joined, "utf8") <= MAX_PAYLOAD_BYTES
    ? joined
    : undefined;
};

const resultFromEntry = (entry: unknown): CanonicalResult | undefined => {
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
  const details = record(message.details) ? message.details : undefined;
  const truncation =
    details && record(details.truncation) ? details.truncation : undefined;
  const content = textContent(message.content);
  const valid =
    !message.isError &&
    !message.excludeFromContext &&
    truncation?.truncated !== true &&
    content !== undefined;
  return {
    entryId: entry.id,
    callId: message.toolCallId,
    toolName: message.toolName,
    valid,
    ...(content === undefined ? {} : { content, contentHash: sha256(content) }),
  };
};

const canonicalResults = (entries: readonly unknown[]) => {
  const results = new Map<string, CanonicalResult[]>();
  for (const entry of entries) {
    const result = resultFromEntry(entry);
    if (!result) continue;
    const matching = results.get(result.callId) ?? [];
    matching.push(result);
    results.set(result.callId, matching);
  }
  return results;
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

/** Full workbook/sheets/sheet hierarchy only; this is deliberately not XML generality. */
const manifestNames = (body: string): string[] | undefined => {
  if (Buffer.byteLength(body, "utf8") > MAX_PAYLOAD_BYTES || /<!/u.test(body))
    return;
  let xml = body.trim();
  if (xml.startsWith("<?xml")) {
    const end = xml.indexOf("?>");
    if (
      end < 0 ||
      !/^<\?xml version="1\.0"(?: encoding="(?:UTF-8|utf-8)")?\?>$/u.test(
        xml.slice(0, end + 2),
      )
    )
      return;
    xml = xml.slice(end + 2).trimStart();
  }
  const outer =
    /^<workbook(?:\s+[^<>]*)?><sheets>([\s\S]*)<\/sheets><\/workbook>$/u.exec(
      xml,
    );
  if (!outer) return;
  const sheets = outer[1];
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
    const values = attributes(match[1]);
    if (!values) return;
    if (!values.has("name")) return;
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
      }
    : undefined;

const sameReceipt = (
  value: ToolReceipt,
  results: ReadonlyMap<string, readonly CanonicalResult[]>,
) => {
  const matching = results.get(value.callId);
  const current = matching?.length === 1 ? matching[0] : undefined;
  if (!current?.valid) return false;
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
  private omissions = 0;
  private readonly pending = new Map<string, Candidate>();
  private readonly manifests = new Map<string, Manifest>();
  private readonly declarations = new Map<string, ScriptDeclaration>();
  private readonly scriptReads = new Map<string, ScriptRead>();
  private readonly listings = new Map<string, Listing>();
  private readonly fileMappings = new Map<
    string,
    { resourceKey: string; itemKey: string; listingDigest: string }
  >();

  start(input: CoverageToolStart, epoch: number) {
    if (!this.acceptsEpoch(epoch) || !safeText(input.toolCallId, 512)) return;
    if (this.pending.has(input.toolCallId)) return;
    const candidate = this.candidate(input);
    if (!candidate) return;
    if (this.pending.size >= MAX_PENDING || !this.fitsAdditional(candidate)) {
      this.omissions++;
      return;
    }
    this.pending.set(input.toolCallId, candidate);
  }

  end(input: CoverageToolEnd, epoch: number) {
    if (epoch !== this.epoch) return;
    const candidate = this.pending.get(input.toolCallId);
    if (!candidate || candidate.toolName !== input.toolName) return;
    candidate.ended = true;
  }

  confirm(entries: readonly unknown[], epoch: number): CoverageAdapterResult {
    if (epoch !== this.epoch) return this.result();
    const results = canonicalResults(entries);
    this.revalidate(results);
    const accepted: CoverageAdapterResult = {
      inventories: [],
      access: [],
      omissions: this.omissions,
    };
    for (const [callId, candidate] of [...this.pending]) {
      if (!candidate.ended) continue;
      const matching = results.get(callId);
      if (!matching?.length) continue; // preappend: terminal listener has no canonical result yet.
      this.pending.delete(callId);
      const current = matching.length === 1 ? matching[0] : undefined;
      if (!current?.valid || current.toolName !== candidate.toolName) {
        this.omissions++;
        continue;
      }
      this.accept(candidate, current, accepted);
    }
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

  reset(epoch: number) {
    this.epoch = epoch;
    this.omissions = 0;
    this.pending.clear();
    this.manifests.clear();
    this.declarations.clear();
    this.scriptReads.clear();
    this.listings.clear();
    this.fileMappings.clear();
  }

  private acceptsEpoch(epoch: number) {
    if (!Number.isSafeInteger(epoch) || epoch < 0) return false;
    if (this.epoch === undefined) this.epoch = epoch;
    return this.epoch === epoch;
  }

  private candidate(input: CoverageToolStart): Candidate | undefined {
    if (input.toolName === "bash") {
      const resourcePath = manifestCommand(input.args);
      if (resourcePath)
        return {
          kind: "manifest",
          callId: input.toolCallId,
          toolName: "bash",
          resourcePath,
          ended: false,
        };
      const listing = listingCommand(input.args);
      if (listing)
        return {
          kind: "listing",
          callId: input.toolCallId,
          toolName: "bash",
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
      const args = record(input.args) ? input.args : undefined;
      const scriptPath = repoPath(args?.path);
      if (!scriptPath || typeof args?.content !== "string") return;
      if (Buffer.byteLength(args.content, "utf8") > MAX_PAYLOAD_BYTES) return;
      return {
        kind: "script-write",
        callId: input.toolCallId,
        toolName: input.toolName,
        scriptPath,
        contentDigest: sha256(args.content),
        ended: false,
      };
    }
    if (input.toolName === "read") {
      const args = record(input.args) ? input.args : undefined;
      const scriptPath = repoPath(args?.path);
      return scriptPath
        ? {
            kind: "script-read",
            callId: input.toolCallId,
            toolName: "read",
            scriptPath,
            ended: false,
          }
        : undefined;
    }
  }

  private accept(
    candidate: Candidate,
    result: CanonicalResult,
    accepted: CoverageAdapterResult,
  ) {
    if (candidate.kind === "manifest") {
      const names = result.content ? manifestNames(result.content) : undefined;
      if (!names) return this.omit();
      const resourceKey = sha256(candidate.resourcePath);
      const prior = this.manifests.get(candidate.resourcePath);
      const nextReceipt = receipt(result, [
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
      const prior = this.declarations.get(candidate.scriptPath);
      const nextReceipt = receipt(result, [
        "worksheet-extraction-list/v1",
        candidate.scriptPath,
        candidate.contentDigest,
      ]);
      if (!nextReceipt) return this.omit();
      const next: ScriptDeclaration = {
        ...nextReceipt,
        scriptPath: candidate.scriptPath,
        contentDigest: candidate.contentDigest,
      };
      if (
        (!prior && this.declarations.size >= MAX_RETAINED_RECEIPTS) ||
        !this.fitsReplacement(prior, next)
      )
        return this.omit();
      this.declarations.set(candidate.scriptPath, next);
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
        sha256(result.content) !== declaration.contentDigest
      )
        return this.omit();
      const prior = this.scriptReads.get(candidate.scriptPath);
      const nextReceipt = receipt(result, [
        "worksheet-extraction-list/v1",
        candidate.scriptPath,
        declaration.bindingDigest,
      ]);
      if (!nextReceipt) return this.omit();
      const next: ScriptRead = {
        ...nextReceipt,
        scriptPath: candidate.scriptPath,
        declarationDigest: declaration.bindingDigest,
      };
      if (
        (!prior && this.scriptReads.size >= MAX_RETAINED_RECEIPTS) ||
        !this.fitsReplacement(prior, next)
      )
        return this.omit();
      this.scriptReads.set(candidate.scriptPath, next);
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
        scriptRead.declarationDigest !== declaration.bindingDigest
      )
        return this.omit();
      const files = result.content
        ? listingRecords(result.content, manifest)
        : undefined;
      if (!files) return this.omit();
      const prior = this.listings.get(candidate.resourcePath);
      const currentMappings = this.mappingCount() - (prior?.files.length ?? 0);
      const nextReceipt = receipt(result, [
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
        return this.omit();
      const next: Listing = {
        ...nextReceipt,
        resourcePath: candidate.resourcePath,
        scriptPath: candidate.scriptPath,
        manifestDigest: manifest.bindingDigest,
        scriptReadDigest: scriptRead.bindingDigest,
        files,
      };
      if (!this.fitsReplacement(prior, next)) return this.omit();
      this.listings.set(candidate.resourcePath, next);
      this.rebuildMappings();
      accepted.access.push({
        resourceKey: manifest.resourceKey,
        itemKeys: files.map((file) => file.itemKey),
      });
      return;
    }
    const listing = [...this.listings.values()].find(
      (item) => item.bindingDigest === candidate.activity.listingDigest,
    );
    if (
      !listing ||
      !candidate.activity.files.every((path, index) => {
        const mapping = this.fileMappings.get(path);
        return (
          mapping?.resourceKey === candidate.activity.resourceKey &&
          mapping.listingDigest === candidate.activity.listingDigest &&
          mapping.itemKey === candidate.activity.itemKeys[index]
        );
      })
    )
      return this.omit();
    accepted.access.push({
      resourceKey: candidate.activity.resourceKey,
      itemKeys: [...candidate.activity.itemKeys],
    });
  }

  private revalidate(results: ReadonlyMap<string, readonly CanonicalResult[]>) {
    for (const [path, manifest] of this.manifests)
      if (!sameReceipt(manifest, results)) this.manifests.delete(path);
    for (const [path, declaration] of this.declarations)
      if (!sameReceipt(declaration, results)) this.declarations.delete(path);
    for (const [path, scriptRead] of this.scriptReads) {
      const declaration = this.declarations.get(path);
      if (
        !sameReceipt(scriptRead, results) ||
        !declaration ||
        scriptRead.declarationDigest !== declaration.bindingDigest
      )
        this.scriptReads.delete(path);
    }
    for (const [resourcePath, listing] of this.listings) {
      const manifest = this.manifests.get(resourcePath);
      const scriptRead = this.scriptReads.get(listing.scriptPath);
      if (
        !sameReceipt(listing, results) ||
        !manifest ||
        !scriptRead ||
        listing.manifestDigest !== manifest.bindingDigest ||
        listing.scriptReadDigest !== scriptRead.bindingDigest
      )
        this.listings.delete(resourcePath);
    }
    this.rebuildMappings();
  }

  private rebuildMappings() {
    this.fileMappings.clear();
    for (const listing of this.listings.values()) {
      const manifest = this.manifests.get(listing.resourcePath);
      if (!manifest) continue;
      for (const file of listing.files)
        this.fileMappings.set(file.path, {
          resourceKey: manifest.resourceKey,
          itemKey: file.itemKey,
          listingDigest: listing.bindingDigest,
        });
    }
  }

  private mappingCount() {
    return [...this.listings.values()].reduce(
      (count, listing) => count + listing.files.length,
      0,
    );
  }

  private metadataBytes() {
    return byteLength({
      pending: [...this.pending.values()],
      manifests: [...this.manifests.values()],
      declarations: [...this.declarations.values()],
      scriptReads: [...this.scriptReads.values()],
      listings: [...this.listings.values()],
    });
  }

  private fitsAdditional(value: unknown) {
    return this.metadataBytes() + byteLength(value) <= MAX_METADATA_BYTES;
  }

  private fitsReplacement(current: unknown, next: unknown) {
    return (
      this.metadataBytes() -
        (current === undefined ? 0 : byteLength(current)) +
        byteLength(next) <=
      MAX_METADATA_BYTES
    );
  }

  private omit() {
    this.omissions++;
  }

  private result(): CoverageAdapterResult {
    return { inventories: [], access: [], omissions: this.omissions };
  }
}
