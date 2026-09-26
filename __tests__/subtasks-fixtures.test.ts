import { describe, expect, it } from "vitest";
import observedCoverage from "./fixtures/coverage-heldout.json";
import { subtaskTuning } from "./fixtures/subtasks";
import heldout from "./fixtures/subtasks-heldout.json";

describe("generic subtask corpus freeze", () => {
  it("keeps fresh held-out identities separate from tuning and observed coverage", () => {
    const ids = [...heldout.gateCases, ...heldout.reportCases].map(
      (item) => item.id,
    );
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
