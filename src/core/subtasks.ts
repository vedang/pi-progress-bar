import { createHash } from "node:crypto";
import type { HybridTask, SourceRef } from "./hybrid-state";

const MAX_ACTIVE_CHILDREN = 64;
const MAX_RETAINED_CHILDREN = 200;
const MAX_GROUPS = 200;
const MAX_LABEL_SCALARS = 240;
const MAX_ADMISSION_BYTES = 32 * 1024;

const digest = /^[a-f0-9]{64}$/;
const taskId = /^task:[1-9]\d*$/;
const groupId = /^subtask-group:[1-9]\d*$/;
const childId = /^subtask-child:[1-9]\d*$/;

type AdmissionFailure = "invalid" | "capacity";

export type SubtaskChildStatus =
  | "pending"
  | "reported-completed"
  | "reported-blocked";

export interface SubtaskProof {
  contextHash: string;
  gateRequestHash: string;
  proposalRequestHash: string;
}

export type SubtaskChildOperation =
  | { kind: "add"; label: string; source: SourceRef }
  | { kind: "retain"; id: string }
  | { kind: "reword"; id: string; label: string; source: SourceRef }
  | { kind: "replace"; id: string; label: string; source: SourceRef };

export interface SubtaskRemoval {
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

export interface SubtaskRetiredChildSnapshot extends SubtaskChildSnapshot {
  retirement: {
    source: SourceRef;
    reason: "replaced" | "withdrawn" | "out-of-scope";
  };
}

export interface SubtaskGroupSnapshot {
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

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) => {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
};

const validHash = (value: unknown): value is string =>
  typeof value === "string" && digest.test(value);

const validText = (value: unknown, maxLength: number): value is string =>
  typeof value === "string" &&
  !!value.trim() &&
  Array.from(value).length <= maxLength &&
  !/[\p{Cc}\p{Cf}]/u.test(value);

const labelValidity = (value: unknown): "valid" | AdmissionFailure => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  )
    return "invalid";
  return Array.from(value).length <= MAX_LABEL_SCALARS ? "valid" : "capacity";
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
  record(value) &&
  hasExactKeys(value, ["entryId", "messageHash", "role"]) &&
  validText(value.entryId, 512) &&
  validHash(value.messageHash) &&
  validRole(value.role);

const validSourceRef = (value: unknown): value is SourceRef =>
  record(value) &&
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
  record(value) &&
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
  record(value) &&
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
  record(value) &&
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
  if (!record(value) || typeof value.kind !== "string") return "invalid";
  switch (value.kind) {
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
  record(value) &&
  hasExactKeys(value, ["id", "source", "reason"]) &&
  validChildId(value.id) &&
  validSourceRef(value.source) &&
  (value.reason === "withdrawn" || value.reason === "out-of-scope");

const admissionValidity = (value: unknown): "valid" | AdmissionFailure => {
  if (
    !record(value) ||
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
    ) ||
    !validParent(value.parent) ||
    !nonNegativeInteger(value.expectedListRevision) ||
    !validSourceRef(value.source) ||
    !validProof(value.proof) ||
    !Array.isArray(value.children) ||
    !Array.isArray(value.removals) ||
    typeof value.complete !== "boolean" ||
    (Object.hasOwn(value, "knownTotal") &&
      (!nonNegativeInteger(value.knownTotal) || value.knownTotal === undefined))
  )
    return "invalid";
  for (const child of value.children) {
    const validity = childOperationValidity(child);
    if (validity !== "valid") return validity;
  }
  return value.removals.every(validRemoval) ? "valid" : "invalid";
};

const statusIsValid = (value: unknown): value is SubtaskChildStatus =>
  value === "pending" ||
  value === "reported-completed" ||
  value === "reported-blocked";

const cloneSource = (source: SourceRef): SourceRef => ({ ...source });

const cloneProof = (proof: SubtaskProof): SubtaskProof => ({ ...proof });

const cloneChild = (child: SubtaskChildSnapshot): SubtaskChildSnapshot => ({
  ...child,
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

/**
 * Pure, disconnected generic subtask reducer. It owns only sidecar list state;
 * caller-owned HybridTask records remain immutable inputs.
 */
export class SubtaskStore {
  private groups: SubtaskGroup[] = [];
  /** Revision fences survive invalidated groups so old admissions cannot revive. */
  private parentRevisionFences = new Map<string, number>();
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
      if (!Array.isArray(parents) || !parents.every(validParent)) return;
      const current = new Map<string, HybridTask>();
      for (const parent of parents) {
        if (current.has(parent.id)) return;
        current.set(parent.id, parent);
      }
      const fences = new Map(this.parentRevisionFences);
      const groups = this.groups.flatMap((group) => {
        const parent = current.get(group.parentTaskId);
        if (!parent || parent.revision !== group.parentRevision) {
          if (parent) {
            fences.set(
              group.parentTaskId,
              Math.max(
                fences.get(group.parentTaskId) ?? 0,
                group.parentRevision,
                parent.revision,
              ),
            );
          }
          return [];
        }
        return [{ ...group, included: parent.included }];
      });
      this.groups = groups;
      this.parentRevisionFences = fences;
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

    const serialized = admissionSignature(input);
    if (Buffer.byteLength(serialized, "utf8") > MAX_ADMISSION_BYTES)
      return { accepted: false, reason: "capacity" };

    const { parent } = input;
    if (!parent.included) return { accepted: false, reason: "stale" };

    const parentGroups = this.groups.filter(
      (group) => group.parentTaskId === parent.id,
    );
    if (
      (this.parentRevisionFences.get(parent.id) ?? 0) > parent.revision ||
      parentGroups.some((group) => group.parentRevision > parent.revision)
    )
      return { accepted: false, reason: "stale" };

    const group = parentGroups.find(
      (candidate) => candidate.parentRevision === parent.revision,
    );
    if (!group)
      return this.admitNewGroup(
        input,
        serialized,
        parentGroups.filter(
          (candidate) => candidate.parentRevision < parent.revision,
        ),
      );

    if (!group.included) return { accepted: false, reason: "stale" };
    if (input.expectedListRevision !== group.listRevision) {
      return serialized === group.latestAdmissionSignature
        ? { accepted: true }
        : { accepted: false, reason: "stale" };
    }

    return this.refineGroup(group, input, serialized);
  }

  private admitNewGroup(
    input: SubtaskAdmission,
    serialized: string,
    superseded: readonly SubtaskGroup[],
  ): SubtaskAdmissionResult {
    if (input.expectedListRevision !== 0)
      return { accepted: false, reason: "stale" };

    const active = this.buildInitialChildren(input.children);
    if (!active) return { accepted: false, reason: "foreign" };
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
    this.parentRevisionFences.set(
      input.parent.id,
      Math.max(
        this.parentRevisionFences.get(input.parent.id) ?? 0,
        input.parent.revision,
      ),
    );
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
    if (
      !record(input) ||
      !hasExactKeys(input, [
        "groupId",
        "listRevision",
        "childIds",
        "source",
        "status",
      ]) ||
      typeof input.groupId !== "string" ||
      !groupId.test(input.groupId) ||
      !positiveInteger(input.listRevision) ||
      !Array.isArray(input.childIds) ||
      !input.childIds.every(validChildId) ||
      !validSourceRef(input.source) ||
      !statusIsValid(input.status)
    )
      return { accepted: false, reason: "invalid" };

    const group = this.groups.find(
      (candidate) => candidate.id === input.groupId,
    );
    if (!group) return { accepted: false, reason: "foreign" };
    if (!group.included || group.listRevision !== input.listRevision)
      return { accepted: false, reason: "stale" };

    const selected = new Set(input.childIds);
    if (!selected.size || selected.size !== input.childIds.length)
      return { accepted: false, reason: "invalid" };
    if (
      !input.childIds.every((id) =>
        group.children.some((child) => child.id === id),
      )
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
