import { describe, expect, it } from "vitest";
import { CoverageStore } from "../src/core/coverage";
import {
  coverageInventory,
  coverageNames,
  coverageParent,
  coverageSource,
} from "./fixtures/coverage";

// [ref:coverage_not_task_authority] These inputs are already-admitted evidence;
// canonical/tool/model validation belongs to distinct adapter and monitor tests.
function fixture() {
  const store = new CoverageStore();
  const parent = coverageParent();
  expect(
    store.admit({
      parent,
      intent: coverageSource(),
      inventory: coverageInventory(),
    }),
  ).toEqual({ accepted: true });
  return { store, parent };
}

describe("one-level coverage store", () => {
  it("bounds count-only groups even when they consume no child slots", () => {
    const store = new CoverageStore();
    for (let i = 1; i <= 200; i++)
      expect(
        store.admit({
          parent: { ...coverageParent(), id: `task:${i}` },
          intent: coverageSource(),
          inventory: {
            ...coverageInventory([]),
            complete: false,
            knownTotal: 22,
          },
        }).accepted,
      ).toBe(true);
    expect(
      store.admit({
        parent: { ...coverageParent(), id: "task:201" },
        intent: coverageSource(),
        inventory: {
          ...coverageInventory([]),
          complete: false,
          knownTotal: 22,
        },
      }),
    ).toEqual({ accepted: false, reason: "capacity" });
    expect(store.snapshot().groups).toHaveLength(200);
  });
  it("does not retain two requirements revisions for one parent", () => {
    const { store, parent } = fixture();
    const revisionTwo = { ...parent, revision: 2 };
    expect(
      store.admit({
        parent: revisionTwo,
        intent: coverageSource(),
        inventory: coverageInventory(),
      }).accepted,
    ).toBe(true);
    expect(store.snapshot().groups).toHaveLength(1);
    expect(store.snapshot().groups[0].parentRevision).toBe(2);
    expect(
      store.admit({
        parent,
        intent: coverageSource(),
        inventory: coverageInventory(),
      }).accepted,
    ).toBe(false);
    expect(store.snapshot().groups).toHaveLength(1);
  });
  it("does not copy undeclared raw evidence in source references", () => {
    const store = new CoverageStore();
    const intent = { ...coverageSource(), rawPrompt: "PRIVATE_SENTINEL" };
    const admission = store.admit({
      parent: coverageParent(),
      intent,
      inventory: coverageInventory(),
    });
    expect(admission.accepted).toBe(false);
    expect(JSON.stringify(store.snapshot())).not.toContain("PRIVATE_SENTINEL");
  });
  it("keeps count-only scope explicit without inventing children", () => {
    const store = new CoverageStore();
    expect(
      store.admit({
        parent: coverageParent(),
        intent: coverageSource(),
        inventory: {
          ...coverageInventory([]),
          complete: false,
          knownTotal: 22,
        },
      }).accepted,
    ).toBe(true);
    expect(store.snapshot().groups[0]).toMatchObject({
      children: [],
      knownTotal: 22,
      complete: false,
    });
    expect(store.snapshot().groups[0].omissions.length).toBeGreaterThan(0);
  });
  it("rejects conflicting count and complete inventory", () => {
    const store = new CoverageStore();
    expect(
      store.admit({
        parent: coverageParent(),
        intent: coverageSource(),
        inventory: { ...coverageInventory(), knownTotal: 23 },
      }).accepted,
    ).toBe(false);
    expect(store.snapshot().groups).toEqual([]);
  });
  it("rejects competing resources under the same parent", () => {
    const { store, parent } = fixture();
    const before = store.snapshot();
    expect(
      store.admit({
        parent,
        intent: coverageSource(),
        inventory: { ...coverageInventory(), resourceKey: "other.xlsx" },
      }).accepted,
    ).toBe(false);
    expect(store.snapshot()).toEqual(before);
  });
  it("requires explicit removal and never completes a removed item", () => {
    const { store, parent } = fixture();
    const before = store.snapshot();
    const inventory = {
      ...coverageInventory(),
      revision: 2,
      items: coverageInventory().items.slice(1),
    };
    expect(
      store.admit({ parent, intent: coverageSource(), inventory }).accepted,
    ).toBe(false);
    expect(store.snapshot()).toEqual(before);
    expect(
      store.admit({
        parent,
        intent: coverageSource(),
        inventory: { ...inventory, replacement: true },
      }).accepted,
    ).toBe(true);
    expect(
      store.snapshot().groups[0].children.map((child) => child.id),
    ).toEqual(before.groups[0].children.slice(1).map((child) => child.id));
    expect(store.snapshot().groups[0].omissions.length).toBeGreaterThan(0);
  });
  it("resource replacement cannot transfer reviewed status or child IDs", () => {
    const { store, parent } = fixture();
    const group = store.snapshot().groups[0];
    store.report({
      groupId: group.id,
      inventoryRevision: group.inventoryRevision,
      childIds: [group.children[0].id],
      source: coverageSource("report"),
      status: "reported-reviewed",
    });
    expect(
      store.admit({
        parent,
        intent: coverageSource(),
        inventory: {
          ...coverageInventory(),
          resourceKey: "other.xlsx",
          revision: 2,
          replacement: true,
        },
      }).accepted,
    ).toBe(true);
    const next = store.snapshot().groups[0];
    expect(next.children.every((child) => child.status === "pending")).toBe(
      true,
    );
    expect(
      next.children.some((child) =>
        group.children.some((old) => old.id === child.id),
      ),
    ).toBe(false);
  });
  it("caps retained children at200across groups without evicting admitted work", () => {
    const store = new CoverageStore();
    for (let i = 1; i <= 4; i++) {
      expect(
        store.admit({
          parent: { ...coverageParent(), id: `task:${i}` },
          intent: coverageSource(),
          inventory: coverageInventory(
            Array.from({ length: 50 }, (_, j) => `Item ${j}`),
          ),
        }).accepted,
      ).toBe(true);
    }
    const before = store.snapshot();
    expect(
      store.admit({
        parent: { ...coverageParent(), id: "task:5" },
        intent: coverageSource(),
        inventory: coverageInventory(["overflow"]),
      }),
    ).toEqual({ accepted: false, reason: "capacity" });
    expect(store.snapshot()).toEqual(before);
  });
  it("rejects241scalar labels and wrong-source hashes", () => {
    const store = new CoverageStore();
    expect(
      store.admit({
        parent: coverageParent(),
        intent: coverageSource(),
        inventory: coverageInventory(["a".repeat(241)]),
      }).accepted,
    ).toBe(false);
    expect(
      store.admit({
        parent: coverageParent(),
        intent: { ...coverageSource(), messageHash: "not-a-hash" },
        inventory: coverageInventory(),
      }).accepted,
    ).toBe(false);
    expect(store.snapshot().groups).toEqual([]);
  });
  it("rejects conflicting same-revision updates and aliases from input mutation", () => {
    const store = new CoverageStore();
    const parent = coverageParent();
    const inventory = coverageInventory();
    store.admit({ parent, intent: coverageSource(), inventory });
    inventory.items[0].label = "changed";
    expect(store.snapshot().groups[0].children[0].label).toBe("Overview");
    expect(
      store.admit({ parent, intent: coverageSource(), inventory }).accepted,
    ).toBe(false);
  });
  it("archived parents keep facts but reject new reports until restored", () => {
    const { store, parent } = fixture();
    const group = store.snapshot().groups[0];
    const report = {
      groupId: group.id,
      inventoryRevision: group.inventoryRevision,
      childIds: [group.children[0].id],
      source: coverageSource("report"),
      status: "reported-blocked" as const,
    };
    store.reconcile([{ ...parent, included: false }]);
    expect(store.report(report).accepted).toBe(false);
    store.reconcile([parent]);
    expect(store.report(report).accepted).toBe(true);
  });
  it("admits22pending children without mutating its parent", () => {
    const parent = coverageParent();
    const before = structuredClone(parent);
    const store = new CoverageStore();
    store.admit({
      parent,
      intent: coverageSource(),
      inventory: coverageInventory(),
    });
    expect(parent).toEqual(before);
    const [group] = store.snapshot().groups;
    expect(group.parentTaskId).toBe("task:1");
    expect(group.children.map((child) => child.label)).toEqual(coverageNames);
    expect(group.children.every((child) => child.status === "pending")).toBe(
      true,
    );
    expect(new Set(group.children.map((child) => child.id)).size).toBe(22);
  });
  it("deduplicates identical inventories without changing IDs", () => {
    const { store, parent } = fixture();
    const before = store.snapshot();
    store.admit({
      parent,
      intent: coverageSource(),
      inventory: coverageInventory(),
    });
    expect(store.snapshot()).toEqual(before);
  });
  it("preserves child IDs across reorder, not position-based identity", () => {
    const { store, parent } = fixture();
    const first = store.snapshot().groups[0];
    const inventory = coverageInventory();
    inventory.items.reverse();
    inventory.revision = 2;
    store.admit({ parent, intent: coverageSource(), inventory });
    const next = store.snapshot().groups[0];
    expect(next.children.map((child) => child.id)).toEqual(
      first.children.map((child) => child.id).reverse(),
    );
  });
  it("does not expose mutable aliases through snapshots", () => {
    const { store } = fixture();
    const snapshot = store.snapshot();
    snapshot.groups[0].children[0].label = "corrupted";
    expect(store.snapshot().groups[0].children[0].label).toBe("Overview");
  });
  it("rejects65items atomically with explicit capacity", () => {
    const { store, parent } = fixture();
    const before = store.snapshot();
    const inventory = coverageInventory(
      Array.from({ length: 65 }, (_, i) => `Item ${i}`),
    );
    inventory.revision = 2;
    expect(
      store.admit({ parent, intent: coverageSource(), inventory }),
    ).toEqual({ accepted: false, reason: "capacity" });
    expect(store.snapshot()).toEqual(before);
  });
  it("rejects duplicate item keys and control-bearing labels", () => {
    for (const items of [
      [
        { key: "same", label: "A" },
        { key: "same", label: "B" },
      ],
      [{ key: "a", label: "bad\u001b[31m" }],
    ]) {
      const store = new CoverageStore();
      expect(
        store.admit({
          parent: coverageParent(),
          intent: coverageSource(),
          inventory: { ...coverageInventory(), items },
        }),
      ).toEqual({ accepted: false, reason: "invalid" });
      expect(store.snapshot().groups).toEqual([]);
    }
  });
  it("keeps same-label worksheets in different resources separate", () => {
    const { store } = fixture();
    const parent = { ...coverageParent(), id: "task:2" };
    store.admit({
      parent,
      intent: coverageSource(),
      inventory: { ...coverageInventory(), resourceKey: "docs/other.xlsx" },
    });
    const groups = store.snapshot().groups;
    expect(groups).toHaveLength(2);
    expect(groups[0].children[0].id).not.toBe(groups[1].children[0].id);
  });
  it("allows reported review/retraction without changing parent status", () => {
    const { store, parent } = fixture();
    const group = store.snapshot().groups[0];
    const report = {
      groupId: group.id,
      inventoryRevision: group.inventoryRevision,
      childIds: [group.children[0].id],
      source: {
        ...coverageSource("report", "Overview reviewed"),
        role: "assistant" as const,
      },
      status: "reported-reviewed" as const,
    };
    expect(store.report(report)).toEqual({ accepted: true });
    expect(store.snapshot().groups[0].children[0].status).toBe(
      "reported-reviewed",
    );
    expect(parent.status).toBe("not-started");
    expect(
      store.report({
        ...report,
        source: {
          ...coverageSource("retract", "Overview unfinished"),
          role: "assistant" as const,
        },
        status: "pending",
      }),
    ).toEqual({ accepted: true });
    expect(store.snapshot().groups[0].children[0].status).toBe("pending");
  });
  it("fences stale inventory reports and rejects foreign child IDs atomically", () => {
    const { store } = fixture();
    const group = store.snapshot().groups[0];
    for (const patch of [
      { inventoryRevision: 0, childIds: [group.children[0].id] },
      { inventoryRevision: 1, childIds: [group.children[0].id, "foreign"] },
    ]) {
      expect(
        store.report({
          groupId: group.id,
          source: coverageSource("report"),
          status: "reported-reviewed",
          ...patch,
        }).accepted,
      ).toBe(false);
      expect(
        store
          .snapshot()
          .groups[0].children.every((child) => child.status === "pending"),
      ).toBe(true);
    }
  });
  it("retains children when parent completes and invalidates on changed requirements", () => {
    const { store, parent } = fixture();
    store.reconcile([{ ...parent, status: "done" }]);
    expect(
      store
        .snapshot()
        .groups[0].children.every((child) => child.status === "pending"),
    ).toBe(true);
    store.reconcile([{ ...parent, revision: 2 }]);
    expect(store.snapshot().groups).toEqual([]);
  });
  it("retains IDs on wording-only edits and archive/restore", () => {
    const { store, parent } = fixture();
    const ids = store.snapshot().groups[0].children.map((child) => child.id);
    store.reconcile([
      { ...parent, label: "Workbook summary", included: false },
    ]);
    expect(
      store.snapshot().groups[0].children.map((child) => child.id),
    ).toEqual(ids);
    store.reconcile([parent]);
    expect(
      store.snapshot().groups[0].children.map((child) => child.id),
    ).toEqual(ids);
  });
});
