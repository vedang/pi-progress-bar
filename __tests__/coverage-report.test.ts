import { expect, it } from "vitest";
import {
  coverageReportBatches,
  coverageReportDecisions,
} from "../src/analysis/coverage-report";
import { MODEL, type ValidatedResult } from "../src/analysis/gateway";
import { CoverageStore } from "../src/core/coverage";
import {
  coverageInventory,
  coverageParent,
  coverageSource,
} from "./fixtures/coverage";
import { observation } from "./fixtures/hybrid";

function fixture(
  text = "I reviewed all tabs in docs/plan.xlsx; synthesis is still pending.",
) {
  const store = new CoverageStore();
  const parent = coverageParent();
  store.admit({
    parent,
    intent: coverageSource(),
    inventory: coverageInventory(),
  });
  const group = store.snapshot().groups[0];
  const report = observation("report", text, "assistant");
  const intent = observation("intent", "Review every tab in docs/plan.xlsx.");
  const resolve = (id: string) =>
    id === report.id ? report : id === intent.id ? intent : undefined;
  return { store, parent, group, report, resolve };
}
type Batch = ReturnType<typeof coverageReportBatches>[number];
function reply(
  batch: Batch,
  choice = "reviewed",
  confidence = 1,
  probability = 1,
): ValidatedResult {
  return {
    model: MODEL,
    usage: { input_tokens: 1, output_tokens: 1 },
    answers: Object.fromEntries(
      Object.entries(batch.request.questions).map(([key, question]) => {
        if (question.type !== "choice") throw new Error("Expected choices");
        const choices = Object.keys(question.criteria);
        return [
          key,
          {
            type: "choice",
            choice,
            confidence,
            probabilities: Object.fromEntries(
              choices.map((candidate) => [
                candidate,
                candidate === choice
                  ? probability
                  : (1 - probability) / (choices.length - 1),
              ]),
            ),
          },
        ];
      }),
    ),
  };
}
it("batches22children into20+2 pinned-model bounded questions with exact report identity", () => {
  const f = fixture();
  const batches = coverageReportBatches(f);
  expect(
    batches.map((batch) => Object.keys(batch.request.questions).length),
  ).toEqual([20, 2]);
  expect(batches.flatMap((batch) => batch.childIds)).toEqual(
    f.group.children.map((child) => child.id),
  );
  for (const batch of batches) {
    expect(batch.request.model).toBe(MODEL);
    expect(
      Buffer.byteLength(JSON.stringify(batch.request)),
    ).toBeLessThanOrEqual(24576);
    expect(batch).toMatchObject({
      groupId: f.group.id,
      inventoryRevision: 1,
      source: { entryId: "report", messageHash: f.report.hash },
    });
    const instructions = JSON.stringify(batch.request);
    expect(instructions).toMatch(/quoted/i);
    expect(instructions).toMatch(/future/i);
    expect(instructions).toMatch(/read/i);
  }
});
it("accepted whole-set reports advance only reported coverage, not synthesis or parenthealth", () => {
  const f = fixture();
  const parent = structuredClone(f.parent);
  for (const batch of coverageReportBatches(f)) {
    const decisions = coverageReportDecisions(batch, reply(batch), f);
    expect(decisions.receipt?.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(decisions.receipt)).not.toContain(f.report.text);
    for (const report of decisions.reports)
      expect(f.store.report(report).accepted).toBe(true);
    const saved = f.store.checkpoint();
    for (const report of decisions.reports) f.store.report(report);
    expect(f.store.checkpoint()).toEqual(saved);
  }
  expect(
    f.store
      .snapshot()
      .groups[0].children.every(
        (child) => child.status === "reported-reviewed",
      ),
  ).toBe(true);
  expect(f.parent).toEqual(parent);
  expect(f.parent.status).toBe("not-started");
});
it("first accepted chunk does not falsely finalize uncovered remainder", () => {
  const f = fixture();
  const [first, second] = coverageReportBatches(f);
  for (const report of coverageReportDecisions(first, reply(first), f).reports)
    f.store.report(report);
  const children = f.store.snapshot().groups[0].children;
  expect(
    children.filter((child) => child.status === "reported-reviewed"),
  ).toHaveLength(20);
  expect(
    children
      .filter((child) => child.status === "pending")
      .map((child) => child.id),
  ).toEqual(second.childIds);
});
it.each([
  [0.49, 1],
  [1, 0.79],
])(
  "abstains below fixed confidence/probability %s/%s",
  (confidence, probability) => {
    const f = fixture();
    const batch = coverageReportBatches(f)[0];
    expect(
      coverageReportDecisions(
        batch,
        reply(batch, "reviewed", confidence, probability),
        f,
      ).reports,
    ).toEqual([]);
  },
);
it("accepts exact0.5confidence/0.8probability boundary", () => {
  const f = fixture();
  const batch = coverageReportBatches(f)[0];
  expect(
    coverageReportDecisions(batch, reply(batch, "reviewed", 0.5, 0.8), f)
      .reports.length,
  ).toBeGreaterThan(0);
});
it.each(["unchanged", "uncertain"])(
  "%s evidence cannot advance coverage",
  (choice) => {
    const f = fixture(
      'Quoted example: "I reviewed Overview". I will review it later.',
    );
    const batch = coverageReportBatches(f)[0];
    expect(
      coverageReportDecisions(batch, reply(batch, choice), f).reports,
    ).toEqual([]);
  },
);
it.each([
  ["retracted", "pending"],
  ["blocked", "reported-blocked"],
])("maps %s only to its individually bound child", (choice, status) => {
  const f = fixture("Overview is unfinished and blocked on missing inputs.");
  const batch = coverageReportBatches(f)[0];
  const result = reply(batch, "unchanged");
  const key = Object.keys(batch.request.questions)[0];
  result.answers[key] = reply(batch, choice).answers[key];
  const decisions = coverageReportDecisions(batch, result, f);
  expect(decisions.reports).toHaveLength(1);
  expect(decisions.reports[0]).toMatchObject({
    childIds: [f.group.children[0].id],
    status,
  });
});
it.each(["inventory", "parent", "report", "intent", "model", "request"])(
  "fences amended %s identity",
  (change) => {
    const f = fixture();
    const batch = coverageReportBatches(f)[0];
    const result = reply(batch);
    const current = {
      ...f,
      group: structuredClone(f.group),
      parent: structuredClone(f.parent),
    };
    if (change === "inventory") current.group.inventoryRevision++;
    if (change === "parent") current.parent.revision++;
    if (change === "report" || change === "intent")
      current.resolve = (id) => (id === change ? undefined : f.resolve(id));
    if (change === "model") result.model = "other-model";
    if (change === "request") {
      try {
        batch.request.model = "tampered";
      } catch {
        /* immutable is acceptable */
      }
    }
    const decisions = coverageReportDecisions(batch, result, current);
    if (change === "request" && batch.request.model === MODEL)
      expect(Object.isFrozen(batch.request)).toBe(true);
    else expect(decisions.reports).toEqual([]);
  },
);
it("does not interpret whole-set claims as review of unknown/incomplete inventory", () => {
  const f = fixture();
  f.group.complete = false;
  f.group.knownTotal = 23;
  for (const batch of coverageReportBatches(f))
    expect(coverageReportDecisions(batch, reply(batch), f).reports).toEqual([]);
});
it("rejects oversized or noncanonical tool reports without provider input", () => {
  const f = fixture();
  expect(
    coverageReportBatches({
      ...f,
      report: observation("report", "x".repeat(13000), "assistant"),
    }),
  ).toEqual([]);
  expect(
    coverageReportBatches({
      ...f,
      report: { ...f.report, role: "toolResult" } as unknown as typeof f.report,
    }),
  ).toEqual([]);
  expect(coverageReportBatches({ ...f, resolve: () => undefined })).toEqual([]);
});
