import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EvaluationRequest } from "../src/analysis/gateway";
import { processObservation } from "../src/core/hybrid";
import * as checkpointCodec from "../src/core/hybrid-checkpoint";
import {
  type encodeSubtaskCheckpoint,
  subtaskCheckpointStorageStatus,
} from "../src/core/hybrid-checkpoint";
import type { SourceRef } from "../src/core/hybrid-state";
import { SubtaskStore } from "../src/core/subtasks";
import { backend, noPatch, observation } from "./fixtures/hybrid";
import { branchEntry, monitorHarness } from "./fixtures/hybrid-monitor";
import { subtaskAdmission } from "./fixtures/subtasks";

type Envelope = ReturnType<typeof encodeSubtaskCheckpoint>;
const labels = Array.from(
  { length: 22 },
  (_, i) => `Implement component ${i + 1}`,
);
const goal = `Complete these agreed obligations: ${labels.join("; ")}.`;
const reportText =
  "I completed all agreed obligations. Synthesis remains pending.";
const running: ReturnType<typeof monitorHarness>[] = [];
const releases: (() => void)[] = [];
const isReport = (request: EvaluationRequest) =>
  Object.keys(request.questions).some((key) =>
    key.startsWith("subtask:subtask-child:"),
  );
const sourceId = (request: EvaluationRequest) =>
  (request.state as { report: { source: SourceRef } }).report.source.entryId;
function answer(request: EvaluationRequest, choice = "completed-set") {
  return Response.json({
    model: request.model,
    usage: { input_tokens: 7, output_tokens: 3 },
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([key, question]) => [
        key,
        {
          type: "choice",
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(question.criteria).map((item) => [
              item,
              item === choice ? 1 : 0,
            ]),
          ),
        },
      ]),
    ),
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline");
});
afterEach(() => {
  for (const h of running.splice(0)) h.monitor.stop();
  for (const release of releases.splice(0)) release();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function fixture(details = false, throwingModel = false) {
  const h = monitorHarness([branchEntry("goal", goal)], {
    richDetailsEnabled: details,
    extractionText: (input) =>
      JSON.stringify({
        add: input.tasks.length
          ? []
          : [
              {
                label: "Deliver agreed plan",
                kind: "response",
                basis: "explicit",
                quote: goal,
                ...(details
                  ? { details: { title: { quote: labels[21] } } }
                  : {}),
              },
            ],
        revise: [],
        archive: [],
        restore: [],
        unresolved: false,
      }),
    monitorOptions: throwingModel
      ? {
          selectedModel: () => {
            throw new Error("No proposal credentials");
          },
        }
      : {},
  });
  running.push(h);
  const calls: EvaluationRequest[] = [];
  const all: EvaluationRequest[] = [];
  let choice = "completed-set";
  let transport:
    | ((request: EvaluationRequest, init?: RequestInit) => Promise<Response>)
    | undefined;
  const original = h.fetch.getMockImplementation();
  if (!original) throw new Error("Missing offline transport");
  const checkpoint = () => {
    const raw = h.monitor.checkpoint();
    expect(subtaskCheckpointStorageStatus(raw)).toBe("supported");
    return raw as Envelope;
  };
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body)) as EvaluationRequest;
    all.push(request);
    if (!isReport(request)) return original(url, init);
    calls.push(request);
    // Production transport must have saved/charged its exact attempt first.
    const journal = checkpoint().monitor?.subtasks?.journal;
    expect(
      journal?.reports.some(
        (job) =>
          job.source.entryId === sourceId(request) &&
          job.state === "dispatched" &&
          job.attempts.at(-1)?.outcome === "dispatched",
      ),
    ).toBe(true);
    return transport ? transport(request, init) : answer(request, choice);
  });
  h.start();
  await h.settle("goal");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.state.tasks).toHaveLength(1);
  const parent = h.monitor.state.tasks[0];
  const store = new SubtaskStore();
  expect(
    store.admit({
      ...subtaskAdmission(labels),
      parent,
      source: parent.source,
      complete: true,
      knownTotal: 22,
      children: labels.map((label) => ({
        kind: "add",
        label,
        source: parent.source,
      })),
    }),
  ).toEqual({ accepted: true });
  const saved = checkpoint();
  if (!saved.monitor) throw new Error("Missing monitor metadata");
  saved.monitor.subtasks = {
    state: store.checkpoint(),
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
  };
  expect(subtaskCheckpointStorageStatus(saved)).toBe("supported");
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  await vi.advanceTimersByTimeAsync(100);
  expect(checkpoint().monitor?.subtasks?.state.groups[0].children).toHaveLength(
    22,
  );
  expect(calls).toEqual([]); // Admission source equality is NOT a report token.
  all.splice(0);
  return {
    ...h,
    calls,
    all,
    checkpoint,
    setChoice: (value: string) => {
      choice = value;
    },
    setTransport: (value: typeof transport) => {
      transport = value;
    },
    statuses: () =>
      h.monitor
        .subtaskSnapshot()
        .groups[0]?.children.map((child) => child.status),
  };
}
it.each([false, true])(
  "runs a finite20+2 wave after semantics/health without proposal credentials (throwing resolver:%s)",
  async (throwing) => {
    const h = await fixture(false, throwing);
    h.append("report", reportText);
    await h.settle("report");
    await vi.advanceTimersByTimeAsync(100);
    expect(
      h.calls.map((request) => Object.keys(request.questions).length),
    ).toEqual([20, 2]);
    const first = h.all.findIndex(isReport);
    const health = h.all.reduce(
      (last, request, index) => ("clarity" in request.questions ? index : last),
      -1,
    );
    expect(health).toBeGreaterThanOrEqual(0);
    expect(first).toBeGreaterThan(health);
    expect(h.statuses()).toEqual(Array(22).fill("reported-completed"));
    expect(h.monitor.state.tasks[0].status).toBe("not-started");
    const journal = h.checkpoint().monitor?.subtasks?.journal;
    expect(journal).toMatchObject({
      dispatches: 2,
      usage: {
        jev: { calls: 2, inputTokens: 14, outputTokens: 6 },
        extraction: { calls: 0 },
      },
      reports: [{ state: "complete" }],
    });
    expect(JSON.stringify(journal)).not.toContain(reportText);
  },
);
it.each(["completed-set", "unchanged", "uncertain"])(
  "never rebills covered %s chunks on getters/wakes/actual Monitor reload",
  async (choice) => {
    const h = await fixture();
    h.setChoice(choice);
    h.append("report", reportText);
    await h.settle("report");
    expect(h.calls).toHaveLength(2);
    const saved = h.checkpoint();
    for (let i = 0; i < 3; i++) {
      h.monitor.subtaskSnapshot();
      h.monitor.boardSnapshot();
      h.observe();
    }
    await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.calls).toHaveLength(2);
    expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(2);
    expect(h.statuses()).toEqual(
      Array(22).fill(
        choice === "completed-set" ? "reported-completed" : "pending",
      ),
    );
  },
);
it("restores saved20 then retries only final2 after deadline AND named wake", async () => {
  const h = await fixture();
  h.setTransport(async (request) =>
    h.calls.length === 2
      ? new Response(null, { status: 503 })
      : answer(request),
  );
  h.append("report", reportText);
  await h.settle("report");
  expect(
    h.calls.map((request) => Object.keys(request.questions).length),
  ).toEqual([20, 2]);
  expect(
    h.statuses()?.filter((status) => status === "reported-completed"),
  ).toHaveLength(20);
  const saved = h.checkpoint();
  h.setTransport(undefined);
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  await vi.advanceTimersByTimeAsync(11000);
  expect(h.calls).toHaveLength(2);
  h.observe();
  await vi.advanceTimersByTimeAsync(100);
  expect(
    h.calls.map((request) => Object.keys(request.questions).length),
  ).toEqual([20, 2, 2]);
  expect(h.statuses()).toEqual(Array(22).fill("reported-completed"));
  expect(
    h
      .checkpoint()
      .monitor?.subtasks?.journal.reports[0].attempts.map(
        (attempt) => attempt.dispatch,
      ),
  ).toEqual([1, 2, 3]);
});
it.each(["unrelated", "corrective"])(
  "retains parked A ahead of newer %s B and reconstructs latest B across reload",
  async (kind) => {
    const h = await fixture();
    h.setTransport(async (request) =>
      h.calls.length === 2
        ? new Response(null, { status: 503 })
        : answer(request),
    );
    h.append("report-a", reportText);
    await h.settle("report-a");
    expect(h.calls).toHaveLength(2);
    h.append(
      "report-b",
      kind === "corrective"
        ? "Correction: all previously reported completions are retracted."
        : "Unrelated discussion; no work update.",
    );
    await h.settle("report-b");
    expect(h.calls).toHaveLength(2);
    expect(h.checkpoint().monitor?.subtasks?.journal.reports[0].state).toBe(
      "parked",
    );
    h.setTransport(async (request) =>
      answer(
        request,
        sourceId(request) === "report-b"
          ? kind === "corrective"
            ? "retracted-set"
            : "unchanged"
          : "completed-set",
      ),
    );
    await h.monitor.restore(
      "/nonexistent-hybrid-test",
      h.checkpoint(),
      false,
      h.reader,
    );
    await vi.advanceTimersByTimeAsync(11000);
    expect(h.calls).toHaveLength(2);
    h.observe();
    await vi.advanceTimersByTimeAsync(200);
    expect(
      h.calls.map((request) => [
        sourceId(request),
        Object.keys(request.questions).length,
      ]),
    ).toEqual([
      ["report-a", 20],
      ["report-a", 2],
      ["report-a", 2],
      ["report-b", 20],
      ["report-b", 2],
    ]);
    expect(h.statuses()).toEqual(
      Array(22).fill(kind === "corrective" ? "pending" : "reported-completed"),
    );
    expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(5);
  },
);
it("coalesces pending candidates to latest C without claiming B was assessed", async () => {
  const h = await fixture();
  h.setTransport(async (request) =>
    h.calls.length === 2
      ? new Response(null, { status: 503 })
      : answer(request),
  );
  h.append("report-a", reportText);
  await h.settle("report-a");
  expect(h.calls).toHaveLength(2);
  h.append(
    "report-b",
    "An intermediate report will be superseded by later input.",
  );
  await h.settle("report-b");
  h.append(
    "report-c",
    "The latest report confirms all agreed obligations complete.",
  );
  await h.settle("report-c");
  expect(h.calls).toHaveLength(2);
  h.setTransport(undefined);
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    h.checkpoint(),
    false,
    h.reader,
  );
  await vi.advanceTimersByTimeAsync(11000);
  h.observe();
  await vi.advanceTimersByTimeAsync(200);
  expect(h.calls.map(sourceId)).toEqual([
    "report-a",
    "report-a",
    "report-a",
    "report-c",
    "report-c",
  ]);
  expect(
    h
      .checkpoint()
      .monitor?.subtasks?.journal.reports.some(
        (job) => job.source.entryId === "report-b",
      ),
  ).toBe(false);
});
it("unknown failed A never retries but genuinely newer B may supersede it", async () => {
  const h = await fixture();
  h.setTransport(async () => {
    throw new Error("Ambiguous network failure");
  });
  h.append("report-a", reportText);
  await h.settle("report-a");
  expect(h.calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(11000);
  h.observe();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.calls).toHaveLength(1);
  h.setTransport(undefined);
  h.append("report-b", "I confirm completion of all agreed obligations.");
  await h.settle("report-b");
  expect(h.calls.map(sourceId)).toEqual(["report-a", "report-b", "report-b"]);
  expect(h.checkpoint().monitor?.subtasks?.journal.reports[0].state).toBe(
    "superseded",
  );
});
it("binds the real full-envelope capacity predicate before report transport", async () => {
  const h = await fixture();
  const capacity = vi
    .spyOn(checkpointCodec, "canCommitSubtaskCheckpoint")
    .mockReturnValue(false);
  try {
    h.append("report", reportText);
    await h.settle("report");
    expect(capacity).toHaveBeenCalled();
    expect(
      capacity.mock.calls.some(
        ([, metadata, reserve]) =>
          metadata?.subtasks &&
          (reserve?.storeBytes ?? 0) > 0 &&
          (reserve?.journalBytes ?? 0) > 0,
      ),
    ).toBe(true);
    expect(h.calls).toHaveLength(0);
    expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(0);
  } finally {
    capacity.mockRestore();
  }
});
it("refused report dispatch persistence causes no fetch, charge or child publication", async () => {
  const h = await fixture();
  h.save.mockImplementation((raw: unknown) => {
    const candidate = raw as Envelope;
    if (
      candidate.monitor?.subtasks?.journal.reports.some(
        (job) => job.attempts.at(-1)?.outcome === "dispatched",
      )
    )
      throw new Error("Report dispatch save refused");
  });
  h.append("report", reportText);
  await h.settle("report");
  expect(h.calls).toHaveLength(0);
  expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(0);
  expect(h.statuses()).toEqual(Array(22).fill("pending"));
});
it("failed final save keeps charged proof and does not publish or retry after Monitor reload", async () => {
  const h = await fixture();
  h.save.mockImplementation((raw: unknown) => {
    if (
      (raw as Envelope).monitor?.subtasks?.journal.reports.some((job) =>
        job.attempts.some((attempt) => attempt.outcome === "decided"),
      )
    )
      throw new Error("Report result save refused");
  });
  h.append("report", reportText);
  await h.settle("report");
  expect(h.calls).toHaveLength(1);
  expect(h.statuses()).toEqual(Array(22).fill("pending"));
  expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(1);
  h.save.mockReset();
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    h.checkpoint(),
    false,
    h.reader,
  );
  await vi.advanceTimersByTimeAsync(11000);
  h.observe();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.calls).toHaveLength(1);
  expect(h.checkpoint().monitor?.subtasks?.journal.reports[0].state).toBe(
    "permanent",
  );
});
it("holds optional ownership until canceled report fetch physically drains while mandatory semantics advance", async () => {
  const h = await fixture();
  let release = () => {};
  releases.push(() => release());
  h.setTransport(
    (request) =>
      new Promise<Response>((resolve) => {
        release = () => resolve(answer(request));
      }),
  );
  h.append("report-a", reportText);
  await h.settle("report-a");
  expect(h.calls).toHaveLength(1);
  h.append("report-b", "All agreed work is now completed.");
  await h.settle("report-b");
  expect(h.monitor.state.cursor?.id).toBe("report-b");
  expect(h.calls).toHaveLength(1);
  h.setTransport(undefined);
  release();
  await vi.advanceTimersByTimeAsync(200);
  expect(h.calls.map(sourceId)).toEqual(["report-a", "report-b", "report-b"]);
  expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(3);
});
it("alternates ready detail between report chunks after finite higher-priority work", async () => {
  const h = await fixture(true);
  const saved = h.checkpoint();
  const details = saved.monitor?.taskDetails as
    | { candidates: { key: string }[]; receipts: unknown[] }[]
    | undefined;
  expect(details?.length).toBeGreaterThan(0);
  if (!details) throw new Error("Missing real detail offers");
  for (const record of details) {
    record.receipts = [];
    record.candidates[0].key = "description";
  }
  // Seed a real settled semantic cursor, without an unresolved dispatched report.
  h.reader().push(branchEntry("report", reportText, "assistant"));
  saved.state = await processObservation(
    saved.state,
    observation("report", reportText, "assistant"),
    backend(noPatch(), { gate: "unchanged" }),
  );
  expect(subtaskCheckpointStorageStatus(saved)).toBe("supported");
  h.all.splice(0);
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  await vi.advanceTimersByTimeAsync(300);
  const optional = h.all.filter(
    (request) =>
      isReport(request) ||
      Object.keys(request.questions).some((key) => key.startsWith("detail:")),
  );
  const indices = optional.flatMap((request, index) =>
    isReport(request) ? [index] : [],
  );
  const detail = optional.findIndex((request) =>
    Object.keys(request.questions).some((key) => key.startsWith("detail:")),
  );
  expect(indices).toHaveLength(2);
  expect(detail).toBeGreaterThan(indices[0]);
  expect(detail).toBeLessThan(indices[1]);
});
it("accepts later canonical intercom reports through the same report pipeline", async () => {
  const h = await fixture();
  h.replace([
    ...h.reader(),
    {
      type: "custom_message",
      customType: "intercom_message",
      id: "report",
      content: reportText,
    },
  ]);
  await h.settle("report");
  expect(h.monitor.state.cursor?.role).toBe("intercom");
  expect(
    h.calls.map((request) => Object.keys(request.questions).length),
  ).toEqual([20, 2]);
  expect(h.statuses()).toEqual(Array(22).fill("reported-completed"));
});
it("accepts later canonical user reports without a role shortcut", async () => {
  const h = await fixture();
  h.append("report", reportText, "user");
  await h.settle("report");
  expect(
    h.calls.map((request) => Object.keys(request.questions).length),
  ).toEqual([20, 2]);
  expect(h.statuses()).toEqual(Array(22).fill("reported-completed"));
});
