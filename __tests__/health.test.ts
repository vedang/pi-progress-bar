import { describe, expect, it } from "vitest";
import { healthSnapshot } from "../src/analysis/health";
import type { Ledger } from "../src/core/types";

const ledger: Ledger = {
  sourceId: "conversation:goal",
  kind: "conversation",
  sourceRevision: "r1",
  scopeRevision: "s:1",
  tasks: [
    {
      id: "t1",
      text: "Fix authorization bypass",
      status: "in-progress",
      criteria: ["Unauthorized request is denied"],
      included: true,
      ref: {
        sourceId: "conversation:goal",
        entryId: "goal",
        start: 0,
        end: 24,
        provenance: "user",
      },
    },
  ],
  currentTaskId: "t1",
  stale: false,
  reportOrder: 0,
  reports: [],
  nextTaskId: 2,
  explicitSelection: false,
};

describe("health question contracts", () => {
  it("batches every criterion under gateway limits", () => {
    const first = ledger.tasks[0];
    if (!first) throw new Error("fixture task missing");
    const many: Ledger = {
      ...ledger,
      tasks: [
        {
          ...first,
          criteria: Array.from(
            { length: 37 },
            (_, index) => `criterion ${index}`,
          ),
        },
      ],
    };
    const snapshot = healthSnapshot(many, 1, ["goal"]);
    const ids = snapshot?.requests.flatMap((request) =>
      Object.keys(request.questions).filter((id) =>
        id.startsWith("criterion:"),
      ),
    );
    expect(new Set(ids).size).toBe(37);
    for (const request of snapshot?.requests ?? []) {
      expect(Object.keys(request.questions).length).toBeLessThanOrEqual(20);
      expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(
        24 * 1024,
      );
    }
  });

  it("states that an explicit actual failing-test assertion is sufficient for Reported red", () => {
    const snapshot = healthSnapshot(ledger, 1, [
      "assistant: I wrote a failing regression test",
    ]);
    const question = snapshot?.request.questions.redReport;
    expect(question?.instructions).toMatch(/sufficient/i);
    expect(question?.instructions).toMatch(
      /without observed execution|no observed run/i,
    );
  });
});

it("uses long-term regression value in the existing necessity question", () => {
  const snapshot = healthSnapshot(ledger, 1, [
    "Task requires durable protection, not a disposable one-off check.",
  ]);
  const question = snapshot?.request.questions.redApplicability;
  expect(question?.instructions).toMatch(/long-term/i);
  expect(question?.instructions).toMatch(/disposable|one-off/i);
  expect(question?.instructions).toMatch(/durable|recurr/i);
  expect(question?.type).toBe("choice");
  expect(Object.keys(question?.criteria ?? {})).toEqual([
    "needed",
    "not-needed",
    "unknown",
  ]);
  expect(
    snapshot?.requests
      .flatMap((request) => Object.keys(request.questions))
      .filter((key) => key === "redApplicability"),
  ).toHaveLength(1);
});
it("never uses new-test applicability to skip required tests or existing validation", () => {
  const question = healthSnapshot(ledger, 1, [
    "Explicit policy requires a regression test and running existing validation.",
  ])?.request.questions.redApplicability;
  expect(question?.instructions).toMatch(/required/i);
  expect(question?.instructions).toMatch(/existing (tests|validation)/i);
  expect(question?.instructions).toMatch(/unknown/i);
  expect(question?.instructions).toMatch(/not.*skip|never.*skip/i);
});
