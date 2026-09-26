import { describe, expect, it, vi } from "vitest";
import { SubtaskStore } from "../src/core/subtasks";
import {
  subtaskAdmission,
  subtaskHash,
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

function byteBoundAdmission(bytes: number) {
  const input = subtaskAdmission(
    Array.from({ length: 32 }, (_, i) => `Step ${i}: `),
  );
  let remaining = bytes - Buffer.byteLength(JSON.stringify(input), "utf8");
  if (remaining < 0) throw new Error("Byte fixture base already too large");
  for (const child of input.children) {
    const scalars = Array.from(child.label).length;
    const astral = Math.min(240 - scalars, Math.floor(remaining / 4));
    child.label += "😀".repeat(astral);
    remaining -= astral * 4;
    const ascii = Math.min(240 - Array.from(child.label).length, remaining);
    child.label += "x".repeat(ascii);
    remaining -= ascii;
  }
  expect(remaining).toBe(0);
  expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBe(bytes);
  expect(
    input.children.every((child) => Array.from(child.label).length <= 240),
  ).toBe(true);
  return input;
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
      parentSourceDigest: subtaskHash(
        JSON.stringify([
          input.parent.source.entryId,
          input.parent.source.messageHash,
          input.parent.source.role,
          input.parent.source.start,
          input.parent.source.end,
          input.parent.source.quoteHash,
        ]),
      ),
      source: input.source,
      proof: input.proof,
      complete: false,
      children: input.children.map(({ label, source }) => ({
        label,
        source,
        status: "pending",
      })),
      retired: [],
    });
    expect(group.knownTotal).toBeUndefined();
    expect(Array.isArray(group.omissions)).toBe(true);
    expect(group.omissions.length).toBeGreaterThan(0);
    expect(group).not.toHaveProperty("resourceKey");
    expect(group).not.toHaveProperty("inventorySource");
    expect(new Set(group.children.map((child) => child.id)).size).toBe(2);
    expect(input).toEqual(original);
  });

  it("rejects first-admission foreign removals without creating a group or spending IDs", () => {
    const { store, input, group } = fixture();
    const before = store.snapshot();
    const next = {
      ...subtaskAdmission(["New parent obligation"]),
      parent: { ...input.parent, id: "task:2" },
    };
    expect(
      store.admit({
        ...next,
        removals: [
          {
            id: group.children[0].id,
            source: subtaskSource(),
            reason: "withdrawn",
          },
        ],
      }),
    ).toEqual({ accepted: false, reason: "foreign" });
    expect(store.snapshot()).toEqual(before);
    expect(store.admit(next)).toEqual({ accepted: true });
    expect(store.snapshot().groups[1]).toMatchObject({
      id: "subtask-group:2",
      children: [{ id: "subtask-child:3" }],
    });
  });

  it("rejects a new empty unknown-scope group instead of manufacturing a sidecar", () => {
    const store = new SubtaskStore();
    const before = store.snapshot();
    expect(store.admit(subtaskAdmission([]))).toEqual({
      accepted: false,
      reason: "invalid",
    });
    expect(store.snapshot()).toEqual(before);
    expect(store.admit(subtaskAdmission())).toEqual({ accepted: true });
    expect(store.snapshot().groups[0].id).toBe("subtask-group:1");
  });

  it.each(["revision", "archive", "absence"])(
    "fences first or delayed admission after authoritative reconciliation (%s)",
    (kind) => {
      const store = new SubtaskStore();
      const input = subtaskAdmission();
      if (kind === "absence") {
        expect(store.admit(input)).toEqual({ accepted: true });
        store.reconcile([]);
      } else
        store.reconcile([
          {
            ...input.parent,
            ...(kind === "revision" ? { revision: 2 } : { included: false }),
          },
        ]);
      const before = store.snapshot();
      expect(store.admit(input)).toEqual({ accepted: false, reason: "stale" });
      expect(store.snapshot()).toEqual(before);
    },
  );

  it("classifies a previously allocated invalidated group report as stale", () => {
    const { store, input, group } = fixture();
    store.reconcile([{ ...input.parent, revision: 2 }]);
    const before = store.snapshot();
    expect(
      store.report({
        groupId: group.id,
        listRevision: 1,
        childIds: [group.children[0].id],
        source: subtaskSource(),
        status: "reported-completed",
      }),
    ).toEqual({ accepted: false, reason: "stale" });
    expect(store.snapshot()).toEqual(before);
    expect(
      store.report({
        groupId: "subtask-group:999",
        listRevision: 1,
        childIds: [group.children[0].id],
        source: subtaskSource(),
        status: "reported-completed",
      }),
    ).toEqual({ accepted: false, reason: "foreign" });
  });

  it.each(["hidden", "inherited"])(
    "rejects caller serialization hooks before byte accounting (%s)",
    (kind) => {
      const store = new SubtaskStore();
      const input = byteBoundAdmission(32769);
      const hook = vi.fn(() => ({}));
      if (kind === "hidden")
        Object.defineProperty(input, "toJSON", { value: hook });
      else Object.setPrototypeOf(input, { toJSON: hook });
      const before = store.snapshot();
      expect(store.admit(input)).toEqual({
        accepted: false,
        reason: "invalid",
      });
      expect(hook).not.toHaveBeenCalled();
      expect(store.snapshot()).toEqual(before);
    },
  );

  it("does not let a hidden serializer forge exact-latest replay", () => {
    const { store, input } = fixture();
    const forged = {
      ...subtaskAdmission(["Different work"]),
      expectedListRevision: 99,
    };
    const hook = vi.fn(() => input);
    Object.defineProperty(forged, "toJSON", { value: hook });
    const before = store.snapshot();
    expect(store.admit(forged)).toEqual({ accepted: false, reason: "invalid" });
    expect(hook).not.toHaveBeenCalled();
    expect(store.snapshot()).toEqual(before);
  });

  it("rejects sparse report batches without advancing the valid prefix", () => {
    const { store, group } = fixture();
    const childIds = Array<string>(2);
    childIds[0] = group.children[0].id;
    const before = store.snapshot();
    expect(
      store.report({
        groupId: group.id,
        listRevision: 1,
        childIds,
        source: subtaskSource(),
        status: "reported-completed",
      }),
    ).toEqual({ accepted: false, reason: "invalid" });
    expect(store.snapshot()).toEqual(before);
  });

  it.each(["children", "removals"])(
    "rejects oversized operation arrays before reading elements (%s)",
    (field) => {
      const input = subtaskAdmission();
      const values = Array(65).fill(undefined);
      const read = vi.fn(() => {
        throw new Error("Must reject length before access");
      });
      Object.defineProperty(values, 0, { get: read });
      const store = new SubtaskStore();
      const before = store.snapshot();
      expect(store.admit({ ...input, [field]: values })).toEqual({
        accepted: false,
        reason: "capacity",
      });
      expect(read).not.toHaveBeenCalled();
      expect(store.snapshot()).toEqual(before);
    },
  );

  it("bounds report length before reading child IDs", () => {
    const { store, group } = fixture();
    const childIds = Array<string>(65).fill(group.children[0].id);
    const read = vi.fn(() => {
      throw new Error("Must reject length before access");
    });
    Object.defineProperty(childIds, 0, { get: read });
    const before = store.snapshot();
    expect(
      store.report({
        groupId: group.id,
        listRevision: 1,
        childIds,
        source: subtaskSource(),
        status: "reported-completed",
      }),
    ).toEqual({ accepted: false, reason: "invalid" });
    expect(read).not.toHaveBeenCalled();
    expect(store.snapshot()).toEqual(before);
  });

  it("rejects oversized labels without materializing all scalar values", () => {
    const label = "x".repeat(100000);
    const input = subtaskAdmission([label]);
    const store = new SubtaskStore();
    const expand = vi.spyOn(Array, "from");
    let expanded = false;
    let result;
    try {
      result = store.admit(input);
      expanded = expand.mock.calls.some((args) => args[0] === label);
    } finally {
      expand.mockRestore();
    }
    expect(result).toEqual({ accepted: false, reason: "capacity" });
    expect(expanded).toBe(false);
    expect(store.snapshot()).toEqual({ groups: [] });
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
    input.proof.gateRequestHash = subtaskHash("mutated input proof");
    input.children[0].source.entryId = "mutated child source";
    const snapshot = store.snapshot();
    snapshot.groups[0].children[0].label = "Changed snapshot";
    snapshot.groups[0].source.entryId = "mutated group source";
    snapshot.groups[0].proof.proposalRequestHash = subtaskHash(
      "mutated snapshot proof",
    );
    snapshot.groups[0].children[0].source.entryId =
      "mutated snapshot child source";
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
      source: subtaskSource(
        "wording",
        "Call the comparison deployment tradeoffs.",
      ),
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
    expect(after.children[0].source).toEqual(
      subtaskSource(
        "replacement",
        "Replace the old comparison with revised requirements.",
      ),
    );
    expect(after.retired[0]).toEqual({
      ...group.children[0],
      status: "reported-completed",
      retirement: {
        reason: "replaced",
        source: subtaskSource(
          "replacement",
          "Replace the old comparison with revised requirements.",
        ),
      },
    });
    const retained = store.snapshot();
    after.retired[0].source.entryId = "mutated retired obligation source";
    after.retired[0].retirement.source.entryId = "mutated retirement source";
    expect(store.snapshot()).toEqual(retained);
  });

  it("rejects silent omission but accepts explicitly grounded removal", () => {
    const { store, input, group } = fixture();
    const before = store.snapshot();
    const update = {
      ...input,
      expectedListRevision: 1,
      children: [{ kind: "retain" as const, id: group.children[0].id }],
    };
    expect(store.admit(update)).toEqual({ accepted: false, reason: "invalid" });
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

  it("rejects nonexistent references and duplicate child use atomically", () => {
    const { store, input, group } = fixture();
    const before = store.snapshot();
    for (const [id, reason] of [
      ["subtask-child:999", "foreign"],
      [group.children[0].id, "invalid"],
    ] as const) {
      expect(
        store.admit({
          ...input,
          expectedListRevision: 1,
          children: [
            { kind: "retain", id: group.children[0].id },
            { kind: "retain", id },
          ],
        }),
      ).toEqual({ accepted: false, reason });
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
    expect(store.admit(input)).toEqual({ accepted: false, reason: "stale" });
    expect(
      store.report({
        groupId: group.id,
        listRevision: 1,
        childIds: [group.children[0].id],
        source: subtaskSource(),
        status: "reported-completed",
      }),
    ).toEqual({ accepted: false, reason: "stale" });
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
    expect(store.admit(input)).toEqual({ accepted: false, reason: "stale" });
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
    expect(store.report(report)).toEqual({ accepted: false, reason: "stale" });
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
      other.admit({ ...subtaskAdmission(), complete: true, knownTotal: 22 }),
    ).toEqual({ accepted: false, reason: "invalid" });
  });

  it.each([
    { complete: true, knownTotal: undefined, accepted: true },
    { complete: true, knownTotal: 2, accepted: true },
    { complete: false, knownTotal: 2, accepted: true },
    { complete: false, knownTotal: 1, accepted: false },
  ])(
    "validates exhaustive and incomplete totals ($complete/$knownTotal)",
    ({ complete, knownTotal, accepted }) => {
      const store = new SubtaskStore();
      const before = store.snapshot();
      const input = {
        ...subtaskAdmission(),
        complete,
        ...(knownTotal === undefined ? {} : { knownTotal }),
      };
      expect(store.admit(input)).toEqual(
        accepted ? { accepted: true } : { accepted: false, reason: "invalid" },
      );
      if (!accepted) expect(store.snapshot()).toEqual(before);
      else {
        const group = store.snapshot().groups[0];
        expect(group.complete).toBe(complete);
        expect(group.knownTotal).toBe(knownTotal);
        expect(group.children.map((child) => child.status)).toEqual([
          "pending",
          "pending",
        ]);
      }
    },
  );

  it("rejects empty, duplicate and malformed-source report batches atomically", () => {
    const { store, group } = fixture();
    const before = store.snapshot();
    const report = {
      groupId: group.id,
      listRevision: 1,
      childIds: [group.children[0].id],
      source: subtaskSource(),
      status: "reported-completed" as const,
    };
    for (const malformed of [
      { ...report, childIds: [] },
      { ...report, childIds: [group.children[0].id, group.children[0].id] },
      { ...report, source: { ...report.source, end: 0 } },
      { ...report, source: { ...report.source, quoteHash: "invalid" } },
      {
        ...report,
        source: { ...report.source, rawPrompt: "PRIVATE_REPORT_SENTINEL" },
      },
    ]) {
      expect(store.report(malformed)).toEqual({
        accepted: false,
        reason: "invalid",
      });
      expect(store.snapshot()).toEqual(before);
    }
    expect(store.report(report)).toEqual({ accepted: true });
    expect(store.snapshot().groups[0].children[0].status).toBe(
      "reported-completed",
    );
  });

  it("increments revision for retain-only reorder without changing child records", () => {
    const { store, input, group } = fixture();
    expect(
      store.admit({
        ...input,
        expectedListRevision: 1,
        children: [...group.children]
          .reverse()
          .map((child) => ({ kind: "retain" as const, id: child.id })),
      }),
    ).toEqual({ accepted: true });
    const after = store.snapshot().groups[0];
    expect(after.listRevision).toBe(2);
    expect(after.children).toEqual([...group.children].reverse());
  });

  it("bounds active children and rejects raw provenance fields without partial mutation", () => {
    const store = new SubtaskStore();
    const before = store.snapshot();
    expect(
      store.admit(
        subtaskAdmission(Array.from({ length: 65 }, (_, i) => `Step ${i}`)),
      ),
    ).toEqual({ accepted: false, reason: "capacity" });
    const malformed = {
      ...subtaskAdmission(),
      source: { ...subtaskSource(), rawPrompt: "PRIVATE_SENTINEL" },
    };
    expect(store.admit(malformed)).toEqual({
      accepted: false,
      reason: "invalid",
    });
    expect(store.admit(subtaskAdmission(["bad\nlabel"]))).toEqual({
      accepted: false,
      reason: "invalid",
    });
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

  it("bounds empty groups at 200 without spending child or rejected group IDs", () => {
    const store = new SubtaskStore();
    const parents = Array.from({ length: 200 }, (_, i) => ({
      ...subtaskParent(),
      id: `task:${i + 1}`,
    }));
    const countOnly = { ...subtaskAdmission([]), knownTotal: 22 };
    for (const parent of parents)
      expect(store.admit({ ...countOnly, parent })).toEqual({
        accepted: true,
      });
    const before = store.snapshot();
    expect(before.groups).toHaveLength(200);
    const nextParent = { ...subtaskParent(), id: "task:201" };
    expect(store.admit({ ...countOnly, parent: nextParent })).toEqual({
      accepted: false,
      reason: "capacity",
    });
    expect(store.snapshot()).toEqual(before);
    store.reconcile([...parents.slice(1), nextParent]);
    expect(store.admit({ ...countOnly, parent: nextParent })).toEqual({
      accepted: true,
    });
    expect(
      store
        .snapshot()
        .groups.find((group) => group.parentTaskId === nextParent.id)?.id,
    ).toBe("subtask-group:201");
    const withChild = {
      ...subtaskAdmission(["First real child"]),
      knownTotal: 22,
      parent: nextParent,
      expectedListRevision: 1,
    };
    expect(store.admit(withChild)).toEqual({ accepted: true });
    expect(
      store
        .snapshot()
        .groups.find((group) => group.parentTaskId === nextParent.id)
        ?.children[0].id,
    ).toBe("subtask-child:1");
  });

  it("counts 240/241 astral Unicode scalars, not UTF16 units or UTF8 bytes", () => {
    const store = new SubtaskStore();
    const before = store.snapshot();
    expect(store.admit(subtaskAdmission(["😀".repeat(241)]))).toEqual({
      accepted: false,
      reason: "capacity",
    });
    expect(store.snapshot()).toEqual(before);
    const valid = subtaskAdmission(["😀".repeat(240)]);
    expect(store.admit(valid)).toEqual({ accepted: true });
    const control = new SubtaskStore();
    expect(control.admit(valid)).toEqual({ accepted: true });
    expect(store.snapshot()).toEqual(control.snapshot());
  });

  it("enforces the full 32KiB UTF8 admission boundary atomically", () => {
    const store = new SubtaskStore();
    const before = store.snapshot();
    const over = byteBoundAdmission(32 * 1024 + 1);
    expect(store.admit(over)).toEqual({ accepted: false, reason: "capacity" });
    expect(store.snapshot()).toEqual(before);
    const at = byteBoundAdmission(32 * 1024);
    expect(store.admit(at)).toEqual({ accepted: true });
    const control = new SubtaskStore();
    expect(control.admit(at)).toEqual({ accepted: true });
    expect(store.snapshot()).toEqual(control.snapshot());
  });

  it("rejects malformed admission proofs and sources without allocator movement", () => {
    const store = new SubtaskStore();
    const input = subtaskAdmission();
    const before = store.snapshot();
    const malformed = [
      { ...input, proof: { ...input.proof, contextHash: "not-a-hash" } },
      { ...input, proof: { ...input.proof, gateRequestHash: "invalid" } },
      { ...input, proof: { ...input.proof, proposalRequestHash: "invalid" } },
      { ...input, source: { ...input.source, end: 0 } },
      { ...input, source: { ...input.source, messageHash: "invalid" } },
      {
        ...input,
        children: [
          {
            ...input.children[0],
            source: { ...input.source, quoteHash: "invalid" },
          },
        ],
      },
      {
        ...input,
        children: [{ ...input.children[0], status: "reported-completed" }],
      },
    ];
    for (const bad of malformed) {
      expect(store.admit(bad)).toEqual({ accepted: false, reason: "invalid" });
      expect(store.snapshot()).toEqual(before);
    }
    expect(store.admit(input)).toEqual({ accepted: true });
    const control = new SubtaskStore();
    expect(control.admit(input)).toEqual({ accepted: true });
    expect(store.snapshot()).toEqual(control.snapshot());
  });

  it("rejects actual cross-parent list references and mixed reports as a whole", () => {
    const { store, input, group } = fixture();
    expect(
      store.admit({
        ...subtaskAdmission(),
        parent: { ...input.parent, id: "task:2" },
      }),
    ).toEqual({ accepted: true });
    const foreign = store.snapshot().groups[1].children[0];
    const before = store.snapshot();
    expect(
      store.admit({
        ...input,
        expectedListRevision: 1,
        children: [
          ...group.children.map((child) => ({
            kind: "retain" as const,
            id: child.id,
          })),
          {
            kind: "add",
            label: "Must not allocate this child",
            source: subtaskSource(),
          },
          { kind: "retain", id: foreign.id },
        ],
      }),
    ).toEqual({ accepted: false, reason: "foreign" });
    expect(
      store.report({
        groupId: group.id,
        listRevision: 1,
        childIds: [group.children[0].id, foreign.id],
        source: subtaskSource(),
        status: "reported-completed",
      }),
    ).toEqual({ accepted: false, reason: "foreign" });
    expect(store.snapshot()).toEqual(before);
    expect(
      store.admit({
        ...input,
        expectedListRevision: 1,
        children: [
          ...group.children.map((child) => ({
            kind: "retain" as const,
            id: child.id,
          })),
          { kind: "add", label: "Next valid child", source: subtaskSource() },
        ],
      }),
    ).toEqual({ accepted: true });
    expect(store.snapshot().groups[0].children[2].id).toBe("subtask-child:5");
  });

  it("keeps a current-revision retain-only transaction a true no-op", () => {
    const { store, input, group } = fixture();
    const before = store.snapshot();
    expect(
      store.admit({
        ...input,
        expectedListRevision: 1,
        children: group.children.map((child) => ({
          kind: "retain" as const,
          id: child.id,
        })),
      }),
    ).toEqual({ accepted: true });
    expect(store.snapshot()).toEqual(before);
  });

  it("retains exact removal source, old child state and mutation proof", () => {
    const { store, input, group } = fixture();
    const removalSource = subtaskSource(
      "remove",
      "The recommendation step is out of scope.",
    );
    const proof = {
      contextHash: subtaskHash("changed context"),
      gateRequestHash: subtaskHash("new gate"),
      proposalRequestHash: subtaskHash("new proposal"),
    };
    expect(
      store.admit({
        ...input,
        expectedListRevision: 1,
        source: removalSource,
        proof,
        children: [{ kind: "retain", id: group.children[0].id }],
        removals: [
          {
            id: group.children[1].id,
            source: removalSource,
            reason: "out-of-scope",
          },
        ],
      }),
    ).toEqual({ accepted: true });
    const after = store.snapshot().groups[0];
    expect(after.source).toEqual(removalSource);
    expect(after.proof).toEqual(proof);
    expect(after.retired).toEqual([
      {
        ...group.children[1],
        retirement: { source: removalSource, reason: "out-of-scope" },
      },
    ]);
    expect(after.omissions).not.toEqual(group.omissions);
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
