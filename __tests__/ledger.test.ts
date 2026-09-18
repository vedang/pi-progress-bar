import { describe, expect, it } from "vitest";
import {
  applyReportBatch,
  countReported,
  reconcileLedger,
} from "../src/core/ledger";
import type { SourceSnapshot } from "../src/core/types";

const parse = (text: string): SourceSnapshot => {
  const lines = text.split("\n");
  const end = lines.findIndex((line, index) => index > 0 && /^# /.test(line));
  return {
    sourceId: "conversation:plan",
    kind: "conversation",
    revision: text,
    complete: true,
    tasks: lines.slice(0, end < 0 ? undefined : end).flatMap((line, index) => {
      const match = /^- \[([ xX])\] (.+)$/.exec(line);
      return match
        ? [
            {
              text: match[2] ?? "",
              status:
                match[1] === " " ? ("not-started" as const) : ("done" as const),
              criteria: [],
              ref: {
                sourceId: "conversation:plan",
                entryId: "plan",
                start: index,
                end: index + line.length,
                provenance: "user" as const,
              },
            },
          ]
        : [];
    }),
  };
};
const fixture =
  "# Tasks\n- [x] First\n  - [ ] Nested criterion\n- [ ] Second\n- [x] Third\n- [ ] Fourth\n- [ ] Fifth\n# Notes\n- [x] Not scoped";

describe("reported task ledger", () => {
  it("counts only direct selected-section tasks", () => {
    const snapshot = parse(fixture);
    const ledger = reconcileLedger(undefined, snapshot);
    expect(ledger.tasks.map((task) => task.text)).toEqual([
      "First",
      "Second",
      "Third",
      "Fourth",
      "Fifth",
    ]);
    expect(countReported(ledger)).toMatchObject({
      done: 2,
      total: 5,
      percent: 40,
    });
    expect(ledger.currentTaskId).toBeUndefined();
  });

  it("does not fabricate a percentage for missing or empty scope", () => {
    expect(countReported(undefined).percent).toBeNull();
    expect(
      countReported(reconcileLedger(undefined, parse("# Tasks\nNothing yet")))
        .percent,
    ).toBeNull();
  });

  it("preserves identities on reorder and distinguishes content from scope changes", () => {
    const first = reconcileLedger(
      undefined,
      parse("# Tasks\n- [x] A\n- [ ] B"),
    );
    const reordered = reconcileLedger(
      first,
      parse("# Tasks\n- [ ] B\n- [x] A"),
    );
    expect(reordered.tasks.find((task) => task.text === "A")?.id).toBe(
      first.tasks[0]?.id,
    );
    expect(reordered.scopeRevision).toBe(first.scopeRevision);
    const unchecked = reconcileLedger(
      reordered,
      parse("# Tasks\n- [ ] B\n- [ ] A"),
    );
    expect(unchecked.scopeRevision).toBe(first.scopeRevision);
    // Conversation markers do not overwrite ordered report authority.
    expect(countReported(unchecked).done).toBe(1);
    const renamed = reconcileLedger(
      unchecked,
      parse("# Tasks\n- [ ] B\n- [ ] Different"),
    );
    expect(renamed.tasks[1]?.id).not.toBe(first.tasks[0]?.id);
    expect(renamed.scopeRevision).not.toBe(first.scopeRevision);
  });

  it("retains last complete denominator on incomplete input", () => {
    const first = reconcileLedger(undefined, parse(fixture));
    const partial = { ...parse("# Tasks\n- [x] First"), complete: false };
    const next = reconcileLedger(first, partial);
    expect(countReported(next)).toMatchObject({ done: 2, total: 5 });
    expect(next.stale).toBe(true);
  });

  it("supports selected scope without defaulting current task", () => {
    const first = reconcileLedger(undefined, parse(fixture));
    const ids = first.tasks.slice(0, 2).map((task) => task.id);
    const selected = reconcileLedger(first, parse(fixture), {
      includedIds: ids,
      currentTaskId: ids[1],
    });
    expect(countReported(selected)).toMatchObject({
      done: 1,
      total: 2,
      percent: 50,
    });
    expect(selected.currentTaskId).toBe(ids[1]);
  });

  it("applies complete ordered conversation reports, not cross-source or unknown-task claims", () => {
    const source = {
      ...parse("# Tasks\n- [ ] A\n- [ ] B\n- [ ] C"),
      kind: "conversation" as const,
    };
    const first = reconcileLedger(undefined, source);
    const [a, b] = first.tasks.map((task) => task.id);
    if (!a || !b) throw new Error("fixture tasks missing");
    const report = {
      sourceId: first.sourceId,
      scopeRevision: first.scopeRevision,
      order: 1,
      entryId: "report-1",
      states: { [a]: "done" as const, [b]: "done" as const },
    };
    const done = applyReportBatch(first, report);
    expect(countReported(done)).toMatchObject({ done: 2, total: 3 });
    const reopened = applyReportBatch(done, {
      ...report,
      order: 2,
      entryId: "report-2",
      states: { [a]: "reopened" },
    });
    expect(countReported(reopened).done).toBe(1);
    expect(() => applyReportBatch(reopened, report)).toThrow();
    expect(() =>
      applyReportBatch(first, { ...report, sourceId: "other" }),
    ).toThrow();
    expect(() =>
      applyReportBatch(first, {
        ...report,
        states: { [a]: "done", missing: "done" },
      }),
    ).toThrow();
    expect(countReported(first).done).toBe(0);
    const cancelled = applyReportBatch(
      { ...reopened, currentTaskId: b },
      {
        ...report,
        order: 3,
        entryId: "report-3",
        states: { [b]: "cancelled" },
      },
    );
    expect(countReported(cancelled)).toMatchObject({ done: 0, total: 2 });
    expect(cancelled.currentTaskId).toBeUndefined();
    const restored = applyReportBatch(cancelled, {
      ...report,
      order: 4,
      entryId: "report-4",
      states: { [b]: "reopened" },
    });
    expect(countReported(restored)).toMatchObject({ done: 0, total: 3 });
  });
});
