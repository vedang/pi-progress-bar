import { describe, expect, it } from "vitest";
import { subtaskAccessFixture } from "./fixtures/subtask-access";

describe("explicit optional model resource associations", () => {
  it("accepts indexed associations while keeping canonical child provenance and store shape", () => {
    const f = subtaskAccessFixture();
    const p = f.propose([
      { resourceIndex: 0, itemIndex: 0 },
      { resourceIndex: 1, itemIndex: 0 },
    ]);
    expect(p.applied?.status).toBe("accepted");
    if (p.applied?.status !== "accepted")
      throw new Error("Expected association proposal");
    expect(p.applied.admission.children[0]).toMatchObject({
      kind: "add",
      source: { entryId: f.latest.id, role: "user" },
    });
    expect(p.applied.admission.children[0]).not.toHaveProperty("association");
    expect(f.store.snapshot().groups).toEqual([]);
  });
  it.each([
    { resourceIndex: 99, itemIndex: 0 },
    { resourceIndex: 0, itemIndex: 99 },
    { resourceIndex: -1, itemIndex: 0 },
    { resourceIndex: 0, itemIndex: 0.5 },
  ])("rejects foreign or malformed index pair %#", (association) => {
    expect(
      subtaskAccessFixture().propose([association]).applied,
    ).toBeUndefined();
  });
});
