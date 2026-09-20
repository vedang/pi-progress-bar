import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { completionDecisions } from "../src/analysis/completion";
import type { ValidatedResult } from "../src/analysis/gateway";
import type { HybridTask } from "../src/core/hybrid-state";
import { observation } from "./fixtures/hybrid";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/manual-advisory-reading.json", import.meta.url),
    "utf8",
  ),
);

it("preserves the manual final report and owner-approved abstention oracle", () => {
  const final = fixture.messages.at(-1);
  expect(final.id).toBe("3b6c3881");
  expect(final.text).toContain("Read plan and supporting lifecycle");
  expect(final.text).toContain("Waiting for your go-ahead.");
  expect(fixture.recordedCursor.id).toBe(final.id);
  expect(fixture.expectedFinalReported).toEqual({ done: 0, total: 2 });
  expect(fixture.expectedCompletedTaskIds).toEqual([]);
  expect(fixture.recordedTasks.map((task: HybridTask) => task.status)).toEqual([
    "not-started",
    "not-started",
  ]);
});

it("reproduces recorded yes-answer abstentions without weakening global confidence guards", () => {
  const tasks = fixture.recordedTasks as HybridTask[];
  const final = fixture.messages.at(-1);
  const result: ValidatedResult = {
    model: "jev-1.13.0",
    usage: { input_tokens: 0, output_tokens: 0 },
    answers: Object.fromEntries(
      tasks.map((task) => {
        const assessment = task.latestAssessment;
        if (!assessment) throw new Error("Missing recorded assessment");
        return [
          `complete:${task.id}`,
          {
            type: "choice",
            choice: assessment.rawChoice,
            confidence: assessment.confidence,
            probabilities: { yes: assessment.probability },
          },
        ];
      }),
    ),
  };
  const decisions = completionDecisions(
    result,
    observation(final.id, final.text, "assistant"),
    tasks,
  );
  expect(decisions.map((decision) => decision.assessment.rawChoice)).toEqual([
    "yes",
    "yes",
  ]);
  expect(decisions.map((decision) => decision.assessment.reason)).toEqual([
    "threshold-abstention",
    "threshold-abstention",
  ]);
  expect(decisions.map((decision) => decision.status)).toEqual([
    "not-started",
    "not-started",
  ]);
});
