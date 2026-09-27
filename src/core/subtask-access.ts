import { ownDataJson } from "../analysis/own-data-json";
import {
  type ResolvedSubtaskAssociationPlan,
  resolveSubtaskAssociationPlan,
} from "../analysis/subtask-proposal";
import {
  isCurrentSubtaskAccessEvidence,
  type SubtaskAccessEvidence,
} from "../sources/coverage";
import type { SubtaskSnapshot, SubtaskStore } from "./subtasks";

const MAX_REGISTRY_CHILDREN = 200;
const MAX_REGISTRY_GROUPS = 200;
const MAX_REGISTRY_BYTES = 64 * 1024;

type SubtaskAccessStatus = "observed" | "no-observation" | "unavailable";
type GroupSnapshot = SubtaskSnapshot["groups"][number];

export interface SubtaskAccessSnapshot {
  groups: Array<{
    groupId: string;
    parentTaskId: string;
    parentRevision: number;
    listRevision: number;
    children: Array<{
      childId: string;
      status: SubtaskAccessStatus;
      activeCallHashes: string[];
    }>;
  }>;
  omissions: number;
}

interface RegisteredGroup {
  result: object;
  groupId: string;
  parentTaskId: string;
  parentRevision: number;
  listRevision: number;
}

interface CurrentRegistration {
  registration: RegisteredGroup;
  resolution: ResolvedSubtaskAssociationPlan;
}

interface AssociationLink {
  groupId: string;
  childId: string;
  resourceKey: string;
  itemKey: string;
}

interface AccessFacts {
  mapped: Set<string>;
  active: Map<string, string[]>;
  confirmed: Set<string>;
  omissions: number;
}

const resourceItemKey = (resourceKey: string, itemKey: string) =>
  `${resourceKey}\u0000${itemKey}`;

const childKey = (groupId: string, childId: string) =>
  `${groupId}\u0000${childId}`;

const deepFreeze = <Value>(
  value: Value,
  seen = new WeakSet<object>(),
): Value => {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

const sameRegistration = (
  registration: RegisteredGroup,
  group: GroupSnapshot,
) =>
  registration.groupId === group.id &&
  registration.parentTaskId === group.parentTaskId &&
  registration.parentRevision === group.parentRevision &&
  registration.listRevision === group.listRevision;

const register = (result: object, group: GroupSnapshot): RegisteredGroup => ({
  result,
  groupId: group.id,
  parentTaskId: group.parentTaskId,
  parentRevision: group.parentRevision,
  listRevision: group.listRevision,
});

const accessFacts = (evidence: SubtaskAccessEvidence): AccessFacts => {
  const mapped = new Set<string>();
  for (const resource of evidence.mapped)
    for (const itemKey of resource.itemKeys)
      mapped.add(resourceItemKey(resource.resourceKey, itemKey));

  const active = new Map<string, string[]>();
  for (const call of evidence.active)
    for (const itemKey of call.itemKeys) {
      const key = resourceItemKey(call.resourceKey, itemKey);
      const hashes = active.get(key) ?? [];
      if (!hashes.includes(call.callHash)) hashes.push(call.callHash);
      active.set(key, hashes);
    }

  const confirmed = new Set<string>();
  for (const receipt of evidence.confirmed)
    for (const itemKey of receipt.itemKeys)
      confirmed.add(resourceItemKey(receipt.resourceKey, itemKey));

  return { mapped, active, confirmed, omissions: evidence.omissions };
};

/**
 * Runtime-only optional resource access projection. It never admits, reports,
 * changes parent state, or reconstructs links after reset.
 */
export class SubtaskAccess {
  private groups = new Map<string, RegisteredGroup>();
  private omissions = 0;

  constructor(private readonly store: SubtaskStore) {}

  /**
   * Atomically replace one current group's model association set. The original
   * accepted result is retained privately so every later projection can replay
   * bridge currentness checks instead of trusting caller-supplied links.
   */
  bind(result: unknown): boolean {
    try {
      if (!result || typeof result !== "object") return false;
      const resolution = resolveSubtaskAssociationPlan(result, this.store);
      if (!resolution) return false;
      const current = this.currentRegistrations();
      current.delete(resolution.group.id);
      if (resolution.associations.length)
        current.set(resolution.group.id, {
          registration: register(result, resolution.group),
          resolution,
        });
      if (!this.fitsRegistry(current)) {
        this.omissions += 1;
        return false;
      }
      this.groups = new Map(
        [...current].map(([groupId, item]) => [groupId, item.registration]),
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Project every current generic group. Invalid, absent, stale, ambiguous, or
   * omitted access facts stay unavailable rather than becoming negative claims.
   */
  snapshot(access: unknown): SubtaskAccessSnapshot {
    try {
      const groups = this.store.snapshot().groups;
      const current = this.currentRegistrations();
      const links = this.links(current);
      const facts = isCurrentSubtaskAccessEvidence(access)
        ? accessFacts(access as SubtaskAccessEvidence)
        : undefined;

      return deepFreeze({
        groups: groups.map((group) => this.groupSnapshot(group, links, facts)),
        omissions: this.omissions,
      });
    } catch {
      return deepFreeze({
        groups: [],
        omissions: this.omissions,
      });
    }
  }

  reset(): void {
    this.groups.clear();
    this.omissions = 0;
  }

  private currentRegistrations(): Map<string, CurrentRegistration> {
    const current = new Map<string, CurrentRegistration>();
    for (const [groupId, registration] of this.groups) {
      const resolution = resolveSubtaskAssociationPlan(
        registration.result,
        this.store,
      );
      if (!resolution || !sameRegistration(registration, resolution.group))
        continue;
      current.set(groupId, { registration, resolution });
    }
    return current;
  }

  private fitsRegistry(current: ReadonlyMap<string, CurrentRegistration>) {
    if (current.size > MAX_REGISTRY_GROUPS) return false;
    const children = new Set<string>();
    for (const { resolution } of current.values())
      for (const association of resolution.associations)
        children.add(childKey(resolution.group.id, association.childId));
    if (children.size > MAX_REGISTRY_CHILDREN) return false;

    const serialized = ownDataJson(
      {
        groups: [...current.values()].map(({ resolution }) => ({
          groupId: resolution.group.id,
          parentTaskId: resolution.group.parentTaskId,
          parentRevision: resolution.group.parentRevision,
          listRevision: resolution.group.listRevision,
          admission: resolution.admission,
          ...(resolution.evidence === undefined
            ? {}
            : { evidence: resolution.evidence }),
          associations: resolution.associations,
        })),
      },
      MAX_REGISTRY_BYTES,
    );
    return (
      serialized !== undefined &&
      Buffer.byteLength(serialized.json, "utf8") <= MAX_REGISTRY_BYTES
    );
  }

  private links(
    current: ReadonlyMap<string, CurrentRegistration>,
  ): Map<string, AssociationLink[]> {
    const links = new Map<string, AssociationLink[]>();
    for (const { resolution } of current.values())
      for (const association of resolution.associations) {
        const key = childKey(resolution.group.id, association.childId);
        const childLinks = links.get(key) ?? [];
        childLinks.push({
          groupId: resolution.group.id,
          childId: association.childId,
          resourceKey: association.resourceKey,
          itemKey: association.itemKey,
        });
        links.set(key, childLinks);
      }
    return links;
  }

  private groupSnapshot(
    group: GroupSnapshot,
    links: ReadonlyMap<string, readonly AssociationLink[]>,
    facts: AccessFacts | undefined,
  ): SubtaskAccessSnapshot["groups"][number] {
    const allLinks = [...links.values()].flat();
    const claimCounts = new Map<string, number>();
    for (const link of allLinks) {
      const key = resourceItemKey(link.resourceKey, link.itemKey);
      claimCounts.set(key, (claimCounts.get(key) ?? 0) + 1);
    }

    return {
      groupId: group.id,
      parentTaskId: group.parentTaskId,
      parentRevision: group.parentRevision,
      listRevision: group.listRevision,
      children: group.children.map((child) => {
        const childLinks = links.get(childKey(group.id, child.id)) ?? [];
        const link = childLinks.length === 1 ? childLinks[0] : undefined;
        if (!facts || !link)
          return {
            childId: child.id,
            status: "unavailable" as const,
            activeCallHashes: [],
          };
        const resourceItem = resourceItemKey(link.resourceKey, link.itemKey);
        const activeCallHashes = facts.active.get(resourceItem) ?? [];
        if (
          claimCounts.get(resourceItem) !== 1 ||
          !facts.mapped.has(resourceItem)
        )
          return {
            childId: child.id,
            status: "unavailable" as const,
            activeCallHashes: [],
          };
        if (activeCallHashes.length || facts.confirmed.has(resourceItem))
          return {
            childId: child.id,
            status: "observed" as const,
            activeCallHashes: [...activeCallHashes],
          };
        return {
          childId: child.id,
          status:
            facts.omissions > 0 ? ("unavailable" as const) : "no-observation",
          activeCallHashes: [],
        };
      }),
    };
  }
}
