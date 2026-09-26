import { projectContinuationAuthority } from "../../src/advisory/continuation-authority";
import { buildContinuationDraft } from "../../src/advisory/continuation-draft";
import { buildContinuationGate } from "../../src/analysis/continuation-gate";
import { MODEL, type ValidatedResult } from "../../src/analysis/gateway";
import { continuationAuthorityFixture } from "./continuation";

export function continuationDraftFixture(model = "fixture/selected") {
  const { input } = continuationAuthorityFixture();
  input.model = model;
  const authority = projectContinuationAuthority(input);
  if (!authority.available) throw new Error("Expected authority");
  const gate = buildContinuationGate(authority);
  if (!gate) throw new Error("Expected gate");
  const result: ValidatedResult = {
    model: MODEL,
    answers: Object.fromEntries(
      Object.keys(gate.request.questions).map((key) => [
        key,
        {
          type: "choice",
          choice: "yes",
          confidence: 1,
          probabilities: { yes: 1, no: 0, uncertain: 0 },
        },
      ]),
    ),
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const request = buildContinuationDraft(gate, result, authority);
  if (!request) throw new Error("Expected draft request");
  const text = JSON.stringify({
    targetIndex: 0,
    action: "Compare deployment options",
    evidence: [{ contextIndex: 0, start: 0, end: 26 }],
  });
  return { request, authority, text };
}
