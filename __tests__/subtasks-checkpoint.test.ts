import { describe, expect, it } from "vitest";
import { SubtaskStore, subtaskCheckpointIsValid } from "../src/core/subtasks";
import {
  subtaskAdmission,
  subtaskParent,
  subtaskSource,
} from "./fixtures/subtasks";

function fixture() {
  const store = new SubtaskStore();
  const admission = subtaskAdmission();
  expect(store.admit(admission)).toEqual({ accepted: true });
  const group = store.snapshot().groups[0];
  expect(
    store.report({
      groupId: group.id,
      listRevision: group.listRevision,
      childIds: [group.children[0].id],
      status: "reported-completed",
      source: subtaskSource("report", "The comparison is complete."),
    }),
  ).toEqual({ accepted: true });
  return { store, admission, group, parent: admission.parent };
}
const restore = (
  payload: unknown,
  parents = [subtaskParent()],
  sourceCurrent = (_source: ReturnType<typeof subtaskSource>) => true,
) => SubtaskStore.restore(payload, { parents, sourceCurrent });

describe("generic subtask store persistence primitives", () => {
  it("roundtrips generic provenance/status without tool or workbook receipts", () => {
    const { store, parent } = fixture();
    const payload = store.checkpoint();
    expect(subtaskCheckpointIsValid(payload)).toBe(true);
    expect(payload.version).toBe(1);
    expect(restore(payload, [parent])?.snapshot()).toEqual(store.snapshot());
    expect(JSON.stringify(payload)).toContain('"entryId":"report"');
    expect(JSON.stringify(payload)).not.toMatch(
      /resourceKey|inventorySource|toolCallId/,
    );
    const saved = JSON.stringify(payload);
    payload.groups[0].children[0].label = "Changed caller copy";
    expect(JSON.stringify(store.checkpoint())).toBe(saved);
  });
  it("preserves latest exact admission replay and allocator continuity", () => {
    const { store, admission, parent, group } = fixture();
    const payload = store.checkpoint();
    const restored = restore(payload, [parent, { ...parent, id: "task:2" }]);
    expect(restored).toBeDefined();
    expect(restored?.admit(admission)).toEqual({ accepted: true });
    expect(restored?.snapshot()).toEqual(store.snapshot());
    expect(
      restored?.admit({
        ...subtaskAdmission(["Other scoped child"]),
        parent: { ...parent, id: "task:2" },
      }),
    ).toEqual({ accepted: true });
    const added = restored?.snapshot().groups[1];
    expect(added?.id).not.toBe(group.id);
    expect(group.children.map((child) => child.id)).not.toContain(
      added?.children[0].id,
    );
  });
  it("preserves replacement/retirement identity and report provenance", () => {
    const { store, group, admission, parent } = fixture();
    expect(
      store.admit({
        ...admission,
        expectedListRevision: 1,
        source: subtaskSource("revision"),
        children: [
          {
            kind: "replace",
            id: group.children[0].id,
            label: "Replacement scope",
            source: subtaskSource("revision"),
          },
          { kind: "retain", id: group.children[1].id },
        ],
        removals: [],
      }),
    ).toEqual({ accepted: true });
    const restored = restore(store.checkpoint(), [parent]);
    expect(restored?.snapshot()).toEqual(store.snapshot());
    expect(restored?.snapshot().groups[0].retired[0].status).toBe(
      "reported-completed",
    );
  });
  it("drops only stale group authority and never reuses its allocated identities", () => {
    const { store, group, parent } = fixture();
    const second = { ...parent, id: "task:2", source: subtaskSource("other") };
    store.admit({
      ...subtaskAdmission(["Other child"]),
      parent: second,
      source: subtaskSource("other"),
      children: [
        { kind: "add", label: "Other child", source: subtaskSource("other") },
      ],
    });
    const payload = store.checkpoint();
    const third = { ...parent, id: "task:3", source: subtaskSource("third") };
    const restored = restore(
      payload,
      [parent, second, third],
      (source) => source.entryId !== "request",
    );
    expect(
      restored?.snapshot().groups.map((item) => item.parentTaskId),
    ).toEqual(["task:2"]);
    expect(
      restored?.report({
        groupId: group.id,
        listRevision: 1,
        childIds: [group.children[0].id],
        status: "pending",
        source: subtaskSource("report"),
      }),
    ).toEqual({ accepted: false, reason: "stale" });
    restored?.admit({ ...subtaskAdmission(["Third child"]), parent: third });
    expect(restored?.checkpoint().nextGroupId).toBeGreaterThan(
      payload.nextGroupId,
    );
  });
  it("stale report provenance resets only reported status, not valid list identity", () => {
    const { store, parent, group } = fixture();
    const restored = restore(
      store.checkpoint(),
      [parent],
      (source) => source.entryId !== "report",
    );
    expect(restored?.snapshot().groups[0].id).toBe(group.id);
    expect(restored?.snapshot().groups[0].children[0]).toMatchObject({
      id: group.children[0].id,
      status: "pending",
    });
    expect(restored?.snapshot().groups[0].children).toHaveLength(2);
  });
  it("restores complete current parent authority even for parents without groups", () => {
    const { store, parent } = fixture();
    const blocked = { ...parent, id: "task:2", revision: 2, included: false };
    const restored = restore(store.checkpoint(), [parent, blocked]);
    expect(
      restored?.admit({
        ...subtaskAdmission(),
        parent: { ...blocked, revision: 1, included: true },
      }),
    ).toEqual({ accepted: false, reason: "stale" });
  });
  it.each([
    "version",
    "extra",
    "allocator",
    "duplicate-group",
    "duplicate-child",
    "bad-status",
    "parent-revision",
  ])("rejects corrupt payload %s rather than repairing it", (mode) => {
    const { store } = fixture();
    const payload = store.checkpoint();
    if (mode === "version") Object.assign(payload, { version: 0 });
    if (mode === "extra") Object.assign(payload, { toolReceipt: {} });
    if (mode === "allocator") payload.nextChildId = 1;
    if (mode === "duplicate-group")
      payload.groups.push(structuredClone(payload.groups[0]));
    if (mode === "duplicate-child")
      payload.groups[0].children.push(
        structuredClone(payload.groups[0].children[0]),
      );
    if (mode === "bad-status")
      Object.assign(payload.groups[0].children[0], { status: "done" });
    if (mode === "parent-revision") payload.groups[0].parentRevision = -1;
    expect(subtaskCheckpointIsValid(payload)).toBe(false);
    expect(restore(payload)).toBeUndefined();
  });
  it("rejects hidden keys and serialization hooks without invoking them", () => {
    const { store } = fixture();
    const payload = store.checkpoint();
    let calls = 0;
    Object.defineProperty(payload, "toJSON", {
      enumerable: false,
      value: () => {
        calls++;
        return {};
      },
    });
    expect(subtaskCheckpointIsValid(payload)).toBe(false);
    expect(restore(payload)).toBeUndefined();
    expect(calls).toBe(0);
  });
  it("does not evict state when a serialized store exceeds64KiB", () => {
    const store = new SubtaskStore();
    for (let i = 1; i <= 4; i++) {
      const admission = subtaskAdmission(
        Array.from({ length: 50 }, (_, j) => `${i}:${j}:${"x".repeat(225)}`),
      );
      admission.parent = { ...admission.parent, id: `task:${i}` };
      expect(store.admit(admission)).toEqual({ accepted: true });
    }
    const before = store.snapshot();
    expect(store.checkpoint).toBeTypeOf("function");
    expect(() => store.checkpoint()).toThrow();
    expect(store.snapshot()).toEqual(before);
  });
});
