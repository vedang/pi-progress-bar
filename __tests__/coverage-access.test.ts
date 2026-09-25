import { expect, it } from "vitest";
import { CoverageStore } from "../src/core/coverage";
import {
  coverageInventory,
  coverageParent,
  coverageSource,
} from "./fixtures/coverage";

it("persists observed access separately from reported review with canonical tool receipts", () => {
  const store = new CoverageStore();
  const parent = coverageParent();
  const inventory = coverageInventory();
  store.admit({ parent, inventory, intent: coverageSource() });
  const group = store.snapshot().groups[0];
  const source = {
    ...inventory.source,
    entryId: "read-result",
    callId: "read-call",
  };
  expect(
    store.access({
      groupId: group.id,
      inventoryRevision: group.inventoryRevision,
      childIds: [group.children[0].id],
      source,
    }).accepted,
  ).toBe(true);
  expect(store.snapshot().groups[0].children[0]).toMatchObject({
    accessed: true,
    status: "pending",
  });
  expect(parent.status).toBe("not-started");
  const durable = store.checkpoint();
  expect(JSON.stringify(durable)).not.toContain("read-call");
  expect(
    CoverageStore.restore(durable, {
      parents: [parent],
      sourceCurrent: () => true,
    })?.snapshot().groups[0].children[0],
  ).toMatchObject({ accessed: true, status: "pending" });
  expect(
    CoverageStore.restore(durable, {
      parents: [parent],
      sourceCurrent: (ref) => ref.entryId !== "read-result",
    })?.snapshot().groups[0].children[0],
  ).toMatchObject({ accessed: false, status: "pending" });
});
it("rejects mixed foreign or stale access batches atomically", () => {
  const store = new CoverageStore();
  const parent = coverageParent();
  const inventory = coverageInventory();
  store.admit({ parent, inventory, intent: coverageSource() });
  const group = store.snapshot().groups[0];
  const before = store.checkpoint();
  for (const input of [
    {
      inventoryRevision: group.inventoryRevision,
      childIds: [group.children[0].id, "foreign"],
    },
    {
      inventoryRevision: group.inventoryRevision + 1,
      childIds: [group.children[0].id],
    },
  ])
    expect(
      store.access({ groupId: group.id, source: inventory.source, ...input })
        .accepted,
    ).toBe(false);
  expect(store.checkpoint()).toEqual(before);
});
