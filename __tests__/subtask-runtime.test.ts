import { describe, expect, it, vi } from "vitest";
import { MODEL, type ValidatedResult } from "../src/analysis/gateway";
import type { SubtaskGateBatch } from "../src/analysis/subtask-gate";
import type { buildSubtaskProposal } from "../src/analysis/subtask-proposal";
import type { SubtaskJournalCheckpoint } from "../src/core/subtask-journal";
import { SubtaskRuntime } from "../src/core/subtask-runtime";
import { SubtaskStore } from "../src/core/subtasks";
import { subtaskAccessFixture } from "./fixtures/subtask-access";
import { subtaskProposalFixture } from "./fixtures/subtask-proposal";

type Component = {
  state: ReturnType<SubtaskStore["checkpoint"]>;
  journal: SubtaskJournalCheckpoint;
};
type ProposalRequest = NonNullable<ReturnType<typeof buildSubtaskProposal>>;
const empty = (): Component => ({
  state: new SubtaskStore().checkpoint(),
  journal: {
    version: 1,
    dispatches: 0,
    records: [],
    reports: [],
    usage: {
      jev: { calls: 0, inputTokens: 0, outputTokens: 0 },
      extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
    },
  },
});
function fixture(expectedProposalDispatch: number | (() => number) = 2) {
  const h = subtaskProposalFixture();
  const saved: Component[] = [];
  let enabled = true;
  let choice: "yes" | "no" | "uncertain" = "yes";
  const current = () => ({
    sourceId: "runtime-fixture",
    enabled,
    parents: [h.parent],
    latest: h.options.latest,
    earlier: h.options.earlier,
    omissions: h.options.omissions,
    selectedModel: h.options.selectedModel,
    resolve: h.options.resolve,
    ...(h.options.evidence === undefined
      ? {}
      : { evidence: h.options.evidence }),
  });
  const commit = vi.fn((candidate: Component) => {
    saved.push(structuredClone(candidate));
    return true;
  });
  const onPublish = vi.fn();
  const network = vi.fn();
  const gate = vi.fn(
    async (
      batch: SubtaskGateBatch,
      signal: AbortSignal,
      onDispatch: (at: number) => boolean,
      _onPhysicalFlight?: (drain: Promise<void>) => void,
    ): Promise<ValidatedResult | undefined> => {
      if (!onDispatch(100) || signal.aborted) return;
      network("gate");
      expect(
        saved
          .at(-1)
          ?.journal.records.some(
            (r) => r.state === "dispatched" && r.gate?.outcome === "dispatched",
          ),
      ).toBe(true);
      return {
        model: MODEL,
        usage: { input_tokens: 3, output_tokens: 5 },
        answers: Object.fromEntries(
          Object.keys(batch.request.questions).map((key) => [
            key,
            {
              type: "choice",
              choice,
              confidence: 1,
              probabilities: {
                yes: choice === "yes" ? 1 : 0,
                no: choice === "no" ? 1 : 0,
                uncertain: choice === "uncertain" ? 1 : 0,
              },
            },
          ]),
        ),
      };
    },
  );
  const propose = vi.fn(
    async (
      request: ProposalRequest,
      signal: AbortSignal,
      onDispatch: (at: number) => boolean,
      _onPhysicalFlight?: (drain: Promise<void>) => void,
    ) => {
      if (!onDispatch(101) || signal.aborted) throw new Error("vetoed");
      network("proposal");
      expect(saved.at(-1)?.journal.dispatches).toBe(
        typeof expectedProposalDispatch === "function"
          ? expectedProposalDispatch()
          : expectedProposalDispatch,
      );
      expect(
        saved
          .at(-1)
          ?.journal.records.some(
            (r) =>
              r.gate?.choice === "yes" && r.proposal?.outcome === "dispatched",
          ),
      ).toBe(true);
      const contextIndex = request.input.context.findIndex(
        (item) => item.id === h.latest.id,
      );
      return {
        provider: "fixture",
        model: "selected",
        requestHash: request.requestHash,
        usage: { inputTokens: 7, outputTokens: 9 },
        text: JSON.stringify({
          proposals: [
            {
              parentIndex: 0,
              complete: false,
              removals: [],
              children: [
                "Compare operating costs",
                "Recommend deployment approach",
              ].map((label) => ({
                kind: "add",
                label,
                evidence: [
                  { contextIndex, start: 0, end: h.latest.text.length },
                ],
              })),
            },
          ],
        }),
      };
    },
  );
  const create = (initial = empty()) =>
    new SubtaskRuntime({ initial, current, gate, propose, commit, onPublish });
  return {
    ...h,
    saved,
    network,
    commit,
    onPublish,
    gate,
    propose,
    create,
    disable: () => {
      enabled = false;
    },
    choose: (value: typeof choice) => {
      choice = value;
    },
  };
}

function associatedFixture() {
  const h = fixture();
  const evidence = subtaskAccessFixture([["One", "Two"]]);
  h.options.evidence = evidence.adapter.metadata();
  const original = h.propose.getMockImplementation();
  if (!original) throw new Error("Missing proposal transport");
  h.propose.mockImplementation(async (...args) => ({
    ...(await original(...args)),
    text: evidence.propose([
      { resourceIndex: 0, itemIndex: 0 },
      { resourceIndex: 0, itemIndex: 1 },
    ]).raw,
  }));
  return { ...h, evidence };
}

describe("durable generic subtask runtime", () => {
  it.each(["ready-yes", "proposal-dispatched"])(
    "retires %s without granting its old proposal permission",
    async (mode) => {
      const h = fixture();
      const propose = h.propose.getMockImplementation();
      if (!propose) throw new Error("Missing proposal");
      h.propose.mockImplementationOnce(async (...args) => {
        if (mode === "proposal-dispatched") await propose(...args);
        throw new Error("No proposal result");
      });
      const runtime = h.create();
      await runtime.run(h.parent.id);
      const old = structuredClone(runtime.checkpoint().journal.records[0]);
      expect(old).toMatchObject({
        phase: "gate-decided",
        state: mode === "ready-yes" ? "ready" : "dispatched",
        gate: { choice: "yes" },
      });
      const charges = runtime.checkpoint().journal.dispatches;
      expect(charges).toBe(mode === "ready-yes" ? 1 : 2);
      h.options.selectedModel = "fixture/new-model";
      h.choose("no");
      await runtime.run(h.parent.id);
      expect(runtime.checkpoint().journal.records).toContainEqual({
        ...old,
        state: "superseded",
      });
      expect(runtime.checkpoint().journal.dispatches).toBe(charges + 1);
      expect(h.propose).toHaveBeenCalledTimes(1);
      expect(runtime.snapshot().groups).toEqual([]);
    },
  );
  it("retains superseded charged history at lifetime exhaustion without a fresh network call", async () => {
    const h = fixture();
    h.choose("no");
    const runtime = h.create();
    await runtime.run(h.parent.id);
    const initial = structuredClone(runtime.checkpoint());
    const old = structuredClone(initial.journal.records[0]);
    initial.journal.dispatches = 1024;
    initial.journal.usage.jev.calls = 1024;
    h.options.selectedModel = "fixture/new-model";
    const restored = h.create(initial);
    await restored.run(h.parent.id);
    expect(restored.checkpoint().journal.records).toContainEqual({
      ...old,
      state: "superseded",
    });
    expect(restored.checkpoint().journal.dispatches).toBe(1024);
    expect(h.network.mock.calls).toEqual([["gate"]]);
    expect(h.propose).not.toHaveBeenCalled();
  });
  it.each(["refinement", "parent-revision"])(
    "keeps every committed accepted frontier coherent across %s",
    async (mode) => {
      let expectedDispatch = 2;
      const h = fixture(() => expectedDispatch);
      const runtime = h.create();
      await runtime.run(h.parent.id);
      const oldRecord = structuredClone(
        runtime.checkpoint().journal.records[0],
      );
      const oldGroup = runtime.snapshot().groups[0];
      expect(oldRecord.proposal?.outcome).toBe("accepted");
      expectedDispatch = 4;
      if (mode === "parent-revision") h.parent.revision++;
      else {
        h.options.omissions = ["Additional context unavailable"];
        const original = h.propose.getMockImplementation();
        if (!original) throw new Error("Missing proposal");
        h.propose.mockImplementation(async (...args) => {
          const result = await original(...args);
          const request = args[0];
          const contextIndex = request.input.context.findIndex(
            (item) => item.id === h.latest.id,
          );
          return {
            ...result,
            text: JSON.stringify({
              proposals: [
                {
                  parentIndex: 0,
                  complete: false,
                  removals: [],
                  children: oldGroup.children.map((child, childIndex) =>
                    childIndex === 0
                      ? {
                          kind: "reword",
                          childIndex,
                          label: `${child.label} carefully`,
                          evidence: [
                            {
                              contextIndex,
                              start: 0,
                              end: h.latest.text.length,
                            },
                          ],
                        }
                      : { kind: "retain", childIndex },
                  ),
                },
              ],
            }),
          };
        });
      }
      await runtime.run(h.parent.id);
      expect(runtime.checkpoint().journal.dispatches).toBe(4);
      expect(runtime.checkpoint().journal.records).toContainEqual({
        ...oldRecord,
        state: "superseded",
      });
      for (const saved of h.saved)
        for (const record of saved.journal.records)
          if (
            record.state !== "superseded" &&
            record.proposal?.outcome === "accepted"
          )
            expect(
              saved.state.groups.some(
                (group) =>
                  group.parentTaskId === record.parentTaskId &&
                  group.parentRevision === record.parentRevision &&
                  group.listRevision === record.proposal?.listRevision,
              ),
            ).toBe(true);
      const history = runtime.checkpoint();
      const restored = h.create(history);
      await restored.run(h.parent.id);
      expect(restored.checkpoint().journal.records).toEqual(
        history.journal.records,
      );
      expect(h.gate).toHaveBeenCalledTimes(2);
      expect(h.propose).toHaveBeenCalledTimes(2);
    },
  );
  it.each([false, true])(
    "retains exact A→B→A charged history without stale permission (reload: %s)",
    async (reload) => {
      const h = fixture();
      h.choose("no");
      const gate = h.gate.getMockImplementation();
      if (!gate) throw new Error("Missing gate");
      h.gate.mockImplementationOnce(async (...args) => {
        await gate(...args);
        throw new Error("failed A");
      });
      let runtime = h.create();
      await runtime.run(h.parent.id);
      const originalModel = h.options.selectedModel;
      const a = structuredClone(runtime.checkpoint().journal.records[0]);
      expect(a).toMatchObject({
        state: "dispatched",
        gate: { outcome: "dispatched", dispatch: 1 },
      });
      h.options.selectedModel = "fixture/other";
      if (reload) runtime = h.create(runtime.checkpoint());
      await runtime.run(h.parent.id);
      expect(runtime.checkpoint().journal.records).toContainEqual({
        ...a,
        state: "superseded",
      });
      expect(h.network.mock.calls).toEqual([["gate"], ["gate"]]);
      h.options.selectedModel = originalModel;
      if (reload) runtime = h.create(runtime.checkpoint());
      await runtime.run(h.parent.id);
      expect(h.network.mock.calls).toEqual([["gate"], ["gate"]]);
      expect(h.propose).not.toHaveBeenCalled();
      expect(runtime.checkpoint().journal.dispatches).toBe(2);
      expect(runtime.checkpoint().journal.records).toHaveLength(2);
    },
  );
  it.each(["refused", "post-save-invalidated"])(
    "retires old ownership only with atomic new charge: %s",
    async (mode) => {
      const h = fixture();
      h.choose("no");
      const gate = h.gate.getMockImplementation();
      if (!gate) throw new Error("Missing gate");
      h.gate.mockImplementationOnce(async (...args) => {
        await gate(...args);
        throw new Error("failed A");
      });
      const runtime = h.create();
      await runtime.run(h.parent.id);
      const before = runtime.checkpoint();
      const saveCount = h.commit.mock.calls.length;
      h.options.selectedModel = "fixture/other";
      h.commit.mockImplementation((candidate) => {
        if (mode === "refused") return false;
        h.saved.push(structuredClone(candidate));
        runtime.invalidate();
        return true;
      });
      await runtime.run(h.parent.id);
      expect(h.commit).toHaveBeenCalledTimes(saveCount + 1);
      expect(h.network.mock.calls).toEqual([["gate"]]);
      expect(h.propose).not.toHaveBeenCalled();
      if (mode === "refused") expect(runtime.checkpoint()).toEqual(before);
      else {
        expect(runtime.checkpoint().journal.dispatches).toBe(2);
        expect(runtime.checkpoint().journal.records).toContainEqual({
          ...before.journal.records[0],
          state: "superseded",
        });
        expect(runtime.checkpoint().journal.records).toContainEqual(
          expect.objectContaining({
            state: "dispatched",
            gate: expect.objectContaining({
              dispatch: 2,
              outcome: "dispatched",
            }),
          }),
        );
      }
    },
  );
  it("admits a fresh metadata trigger after a stale gate drains without refunding or replaying its charge", async () => {
    const h = fixture(3);
    const gate = h.gate.getMockImplementation();
    if (!gate) throw new Error("Missing gate transport");
    let release = () => {};
    let started = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.gate.mockImplementationOnce(async (...args) => {
      const result = await gate(...args);
      started();
      await held;
      return result;
    });
    h.choose("no");
    const runtime = h.create();
    const first = runtime.run(h.parent.id);
    await dispatched;
    h.options.evidence = subtaskAccessFixture([
      ["One", "Two"],
    ]).adapter.metadata();
    release();
    await first;
    expect(runtime.checkpoint().journal).toMatchObject({
      dispatches: 1,
      usage: { jev: { calls: 1 } },
      records: [
        { state: "permanent", gate: { outcome: "failed", dispatch: 1 } },
      ],
    });
    expect(h.propose).not.toHaveBeenCalled();
    h.choose("yes");
    // An explicit current-context wake is new work, not a retry of old proof.
    await runtime.run(h.parent.id);
    expect(h.gate).toHaveBeenCalledTimes(2);
    expect(h.propose).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().groups).toHaveLength(1);
    expect(runtime.checkpoint().journal).toMatchObject({
      dispatches: 3,
      usage: { jev: { calls: 2 }, extraction: { calls: 1 } },
    });
    await runtime.run(h.parent.id);
    expect(h.gate).toHaveBeenCalledTimes(2);
    expect(h.propose).toHaveBeenCalledTimes(1);
  });
  it("binds explicit access only after committed generic admission, never as completion", async () => {
    const h = associatedFixture();
    const runtime = h.create();
    const parent = structuredClone(h.parent);
    h.commit.mockImplementation((candidate) => {
      if (candidate.state.groups.length)
        expect(runtime.snapshot().groups).toEqual([]);
      h.saved.push(structuredClone(candidate));
      return true;
    });
    await runtime.run(h.parent.id);
    expect(runtime.snapshot().groups[0]?.children).toHaveLength(2);
    expect(
      runtime
        .accessSnapshot(h.evidence.adapter.accessEvidence())
        .groups[0]?.children.map((child) => child.status),
    ).toEqual(["no-observation", "no-observation"]);
    h.evidence.run(
      "read-one",
      "read",
      { path: "extracted/r0-0.txt" },
      "private body",
    );
    expect(
      runtime
        .accessSnapshot(h.evidence.adapter.accessEvidence())
        .groups[0]?.children.map((child) => child.status),
    ).toEqual(["observed", "no-observation"]);
    expect(
      runtime.snapshot().groups[0].children.map((child) => child.status),
    ).toEqual(["pending", "pending"]);
    expect(h.parent).toEqual(parent);
  });
  it("does not publish candidate access bindings after admission storage refusal", async () => {
    const h = associatedFixture();
    h.commit.mockImplementation((candidate) => {
      if (candidate.state.groups.length) return false;
      h.saved.push(structuredClone(candidate));
      return true;
    });
    const runtime = h.create();
    await runtime.run(h.parent.id);
    expect(
      runtime.accessSnapshot(h.evidence.adapter.accessEvidence()).groups,
    ).toEqual([]);
    expect(runtime.checkpoint().journal.dispatches).toBe(2);
  });
  it("reload retains generic children and charges but never reconstructs runtime access links", async () => {
    const h = associatedFixture();
    const runtime = h.create();
    await runtime.run(h.parent.id);
    const restored = h.create(runtime.checkpoint());
    await restored.run(h.parent.id);
    expect(restored.snapshot().groups[0]?.children).toHaveLength(2);
    expect(
      restored
        .accessSnapshot(h.evidence.adapter.accessEvidence())
        .groups[0]?.children.map((child) => child.status),
    ).toEqual(["unavailable", "unavailable"]);
    expect(h.gate).toHaveBeenCalledTimes(1);
    expect(h.propose).toHaveBeenCalledTimes(1);
  });
  it("accepted retain-only refinement without associations removes prior access links", async () => {
    const h = associatedFixture();
    const runtime = h.create();
    await runtime.run(h.parent.id);
    const before = runtime.snapshot();
    h.options.omissions = ["New independent context"];
    h.propose.mockImplementation(async (request, signal, onDispatch) => {
      if (!onDispatch(102) || signal.aborted) throw new Error("vetoed");
      return {
        provider: "fixture",
        model: "selected",
        requestHash: request.requestHash,
        usage: { inputTokens: 1, outputTokens: 1 },
        text: h.evidence.propose([undefined, undefined], "task:1", true).raw,
      };
    });
    await runtime.run(h.parent.id);
    expect(runtime.snapshot().groups[0].listRevision).toBe(
      before.groups[0].listRevision,
    );
    expect(runtime.snapshot().groups[0].children).toEqual(
      before.groups[0].children,
    );
    expect(
      runtime
        .accessSnapshot(h.evidence.adapter.accessEvidence())
        .groups[0]?.children.map((child) => child.status),
    ).toEqual(["unavailable", "unavailable"]);
    expect(h.propose).toHaveBeenCalledTimes(2);
    expect(runtime.checkpoint().journal.dispatches).toBe(4);
  });
  it("reset clears access links without changing durable facts or opening a new paid job", async () => {
    const h = associatedFixture();
    const runtime = h.create();
    await runtime.run(h.parent.id);
    const before = runtime.checkpoint();
    runtime.resetAccess();
    expect(
      runtime
        .accessSnapshot(h.evidence.adapter.accessEvidence())
        .groups[0]?.children.map((child) => child.status),
    ).toEqual(["unavailable", "unavailable"]);
    expect(runtime.checkpoint()).toEqual(before);
    await runtime.run(h.parent.id);
    expect(h.propose).toHaveBeenCalledTimes(1);
  });

  it("retains gate reservation when logical gateway cancellation precedes fetch drain", async () => {
    const h = fixture();
    let release = () => {};
    const physical = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.gate.mockImplementation(
      async (_batch, _signal, onDispatch, onPhysicalFlight) => {
        if (!onDispatch(100)) return;
        onPhysicalFlight?.(physical);
        return undefined;
      },
    );
    const runtime = h.create();
    let settled = false;
    const run = runtime.run(h.parent.id).then(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() =>
        expect(runtime.checkpoint().journal.dispatches).toBe(1),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(h.propose).not.toHaveBeenCalled();
      release();
      await run;
      expect(settled).toBe(true);
      expect(runtime.checkpoint().journal.dispatches).toBe(1);
    } finally {
      release();
      await run;
    }
  });

  it("retains reservation after logical proposal failure until its separate physical drain", async () => {
    const h = fixture();
    let release = () => {};
    const physical = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.propose.mockImplementation(
      async (_request, _signal, onDispatch, onPhysicalFlight) => {
        if (!onDispatch(101)) throw new Error("vetoed");
        onPhysicalFlight?.(physical);
        throw new Error("Subtask proposal unavailable");
      },
    );
    const runtime = h.create();
    let settled = false;
    const logical = runtime.run(h.parent.id).then(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() => expect(h.propose).toHaveBeenCalledTimes(1));
      expect(settled).toBe(false);
      runtime.invalidate();
      const second = runtime.run(h.parent.id);
      expect(h.gate).toHaveBeenCalledTimes(1);
      release();
      await Promise.all([logical, second]);
      expect(settled).toBe(true);
      expect(runtime.checkpoint().journal.dispatches).toBe(2);
      expect(runtime.snapshot().groups).toEqual([]);
    } finally {
      release();
      await logical;
    }
  });

  it("preserves the restored durable component before any run or provider opportunity", async () => {
    const h = fixture();
    const runtime = h.create();
    await runtime.run(h.parent.id);
    const saved = runtime.checkpoint();
    const calls = h.commit.mock.calls.length;
    const restored = h.create(saved);
    expect(restored.checkpoint()).toEqual(saved);
    expect(h.commit).toHaveBeenCalledTimes(calls);
  });
  it.each([1, 2])(
    "rechecks model authority after dispatch %i save without refunding the reservation",
    async (ordinal) => {
      const h = fixture();
      h.commit.mockImplementation((candidate) => {
        h.saved.push(structuredClone(candidate));
        if (
          candidate.journal.dispatches === ordinal &&
          candidate.journal.records.some(
            (record) => record.state === "dispatched",
          )
        )
          h.options.selectedModel = "fixture/changed-after-save";
        return true;
      });
      const runtime = h.create();
      await runtime.run(h.parent.id);
      expect(h.network.mock.calls.map(([kind]) => kind)).toEqual(
        ordinal === 1 ? [] : ["gate"],
      );
      expect(runtime.checkpoint().journal.dispatches).toBe(ordinal);
      expect(runtime.snapshot().groups).toEqual([]);
      expect(h.onPublish).not.toHaveBeenCalled();
    },
  );
  it("does not publish an accepted list if admission save invalidates its flight", async () => {
    const h = fixture();
    const runtime = h.create();
    h.commit.mockImplementation((candidate) => {
      h.saved.push(structuredClone(candidate));
      if (candidate.state.groups.length) runtime.invalidate();
      return true;
    });
    await runtime.run(h.parent.id);
    // The old-flight write succeeded externally; it is not rolled back or
    // adopted as current semantic authority after synchronous invalidation.
    expect(h.saved.at(-1)?.state.groups).toHaveLength(1);
    expect(runtime.checkpoint().journal.dispatches).toBe(2);
    expect(runtime.snapshot().groups).toEqual([]);
    expect(h.onPublish).not.toHaveBeenCalled();
  });

  it("constructs without effects, then admits conversation-only children without changing parents", async () => {
    const h = fixture();
    const before = structuredClone(h.parent);
    const runtime = h.create();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.gate).not.toHaveBeenCalled();
    await runtime.run(h.parent.id);
    expect(h.gate).toHaveBeenCalledTimes(1);
    expect(h.propose).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().groups[0]?.children).toHaveLength(2);
    expect(runtime.checkpoint()).toEqual(h.saved.at(-1));
    expect(runtime.checkpoint().journal.dispatches).toBe(2);
    expect(h.parent).toEqual(before);
  });
  it.each(["no", "uncertain"] as const)(
    "persists %s without a selected-model call",
    async (choice) => {
      const h = fixture();
      h.choose(choice);
      const runtime = h.create();
      await runtime.run(h.parent.id);
      await runtime.run(h.parent.id);
      expect(h.gate).toHaveBeenCalledTimes(1);
      expect(h.propose).not.toHaveBeenCalled();
      expect(runtime.snapshot().groups).toEqual([]);
      expect(runtime.checkpoint().journal.records[0]?.state).toBe("complete");
    },
  );
  it("suppresses its own accepted list through repeated wakes and reload without rebilling", async () => {
    const h = fixture();
    const runtime = h.create();
    await runtime.run(h.parent.id);
    const checkpoint = runtime.checkpoint();
    await runtime.run(h.parent.id);
    const restored = h.create(checkpoint);
    await restored.run(h.parent.id);
    expect(h.gate).toHaveBeenCalledTimes(1);
    expect(h.propose).toHaveBeenCalledTimes(1);
    expect(restored.checkpoint()).toEqual(checkpoint);
  });
  it("persists proposal noop without inventing a group or replaying after reload", async () => {
    const h = fixture();
    h.propose.mockImplementation(async (request, signal, onDispatch) => {
      if (!onDispatch(101) || signal.aborted) throw new Error("vetoed");
      return {
        provider: "fixture",
        model: "selected",
        requestHash: request.requestHash,
        usage: { inputTokens: 1, outputTokens: 1 },
        text: '{"proposals":[]}',
      };
    });
    const runtime = h.create();
    await runtime.run(h.parent.id);
    expect(runtime.snapshot().groups).toEqual([]);
    expect(runtime.checkpoint().journal.records[0]?.proposal?.outcome).toBe(
      "noop",
    );
    await h.create(runtime.checkpoint()).run(h.parent.id);
    expect(h.gate).toHaveBeenCalledTimes(1);
    expect(h.propose).toHaveBeenCalledTimes(1);
  });
  it("gates changed omissions even when latest conversation and admitted group are unchanged", async () => {
    const h = fixture();
    const runtime = h.create();
    await runtime.run(h.parent.id);
    h.options.omissions = ["Older context unavailable"];
    h.choose("no");
    await runtime.run(h.parent.id);
    expect(h.gate).toHaveBeenCalledTimes(2);
    expect(h.propose).toHaveBeenCalledTimes(1);
  });
  it("does not charge or publish when dispatch storage refuses", async () => {
    const h = fixture();
    h.commit.mockReturnValue(false);
    const runtime = h.create();
    await runtime.run(h.parent.id);
    expect(runtime.checkpoint()).toEqual(empty());
    expect(h.network).not.toHaveBeenCalled();
    expect(h.propose).not.toHaveBeenCalled();
    expect(h.onPublish).not.toHaveBeenCalled();
  });
  it("retains the charged gate after decision-save failure and does not repeat after reload", async () => {
    const h = fixture();
    h.commit.mockImplementation((candidate) => {
      if (candidate.journal.records.some((r) => r.gate?.outcome === "decided"))
        return false;
      h.saved.push(structuredClone(candidate));
      return true;
    });
    const runtime = h.create();
    await runtime.run(h.parent.id);
    expect(runtime.checkpoint().journal.dispatches).toBe(1);
    expect(h.propose).not.toHaveBeenCalled();
    const saved = h.saved.at(-1);
    if (!saved) throw new Error("Missing durable gate attempt");
    const restored = h.create(saved);
    await runtime.run(h.parent.id);
    await restored.run(h.parent.id);
    for (const checkpoint of [
      runtime.checkpoint(),
      saved,
      restored.checkpoint(),
    ]) {
      expect(checkpoint.journal.records[0].gate?.usage).toEqual({
        inputTokens: 3,
        outputTokens: 5,
      });
      expect(checkpoint.journal.usage.jev).toEqual({
        calls: 1,
        inputTokens: 3,
        outputTokens: 5,
      });
    }
    expect(h.gate).toHaveBeenCalledTimes(1);
  });
  it.each(["accepted", "noop"] as const)(
    "does not expose a rejected proposal %s or lose its paid usage",
    async (outcome) => {
      const h = fixture();
      if (outcome === "noop") {
        const original = h.propose.getMockImplementation();
        if (!original) throw new Error("Missing proposal fixture");
        h.propose.mockImplementation(async (...args) => ({
          ...(await original(...args)),
          text: '{"proposals":[]}',
        }));
      }
      h.commit.mockImplementation((candidate) => {
        if (
          candidate.journal.records.some(
            (record) => record.proposal?.outcome === outcome,
          )
        )
          return false;
        h.saved.push(structuredClone(candidate));
        return true;
      });
      const runtime = h.create();
      await runtime.run(h.parent.id);
      expect(runtime.snapshot().groups).toEqual([]);
      expect(runtime.checkpoint().journal.dispatches).toBe(2);
      const saved = h.saved.at(-1);
      if (!saved) throw new Error("Missing durable proposal attempt");
      const restored = h.create(saved);
      await runtime.run(h.parent.id);
      await restored.run(h.parent.id);
      for (const checkpoint of [
        runtime.checkpoint(),
        saved,
        restored.checkpoint(),
      ]) {
        expect(checkpoint.state.groups).toEqual([]);
        expect(checkpoint.journal.records[0].proposal?.usage).toEqual({
          inputTokens: 7,
          outputTokens: 9,
        });
        expect(checkpoint.journal.usage).toEqual({
          jev: { calls: 1, inputTokens: 3, outputTokens: 5 },
          extraction: { calls: 1, inputTokens: 7, outputTokens: 9 },
        });
      }
      expect(h.gate).toHaveBeenCalledTimes(1);
      expect(h.propose).toHaveBeenCalledTimes(1);
    },
  );
  it("retains one physical flight through invalidation and cancellation-ignore drain", async () => {
    const h = fixture();
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = h.gate.getMockImplementation();
    if (!original) throw new Error("Missing gate fixture");
    h.gate.mockImplementation(async (...args) => {
      const result = await original(...args);
      await pending;
      return result;
    });
    const runtime = h.create();
    const first = runtime.run(h.parent.id);
    await Promise.resolve();
    runtime.invalidate();
    const second = runtime.run(h.parent.id);
    expect(h.gate).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(h.propose).not.toHaveBeenCalled();
    expect(runtime.snapshot().groups).toEqual([]);
    expect(runtime.checkpoint().journal.dispatches).toBe(1);
  });
  it("reserves before reentrant commit callbacks and fences disabled current authority", async () => {
    const h = fixture();
    const runtime = h.create();
    const reentrant: Promise<void>[] = [];
    h.commit.mockImplementation((candidate) => {
      reentrant.push(runtime.run(h.parent.id));
      h.saved.push(structuredClone(candidate));
      return true;
    });
    await runtime.run(h.parent.id);
    await Promise.all(reentrant);
    expect(h.gate).toHaveBeenCalledTimes(1);
    expect(h.propose).toHaveBeenCalledTimes(1);
    h.disable();
    await runtime.run(h.parent.id);
    expect(h.gate).toHaveBeenCalledTimes(1);
  });
});
