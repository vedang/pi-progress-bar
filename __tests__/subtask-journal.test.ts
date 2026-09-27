import { describe, expect, it, vi } from "vitest";
import {
  nextSubtaskPhase,
  restoreSubtaskJournal,
  type SubtaskJournalCheckpoint,
  type SubtaskPhaseRecord,
  subtaskJournalIsValid,
} from "../src/core/subtask-journal";
import { subtaskHash, subtaskSource } from "./fixtures/subtasks";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected fixture value");
  return value;
}

function record(): SubtaskPhaseRecord {
  return {
    identity: subtaskHash("job"),
    parentTaskId: "task:1",
    parentRevision: 1,
    parentSourceDigest: subtaskHash("parent"),
    listRevision: 0,
    source: subtaskSource(),
    contextHash: subtaskHash("context"),
    ...{ triggerHash: subtaskHash("trigger") },
    gateModel: "jev-1.13.0",
    selectedModel: "fixture/selected",
    phase: "gate-ready",
    state: "ready",
  };
}
function journal(): SubtaskJournalCheckpoint {
  return {
    version: 1,
    dispatches: 0,
    usage: {
      jev: { calls: 0, inputTokens: 0, outputTokens: 0 },
      extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
    },
    records: [record()],
  };
}
function decided() {
  const data = journal();
  const item = data.records[0];
  data.dispatches = 1;
  data.usage.jev = { calls: 1, inputTokens: 2, outputTokens: 3 };
  item.phase = "gate-decided";
  item.gate = {
    requestHash: subtaskHash("gate"),
    dispatch: 1,
    at: 10,
    outcome: "decided",
    choice: "yes",
    confidence: 0.5,
    probability: 0.8,
    usage: { inputTokens: 2, outputTokens: 3 },
  };
  return data;
}

describe("durable generic decomposition phases", () => {
  it.each([
    "ready",
    "gate-dispatched",
    "gate-failed",
    "yes",
    "proposal-dispatched",
    "proposal-failed",
    "accepted",
    "noop",
  ])(
    "retains superseded %s proof without permission or unfinished ownership",
    (mode) => {
      const data =
        mode === "ready" || mode.startsWith("gate-") ? journal() : decided();
      const item = data.records[0];
      if (mode.startsWith("gate-")) {
        data.dispatches = 1;
        data.usage.jev.calls = 1;
        item.gate = {
          requestHash: subtaskHash("old-gate"),
          dispatch: 1,
          at: 10,
          outcome: mode === "gate-failed" ? "failed" : "dispatched",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
      if (
        mode.startsWith("proposal-") ||
        mode === "accepted" ||
        mode === "noop"
      ) {
        data.dispatches = 2;
        data.usage.extraction.calls = 1;
        item.phase =
          mode === "accepted" || mode === "noop"
            ? "proposal-decided"
            : "gate-decided";
        item.proposal = {
          requestHash: subtaskHash("old-proposal"),
          dispatch: 2,
          at: 11,
          outcome:
            mode === "proposal-dispatched"
              ? "dispatched"
              : mode === "proposal-failed"
                ? "failed"
                : mode === "accepted"
                  ? "accepted"
                  : "noop",
          ...(mode === "accepted" ? { listRevision: 1 } : {}),
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
      Object.assign(item, { state: "superseded" });
      data.records.push({
        ...record(),
        identity: subtaskHash("new-owner"),
        contextHash: subtaskHash("new-context"),
        triggerHash: subtaskHash("new-trigger"),
      });
      expect(subtaskJournalIsValid(data)).toBe(true);
      const callback = vi.fn(() => true);
      const restored = required(restoreSubtaskJournal(data, callback));
      expect(restored).toEqual(data);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(nextSubtaskPhase(restored, item.identity)).toBeUndefined();
      expect(nextSubtaskPhase(restored, data.records[1].identity)).toBe("gate");
      const invalid = structuredClone(data);
      Object.assign(invalid.records[0], { parkedUntil: 99 });
      expect(subtaskJournalIsValid(invalid)).toBe(false);
      if (item.gate) {
        const malformed = structuredClone(data);
        Reflect.deleteProperty(
          malformed.records[0].gate as object,
          "requestHash",
        );
        expect(subtaskJournalIsValid(malformed)).toBe(false);
      }
    },
  );
  it("clears only obsolete parked deadline when retiring noncurrent proof", () => {
    const data = journal();
    data.dispatches = 1;
    data.usage.jev.calls = 1;
    Object.assign(data.records[0], {
      state: "parked",
      parkedUntil: 100,
      gate: {
        requestHash: subtaskHash("gate"),
        dispatch: 1,
        at: 10,
        outcome: "failed",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
    const before = structuredClone(data.records[0]);
    Reflect.deleteProperty(before, "parkedUntil");
    expect(restoreSubtaskJournal(data, () => false)?.records).toEqual([
      { ...before, state: "superseded" },
    ]);
  });
  it("requires the independent trigger without a legacy restore fallback", () => {
    const data = journal();
    Reflect.deleteProperty(data.records[0], "triggerHash");
    expect(subtaskJournalIsValid(data)).toBe(false);
    expect(restoreSubtaskJournal(data, () => true)).toBeUndefined();
  });
  it("preserves a detached trigger through journal restore", () => {
    const data = journal();
    expect(subtaskJournalIsValid(data)).toBe(true);
    const restored = restoreSubtaskJournal(data, () => true);
    expect(restored?.records[0]).toMatchObject({
      triggerHash: subtaskHash("trigger"),
    });
    Reflect.set(data.records[0], "triggerHash", subtaskHash("changed"));
    expect(restored?.records[0]).toMatchObject({
      triggerHash: subtaskHash("trigger"),
    });
  });
  it.each(["", "not-a-hash", "a".repeat(65), 1, null])(
    "rejects malformed trigger %s",
    (triggerHash) => {
      const data = journal();
      Reflect.set(data.records[0], "triggerHash", triggerHash);
      expect(subtaskJournalIsValid(data)).toBe(false);
    },
  );

  it("snapshots wallet before a currentness callback mutates the original journal", () => {
    const data = decided();
    const before = structuredClone(data);
    const restored = restoreSubtaskJournal(data, () => {
      data.dispatches = 0;
      data.usage.jev = { calls: 0, inputTokens: 0, outputTokens: 0 };
      return false;
    });
    expect(restored?.records).toEqual(
      before.records.map((item) => ({ ...item, state: "superseded" })),
    );
    expect(restored?.dispatches).toBe(before.dispatches);
    expect(restored?.usage).toEqual(before.usage);
  });
  it("retains validated record snapshot despite closure mutation during currentness", () => {
    const data = decided();
    const before = structuredClone(data);
    const restored = restoreSubtaskJournal(data, () => {
      data.records[0].identity = subtaskHash("injected-record");
      data.records[0].selectedModel = "injected/model";
      return true;
    });
    expect(restored).toEqual(before);
  });
  it("restores ready gate and detached provenance without scheduling providers", () => {
    const data = journal();
    expect(subtaskJournalIsValid(data)).toBe(true);
    const restored = restoreSubtaskJournal(data, () => true);
    expect(restored).toEqual(data);
    expect(nextSubtaskPhase(required(restored), data.records[0].identity)).toBe(
      "gate",
    );
    required(restored).records[0].source.entryId = "changed";
    expect(data.records[0].source.entryId).toBe("request");
  });
  it("restores accepted yes directly to proposal without repeating gate", () => {
    const data = decided();
    expect(subtaskJournalIsValid(data)).toBe(true);
    const restored = restoreSubtaskJournal(data, () => true);
    expect(restored).toEqual(data);
    expect(nextSubtaskPhase(required(restored), data.records[0].identity)).toBe(
      "proposal",
    );
    expect(restored?.dispatches).toBe(1);
  });
  it.each(["no", "uncertain", "low-confidence", "low-probability"])(
    "retains terminal %s decision without proposing",
    (mode) => {
      const data = decided();
      const item = data.records[0];
      item.state = "complete";
      if (mode === "no" || mode === "uncertain")
        Object.assign(required(item.gate), {
          choice: mode,
          confidence: 1,
          probability: 1,
        });
      if (mode === "low-confidence") required(item.gate).confidence = 0.499;
      if (mode === "low-probability") required(item.gate).probability = 0.799;
      expect(subtaskJournalIsValid(data)).toBe(true);
      expect(
        nextSubtaskPhase(
          required(restoreSubtaskJournal(data, () => true)),
          item.identity,
        ),
      ).toBeUndefined();
    },
  );
  it("restores accepted proposal without either call and preserves explicit next list revision", () => {
    const data = decided();
    const item = data.records[0];
    data.dispatches = 2;
    data.usage.extraction = { calls: 1, inputTokens: 5, outputTokens: 7 };
    item.phase = "proposal-decided";
    item.state = "complete";
    item.proposal = {
      requestHash: subtaskHash("proposal"),
      dispatch: 2,
      at: 11,
      outcome: "accepted",
      listRevision: 1,
      usage: { inputTokens: 5, outputTokens: 7 },
    };
    const restored = restoreSubtaskJournal(data, () => true);
    expect(restored).toEqual(data);
    expect(nextSubtaskPhase(required(restored), item.identity)).toBeUndefined();
  });
  it("preserves charged crash-before-receipt as permanent, never silently re-bills", () => {
    const data = journal();
    const item = data.records[0];
    data.dispatches = 1;
    data.usage.jev.calls = 1;
    item.state = "dispatched";
    item.gate = {
      requestHash: subtaskHash("gate"),
      dispatch: 1,
      at: 10,
      outcome: "dispatched",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
    expect(subtaskJournalIsValid(data)).toBe(true);
    const restored = restoreSubtaskJournal(data, () => true);
    expect(restored?.records[0].state).toBe("permanent");
    expect(restored?.dispatches).toBe(1);
    expect(nextSubtaskPhase(required(restored), item.identity)).toBeUndefined();
  });
  it("retires stale authority into history while retaining lifetime charges and usage", () => {
    const data = decided();
    const restored = restoreSubtaskJournal(data, () => false);
    expect(restored?.records).toEqual(
      data.records.map((item) => ({ ...item, state: "superseded" })),
    );
    expect(
      nextSubtaskPhase(required(restored), data.records[0].identity),
    ).toBeUndefined();
    expect(restored?.dispatches).toBe(1);
    expect(restored?.usage).toEqual(data.usage);
    expect(
      restoreSubtaskJournal(data, () => {
        throw new Error("unavailable");
      })?.records,
    ).toEqual(data.records.map((item) => ({ ...item, state: "superseded" })));
  });
  it("a new changed context can be ready despite a retained old negative", () => {
    const data = decided();
    data.records[0].state = "complete";
    Object.assign(required(data.records[0].gate), {
      choice: "no",
      confidence: 1,
      probability: 1,
    });
    const next = {
      ...record(),
      identity: subtaskHash("new-job"),
      contextHash: subtaskHash("new-context"),
    };
    data.records.push(next);
    expect(subtaskJournalIsValid(data)).toBe(true);
    expect(nextSubtaskPhase(data, next.identity)).toBe("gate");
  });
  it("shared1024 ceiling blocks proposal after the last allowed gate yes", () => {
    const data = decided();
    data.dispatches = 1024;
    data.usage.jev.calls = 1024;
    required(data.records[0].gate).dispatch = 1024;
    expect(subtaskJournalIsValid(data)).toBe(true);
    expect(nextSubtaskPhase(data, data.records[0].identity)).toBeUndefined();
    data.dispatches++;
    data.usage.jev.calls++;
    expect(subtaskJournalIsValid(data)).toBe(false);
  });
  it.each([
    "version",
    "extra",
    "model",
    "duplicate",
    "future-dispatch",
    "usage",
    "missing-gate",
    "negative-ready",
    "proposal-before-gate",
    "raw-prompt",
  ])("rejects inconsistent or unsupported journal %s", (mode) => {
    const data = decided();
    const item = data.records[0];
    if (mode === "version") Object.assign(data, { version: 2 });
    if (mode === "extra") Object.assign(data, { callId: "runtime-call" });
    if (mode === "model") item.gateModel = "jev-latest";
    if (mode === "duplicate") data.records.push(structuredClone(item));
    if (mode === "future-dispatch") required(item.gate).dispatch = 2;
    if (mode === "usage") data.usage.jev.inputTokens = 0;
    if (mode === "missing-gate") delete item.gate;
    if (mode === "negative-ready")
      Object.assign(required(item.gate), {
        choice: "no",
        confidence: 1,
        probability: 1,
      });
    if (mode === "proposal-before-gate") {
      item.phase = "gate-ready";
      item.proposal = {
        requestHash: subtaskHash("proposal"),
        dispatch: 1,
        at: 11,
        outcome: "noop",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }
    if (mode === "raw-prompt")
      Object.assign(item, { prompt: "private raw conversation" });
    expect(subtaskJournalIsValid(data)).toBe(false);
    expect(restoreSubtaskJournal(data, () => true)).toBeUndefined();
  });
  it("bounds active owner jobs independently from retained terminal receipts", () => {
    const data = journal();
    data.records = Array.from({ length: 20 }, (_, i) => ({
      ...record(),
      identity: subtaskHash(`job:${i}`),
      parentTaskId: `task:${i + 1}`,
    }));
    expect(subtaskJournalIsValid(data)).toBe(true);
    data.records.push({
      ...record(),
      identity: subtaskHash("job:21"),
      parentTaskId: "task:21",
    });
    expect(subtaskJournalIsValid(data)).toBe(false);
  });
  it("rejects hooks without executing serialization or getters", () => {
    const data = journal();
    let touched = 0;
    Object.defineProperty(data, "toJSON", {
      value: () => {
        touched++;
        return {};
      },
    });
    expect(subtaskJournalIsValid(data)).toBe(false);
    expect(touched).toBe(0);
  });
});
