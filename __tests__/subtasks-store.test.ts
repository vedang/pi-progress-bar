import { describe, expect, it } from "vitest";
import { SubtaskStore } from "../src/core/subtasks";
import {
  subtaskAdmission,
  subtaskParent,
  subtaskSource,
} from "./fixtures/subtasks";

// [ref:coverage_not_task_authority] These are validated semantic mutations;
// provider decisions and canonical reference resolution are upstream contracts.
function fixture() {
  const store = new SubtaskStore();
  const input = subtaskAdmission();
  expect(store.admit(input)).toEqual({ accepted: true });
  return { store, input, group: store.snapshot().groups[0] };
}

describe("generic conversation-backed subtask store", () => {
  it("creates meaningful pending children without a file, resource or tool receipt", () => {
    const input = subtaskAdmission();
    const original = structuredClone(input);
    const store = new SubtaskStore();
    expect(store.admit(input)).toEqual({ accepted: true });
    const group = store.snapshot().groups[0];
    expect(group).toMatchObject({
      parentTaskId: "task:1",
      parentRevision: 1,
      listRevision: 1,
      complete: false,
      children: input.children.map(({ label }) => ({
        label,
        status: "pending",
      })),
      retired: [],
    });
    expect(group.knownTotal).toBeUndefined();
    expect(group).not.toHaveProperty("resourceKey");
    expect(group).not.toHaveProperty("inventorySource");
    expect(new Set(group.children.map((child) => child.id)).size).toBe(2);
    expect(input).toEqual(original);
  });

  it("makes exact latest admission replay idempotent without reallocating IDs", () => {
    const { store, input } = fixture();
    const before = store.snapshot();
    expect(store.admit(structuredClone(input))).toEqual({ accepted: true });
    expect(store.snapshot()).toEqual(before);
  });

  it("returns detached snapshots and does not retain mutable input references", () => {
    const { store, input } = fixture();
    const before = store.snapshot();
    input.children[0].label = "Changed outside reducer";
    input.source.entryId = "forged";
    const snapshot = store.snapshot();
    snapshot.groups[0].children[0].label = "Changed snapshot";
    expect(store.snapshot()).toEqual(before);
  });

  it("extends a non-exhaustive tracked list without claiming complete inventory", () => {
    const { store, input, group } = fixture();
    expect(
      store.admit({
        ...input,
        expectedListRevision: group.listRevision,
        children: [
          ...group.children.map((child) => ({
            kind: "retain" as const,
            id: child.id,
          })),
          {
            kind: "add",
            label: "Explain recommendation assumptions",
            source: subtaskSource(),
          },
        ],
      }),
    ).toEqual({ accepted: true });
    const after = store.snapshot().groups[0];
    expect(after.children).toHaveLength(3);
    expect(after.complete).toBe(false);
    expect(after.knownTotal).toBeUndefined();
    expect(after.listRevision).toBe(2);
    expect(after.children.slice(0, 2).map((child) => child.id)).toEqual(
      group.children.map((child) => child.id),
    );
  });

  it("preserves IDs and reported completion through reorder and wording-only edit", () => {
    const { store, input, group } = fixture();
    expect(
      store.report({
        groupId: group.id,
        listRevision: 1,
        childIds: [group.children[0].id],
        source: subtaskSource("report", "Tradeoffs are compared."),
        status: "reported-completed",
      }),
    ).toEqual({ accepted: true });
    expect(
      store.admit({
        ...input,
        expectedListRevision: 1,
        children: [
          { kind: "retain", id: group.children[1].id },
          {
            kind: "reword",
            id: group.children[0].id,
            label: "Compare deployment tradeoffs",
            source: subtaskSource(
              "wording",
              "Call the comparison deployment tradeoffs.",
            ),
          },
        ],
      }),
    ).toEqual({ accepted: true });
    const after = store.snapshot().groups[0];
    expect(after.children[1]).toMatchObject({
      id: group.children[0].id,
      label: "Compare deployment tradeoffs",
      status: "reported-completed",
    });
    expect(after.children[0].id).toBe(group.children[1].id);
  });

  it("replaces an obligation with a new pending ID and retains retirement evidence", () => {
    const { store, input, group } = fixture();
    store.report({
      groupId: group.id,
      listRevision: 1,
      childIds: [group.children[0].id],
      source: subtaskSource("done", "Comparison complete."),
      status: "reported-completed",
    });
    expect(
      store.admit({
        ...input,
        expectedListRevision: 1,
        children: [
          {
            kind: "replace",
            id: group.children[0].id,
            label: "Compare revised operational requirements",
            source: subtaskSource(
              "replacement",
              "Replace the old comparison with revised requirements.",
            ),
          },
          { kind: "retain", id: group.children[1].id },
        ],
      }),
    ).toEqual({ accepted: true });
    const after = store.snapshot().groups[0];
    expect(after.children[0].id).not.toBe(group.children[0].id);
    expect(after.children[0].status).toBe("pending");
    expect(after.retired[0]).toMatchObject({
      id: group.children[0].id,
      retirement: { reason: "replaced" },
    });
  });

  it("rejects silent omission but accepts explicitly grounded removal", () => {
    const { store, input, group } = fixture();
    const before = store.snapshot();
    const update = {
      ...input,
      expectedListRevision: 1,
      children: [{ kind: "retain" as const, id: group.children[0].id }],
    };
    expect(store.admit(update).accepted).toBe(false);
    expect(store.snapshot()).toEqual(before);
    expect(
      store.admit({
        ...update,
        removals: [
          {
            id: group.children[1].id,
            reason: "withdrawn",
            source: subtaskSource(
              "withdrawal",
              "Do not write a recommendation after all.",
            ),
          },
        ],
      }),
    ).toEqual({ accepted: true });
    expect(store.snapshot().groups[0].retired[0].id).toBe(group.children[1].id);
  });

  it("rejects mixed foreign references and duplicate child use atomically", () => {
    const { store, input, group } = fixture();
    const before = store.snapshot();
    for (const id of ["subtask-child:999", group.children[0].id]) {
      expect(
        store.admit({
          ...input,
          expectedListRevision: 1,
          children: [
            { kind: "retain", id: group.children[0].id },
            { kind: "retain", id },
          ],
        }).accepted,
      ).toBe(false);
      expect(store.snapshot()).toEqual(before);
    }
  });

  it("rejects stale list proposals and old reports after list refinement", () => {
    const { store, input, group } = fixture();
    expect(
      store.admit({
        ...input,
        expectedListRevision: 1,
        children: group.children.map((child) => ({
          kind: "reword" as const,
          id: child.id,
          label: `${child.label} carefully`,
          source: subtaskSource("change", "Clarify the wording of both steps."),
        })),
      }).accepted,
    ).toBe(true);
    const before = store.snapshot();
    expect(store.admit(input).accepted).toBe(false);
    expect(
      store.report({
        groupId: group.id,
        listRevision: 1,
        childIds: [group.children[0].id],
        source: subtaskSource(),
        status: "reported-completed",
      }).accepted,
    ).toBe(false);
    expect(store.snapshot()).toEqual(before);
  });

  it("handles completed, blocked and explicit retraction without changing parent", () => {
    const { store, input, group } = fixture();
    const originalParent = structuredClone(input.parent);
    for (const status of [
      "reported-completed",
      "reported-blocked",
      "pending",
    ] as const) {
      expect(
        store.report({
          groupId: group.id,
          listRevision: 1,
          childIds: [group.children[0].id],
          source: subtaskSource(`report-${status}`, `Reported ${status}`),
          status,
        }),
      ).toEqual({ accepted: true });
      expect(store.snapshot().groups[0].children[0].status).toBe(status);
    }
    expect(store.snapshot().groups[0].children[1].status).toBe("pending");
    expect(input.parent).toEqual(originalParent);
  });

  it("retains DONE-parent pending children and stable provenance for wording changes", () => {
    const { store, input } = fixture();
    const before = store.snapshot();
    store.reconcile([
      {
        ...input.parent,
        status: "done",
        label: "Deployment recommendation",
        source: subtaskSource("wording", "Recommendation for deployment"),
      },
    ]);
    expect(store.snapshot()).toEqual(before);
    expect(
      store
        .snapshot()
        .groups[0].children.every((child) => child.status === "pending"),
    ).toBe(true);
  });

  it("invalidates changed parent requirements and rejects stale old admission", () => {
    const { store, input } = fixture();
    store.reconcile([{ ...input.parent, revision: 2 }]);
    expect(store.snapshot().groups).toHaveLength(0);
    expect(store.admit(input).accepted).toBe(false);
  });

  it("retains archived facts but forbids report mutation until included again", () => {
    const { store, input, group } = fixture();
    store.reconcile([{ ...input.parent, included: false }]);
    const before = store.snapshot();
    const report = {
      groupId: group.id,
      listRevision: 1,
      childIds: [group.children[0].id],
      source: subtaskSource(),
      status: "reported-completed" as const,
    };
    expect(store.report(report).accepted).toBe(false);
    expect(store.snapshot()).toEqual(before);
    store.reconcile([input.parent]);
    expect(store.report(report).accepted).toBe(true);
  });

  it("does not invent labels from a count and rejects inconsistent exhaustive totals", () => {
    const store = new SubtaskStore();
    expect(store.admit({ ...subtaskAdmission([]), knownTotal: 22 })).toEqual({
      accepted: true,
    });
    expect(store.snapshot().groups[0]).toMatchObject({
      complete: false,
      knownTotal: 22,
      children: [],
    });
    const other = new SubtaskStore();
    expect(
      other.admit({ ...subtaskAdmission(), complete: true, knownTotal: 22 })
        .accepted,
    ).toBe(false);
  });

  it("bounds active children and rejects raw provenance fields without partial mutation", () => {
    const store = new SubtaskStore();
    const before = store.snapshot();
    expect(
      store.admit(
        subtaskAdmission(Array.from({ length: 65 }, (_, i) => `Step ${i}`)),
      ),
    ).toEqual({ accepted: false, reason: "capacity" });
    expect(
      store.admit({
        ...subtaskAdmission(),
        source: { ...subtaskSource(), rawPrompt: "PRIVATE_SENTINEL" },
      }).accepted,
    ).toBe(false);
    expect(store.admit(subtaskAdmission(["bad\nlabel"])).accepted).toBe(false);
    expect(store.snapshot()).toEqual(before);
    expect(JSON.stringify(store.snapshot())).not.toContain("PRIVATE_SENTINEL");
  });

  it("retired replacement IDs count toward 200 retained children, not just active rows", () => {
    const store = new SubtaskStore();
    const input = subtaskAdmission(["Initial obligation"]);
    expect(store.admit(input).accepted).toBe(true);
    for (let n = 1; n < 200; n++) {
      const group = store.snapshot().groups[0];
      expect(
        store.admit({
          ...input,
          expectedListRevision: group.listRevision,
          children: [
            {
              kind: "replace",
              id: group.children[0].id,
              label: `Replacement obligation ${n}`,
              source: subtaskSource(
                `replace-${n}`,
                `Replace obligation with version ${n}.`,
              ),
            },
          ],
        }).accepted,
      ).toBe(true);
    }
    const before = store.snapshot();
    const group = before.groups[0];
    expect(group.children).toHaveLength(1);
    expect(group.retired).toHaveLength(199);
    expect(
      store.admit({
        ...input,
        expectedListRevision: group.listRevision,
        children: [
          {
            kind: "replace",
            id: group.children[0].id,
            label: "One too many",
            source: subtaskSource(),
          },
        ],
      }),
    ).toEqual({ accepted: false, reason: "capacity" });
    expect(store.snapshot()).toEqual(before);
  });

  it("keeps identical labels under different parents independent", () => {
    const { store, group } = fixture();
    expect(
      store.admit({
        ...subtaskAdmission(),
        parent: { ...subtaskParent(), id: "task:2" },
      }).accepted,
    ).toBe(true);
    const groups = store.snapshot().groups;
    expect(groups).toHaveLength(2);
    expect(groups[1].children[0].id).not.toBe(group.children[0].id);
    expect(
      store.report({
        groupId: group.id,
        listRevision: 1,
        childIds: [groups[1].children[0].id],
        source: subtaskSource(),
        status: "reported-completed",
      }).accepted,
    ).toBe(false);
  });
});
