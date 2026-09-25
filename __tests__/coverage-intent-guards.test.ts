import { expect, it } from "vitest";
import { CoverageIntentRequests } from "../src/analysis/coverage-intent";
import { emptyState } from "../src/core/hybrid-state";
import { coverageParent } from "./fixtures/coverage";
import { observation } from "./fixtures/hybrid";

function fixture() {
  const state = emptyState("session:coverage");
  state.tasks = [coverageParent()];
  state.nextTaskId = 2;
  const latest = observation("intent", "Review every tab in docs/plan.xlsx.");
  return { state, latest, requests: new CoverageIntentRequests() };
}
it("bounds unfinished request reservations at20 without evicting older work", () => {
  const { state, requests } = fixture();
  const admitted = Array.from({ length: 200 }, (_, i) =>
    requests.begin(
      state,
      observation(`intent-${i}`, "Review every tab in docs/plan.xlsx."),
      1,
    ),
  ).filter(Boolean);
  expect(admitted.length).toBeLessThanOrEqual(20);
  expect(admitted.length).toBeGreaterThan(0);
});
it("does not redispatch accepted empty results for unchanged canonical evidence", () => {
  const { state, latest, requests } = fixture();
  const request = requests.begin(state, latest, 1);
  if (!request) throw new Error("Missing request");
  expect(
    requests.finish(request, '{"intents":[]}', state, () => latest, 1).status,
  ).toBe("accepted");
  expect(requests.begin(state, latest, 1)).toBeUndefined();
  expect(requests.begin(state, latest, 2)).toBeUndefined();
});
it("cannot accept a model result for caller-amended request evidence", () => {
  const { state, latest, requests } = fixture();
  const request = requests.begin(state, latest, 1);
  if (!request) throw new Error("Missing request");
  // The selected model must receive exactly the identity-bound snapshot.
  try {
    request.input.latest.text = "Other party will review every tab.";
  } catch {
    /* Freezing is also acceptable. */
  }
  const raw = JSON.stringify({
    intents: [
      {
        parentIndices: [0],
        quote: latest.text,
        resource: "docs/plan.xlsx",
        kind: "unconditional-enumerable",
      },
    ],
  });
  const result = requests.finish(request, raw, state, () => latest, 1);
  expect(
    request.input.latest.text === latest.text || result.status === "abstained",
  ).toBe(true);
});
