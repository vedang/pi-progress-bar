import { createHash } from "node:crypto";
import type { HybridTask, SourceRef } from "./hybrid-state";

const MAX_CHILDREN_PER_GROUP = 64;
const MAX_RETAINED_CHILDREN = 200;
const MAX_LABEL_SCALARS = 240;
const MAX_INVENTORY_BYTES = 32 * 1024;
const digest = /^[a-f0-9]{64}$/;

type CoverageChildStatus = "pending" | "reported-reviewed" | "reported-blocked";

export interface CoverageInventory {
  resourceKey: string;
  revision: number;
  complete: boolean;
  knownTotal?: number;
  replacement?: true;
  source: {
    entryId: string;
    messageHash: string;
    callId: string;
  };
  items: Array<{ key: string; label: string }>;
}

export interface CoverageAdmission {
  parent: HybridTask;
  intent: SourceRef;
  inventory: CoverageInventory;
}

export type CoverageAdmissionResult =
  | { accepted: true }
  | { accepted: false; reason: "invalid" | "capacity" | "stale" };

export interface CoverageReport {
  groupId: string;
  inventoryRevision: number;
  childIds: string[];
  source: SourceRef;
  status: CoverageChildStatus;
}

export type CoverageReportResult =
  | { accepted: true }
  | { accepted: false; reason: "invalid" | "stale" | "foreign" };

export interface CoverageChildSnapshot {
  id: string;
  key: string;
  label: string;
  status: CoverageChildStatus;
}

interface CoverageGroupSnapshot {
  id: string;
  parentTaskId: string;
  parentRevision: number;
  parentSourceDigest: string;
  intent: SourceRef;
  resourceKey: string;
  inventoryRevision: number;
  complete: boolean;
  knownTotal?: number;
  children: CoverageChildSnapshot[];
  omissions: string[];
}

export interface CoverageSnapshot {
  groups: CoverageGroupSnapshot[];
}

interface CoverageReportReceipt {
  inventoryRevision: number;
  status: CoverageChildStatus;
  source: SourceRef;
}

interface CoverageGroup extends CoverageGroupSnapshot {
  included: boolean;
  inventorySource: CoverageInventory["source"];
  inventorySignature: string;
  /** One latest receipt per child keeps report provenance bounded by group size. */
  reportReceipts: Map<string, CoverageReportReceipt>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const safeText = (
  value: unknown,
  maxScalars = MAX_LABEL_SCALARS,
): value is string =>
  typeof value === "string" &&
  !!value.trim() &&
  Array.from(value).length <= maxScalars &&
  !/[\p{Cc}\p{Cf}]/u.test(value);

const validHash = (value: unknown): value is string =>
  typeof value === "string" && digest.test(value);

const validSourceRef = (value: unknown): value is SourceRef => {
  if (!record(value)) return false;
  return (
    safeText(value.entryId, 512) &&
    validHash(value.messageHash) &&
    (value.role === "user" ||
      value.role === "assistant" ||
      value.role === "intercom") &&
    Number.isSafeInteger(value.start) &&
    (value.start as number) >= 0 &&
    Number.isSafeInteger(value.end) &&
    (value.end as number) > (value.start as number) &&
    validHash(value.quoteHash)
  );
};

const validParent = (value: unknown): value is HybridTask => {
  if (!record(value)) return false;
  return (
    safeText(value.id, 512) &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 1 &&
    value.included === true &&
    validSourceRef(value.source)
  );
};

const validInventory = (value: unknown): value is CoverageInventory => {
  if (!record(value) || !record(value.source) || !Array.isArray(value.items))
    return false;
  if (
    !safeText(value.resourceKey, 1024) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    typeof value.complete !== "boolean" ||
    !safeText(value.source.entryId, 512) ||
    !validHash(value.source.messageHash) ||
    !safeText(value.source.callId, 512) ||
    (value.replacement !== undefined && value.replacement !== true)
  )
    return false;
  const knownTotal = value.knownTotal;
  if (
    knownTotal !== undefined &&
    (typeof knownTotal !== "number" ||
      !Number.isSafeInteger(knownTotal) ||
      knownTotal < 0)
  )
    return false;
  const keys = new Set<string>();
  for (const item of value.items) {
    if (
      !record(item) ||
      !safeText(item.key, 512) ||
      !safeText(item.label) ||
      keys.has(item.key)
    )
      return false;
    keys.add(item.key);
  }
  if (value.complete && knownTotal !== undefined)
    return knownTotal === value.items.length;
  return knownTotal === undefined || knownTotal >= value.items.length;
};

const inventoryCapacityExceeded = (inventory: CoverageInventory) =>
  inventory.items.length > MAX_CHILDREN_PER_GROUP ||
  (inventory.knownTotal !== undefined &&
    inventory.knownTotal > MAX_CHILDREN_PER_GROUP) ||
  Buffer.byteLength(JSON.stringify(inventory), "utf8") > MAX_INVENTORY_BYTES;

const sourceDigest = (source: SourceRef) =>
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

const inventorySignature = (inventory: CoverageInventory) =>
  JSON.stringify({
    resourceKey: inventory.resourceKey,
    revision: inventory.revision,
    complete: inventory.complete,
    ...(inventory.knownTotal === undefined
      ? {}
      : { knownTotal: inventory.knownTotal }),
    ...(inventory.replacement ? { replacement: true } : {}),
    source: {
      entryId: inventory.source.entryId,
      messageHash: inventory.source.messageHash,
      callId: inventory.source.callId,
    },
    items: inventory.items.map((item) => ({
      key: item.key,
      label: item.label,
    })),
  });

const inventoryOmissions = (inventory: CoverageInventory) => {
  const omissions: string[] = [];
  if (!inventory.complete) {
    omissions.push(
      inventory.knownTotal === undefined
        ? "Inventory is incomplete"
        : `Inventory labels unavailable for ${inventory.knownTotal} items`,
    );
  }
  return omissions;
};

/**
 * Pure bounded coverage reducer. It deliberately has no host/model/checkpoint
 * dependencies and never changes its parent tasks.
 */
export class CoverageStore {
  private groups: CoverageGroup[] = [];
  private nextGroupId = 1;
  private nextChildId = 1;

  admit(input: CoverageAdmission): CoverageAdmissionResult {
    if (
      !record(input) ||
      !validParent(input.parent) ||
      !validSourceRef(input.intent) ||
      !validInventory(input.inventory)
    )
      return { accepted: false, reason: "invalid" };
    if (inventoryCapacityExceeded(input.inventory))
      return { accepted: false, reason: "capacity" };

    const { parent, intent, inventory } = input;
    const group = this.groups.find(
      (candidate) =>
        candidate.parentTaskId === parent.id &&
        candidate.parentRevision === parent.revision,
    );
    if (!group) return this.admitGroup(parent, intent, inventory);
    if (group.resourceKey !== inventory.resourceKey && !inventory.replacement)
      return { accepted: false, reason: "invalid" };
    if (inventory.revision < group.inventoryRevision)
      return { accepted: false, reason: "stale" };
    if (inventory.revision === group.inventoryRevision) {
      return inventorySignature(inventory) === group.inventorySignature
        ? { accepted: true }
        : { accepted: false, reason: "invalid" };
    }

    const resourceReplacement = group.resourceKey !== inventory.resourceKey;
    const priorByKey = new Map(
      group.children.map((child) => [child.key, child]),
    );
    const removed = group.children.filter(
      (child) => !inventory.items.some((item) => item.key === child.key),
    );
    const added = inventory.items.filter((item) => !priorByKey.has(item.key));
    if ((removed.length > 0 || resourceReplacement) && !inventory.replacement)
      return { accepted: false, reason: "invalid" };
    if (added.length > 0 && !inventory.complete)
      return { accepted: false, reason: "invalid" };

    const retainedWithoutGroup =
      this.retainedChildren() - group.children.length;
    if (retainedWithoutGroup + inventory.items.length > MAX_RETAINED_CHILDREN)
      return { accepted: false, reason: "capacity" };

    const children = resourceReplacement
      ? this.newChildren(inventory.items)
      : inventory.items.map((item) => {
          const prior = priorByKey.get(item.key);
          return prior
            ? { ...prior, label: item.label }
            : this.newChild(item.key, item.label);
        });
    const omissions = inventoryOmissions(inventory);
    if (resourceReplacement)
      omissions.push("Resource replaced by explicit inventory replacement");
    else if (removed.length)
      omissions.push(
        `${removed.length} prior item${removed.length === 1 ? "" : "s"} removed by explicit inventory replacement`,
      );
    const childIds = new Set(children.map((child) => child.id));
    const reportReceipts = resourceReplacement
      ? new Map<string, CoverageReportReceipt>()
      : new Map(
          [...group.reportReceipts].filter(([childId]) =>
            childIds.has(childId),
          ),
        );

    this.groups = this.groups.map((candidate) =>
      candidate === group
        ? {
            ...candidate,
            resourceKey: inventory.resourceKey,
            inventoryRevision: inventory.revision,
            complete: inventory.complete,
            inventorySource: { ...inventory.source },
            reportReceipts,
            ...(inventory.knownTotal === undefined
              ? { knownTotal: undefined }
              : { knownTotal: inventory.knownTotal }),
            children,
            omissions,
            inventorySignature: inventorySignature(inventory),
          }
        : candidate,
    );
    return { accepted: true };
  }

  report(input: CoverageReport): CoverageReportResult {
    if (
      !record(input) ||
      !safeText(input.groupId, 512) ||
      !Number.isSafeInteger(input.inventoryRevision) ||
      (input.inventoryRevision as number) < 1 ||
      !Array.isArray(input.childIds) ||
      !validSourceRef(input.source) ||
      !["pending", "reported-reviewed", "reported-blocked"].includes(
        input.status,
      )
    )
      return { accepted: false, reason: "invalid" };
    const group = this.groups.find(
      (candidate) => candidate.id === input.groupId,
    );
    if (!group) return { accepted: false, reason: "foreign" };
    if (!group.included || input.inventoryRevision !== group.inventoryRevision)
      return { accepted: false, reason: "stale" };
    const childIds = new Set(input.childIds);
    if (!childIds.size || childIds.size !== input.childIds.length)
      return { accepted: false, reason: "invalid" };
    if (
      !input.childIds.every((id) =>
        group.children.some((child) => child.id === id),
      )
    )
      return { accepted: false, reason: "foreign" };

    const selected = new Set(input.childIds);
    this.groups = this.groups.map((candidate) => {
      if (candidate !== group) return candidate;
      const reportReceipts = new Map(candidate.reportReceipts);
      for (const childId of selected) {
        reportReceipts.set(childId, {
          inventoryRevision: input.inventoryRevision,
          status: input.status,
          source: { ...input.source },
        });
      }
      return {
        ...candidate,
        reportReceipts,
        children: candidate.children.map((child) =>
          selected.has(child.id) ? { ...child, status: input.status } : child,
        ),
      };
    });
    return { accepted: true };
  }

  reconcile(parents: readonly HybridTask[]): void {
    const current = new Map<string, HybridTask>();
    for (const parent of parents) {
      if (validParentRecord(parent)) current.set(parent.id, parent);
    }
    this.groups = this.groups.flatMap((group) => {
      const parent = current.get(group.parentTaskId);
      if (!parent || parent.revision !== group.parentRevision) return [];
      return [{ ...group, included: parent.included }];
    });
  }

  snapshot(): CoverageSnapshot {
    return {
      groups: this.groups.map((group) => ({
        id: group.id,
        parentTaskId: group.parentTaskId,
        parentRevision: group.parentRevision,
        parentSourceDigest: group.parentSourceDigest,
        intent: { ...group.intent },
        resourceKey: group.resourceKey,
        inventoryRevision: group.inventoryRevision,
        complete: group.complete,
        ...(group.knownTotal === undefined
          ? {}
          : { knownTotal: group.knownTotal }),
        children: group.children.map((child) => ({ ...child })),
        omissions: [...group.omissions],
      })),
    };
  }

  private admitGroup(
    parent: HybridTask,
    intent: SourceRef,
    inventory: CoverageInventory,
  ): CoverageAdmissionResult {
    if (
      this.retainedChildren() + inventory.items.length >
      MAX_RETAINED_CHILDREN
    )
      return { accepted: false, reason: "capacity" };
    const id = `coverage-group:${this.nextGroupId++}`;
    this.groups = [
      ...this.groups,
      {
        id,
        parentTaskId: parent.id,
        parentRevision: parent.revision,
        parentSourceDigest: sourceDigest(parent.source),
        intent: { ...intent },
        resourceKey: inventory.resourceKey,
        inventoryRevision: inventory.revision,
        complete: inventory.complete,
        ...(inventory.knownTotal === undefined
          ? {}
          : { knownTotal: inventory.knownTotal }),
        children: this.newChildren(inventory.items),
        omissions: inventoryOmissions(inventory),
        included: parent.included,
        inventorySource: { ...inventory.source },
        inventorySignature: inventorySignature(inventory),
        reportReceipts: new Map(),
      },
    ];
    return { accepted: true };
  }

  private newChildren(items: readonly { key: string; label: string }[]) {
    return items.map((item) => this.newChild(item.key, item.label));
  }

  private newChild(key: string, label: string): CoverageChildSnapshot {
    return {
      id: `coverage-child:${this.nextChildId++}`,
      key,
      label,
      status: "pending",
    };
  }

  private retainedChildren() {
    return this.groups.reduce(
      (total, group) => total + group.children.length,
      0,
    );
  }
}

/** Reconciliation accepts archived parents but keeps invalid inputs non-authoritative. */
function validParentRecord(value: unknown): value is HybridTask {
  if (!record(value)) return false;
  return (
    safeText(value.id, 512) &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 1 &&
    typeof value.included === "boolean" &&
    validSourceRef(value.source)
  );
}
