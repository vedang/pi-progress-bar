import { afterEach, expect, it, vi } from "vitest";
import { MODEL, type ValidatedResult } from "../src/analysis/gateway";
import {
  type SubtaskReportBatch,
  type SubtaskReportReceipt,
  subtaskReportBatches,
  subtaskReportDecisions,
} from "../src/analysis/subtask-report";
import { reportChoices, subtaskReportFixture } from "./fixtures/subtask-report";
import { subtaskHash, subtaskSource } from "./fixtures/subtasks";

const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Expected a report batch");
  return value;
};
function reply(
  batch: SubtaskReportBatch,
  choice: string = "completed-set",
  confidence = 1,
  probability = 1,
): ValidatedResult {
  return {
    model: MODEL,
    usage: { input_tokens: 3, output_tokens: 5 },
    answers: Object.fromEntries(
      Object.keys(batch.request.questions).map((key) => [
        key,
        {
          type: "choice",
          choice,
          confidence,
          probabilities: Object.fromEntries(
            reportChoices.map((candidate) => [
              candidate,
              candidate === choice
                ? probability
                : (1 - probability) / (reportChoices.length - 1),
            ]),
          ),
        },
      ]),
    ),
  };
}
afterEach(() => {
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

it("adapts chunk-local source observations without dropping full-roster obligations", () => {
  const f = subtaskReportFixture();
  const children = f.options.group.children.map((child, i) => {
    const id = `child-source-${i}`;
    const label = `${child.label} with validation`;
    const text = `${label}. ${"Supporting canonical requirements. ".repeat(36)}`;
    f.observations.set(id, { id, role: "user", text, hash: subtaskHash(text) });
    return {
      kind: "reword" as const,
      id: child.id,
      label,
      source: subtaskSource(id, text),
    };
  });
  expect(
    f.store.admit({
      parent: f.options.parent,
      expectedListRevision: f.options.group.listRevision,
      source: f.options.group.source,
      proof: f.options.group.proof,
      children,
      removals: [],
      complete: true,
      knownTotal: children.length,
    }),
  ).toEqual({ accepted: true });
  f.options.group = f.store.snapshot().groups[0];
  expect(f.options.group.listRevision).toBe(2);
  expect(f.options.group.children.map((child) => child.source.entryId)).toEqual(
    children.map((child) => child.source.entryId),
  );
  expect(
    new Set(f.options.group.children.map((child) => child.source.entryId)).size,
  ).toBe(22);
  const batches = subtaskReportBatches(f.options);
  expect(batches.flatMap((batch) => batch.childIds)).toEqual(
    f.options.group.children.map((child) => child.id),
  );
  expect(batches.length).toBeGreaterThan(2);
  for (const batch of batches) {
    const input = JSON.stringify(batch.request);
    expect(Buffer.byteLength(input)).toBeLessThanOrEqual(24576);
    for (const child of f.options.group.children) {
      expect(input).toContain(JSON.stringify(child.id));
      expect(input).toContain(child.label);
      const observation = required(f.observations.get(child.source.entryId));
      if (batch.childIds.includes(child.id))
        expect(input).toContain(observation.text);
      else expect(input).not.toContain(observation.text);
    }
    expect(
      subtaskReportDecisions(batch, reply(batch), f.options).reports,
    ).toHaveLength(batch.childIds.length);
  }
});
it.each(["list", "parent", "child"])(
  "fences %s mutation inside a currentness resolver callback",
  (change) => {
    const f = subtaskReportFixture();
    const batch = required(subtaskReportBatches(f.options)[0]);
    const resolve = f.options.resolve;
    f.options.resolve = (id) => {
      if (id === "goal") {
        if (change === "list") f.options.group.listRevision++;
        if (change === "parent") f.options.parent.included = false;
        if (change === "child")
          f.options.group.children[0].label = "Replaced obligation";
      }
      return resolve(id);
    };
    expect(subtaskReportDecisions(batch, reply(batch), f.options)).toEqual({
      reports: [],
    });
  },
);
it("builds a no-tool 22-child report in 20+2 immutable bounded questions", () => {
  const f = subtaskReportFixture();
  const before = structuredClone(f.options.parent);
  const batches = subtaskReportBatches(f.options);
  expect(batches.map((batch) => batch.childIds.length)).toEqual([20, 2]);
  expect(batches.flatMap((batch) => batch.childIds)).toEqual(
    f.options.group.children.map((child) => child.id),
  );
  for (const batch of batches) {
    expect(batch.request.model).toBe(MODEL);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.request)).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(batch.request)),
    ).toBeLessThanOrEqual(24576);
    expect(batch).toMatchObject({
      groupId: f.options.group.id,
      listRevision: 1,
      parentTaskId: f.options.parent.id,
      parentRevision: 1,
      identity: expect.stringMatching(/^[a-f0-9]{64}$/),
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    for (const question of Object.values(batch.request.questions)) {
      expect(question.type).toBe("choice");
      expect(Object.keys(question.criteria).sort()).toEqual(
        [...reportChoices].sort(),
      );
    }
    const input = JSON.stringify(batch.request);
    expect(input).toContain(f.options.report.text);
    expect(input).toContain(required(f.observations.get("goal")).text);
    expect(input).toMatch(/quoted/i);
    expect(input).toMatch(/future/i);
    expect(input).toMatch(/implement/i);
    expect(input).toMatch(/read/i);
  }
  expect(f.options.parent).toEqual(before);
});
it("applies only assessed complete-set children and keeps identities stable after status changes", () => {
  const f = subtaskReportFixture();
  const before = structuredClone(f.options.parent);
  const batches = subtaskReportBatches(f.options);
  const first = required(batches[0]);
  const decisions = subtaskReportDecisions(first, reply(first), f.options);
  const receipt: SubtaskReportReceipt | undefined = decisions.receipt;
  expect(receipt?.childIds).toEqual(first.childIds);
  expect(decisions.reports).toHaveLength(20);
  for (const report of decisions.reports)
    expect(f.store.report(report)).toEqual({ accepted: true });
  let group = f.store.snapshot().groups[0];
  expect(
    group.children.filter((child) => child.status === "reported-completed"),
  ).toHaveLength(20);
  expect(
    group.children
      .filter((child) => child.status === "pending")
      .map((child) => child.id),
  ).toEqual(required(batches[1]).childIds);
  const current = { ...f.options, group };
  expect(
    subtaskReportBatches(current).map((batch) => [
      batch.identity,
      batch.requestHash,
    ]),
  ).toEqual(batches.map((batch) => [batch.identity, batch.requestHash]));
  expect(subtaskReportDecisions(first, reply(first), current).receipt).toEqual(
    decisions.receipt,
  );
  const second = required(batches[1]);
  for (const report of subtaskReportDecisions(second, reply(second), current)
    .reports)
    expect(f.store.report(report).accepted).toBe(true);
  group = f.store.snapshot().groups[0];
  expect(
    group.children.every((child) => child.status === "reported-completed"),
  ).toBe(true);
  expect(f.options.parent).toEqual(before);
  expect(f.options.parent.status).toBe("not-started");
});
it.each(["completed", "retracted", "blocked"])(
  "vetoes incomplete %s-set but permits item-scoped paraphrase",
  (choice) => {
    const f = subtaskReportFixture(
      ["Implement parser"],
      false,
      "I implemented the parser and finished its tests.",
    );
    const batch = required(subtaskReportBatches(f.options)[0]);
    const set = subtaskReportDecisions(
      batch,
      reply(batch, `${choice}-set`),
      f.options,
    );
    expect(set.reports).toEqual([]);
    expect(set.receipt?.assessments).toEqual([
      {
        childId: batch.childIds[0],
        choice,
        scope: "set",
        confidence: 1,
        probability: 1,
        accepted: false,
      },
    ]);
    const item = subtaskReportDecisions(
      batch,
      reply(batch, `${choice}-item`),
      f.options,
    );
    expect(item.reports).toHaveLength(1);
    expect(item.reports[0]).toMatchObject({
      childIds: batch.childIds,
      status:
        choice === "completed"
          ? "reported-completed"
          : choice === "retracted"
            ? "pending"
            : "reported-blocked",
    });
    expect(item.receipt?.assessments[0]).toMatchObject({
      choice,
      scope: "item",
      accepted: true,
    });
  },
);
it("suppresses exact duplicate-label item claims across chunk boundaries, not complete-set claims", () => {
  const labels = Array.from(
    { length: 22 },
    (_, i) => `Implement component ${i + 1}`,
  );
  labels[21] = labels[0];
  const f = subtaskReportFixture(labels);
  const batches = subtaskReportBatches(f.options);
  const duplicateIds = [
    f.options.group.children[0].id,
    f.options.group.children[21].id,
  ];
  const itemReports = batches.flatMap(
    (batch) =>
      subtaskReportDecisions(batch, reply(batch, "completed-item"), f.options)
        .reports,
  );
  expect(itemReports).toHaveLength(20);
  expect(
    itemReports
      .flatMap((report) => report.childIds)
      .some((id) => duplicateIds.includes(id)),
  ).toBe(false);
  expect(
    batches.flatMap(
      (batch) => subtaskReportDecisions(batch, reply(batch), f.options).reports,
    ),
  ).toHaveLength(22);
});
it.each([
  [0.5, 0.8, true],
  [0.499, 1, false],
  [1, 0.799, false],
] as const)(
  "uses unchanged confidence/probability thresholds %s/%s",
  (confidence, probability, accepted) => {
    const f = subtaskReportFixture(["Review proposal"]);
    const batch = required(subtaskReportBatches(f.options)[0]);
    const result = subtaskReportDecisions(
      batch,
      reply(batch, "completed-item", confidence, probability),
      f.options,
    );
    expect(result.reports).toHaveLength(accepted ? 1 : 0);
    expect(result.receipt?.assessments[0]).toMatchObject({
      confidence,
      probability,
      accepted,
    });
  },
);
it("does not sum item and set probabilities to cross threshold", () => {
  const f = subtaskReportFixture(["Review proposal"]);
  const batch = required(subtaskReportBatches(f.options)[0]);
  const result = reply(batch, "completed-item");
  const answer = required(Object.values(result.answers)[0]);
  if (answer.type !== "choice") throw new Error("Expected choice");
  answer.probabilities = Object.fromEntries(
    reportChoices.map((choice) => [
      choice,
      choice.startsWith("completed-") ? 0.4 : 0.2 / 6,
    ]),
  );
  const decisions = subtaskReportDecisions(batch, result, f.options);
  expect(decisions.reports).toEqual([]);
  expect(decisions.receipt?.assessments[0]).toMatchObject({
    probability: 0.4,
    accepted: false,
  });
});
it.each(["unchanged", "uncertain"])(
  "retains all %s assessments in content-free accounting receipt",
  (choice) => {
    const f = subtaskReportFixture();
    const batch = required(subtaskReportBatches(f.options)[0]);
    const decisions = subtaskReportDecisions(
      batch,
      reply(batch, choice),
      f.options,
    );
    expect(decisions.reports).toEqual([]);
    expect(decisions.receipt).toMatchObject({
      identity: batch.identity,
      requestHash: batch.requestHash,
      parentTaskId: batch.parentTaskId,
      parentRevision: batch.parentRevision,
      parentSourceDigest: batch.parentSourceDigest,
      groupId: batch.groupId,
      listRevision: batch.listRevision,
      source: batch.source,
      childIds: batch.childIds,
      model: MODEL,
      usage: { inputTokens: 3, outputTokens: 5 },
    });
    expect(decisions.receipt?.assessments).toHaveLength(batch.childIds.length);
    expect(
      decisions.receipt?.assessments.every(
        (assessment) =>
          assessment.choice === choice &&
          assessment.scope === "none" &&
          !assessment.accepted,
      ),
    ).toBe(true);
    expect(JSON.stringify(decisions.receipt)).not.toContain(
      f.options.report.text,
    );
    expect(JSON.stringify(decisions.receipt)).not.toContain(
      f.options.parent.label,
    );
  },
);
it.each([
  "parent-revision",
  "list",
  "child-label",
  "report-source",
  "group-source",
  "child-source",
])("fences amended %s without a receipt", (change) => {
  const f = subtaskReportFixture();
  const batch = required(subtaskReportBatches(f.options)[0]);
  const current = {
    ...f.options,
    parent: structuredClone(f.options.parent),
    group: structuredClone(f.options.group),
  };
  if (change === "parent-revision") current.parent.revision++;
  if (change === "list") current.group.listRevision++;
  if (change === "child-label") current.group.children[0].label += " amended";
  if (change === "report-source")
    current.resolve = (id) =>
      id === "report" ? undefined : f.options.resolve(id);
  if (change === "group-source")
    current.group.source = subtaskSource("missing");
  if (change === "child-source")
    current.group.children[0].source = subtaskSource("missing");
  expect(subtaskReportDecisions(batch, reply(batch), current)).toEqual({
    reports: [],
  });
});
it("preserves immutable group provenance across same-revision parent wording updates", () => {
  const f = subtaskReportFixture();
  const oldBatch = required(subtaskReportBatches(f.options)[0]);
  const originalDigest = f.options.group.parentSourceDigest;
  const text = "Deliver the same agreed obligations with a concise synthesis.";
  f.observations.set("wording", {
    id: "wording",
    role: "user",
    text,
    hash: subtaskHash(text),
  });
  f.options.parent.source = subtaskSource("wording", text);
  f.options.parent.label = "Deliver agreed obligations";
  const next = subtaskReportBatches(f.options);
  expect(next).toHaveLength(2);
  expect(required(next[0]).parentSourceDigest).not.toBe(
    oldBatch.parentSourceDigest,
  );
  expect(f.options.group.parentSourceDigest).toBe(originalDigest);
  expect(subtaskReportDecisions(oldBatch, reply(oldBatch), f.options)).toEqual({
    reports: [],
  });
  expect(
    subtaskReportDecisions(
      required(next[0]),
      reply(required(next[0])),
      f.options,
    ).reports,
  ).toHaveLength(20);
});
it.each(["clone", "frozen-clone", "forged"])(
  "rejects %s batch without private original proof",
  (mode) => {
    const f = subtaskReportFixture();
    const batch = required(subtaskReportBatches(f.options)[0]);
    const clone = mode === "forged" ? { ...batch } : structuredClone(batch);
    if (mode === "frozen-clone") {
      Object.freeze(clone.request);
      Object.freeze(clone);
    }
    expect(subtaskReportDecisions(clone, reply(batch), f.options)).toEqual({
      reports: [],
    });
  },
);
it.each([
  "model",
  "extra-answer",
  "missing-answer",
  "sum",
  "loser",
  "usage-negative",
  "usage-fractional",
  "usage-overflow",
])("rejects invalid provider %s atomically", (mode) => {
  const f = subtaskReportFixture(["Review proposal"]);
  const batch = required(subtaskReportBatches(f.options)[0]);
  const result = reply(batch);
  const key = required(Object.keys(result.answers)[0]);
  const answer = required(result.answers[key]);
  if (answer.type !== "choice") throw new Error("Expected choice");
  if (mode === "model") result.model = "other";
  if (mode === "extra-answer") result.answers.foreign = structuredClone(answer);
  if (mode === "missing-answer") delete result.answers[key];
  if (mode === "sum")
    for (const choice of reportChoices) answer.probabilities[choice] = 1;
  if (mode === "loser") {
    answer.probabilities[answer.choice] = 0.1;
    answer.probabilities.unchanged = 0.9;
  }
  if (mode === "usage-negative") result.usage.input_tokens = -1;
  if (mode === "usage-fractional") result.usage.output_tokens = 0.5;
  if (mode === "usage-overflow")
    result.usage.input_tokens = Number.MAX_SAFE_INTEGER + 1;
  expect(subtaskReportDecisions(batch, result, f.options)).toEqual({
    reports: [],
  });
});
it("rejects own getters without invoking them", () => {
  const f = subtaskReportFixture();
  let reads = 0;
  Object.defineProperty(f.options.group.children[0], "label", {
    enumerable: true,
    get() {
      reads++;
      return "unsafe";
    },
  });
  expect(subtaskReportBatches(f.options)).toEqual([]);
  expect(reads).toBe(0);
});
it("ignores inherited serialization hooks in hashes and byte accounting", () => {
  const f = subtaskReportFixture();
  const before = subtaskReportBatches(f.options);
  let calls = 0;
  const prior = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  let after: readonly SubtaskReportBatch[] = [];
  try {
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value() {
        calls++;
        return "PRIVATE_HOOK";
      },
    });
    after = subtaskReportBatches(f.options);
  } finally {
    if (prior) Object.defineProperty(Object.prototype, "toJSON", prior);
    else Reflect.deleteProperty(Object.prototype, "toJSON");
  }
  expect(calls).toBe(0);
  expect(after.map((batch) => batch.requestHash)).toEqual(
    before.map((batch) => batch.requestHash),
  );
});
it("snapshots caller data before resolver side effects", () => {
  const f = subtaskReportFixture();
  const resolve = f.options.resolve;
  f.options.resolve = (id) => {
    f.options.parent.label = "INJECTED_AFTER_SNAPSHOT";
    return resolve(id);
  };
  const batches = subtaskReportBatches(f.options);
  expect(JSON.stringify(batches)).not.toContain("INJECTED_AFTER_SNAPSHOT");
});
it("does not truncate or partially build oversized canonical report evidence", () => {
  const f = subtaskReportFixture(undefined, true, "x".repeat(12289));
  expect(subtaskReportBatches(f.options)).toEqual([]);
  const tool = subtaskReportFixture();
  Object.assign(tool.options.report, { role: "toolResult" });
  expect(subtaskReportBatches(tool.options)).toEqual([]);
});
it("keeps all children within fixed request bounds with long canonical context", () => {
  const f = subtaskReportFixture(
    undefined,
    true,
    `${"Context. ".repeat(1000)} I completed all agreed obligations.`,
  );
  const batches = subtaskReportBatches(f.options);
  expect(batches.flatMap((batch) => batch.childIds)).toEqual(
    f.options.group.children.map((child) => child.id),
  );
  for (const batch of batches) {
    expect(batch.childIds.length).toBeLessThanOrEqual(20);
    expect(
      Buffer.byteLength(JSON.stringify(batch.request)),
    ).toBeLessThanOrEqual(24576);
  }
});
