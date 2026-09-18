import { describe, expect, it } from "vitest";
import { countReported, reconcileLedger } from "../src/core/ledger";
import type { Ledger, SourceTask } from "../src/core/types";
import {
  applyScopeRelations,
  scopeAnswers,
  scopeChunks,
} from "../src/sources/scope";

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
  it.each(["same", "revised"] as const)(
    "preserves the full production ID in %s relations",
    (kind) => {
      const initial = reconcileLedger(undefined, {
        sourceId: "conversation:later",
        kind: "conversation",
        revision: "source-1",
        complete: true,
        tasks: [{ ...candidate("Implement parser"), status: "done" }],
      });
      const id = initial.tasks[0]?.id;
      if (!id) throw new Error("Missing generated task ID");
      expect(id).toContain(":task:1");
      const next = applyScopeRelations(
        initial,
        [candidate("Implement parser with recovery")],
        { 0: `${kind}:${id}`, current: "candidate:0", scope: "continue" },
      );
      expect(next.currentTaskId).toBe(id);
      expect(next.tasks).toHaveLength(1);
      expect(next.tasks[0]).toMatchObject({
        id,
        text:
          kind === "same"
            ? "Implement parser"
            : "Implement parser with recovery",
        status: kind === "same" ? "done" : "not-started",
      });
    },
  );
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

  it("abstains on a weak identity choice instead of transferring completion", () => {
    const answers = scopeAnswers([candidate("Build parser")], {
      model: "jev-1.13.0",
      answers: {
        "0": {
          type: "choice",
          choice: "same:task:1",
          confidence: 0.28,
          probabilities: {
            "same:task:1": 0.46,
            ambiguous: 0.32,
            new: 0.22,
          },
        },
        "status:0": {
          type: "choice",
          choice: "not-a-report",
          confidence: 1,
          probabilities: { "not-a-report": 1 },
        },
        current: {
          type: "choice",
          choice: "candidate:0",
          confidence: 0.4,
          probabilities: { "candidate:0": 0.6, unknown: 0.4 },
        },
        scope: {
          type: "choice",
          choice: "continue",
          confidence: 0.3,
          probabilities: { continue: 0.55, ambiguous: 0.45 },
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(answers).toMatchObject({
      0: "ambiguous",
      current: "unknown",
      scope: "ambiguous",
    });
  });

  it("batches every candidate under request limits without dropping suffix work", () => {
    const candidates = Array.from({ length: 27 }, (_, index) =>
      candidate(`Additional work ${index}`),
    );
    const chunks = scopeChunks(ledger(), candidates);
    expect(chunks.flatMap((chunk) => chunk.indexes)).toEqual(
      Array.from({ length: 27 }, (_, index) => index),
    );
    for (const chunk of chunks) {
      expect(Object.keys(chunk.request.questions).length).toBeLessThanOrEqual(
        20,
      );
      expect(
        Buffer.byteLength(JSON.stringify(chunk.request)),
      ).toBeLessThanOrEqual(24 * 1024);
    }
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
