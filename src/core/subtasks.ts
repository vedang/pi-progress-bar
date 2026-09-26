import { createHash } from "node:crypto";
import type { Assessment, HybridTask, SourceRef } from "./hybrid-state";

const MAX_ACTIVE_CHILDREN = 64;
const MAX_RETAINED_CHILDREN = 200;
const MAX_GROUPS = 200;
const MAX_LABEL_SCALARS = 240;
const MAX_ADMISSION_BYTES = 32 * 1024;

const digest = /^[a-f0-9]{64}$/;
const taskId = /^task:[1-9]\d*$/;
const groupId = /^subtask-group:([1-9]\d*)$/;
const childId = /^subtask-child:[1-9]\d*$/;
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

interface SubtaskGroup extends SubtaskGroupSnapshot {
  included: boolean;
  latestAdmissionSignature: string;
}

interface ParentAuthority {
  revision: number;
  included: boolean;
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

const validHash = (value: unknown): value is string =>
  typeof value === "string" && digest.test(value);

const textWithinScalarLimit = (value: unknown, limit: number): boolean => {
  if (typeof value !== "string" || !value.length) return false;
  let scalars = 0;
  let nonblank = false;
  for (let index = 0; index < value.length; ) {
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
    (typeof value.rawChoice === "string" && taskId.test(value.rawChoice))) &&
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
  typeof value.id === "string" &&
  taskId.test(value.id) &&
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
  typeof value === "string" && childId.test(value);

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
    typeof value.groupId !== "string" ||
    !groupId.test(value.groupId) ||
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

const parentSourceDigest = (source: SourceRef) =>
  createHash("sha256")
    .update(
      JSON.stringify([
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

const admissionSignature = (input: SubtaskAdmission) => JSON.stringify(input);

const allocatedGroupId = (id: string, nextGroupId: number) => {
  const match = id.match(groupId);
  if (!match) return false;
  const allocated = Number(match[1]);
  return Number.isSafeInteger(allocated) && allocated < nextGroupId;
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
    return {
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
      })),
    };
  }

  private admitInternal(input: SubtaskAdmission): SubtaskAdmissionResult {
    const validity = admissionValidity(input);
    if (validity !== "valid") return { accepted: false, reason: validity };

    // All byte accounting and replay identity use this inert detached projection.
    const admission = cloneAdmission(input);
    const serialized = admissionSignature(admission);
    if (Buffer.byteLength(serialized, "utf8") > MAX_ADMISSION_BYTES)
      return { accepted: false, reason: "capacity" };

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
        serialized,
        parentGroups.filter(
          (candidate) => candidate.parentRevision < parent.revision,
        ),
      );

    if (!group.included) return { accepted: false, reason: "stale" };
    if (admission.expectedListRevision !== group.listRevision) {
      return serialized === group.latestAdmissionSignature
        ? { accepted: true }
        : { accepted: false, reason: "stale" };
    }

    return this.refineGroup(group, admission, serialized);
  }

  private admitNewGroup(
    input: SubtaskAdmission,
    serialized: string,
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
      latestAdmissionSignature: serialized,
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
    serialized: string,
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
      group.latestAdmissionSignature = serialized;
      return { accepted: true };
    }

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
            latestAdmissionSignature: serialized,
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

    this.groups = this.groups.map((candidate) =>
      candidate === group
        ? {
            ...candidate,
            children: candidate.children.map((child) =>
              selected.has(child.id)
                ? { ...cloneChild(child), status: input.status }
                : child,
            ),
          }
        : candidate,
    );
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
