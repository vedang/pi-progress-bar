import { describe, expect, it } from "vitest";
import { CoverageStore } from "../src/core/coverage";
import {
  checkpointStorageStatus,
  encodeCheckpoint,
  monitorCheckpointMetadata,
  restoreCheckpoint,
} from "../src/core/hybrid-checkpoint";
import {
  coverageInventory,
  coverageParent,
  coverageSource,
} from "./fixtures/coverage";
import { initial, initialMessage } from "./fixtures/hybrid";

function fixture() {
  const store = new CoverageStore();
  const parent = coverageParent();
  store.admit({
    parent,
    intent: coverageSource(),
    inventory: coverageInventory(),
  });
  const group = store.snapshot().groups[0];
  store.report({
    groupId: group.id,
    inventoryRevision: group.inventoryRevision,
    childIds: [group.children[0].id],
    source: coverageSource("review"),
    status: "reported-reviewed",
  });
  return { store, parent, group };
}
const usage = () => ({
  jev: { calls: 0, inputTokens: 0, outputTokens: 0 },
  extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
});

describe("durable coverage projections", () => {
  it("roundtrips receipts and stable IDs without exposing a mutable alias", () => {
    const { store, parent } = fixture();
    const payload = store.checkpoint();
    const restored = CoverageStore.restore(payload, {
      parents: [parent],
      sourceCurrent: () => true,
    });
    expect(restored?.snapshot()).toEqual(store.snapshot());
    expect(JSON.stringify(payload)).toContain("review");
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("manifest-call");
    expect(serialized).not.toContain("inventorySignature");
    const other = structuredClone(payload);
    const second = CoverageStore.restore(other, {
      parents: [parent],
      sourceCurrent: () => true,
    });
    expect(second?.snapshot()).toEqual(store.snapshot());
  });
  it("restores allocator continuity rather than reusing IDs", () => {
    const { store, parent, group } = fixture();
    const restored = CoverageStore.restore(store.checkpoint(), {
      parents: [parent],
      sourceCurrent: () => true,
    });
    expect(restored).toBeDefined();
    restored?.admit({
      parent: { ...parent, id: "task:2" },
      intent: coverageSource(),
      inventory: coverageInventory(),
    });
    const groups = restored?.snapshot().groups ?? [];
    expect(groups).toHaveLength(2);
    expect(groups[1].id).not.toBe(group.id);
    expect(
      groups[1].children.some((child) =>
        group.children.some((old) => old.id === child.id),
      ),
    ).toBe(false);
  });
  it("drops stale inventory or intent locally, without modifying parent", () => {
    const { store, parent } = fixture();
    for (const id of ["inventory", "intent"]) {
      const restored = CoverageStore.restore(store.checkpoint(), {
        parents: [parent],
        sourceCurrent: (source) => source.entryId !== id,
      });
      expect(restored?.snapshot().groups).toEqual([]);
      expect(parent.status).toBe("not-started");
    }
  });
  it("invalidates stale child report without losing valid inventory", () => {
    const { store, parent } = fixture();
    const restored = CoverageStore.restore(store.checkpoint(), {
      parents: [parent],
      sourceCurrent: (source) => source.entryId !== "review",
    });
    expect(restored?.snapshot().groups).toHaveLength(1);
    expect(restored?.snapshot().groups[0].children[0].status).toBe("pending");
    expect(restored?.snapshot().groups[0].children).toHaveLength(22);
  });
  it("rejects structural garbage and hidden raw payload fields", () => {
    const { store, parent } = fixture();
    for (const data of [
      null,
      [],
      {},
      { ...store.checkpoint(), rawOutput: "PRIVATE" },
    ]) {
      expect(
        CoverageStore.restore(data, {
          parents: [parent],
          sourceCurrent: () => true,
        }),
      ).toBeUndefined();
    }
  });
  it("fences changed parent requirements on restore", () => {
    const { store, parent } = fixture();
    const restored = CoverageStore.restore(store.checkpoint(), {
      parents: [{ ...parent, revision: 2 }],
      sourceCurrent: () => true,
    });
    expect(restored?.snapshot().groups).toEqual([]);
  });
});

describe("strictv10 optional coverage metadata", () => {
  async function checkpointFixture() {
    const state = await initial();
    const store = new CoverageStore();
    store.admit({
      parent: state.tasks[0],
      intent: state.tasks[0].source,
      inventory: coverageInventory(),
    });
    const coverage = {
      state: store.checkpoint(),
      dispatches: 0,
      usage: usage(),
    };
    const metadata = { enabled: true, usage: usage(), coverage };
    return { state, metadata, coverage };
  }
  it("accepts bounded coverage with parent semantics unchanged", async () => {
    const { state, metadata } = await checkpointFixture();
    const cp = encodeCheckpoint(state, metadata);
    expect(cp.version).toBe(10);
    expect(checkpointStorageStatus(cp)).toBe("supported");
    expect(monitorCheckpointMetadata(cp)?.coverage).toEqual(metadata.coverage);
    expect(
      restoreCheckpoint(
        cp,
        "session:test",
        (id) => (id === initialMessage.id ? initialMessage : undefined),
        () => [],
      ),
    ).toEqual(state);
    expect(cp.state.tasks).toHaveLength(3);
    expect(monitorCheckpointMetadata(cp)?.healthCards).toBeUndefined();
  });
  it("rejectsv9without migration even when otherwise well-formed", async () => {
    const { state, metadata } = await checkpointFixture();
    const cp = { ...encodeCheckpoint(state, metadata), version: 9 };
    expect(checkpointStorageStatus(cp)).toBe("unsupported");
    expect(monitorCheckpointMetadata(cp)).toBeUndefined();
  });
  it("caps optional coverage bytes and never accepts raw provider envelopes", async () => {
    const { state, metadata } = await checkpointFixture();
    for (const coverage of [
      { ...metadata.coverage, rawProvider: "PRIVATE" },
      { ...metadata.coverage, padding: "x".repeat(65536) },
    ]) {
      expect(() =>
        encodeCheckpoint(state, { ...metadata, coverage }),
      ).toThrow();
    }
  });
  it("rejects a genuinely oversized optional projection without changing parent state", async () => {
    const state = await initial();
    const before = structuredClone(state);
    const store = new CoverageStore();
    for (const parent of state.tasks) {
      expect(
        store.admit({
          parent,
          intent: parent.source,
          inventory: coverageInventory(
            Array.from({ length: 60 }, (_, i) => `${i}-${"x".repeat(220)}`),
          ),
        }).accepted,
      ).toBe(true);
      const group = store
        .snapshot()
        .groups.find((item) => item.parentTaskId === parent.id);
      if (!group) throw new Error("Missing group");
      for (const [i, child] of group.children.entries())
        store.report({
          groupId: group.id,
          inventoryRevision: group.inventoryRevision,
          childIds: [child.id],
          source: coverageSource(`report-${parent.id}-${i}`),
          status: "reported-reviewed",
        });
    }
    expect(() =>
      encodeCheckpoint(state, {
        enabled: true,
        usage: usage(),
        coverage: { state: store.checkpoint(), dispatches: 0, usage: usage() },
      }),
    ).toThrow();
    expect(state).toEqual(before);
  });
  it("validates coverage dispatch cap and exact provider counters", async () => {
    const { state, metadata } = await checkpointFixture();
    for (const dispatches of [-1, 1025, 1.5]) {
      expect(() =>
        encodeCheckpoint(state, {
          ...metadata,
          coverage: { ...metadata.coverage, dispatches },
        }),
      ).toThrow();
    }
    const coverage = {
      ...metadata.coverage,
      dispatches: 1024,
      usage: {
        ...usage(),
        jev: { calls: 1024, inputTokens: 2, outputTokens: 1 },
      },
    };
    expect(
      checkpointStorageStatus(
        encodeCheckpoint(state, { ...metadata, coverage }),
      ),
    ).toBe("supported");
    expect(() =>
      encodeCheckpoint(state, {
        ...metadata,
        coverage: { ...coverage, dispatches: 1023 },
      }),
    ).toThrow();
  });
  it("fits bothONandOFF and returns detached metadata", async () => {
    const { state, metadata } = await checkpointFixture();
    for (const enabled of [true, false]) {
      const cp = encodeCheckpoint(state, { ...metadata, enabled });
      expect(Buffer.byteLength(JSON.stringify(cp))).toBeLessThanOrEqual(
        512 * 1024,
      );
      const read = monitorCheckpointMetadata(cp);
      if (!read?.coverage) throw new Error("missing coverage");
      read.coverage.dispatches = 999;
      expect(monitorCheckpointMetadata(cp)?.coverage?.dispatches).toBe(0);
    }
  });
});
