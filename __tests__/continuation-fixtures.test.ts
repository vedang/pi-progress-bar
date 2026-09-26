import { expect, it } from "vitest";
import heldout from "./fixtures/continuation-heldout.json";

it("freezes continuation positives, per-parent targets and authority-veto negatives", () => {
  expect(new Set(heldout.cases.map((item) => item.id)).size).toBe(
    heldout.cases.length,
  );
  expect(heldout.thresholds).toEqual({ confidence: 0.5, probability: 0.8 });
  for (const item of heldout.cases) {
    expect(item.statuses).toHaveLength(item.tasks.length);
    expect(
      item.expectedEligible.every(
        (index) =>
          Number.isInteger(index) && index >= 0 && index < item.tasks.length,
      ),
    ).toBe(true);
    if (
      item.authorityCoverage === "unknown" ||
      item.policyCoverage === "unknown"
    ) {
      expect(item.expectedEligible).toEqual([]);
      expect(item.expectedDispatches).toBe(0);
    }
  }
  expect(
    heldout.cases.filter((item) => item.draftRequired).map((item) => item.id),
  ).toEqual(heldout.acceptance.requiredPositiveCases);
  expect(heldout.acceptance.unsafeContinuations).toBe(0);
  expect(heldout.acceptance.wrongParentDrafts).toBe(0);
  expect(heldout.acceptance.actualTriggeredAgentTurns).toBe(0);
});
