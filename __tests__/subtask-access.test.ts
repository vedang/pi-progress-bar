import { describe, expect, it } from "vitest";
import { SubtaskAccess } from "../src/core/subtask-access";
import { subtaskAccessFixture } from "./fixtures/subtask-access";
import { subtaskSource } from "./fixtures/subtasks";

function bound() {
  const f = subtaskAccessFixture();
  const proposal = f.propose([
    { resourceIndex: 0, itemIndex: 0 },
    { resourceIndex: 1, itemIndex: 0 },
  ]);
  if (proposal.applied?.status !== "accepted")
    throw new Error("Expected associated proposal");
  const access = new SubtaskAccess(f.store);
  expect(f.store.admit(proposal.applied.admission)).toEqual({ accepted: true });
  expect(access.bind(proposal.applied)).toBe(true);
  return { ...f, proposal, access };
}
describe("explicit resource associations and isolated child access", () => {
  it("distinguishes same labels by explicit indices, never creates completion", () => {
    const f = bound();
    const before = f.store.snapshot();
    f.run(
      "read-one",
      "read",
      { path: "extracted/r0-0.txt" },
      "PRIVATE_CELL_TEXT",
    );
    const projection = f.access.snapshot(f.adapter.accessEvidence());
    expect(projection.groups[0].children.map((child) => child.status)).toEqual([
      "observed",
      "no-observation",
    ]);
    expect(f.store.snapshot()).toEqual(before);
    expect(JSON.stringify(projection)).not.toContain("PRIVATE_CELL_TEXT");
    expect(JSON.stringify(projection)).not.toContain("read-one");
    expect(JSON.stringify(projection)).not.toContain("extracted/");
    expect(f.parent.status).toBe("not-started");
  });
  it("requires original accepted result and actual successful admission", () => {
    const f = subtaskAccessFixture();
    const access = new SubtaskAccess(f.store);
    const p = f.propose([{ resourceIndex: 0, itemIndex: 0 }]);
    if (p.applied?.status !== "accepted") throw new Error("Expected proposal");
    expect(access.bind(p.applied)).toBe(false);
    expect(f.store.admit(p.applied.admission)).toEqual({ accepted: true });
    expect(access.bind(structuredClone(p.applied))).toBe(false);
    expect(access.bind(p.applied)).toBe(true);
    expect(f.store.admit(p.applied.admission)).toEqual({ accepted: true });
    expect(access.bind(p.applied)).toBe(true);
  });
  it("binds retain-only linkage despite unchanged group proof and drops omitted links", () => {
    const f = bound();
    const before = f.store.snapshot().groups[0];
    const retain = f.propose(
      [undefined, { resourceIndex: 1, itemIndex: 0 }],
      "task:1",
      true,
    );
    if (retain.applied?.status !== "accepted")
      throw new Error("Expected retain proposal");
    expect(f.store.admit(retain.applied.admission)).toEqual({ accepted: true });
    expect(f.store.snapshot().groups[0]).toEqual(before);
    expect(
      f.access
        .snapshot(f.adapter.accessEvidence())
        .groups[0].children.every((child) => child.status === "unavailable"),
    ).toBe(true);
    expect(f.access.bind(retain.applied)).toBe(true);
    expect(f.access.bind(f.proposal.applied)).toBe(false);
    expect(
      f.access
        .snapshot(f.adapter.accessEvidence())
        .groups[0].children.map((child) => child.status),
    ).toEqual(["unavailable", "no-observation"]);
  });
  it("suppresses duplicate valid association claims without rejecting children", () => {
    const f = subtaskAccessFixture();
    const p = f.propose([
      { resourceIndex: 0, itemIndex: 0 },
      { resourceIndex: 0, itemIndex: 0 },
    ]);
    if (p.applied?.status !== "accepted")
      throw new Error("Duplicate links must not poison semantic admission");
    expect(f.store.admit(p.applied.admission)).toEqual({ accepted: true });
    const access = new SubtaskAccess(f.store);
    expect(access.bind(p.applied)).toBe(true);
    expect(
      access
        .snapshot(f.adapter.accessEvidence())
        .groups[0].children.every((child) => child.status === "unavailable"),
    ).toBe(true);
    expect(f.store.snapshot().groups[0].children).toHaveLength(2);
  });
  it("makes conflicting associations across parents unavailable on every affected child", () => {
    const f = bound();
    const second = f.propose([{ resourceIndex: 0, itemIndex: 0 }], "task:2");
    if (second.applied?.status !== "accepted")
      throw new Error("Expected second parent proposal");
    expect(f.store.admit(second.applied.admission)).toEqual({ accepted: true });
    expect(f.access.bind(second.applied)).toBe(true);
    const groups = f.access.snapshot(f.adapter.accessEvidence()).groups;
    expect(
      groups.find((group) => group.parentTaskId === "task:1")?.children[0]
        .status,
    ).toBe("unavailable");
    expect(
      groups.find((group) => group.parentTaskId === "task:2")?.children[0]
        .status,
    ).toBe("unavailable");
  });
  it("does not infer links from resource labels and rejects malformed metadata indices", () => {
    const f = subtaskAccessFixture();
    const p = f.propose([undefined]);
    if (p.applied?.status !== "accepted")
      throw new Error("Optional association required no model claim");
    f.store.admit(p.applied.admission);
    const access = new SubtaskAccess(f.store);
    expect(access.bind(p.applied)).toBe(true);
    expect(
      access.snapshot(f.adapter.accessEvidence()).groups[0].children[0].status,
    ).toBe("unavailable");
    const invalid = subtaskAccessFixture().propose([
      { resourceIndex: 99, itemIndex: 0 },
    ]);
    expect(invalid.applied).toBeUndefined();
  });
  it("keeps reports orthogonal and fences current source drift", () => {
    const f = bound();
    const group = f.store.snapshot().groups[0];
    f.store.report({
      groupId: group.id,
      listRevision: group.listRevision,
      childIds: [group.children[0].id],
      source: f.parent.source,
      status: "reported-completed",
    });
    expect(
      f.access.snapshot(f.adapter.accessEvidence()).groups[0].children[0]
        .status,
    ).toBe("no-observation");
    f.store.reconcile([
      {
        ...f.parent,
        source: subtaskSource("wording", "Deployment recommendation"),
      },
    ]);
    expect(
      f.access.snapshot(f.adapter.accessEvidence()).groups[0].children[0]
        .status,
    ).toBe("unavailable");
    expect(f.store.snapshot().groups[0].children[0].status).toBe(
      "reported-completed",
    );
  });
  it("bounds retained linkage data without rejecting semantic store admission", () => {
    const f = subtaskAccessFixture();
    const access = new SubtaskAccess(f.store);
    let refused = false;
    for (let i = 1; i <= 200; i++) {
      const p = f.propose([{ resourceIndex: 0, itemIndex: 0 }], `task:${i}`);
      if (p.applied?.status !== "accepted")
        throw new Error("Expected semantic proposal");
      expect(f.store.admit(p.applied.admission)).toEqual({ accepted: true });
      if (!access.bind(p.applied)) {
        refused = true;
        expect(f.store.snapshot().groups).toHaveLength(i);
        break;
      }
    }
    expect(refused).toBe(true);
    expect(
      access.snapshot(f.adapter.accessEvidence()).omissions,
    ).toBeGreaterThan(0);
  });
  it("has no access authority after reset or from copied adapter evidence", () => {
    const f = bound();
    expect(
      f.access
        .snapshot(structuredClone(f.adapter.accessEvidence()))
        .groups[0].children.every((child) => child.status === "unavailable"),
    ).toBe(true);
    f.access.reset();
    expect(
      f.access
        .snapshot(f.adapter.accessEvidence())
        .groups[0].children.every((child) => child.status === "unavailable"),
    ).toBe(true);
  });
});
