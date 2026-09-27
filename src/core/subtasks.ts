import { createHash } from "node:crypto";
import type { Assessment, HybridTask, SourceRef } from "./hybrid-state";

const MAX_ACTIVE_CHILDREN = 64;
const MAX_RETAINED_CHILDREN = 200;
const MAX_GROUPS = 200;
const MAX_LABEL_SCALARS = 240;
const MAX_ADMISSION_BYTES = 32 * 1024;
const MAX_SUBTASK_CHECKPOINT_BYTES = 64 * 1024;
const CHECKPOINT_VERSION = 1;
const MAX_OMISSIONS = 2;
const MAX_OMISSION_SCALARS = 512;
const MAX_NUMERIC_ID_CODE_UNITS = 32;

const digest = /^[a-f0-9]{64}$/;
const taskId = /^task:[1-9]\d*$/;
const groupId = /^subtask-group:([1-9]\d*)$/;
const childId = /^subtask-child:([1-9]\d*)$/;
const controlCharacter = /[\p{Cc}\p{Cf}]/u;
const whitespaceCharacter = /^\s$/u;

type AdmissionFailure = "invalid" | "capacity";
type SubtaskChildStatus = "pending" | "reported-completed" | "reported-blocked";

interface SubtaskProof {
  contextHash: string;
  gateRequestHash: string;
  proposalRequestHash: string;
}

export type SubtaskChildOperation =
  | { kind: "add"; label: string; source: SourceRef }
  | { kind: "retain"; id: string }
  | { kind: "reword"; id: string; label: string; source: SourceRef }
  | { kind: "replace"; id: string; label: string; source: SourceRef };

interface SubtaskRemoval {
  id: string;
  source: SourceRef;
  reason: "withdrawn" | "out-of-scope";
}

export interface SubtaskAdmission {
  parent: HybridTask;
  expectedListRevision: number;
  source: SourceRef;
  proof: SubtaskProof;
  children: SubtaskChildOperation[];
  removals: SubtaskRemoval[];
  complete: boolean;
  knownTotal?: number;
}

export type SubtaskAdmissionResult =
  | { accepted: true }
  | { accepted: false; reason: "invalid" | "capacity" | "stale" | "foreign" };

export interface SubtaskReport {
  groupId: string;
  listRevision: number;
  childIds: string[];
  source: SourceRef;
  status: SubtaskChildStatus;
}

export type SubtaskReportResult =
  | { accepted: true }
  | { accepted: false; reason: "invalid" | "stale" | "foreign" };

export interface SubtaskChildSnapshot {
  id: string;
  label: string;
  status: SubtaskChildStatus;
  source: SourceRef;
}

interface SubtaskRetiredChildSnapshot extends SubtaskChildSnapshot {
  retirement: {
    source: SourceRef;
    reason: "replaced" | "withdrawn" | "out-of-scope";
  };
}

interface SubtaskGroupSnapshot {
  id: string;
  parentTaskId: string;
  parentRevision: number;
  parentSourceDigest: string;
  listRevision: number;
  source: SourceRef;
  proof: SubtaskProof;
  complete: boolean;
  knownTotal?: number;
  children: SubtaskChildSnapshot[];
  retired: SubtaskRetiredChildSnapshot[];
  omissions: string[];
}

export interface SubtaskSnapshot {
  groups: SubtaskGroupSnapshot[];
}

interface SubtaskReportReceipt {
  status: SubtaskChildStatus;
  source: SourceRef;
}

interface SubtaskCheckpointReport extends SubtaskReportReceipt {
  childId: string;
}

interface SubtaskCheckpointGroup extends SubtaskGroupSnapshot {
  latestAdmissionDigest: string;
  reports: SubtaskCheckpointReport[];
}

export interface SubtaskCheckpoint {
  version: typeof CHECKPOINT_VERSION;
  nextGroupId: number;
  nextChildId: number;
  groups: SubtaskCheckpointGroup[];
}

export interface SubtaskRestoreOptions {
  parents: readonly HybridTask[];
  sourceCurrent: (source: SourceRef) => boolean;
}

interface SubtaskGroup extends SubtaskGroupSnapshot {
  included: boolean;
  /** SHA-256 of exact latest validated admission, never raw proposal data. */
  latestAdmissionDigest: string;
  /** Latest report or explicit retraction receipt for active and retired IDs. */
  reportReceipts: Map<string, SubtaskReportReceipt>;
}

interface ParentAuthority {
  revision: number;
  included: boolean;
  /** Current parent source fence; immutable group provenance stays untouched. */
  sourceDigest: string;
}

const plainDataRecord = (value: unknown): value is Record<string, unknown> => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => "value" in descriptor && descriptor.enumerable,
  );
};

const hasExactKeys = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> => {
  if (!plainDataRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  return (
    keys.length >= required.length &&
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => typeof key === "string" && allowed.has(key))
  );
};

const densePlainArray = (
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): value is unknown[] => {
  if (!Array.isArray(value)) return false;
  // Read length before any element descriptor so oversized input never invokes
  // an indexed getter through later validation.
  if (value.length < minimumLength || value.length > maximumLength)
    return false;
  if (Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length"))
    return false;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      return false;
  }
  return true;
};

const operationArrayValidity = (value: unknown): "valid" | AdmissionFailure => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return "invalid";
  if (value.length > MAX_ACTIVE_CHILDREN) return "capacity";
  return densePlainArray(value, 0, MAX_ACTIVE_CHILDREN) ? "valid" : "invalid";
};

const numericIdIsValid = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" &&
  value.length <= MAX_NUMERIC_ID_CODE_UNITS &&
  pattern.test(value);

const validHash = (value: unknown): value is string =>
  typeof value === "string" && value.length === 64 && digest.test(value);

const textWithinScalarLimit = (value: unknown, limit: number): boolean => {
  if (typeof value !== "string" || !value.length) return false;
  let scalars = 0;
  let nonblank = false;
  for (let index = 0; index < value.length; ) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const trail = value.charCodeAt(index + 1);
      if (!(trail >= 0xdc00 && trail <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) return false;
    const character = String.fromCodePoint(codePoint);
    if (controlCharacter.test(character)) return false;
    scalars += 1;
    if (scalars > limit) return false;
    if (!whitespaceCharacter.test(character)) nonblank = true;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return nonblank;
};

const validText = (value: unknown, maxLength: number): value is string =>
  textWithinScalarLimit(value, maxLength);

const labelValidity = (value: unknown): "valid" | AdmissionFailure => {
  if (typeof value !== "string" || !value.length) return "invalid";
  let scalars = 0;
  let nonblank = false;
  for (let index = 0; index < value.length; ) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const trail = value.charCodeAt(index + 1);
      if (!(trail >= 0xdc00 && trail <= 0xdfff)) return "invalid";
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return "invalid";
    }
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) return "invalid";
    const character = String.fromCodePoint(codePoint);
    if (controlCharacter.test(character)) return "invalid";
    scalars += 1;
    if (scalars > MAX_LABEL_SCALARS) return "capacity";
    if (!whitespaceCharacter.test(character)) nonblank = true;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return nonblank ? "valid" : "invalid";
};

const positiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1;

const nonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const safeIncrement = (value: number, increment = 1) =>
  Number.isSafeInteger(value + increment);

const validRole = (value: unknown) =>
  value === "user" || value === "assistant" || value === "intercom";

const unit = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;

const validObservationRef = (value: unknown) =>
  hasExactKeys(value, ["entryId", "messageHash", "role"]) &&
  validText(value.entryId, 512) &&
  validHash(value.messageHash) &&
  validRole(value.role);

const validSourceRef = (value: unknown): value is SourceRef =>
  hasExactKeys(value, [
    "entryId",
    "messageHash",
    "role",
    "start",
    "end",
    "quoteHash",
  ]) &&
  validText(value.entryId, 512) &&
  validHash(value.messageHash) &&
  validRole(value.role) &&
  nonNegativeInteger(value.start) &&
  positiveInteger(value.end) &&
  value.end > value.start &&
  validHash(value.quoteHash);

const validAssessment = (value: unknown) =>
  hasExactKeys(value, [
    "rawChoice",
    "confidence",
    "probability",
    "reason",
    "source",
  ]) &&
  (value.rawChoice === "changed" ||
    value.rawChoice === "unchanged" ||
    value.rawChoice === "uncertain" ||
    value.rawChoice === "none" ||
    value.rawChoice === "concurrent" ||
    value.rawChoice === "yes" ||
    value.rawChoice === "no" ||
    value.rawChoice === "invalid" ||
    numericIdIsValid(value.rawChoice, taskId)) &&
  unit(value.confidence) &&
  unit(value.probability) &&
  (value.reason === "accepted" ||
    value.reason === "semantic-unknown" ||
    value.reason === "threshold-abstention") &&
  validObservationRef(value.source);

/** Full HybridTask shape prevents extra transport payloads entering reducer state. */
const validParent = (value: unknown): value is HybridTask =>
  hasExactKeys(
    value,
    [
      "id",
      "label",
      "kind",
      "basis",
      "status",
      "included",
      "revision",
      "source",
    ],
    ["latestAssessment"],
  ) &&
  numericIdIsValid(value.id, taskId) &&
  labelValidity(value.label) === "valid" &&
  (value.kind === "action" || value.kind === "response") &&
  (value.basis === "explicit" || value.basis === "derived") &&
  (value.status === "not-started" ||
    value.status === "reopened" ||
    value.status === "done") &&
  typeof value.included === "boolean" &&
  positiveInteger(value.revision) &&
  validSourceRef(value.source) &&
  (!Object.hasOwn(value, "latestAssessment") ||
    validAssessment(value.latestAssessment));

const validProof = (value: unknown): value is SubtaskProof =>
  hasExactKeys(value, [
    "contextHash",
    "gateRequestHash",
    "proposalRequestHash",
  ]) &&
  validHash(value.contextHash) &&
  validHash(value.gateRequestHash) &&
  validHash(value.proposalRequestHash);

const validChildId = (value: unknown): value is string =>
  numericIdIsValid(value, childId);

const childOperationValidity = (value: unknown): "valid" | AdmissionFailure => {
  if (!plainDataRecord(value)) return "invalid";
  const kind = value.kind;
  switch (kind) {
    case "add":
      if (!hasExactKeys(value, ["kind", "label", "source"])) return "invalid";
      return !validSourceRef(value.source)
        ? "invalid"
        : labelValidity(value.label);
    case "retain":
      return hasExactKeys(value, ["kind", "id"]) && validChildId(value.id)
        ? "valid"
        : "invalid";
    case "reword":
    case "replace":
      if (
        !hasExactKeys(value, ["kind", "id", "label", "source"]) ||
        !validChildId(value.id) ||
        !validSourceRef(value.source)
      )
        return "invalid";
      return labelValidity(value.label);
    default:
      return "invalid";
  }
};

const validRemoval = (value: unknown): value is SubtaskRemoval =>
  hasExactKeys(value, ["id", "source", "reason"]) &&
  validChildId(value.id) &&
  validSourceRef(value.source) &&
  (value.reason === "withdrawn" || value.reason === "out-of-scope");

const admissionValidity = (value: unknown): "valid" | AdmissionFailure => {
  if (
    !hasExactKeys(
      value,
      [
        "parent",
        "expectedListRevision",
        "source",
        "proof",
        "children",
        "removals",
        "complete",
      ],
      ["knownTotal"],
    )
  )
    return "invalid";

  const children = value.children;
  const childrenValidity = operationArrayValidity(children);
  if (childrenValidity !== "valid" || !Array.isArray(children))
    return childrenValidity;
  const removals = value.removals;
  const removalsValidity = operationArrayValidity(removals);
  if (removalsValidity !== "valid" || !Array.isArray(removals))
    return removalsValidity;

  if (
    !validParent(value.parent) ||
    !nonNegativeInteger(value.expectedListRevision) ||
    !validSourceRef(value.source) ||
    !validProof(value.proof) ||
    typeof value.complete !== "boolean" ||
    (Object.hasOwn(value, "knownTotal") &&
      (!nonNegativeInteger(value.knownTotal) || value.knownTotal === undefined))
  )
    return "invalid";

  for (let index = 0; index < children.length; index += 1) {
    const validity = childOperationValidity(children[index]);
    if (validity !== "valid") return validity;
  }
  for (let index = 0; index < removals.length; index += 1) {
    if (!validRemoval(removals[index])) return "invalid";
  }
  return "valid";
};

const reportValidity = (value: unknown): value is SubtaskReport => {
  if (
    !hasExactKeys(value, [
      "groupId",
      "listRevision",
      "childIds",
      "source",
      "status",
    ]) ||
    !densePlainArray(value.childIds, 1, MAX_ACTIVE_CHILDREN)
  )
    return false;
  if (
    !numericIdIsValid(value.groupId, groupId) ||
    !positiveInteger(value.listRevision) ||
    !validSourceRef(value.source) ||
    !statusIsValid(value.status)
  )
    return false;
  for (let index = 0; index < value.childIds.length; index += 1) {
    if (!validChildId(value.childIds[index])) return false;
  }
  return true;
};

const statusIsValid = (value: unknown): value is SubtaskChildStatus =>
  value === "pending" ||
  value === "reported-completed" ||
  value === "reported-blocked";

const cloneSource = (source: SourceRef): SourceRef => ({
  entryId: source.entryId,
  messageHash: source.messageHash,
  role: source.role,
  start: source.start,
  end: source.end,
  quoteHash: source.quoteHash,
});

const cloneProof = (proof: SubtaskProof): SubtaskProof => ({
  contextHash: proof.contextHash,
  gateRequestHash: proof.gateRequestHash,
  proposalRequestHash: proof.proposalRequestHash,
});

const cloneAssessment = (assessment: Assessment): Assessment => ({
  rawChoice: assessment.rawChoice,
  confidence: assessment.confidence,
  probability: assessment.probability,
  reason: assessment.reason,
  source: {
    entryId: assessment.source.entryId,
    messageHash: assessment.source.messageHash,
    role: assessment.source.role,
  },
});

const cloneParent = (parent: HybridTask): HybridTask => ({
  id: parent.id,
  label: parent.label,
  kind: parent.kind,
  basis: parent.basis,
  status: parent.status,
  included: parent.included,
  revision: parent.revision,
  source: cloneSource(parent.source),
  ...(parent.latestAssessment === undefined
    ? {}
    : { latestAssessment: cloneAssessment(parent.latestAssessment) }),
});

const cloneChild = (child: SubtaskChildSnapshot): SubtaskChildSnapshot => ({
  id: child.id,
  label: child.label,
  status: child.status,
  source: cloneSource(child.source),
});

const cloneRetiredChild = (
  child: SubtaskRetiredChildSnapshot,
): SubtaskRetiredChildSnapshot => ({
  ...cloneChild(child),
  retirement: {
    reason: child.retirement.reason,
    source: cloneSource(child.retirement.source),
  },
});

const cloneGroupSnapshot = (
  group: SubtaskGroupSnapshot,
): SubtaskGroupSnapshot => ({
  id: group.id,
  parentTaskId: group.parentTaskId,
  parentRevision: group.parentRevision,
  parentSourceDigest: group.parentSourceDigest,
  listRevision: group.listRevision,
  source: cloneSource(group.source),
  proof: cloneProof(group.proof),
  complete: group.complete,
  ...(group.knownTotal === undefined ? {} : { knownTotal: group.knownTotal }),
  children: group.children.map(cloneChild),
  retired: group.retired.map(cloneRetiredChild),
  omissions: [...group.omissions],
});

const cloneSubtaskCheckpoint = (
  checkpoint: SubtaskCheckpoint,
): SubtaskCheckpoint => ({
  version: checkpoint.version,
  nextGroupId: checkpoint.nextGroupId,
  nextChildId: checkpoint.nextChildId,
  groups: checkpoint.groups.map((group) => ({
    id: group.id,
    parentTaskId: group.parentTaskId,
    parentRevision: group.parentRevision,
    parentSourceDigest: group.parentSourceDigest,
    listRevision: group.listRevision,
    source: cloneSource(group.source),
    proof: cloneProof(group.proof),
    complete: group.complete,
    ...(group.knownTotal === undefined ? {} : { knownTotal: group.knownTotal }),
    children: group.children.map(cloneChild),
    retired: group.retired.map(cloneRetiredChild),
    omissions: [...group.omissions],
    latestAdmissionDigest: group.latestAdmissionDigest,
    reports: group.reports.map((report) => ({
      childId: report.childId,
      status: report.status,
      source: cloneSource(report.source),
    })),
  })),
});

const cloneAdmission = (input: SubtaskAdmission): SubtaskAdmission => ({
  parent: cloneParent(input.parent),
  expectedListRevision: input.expectedListRevision,
  source: cloneSource(input.source),
  proof: cloneProof(input.proof),
  children: input.children.map((operation) => {
    switch (operation.kind) {
      case "add":
        return {
          kind: "add",
          label: operation.label,
          source: cloneSource(operation.source),
        };
      case "retain":
        return { kind: "retain", id: operation.id };
      case "reword":
        return {
          kind: "reword",
          id: operation.id,
          label: operation.label,
          source: cloneSource(operation.source),
        };
      case "replace":
        return {
          kind: "replace",
          id: operation.id,
          label: operation.label,
          source: cloneSource(operation.source),
        };
      default:
        throw new Error("Validated subtask operation is unsupported");
    }
  }),
  removals: input.removals.map((removal) => ({
    id: removal.id,
    source: cloneSource(removal.source),
    reason: removal.reason,
  })),
  complete: input.complete,
  ...(input.knownTotal === undefined ? {} : { knownTotal: input.knownTotal }),
});

/**
 * Build a JSON-only projection that cannot inherit ambient toJSON hooks.
 * Reducer clones stay ordinary arrays/records; only serialization needs masking.
 */
const inertSerializationProjection = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const projection: unknown[] = [];
    for (let index = 0; index < value.length; index += 1)
      projection.push(inertSerializationProjection(value[index]));
    Object.defineProperty(projection, "toJSON", {
      value: undefined,
      enumerable: false,
    });
    return projection;
  }
  if (value && typeof value === "object") {
    const projection = Object.create(null) as Record<string, unknown>;
    for (const [key, child] of Object.entries(value))
      projection[key] = inertSerializationProjection(child);
    return projection;
  }
  return value;
};

const inertJson = (value: object) =>
  JSON.stringify(inertSerializationProjection(value)) as string;

const parentSourceDigest = (source: SourceRef) =>
  createHash("sha256")
    .update(
      inertJson([
        source.entryId,
        source.messageHash,
        source.role,
        source.start,
        source.end,
        source.quoteHash,
      ]),
    )
    .digest("hex");

const omissionList = (
  complete: boolean,
  knownTotal: number | undefined,
  children: readonly SubtaskChildSnapshot[],
  retired: readonly SubtaskRetiredChildSnapshot[],
) => {
  const omissions: string[] = [];
  if (!complete) {
    omissions.push(
      knownTotal === undefined
        ? "Tracked decomposition is non-exhaustive"
        : `Tracked decomposition names ${children.length} of ${knownTotal} items`,
    );
  }
  if (retired.length) {
    omissions.push(
      `${retired.length} prior obligation${retired.length === 1 ? "" : "s"} retained as retired`,
    );
  }
  return omissions;
};

const sameSource = (left: SourceRef, right: SourceRef) =>
  left.entryId === right.entryId &&
  left.messageHash === right.messageHash &&
  left.role === right.role &&
  left.start === right.start &&
  left.end === right.end &&
  left.quoteHash === right.quoteHash;

const sameChild = (left: SubtaskChildSnapshot, right: SubtaskChildSnapshot) =>
  left.id === right.id &&
  left.label === right.label &&
  left.status === right.status &&
  sameSource(left.source, right.source);

const sameChildren = (
  left: readonly SubtaskChildSnapshot[],
  right: readonly SubtaskChildSnapshot[],
) =>
  left.length === right.length &&
  left.every((child, index) => sameChild(child, right[index]));

const sameRetiredChildren = (
  left: readonly SubtaskRetiredChildSnapshot[],
  right: readonly SubtaskRetiredChildSnapshot[],
) =>
  left.length === right.length &&
  left.every(
    (child, index) =>
      sameChild(child, right[index]) &&
      child.retirement.reason === right[index].retirement.reason &&
      sameSource(child.retirement.source, right[index].retirement.source),
  );

const admissionDigest = (input: SubtaskAdmission) =>
  createHash("sha256").update(inertJson(input)).digest("hex");

const allocatedGroupId = (id: string, nextGroupId: number) => {
  const allocated = opaqueIdNumber(id, groupId);
  return allocated !== undefined && allocated < nextGroupId;
};

const opaqueIdNumber = (value: string, pattern: RegExp) => {
  if (!numericIdIsValid(value, pattern)) return;
  const match = pattern.exec(value);
  if (!match) return;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number >= 1 ? number : undefined;
};

const validCheckpointChild = (value: unknown): value is SubtaskChildSnapshot =>
  hasExactKeys(value, ["id", "label", "status", "source"]) &&
  validChildId(value.id) &&
  opaqueIdNumber(value.id, childId) !== undefined &&
  labelValidity(value.label) === "valid" &&
  statusIsValid(value.status) &&
  validSourceRef(value.source);

const validCheckpointRetiredChild = (
  value: unknown,
): value is SubtaskRetiredChildSnapshot =>
  hasExactKeys(value, ["id", "label", "status", "source", "retirement"]) &&
  validChildId(value.id) &&
  opaqueIdNumber(value.id, childId) !== undefined &&
  labelValidity(value.label) === "valid" &&
  statusIsValid(value.status) &&
  validSourceRef(value.source) &&
  hasExactKeys(value.retirement, ["source", "reason"]) &&
  validSourceRef(value.retirement.source) &&
  (value.retirement.reason === "replaced" ||
    value.retirement.reason === "withdrawn" ||
    value.retirement.reason === "out-of-scope");

const validCheckpointReport = (
  value: unknown,
): value is SubtaskCheckpointReport =>
  hasExactKeys(value, ["childId", "status", "source"]) &&
  validChildId(value.childId) &&
  opaqueIdNumber(value.childId, childId) !== undefined &&
  statusIsValid(value.status) &&
  validSourceRef(value.source);

const checkpointGroupKeys = (value: unknown) =>
  hasExactKeys(
    value,
    [
      "id",
      "parentTaskId",
      "parentRevision",
      "parentSourceDigest",
      "listRevision",
      "source",
      "proof",
      "complete",
      "children",
      "retired",
      "omissions",
      "latestAdmissionDigest",
      "reports",
    ],
    ["knownTotal"],
  );

const validCheckpointGroup = (
  value: unknown,
): value is SubtaskCheckpointGroup => {
  if (
    !checkpointGroupKeys(value) ||
    typeof value.id !== "string" ||
    opaqueIdNumber(value.id, groupId) === undefined ||
    !numericIdIsValid(value.parentTaskId, taskId) ||
    !positiveInteger(value.parentRevision) ||
    !validHash(value.parentSourceDigest) ||
    !positiveInteger(value.listRevision) ||
    !validSourceRef(value.source) ||
    !validProof(value.proof) ||
    typeof value.complete !== "boolean" ||
    !validHash(value.latestAdmissionDigest) ||
    !densePlainArray(value.children, 0, MAX_ACTIVE_CHILDREN) ||
    !value.children.every(validCheckpointChild) ||
    !densePlainArray(value.retired, 0, MAX_RETAINED_CHILDREN) ||
    !value.retired.every(validCheckpointRetiredChild) ||
    value.children.length + value.retired.length > MAX_RETAINED_CHILDREN ||
    !densePlainArray(value.omissions, 0, MAX_OMISSIONS) ||
    !value.omissions.every((omission) =>
      validText(omission, MAX_OMISSION_SCALARS),
    ) ||
    !densePlainArray(value.reports, 0, MAX_RETAINED_CHILDREN) ||
    value.reports.length > value.children.length + value.retired.length ||
    !value.reports.every(validCheckpointReport)
  )
    return false;

  if (
    (Object.hasOwn(value, "knownTotal") &&
      (!nonNegativeInteger(value.knownTotal) ||
        value.knownTotal === undefined)) ||
    !(value.complete
      ? value.knownTotal === undefined ||
        value.knownTotal === value.children.length
      : value.knownTotal === undefined ||
        (typeof value.knownTotal === "number" &&
          value.knownTotal >= value.children.length))
  )
    return false;

  const childById = new Map<string, SubtaskChildSnapshot>();
  for (const child of value.children) childById.set(child.id, child);
  for (const child of value.retired) childById.set(child.id, child);
  if (childById.size !== value.children.length + value.retired.length)
    return false;

  const reports = new Map<string, SubtaskCheckpointReport>();
  for (const report of value.reports) reports.set(report.childId, report);
  if (
    reports.size !== value.reports.length ||
    [...reports.keys()].some((id) => !childById.has(id))
  )
    return false;

  return [...childById.values()].every((child) => {
    const report = reports.get(child.id);
    return (
      (child.status === "pending" || report !== undefined) &&
      (!report || report.status === child.status)
    );
  });
};

const validSubtaskCheckpointShape = (
  value: unknown,
): value is SubtaskCheckpoint => {
  if (
    !hasExactKeys(value, ["version", "nextGroupId", "nextChildId", "groups"]) ||
    value.version !== CHECKPOINT_VERSION ||
    !positiveInteger(value.nextGroupId) ||
    !positiveInteger(value.nextChildId) ||
    !densePlainArray(value.groups, 0, MAX_GROUPS) ||
    !value.groups.every(validCheckpointGroup)
  )
    return false;

  const groupIds = new Set(value.groups.map((group) => group.id));
  const parentRevisions = new Set(
    value.groups.map(
      (group) => `${group.parentTaskId}:${group.parentRevision}`,
    ),
  );
  if (
    groupIds.size !== value.groups.length ||
    parentRevisions.size !== value.groups.length
  )
    return false;

  const children = value.groups.flatMap((group) => [
    ...group.children,
    ...group.retired,
  ]);
  if (
    children.length > MAX_RETAINED_CHILDREN ||
    new Set(children.map((child) => child.id)).size !== children.length
  )
    return false;

  const highestGroupId = Math.max(
    0,
    ...value.groups.map((group) => opaqueIdNumber(group.id, groupId) ?? 0),
  );
  const highestChildId = Math.max(
    0,
    ...children.map((child) => opaqueIdNumber(child.id, childId) ?? 0),
  );
  return (
    value.nextGroupId > highestGroupId && value.nextChildId > highestChildId
  );
};

export const subtaskCheckpointIsValid = (
  value: unknown,
): value is SubtaskCheckpoint => {
  try {
    return (
      validSubtaskCheckpointShape(value) &&
      Buffer.byteLength(inertJson(value), "utf8") <=
        MAX_SUBTASK_CHECKPOINT_BYTES
    );
  } catch {
    return false;
  }
};

/**
 * Pure, disconnected generic subtask reducer. It owns only sidecar list state;
 * caller-owned HybridTask records remain immutable inputs.
 */
export class SubtaskStore {
  private groups: SubtaskGroup[] = [];
  /** Successful reconciliation makes this complete bounded parent authority. */
  private currentParents = new Map<string, ParentAuthority>();
  private hasCurrentParentAuthority = false;
  private nextGroupId = 1;
  private nextChildId = 1;

  admit(input: SubtaskAdmission): SubtaskAdmissionResult {
    try {
      return this.admitInternal(input);
    } catch {
      return { accepted: false, reason: "invalid" };
    }
  }

  report(input: SubtaskReport): SubtaskReportResult {
    try {
      return this.reportInternal(input);
    } catch {
      return { accepted: false, reason: "invalid" };
    }
  }

  /**
   * Resolve only the exact latest admitted list under reconciled current parent
   * authority. This read-only bridge never substitutes group provenance for a
   * changed current parent source.
   */
  resolveAdmission(
    input: SubtaskAdmission,
  ): SubtaskSnapshot["groups"][number] | undefined {
    try {
      if (admissionValidity(input) !== "valid") return;
      const admission = cloneAdmission(input);
      if (Buffer.byteLength(inertJson(admission), "utf8") > MAX_ADMISSION_BYTES)
        return;
      const current = this.currentParents.get(admission.parent.id);
      const group = this.groups.find(
        (candidate) =>
          candidate.parentTaskId === admission.parent.id &&
          candidate.parentRevision === admission.parent.revision,
      );
      if (
        !this.hasCurrentParentAuthority ||
        !current ||
        !group?.included ||
        !current.included ||
        current.revision !== admission.parent.revision ||
        current.sourceDigest !== parentSourceDigest(admission.parent.source) ||
        group.latestAdmissionDigest !== admissionDigest(admission)
      )
        return;
      return cloneGroupSnapshot(group);
    } catch {
      return;
    }
  }

  reconcile(parents: readonly HybridTask[]): void {
    try {
      if (!densePlainArray(parents, 0, MAX_GROUPS)) return;
      const current = new Map<string, ParentAuthority>();
      for (let index = 0; index < parents.length; index += 1) {
        const parent = parents[index];
        if (!validParent(parent) || current.has(parent.id)) return;
        current.set(parent.id, {
          revision: parent.revision,
          included: parent.included,
          sourceDigest: parentSourceDigest(parent.source),
        });
      }
      const groups = this.groups.flatMap((group) => {
        const parent = current.get(group.parentTaskId);
        if (!parent || parent.revision !== group.parentRevision) return [];
        return [{ ...group, included: parent.included }];
      });
      this.currentParents = current;
      this.hasCurrentParentAuthority = true;
      this.groups = groups;
    } catch {
      // Malformed reconciliation input has no authority to delete retained facts.
    }
  }

  snapshot(): SubtaskSnapshot {
    return { groups: this.groups.map(cloneGroupSnapshot) };
  }

  /**
   * Persist only generic sidecar facts. This is a v11 component, not a v10
   * runtime checkpoint: parent authority is rebuilt by restore.
   */
  checkpoint(): SubtaskCheckpoint {
    const checkpoint: SubtaskCheckpoint = {
      version: CHECKPOINT_VERSION,
      nextGroupId: this.nextGroupId,
      nextChildId: this.nextChildId,
      groups: this.groups.map((group) => ({
        id: group.id,
        parentTaskId: group.parentTaskId,
        parentRevision: group.parentRevision,
        parentSourceDigest: group.parentSourceDigest,
        listRevision: group.listRevision,
        source: cloneSource(group.source),
        proof: cloneProof(group.proof),
        complete: group.complete,
        ...(group.knownTotal === undefined
          ? {}
          : { knownTotal: group.knownTotal }),
        children: group.children.map(cloneChild),
        retired: group.retired.map(cloneRetiredChild),
        omissions: [...group.omissions],
        latestAdmissionDigest: group.latestAdmissionDigest,
        reports: [...group.children, ...group.retired].flatMap((child) => {
          const receipt = group.reportReceipts.get(child.id);
          return receipt
            ? [
                {
                  childId: child.id,
                  status: receipt.status,
                  source: cloneSource(receipt.source),
                },
              ]
            : [];
        }),
      })),
    };
    if (!validSubtaskCheckpointShape(checkpoint))
      throw new Error("Subtask checkpoint has invalid v11 component shape");
    if (
      Buffer.byteLength(inertJson(checkpoint), "utf8") >
      MAX_SUBTASK_CHECKPOINT_BYTES
    )
      throw new Error("Subtask checkpoint exceeds v11 component bounds");
    return checkpoint;
  }

  static restore(
    data: unknown,
    options: SubtaskRestoreOptions,
  ): SubtaskStore | undefined {
    if (
      !subtaskCheckpointIsValid(data) ||
      !hasExactKeys(options, ["parents", "sourceCurrent"]) ||
      !densePlainArray(options.parents, 0, MAX_GROUPS) ||
      typeof options.sourceCurrent !== "function"
    )
      return;

    const checkpoint = cloneSubtaskCheckpoint(data);
    const currentParents = new Map<string, ParentAuthority>();
    for (const parent of options.parents) {
      if (!validParent(parent) || currentParents.has(parent.id)) return;
      const snapshot = cloneParent(parent);
      currentParents.set(snapshot.id, {
        revision: snapshot.revision,
        included: snapshot.included,
        sourceDigest: parentSourceDigest(snapshot.source),
      });
    }
    const sourceCurrentCallback = options.sourceCurrent;
    const sourceCurrent = (source: SourceRef) => {
      try {
        return sourceCurrentCallback(cloneSource(source)) === true;
      } catch {
        return false;
      }
    };

    const store = new SubtaskStore();
    store.nextGroupId = checkpoint.nextGroupId;
    store.nextChildId = checkpoint.nextChildId;
    store.currentParents = currentParents;
    store.hasCurrentParentAuthority = true;
    store.groups = checkpoint.groups.flatMap((group) => {
      const parent = currentParents.get(group.parentTaskId);
      // Parent wording/source can change at same revision. Persisted digest is
      // immutable admission provenance; revision is current authority fence.
      if (
        !parent ||
        parent.revision !== group.parentRevision ||
        !sourceCurrent(group.source) ||
        !group.children.every((child) => sourceCurrent(child.source)) ||
        !group.retired.every(
          (child) =>
            sourceCurrent(child.source) &&
            sourceCurrent(child.retirement.source),
        )
      )
        return [];

      const reportReceipts = new Map<string, SubtaskReportReceipt>();
      for (const report of group.reports) {
        if (sourceCurrent(report.source))
          reportReceipts.set(report.childId, {
            status: report.status,
            source: cloneSource(report.source),
          });
      }
      const restoredStatus = (child: SubtaskChildSnapshot) =>
        reportReceipts.get(child.id)?.status ?? "pending";
      return [
        {
          id: group.id,
          parentTaskId: group.parentTaskId,
          parentRevision: group.parentRevision,
          parentSourceDigest: group.parentSourceDigest,
          listRevision: group.listRevision,
          source: cloneSource(group.source),
          proof: cloneProof(group.proof),
          complete: group.complete,
          ...(group.knownTotal === undefined
            ? {}
            : { knownTotal: group.knownTotal }),
          children: group.children.map((child) => ({
            ...cloneChild(child),
            status: restoredStatus(child),
          })),
          retired: group.retired.map((child) => ({
            ...cloneRetiredChild(child),
            status: restoredStatus(child),
          })),
          omissions: [...group.omissions],
          included: parent.included,
          latestAdmissionDigest: group.latestAdmissionDigest,
          reportReceipts,
        } satisfies SubtaskGroup,
      ];
    });
    return store;
  }

  private admitInternal(input: SubtaskAdmission): SubtaskAdmissionResult {
    const validity = admissionValidity(input);
    if (validity !== "valid") return { accepted: false, reason: validity };

    // All byte accounting and replay identity use this inert detached projection.
    const admission = cloneAdmission(input);
    const serializedAdmission = inertJson(admission);
    if (Buffer.byteLength(serializedAdmission, "utf8") > MAX_ADMISSION_BYTES)
      return { accepted: false, reason: "capacity" };
    const replayDigest = admissionDigest(admission);

    const { parent } = admission;
    if (!parent.included) return { accepted: false, reason: "stale" };
    if (this.hasCurrentParentAuthority) {
      const current = this.currentParents.get(parent.id);
      if (!current || current.revision !== parent.revision || !current.included)
        return { accepted: false, reason: "stale" };
    }

    const parentGroups = this.groups.filter(
      (group) => group.parentTaskId === parent.id,
    );
    if (parentGroups.some((group) => group.parentRevision > parent.revision))
      return { accepted: false, reason: "stale" };

    const group = parentGroups.find(
      (candidate) => candidate.parentRevision === parent.revision,
    );
    if (!group)
      return this.admitNewGroup(
        admission,
        replayDigest,
        parentGroups.filter(
          (candidate) => candidate.parentRevision < parent.revision,
        ),
      );

    if (!group.included) return { accepted: false, reason: "stale" };
    if (admission.expectedListRevision !== group.listRevision) {
      return replayDigest === group.latestAdmissionDigest
        ? { accepted: true }
        : { accepted: false, reason: "stale" };
    }

    return this.refineGroup(group, admission, replayDigest);
  }

  private admitNewGroup(
    input: SubtaskAdmission,
    replayDigest: string,
    superseded: readonly SubtaskGroup[],
  ): SubtaskAdmissionResult {
    if (input.expectedListRevision !== 0)
      return { accepted: false, reason: "stale" };
    // First admission has no active child set; removal can only be foreign.
    if (input.removals.length) return { accepted: false, reason: "foreign" };

    const active = this.buildInitialChildren(input.children);
    if (!active) return { accepted: false, reason: "foreign" };
    if (!active.length && input.knownTotal === undefined)
      return { accepted: false, reason: "invalid" };
    if (active.length > MAX_ACTIVE_CHILDREN)
      return { accepted: false, reason: "capacity" };
    if (!this.validTotal(input.complete, input.knownTotal, active.length))
      return { accepted: false, reason: "invalid" };

    const supersededSet = new Set(superseded);
    const retainedWithoutSuperseded =
      this.retainedChildren() -
      superseded.reduce(
        (total, group) => total + group.children.length + group.retired.length,
        0,
      );
    if (retainedWithoutSuperseded + active.length > MAX_RETAINED_CHILDREN)
      return { accepted: false, reason: "capacity" };
    if (this.groups.length - superseded.length >= MAX_GROUPS)
      return { accepted: false, reason: "capacity" };
    if (
      !safeIncrement(this.nextGroupId) ||
      !safeIncrement(this.nextChildId, active.length)
    )
      return { accepted: false, reason: "capacity" };

    const children = active.map((child, index) => ({
      ...child,
      id: `subtask-child:${this.nextChildId + index}`,
    }));
    const group: SubtaskGroup = {
      id: `subtask-group:${this.nextGroupId}`,
      parentTaskId: input.parent.id,
      parentRevision: input.parent.revision,
      parentSourceDigest: parentSourceDigest(input.parent.source),
      listRevision: 1,
      source: cloneSource(input.source),
      proof: cloneProof(input.proof),
      complete: input.complete,
      ...(input.knownTotal === undefined
        ? {}
        : { knownTotal: input.knownTotal }),
      children,
      retired: [],
      omissions: omissionList(input.complete, input.knownTotal, children, []),
      included: true,
      latestAdmissionDigest: replayDigest,
      reportReceipts: new Map(),
    };
    this.groups = [
      ...this.groups.filter((item) => !supersededSet.has(item)),
      group,
    ];
    this.nextGroupId += 1;
    this.nextChildId += children.length;
    return { accepted: true };
  }

  private refineGroup(
    group: SubtaskGroup,
    input: SubtaskAdmission,
    replayDigest: string,
  ): SubtaskAdmissionResult {
    const activeById = new Map(
      group.children.map((child) => [child.id, child]),
    );
    const retiredIds = new Set(group.retired.map((child) => child.id));
    const referenced = new Set<string>();
    const retirementById = new Map<
      string,
      SubtaskRetiredChildSnapshot["retirement"]
    >();
    const children: SubtaskChildSnapshot[] = [];
    let addedCount = 0;

    for (const operation of input.children) {
      if (operation.kind === "add") {
        children.push({
          id: `subtask-child:${this.nextChildId + addedCount}`,
          label: operation.label,
          status: "pending",
          source: cloneSource(operation.source),
        });
        addedCount += 1;
        continue;
      }
      if (referenced.has(operation.id))
        return { accepted: false, reason: "invalid" };
      referenced.add(operation.id);

      const prior = activeById.get(operation.id);
      if (!prior) {
        if (retiredIds.has(operation.id))
          return { accepted: false, reason: "stale" };
        return { accepted: false, reason: "foreign" };
      }
      switch (operation.kind) {
        case "retain":
          children.push(cloneChild(prior));
          break;
        case "reword":
          children.push(
            operation.label === prior.label
              ? cloneChild(prior)
              : {
                  ...cloneChild(prior),
                  label: operation.label,
                  source: cloneSource(operation.source),
                },
          );
          break;
        case "replace":
          children.push({
            id: `subtask-child:${this.nextChildId + addedCount}`,
            label: operation.label,
            status: "pending",
            source: cloneSource(operation.source),
          });
          addedCount += 1;
          retirementById.set(prior.id, {
            reason: "replaced",
            source: cloneSource(operation.source),
          });
          break;
      }
    }

    for (const removal of input.removals) {
      if (referenced.has(removal.id))
        return { accepted: false, reason: "invalid" };
      referenced.add(removal.id);
      const prior = activeById.get(removal.id);
      if (!prior) {
        if (retiredIds.has(removal.id))
          return { accepted: false, reason: "stale" };
        return { accepted: false, reason: "foreign" };
      }
      retirementById.set(prior.id, {
        reason: removal.reason,
        source: cloneSource(removal.source),
      });
    }

    if (referenced.size !== group.children.length)
      return { accepted: false, reason: "invalid" };
    if (children.length > MAX_ACTIVE_CHILDREN)
      return { accepted: false, reason: "capacity" };
    if (!this.validTotal(input.complete, input.knownTotal, children.length))
      return { accepted: false, reason: "invalid" };
    if (this.retainedChildren() + addedCount > MAX_RETAINED_CHILDREN)
      return { accepted: false, reason: "capacity" };

    const retired = [
      ...group.retired.map(cloneRetiredChild),
      ...group.children.flatMap((child) => {
        const retirement = retirementById.get(child.id);
        return retirement
          ? [
              {
                ...cloneChild(child),
                retirement,
              },
            ]
          : [];
      }),
    ];
    const omissions = omissionList(
      input.complete,
      input.knownTotal,
      children,
      retired,
    );
    const changed =
      !sameChildren(group.children, children) ||
      !sameRetiredChildren(group.retired, retired) ||
      group.complete !== input.complete ||
      group.knownTotal !== input.knownTotal;

    if (!changed) {
      group.latestAdmissionDigest = replayDigest;
      return { accepted: true };
    }
    if (
      !safeIncrement(group.listRevision) ||
      !safeIncrement(this.nextChildId, addedCount)
    )
      return { accepted: false, reason: "capacity" };

    this.groups = this.groups.map((candidate) =>
      candidate === group
        ? {
            ...candidate,
            listRevision: candidate.listRevision + 1,
            source: cloneSource(input.source),
            proof: cloneProof(input.proof),
            complete: input.complete,
            ...(input.knownTotal === undefined
              ? { knownTotal: undefined }
              : { knownTotal: input.knownTotal }),
            children,
            retired,
            omissions,
            latestAdmissionDigest: replayDigest,
          }
        : candidate,
    );
    this.nextChildId += addedCount;
    return { accepted: true };
  }

  private reportInternal(input: SubtaskReport): SubtaskReportResult {
    if (!reportValidity(input)) return { accepted: false, reason: "invalid" };

    const group = this.groups.find(
      (candidate) => candidate.id === input.groupId,
    );
    if (!group) {
      return allocatedGroupId(input.groupId, this.nextGroupId)
        ? { accepted: false, reason: "stale" }
        : { accepted: false, reason: "foreign" };
    }
    if (!group.included || group.listRevision !== input.listRevision)
      return { accepted: false, reason: "stale" };

    const childIds = [...input.childIds];
    const selected = new Set(childIds);
    if (selected.size !== childIds.length)
      return { accepted: false, reason: "invalid" };
    if (
      !childIds.every((id) => group.children.some((child) => child.id === id))
    )
      return { accepted: false, reason: "foreign" };

    this.groups = this.groups.map((candidate) => {
      if (candidate !== group) return candidate;
      const reportReceipts = new Map(candidate.reportReceipts);
      for (const id of selected)
        reportReceipts.set(id, {
          status: input.status,
          source: cloneSource(input.source),
        });
      return {
        ...candidate,
        reportReceipts,
        children: candidate.children.map((child) =>
          selected.has(child.id)
            ? { ...cloneChild(child), status: input.status }
            : child,
        ),
      };
    });
    return { accepted: true };
  }

  private buildInitialChildren(
    operations: readonly SubtaskChildOperation[],
  ): Omit<SubtaskChildSnapshot, "id">[] | undefined {
    const children: Omit<SubtaskChildSnapshot, "id">[] = [];
    for (const operation of operations) {
      if (operation.kind !== "add") return;
      children.push({
        label: operation.label,
        status: "pending",
        source: cloneSource(operation.source),
      });
    }
    return children;
  }

  private validTotal(
    complete: boolean,
    knownTotal: number | undefined,
    activeCount: number,
  ) {
    if (complete) return knownTotal === undefined || knownTotal === activeCount;
    return knownTotal === undefined || knownTotal >= activeCount;
  }

  private retainedChildren() {
    return this.groups.reduce(
      (total, group) => total + group.children.length + group.retired.length,
      0,
    );
  }
}
