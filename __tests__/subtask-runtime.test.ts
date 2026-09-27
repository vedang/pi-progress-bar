import { describe, expect, it, vi } from "vitest";
import { MODEL, type ValidatedResult } from "../src/analysis/gateway";
import type { SubtaskGateBatch } from "../src/analysis/subtask-gate";
import type { buildSubtaskProposal } from "../src/analysis/subtask-proposal";
import type { SubtaskJournalCheckpoint } from "../src/core/subtask-journal";
import { SubtaskRuntime } from "../src/core/subtask-runtime";
import { SubtaskStore } from "../src/core/subtasks";
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
    usage: {
      jev: { calls: 0, inputTokens: 0, outputTokens: 0 },
      extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
    },
  },
});
function fixture() {
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
    ) => {
      if (!onDispatch(101) || signal.aborted) throw new Error("vetoed");
      network("proposal");
      expect(saved.at(-1)?.journal.dispatches).toBe(2);
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

describe("durable generic subtask runtime", () => {
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
    await runtime.run(h.parent.id);
    await h.create(runtime.checkpoint()).run(h.parent.id);
    expect(h.gate).toHaveBeenCalledTimes(1);
  });
  it("does not expose a rejected admission or refund its two charged calls", async () => {
    const h = fixture();
    h.commit.mockImplementation((candidate) => {
      if (candidate.state.groups.length) return false;
      h.saved.push(structuredClone(candidate));
      return true;
    });
    const runtime = h.create();
    await runtime.run(h.parent.id);
    expect(runtime.snapshot().groups).toEqual([]);
    expect(runtime.checkpoint().journal.dispatches).toBe(2);
    await runtime.run(h.parent.id);
    await h.create(runtime.checkpoint()).run(h.parent.id);
    expect(h.gate).toHaveBeenCalledTimes(1);
    expect(h.propose).toHaveBeenCalledTimes(1);
  });
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
