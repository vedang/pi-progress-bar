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
