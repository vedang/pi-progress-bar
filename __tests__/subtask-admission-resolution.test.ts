import { describe, expect, it } from "vitest";
import { SubtaskStore } from "../src/core/subtasks";
import {
  subtaskAdmission,
  subtaskHash,
  subtaskSource,
} from "./fixtures/subtasks";

function fixture() {
  const store = new SubtaskStore();
  const admission = subtaskAdmission();
  store.reconcile([admission.parent]);
  expect(store.admit(admission)).toEqual({ accepted: true });
  return { store, admission };
}
describe("exact successful subtask admission resolution", () => {
  it("requires actual admission and reconciled parent authority", () => {
    const store = new SubtaskStore();
    const admission = subtaskAdmission();
    expect(store.resolveAdmission(admission)).toBeUndefined();
    expect(store.admit(admission)).toEqual({ accepted: true });
    expect(store.resolveAdmission(admission)).toBeUndefined();
    store.reconcile([admission.parent]);
    expect(store.resolveAdmission(admission)).toEqual(
      store.snapshot().groups[0],
    );
  });
  it("resolves exact replay and returns a detached current group", () => {
    const { store, admission } = fixture();
    expect(store.admit(admission)).toEqual({ accepted: true });
    const resolved = store.resolveAdmission(admission);
    if (!resolved) throw new Error("Expected actual admitted group");
    resolved.children[0].label = "caller mutation";
    expect(store.resolveAdmission(admission)?.children[0].label).not.toBe(
      "caller mutation",
    );
  });
  it("resolves retain-only admission using latest digest, not unchanged group proof", () => {
    const { store, admission } = fixture();
    const before = store.snapshot().groups[0];
    const retain = {
      ...admission,
      expectedListRevision: before.listRevision,
      proof: {
        ...admission.proof,
        proposalRequestHash: subtaskHash("new retain-only proposal"),
      },
      children: before.children.map((child) => ({
        kind: "retain" as const,
        id: child.id,
      })),
    };
    expect(store.admit(retain)).toEqual({ accepted: true });
    expect(store.snapshot().groups[0]).toEqual(before);
    expect(store.resolveAdmission(retain)).toEqual(before);
    expect(store.resolveAdmission(admission)).toBeUndefined();
  });
  it("does not resolve a failed admission or lose the last successful one", () => {
    const { store, admission } = fixture();
    const failed = {
      ...admission,
      expectedListRevision: 99,
      proof: { ...admission.proof, proposalRequestHash: subtaskHash("failed") },
    };
    expect(store.admit(failed).accepted).toBe(false);
    expect(store.resolveAdmission(failed)).toBeUndefined();
    expect(store.resolveAdmission(admission)).toBeDefined();
  });
  it.each(["archived", "removed", "revision", "source"])(
    "fences %s current authority without equating group provenance",
    (mode) => {
      const { store, admission } = fixture();
      const before = store.snapshot();
      const parent = { ...admission.parent };
      if (mode === "archived") parent.included = false;
      if (mode === "revision") parent.revision++;
      if (mode === "source")
        parent.source = subtaskSource("wording", "Deployment recommendation");
      store.reconcile(mode === "removed" ? [] : [parent]);
      expect(store.resolveAdmission(admission)).toBeUndefined();
      if (mode === "source") expect(store.snapshot()).toEqual(before);
    },
  );
  it("rebuilds independent current-source authority on restore", () => {
    const { store, admission } = fixture();
    const restored = SubtaskStore.restore(store.checkpoint(), {
      parents: [admission.parent],
      sourceCurrent: () => true,
    });
    expect(restored?.resolveAdmission(admission)).toEqual(
      store.snapshot().groups[0],
    );
    const changed = SubtaskStore.restore(store.checkpoint(), {
      parents: [
        {
          ...admission.parent,
          source: subtaskSource("wording", "Deployment recommendation"),
        },
      ],
      sourceCurrent: () => true,
    });
    expect(changed?.snapshot()).toEqual(store.snapshot());
    expect(changed?.resolveAdmission(admission)).toBeUndefined();
  });
});
