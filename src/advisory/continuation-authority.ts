import { createHash } from "node:crypto";
import {
  type Cursor,
  type HybridTask,
  type MutationEvent,
  type Observation,
  type ObservationRef,
  type ObservationRole,
  type SourceRef,
  taskLabelIsValid,
} from "../core/hybrid-state";
import type { ReconciliationSettlement } from "./delivery";

const ADVISORY_CUSTOM_TYPE = "pi-progress-advisory";
const MAX_QUESTION_BYTES = 24 * 1024;
const MAX_CONTEXT_OBSERVATIONS = 16;
const MAX_CONTEXT_BYTES = 12 * 1024;
const MAX_INCLUDED_TASKS = 20;
const MAX_POLICY_BYTES = 8 * 1024;
const MAX_OUTPUT_BYTES = 24 * 1024;
const MAX_MODEL_BYTES = 4 * 1024;
const MAX_IDENTIFIER_BYTES = 12 * 1024;
const HASH_PLACEHOLDER = "0".repeat(64);
const SHA256 = /^[a-f0-9]{64}$/;
const observationRoles = new Set<ObservationRole>([
  "user",
  "assistant",
  "intercom",
]);
const taskKinds = new Set(["action", "response"]);
const taskBases = new Set(["explicit", "derived"]);
const taskStatuses = new Set(["not-started", "reopened", "done"]);

type ContinuationAuthorityReason =
  | "frontier"
  | "stale"
  | "authority"
  | "capacity"
  | "no-work";

type ContinuationAuthorityPolicy = {
  coverage: "complete";
  promptHash: string;
  text: string;
};

type ContinuationAuthorityTask = Pick<
  HybridTask,
  "id" | "label" | "kind" | "basis" | "status" | "included" | "revision"
> & { source: SourceRef };

export type ContinuationAuthorityBinding = Readonly<{
  receipt: ReconciliationSettlement;
  policy: unknown;
  originalRunId: number;
  sessionEpoch: number;
  branchEpoch: number;
  controlEpoch: number;
  model: string;
}>;

export type ContinuationAuthorityInput = ContinuationAuthorityBinding &
  Readonly<{
    branch: readonly unknown[];
    tasks: readonly HybridTask[];
    events: readonly MutationEvent[];
    ready: boolean;
    cursor?: Cursor;
  }>;

type ContinuationAuthorityUnavailable = {
  available: false;
  reason: ContinuationAuthorityReason;
};

type ContinuationAuthorityAvailable = {
  available: true;
  fingerprint: string;
  receipt: ReconciliationSettlement;
  tasks: ContinuationAuthorityTask[];
  context: Observation[];
  policy: ContinuationAuthorityPolicy;
  originalRunId: number;
  sessionEpoch: number;
  branchEpoch: number;
  controlEpoch: number;
  model: string;
};

export type ContinuationAuthorityProjection =
  | ContinuationAuthorityUnavailable
  | ContinuationAuthorityAvailable;

type RecordValue = Record<string, unknown>;

type Header = {
  id: string;
  role: ObservationRole;
  index: number;
  contentOwner: RecordValue;
};

type BranchIndex = {
  headers: Header[];
  byId: Map<string, Header>;
  duplicateCanonicalIds: Set<string>;
  entryIdCounts: Map<string, number>;
};

type ReceiptData = {
  receipt: ReconciliationSettlement;
  replyRefs: ObservationRef[];
};

type PolicyResult =
  | { kind: "complete"; policy: ContinuationAuthorityPolicy }
  | { kind: "authority" }
  | { kind: "capacity" };

type Materialized =
  | { kind: "observation"; observation: Observation; serializedBytes: number }
  | { kind: "empty" }
  | { kind: "capacity" };

type TaskHistory = {
  task: ContinuationAuthorityTask;
  create: {
    id: string;
    revision: number;
    source: ObservationRef;
    header: Header;
  };
};

const unavailable = (
  reason: ContinuationAuthorityReason,
): ContinuationAuthorityUnavailable => ({ available: false, reason });

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

const record = (value: unknown): value is RecordValue =>
  !!value && typeof value === "object" && !Array.isArray(value);

const exactKeys = (value: RecordValue, keys: readonly string[]) => {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
};

const safeInteger = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;

const boundedString = (
  value: unknown,
  limit = MAX_IDENTIFIER_BYTES,
): value is string =>
  typeof value === "string" && Buffer.byteLength(value, "utf8") <= limit;

const nonblankString = (
  value: unknown,
  limit = MAX_IDENTIFIER_BYTES,
): value is string => boundedString(value, limit) && !!value.trim();

const validHash = (value: unknown): value is string =>
  typeof value === "string" && SHA256.test(value);

const validRole = (value: unknown): value is ObservationRole =>
  typeof value === "string" && observationRoles.has(value as ObservationRole);

const copyRef = (reference: ObservationRef): ObservationRef => ({
  entryId: reference.entryId,
  messageHash: reference.messageHash,
  role: reference.role,
});

const copySource = (source: SourceRef): SourceRef => ({
  ...copyRef(source),
  start: source.start,
  end: source.end,
  quoteHash: source.quoteHash,
});

const sameRef = (left: ObservationRef, right: ObservationRef) =>
  left.entryId === right.entryId &&
  left.messageHash === right.messageHash &&
  left.role === right.role;

const sameCursor = (cursor: Cursor, reference: ObservationRef) =>
  cursor.id === reference.entryId &&
  cursor.hash === reference.messageHash &&
  cursor.role === reference.role;

const canonicalHeader = (entry: unknown, index: number): Header | undefined => {
  if (!record(entry)) return;
  const id = entry.id;
  // Match canonical intake here; output admission later rejects oversized IDs.
  if (typeof id !== "string" || !id) return;
  if (entry.type === "custom_message") {
    if (entry.customType !== "intercom_message") return;
    return { id, role: "intercom", index, contentOwner: entry };
  }
  if (entry.type !== "message" || !record(entry.message)) return;
  const message = entry.message;
  if (message.role !== "user" && message.role !== "assistant") return;
  if (message.stopReason === "error" || message.stopReason === "aborted")
    return;
  return { id, role: message.role, index, contentOwner: message };
};

const indexBranch = (branch: readonly unknown[]): BranchIndex => {
  const headers: Header[] = [];
  const byId = new Map<string, Header>();
  const duplicateCanonicalIds = new Set<string>();
  const entryIdCounts = new Map<string, number>();
  for (let index = 0; index < branch.length; index++) {
    const entry = branch[index];
    if (record(entry) && typeof entry.id === "string")
      entryIdCounts.set(entry.id, (entryIdCounts.get(entry.id) ?? 0) + 1);
    const header = canonicalHeader(entry, index);
    if (!header) continue;
    headers.push(header);
    if (byId.has(header.id)) duplicateCanonicalIds.add(header.id);
    else byId.set(header.id, header);
  }
  return { headers, byId, duplicateCanonicalIds, entryIdCounts };
};

const headerFor = (index: BranchIndex, entryId: string): Header | undefined =>
  index.duplicateCanonicalIds.has(entryId)
    ? undefined
    : index.byId.get(entryId);

const visibleText = (content: unknown): string | undefined | "capacity" => {
  if (typeof content === "string")
    return Buffer.byteLength(content, "utf8") <= MAX_CONTEXT_BYTES
      ? content
      : "capacity";
  if (!Array.isArray(content)) return;

  let text = "";
  let bytes = 0;
  for (const block of content) {
    if (
      !record(block) ||
      block.type !== "text" ||
      typeof block.text !== "string"
    )
      continue;
    const blockBytes = Buffer.byteLength(block.text, "utf8");
    if (bytes + blockBytes > MAX_CONTEXT_BYTES) return "capacity";
    bytes += blockBytes;
    text += block.text;
  }
  return text;
};

/** Later visible records fence a receipt without inspecting tool/thinking bodies. */
const potentiallyVisible = (content: unknown): boolean => {
  if (typeof content === "string") return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      record(block) &&
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.length > 0,
  );
};

const materialize = (header: Header): Materialized => {
  if (!boundedString(header.id, MAX_CONTEXT_BYTES)) return { kind: "capacity" };
  const text = visibleText(header.contentOwner.content);
  if (text === "capacity") return { kind: "capacity" };
  if (text === undefined || !text.trim()) return { kind: "empty" };
  const serializedBytes = Buffer.byteLength(
    JSON.stringify({
      id: header.id,
      role: header.role,
      text,
      hash: HASH_PLACEHOLDER,
    }),
    "utf8",
  );
  return {
    kind: "observation",
    observation: { id: header.id, role: header.role, text, hash: sha256(text) },
    serializedBytes,
  };
};

const validReceipt = (value: unknown): ReceiptData | undefined => {
  if (
    !record(value) ||
    !exactKeys(value, [
      "kind",
      "opportunityId",
      "sendId",
      "sessionEpoch",
      "branchEpoch",
      "replyRunId",
      "question",
      "replies",
    ])
  )
    return;
  if (
    value.kind !== "reconciliation" ||
    !nonblankString(value.opportunityId) ||
    !nonblankString(value.sendId) ||
    !safeInteger(value.sessionEpoch) ||
    !safeInteger(value.branchEpoch) ||
    !safeInteger(value.replyRunId, 1) ||
    !record(value.question) ||
    !exactKeys(value.question, ["entryId", "contentHash"]) ||
    !nonblankString(value.question.entryId) ||
    !validHash(value.question.contentHash) ||
    !Array.isArray(value.replies) ||
    value.replies.length === 0 ||
    value.replies.length > MAX_CONTEXT_OBSERVATIONS
  )
    return;

  const replyRefs: ObservationRef[] = [];
  const replyIds = new Set<string>();
  for (const reply of value.replies) {
    if (
      !record(reply) ||
      !exactKeys(reply, ["entryId", "messageHash", "role"]) ||
      !nonblankString(reply.entryId) ||
      !validHash(reply.messageHash) ||
      reply.role !== "assistant" ||
      replyIds.has(reply.entryId)
    )
      return;
    replyIds.add(reply.entryId);
    replyRefs.push({
      entryId: reply.entryId,
      messageHash: reply.messageHash,
      role: "assistant",
    });
  }

  return {
    receipt: {
      kind: "reconciliation",
      opportunityId: value.opportunityId,
      sendId: value.sendId,
      sessionEpoch: value.sessionEpoch,
      branchEpoch: value.branchEpoch,
      replyRunId: value.replyRunId,
      question: {
        entryId: value.question.entryId,
        contentHash: value.question.contentHash,
      },
      replies: replyRefs.map(copyRef),
    },
    replyRefs,
  };
};

const questionMatches = (
  entry: unknown,
  receipt: ReconciliationSettlement,
): boolean => {
  if (
    !record(entry) ||
    entry.type !== "custom_message" ||
    entry.id !== receipt.question.entryId ||
    entry.customType !== ADVISORY_CUSTOM_TYPE ||
    typeof entry.content !== "string" ||
    Buffer.byteLength(entry.content, "utf8") > MAX_QUESTION_BYTES ||
    !record(entry.details) ||
    !exactKeys(entry.details, ["kind", "opportunityId", "sendId"])
  )
    return false;
  return (
    entry.details.kind === "reconciliation" &&
    entry.details.opportunityId === receipt.opportunityId &&
    entry.details.sendId === receipt.sendId &&
    sha256(entry.content) === receipt.question.contentHash
  );
};

const validCursor = (value: unknown): value is Cursor =>
  record(value) &&
  exactKeys(value, ["id", "hash", "role"]) &&
  nonblankString(value.id) &&
  validHash(value.hash) &&
  validRole(value.role);

const policyFor = (value: unknown): PolicyResult => {
  if (!record(value)) return { kind: "authority" };
  if (exactKeys(value, ["coverage"]) && value.coverage === "unknown")
    return { kind: "authority" };
  if (
    !exactKeys(value, ["coverage", "promptHash", "text"]) ||
    value.coverage !== "complete" ||
    !validHash(value.promptHash) ||
    typeof value.text !== "string"
  )
    return { kind: "authority" };
  if (Buffer.byteLength(value.text, "utf8") > MAX_POLICY_BYTES)
    return { kind: "capacity" };
  if (!value.text.trim()) return { kind: "authority" };
  const policy: ContinuationAuthorityPolicy = {
    coverage: "complete",
    promptHash: value.promptHash,
    text: value.text,
  };
  if (Buffer.byteLength(JSON.stringify(policy), "utf8") > MAX_POLICY_BYTES)
    return { kind: "capacity" };
  return sha256(policy.text) === policy.promptHash
    ? { kind: "complete", policy }
    : { kind: "authority" };
};

const validSourceShape = (value: unknown): value is SourceRef =>
  record(value) &&
  exactKeys(value, [
    "entryId",
    "messageHash",
    "role",
    "start",
    "end",
    "quoteHash",
  ]) &&
  nonblankString(value.entryId) &&
  validHash(value.messageHash) &&
  validRole(value.role) &&
  safeInteger(value.start) &&
  safeInteger(value.end) &&
  value.end > value.start &&
  validHash(value.quoteHash);

const validReferenceShape = (value: unknown): value is ObservationRef =>
  record(value) &&
  exactKeys(value, ["entryId", "messageHash", "role"]) &&
  nonblankString(value.entryId) &&
  validHash(value.messageHash) &&
  validRole(value.role);

const copyTask = (task: HybridTask): ContinuationAuthorityTask => ({
  id: task.id,
  label: task.label,
  kind: task.kind,
  basis: task.basis,
  status: task.status,
  included: true,
  revision: task.revision,
  source: copySource(task.source),
});

const validTask = (value: unknown): value is HybridTask =>
  record(value) &&
  nonblankString(value.id) &&
  boundedString(value.label) &&
  taskLabelIsValid(value.label) &&
  typeof value.kind === "string" &&
  taskKinds.has(value.kind) &&
  typeof value.basis === "string" &&
  taskBases.has(value.basis) &&
  typeof value.status === "string" &&
  taskStatuses.has(value.status) &&
  typeof value.included === "boolean" &&
  safeInteger(value.revision) &&
  validSourceShape(value.source);

const sourceHeader = (
  index: BranchIndex,
  source: ObservationRef,
): Header | undefined => {
  const header = headerFor(index, source.entryId);
  return header && header.role === source.role ? header : undefined;
};

const currentSourceMatches = (
  source: SourceRef,
  observation: Observation | undefined,
): boolean => {
  if (
    !observation ||
    observation.hash !== source.messageHash ||
    observation.role !== source.role ||
    source.end > observation.text.length
  )
    return false;
  const quote = observation.text.slice(source.start, source.end);
  return !!quote && sha256(quote) === source.quoteHash;
};

const eventCreateFor = (
  events: readonly MutationEvent[],
  taskId: string,
): { id: string; revision: number; source: ObservationRef } | undefined => {
  let create:
    | { id: string; revision: number; source: ObservationRef }
    | undefined;
  for (const event of events) {
    if (!record(event) || event.kind !== "create" || event.taskId !== taskId)
      continue;
    if (
      create ||
      !nonblankString(event.id) ||
      !safeInteger(event.revision) ||
      !validReferenceShape(event.source)
    )
      return;
    create = {
      id: event.id,
      revision: event.revision,
      source: copyRef(event.source),
    };
  }
  return create;
};

const canonicalUserBefore = (
  headers: readonly Header[],
  before: number,
): Header | "capacity" | undefined => {
  for (const header of headers) {
    if (header.index >= before) break;
    if (header.role !== "user") continue;
    const observed = materialize(header);
    if (observed.kind === "capacity") return "capacity";
    if (observed.kind === "observation") return header;
  }
  return;
};

const lastVisibleAfter = (headers: readonly Header[], after: number): boolean =>
  headers.some(
    (header) =>
      header.index > after && potentiallyVisible(header.contentOwner.content),
  );

/**
 * Project complete current canonical evidence. Availability means bounded,
 * current provenance only; it never establishes permission to continue work.
 */
export const projectContinuationAuthority = (
  input: ContinuationAuthorityInput,
): ContinuationAuthorityProjection => {
  try {
    const receiptData = validReceipt(input?.receipt);
    if (
      !receiptData ||
      !Array.isArray(input?.branch) ||
      !Array.isArray(input?.tasks) ||
      !Array.isArray(input?.events) ||
      !safeInteger(input?.sessionEpoch) ||
      !safeInteger(input?.branchEpoch) ||
      !safeInteger(input?.controlEpoch) ||
      !safeInteger(input?.originalRunId) ||
      !nonblankString(input?.model, MAX_MODEL_BYTES) ||
      receiptData?.receipt.sessionEpoch !== input.sessionEpoch ||
      receiptData?.receipt.branchEpoch !== input.branchEpoch
    )
      return unavailable("stale");

    const branch = indexBranch(input.branch);
    const receipt = receiptData.receipt;
    if (
      branch.entryIdCounts.get(receipt.question.entryId) !== 1 ||
      !questionMatches(
        input.branch.find(
          (entry) => record(entry) && entry.id === receipt.question.entryId,
        ),
        receipt,
      )
    )
      return unavailable("stale");
    const questionIndex = input.branch.findIndex(
      (entry) => record(entry) && entry.id === receipt.question.entryId,
    );

    const replyHeaders: Header[] = [];
    let previousIndex = questionIndex;
    for (const reference of receiptData.replyRefs) {
      if (branch.entryIdCounts.get(reference.entryId) !== 1)
        return unavailable("stale");
      const header = sourceHeader(branch, reference);
      if (!header) return unavailable("stale");
      if (
        header.role !== "assistant" ||
        header.index <= previousIndex ||
        header.contentOwner.stopReason !== "stop"
      )
        return unavailable("stale");
      previousIndex = header.index;
      replyHeaders.push(header);
    }
    const lastReply = replyHeaders.at(-1);
    const finalReplyReference = receiptData.replyRefs.at(-1);
    if (!lastReply || !finalReplyReference) return unavailable("stale");
    if (lastVisibleAfter(branch.headers, lastReply.index))
      return unavailable("stale");

    if (
      input.ready !== true ||
      !validCursor(input.cursor) ||
      !sameCursor(input.cursor, finalReplyReference)
    )
      return unavailable("frontier");

    const policy = policyFor(input.policy);
    if (policy.kind === "capacity") return unavailable("capacity");
    if (policy.kind !== "complete") return unavailable("authority");

    const included: HybridTask[] = [];
    for (const task of input.tasks) {
      if (!record(task) || typeof task.included !== "boolean")
        return unavailable("authority");
      if (!task.included) continue;
      if (included.length >= MAX_INCLUDED_TASKS) return unavailable("capacity");
      if (!validTask(task)) return unavailable("authority");
      included.push(task);
    }
    if (!included.length || !included.some((task) => task.status !== "done"))
      return unavailable("no-work");

    const taskIds = new Set<string>();
    const histories: TaskHistory[] = [];
    for (const task of included) {
      if (taskIds.has(task.id)) return unavailable("authority");
      taskIds.add(task.id);
      const create = eventCreateFor(input.events, task.id);
      if (!create) return unavailable("authority");
      const createHeader = sourceHeader(branch, create.source);
      const taskSourceHeader = sourceHeader(branch, task.source);
      if (!createHeader || !taskSourceHeader) return unavailable("authority");
      if (taskSourceHeader.index < createHeader.index)
        return unavailable("authority");
      histories.push({
        task: copyTask(task),
        create: { ...create, header: createHeader },
      });
    }

    let firstIndex = Math.min(
      ...histories.map((history) => history.create.header.index),
    );
    for (const history of histories) {
      if (
        history.create.header.role !== "assistant" &&
        history.create.header.role !== "intercom"
      )
        continue;
      const user = canonicalUserBefore(
        branch.headers,
        history.create.header.index,
      );
      if (user === "capacity") return unavailable("capacity");
      if (!user) return unavailable("authority");
      firstIndex = Math.min(firstIndex, user.index);
    }

    if (branch.duplicateCanonicalIds.size) {
      const ambiguous = branch.headers.some(
        (header) =>
          header.index >= firstIndex &&
          header.index <= lastReply.index &&
          branch.duplicateCanonicalIds.has(header.id),
      );
      if (ambiguous) return unavailable("authority");
    }

    const context: Observation[] = [];
    const observations = new Map<string, Observation>();
    let contextBytes = 2;
    for (const header of branch.headers) {
      if (header.index < firstIndex || header.index > lastReply.index) continue;
      const observed = materialize(header);
      if (observed.kind === "capacity") return unavailable("capacity");
      if (observed.kind === "empty") continue;
      if (
        context.length >= MAX_CONTEXT_OBSERVATIONS ||
        contextBytes + (context.length ? 1 : 0) + observed.serializedBytes >
          MAX_CONTEXT_BYTES
      )
        return unavailable("capacity");
      contextBytes += (context.length ? 1 : 0) + observed.serializedBytes;
      const copy = { ...observed.observation };
      context.push(copy);
      observations.set(copy.id, copy);
    }

    for (let index = 0; index < histories.length; index++) {
      const history = histories[index];
      if (!history) return unavailable("authority");
      const createObservation = observations.get(history.create.source.entryId);
      const sourceObservation = observations.get(history.task.source.entryId);
      if (
        !createObservation ||
        !sameRef(history.create.source, {
          entryId: createObservation.id,
          messageHash: createObservation.hash,
          role: createObservation.role,
        }) ||
        !currentSourceMatches(history.task.source, sourceObservation)
      )
        return unavailable("authority");
    }

    for (const reference of receiptData.replyRefs) {
      const observation = observations.get(reference.entryId);
      if (
        !observation ||
        !sameRef(reference, {
          entryId: observation.id,
          messageHash: observation.hash,
          role: observation.role,
        })
      )
        return unavailable("stale");
    }

    const receiptCopy: ReconciliationSettlement = {
      ...receipt,
      question: { ...receipt.question },
      replies: receipt.replies.map(copyRef),
    };
    const policyCopy = { ...policy.policy };
    const tasks = histories.map((history) => ({
      ...history.task,
      source: copySource(history.task.source),
    }));
    const output = {
      available: true as const,
      fingerprint: HASH_PLACEHOLDER,
      receipt: receiptCopy,
      tasks,
      context,
      policy: policyCopy,
      originalRunId: input.originalRunId,
      sessionEpoch: input.sessionEpoch,
      branchEpoch: input.branchEpoch,
      controlEpoch: input.controlEpoch,
      model: input.model,
    };
    if (Buffer.byteLength(JSON.stringify(output), "utf8") > MAX_OUTPUT_BYTES)
      return unavailable("capacity");

    const fingerprint = sha256(
      JSON.stringify({
        receipt: receiptCopy,
        tasks,
        context,
        policy: policyCopy,
        originalRunId: input.originalRunId,
        sessionEpoch: input.sessionEpoch,
        branchEpoch: input.branchEpoch,
        controlEpoch: input.controlEpoch,
        model: input.model,
        cursor: { ...input.cursor },
        provenance: histories.map((history) => ({
          taskId: history.task.id,
          create: {
            id: history.create.id,
            revision: history.create.revision,
            source: history.create.source,
          },
          source: history.task.source,
        })),
      }),
    );
    return { ...output, fingerprint };
  } catch {
    return unavailable("authority");
  }
};
