import { describe, expect, it } from "vitest";
import observedCoverage from "./fixtures/coverage-heldout.json";
import { subtaskTuning } from "./fixtures/subtasks";
import heldout from "./fixtures/subtasks-heldout.json";

describe("generic subtask corpus freeze", () => {
  it("keeps fresh held-out identities separate from tuning and observed coverage", () => {
    const ids = [
      ...heldout.gateCases,
      ...heldout.reportCases,
      ...heldout.listUpdateCases,
    ].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const prior = new Set([
      ...subtaskTuning.map((item) => item.id),
      ...observedCoverage.cases.map((item) => item.id),
    ]);
    expect(ids.every((id) => !prior.has(id))).toBe(true);
    expect(heldout.thresholds).toEqual({ confidence: 0.5, probability: 0.8 });
    expect(
      observedCoverage.cases.find((item) => item.id === "h14")?.expected,
    ).toBe("accepted");
  });

  it("freezes phase expectations, incomplete inventory and list/report lifecycle controls", () => {
    expect(heldout.gateCases).toHaveLength(16);
    expect(heldout.reportCases).toHaveLength(15);
    expect(heldout.listUpdateCases).toHaveLength(3);
    expect(
      heldout.gateCases.find((item) => item.id === "sg13")?.phaseExpectations,
    ).toEqual([
      { throughMessage: 0, gate: "no", proposalDispatches: 0 },
      { throughMessage: 1, gate: "yes", proposalDispatches: 1 },
    ]);
    expect(
      heldout.gateCases.find((item) => item.id === "sg15")?.inventory,
    ).toEqual({ complete: false, knownTotal: 12, labels: [] });
    expect(
      heldout.gateCases.find((item) => item.id === "sg16")?.inventory?.labels,
    ).toHaveLength(3);
    const refinement = heldout.listUpdateCases.find(
      (item) => item.id === "sl01",
    );
    if (!refinement) throw new Error("Missing sl01 list-refinement fixture");
    expect(refinement.expectedOperations?.map((item) => item.kind)).toEqual([
      "retain",
      "reword",
      "replace",
      "add",
    ]);
    expect(refinement.expectedRemovals).toEqual([
      { childIndex: 3, reason: "withdrawn" },
    ]);
    expect(
      heldout.reportCases.find((item) => item.id === "sr13")
        ?.expectedTransitions,
    ).toEqual([]);
    expect(
      heldout.reportCases
        .filter((item) => item.expectedDispatches === 0)
        .map((item) => item.id),
    ).toEqual(["sr14", "sr15"]);
  });

  it("includes required no-tool positives and a distinct complete 22-name inventory", () => {
    const noTools = heldout.gateCases.filter(
      (item) => item.expected === "yes" && !item.tools,
    );
    expect(noTools.length).toBeGreaterThanOrEqual(5);
    expect(
      noTools.every(
        (item) => !/\.(xlsx|xlsm|ods)\b/i.test(JSON.stringify(item.messages)),
      ),
    ).toBe(true);
    const workbook = heldout.gateCases.find((item) => item.id === "sg06");
    expect(workbook?.inventory?.complete).toBe(true);
    expect(workbook?.inventory?.labels).toHaveLength(22);
    expect(new Set(workbook?.inventory?.labels).size).toBe(22);
    expect(heldout.acceptance.falseChildAdvancement).toBe(0);
    expect(heldout.acceptance.unsafeParentOrScopeAdmissions).toBe(0);
  });
});
