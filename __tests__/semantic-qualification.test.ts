import { describe, expect, it } from "vitest";
import {
  gradeQualification,
  validateQualificationCases,
} from "./fixtures/semantic-qualification";

const cases = () =>
  Array.from({ length: 80 }, (_, i) => ({
    id: `case-${i}`,
    parentCount: i < 40 ? 2 : 1,
    eligible: i < 40 ? [0] : [],
  }));
const grades = () =>
  cases().map((item) => ({ id: item.id, acceptedIndices: [...item.eligible] }));

describe("owner-approved prospective semantic qualification", () => {
  it.each([
    [2, true],
    [3, false],
  ] as const)(
    "scores %i positive misses against forty targets, not eighty cases",
    (misses, passes) => {
      const actual = grades();
      for (let i = 0; i < misses; i++) actual[i].acceptedIndices = [];
      expect(gradeQualification(cases(), actual)).toMatchObject({
        positiveTargets: 40,
        correct: 40 - misses,
        missed: misses,
        unexpected: 0,
        gateCriteriaMet: passes,
      });
    },
  );

  it.each([0, 40])(
    "rejects unexpected target admission in case %i even with full recall",
    (index) => {
      const actual = grades();
      actual[index].acceptedIndices.push(index === 0 ? 1 : 0);
      expect(gradeQualification(cases(), actual)).toMatchObject({
        correct: 40,
        missed: 0,
        unexpected: 1,
        gateCriteriaMet: false,
      });
    },
  );

  it("does not turn a wrong-target-only positive into recall", () => {
    const actual = grades();
    actual[0].acceptedIndices = [1];
    const score = gradeQualification(cases(), actual);
    expect(score).toMatchObject({
      correct: 39,
      missed: 1,
      unexpected: 1,
      gateCriteriaMet: false,
    });
    expect(score.cases[0]).toEqual({
      id: "case-0",
      expected: [0],
      actual: [1],
      missed: [0],
      unexpected: [1],
    });
  });

  it("requires complete unique grades and valid target sets", () => {
    expect(() => gradeQualification(cases(), grades().slice(1))).toThrow();
    const duplicate = grades();
    duplicate[1] = duplicate[0];
    expect(() => gradeQualification(cases(), duplicate)).toThrow();
    const unknown = grades();
    unknown[0].id = "unknown";
    expect(() => gradeQualification(cases(), unknown)).toThrow();
    for (const targets of [[0, 0], [-1], [2], [0.5], [Number.NaN]]) {
      const actual = grades();
      actual[0].acceptedIndices = targets;
      expect(() => gradeQualification(cases(), actual)).toThrow();
    }
  });

  it("freezes exactly forty single-target positives and forty negatives", () => {
    expect(() => validateQualificationCases(cases())).not.toThrow();
    const twoTargets = cases();
    twoTargets[0].eligible = [0, 1];
    expect(() => validateQualificationCases(twoTargets)).toThrow();
    const wrongBalance = cases();
    wrongBalance[0].eligible = [];
    expect(() => validateQualificationCases(wrongBalance)).toThrow();
    const duplicate = cases();
    duplicate[1].id = duplicate[0].id;
    expect(() => validateQualificationCases(duplicate)).toThrow();
    const wrongParent = cases();
    wrongParent[0].eligible = [2];
    expect(() => validateQualificationCases(wrongParent)).toThrow();
  });
});
