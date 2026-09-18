import { describe, expect, it } from "vitest";
import { aggregateImplementation } from "../src/analysis/implementation";
import type { PassiveEvidence } from "../src/sources/evidence";

const evidence = (revision = 1): PassiveEvidence[] => [
  {
    kind: "code-change",
    callId: "edit-1",
    toolName: "edit",
    order: 1,
    summary: "src/parser.ts",
    revision,
  },
  {
    kind: "test-pass",
    callId: "test-1",
    toolName: "bash",
    order: 2,
    summary: "parser passes",
    revision,
  },
];

describe("criterion-linked implementation aggregation", () => {
  it("does not claim complete when one of two criteria lacks support", () => {
    expect(
      aggregateImplementation(
        ["parses input", "handles errors"],
        ["supports", "insufficient"],
        evidence(),
        1,
      ),
    ).toBe("partial");
  });

  it("makes any current contradiction authoritative", () => {
    expect(
      aggregateImplementation(
        ["parses input", "handles errors"],
        ["supports", "contradicts"],
        evidence(),
        1,
      ),
    ).toBe("contradicted");
  });

  it("requires complete current evidence coverage for appears complete", () => {
    expect(
      aggregateImplementation(
        ["parses input", "handles errors"],
        ["supports", "supports"],
        evidence(),
        1,
      ),
    ).toBe("appears complete");
    expect(
      aggregateImplementation(
        ["parses input", "handles errors"],
        ["supports"],
        evidence(),
        1,
      ),
    ).toBe("partial");
    expect(aggregateImplementation(["parses input"], ["supports"], [], 1)).toBe(
      "unverified",
    );
  });

  it("ages passing evidence after a later code revision", () => {
    expect(
      aggregateImplementation(["parses input"], ["supports"], evidence(1), 2),
    ).toBe("unverified");
  });
});
