import { afterEach, expect, it, vi } from "vitest";
import { MODEL, type ValidatedResult } from "../src/analysis/gateway";
import type { SubtaskReportBatch } from "../src/analysis/subtask-report";
import type { Observation, SourceRef } from "../src/core/hybrid-state";
import { subtaskJournalIsValid } from "../src/core/subtask-journal";
import {
  SubtaskRuntime,
  type SubtaskRuntimeCheckpoint,
} from "../src/core/subtask-runtime";
import { reportChoices, subtaskReportFixture } from "./fixtures/subtask-report";
import {
  subtaskAdmission,
  subtaskHash,
  subtaskSource,
} from "./fixtures/subtasks";

type Outcome =
  | { kind: "result"; result: ValidatedResult }
  | { kind: "retryable" | "deferred"; retryAfterMs: number }
  | { kind: "unavailable" | "failed" };
type Reserve = { storeBytes: number; journalBytes: number };
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function reply(
  batch: SubtaskReportBatch,
  choice = "completed-set",
): ValidatedResult {
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
          probabilities: Object.fromEntries(
            reportChoices.map((item) => [item, item === choice ? 1 : 0]),
          ),
        },
      ]),
    ),
  };
}
function fixture() {
  const h = subtaskReportFixture();
  let time = 1000;
  let latest = h.options.report;
  let selectedModel: string | undefined;
  const saved: SubtaskRuntimeCheckpoint[] = [];
  const network = vi.fn();
  const onPublish = vi.fn();
  const commit = vi.fn((candidate: SubtaskRuntimeCheckpoint) => {
    saved.push(structuredClone(candidate));
    return true;
  });
  const canCommit = vi.fn(
    (_candidate: SubtaskRuntimeCheckpoint, _reserve: Reserve) => true,
  );
  const report = vi.fn(
    async (
      batch: SubtaskReportBatch,
      signal: AbortSignal,
      onDispatch: (at: number) => boolean,
      _onPhysicalFlight: (drain: Promise<void>) => void,
    ): Promise<Outcome> => {
      if (!onDispatch(time) || signal.aborted) return { kind: "unavailable" };
      network("report");
      expect(saved.at(-1)?.journal.reports.at(-1)).toMatchObject({
        state: "dispatched",
        attempts: expect.arrayContaining([
          expect.objectContaining({
            outcome: "dispatched",
            childIds: [...batch.childIds],
          }),
        ]),
      });
      return { kind: "result", result: reply(batch) };
    },
  );
  const gate = vi.fn(
    async (
      _batch: unknown,
      signal: AbortSignal,
      onDispatch: (at: number) => boolean,
      _onPhysicalFlight: (drain: Promise<void>) => void,
    ): Promise<ValidatedResult | undefined> => {
      if (onDispatch(time) && !signal.aborted) network("gate");
      return undefined;
    },
  );
  const propose = vi.fn(async () => undefined);
  const initial = (): SubtaskRuntimeCheckpoint => ({
    state: h.store.checkpoint(),
    journal: {
      version: 1,
      records: [],
      reports: [],
      dispatches: 0,
      usage: {
        jev: { calls: 0, inputTokens: 0, outputTokens: 0 },
        extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
      },
    },
  });
  const create = (
    checkpoint = initial(),
    capability: "both" | "no-report" | "no-capacity" = "both",
  ) =>
    new SubtaskRuntime({
      initial: checkpoint,
      current: () => ({
        sourceId: "report-runtime",
        enabled: true,
        parents: [h.options.parent],
        latest,
        earlier: [...h.observations.values()].filter(
          (item) => item.id !== latest.id,
        ),
        omissions: [],
        selectedModel,
        resolve: h.options.resolve,
      }),
      gate,
      propose,
      commit,
      onPublish,
      ...(capability === "no-report" ? {} : { report }),
      ...(capability === "no-capacity" ? {} : { canCommit }),
      now: () => time,
    });
  const source = (observation = h.options.report): SourceRef => ({
    ...subtaskSource(observation.id, observation.text),
    role: observation.role,
  });
  const advance = (milliseconds: number) => {
    time += milliseconds;
  };
  const observe = (id: string, text: string) => {
    const observation: Observation = {
      id,
      text,
      hash: subtaskHash(text),
      role: "assistant",
    };
    h.observations.set(id, observation);
    latest = observation;
    return source(observation);
  };
  return {
    ...h,
    saved,
    network,
    onPublish,
    commit,
    canCommit,
    report,
    gate,
    propose,
    create,
    source,
    advance,
    observe,
    select: () => {
      selectedModel = "fixture/selected";
    },
  };
}
const statuses = (runtime: SubtaskRuntime) =>
  runtime.snapshot().groups[0]?.children.map((child) => child.status);
afterEach(() => {
  vi.useRealTimers();
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

it.each(["no-report", "no-capacity"] as const)(
  "absent %s capability grants no report dispatch",
  async (capability) => {
    const h = fixture();
    const runtime = h.create(undefined, capability);
    await runtime.runReport(h.options.parent.id, h.source());
    expect(h.report).not.toHaveBeenCalled();
    expect(runtime.checkpoint().journal.dispatches).toBe(0);
  },
);
it("durably completes 22 children in exactly 20+2 explicit opportunities without proposal credentials", async () => {
  const h = fixture();
  const parent = structuredClone(h.options.parent);
  const runtime = h.create();
  await runtime.runReport(parent.id, h.source());
  expect(h.report).toHaveBeenCalledTimes(1);
  expect(h.report.mock.calls[0][0].childIds).toHaveLength(20);
  expect(statuses(runtime)).toEqual([
    ...Array(20).fill("reported-completed"),
    "pending",
    "pending",
  ]);
  expect(runtime.checkpoint().journal.reports[0]).toMatchObject({
    state: "ready",
    childIds: h.options.group.children.map((child) => child.id),
    attempts: [{ outcome: "decided", assessments: expect.any(Array) }],
  });
  expect(
    runtime.checkpoint().journal.reports[0].attempts[0].assessments,
  ).toHaveLength(20);
  await runtime.runReport(parent.id);
  expect(h.report.mock.calls.map(([batch]) => batch.childIds.length)).toEqual([
    20, 2,
  ]);
  expect(statuses(runtime)).toEqual(Array(22).fill("reported-completed"));
  expect(runtime.checkpoint().journal.reports[0].state).toBe("complete");
  expect(runtime.checkpoint().journal.usage).toEqual({
    jev: { calls: 2, inputTokens: 6, outputTokens: 10 },
    extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
  });
  expect(h.options.parent).toEqual(parent);
  expect(h.gate).not.toHaveBeenCalled();
  expect(h.propose).not.toHaveBeenCalled();
  expect(h.onPublish).toHaveBeenCalledTimes(2);
  for (const candidate of h.saved)
    expect(subtaskJournalIsValid(candidate.journal)).toBe(true);
  await runtime.runReport(parent.id, h.source());
  await runtime.runReport(parent.id);
  expect(h.report).toHaveBeenCalledTimes(2);
});
it("reload resumes saved source, not newer unrelated conversation, and sends only remaining two", async () => {
  const h = fixture();
  const first = h.create();
  await first.runReport(h.options.parent.id, h.source());
  h.observe("unrelated", "A completely unrelated later observation.");
  const resumed = h.create(structuredClone(first.checkpoint()));
  await resumed.runReport(h.options.parent.id);
  expect(h.report.mock.calls.map(([batch]) => [...batch.childIds])).toEqual([
    h.options.group.children.slice(0, 20).map((child) => child.id),
    h.options.group.children.slice(20).map((child) => child.id),
  ]);
  const request = JSON.stringify(h.report.mock.calls[1][0].request);
  expect(request).toContain(h.options.report.text);
  expect(request).not.toContain("A completely unrelated later observation.");
  expect(resumed.checkpoint().journal.dispatches).toBe(2);
  expect(statuses(resumed)).toEqual(Array(22).fill("reported-completed"));
});
it.each(["unchanged", "uncertain"])(
  "persists %s assessments as coverage, suppressing repeat billing after reload",
  async (choice) => {
    const h = fixture();
    h.report.mockImplementation(async (batch, _signal, dispatch) => {
      if (!dispatch(1000)) return { kind: "unavailable" };
      return { kind: "result", result: reply(batch, choice) };
    });
    const first = h.create();
    await first.runReport(h.options.parent.id, h.source());
    const resumed = h.create(structuredClone(first.checkpoint()));
    await resumed.runReport(h.options.parent.id);
    await resumed.runReport(h.options.parent.id, h.source());
    expect(h.report.mock.calls.map(([batch]) => batch.childIds.length)).toEqual(
      [20, 2],
    );
    expect(statuses(resumed)).toEqual(Array(22).fill("pending"));
    expect(resumed.checkpoint().journal.reports[0].state).toBe("complete");
    expect(
      resumed
        .checkpoint()
        .journal.reports[0].attempts.flatMap(
          (attempt) => attempt.assessments ?? [],
        ),
    ).toHaveLength(22);
  },
);
it("retries only certified failed second chunk after reload, deadline and explicit wake, retaining every charge", async () => {
  vi.useFakeTimers();
  const h = fixture();
  const runtime = h.create();
  await runtime.runReport(h.options.parent.id, h.source());
  h.report.mockImplementationOnce(async (_batch, _signal, dispatch) => {
    expect(dispatch(1000)).toBe(true);
    return { kind: "retryable", retryAfterMs: 10000 };
  });
  await runtime.runReport(h.options.parent.id);
  expect(runtime.checkpoint().journal.reports[0]).toMatchObject({
    state: "parked",
    parkedUntil: 11000,
    attempts: [{ outcome: "decided" }, { outcome: "retryable" }],
  });
  const resumed = h.create(structuredClone(runtime.checkpoint()));
  await resumed.runReport(h.options.parent.id);
  expect(h.report).toHaveBeenCalledTimes(2);
  h.advance(10000);
  await vi.advanceTimersByTimeAsync(10000);
  expect(h.report).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
  await resumed.runReport(h.options.parent.id);
  expect(h.report.mock.calls.map(([batch]) => batch.childIds.length)).toEqual([
    20, 2, 2,
  ]);
  expect(h.report.mock.calls[2][0].requestHash).toBe(
    h.report.mock.calls[1][0].requestHash,
  );
  expect(resumed.checkpoint().journal.dispatches).toBe(3);
  expect(
    resumed
      .checkpoint()
      .journal.reports[0].attempts.map((attempt) => attempt.dispatch),
  ).toEqual([1, 2, 3]);
  expect(statuses(resumed)).toEqual(Array(22).fill("reported-completed"));
});
it("captures rounded retry deadline before physical drain rather than extending it at drain completion", async () => {
  const h = fixture();
  let release!: () => void;
  const drain = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.report.mockImplementationOnce(
    async (_batch, _signal, dispatch, physical) => {
      expect(dispatch(1000)).toBe(true);
      physical(drain);
      return { kind: "retryable", retryAfterMs: 10000.1 };
    },
  );
  const runtime = h.create();
  const pending = runtime.runReport(h.options.parent.id, h.source());
  await Promise.resolve();
  await Promise.resolve();
  h.advance(100000);
  release();
  await pending;
  expect(runtime.checkpoint().journal.reports[0].parkedUntil).toBe(11001);
  expect(h.report).toHaveBeenCalledTimes(1);
});
it.each([NaN, Infinity, Number.MAX_SAFE_INTEGER])(
  "rejects unsafe retry arithmetic %s without refund or early retry",
  async (retryAfterMs) => {
    const h = fixture();
    h.report.mockImplementationOnce(async (_batch, _signal, dispatch) => {
      expect(dispatch(1000)).toBe(true);
      return { kind: "retryable", retryAfterMs };
    });
    const runtime = h.create();
    await runtime.runReport(h.options.parent.id, h.source());
    h.advance(1000000);
    await runtime.runReport(h.options.parent.id);
    expect(runtime.checkpoint().journal.dispatches).toBe(1);
    expect(runtime.checkpoint().journal.reports[0].parkedUntil).toBeUndefined();
    expect(h.report).toHaveBeenCalledTimes(1);
  },
);
it.each([
  "failed",
  "throw",
  "malformed",
  "charged-unavailable",
  "charged-deferred",
])("never retries unknown/mislabeled charged outcome %s", async (mode) => {
  const h = fixture();
  h.report.mockImplementationOnce(
    async (batch, _signal, dispatch): Promise<Outcome> => {
      expect(dispatch(1000)).toBe(true);
      if (mode === "throw") throw new Error("network timeout");
      if (mode === "malformed")
        return { kind: "result", result: { ...reply(batch), answers: {} } };
      if (mode === "charged-unavailable") return { kind: "unavailable" };
      if (mode === "charged-deferred")
        return { kind: "deferred", retryAfterMs: 10000 };
      return { kind: "failed" };
    },
  );
  const runtime = h.create();
  await runtime.runReport(h.options.parent.id, h.source());
  h.advance(1000000);
  await runtime.runReport(h.options.parent.id);
  const resumed = h.create(structuredClone(runtime.checkpoint()));
  await resumed.runReport(h.options.parent.id, h.source());
  expect(h.report).toHaveBeenCalledTimes(1);
  expect(resumed.checkpoint().journal.dispatches).toBe(1);
  expect(statuses(resumed)).toEqual(Array(22).fill("pending"));
});
it.each(["unavailable", "throw"])(
  "predispatch %s spends zero",
  async (mode) => {
    const h = fixture();
    h.report.mockImplementationOnce(async () => {
      if (mode === "throw") throw new Error("not dispatched");
      return { kind: "unavailable" };
    });
    const runtime = h.create();
    await runtime.runReport(h.options.parent.id, h.source());
    expect(runtime.checkpoint().journal.dispatches).toBe(0);
    expect(h.network).not.toHaveBeenCalled();
    expect(h.onPublish).not.toHaveBeenCalled();
  },
);
it("persists predispatch backoff without a ticket, then resumes on explicit eligible wake", async () => {
  const h = fixture();
  h.report.mockImplementationOnce(async () => ({
    kind: "deferred",
    retryAfterMs: 10000,
  }));
  const runtime = h.create();
  await runtime.runReport(h.options.parent.id, h.source());
  expect(runtime.checkpoint().journal.dispatches).toBe(0);
  expect(runtime.checkpoint().journal.reports[0]).toMatchObject({
    state: "parked",
    parkedUntil: 11000,
    attempts: [],
  });
  const resumed = h.create(structuredClone(runtime.checkpoint()));
  await resumed.runReport(h.options.parent.id);
  expect(h.report).toHaveBeenCalledTimes(1);
  h.advance(10000);
  await resumed.runReport(h.options.parent.id);
  expect(h.report).toHaveBeenCalledTimes(2);
  expect(resumed.checkpoint().journal.dispatches).toBe(1);
});
it("adaptively fits one child using real candidates and conservative final growth, not fake assessments", async () => {
  const h = fixture();
  h.canCommit.mockImplementation((candidate, reserve) => {
    expect(subtaskJournalIsValid(candidate.journal)).toBe(true);
    const attempt = candidate.journal.reports.at(-1)?.attempts.at(-1);
    if (h.network.mock.calls.length === 0) {
      expect(attempt?.outcome).toBe("dispatched");
      expect(attempt?.assessments).toBeUndefined();
    }
    for (const value of Object.values(reserve))
      expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
    return attempt?.childIds.length === 1;
  });
  const runtime = h.create();
  await runtime.runReport(h.options.parent.id, h.source());
  expect(h.report.mock.calls.map(([batch]) => batch.childIds.length)).toEqual([
    1,
  ]);
  const [dispatchCandidate, reserve] =
    h.canCommit.mock.calls
      .filter(
        ([candidate]) =>
          candidate.journal.reports.at(-1)?.attempts.at(-1)?.outcome ===
          "dispatched",
      )
      .at(-1) ?? [];
  if (!dispatchCandidate || !reserve)
    throw new Error("Missing dispatch capacity projection");
  expect(reserve.storeBytes).toBeGreaterThanOrEqual(
    bytes(runtime.checkpoint().state) - bytes(dispatchCandidate.state),
  );
  expect(reserve?.journalBytes).toBeGreaterThanOrEqual(
    bytes(runtime.checkpoint().journal) - bytes(dispatchCandidate.journal),
  );
  expect(
    statuses(runtime)?.filter((status) => status === "reported-completed"),
  ).toHaveLength(1);
});
it.each(["capacity", "invalidation"])(
  "does not dispatch after %s veto in pure preflight",
  async (mode) => {
    const h = fixture();
    const runtime = h.create();
    h.canCommit.mockImplementation(() => {
      if (mode === "invalidation") runtime.invalidate();
      return mode === "invalidation";
    });
    await runtime.runReport(h.options.parent.id, h.source());
    expect(h.report).not.toHaveBeenCalled();
    expect(h.network).not.toHaveBeenCalled();
    expect(runtime.checkpoint().journal.dispatches).toBe(0);
  },
);
it("refused dispatch save admits no ticket, network, charge or publication", async () => {
  const h = fixture();
  h.commit.mockReturnValue(false);
  const runtime = h.create();
  await runtime.runReport(h.options.parent.id, h.source());
  expect(h.network).not.toHaveBeenCalled();
  expect(runtime.checkpoint().journal.dispatches).toBe(0);
  expect(h.onPublish).not.toHaveBeenCalled();
});
it("post-dispatch-save invalidation retains the saved charge without network or hidden retry", async () => {
  const h = fixture();
  const runtime = h.create();
  h.commit.mockImplementation((candidate) => {
    h.saved.push(structuredClone(candidate));
    runtime.invalidate();
    return true;
  });
  await runtime.runReport(h.options.parent.id, h.source());
  expect(h.network).not.toHaveBeenCalled();
  expect(runtime.checkpoint().journal.dispatches).toBe(1);
  await runtime.runReport(h.options.parent.id, h.source());
  expect(h.report).toHaveBeenCalledTimes(1);
  expect(h.onPublish).not.toHaveBeenCalled();
});
it("result-save refusal retains dispatched proof and blocks replay live and after crash restore", async () => {
  const h = fixture();
  h.commit.mockImplementation((candidate) => {
    if (
      candidate.journal.reports.some((job) =>
        job.attempts.some((attempt) => attempt.outcome === "decided"),
      )
    )
      return false;
    h.saved.push(structuredClone(candidate));
    return true;
  });
  const runtime = h.create();
  await runtime.runReport(h.options.parent.id, h.source());
  expect(runtime.checkpoint().journal.dispatches).toBe(1);
  expect(h.onPublish).not.toHaveBeenCalled();
  await runtime.runReport(h.options.parent.id);
  const resumed = h.create(structuredClone(runtime.checkpoint()));
  await resumed.runReport(h.options.parent.id, h.source());
  expect(h.report).toHaveBeenCalledTimes(1);
  expect(resumed.checkpoint().journal.reports[0].state).toBe("permanent");
  expect(statuses(resumed)).toEqual(Array(22).fill("pending"));
});
it.each(["report-first", "gate-first"])(
  "shares physical drain across job kinds and atomically supersedes old owner: %s",
  async (mode) => {
    const h = fixture();
    h.select();
    let release!: () => void;
    const drain = new Promise<void>((resolve) => {
      release = resolve;
    });
    const report = h.report.getMockImplementation();
    const gate = h.gate.getMockImplementation();
    if (!report || !gate) throw new Error("Missing transport fixture");
    if (mode === "report-first")
      h.report.mockImplementationOnce(async (...args) => {
        args[3](drain);
        return report(...args);
      });
    else
      h.gate.mockImplementationOnce(async (...args) => {
        args[3](drain);
        return gate(...args);
      });
    const runtime = h.create();
    const first =
      mode === "report-first"
        ? runtime.runReport(h.options.parent.id, h.source())
        : runtime.run(h.options.parent.id);
    await Promise.resolve();
    expect(h.network).toHaveBeenCalledTimes(1);
    runtime.invalidate();
    const blocked =
      mode === "report-first"
        ? runtime.run(h.options.parent.id)
        : runtime.runReport(h.options.parent.id, h.source());
    expect(h.network).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, blocked]);
    if (mode === "report-first") await runtime.run(h.options.parent.id);
    else await runtime.runReport(h.options.parent.id, h.source());
    expect(h.network).toHaveBeenCalledTimes(2);
    expect(runtime.checkpoint().journal.dispatches).toBe(2);
    const old =
      mode === "report-first"
        ? runtime.checkpoint().journal.reports[0]
        : runtime.checkpoint().journal.records[0];
    expect(old.state).toBe("superseded");
    for (const candidate of h.saved)
      expect(subtaskJournalIsValid(candidate.journal)).toBe(true);
  },
);
it("coalesces newer report owner and never restarts superseded A after A→B→A reload", async () => {
  const h = fixture();
  const runtime = h.create();
  const a = h.source();
  await runtime.runReport(h.options.parent.id, a);
  const b = h.observe(
    "report-b",
    "All agreed work remains completed after the follow-up.",
  );
  await runtime.runReport(h.options.parent.id, b);
  expect(runtime.checkpoint().journal.reports.map((job) => job.state)).toEqual([
    "superseded",
    "ready",
  ]);
  const resumed = h.create(structuredClone(runtime.checkpoint()));
  await resumed.runReport(h.options.parent.id, a);
  expect(h.report).toHaveBeenCalledTimes(2);
  expect(resumed.checkpoint().journal.dispatches).toBe(2);
});
it.each(["parent", "source"])(
  "fences stale in-flight %s authority while retaining charge",
  async (mode) => {
    const h = fixture();
    h.report.mockImplementationOnce(async (batch, _signal, dispatch) => {
      expect(dispatch(1000)).toBe(true);
      if (mode === "parent") h.options.parent.revision++;
      else
        h.observe(h.options.report.id, "That observation has been corrected.");
      return { kind: "result", result: reply(batch) };
    });
    const runtime = h.create();
    await runtime.runReport(h.options.parent.id, h.source());
    expect(runtime.checkpoint().journal.dispatches).toBe(1);
    expect(h.onPublish).not.toHaveBeenCalled();
    expect(
      runtime
        .snapshot()
        .groups.flatMap((group) => group.children)
        .some((child) => child.status === "reported-completed"),
    ).toBe(false);
  },
);
it("retires saved report owner when a genuine refinement changes the list revision", async () => {
  const h = fixture();
  const runtime = h.create();
  expect(
    h.store.admit({
      ...subtaskAdmission(),
      parent: h.options.parent,
      source: h.options.parent.source,
      expectedListRevision: 1,
      complete: false,
      children: h.options.group.children.map((child) => ({
        kind: "retain" as const,
        id: child.id,
      })),
    }),
  ).toEqual({ accepted: true });
  expect(h.store.snapshot().groups[0].listRevision).toBe(2);
  // The runtime captured list1; the separately validated list2 is loaded below.
  await runtime.runReport(h.options.parent.id, h.source());
  const checkpoint = {
    ...structuredClone(runtime.checkpoint()),
    state: h.store.checkpoint(),
  };
  const resumed = h.create(checkpoint);
  await resumed.runReport(h.options.parent.id);
  expect(resumed.checkpoint().journal.reports[0].state).toBe("superseded");
  expect(resumed.checkpoint().journal.dispatches).toBe(1);
  expect(h.report).toHaveBeenCalledTimes(1);
});
it("rejects canonically altered report evidence before reload recovery", async () => {
  const h = fixture();
  const runtime = h.create();
  await runtime.runReport(h.options.parent.id, h.source());
  h.observe(h.options.report.id, "Correction: that report was not accurate.");
  const resumed = h.create(structuredClone(runtime.checkpoint()));
  await resumed.runReport(h.options.parent.id);
  expect(h.report).toHaveBeenCalledTimes(1);
  expect(resumed.checkpoint().journal.reports[0].state).toBe("superseded");
  expect(resumed.checkpoint().journal.dispatches).toBe(1);
});
