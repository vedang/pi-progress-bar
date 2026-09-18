import { describe, expect, it } from "vitest";
import { countReported } from "../src/core/ledger";
import type { Ledger, SourceTask } from "../src/core/types";
import { applyScopeRelations } from "../src/sources/scope";

const task = (
  id: string,
  text: string,
  status: "done" | "not-started" = "not-started",
) => ({
  id,
  text,
  status,
  anchor: id,
  criteria: [],
  included: true,
  ref: {
    sourceId: "conversation:goal",
    entryId: "goal",
    start: 0,
    end: text.length,
    provenance: "user" as const,
  },
});
const ledger = (): Ledger => ({
  sourceId: "conversation:goal",
  kind: "conversation",
  sourceRevision: "source-1",
  scopeRevision: "scope:1",
  tasks: [task("t1", "Implement parser", "done"), task("t2", "Add tests")],
  currentTaskId: "t2",
  stale: false,
  reportOrder: 0,
  reports: [],
  nextTaskId: 3,
  explicitSelection: false,
});
const candidate = (text: string): SourceTask => ({
  text,
  status: "not-started",
  criteria: [],
  ref: {
    sourceId: "conversation:later",
    entryId: "later",
    start: 0,
    end: text.length,
    provenance: "user",
  },
});

describe("automatic evolving scope", () => {
  it("reuses semantic identity for paraphrases and adds genuine work", () => {
    const next = applyScopeRelations(
      ledger(),
      [candidate("Build parsing support"), candidate("Document the parser")],
      { 0: "same:t1", 1: "new", current: "t1", scope: "continue" },
    );
    expect(next.tasks).toHaveLength(3);
    expect(next.tasks[0]?.id).toBe("t1");
    expect(next.tasks[0]?.status).toBe("done");
    expect(next.tasks[2]?.text).toBe("Document the parser");
    expect(next.currentTaskId).toBe("t1");
  });

  it("invalidates completion for materially revised work", () => {
    const next = applyScopeRelations(
      ledger(),
      [candidate("Implement parser with streaming recovery")],
      { 0: "revised:t1", current: "t1", scope: "continue" },
    );
    expect(next.tasks.find((item) => item.id === "t1")).toMatchObject({
      text: "Implement parser with streaming recovery",
      status: "not-started",
    });
    expect(countReported(next).done).toBe(0);
  });

  it("archives old denominator on a clear new goal and keeps ambiguity unresolved", () => {
    const replaced = applyScopeRelations(
      ledger(),
      [candidate("Publish release")],
      { 0: "new", current: "unknown", scope: "new-goal" },
    );
    expect(countReported(replaced).total).toBe(1);
    expect(replaced.currentTaskId).toBeUndefined();
    const ambiguous = applyScopeRelations(
      ledger(),
      [candidate("Maybe compare alternatives")],
      { 0: "ambiguous", current: "unknown", scope: "ambiguous" },
    );
    expect(ambiguous.tasks).toHaveLength(2);
    expect(ambiguous.currentTaskId).toBeUndefined();
  });
});
