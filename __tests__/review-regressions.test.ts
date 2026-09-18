import { describe, expect, it, vi } from "vitest";
import { JevGateway } from "../src/analysis/gateway";
import type { Ledger, SourceTask } from "../src/core/types";
import { EvidenceStore, redEvidenceLabel } from "../src/sources/evidence";
import { applyScopeRelations } from "../src/sources/scope";

const request = {
  model: "jev-1.13.0",
  state: { task: "x" },
  questions: {
    q: {
      type: "choice" as const,
      instructions: "choose",
      criteria: { yes: "yes", no: "no" },
    },
  },
};
const base: Ledger = {
  sourceId: "conversation:g",
  kind: "conversation",
  sourceRevision: "r",
  scopeRevision: "s:1",
  tasks: [
    {
      id: "t1",
      text: "Old",
      status: "done",
      criteria: [],
      included: true,
      ref: {
        sourceId: "conversation:g",
        entryId: "g",
        start: 0,
        end: 3,
        provenance: "user",
      },
    },
  ],
  currentTaskId: "t1",
  stale: false,
  reportOrder: 0,
  reports: [],
  nextTaskId: 2,
  explicitSelection: false,
};
const candidate: SourceTask = {
  text: "New",
  status: "not-started",
  criteria: [],
  ref: {
    sourceId: "conversation:n",
    entryId: "n",
    start: 0,
    end: 3,
    provenance: "user",
  },
};

describe("full-review regressions", () => {
  it("turns off once for permanent non-auth 4xx", async () => {
    const permanent = vi.fn();
    const fetcher = vi.fn(async () => new Response(null, { status: 400 }));
    const gateway = new JevGateway({
      fetch: fetcher,
      getApiKey: () => "key",
      onPermanentError: permanent,
    });
    gateway.enable("scope");
    await gateway.evaluate(request, "scope");
    await gateway.evaluate(request, "scope");
    expect(permanent).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects compound spoof commands and ages red after code edits", () => {
    const store = new EvidenceStore();
    store.start(
      "spoof",
      "bash",
      { command: "printf AssertionError; echo test" },
      1,
    );
    store.finish(
      "spoof",
      "bash",
      {
        content: [{ type: "text", text: "AssertionError FAIL test" }],
        isError: true,
      },
      2,
    );
    expect(store.redObservation()).toBeUndefined();
    store.start("red", "bash", { command: "bun test parser" }, 3);
    store.finish(
      "red",
      "bash",
      {
        content: [{ type: "text", text: "FAIL parser AssertionError" }],
        isError: true,
      },
      4,
    );
    expect(store.redObservation()).toBeDefined();
    store.start("edit", "edit", { path: "src/parser.ts" }, 5);
    store.finish(
      "edit",
      "edit",
      { content: [{ type: "text", text: "ok" }], isError: false },
      6,
    );
    expect(store.redObservation()).toBeUndefined();
    expect(
      redEvidenceLabel({ applicability: "not-needed", reported: true }),
    ).toBe("Reported red");
  });

  it("does not mutate denominator for ambiguous scope and can select a new task", () => {
    const ambiguous = applyScopeRelations(base, [candidate], {
      0: "new",
      current: "candidate:0",
      scope: "ambiguous",
    });
    expect(ambiguous.tasks).toHaveLength(1);
    const next = applyScopeRelations(base, [candidate], {
      0: "new",
      current: "candidate:0",
      scope: "continue",
    });
    expect(next.tasks).toHaveLength(2);
    expect(next.currentTaskId).toBe(next.tasks[1]?.id);
    const cancelled = applyScopeRelations(base, [candidate], {
      0: "new",
      current: "candidate:0",
      scope: "continue",
      states: { 0: "cancelled" },
    });
    expect(cancelled.currentTaskId).toBeUndefined();
  });
});
