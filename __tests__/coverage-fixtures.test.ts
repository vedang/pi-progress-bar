import { describe, expect, it } from "vitest";
import { coverageNames, coverageTuning } from "./fixtures/coverage";
import heldout from "./fixtures/coverage-heldout.json";

describe("frozen synthetic coverage corpus", () => {
  it("has22unique labels and disjoint tuning/held-out case identities", () => {
    expect(coverageNames).toHaveLength(22);
    expect(new Set(coverageNames).size).toBe(22);
    const tuningIds = new Set(coverageTuning.map((item) => item.id));
    expect(heldout.cases.every((item) => !tuningIds.has(item.id))).toBe(true);
    expect(new Set(heldout.cases.map((item) => item.id)).size).toBe(
      heldout.cases.length,
    );
    expect(heldout.thresholds).toEqual({ confidence: 0.5, probability: 0.8 });
    expect(heldout.provenance).toContain("Synthetic");
  });
});
