import { expect, it } from "vitest";
import { CoverageIntentRequests } from "../src/analysis/coverage-intent";
import { emptyState } from "../src/core/hybrid-state";
import { coverageParent, coverageSource } from "./fixtures/coverage";
import { observation } from "./fixtures/hybrid";

function fixture(negative = false) {
  const state = emptyState("session:coverage");
  state.tasks = [coverageParent()];
  state.nextTaskId = 2;
  const latest = observation("intent", "Review every tab in docs/plan.xlsx.");
  const requests = new CoverageIntentRequests();
  const request = requests.begin(state, latest, 1);
  if (!request) throw new Error("Missing request");
  const output = {
    intents: negative
      ? []
      : [
          {
            parentIndices: [0],
            quote: latest.text,
            resource: "docs/plan.xlsx",
            kind: "unconditional-enumerable",
          },
        ],
  };
  expect(
    requests.finish(request, JSON.stringify(output), state, () => latest, 1)
      .status,
  ).toBe("accepted");
  return { state, latest, requests, journal: requests.journalSnapshot() };
}
it.each([false, true])(
  "restores exact accepted/negative intent without rebilling (negative=%s)",
  (negative) => {
    const h = fixture(negative);
    const restored = CoverageIntentRequests.restoreJournal(
      h.journal,
      h.state,
      () => h.latest,
    );
    expect(restored.journalSnapshot()).toEqual(h.journal);
    expect(restored.begin(h.state, h.latest, 2)).toBeUndefined();
    expect(JSON.stringify(h.journal)).not.toContain("docs/plan.xlsx");
  },
);
it("restored journal snapshots are detached", () => {
  const h = fixture();
  const restored = CoverageIntentRequests.restoreJournal(
    h.journal,
    h.state,
    () => h.latest,
  );
  h.journal.accepted[0].source.entryId = "mutated";
  const snapshot = restored.journalSnapshot();
  snapshot.accepted[0].parentTaskId = "task:9";
  expect(restored.snapshot()[0]).toMatchObject({
    parentTaskId: "task:1",
    source: { entryId: "intent" },
  });
});
it.each(["missing", "amended", "revision"])(
  "drops stale intent on %s canonical evidence",
  (change) => {
    const h = fixture();
    if (change === "revision") h.state.tasks[0].revision++;
    const restored = CoverageIntentRequests.restoreJournal(
      h.journal,
      h.state,
      () =>
        change === "missing"
          ? undefined
          : change === "amended"
            ? observation("intent", "Review nothing.")
            : h.latest,
    );
    expect(restored.snapshot()).toEqual([]);
  },
);
it("retains exact accepted parent intent when an unrelated parent was added before reload", () => {
  const h = fixture();
  h.state.tasks.push({
    ...coverageParent(),
    id: "task:2",
    label: "Unrelated request",
    source: coverageSource("other", "Answer a separate question."),
  });
  h.state.nextTaskId = 3;
  const restored = CoverageIntentRequests.restoreJournal(
    h.journal,
    h.state,
    () => h.latest,
  );
  expect(restored.snapshot()).toEqual(h.requests.snapshot());
});
