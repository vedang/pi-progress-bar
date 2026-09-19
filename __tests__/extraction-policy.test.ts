import { expect, it } from "vitest";
import { extractionInput } from "../src/analysis/extractor";
import { emptyState } from "../src/core/hybrid-state";
import { observation } from "./fixtures/hybrid";

it("requires independently verifiable tasks for explicitly separate requested actions", () => {
  const input = extractionInput(
    emptyState("session:test"),
    observation(
      "compound",
      "Inspect the service logs, identify the cause, and fix the defect.",
    ),
    [],
  );
  // Policy contract; paid CI replay checks actual model decomposition.
  expect(input.instructions).toContain(
    "separate tasks for each explicit requested action or question",
  );
  expect(input.instructions).toContain(
    "independently verifiable completion condition",
  );
});

it("reconciles assistant implementation details with existing deliverables and permits safe no-ops", () => {
  const input = extractionInput(
    emptyState("session:test"),
    observation("report", "I am verifying the fix and saving the changes."),
    [],
  );
  expect(input.instructions).toContain(
    "Reconcile against existing tasks before adding",
  );
  expect(input.instructions).toContain(
    "distinct deliverable not already covered",
  );
  expect(input.instructions).toContain(
    "not for progress reports or newly learned implementation details",
  );
  expect(input.instructions).toContain(
    "do not treat a safe no-op as ambiguous scope",
  );
});
