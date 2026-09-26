import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkpointStorageStatus,
  commitSubtaskCheckpoint,
  encodeCheckpoint,
  encodeSubtaskCheckpoint,
  restoreSubtaskCheckpoint,
  subtaskCheckpointStorageStatus,
} from "../src/core/hybrid-checkpoint";
import { emptyState } from "../src/core/hybrid-state";
import {
  type SubtaskJournalCheckpoint,
  subtaskJournalIsValid,
} from "../src/core/subtask-journal";
import { SubtaskStore, subtaskCheckpointIsValid } from "../src/core/subtasks";
import { fixtureHealthCard } from "./fixtures/health-card";
import { initial, initialMessage } from "./fixtures/hybrid";
import {
  subtaskAdmission,
  subtaskHash,
  subtaskSource,
} from "./fixtures/subtasks";

const usage = () => ({
  jev: { calls: 0, inputTokens: 0, outputTokens: 0 },
  extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
});
const journal = (): SubtaskJournalCheckpoint => ({
  version: 1,
  dispatches: 0,
  usage: usage(),
  records: [],
});
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
async function fixture() {
  const state = await initial();
  const store = new SubtaskStore();
  const parent = state.tasks[0];
  expect(
    store.admit({
      ...subtaskAdmission(),
      parent,
      source: parent.source,
      children: [{ kind: "add", label: "Generic step", source: parent.source }],
    }),
  ).toEqual({ accepted: true });
  const monitor = {
    enabled: true,
    usage: usage(),
    healthCards: [fixtureHealthCard(parent, initialMessage)],
    subtasks: { state: store.checkpoint(), journal: journal() },
  };
  return { state, store, monitor };
}
const resolve = (id: string) =>
  id === initialMessage.id ? initialMessage : undefined;

describe("disconnected strict v11 generic subtask envelope", () => {
  beforeEach(() => {
    for (const api of [
      encodeSubtaskCheckpoint,
      restoreSubtaskCheckpoint,
      subtaskCheckpointStorageStatus,
      commitSubtaskCheckpoint,
    ])
      expect(api).toBeTypeOf("function");
  });
  it.each(["ready", "yes", "negative", "noop"])(
    "retains initial revision-zero %s journal authority without a group",
    async (mode) => {
      const { state, monitor } = await fixture();
      const parent = state.tasks[0];
      const source = parent.source;
      monitor.subtasks.state = new SubtaskStore().checkpoint();
      const data = monitor.subtasks.journal;
      const item: SubtaskJournalCheckpoint["records"][number] = {
        identity: subtaskHash(`initial-${mode}`),
        parentTaskId: parent.id,
        parentRevision: parent.revision,
        parentSourceDigest: subtaskHash(
          JSON.stringify([
            source.entryId,
            source.messageHash,
            source.role,
            source.start,
            source.end,
            source.quoteHash,
          ]),
        ),
        listRevision: 0,
        source,
        contextHash: subtaskHash("initial-context"),
        gateModel: "jev-1.13.0",
        selectedModel: "fixture/selected",
        phase: "gate-ready",
        state: "ready",
      };
      if (mode !== "ready") {
        data.dispatches = 1;
        data.usage.jev.calls = 1;
        item.phase = "gate-decided";
        item.gate = {
          requestHash: subtaskHash("gate"),
          dispatch: 1,
          at: 10,
          outcome: "decided",
          choice: mode === "negative" ? "no" : "yes",
          confidence: 1,
          probability: 1,
          usage: { inputTokens: 0, outputTokens: 0 },
        };
        if (mode === "negative") item.state = "complete";
      }
      if (mode === "noop") {
        data.dispatches = 2;
        data.usage.extraction.calls = 1;
        item.phase = "proposal-decided";
        item.state = "complete";
        item.proposal = {
          requestHash: subtaskHash("proposal"),
          dispatch: 2,
          at: 11,
          outcome: "noop",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
      data.records = [item];
      const checkpoint = encodeSubtaskCheckpoint(state, monitor);
      const restored = restoreSubtaskCheckpoint(
        checkpoint,
        state.sourceId,
        resolve,
        () => [],
        () => true,
      );
      expect(restored?.monitor?.subtasks?.journal).toEqual(data);
    },
  );
  it.each([
    [0, 1, "accepted", false],
    [1, 2, "accepted", false],
    [1, 1, "accepted", false],
    [1, 1, "noop", false],
    [0, 1, "accepted", true],
  ] as const)(
    "restores proposal frontier %s→%s %s, missing list=%s",
    async (prior, resultRevision, outcome, missing) => {
      const { state, monitor, store } = await fixture();
      const parent = state.tasks[0];
      if (resultRevision === 2) {
        const group = store.snapshot().groups[0];
        expect(
          store.admit({
            ...subtaskAdmission(),
            parent,
            source: parent.source,
            expectedListRevision: 1,
            children: [
              {
                kind: "reword",
                id: group.children[0].id,
                label: "Refined generic step",
                source: parent.source,
              },
            ],
          }),
        ).toEqual({ accepted: true });
      }
      monitor.subtasks.state = missing
        ? new SubtaskStore().checkpoint()
        : store.checkpoint();
      const source = parent.source;
      const data = monitor.subtasks.journal;
      data.dispatches = 2;
      data.usage.jev.calls = 1;
      data.usage.extraction.calls = 1;
      data.records = [
        {
          identity: subtaskHash("accepted-job"),
          parentTaskId: parent.id,
          parentRevision: parent.revision,
          parentSourceDigest: subtaskHash(
            JSON.stringify([
              source.entryId,
              source.messageHash,
              source.role,
              source.start,
              source.end,
              source.quoteHash,
            ]),
          ),
          listRevision: prior,
          source,
          contextHash: subtaskHash("context"),
          gateModel: "jev-1.13.0",
          selectedModel: "fixture/selected",
          phase: "proposal-decided",
          state: "complete",
          gate: {
            requestHash: subtaskHash("gate"),
            dispatch: 1,
            at: 10,
            outcome: "decided",
            choice: "yes",
            confidence: 1,
            probability: 1,
            usage: { inputTokens: 0, outputTokens: 0 },
          },
          proposal: {
            requestHash: subtaskHash("proposal"),
            dispatch: 2,
            at: 11,
            outcome,
            ...(outcome === "accepted" ? { listRevision: resultRevision } : {}),
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        },
      ];
      const restored = restoreSubtaskCheckpoint(
        encodeSubtaskCheckpoint(state, monitor),
        state.sourceId,
        resolve,
        () => [],
        () => true,
      );
      expect(restored?.monitor?.subtasks?.journal.records).toEqual(
        missing ? [] : data.records,
      );
      expect(restored?.monitor?.subtasks?.journal.dispatches).toBe(2);
    },
  );
  it("does not commit an exact ON boundary that cannot persist OFF", () => {
    const state = emptyState("s");
    const monitor = { enabled: true, usage: usage() };
    const base = bytes(encodeSubtaskCheckpoint(state, monitor));
    state.sourceId = "s".repeat(1 + 524288 - base);
    expect(bytes(encodeSubtaskCheckpoint(state, monitor))).toBe(524288);
    expect(() =>
      encodeSubtaskCheckpoint(state, { ...monitor, enabled: false }),
    ).toThrow();
    const save = vi.fn(() => true);
    expect(commitSubtaskCheckpoint(state, monitor, save)).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
    state.sourceId = state.sourceId.slice(1);
    expect(commitSubtaskCheckpoint(state, monitor, save)).toBeDefined();
    expect(save).toHaveBeenCalledTimes(1);
  });
  it("rejects grossly oversized scalars before unbounded trim scans", () => {
    const state = emptyState("s".repeat(1024 * 1024));
    const original = String.prototype.trim;
    let oversizedTrims = 0;
    const spy = vi.spyOn(String.prototype, "trim").mockImplementation(function (
      this: string,
    ) {
      if (this.length > 524288) oversizedTrims++;
      return original.call(this);
    });
    let rejected = false;
    try {
      encodeSubtaskCheckpoint(state);
    } catch {
      rejected = true;
    } finally {
      spy.mockRestore();
    }
    expect(rejected).toBe(true);
    expect(oversizedTrims).toBe(0);
  });
  it("roundtrips generic state while preserving parent and independent-health facts", async () => {
    const { state, monitor } = await fixture();
    const checkpoint = encodeSubtaskCheckpoint(state, monitor);
    expect(checkpoint.version).toBe(11);
    expect(subtaskCheckpointStorageStatus(checkpoint)).toBe("supported");
    const restored = restoreSubtaskCheckpoint(
      checkpoint,
      state.sourceId,
      resolve,
      () => [],
      () => true,
    );
    expect(restored?.state).toEqual(state);
    expect(restored?.monitor).toEqual(monitor);
    if (!restored?.monitor?.subtasks)
      throw new Error("Expected restored subtasks");
    restored.monitor.subtasks.state.groups[0].children[0].label =
      "Caller change";
    expect(
      checkpoint.monitor?.subtasks?.state.groups[0].children[0].label,
    ).toBe("Generic step");
  });
  it("prunes stale optional sources while preserving parent state, wallet and allocators", async () => {
    const { state, monitor } = await fixture();
    const store = new SubtaskStore();
    const parent = state.tasks[0];
    const stale = subtaskSource("stale-optional");
    expect(
      store.admit({
        ...subtaskAdmission(),
        parent,
        source: stale,
        children: [{ kind: "add", label: "Stale child", source: stale }],
      }),
    ).toEqual({ accepted: true });
    monitor.subtasks.state = store.checkpoint();
    monitor.subtasks.journal.dispatches = 1;
    monitor.subtasks.journal.usage.jev.calls = 1;
    monitor.subtasks.journal.records = [
      {
        identity: subtaskHash("stale-job"),
        parentTaskId: parent.id,
        parentRevision: parent.revision,
        parentSourceDigest: subtaskHash("parent"),
        listRevision: 0,
        source: stale,
        contextHash: subtaskHash("context"),
        gateModel: "jev-1.13.0",
        selectedModel: "fixture/selected",
        phase: "gate-ready",
        state: "ready",
      },
    ];
    const result = restoreSubtaskCheckpoint(
      encodeSubtaskCheckpoint(state, monitor),
      state.sourceId,
      resolve,
      () => [],
      () => true,
    );
    expect(result?.state).toEqual(state);
    expect(result?.monitor?.subtasks?.state.groups).toEqual([]);
    expect(result?.monitor?.subtasks?.state.nextGroupId).toBe(2);
    expect(result?.monitor?.subtasks?.journal.records).toEqual([]);
    expect(result?.monitor?.subtasks?.journal.dispatches).toBe(1);
  });
  it("rejects hidden serialization hooks without executing them", async () => {
    const { state, monitor } = await fixture();
    let calls = 0;
    Object.defineProperty(monitor, "toJSON", {
      value: () => {
        calls++;
        return {};
      },
    });
    expect(() => encodeSubtaskCheckpoint(state, monitor)).toThrow();
    expect(calls).toBe(0);
  });
  it("keeps active v10 unchanged and never treats it as v11 or migrates it", async () => {
    const { state, monitor } = await fixture();
    const old = encodeCheckpoint(state, { enabled: true, usage: usage() });
    expect(old.version).toBe(10);
    expect(checkpointStorageStatus(old)).toBe("supported");
    expect(subtaskCheckpointStorageStatus(old)).toBe("unsupported");
    expect(
      restoreSubtaskCheckpoint(
        old,
        state.sourceId,
        resolve,
        () => [],
        () => true,
      ),
    ).toBeUndefined();
    expect(
      checkpointStorageStatus(encodeSubtaskCheckpoint(state, monitor)),
    ).toBe("unsupported");
  });
  it.each([true, false])(
    "enforces the exact whole512KiB bound for enabled=%s without shrinking valid parent capacity",
    (enabled) => {
      const state = emptyState("s");
      const monitor = { enabled, usage: usage() };
      const base = bytes(encodeCheckpoint(state, monitor));
      state.sourceId = "s".repeat(1 + 524288 - base);
      expect(bytes(encodeCheckpoint(state, monitor))).toBe(524288);
      expect(bytes(encodeSubtaskCheckpoint(state, monitor))).toBe(524288);
      state.sourceId += "s";
      expect(() => encodeSubtaskCheckpoint(state, monitor)).toThrow();
    },
  );
  it("counts store plus journal and wrapper together under64KiB", async () => {
    const { state, monitor } = await fixture();
    const store = new SubtaskStore();
    for (const parent of state.tasks.slice(0, 2))
      expect(
        store.admit({
          ...subtaskAdmission(),
          parent,
          source: parent.source,
          children: Array.from({ length: 40 }, (_, i) => ({
            kind: "add" as const,
            label: `${i}:${"x".repeat(180)}`,
            source: parent.source,
          })),
        }),
      ).toEqual({ accepted: true });
    monitor.subtasks.state = store.checkpoint();
    const data = monitor.subtasks.journal;
    data.dispatches = 20;
    data.usage.jev.calls = 20;
    data.records = Array.from({ length: 20 }, (_, i) => ({
      identity: subtaskHash(`job${i}`),
      parentTaskId: state.tasks[0].id,
      parentRevision: 1,
      parentSourceDigest: subtaskHash("parent"),
      listRevision: 0,
      source: state.tasks[0].source,
      contextHash: subtaskHash(`context${i}`),
      gateModel: "jev-1.13.0",
      selectedModel: "😀".repeat(512),
      phase: "gate-decided" as const,
      state: "complete" as const,
      gate: {
        requestHash: subtaskHash(`gate${i}`),
        dispatch: i + 1,
        at: i,
        outcome: "decided" as const,
        choice: "no" as const,
        confidence: 1,
        probability: 1,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    }));
    expect(subtaskCheckpointIsValid(monitor.subtasks.state)).toBe(true);
    expect(subtaskJournalIsValid(data)).toBe(true);
    expect(bytes(monitor.subtasks)).toBeGreaterThan(65536);
    for (const enabled of [true, false])
      expect(() =>
        encodeSubtaskCheckpoint(state, { ...monitor, enabled }),
      ).toThrow();
  });
  it.each(["legacy", "extra", "bad-health", "bad-journal"])(
    "rejects %s metadata without stripping invalid data",
    async (mode) => {
      const { state, monitor } = await fixture();
      if (mode === "legacy") Object.assign(monitor, { coverage: {} });
      if (mode === "extra")
        Object.assign(monitor.subtasks, { rawPrompt: "private" });
      if (mode === "bad-health") monitor.healthCards[0].revision = -1;
      if (mode === "bad-journal") monitor.subtasks.journal.dispatches = 1;
      expect(() => encodeSubtaskCheckpoint(state, monitor)).toThrow();
    },
  );
  it.each(["false", "throw"])(
    "does not publish candidate when storage returns %s",
    async (mode) => {
      const { state, monitor } = await fixture();
      const before = structuredClone({ state, monitor });
      const save = vi.fn(() => {
        if (mode === "throw") throw new Error("disk failure");
        return false;
      });
      expect(commitSubtaskCheckpoint(state, monitor, save)).toBeUndefined();
      expect(save).toHaveBeenCalledTimes(1);
      expect({ state, monitor }).toEqual(before);
    },
  );
  it("publishes only a successfully persisted detached candidate", async () => {
    const { state, monitor } = await fixture();
    const save = vi.fn(() => true);
    const saved = commitSubtaskCheckpoint(state, monitor, save);
    expect(saved).toEqual(encodeSubtaskCheckpoint(state, monitor));
    expect(save).toHaveBeenCalledTimes(1);
    if (!saved) throw new Error("Expected committed checkpoint");
    saved.state.tasks[0].label = "Changed return";
    expect(state.tasks[0].label).not.toBe("Changed return");
  });
  it("does not call storage for an invalid candidate", async () => {
    const { state, monitor } = await fixture();
    monitor.subtasks.journal.dispatches = 1025;
    const save = vi.fn(() => true);
    expect(commitSubtaskCheckpoint(state, monitor, save)).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });
});
