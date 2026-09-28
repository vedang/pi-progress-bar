import { expect, it } from "vitest";
import type { SubtaskOmissionSummary } from "../src/core/hybrid-checkpoint";
import {
  appendSubtaskOmission,
  mergeSubtaskOmissions,
  projectSubtaskOmissions,
  saturateSubtaskOmissions,
} from "../src/core/subtask-omissions";

const entry = (
  n: number,
  reason: SubtaskOmissionSummary["entries"][number]["reason"] = "capacity",
) => ({ identity: n.toString(16).padStart(64, "0"), reason });
const summary = (ids: number[], saturated = false): SubtaskOmissionSummary => ({
  entries: ids.map((id) => entry(id)),
  saturated,
});

it("keeps absent summaries canonical rather than creating empty metadata", () => {
  expect(mergeSubtaskOmissions(undefined, undefined)).toEqual({
    summary: undefined,
    changed: false,
  });
  expect(projectSubtaskOmissions(undefined)).toEqual({
    total: 0,
    byReason: { "report-oversized": 0, coalesced: 0, capacity: 0 },
    saturated: false,
  });
});
it("appends a first omission without raw content or derived counters", () => {
  expect(
    appendSubtaskOmission(undefined, entry(1, "report-oversized")),
  ).toEqual({
    summary: { entries: [entry(1, "report-oversized")], saturated: false },
    changed: true,
  });
});
it.each(["capacity", "coalesced", "report-oversized"] as const)(
  "deduplicates identity despite incoming reason %s",
  (reason) => {
    const live = { entries: [entry(1, "coalesced")], saturated: false };
    expect(appendSubtaskOmission(live, entry(1, reason))).toEqual({
      summary: live,
      changed: false,
    });
  },
);
it("allows the 64th entry and saturates on the first distinct overflow without eviction", () => {
  const live = summary(Array.from({ length: 63 }, (_, i) => i));
  const full = appendSubtaskOmission(live, entry(63));
  expect(full.summary.entries).toHaveLength(64);
  expect(full.summary.saturated).toBe(false);
  expect(full.changed).toBe(true);
  expect(appendSubtaskOmission(full.summary, entry(64))).toEqual({
    summary: { ...full.summary, saturated: true },
    changed: true,
  });
  expect(appendSubtaskOmission(full.summary, entry(0))).toEqual({
    summary: full.summary,
    changed: false,
  });
});
it("freezes unknown detail after byte saturation below64 without pretending it is exact", () => {
  const live = summary([1], true);
  expect(appendSubtaskOmission(live, entry(2))).toEqual({
    summary: live,
    changed: false,
  });
  expect(projectSubtaskOmissions(live)).toMatchObject({
    total: 1,
    saturated: true,
  });
});
it("supports a smaller saturation-only candidate, including empty saturated history", () => {
  expect(saturateSubtaskOmissions(undefined)).toEqual({
    summary: { entries: [], saturated: true },
    changed: true,
  });
  const live = summary([1]);
  expect(saturateSubtaskOmissions(live)).toEqual({
    summary: { entries: [entry(1)], saturated: true },
    changed: true,
  });
  expect(saturateSubtaskOmissions(summary([1], true))).toEqual({
    summary: summary([1], true),
    changed: false,
  });
});
it("retains live history when incoming restore omits it", () => {
  expect(mergeSubtaskOmissions(summary([1]), undefined)).toEqual({
    summary: summary([1]),
    changed: false,
  });
  expect(mergeSubtaskOmissions(undefined, summary([1]))).toEqual({
    summary: summary([1]),
    changed: true,
  });
});
it("merges live-first with first durable reason winning and no counter summing", () => {
  const live = { entries: [entry(2, "coalesced"), entry(1)], saturated: false };
  const incoming = {
    entries: [entry(1, "report-oversized"), entry(3), entry(2)],
    saturated: false,
  };
  const merged = mergeSubtaskOmissions(live, incoming);
  expect(merged).toEqual({
    summary: {
      entries: [entry(2, "coalesced"), entry(1), entry(3)],
      saturated: false,
    },
    changed: true,
  });
  expect(mergeSubtaskOmissions(merged.summary, incoming)).toEqual({
    summary: merged.summary,
    changed: false,
  });
});
it("marks a truncated union saturated while preserving the live prefix", () => {
  const live = summary(Array.from({ length: 63 }, (_, i) => i));
  const merged = mergeSubtaskOmissions(live, summary([63, 64]));
  expect(merged.summary).toEqual(
    summary(
      Array.from({ length: 64 }, (_, i) => i),
      true,
    ),
  );
  expect(merged.changed).toBe(true);
});
it("unions previously durable incoming identities even when live detail already saturated", () => {
  expect(mergeSubtaskOmissions(summary([1], true), summary([2]))).toEqual({
    summary: summary([1, 2], true),
    changed: true,
  });
  expect(
    mergeSubtaskOmissions(summary([1]), { entries: [], saturated: true }),
  ).toEqual({ summary: summary([1], true), changed: true });
});
it("projects reason counts without identities and preserves saturated zero", () => {
  expect(
    projectSubtaskOmissions({
      entries: [
        entry(1),
        entry(2, "coalesced"),
        entry(3, "report-oversized"),
        entry(4),
      ],
      saturated: true,
    }),
  ).toEqual({
    total: 4,
    byReason: { capacity: 2, coalesced: 1, "report-oversized": 1 },
    saturated: true,
  });
  expect(projectSubtaskOmissions({ entries: [], saturated: true })).toEqual({
    total: 0,
    byReason: { capacity: 0, coalesced: 0, "report-oversized": 0 },
    saturated: true,
  });
});
it("returns detached candidates even for no-ops and never mutates either input", () => {
  const live = summary([1]);
  const incoming = summary([2]);
  const results = [
    appendSubtaskOmission(live, entry(1)),
    mergeSubtaskOmissions(live, incoming),
    saturateSubtaskOmissions(live),
  ];
  for (const result of results) {
    if (!result.summary) throw new Error("Expected nonempty candidate");
    result.summary.entries[0].reason = "coalesced";
    result.summary.entries.push(entry(99));
  }
  expect(live).toEqual(summary([1]));
  expect(incoming).toEqual(summary([2]));
  const projection = projectSubtaskOmissions(live);
  projection.byReason.capacity = 999;
  expect(projectSubtaskOmissions(live).byReason.capacity).toBe(1);
});
