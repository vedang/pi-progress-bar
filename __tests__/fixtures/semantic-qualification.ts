export interface QualificationCase {
  id: string;
  parentCount: number;
  eligible: readonly number[];
}
export interface QualificationGrade {
  id: string;
  acceptedIndices: readonly number[];
}

function validTargets(targets: readonly number[], parents: number) {
  return (
    Array.isArray(targets) &&
    new Set(targets).size === targets.length &&
    targets.every(
      (index) => Number.isSafeInteger(index) && index >= 0 && index < parents,
    )
  );
}

/** Test-only prospective protocol; neither gate success nor this score is final acceptance. */
export function validateQualificationCases(
  cases: readonly QualificationCase[],
): void {
  if (
    cases.length !== 80 ||
    new Set(cases.map((item) => item.id)).size !== 80 ||
    cases.some(
      (item) =>
        typeof item.id !== "string" ||
        !item.id.trim() ||
        !Number.isSafeInteger(item.parentCount) ||
        item.parentCount < 1 ||
        item.parentCount > 20 ||
        !validTargets(item.eligible, item.parentCount) ||
        item.eligible.length > 1,
    ) ||
    cases.filter((item) => item.eligible.length === 1).length !== 40
  ) {
    throw new Error(
      "Qualification requires 40 single-target positives and 40 negatives with unique IDs",
    );
  }
}

export function gradeQualification(
  cases: readonly QualificationCase[],
  grades: readonly QualificationGrade[],
) {
  validateQualificationCases(cases);
  const byId = new Map(grades.map((grade) => [grade.id, grade]));
  if (grades.length !== cases.length || byId.size !== cases.length)
    throw new Error("Incomplete or duplicate qualification grades");
  const rows = cases.map((item) => {
    const grade = byId.get(item.id);
    if (!grade || !validTargets(grade.acceptedIndices, item.parentCount))
      throw new Error("Missing or invalid qualification grade");
    return {
      id: item.id,
      expected: [...item.eligible],
      actual: [...grade.acceptedIndices],
      missed: item.eligible.filter(
        (index) => !grade.acceptedIndices.includes(index),
      ),
      unexpected: grade.acceptedIndices.filter(
        (index) => !item.eligible.includes(index),
      ),
    };
  });
  const missed = rows.reduce((sum, row) => sum + row.missed.length, 0);
  const unexpected = rows.reduce((sum, row) => sum + row.unexpected.length, 0);
  return {
    positiveTargets: 40,
    correct: 40 - missed,
    missed,
    unexpected,
    gateCriteriaMet: missed <= 2 && unexpected === 0,
    cases: rows,
  };
}
