import { describe, expect, it, vi } from "vitest";
import {
  type SubtaskPhaseRecord,
  subtaskJournalIsValid,
} from "../src/core/subtask-journal";
import { mergeSubtaskRestoreHistory } from "../src/core/subtask-restore-history";
import type { SubtaskRuntimeCheckpoint } from "../src/core/subtask-runtime";
import { SubtaskStore, subtaskCheckpointIsValid } from "../src/core/subtasks";
import {
  subtaskAdmission,
  subtaskHash,
  subtaskSource,
} from "./fixtures/subtasks";

function component(jev = 0, extraction = 0): SubtaskRuntimeCheckpoint {
  return {
    state: new SubtaskStore().checkpoint(),
    journal: {
      version: 1,
      dispatches: jev + extraction,
      usage: {
        jev: { calls: jev, inputTokens: 0, outputTokens: 0 },
        extraction: { calls: extraction, inputTokens: 0, outputTokens: 0 },
      },
      records: [],
      reports: [],
    },
  };
}
function ready(name: string): SubtaskPhaseRecord {
  return {
    identity: subtaskHash(name),
    parentTaskId: "task:1",
    parentRevision: 1,
    parentSourceDigest: subtaskHash("parent"),
    listRevision: 0,
    source: subtaskSource(),
    contextHash: subtaskHash(name),
    triggerHash: subtaskHash("trigger"),
    gateModel: "jev-1.13.0",
    selectedModel: "fixture/selected",
    phase: "gate-ready",
    state: "ready",
  };
}
function decided(name = "job"): SubtaskRuntimeCheckpoint {
  const data = component(1);
  data.journal.records = [
    {
      ...ready(name),
      phase: "gate-decided",
      state: "complete",
      gate: {
        requestHash: subtaskHash(`${name}-gate`),
        dispatch: 1,
        at: 10,
        outcome: "decided",
        choice: "no",
        confidence: 1,
        probability: 1,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    },
  ];
  return data;
}
function merge(
  live: SubtaskRuntimeCheckpoint,
  incoming: SubtaskRuntimeCheckpoint,
  targetStore = incoming.state,
) {
  for (const value of [live, incoming]) {
    expect(subtaskCheckpointIsValid(value.state)).toBe(true);
    expect(subtaskJournalIsValid(value.journal)).toBe(true);
  }
  const before = structuredClone({ live, incoming, targetStore });
  const result = mergeSubtaskRestoreHistory({ live, incoming, targetStore });
  expect({ live, incoming, targetStore }).toEqual(before);
  if (result.kind === "merged") {
    expect(subtaskCheckpointIsValid(result.component.state)).toBe(true);
    expect(subtaskJournalIsValid(result.component.journal)).toBe(true);
  }
  return result;
}

// [ref:subtask_restore_no_refund] Synthetic valid ledger conflicts test the pure boundary.
describe("bounded same-source restore history", () => {
  it.each(["live", "incoming", "equal"] as const)(
    "copies an existing %s-dominant wallet vector without synthesizing accounting",
    (winner) => {
      const high = component(3, 2);
      high.journal.usage.jev.inputTokens = 13;
      high.journal.usage.extraction.outputTokens = 17;
      const low = component(1, 1);
      const live = winner === "incoming" ? low : high;
      const incoming = winner === "live" ? low : structuredClone(high);
      const result = merge(live, incoming);
      expect(result).toMatchObject({
        kind: "merged",
        component: { journal: { dispatches: 5, usage: high.journal.usage } },
      });
      if (result.kind !== "merged") throw new Error("Expected merge");
      result.component.journal.usage.jev.calls = 0;
      expect(high.journal.usage.jev.calls).toBe(3);
    },
  );
  it.each(["calls", "tokens"])(
    "refuses incomparable %s rather than independently maximizing fields",
    (kind) => {
      const live = component(2, 1);
      const incoming = component(1, 2);
      if (kind === "tokens") {
        incoming.journal = structuredClone(live.journal);
        live.journal.usage.jev.inputTokens = 5;
        incoming.journal.usage.jev.outputTokens = 5;
      }
      expect(merge(live, incoming)).toEqual({
        kind: "refused",
        reason: "accounting-conflict",
      });
    },
  );
  it("keeps live terminal proof instead of reviving an older ready identity", () => {
    const live = decided();
    const incoming = component();
    incoming.journal.records = [ready("job")];
    const result = merge(live, incoming);
    expect(result).toMatchObject({
      kind: "merged",
      component: {
        journal: { dispatches: 1, records: [live.journal.records[0]] },
      },
    });
  });
  it("retains richer zero-usage proof without reviving live superseded authority", () => {
    const incoming = decided();
    const live = component(1);
    live.journal.records = [
      {
        ...ready("job"),
        state: "superseded",
        gate: {
          requestHash: subtaskHash("job-gate"),
          dispatch: 1,
          at: 10,
          outcome: "dispatched",
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      },
    ];
    const result = merge(live, incoming);
    expect(result).toMatchObject({
      kind: "merged",
      component: {
        journal: {
          records: [{ ...incoming.journal.records[0], state: "superseded" }],
        },
      },
    });
  });
  it("prefers live owner eligibility on equal wallets and retires incoming-only owners", () => {
    const live = component();
    const incoming = component();
    live.journal.records = [ready("live")];
    incoming.journal.records = [ready("incoming")];
    const result = merge(live, incoming);
    expect(result.kind).toBe("merged");
    if (result.kind !== "merged") throw new Error("Expected merge");
    expect(result.component.journal.records).toEqual(
      expect.arrayContaining([
        live.journal.records[0],
        { ...incoming.journal.records[0], state: "superseded" },
      ]),
    );
    expect(result.component.journal.records).toHaveLength(2);
  });
  it.each(["outcome", "binding", "ordinal"])(
    "refuses conflicting %s proof without hiding it as superseded",
    (kind) => {
      const live = decided();
      const incoming = decided(kind === "ordinal" ? "different-job" : "job");
      if (kind === "binding")
        incoming.journal.records[0].contextHash =
          subtaskHash("changed-binding");
      if (kind === "outcome") {
        const gate = incoming.journal.records[0].gate;
        if (!gate) throw new Error("Missing fixture receipt");
        gate.choice = "uncertain";
      }
      expect(merge(live, incoming)).toEqual({
        kind: "refused",
        reason: "proof-conflict",
      });
    },
  );
  it("preserves allocator floors but adopts only target semantic groups", () => {
    const live = component();
    const store = new SubtaskStore();
    expect(store.admit(subtaskAdmission())).toEqual({ accepted: true });
    live.state = store.checkpoint();
    const incoming = component();
    const result = merge(live, incoming);
    expect(result).toMatchObject({
      kind: "merged",
      component: {
        state: {
          groups: [],
          nextGroupId: live.state.nextGroupId,
          nextChildId: live.state.nextChildId,
        },
      },
    });
  });
  it.each([false, true])(
    "checks accepted proof against its original store before target pruning (orphan=%s)",
    (orphan) => {
      const accepted = decided();
      accepted.journal.dispatches = 2;
      accepted.journal.usage.extraction.calls = 1;
      const item = accepted.journal.records[0];
      if (!item.gate) throw new Error("Missing gate");
      item.gate.choice = "yes";
      item.gate.requestHash = subtaskHash("accepted-yes-gate");
      item.contextHash = subtaskHash("context");
      item.phase = "proposal-decided";
      item.proposal = {
        requestHash: subtaskHash("selected-model-proposal"),
        dispatch: 2,
        at: 11,
        outcome: "accepted",
        listRevision: 1,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
      const store = new SubtaskStore();
      expect(store.admit(subtaskAdmission())).toEqual({ accepted: true });
      accepted.state = store.checkpoint();
      if (orphan) {
        accepted.state = component().state;
        expect(merge(component(), accepted)).toEqual({
          kind: "refused",
          reason: "invalid-history",
        });
      } else {
        const result = merge(accepted, component());
        expect(result).toMatchObject({
          kind: "merged",
          component: {
            state: { groups: [] },
            journal: {
              dispatches: 2,
              records: [{ ...item, state: "superseded" }],
            },
          },
        });
      }
    },
  );
  // [ref:subtask_capacity_eviction]
  it("reapplies oldest-finished eviction to an oversized union from either side", () => {
    const count = 45;
    const history = (side: "live" | "incoming") => {
      const data = component(2 * count);
      data.journal.records = Array.from({ length: count }, (_, i) => {
        const dispatch = 2 * i + (side === "live" ? 1 : 2);
        const item = decided(`${side}-${i}`).journal.records[0];
        return { ...item, gate: { ...item.gate, dispatch } } as typeof item;
      });
      return data;
    };
    const live = history("live");
    // Receipt-free unfinished owner sorts first but is never evictable.
    live.journal.records.push({ ...ready("owner"), parentTaskId: "task:2" });
    const incoming = history("incoming");
    const merged = merge(live, incoming);
    const swapped = merge(incoming, live);
    if (merged.kind !== "merged" || swapped.kind !== "merged")
      throw new Error("Expected eviction, not refusal");
    const retained = (journal: SubtaskRuntimeCheckpoint["journal"]) =>
      journal.records
        .map((item) => item.gate?.dispatch ?? 0)
        .sort((a, b) => a - b);
    const kept = retained(merged.component.journal);
    expect(kept.length).toBeLessThan(2 * count + 1);
    expect(kept[0]).toBe(0);
    // A contiguous newest suffix survives; every older finished record went.
    const oldest = kept[1] ?? 0;
    expect(kept.slice(1)).toEqual(
      Array.from({ length: 2 * count + 1 - oldest }, (_, i) => oldest + i),
    );
    expect(retained(swapped.component.journal).slice(1)).toEqual(kept.slice(1));
    expect(merged.component.journal.usage).toEqual(live.journal.usage);
    const reserved = mergeSubtaskRestoreHistory({
      live,
      incoming,
      targetStore: incoming.state,
      reservedBytes: 4096,
    });
    if (reserved.kind !== "merged") throw new Error("Expected reserved fit");
    expect(reserved.component.journal.records.length).toBeLessThan(kept.length);
  });
  it("rejects accessor inputs without executing them", () => {
    const live = component();
    const getter = vi.fn(() => component().journal);
    Object.defineProperty(live, "journal", { enumerable: true, get: getter });
    expect(
      mergeSubtaskRestoreHistory({
        live,
        incoming: component(),
        targetStore: component().state,
      }),
    ).toEqual({ kind: "refused", reason: "invalid-history" });
    expect(getter).not.toHaveBeenCalled();
  });
});
