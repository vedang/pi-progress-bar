import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EvaluationRequest } from "../src/analysis/gateway";
import { subtaskReportOmissionIdentity } from "../src/analysis/subtask-report";
import { processObservation } from "../src/core/hybrid";
import * as checkpointCodec from "../src/core/hybrid-checkpoint";
import {
  type encodeSubtaskCheckpoint,
  subtaskCheckpointStorageStatus,
} from "../src/core/hybrid-checkpoint";
import type { SourceRef } from "../src/core/hybrid-state";
import type { MonitorOptions } from "../src/core/monitor";
import type { SubtaskRuntimeCurrent } from "../src/core/subtask-runtime";
import { SubtaskStore } from "../src/core/subtasks";
import { isCurrentSubtaskEvidence } from "../src/sources/coverage";
import { CanonicalPass } from "../src/sources/messages";
import { backend, noPatch, observation } from "./fixtures/hybrid";
import { branchEntry, monitorHarness } from "./fixtures/hybrid-monitor";
import {
  metadataCommand,
  metadataXml,
} from "./fixtures/subtask-metadata-monitor";
import {
  subtaskAdmission,
  subtaskHash,
  subtaskSource,
} from "./fixtures/subtasks";

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
async function fixture(
  details = false,
  throwingModel = false,
  parentCount = 1,
  monitorOptions: Partial<MonitorOptions> = {},
  admittedParentCount = parentCount,
) {
  const h = monitorHarness([branchEntry("goal", goal)], {
    richDetailsEnabled: details,
    extractionText: (input) =>
      JSON.stringify({
        add: input.tasks.length
          ? []
          : Array.from({ length: parentCount }, (_, index) => ({
              label:
                parentCount === 1
                  ? "Deliver agreed plan"
                  : `Deliver agreed plan ${index + 1}`,
              kind: "response",
              basis: "explicit",
              quote: goal,
              ...(details ? { details: { title: { quote: labels[21] } } } : {}),
            })),
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
      : monitorOptions,
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
  expect(h.monitor.state.tasks).toHaveLength(parentCount);
  const store = new SubtaskStore();
  for (const parent of h.monitor.state.tasks.slice(0, admittedParentCount))
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
  if (admittedParentCount > 0)
    expect(
      checkpoint().monitor?.subtasks?.state.groups[0].children,
    ).toHaveLength(22);
  else expect(checkpoint().monitor?.subtasks?.state.groups ?? []).toEqual([]);
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
type Diagnostics = {
  dispatches: number;
  exhausted: boolean;
  parkedOwners?: number;
  permanentOwners?: number;
  adapter: {
    pendingCount: number;
    pendingBytes: number;
    retainedBytes: number;
    omissions: number;
  };
};
function diagnostics(h: Awaited<ReturnType<typeof fixture>>): Diagnostics {
  const project = Reflect.get(h.monitor, "subtaskDiagnosticsSnapshot");
  expect(project).toBeTypeOf("function");
  return Reflect.apply(project, h.monitor, []) as Diagnostics;
}
it("projects detached empty diagnostics without reopening host or selected-model readers", async () => {
  const selectedModel = vi.fn(() => "fixture/selected");
  const h = await fixture(false, false, 1, { selectedModel });
  const before = [
    h.reader.mock.calls.length,
    selectedModel.mock.calls.length,
    h.fetch.mock.calls.length,
    h.extract.mock.calls.length,
  ];
  const parents = structuredClone(h.monitor.state.tasks);
  const first = diagnostics(h);
  expect(first).toMatchObject({
    dispatches: 0,
    exhausted: false,
    parkedOwners: 0,
    permanentOwners: 0,
    adapter: { pendingCount: 0, pendingBytes: 0, omissions: 0 },
  });
  expect(first.adapter.retainedBytes).toBeGreaterThan(0);
  expect(first.adapter.retainedBytes).toBeLessThanOrEqual(65536);
  Reflect.set(first.adapter, "omissions", 999);
  for (let i = 0; i < 4; i++) expect(diagnostics(h).adapter.omissions).toBe(0);
  expect([
    h.reader.mock.calls.length,
    selectedModel.mock.calls.length,
    h.fetch.mock.calls.length,
    h.extract.mock.calls.length,
  ]).toEqual(before);
  expect(h.monitor.state.tasks).toEqual(parents);
});
it.each([1023, 1024])(
  "projects exact durable dispatch-wallet exhaustion at %i",
  async (dispatches) => {
    const h = await fixture();
    const saved = h.checkpoint();
    const journal = saved.monitor?.subtasks?.journal;
    if (!journal) throw new Error("Missing journal");
    journal.dispatches = dispatches;
    journal.usage.jev.calls = dispatches;
    expect(subtaskCheckpointStorageStatus(saved)).toBe("supported");
    await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
    expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(
      dispatches,
    );
    expect(diagnostics(h)).toMatchObject({
      dispatches,
      exhausted: dispatches === 1024,
    });
    expect(h.calls).toHaveLength(0);
  },
);
it("captures decomposition permanent ownership without lazy credential reads", async () => {
  let available = false;
  const selectedModel = vi.fn(() =>
    available ? "fixture/selected" : undefined,
  );
  const proposeSubtasks = vi.fn<NonNullable<MonitorOptions["proposeSubtasks"]>>(
    async (_request, _signal, onDispatch) => {
      expect(onDispatch?.(Date.now())).toBe(true);
      return {
        text: "not a proposal",
        requestHash: _request.requestHash,
        provider: "fixture",
        model: "selected",
        usage: { inputTokens: 3, outputTokens: 2 },
      };
    },
  );
  const h = await fixture(false, false, 1, { selectedModel, proposeSubtasks });
  h.setChoice("unchanged");
  const original = h.fetch.getMockImplementation();
  if (!original) throw new Error("Missing offline transport");
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body)) as EvaluationRequest;
    return request.questions["subtask:0"]
      ? answer(request, "yes")
      : original(url, init);
  });
  available = true;
  h.append(
    "refinement",
    "Add deployment and recovery planning to the agreed obligations.",
    "user",
  );
  await h.settle("refinement");
  await vi.advanceTimersByTimeAsync(100);
  expect(proposeSubtasks).toHaveBeenCalledTimes(1);
  const journal = h.checkpoint().monitor?.subtasks?.journal;
  expect(journal?.records).toContainEqual(
    expect.objectContaining({ state: "permanent" }),
  );
  const before = [
    h.reader.mock.calls.length,
    selectedModel.mock.calls.length,
    h.fetch.mock.calls.length,
  ];
  expect(diagnostics(h)).toMatchObject({
    dispatches: journal?.dispatches,
    exhausted: false,
    parkedOwners: 0,
    permanentOwners: 1,
  });
  expect([
    h.reader.mock.calls.length,
    selectedModel.mock.calls.length,
    h.fetch.mock.calls.length,
  ]).toEqual(before);
});
it("projects detached no-file reconciliation gaps and reported counts without parent or correction authority", async () => {
  const h = await fixture();
  const parents = structuredClone(h.monitor.state.tasks);
  const correction = h.monitor.correctionSnapshot();
  const calls = [
    h.fetch.mock.calls.length,
    h.extract.mock.calls.length,
    h.reader.mock.calls.length,
  ];
  const snapshot = h.monitor.advisorySettlementSnapshot();
  expect(snapshot).toMatchObject({
    reason: "ready",
    tasks: [{ id: "task:1" }],
    subtasks: [
      {
        parentTaskId: "task:1",
        parentRevision: 1,
        groupId: "subtask-group:1",
        listRevision: 1,
        complete: true,
        knownTotal: 22,
        reportedCompleted: 0,
        reportedBlocked: 0,
        pending: 22,
        gaps: labels.slice(0, 3),
        omittedChildren: 19,
      },
    ],
  });
  expect(snapshot).not.toHaveProperty("coverage");
  const rows = Reflect.get(snapshot, "subtasks") as {
    gaps: string[];
    observedAccess?: number;
  }[];
  expect(rows[0]).not.toHaveProperty("observedAccess");
  rows[0].gaps[0] = "MUTATED";
  expect(JSON.stringify(h.monitor.advisorySettlementSnapshot())).not.toContain(
    "MUTATED",
  );
  expect(h.monitor.correctionSnapshot()).toEqual(correction);
  expect(h.monitor.state.tasks).toEqual(parents);
  expect([
    h.fetch.mock.calls.length,
    h.extract.mock.calls.length,
    h.reader.mock.calls.length,
  ]).toEqual(calls);
  h.append("report", reportText);
  await h.settle("report");
  expect(
    h.calls.map((request) => Object.keys(request.questions).length),
  ).toEqual([20, 2]);
  expect(h.monitor.advisorySettlementSnapshot()).toMatchObject({
    tasks: [{ id: "task:1", status: "not-started" }],
    subtasks: [
      {
        reportedCompleted: 22,
        reportedBlocked: 0,
        pending: 0,
        gaps: [],
        omittedChildren: 0,
      },
    ],
  });
  expect(h.monitor.state.tasks).toEqual(parents);
});
it.each(["group", "parent", "revision", "list", "child", "unavailable"])(
  "does not infer reconciliation access from mismatched %s evidence",
  async (kind) => {
    const h = await fixture();
    const group = h.monitor.subtaskSnapshot().groups[0];
    const access = vi
      .spyOn(h.monitor, "subtaskAccessSnapshot")
      .mockReturnValue({
        omissions: 0,
        groups: [
          {
            groupId: kind === "group" ? "subtask-group:999" : group.id,
            parentTaskId: kind === "parent" ? "task:999" : group.parentTaskId,
            parentRevision: group.parentRevision + Number(kind === "revision"),
            listRevision: group.listRevision + Number(kind === "list"),
            children: [
              {
                childId:
                  kind === "child" ? "subtask-child:999" : group.children[0].id,
                status: kind === "unavailable" ? "unavailable" : "observed",
                activeCallHashes: [],
              },
            ],
          },
        ],
      });
    try {
      const snapshot = h.monitor.advisorySettlementSnapshot();
      expect(snapshot).toMatchObject({ subtasks: [{ pending: 22 }] });
      const rows = Reflect.get(snapshot, "subtasks") as object[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toHaveProperty("observedAccess");
      expect(h.calls).toHaveLength(0);
    } finally {
      access.mockRestore();
    }
  },
);
it("restores a mid-wave checkpoint without one parent's report suppressing another parent's same-source work", async () => {
  const h = await fixture(false, false, 2);
  const [first, second] = h.monitor.state.tasks;
  let midway: Envelope | undefined;
  h.save.mockImplementation((raw: unknown) => {
    const candidate = raw as Envelope;
    const reports = candidate.monitor?.subtasks?.journal.reports;
    if (
      reports?.length === 1 &&
      reports[0].parentTaskId === first.id &&
      reports[0].state === "ready" &&
      reports[0].attempts.some((attempt) => attempt.outcome === "decided")
    )
      midway = structuredClone(candidate);
  });
  h.append("report", reportText);
  await h.settle("report");
  await vi.advanceTimersByTimeAsync(200);
  expect(midway).toBeDefined();
  if (!midway) throw new Error("Missing actual mid-wave durable checkpoint");
  expect(subtaskCheckpointStorageStatus(midway)).toBe("supported");
  const secondGroup = midway.monitor?.subtasks?.state.groups.find(
    (group) => group.parentTaskId === second.id,
  );
  expect(
    secondGroup?.children.every((child) => child.status === "pending"),
  ).toBe(true);
  const savedJob = midway.monitor?.subtasks?.journal.reports[0];
  if (!savedJob || !secondGroup)
    throw new Error("Missing saved group authority");
  const alreadyDecided = new Set(
    savedJob.attempts
      .filter((attempt) => attempt.outcome === "decided")
      .flatMap((attempt) => attempt.childIds),
  );
  const expectedKeys = [
    ...savedJob.childIds.filter((id) => !alreadyDecided.has(id)),
    ...secondGroup.children.map((child) => child.id),
  ].map((id) => `subtask:${id}`);
  // This is crash recovery, not navigation in a Monitor that already knows the
  // later terminal receipts. A live rewind must not replay that charged work.
  h.monitor.stop();
  const restored = await fixture(false, false, 2);
  expect(restored.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(0);
  await restored.monitor.restore(
    "/nonexistent-hybrid-test",
    midway,
    false,
    h.reader,
  );
  await vi.advanceTimersByTimeAsync(200);
  const covered = restored.calls.flatMap((request) =>
    Object.keys(request.questions),
  );
  expect(covered).toEqual(expectedKeys);
  expect(new Set(covered).size).toBe(expectedKeys.length);
  expect(
    restored.calls.every(
      (request) =>
        sourceId(request) === "report" &&
        Object.keys(request.questions).length <= 20,
    ),
  ).toBe(true);
  const journal = restored.checkpoint().monitor?.subtasks?.journal;
  expect(
    journal?.reports
      .filter((job) => job.state === "complete")
      .map((job) => job.parentTaskId)
      .sort(),
  ).toEqual([first.id, second.id].sort());
  expect(journal?.dispatches).toBe(
    (midway.monitor?.subtasks?.journal.dispatches ?? 0) + restored.calls.length,
  );
});
it("projects restored groups without rereading the host from passive getters", async () => {
  const h = await fixture();
  let reads = 0;
  let disposed = false;
  h.monitor.observe(() => {
    reads++;
    if (disposed) throw new Error("Disposed host reader");
    return h.reader();
  });
  await vi.advanceTimersByTimeAsync(100);
  reads = 0;
  for (let i = 0; i < 4; i++)
    expect(h.monitor.subtaskSnapshot().groups[0]?.children).toHaveLength(22);
  expect(reads).toBe(0);
  disposed = true;
  expect(() => h.monitor.subtaskSnapshot()).not.toThrow();
  expect(reads).toBe(0);
  expect(h.calls).toHaveLength(0);
});
it("bounds blank-history reads when restored report groups really exist", async () => {
  const h = await fixture();
  let reads = 0,
    boundaryStart = 0,
    maximumBoundaryReads = 0;
  const reader = h.reader.getMockImplementation();
  if (!reader) throw new Error("Missing reader");
  h.reader.mockImplementation(() => {
    boundaryStart = reads;
    return reader();
  });
  const invisible = Array.from({ length: 10000 }, (_, index) => ({
    type: "message",
    id: `invisible-${index}`,
    message: {
      role: "assistant",
      get content() {
        reads++;
        maximumBoundaryReads = Math.max(
          maximumBoundaryReads,
          reads - boundaryStart,
        );
        return index % 2
          ? [{ type: "thinking", thinking: "private" }]
          : [{ type: "text", text: "   " }];
      },
    },
  }));
  h.replace([
    ...h.reader(),
    ...invisible,
    branchEntry("report", reportText, "assistant"),
  ]);
  expect(reads).toBeLessThanOrEqual(256);
  for (let step = 0; step < 1000; step++) {
    await vi.advanceTimersByTimeAsync(1);
    expect(maximumBoundaryReads).toBeLessThanOrEqual(256);
    if (h.monitor.state.cursor?.id === "report") break;
  }
  await h.settle("report");
  await vi.advanceTimersByTimeAsync(100);
  expect(maximumBoundaryReads).toBeLessThanOrEqual(256);
  expect(
    h.calls.map((request) => Object.keys(request.questions).length),
  ).toEqual([20, 2]);
  expect(h.statuses()).toEqual(Array(22).fill("reported-completed"));
});
it.each([
  { revised: false, parked: false },
  { revised: true, parked: false },
  { revised: true, parked: true },
])(
  "allows fresh decomposition of an existing group after named input (parent revised: $revised, parked: $parked)",
  async ({ revised, parked }) => {
    let available = false;
    const amendment = revised
      ? "Revise the plan to include deployment and recovery."
      : "Break the agreed plan into deployment and recovery steps.";
    const proposeSubtasks = vi.fn<
      NonNullable<MonitorOptions["proposeSubtasks"]>
    >(async (request, signal, onDispatch, onPhysicalFlight) => {
      onPhysicalFlight?.(Promise.resolve());
      if (onDispatch?.(Date.now()) === false || signal.aborted)
        throw new Error("Vetoed");
      const contextIndex = request.input.context.findIndex(
        (item) => item.text === amendment,
      );
      const active = request.input.parents[0]?.group?.children ?? [];
      expect(active).toHaveLength(revised ? 0 : 22);
      return {
        provider: "fixture",
        model: "selected",
        requestHash: request.requestHash,
        usage: { inputTokens: 1, outputTokens: 1 },
        text: JSON.stringify({
          proposals: [
            {
              parentIndex: 0,
              complete: false,
              removals: [],
              children: [
                ...active.map((_, childIndex) => ({
                  kind: "retain",
                  childIndex,
                })),
                ...["Plan deployment", "Plan recovery"].map((label) => ({
                  kind: "add",
                  label,
                  evidence: [{ contextIndex, start: 0, end: amendment.length }],
                })),
              ],
            },
          ],
        }),
      };
    });
    const h = await fixture(false, false, 1, {
      selectedModel: () => (available ? "fixture/selected" : undefined),
      proposeSubtasks,
    });
    if (parked) {
      h.setTransport(async () => new Response(null, { status: 503 }));
      h.append("prior-report", reportText);
      await h.settle("prior-report");
      expect(h.checkpoint().monitor?.subtasks?.journal.reports[0].state).toBe(
        "parked",
      );
      expect(h.calls).toHaveLength(1);
      h.setTransport(undefined);
    }
    available = true;
    h.setChoice("unchanged");
    const parent = structuredClone(h.monitor.state.tasks[0]);
    const original = h.fetch.getMockImplementation();
    if (!original) throw new Error("Missing transport");
    h.fetch.mockImplementation(async (url, init) => {
      const request = JSON.parse(String(init?.body)) as EvaluationRequest;
      if (request.questions.gate || request.questions["subtask:0"]) {
        const response = await original(url, init);
        const data = (await response.json()) as {
          answers: Record<string, unknown>;
        };
        const key = request.questions.gate ? "gate" : "subtask:0";
        const choice =
          key === "gate" ? (revised ? "changed" : "unchanged") : "yes";
        data.answers[key] = {
          type: "choice",
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(request.questions[key].criteria).map((item) => [
              item,
              item === choice ? 1 : 0,
            ]),
          ),
        };
        return Response.json(data);
      }
      return original(url, init);
    });
    h.extract.mockImplementation(async (_input, _signal, onDispatch) => {
      onDispatch?.(Date.now());
      return {
        text: JSON.stringify({
          add: [],
          revise: [
            {
              id: parent.id,
              label: "Deliver deployment and recovery plan",
              requirementsChanged: true,
              quote: amendment,
            },
          ],
          archive: [],
          restore: [],
          unresolved: false,
        }),
        provider: "offline",
        model: "fixture",
        usage: { inputTokens: 3, outputTokens: 2 },
      };
    });
    h.append("amendment", amendment, "user");
    await h.settle("amendment");
    if (parked) {
      await vi.advanceTimersByTimeAsync(11000);
      h.monitor.modelSelected();
    }
    await vi.advanceTimersByTimeAsync(200);
    expect(h.monitor.state.tasks[0].revision).toBe(
      parent.revision + Number(revised),
    );
    expect(proposeSubtasks).toHaveBeenCalledTimes(1);
    expect(h.monitor.subtaskSnapshot().groups).toHaveLength(1);
    expect(h.monitor.subtaskSnapshot().groups[0]).toMatchObject({
      parentTaskId: parent.id,
      parentRevision: parent.revision + Number(revised),
    });
    expect(
      h.monitor
        .subtaskSnapshot()
        .groups[0].children.map((child) => child.label),
    ).toEqual([...(revised ? [] : labels), "Plan deployment", "Plan recovery"]);
    if (parked) {
      const retired = h
        .checkpoint()
        .monitor?.subtasks?.journal.reports.find(
          (job) => job.source.entryId === "prior-report",
        );
      expect(retired?.state).toBe("superseded");
      expect(retired?.attempts).toHaveLength(1);
      expect(h.calls).toHaveLength(1); // Invalid old report must never retry.
    }
  },
);
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
    expect(diagnostics(h)).toMatchObject({
      dispatches: 2,
      exhausted: false,
      parkedOwners: 1,
      permanentOwners: 0,
    });
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
    // Observe the REAL predicate; do not override the capacity decision.
    const capacity = vi.spyOn(checkpointCodec, "canCommitSubtaskCheckpoint");
    try {
      h.observe();
      await vi.advanceTimersByTimeAsync(200);
      expect(
        h.calls
          .slice(0, 3)
          .map((request) => [
            sourceId(request),
            Object.keys(request.questions).length,
          ]),
      ).toEqual([
        ["report-a", 20],
        ["report-a", 2],
        ["report-a", 2],
      ]);
      const later = h.calls.slice(3);
      expect(later.length).toBeGreaterThan(0);
      expect(later.length).toBeLessThanOrEqual(22);
      expect(
        later.every(
          (request) =>
            sourceId(request) === "report-b" &&
            Object.keys(request.questions).length > 0 &&
            Object.keys(request.questions).length <= 20,
        ),
      ).toBe(true);
      const covered = later.flatMap((request) =>
        Object.keys(request.questions),
      );
      const roster = h.calls
        .slice(0, 2)
        .flatMap((request) => Object.keys(request.questions));
      expect(covered).toEqual(roster); // Ordered, disjoint, complete; no rebilling.
      expect(new Set(covered).size).toBe(22);
      const checks = capacity.mock.calls.flatMap(
        ([, metadata, reserve], index) => {
          const component = metadata?.subtasks;
          const attempt = component?.journal.reports
            .find((job) => job.source.entryId === "report-b")
            ?.attempts.at(-1);
          if (!component || !attempt || !reserve) return [];
          return [
            {
              count: attempt.childIds.length,
              accepted: capacity.mock.results[index]?.value,
              reservedBytes:
                Buffer.byteLength(JSON.stringify(component)) +
                reserve.storeBytes +
                reserve.journalBytes,
            },
          ];
        },
      );
      // Retained A history plus the unchanged conservative reserve does not fit B20.
      expect(
        checks.some(
          (check) =>
            check.count === 20 &&
            check.accepted === false &&
            check.reservedBytes > 65536,
        ),
      ).toBe(true);
      expect(
        checks.some(
          (check) =>
            check.count < 20 &&
            check.accepted === true &&
            check.reservedBytes <= 65536,
        ),
      ).toBe(true);
      expect(h.statuses()).toEqual(
        Array(22).fill(
          kind === "corrective" ? "pending" : "reported-completed",
        ),
      );
      const journal = h.checkpoint().monitor?.subtasks?.journal;
      expect(
        journal?.reports.map((job) => [job.source.entryId, job.state]),
      ).toEqual([
        ["report-a", "complete"],
        ["report-b", "complete"],
      ]);
      expect(journal?.dispatches).toBe(h.calls.length);
      expect(journal?.usage.jev.calls).toBe(h.calls.length);
      expect(
        h.monitor.subtaskDiagnosticsSnapshot().semanticOmissions.byReason
          .capacity,
      ).toBe(0);
    } finally {
      capacity.mockRestore();
    }
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
  expect(diagnostics(h)).toMatchObject({
    dispatches: 1,
    exhausted: false,
    parkedOwners: 0,
    permanentOwners: 1,
  });
  await vi.advanceTimersByTimeAsync(11000);
  h.observe();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.calls).toHaveLength(1);
  h.setTransport(undefined);
  h.append("report-b", "I confirm completion of all agreed obligations.");
  await h.settle("report-b");
  expect(h.calls.map(sourceId)).toEqual(["report-a", "report-b", "report-b"]);
  expect(diagnostics(h)).toMatchObject({
    dispatches: 3,
    exhausted: false,
    parkedOwners: 0,
    permanentOwners: 0,
  });
  expect(h.checkpoint().monitor?.subtasks?.journal.reports[0].state).toBe(
    "superseded",
  );
});
it("invalidates diagnostic owner authority on stop without erasing the durable wallet", async () => {
  const h = await fixture();
  h.setTransport(async () => {
    throw new Error("Ambiguous report failure");
  });
  h.append("report", reportText);
  await h.settle("report");
  expect(h.checkpoint().monitor?.subtasks?.journal.reports[0].state).toBe(
    "permanent",
  );
  h.monitor.stop();
  const before = [h.reader.mock.calls.length, h.fetch.mock.calls.length];
  const stopped = diagnostics(h);
  expect(stopped.dispatches).toBe(1);
  expect(stopped).not.toHaveProperty("parkedOwners");
  expect(stopped).not.toHaveProperty("permanentOwners");
  expect([h.reader.mock.calls.length, h.fetch.mock.calls.length]).toEqual(
    before,
  );
});
it("does not lose a durably saved charge when diagnostic capture cannot read authority", async () => {
  const h = await fixture();
  const originalReader = h.reader.getMockImplementation();
  if (!originalReader) throw new Error("Missing reader");
  let savedCharge: Envelope | undefined;
  h.save.mockImplementation((raw: unknown) => {
    const candidate = raw as Envelope;
    if (
      !savedCharge &&
      candidate.monitor?.subtasks?.journal.reports.some(
        (job) => job.state === "dispatched",
      )
    ) {
      savedCharge = structuredClone(candidate);
      h.reader.mockImplementation(() => {
        throw new Error("Authority unavailable after durable save");
      });
    }
  });
  try {
    h.append("report", reportText);
    await h.settle("report");
    expect(savedCharge?.monitor?.subtasks?.journal.dispatches).toBe(1);
    expect(h.calls).toHaveLength(0);
    expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(1);
    const projected = diagnostics(h);
    expect(projected).toMatchObject({ dispatches: 1, exhausted: false });
    expect(projected).not.toHaveProperty("parkedOwners");
    expect(projected).not.toHaveProperty("permanentOwners");
  } finally {
    h.reader.mockImplementation(originalReader);
  }
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
    expect(diagnostics(h)).toMatchObject({ dispatches: 0, exhausted: false });
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
  let disk = h.checkpoint();
  h.save.mockImplementation((raw: unknown) => {
    if (
      (raw as Envelope).monitor?.subtasks?.journal.reports.some((job) =>
        job.attempts.some((attempt) => attempt.outcome === "decided"),
      )
    )
      throw new Error("Report result save refused");
    disk = structuredClone(raw) as Envelope;
  });
  h.append("report", reportText);
  await h.settle("report");
  expect(h.calls).toHaveLength(1);
  expect(h.statuses()).toEqual(Array(22).fill("pending"));
  expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(1);
  expect(disk.monitor?.subtasks?.journal.reports[0].attempts[0].usage).toEqual({
    inputTokens: 7,
    outputTokens: 3,
  });
  expect(disk.monitor?.subtasks?.journal.usage.jev).toEqual({
    calls: 1,
    inputTokens: 7,
    outputTokens: 3,
  });
  h.save.mockReset();
  await h.monitor.restore("/nonexistent-hybrid-test", disk, false, h.reader);
  await vi.advanceTimersByTimeAsync(11000);
  h.observe();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.calls).toHaveLength(1);
  expect(h.checkpoint().monitor?.subtasks?.journal.reports[0].state).toBe(
    "permanent",
  );
  expect(h.checkpoint().monitor?.subtasks?.journal.usage).toEqual(
    disk.monitor?.subtasks?.journal.usage,
  );
});
it.each(["advance", "off"])(
  "keeps advisory ready during held report flight and fences %s while draining",
  async (mode) => {
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
    expect(h.monitor.advisorySettlementSnapshot().reason).toBe("ready");
    if (mode === "off") {
      h.monitor.turnOff();
      release();
      await vi.advanceTimersByTimeAsync(200);
      expect(h.statuses()).toEqual(Array(22).fill("pending"));
      expect(h.calls).toHaveLength(1);
      expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(1);
      return;
    }
    h.append("report-b", "All agreed work is now completed.");
    await h.settle("report-b");
    expect(h.monitor.state.cursor?.id).toBe("report-b");
    expect(h.calls).toHaveLength(1);
    h.setTransport(undefined);
    release();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.calls.map(sourceId)).toEqual(["report-a", "report-b", "report-b"]);
    expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(3);
  },
);
it.each(["complete", "newer-candidate", "off"])(
  "enforces the final1024th report dispatch with %s results and durable unfinished children",
  async (mode) => {
    const h = await fixture();
    const initial = h.checkpoint();
    if (!initial.monitor?.subtasks) throw new Error("Missing component");
    initial.monitor.subtasks.journal.dispatches = 1023;
    initial.monitor.subtasks.journal.usage.jev.calls = 1023;
    await h.monitor.restore(
      "/nonexistent-hybrid-test",
      initial,
      false,
      h.reader,
    );
    let release = () => {};
    releases.push(() => release());
    if (mode !== "complete")
      h.setTransport(
        (request) =>
          new Promise<Response>((resolve) => {
            release = () => resolve(answer(request));
          }),
      );
    h.append("last-paid-report", reportText);
    await h.settle("last-paid-report");
    expect(h.calls).toHaveLength(1);
    expect(Object.keys(h.calls[0].questions)).toHaveLength(20);
    if (mode === "newer-candidate") {
      h.append(
        "replacement",
        "I retract all earlier completion claims. All obligations remain unfinished.",
      );
      await h.settle("replacement");
    } else if (mode === "off") h.monitor.turnOff();
    if (mode !== "complete") {
      release();
      await vi.advanceTimersByTimeAsync(200);
    }
    // Current contract retains admitted A before newer B; OFF revokes authority.
    const completed = mode === "off" ? 0 : 20;
    expect(
      h.statuses()?.filter((status) => status === "reported-completed"),
    ).toHaveLength(completed);
    expect(h.statuses()?.filter((status) => status === "pending")).toHaveLength(
      22 - completed,
    );
    const saved = h.checkpoint();
    expect(saved.monitor?.subtasks?.journal.dispatches).toBe(1024);
    expect(h.monitor.subtaskDiagnosticsSnapshot().exhausted).toBe(true);
    await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
    h.observe();
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.calls).toHaveLength(1);
    expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(1024);
    expect(
      h.statuses()?.filter((status) => status === "reported-completed"),
    ).toHaveLength(completed);
  },
);

it("records report dispatch time rather than delayed response completion time", async () => {
  const h = await fixture();
  let at = -1;
  let release = () => {};
  releases.push(() => release());
  h.setTransport((request) => {
    if (at !== -1) return Promise.resolve(answer(request));
    at = Date.now();
    return new Promise<Response>((resolve) => {
      release = () => resolve(answer(request));
    });
  });
  h.append("timed-report", reportText);
  await h.settle("timed-report");
  expect(h.calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(2000);
  release();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.calls).toHaveLength(2);
  const job = h.checkpoint().monitor?.subtasks?.journal.reports[0];
  expect(job?.state).toBe("complete");
  expect(job?.attempts[0].at).toBe(at);
  expect(job?.attempts[1].at).toBeGreaterThanOrEqual(at + 2000);
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

it("resolves enabled restore independently of its newly started physical report drain", async () => {
  const original = await fixture();
  let ready: Envelope | undefined;
  original.save.mockImplementation((raw: unknown) => {
    const candidate = raw as Envelope;
    if (
      candidate.monitor?.subtasks?.journal.reports.some(
        (job) =>
          job.state === "ready" &&
          job.attempts.some((attempt) => attempt.outcome === "decided"),
      )
    )
      ready ??= structuredClone(candidate);
  });
  original.append("report", reportText);
  await original.settle("report");
  expect(ready).toBeDefined();
  if (!ready) throw new Error("Missing real ready checkpoint");
  original.monitor.stop();
  const h = await fixture();
  let release: (() => void) | undefined;
  let returned = false;
  h.setTransport(async (request) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return answer(request);
  });
  const restoring = h.monitor
    .restore("/nonexistent-hybrid-test", ready, false, original.reader)
    .then(() => {
      returned = true;
    });
  try {
    await vi.advanceTimersByTimeAsync(100);
    expect(h.calls).toHaveLength(1);
    expect(release).toBeTypeOf("function");
    expect(h.monitor.enabled).toBe(true);
    expect(returned).toBe(true);
    await vi.advanceTimersByTimeAsync(61000);
    expect(h.calls).toHaveLength(1);
    expect(returned).toBe(true);
  } finally {
    h.monitor.stop();
    release?.();
    await vi.advanceTimersByTimeAsync(100);
    await restoring;
  }
});

it.each([false, true])(
  "dispatches target-only report work after old drain without disposed reads (distinct deep parent=%s)",
  async (deepParent) => {
    let disposed = false;
    const selectedModel = vi.fn(() => {
      if (disposed) throw new Error("Disposed model reader");
      return undefined;
    });
    const h = await fixture(false, false, 2, { selectedModel }, 1);
    let release: (() => void) | undefined;
    h.setTransport(async (request) => {
      if (h.calls.length === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return answer(request);
    });
    h.append("report", reportText);
    await h.settle("report");
    expect(h.calls).toHaveLength(1);
    expect(release).toBeTypeOf("function");
    const target = h.checkpoint();
    if (!target.monitor?.subtasks)
      throw new Error("Missing dispatched history");
    const deepText =
      "Deliver agreed plan 2 and implement its agreed component.";
    if (deepParent)
      target.state.tasks[1].source = subtaskSource("deep-parent", deepText);
    const store = new SubtaskStore();
    for (const [index, parent] of target.state.tasks.entries()) {
      const items = index === 0 ? labels : labels.slice(0, 1);
      // Admission/child evidence is later than, and distinct from, parent source.
      const admissionSource = h.monitor.state.tasks[index].source;
      expect(
        store.admit({
          ...subtaskAdmission(items),
          parent,
          source: admissionSource,
          complete: true,
          knownTotal: items.length,
          children: items.map((label) => ({
            kind: "add",
            label,
            source: admissionSource,
          })),
        }),
      ).toEqual({ accepted: true });
    }
    // Equal original wallet/proofs; only target semantics gains a group. This is
    // new report work for the named restore wake, not resurrection of the old job.
    target.monitor.subtasks.state = store.checkpoint();
    expect(subtaskCheckpointStorageStatus(target)).toBe("supported");
    const second = target.monitor.subtasks.state.groups[1];
    const branch = [
      ...(deepParent
        ? [
            branchEntry("deep-parent", deepText, "user"),
            ...Array.from({ length: 80 }, (_, index) =>
              branchEntry(
                `old-context:${index}`,
                "Older neutral context.",
                "assistant",
              ),
            ),
          ]
        : []),
      ...structuredClone(h.reader()),
    ];
    const reader = vi.fn(() => {
      if (disposed) throw new Error("Disposed canonical reader");
      return branch;
    });
    try {
      await h.monitor.restore(
        "/nonexistent-hybrid-test",
        target,
        false,
        reader,
      );
      await vi.advanceTimersByTimeAsync(200);
      expect(h.calls).toHaveLength(1);
      expect(h.monitor.enabled).toBe(true);
      expect(h.checkpoint().monitor?.subtasks?.state.groups).toHaveLength(2);
      expect.soft(h.monitor.subtaskSnapshot().groups).toHaveLength(2);
      const reads = [reader.mock.calls.length, selectedModel.mock.calls.length];
      disposed = true;
      release?.();
      await vi.advanceTimersByTimeAsync(200);
      expect([
        reader.mock.calls.length,
        selectedModel.mock.calls.length,
      ]).toEqual(reads);
      expect(h.calls).toHaveLength(2);
      expect(Object.keys(h.calls[1].questions)).toEqual(
        second.children.map((child) => `subtask:${child.id}`),
      );
      expect(
        h
          .checkpoint()
          .monitor?.subtasks?.journal.reports.find(
            (job) => job.parentTaskId === second.parentTaskId,
          ),
      ).toMatchObject({ state: "complete" });
    } finally {
      h.monitor.stop();
      release?.();
      await vi.advanceTimersByTimeAsync(100);
    }
  },
);

it.each([false, true])(
  "preserves real pending evidence capability and revokes it on stop=%s",
  async (stop) => {
    let selected = false;
    let disposed = false;
    const selectedModel = vi.fn(() => {
      if (disposed) throw new Error("Disposed selected-model reader");
      return selected ? "fixture/selected" : undefined;
    });
    const proposeSubtasks = vi.fn(async () => {
      throw new Error("Unexpected proposal after a negative gate");
    });
    const h = await fixture(
      false,
      false,
      2,
      { selectedModel, proposeSubtasks },
      1,
    );
    let release: (() => void) | undefined;
    h.setTransport(async (request) => {
      if (h.calls.length === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return answer(request);
    });
    h.append("report", reportText);
    await h.settle("report");
    expect(release).toBeTypeOf("function");
    const target = h.checkpoint();
    const gates: EvaluationRequest[] = [];
    const transport = h.fetch.getMockImplementation();
    if (!transport) throw new Error("Missing fixture transport");
    h.fetch.mockImplementation(async (url, init) => {
      const request = JSON.parse(String(init?.body)) as EvaluationRequest;
      if (request.questions["subtask:0"]) {
        gates.push(request);
        return answer(request, "no");
      }
      return transport(url, init);
    });
    const reader = vi.fn(() => {
      if (disposed) throw new Error("Disposed canonical reader");
      return h.reader();
    });
    try {
      await h.monitor.restore(
        "/nonexistent-hybrid-test",
        target,
        false,
        reader,
      );
      h.monitor.observeCoverageToolStart("pending-manifest", "bash", {
        command: metadataCommand,
      });
      h.monitor.observeCoverageToolEnd("pending-manifest", "bash");
      h.replace([
        ...h.reader(),
        {
          type: "message",
          id: "result-pending-manifest",
          message: {
            role: "toolResult",
            toolCallId: "pending-manifest",
            toolName: "bash",
            content: [{ type: "text", text: metadataXml }],
            isError: false,
          },
        },
      ]);
      selected = true;
      h.monitor.confirmCoverageBranch(h.reader());
      const captured = Reflect.get(h.monitor, "pendingSubtaskCurrent") as
        | SubtaskRuntimeCurrent
        | null
        | undefined;
      expect(captured?.evidence?.resources).toHaveLength(1);
      // Narrow white-box check is necessary: JSON equality cannot prove the
      // private adapter-issued capability or release of its resolver closure.
      if (!stop)
        expect.soft(isCurrentSubtaskEvidence(captured?.evidence)).toBe(true);
      if (stop) {
        h.monitor.stop();
        expect.soft(Reflect.get(h.monitor, "pendingSubtaskCurrent")).toBeNull();
        expect
          .soft(Reflect.get(h.monitor, "capturedSubtaskCurrent"))
          .toBeNull();
        expect.soft(captured?.resolve("goal")).toBeUndefined();
        expect.soft(isCurrentSubtaskEvidence(captured?.evidence)).toBe(false);
      }
      const reads = [reader.mock.calls.length, selectedModel.mock.calls.length];
      disposed = true;
      release?.();
      await vi.advanceTimersByTimeAsync(200);
      expect([
        reader.mock.calls.length,
        selectedModel.mock.calls.length,
      ]).toEqual(reads);
      expect(proposeSubtasks).not.toHaveBeenCalled();
      if (stop) {
        expect(gates).toEqual([]);
        expect(Reflect.get(h.monitor, "capturedSubtaskCurrent")).toBeNull();
      } else {
        const secondId = h.monitor.state.tasks[1].id;
        const ownerGates = gates.filter(
          (request) =>
            (request.state as { parent: { id: string } }).parent.id ===
            secondId,
        );
        expect(ownerGates).toHaveLength(1);
        expect(ownerGates[0].state).toMatchObject({
          evidence: {
            resources: [{ source: { entryId: "result-pending-manifest" } }],
          },
        });
      }
    } finally {
      h.monitor.stop();
      release?.();
      await vi.advanceTimersByTimeAsync(100);
    }
  },
);

it.each([
  { bytes: 65536, sources: 1 },
  { bytes: 65537, sources: 1 },
  { bytes: 65537, sources: 2 },
  { bytes: 65537, sources: 2, inheritedHook: true },
])(
  "bounds pending canonical transfer at $bytes UTF-8 bytes across $sources sources (inheritedHook=$inheritedHook)",
  async ({ bytes, sources, inheritedHook = false }) => {
    let selected = false;
    let disposed = false;
    const selectedModel = vi.fn(() => {
      if (disposed) throw new Error("Disposed model reader");
      return selected ? "fixture/selected" : undefined;
    });
    const proposeSubtasks = vi.fn(async () => {
      throw new Error("Unexpected proposal");
    });
    const h = await fixture(
      false,
      false,
      2,
      { selectedModel, proposeSubtasks },
      1,
    );
    let release: (() => void) | undefined;
    h.setTransport(async (request) => {
      if (h.calls.length === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return answer(request);
    });
    h.append("report", reportText);
    await h.settle("report");
    expect(release).toBeTypeOf("function");
    const target = h.checkpoint();
    if (!target.monitor?.subtasks) throw new Error("Missing history");
    const initialBranch = h.reader();
    const ids = Array.from(
      { length: sources },
      (_, index) => `historical:${index}`,
    );
    const makeBranch = (texts: string[]) => [
      ...texts.map((text, index) => branchEntry(ids[index], text, "user")),
      ...initialBranch,
    ];
    const captureBytes = (texts: string[]) => {
      const pass = new CanonicalPass(makeBranch(texts));
      return Buffer.byteLength(
        JSON.stringify(
          ["report", "goal", ...ids].map((id) => pass.observation(id)),
        ),
        "utf8",
      );
    };
    const bodies = labels.slice(0, sources);
    let remaining = bytes - captureBytes(bodies);
    for (let index = 0; index < sources; index++) {
      const added = Math.floor(remaining / (sources - index));
      bodies[index] +=
        "é".repeat(Math.floor(added / 2)) + "x".repeat(added % 2);
      remaining -= added;
    }
    expect(captureBytes(bodies)).toBe(bytes);
    if (sources > 1)
      expect(
        bodies.every((body) => Buffer.byteLength(body, "utf8") < 65536),
      ).toBe(true);
    const references = bodies.map((body, index) => ({
      ...subtaskSource(ids[index], body),
      end: labels[index].length,
      quoteHash: subtaskHash(labels[index]),
    }));
    const source = references[0];
    const store = new SubtaskStore();
    const parent = target.state.tasks[0];
    expect(
      store.admit({
        ...subtaskAdmission(labels),
        parent,
        source: parent.source,
        complete: true,
        knownTotal: 22,
        children: labels.map((label, index) => ({
          kind: "add",
          label,
          source: references[index] ?? parent.source,
        })),
      }),
    ).toEqual({ accepted: true });
    target.monitor.subtasks.state = store.checkpoint();
    expect(subtaskCheckpointStorageStatus(target)).toBe("supported");
    const branch = makeBranch(bodies);
    const reader = vi.fn(() => {
      if (disposed) throw new Error("Disposed canonical reader");
      return branch;
    });
    const gates: EvaluationRequest[] = [];
    const transport = h.fetch.getMockImplementation();
    if (!transport) throw new Error("Missing transport");
    h.fetch.mockImplementation(async (url, init) => {
      const request = JSON.parse(String(init?.body)) as EvaluationRequest;
      if (request.questions["subtask:0"]) {
        gates.push(request);
        return answer(request, "no");
      }
      return transport(url, init);
    });
    try {
      selected = true;
      if (inheritedHook) {
        const pass = new CanonicalPass(branch);
        for (const id of ["goal", "report", ...ids]) pass.observation(id);
        const current = Reflect.apply(
          Reflect.get(h.monitor, "subtaskCurrent"),
          h.monitor,
          [target.state, pass],
        ) as SubtaskRuntimeCurrent | undefined;
        expect(current).toBeDefined();
        const hook = vi.fn(() => ({}));
        const descriptor = Object.getOwnPropertyDescriptor(
          Object.prototype,
          "toJSON",
        );
        let captured: SubtaskRuntimeCurrent | undefined;
        // Isolate the private byte boundary: a global hook during public
        // restore would also alter unrelated fixture/codec serialization.
        try {
          Object.defineProperty(Object.prototype, "toJSON", {
            configurable: true,
            value: hook,
          });
          captured = Reflect.apply(
            Reflect.get(h.monitor, "capturedPendingSubtaskCurrent"),
            h.monitor,
            [
              current,
              target.monitor.subtasks,
              new Set(target.state.tasks.map((task) => task.id)),
              pass,
            ],
          ) as SubtaskRuntimeCurrent | undefined;
        } finally {
          if (descriptor)
            Object.defineProperty(Object.prototype, "toJSON", descriptor);
          else Reflect.deleteProperty(Object.prototype, "toJSON");
        }
        expect.soft(hook).not.toHaveBeenCalled();
        expect(captured).toBeUndefined();
        return;
      }
      await h.monitor.restore(
        "/nonexistent-hybrid-test",
        target,
        false,
        reader,
      );
      // Settle canonical bookkeeping for the historical entry while old
      // optional transport is still held; only later drain must be passive.
      await vi.advanceTimersByTimeAsync(200);
      expect(h.monitor.enabled).toBe(true);
      const before = h.checkpoint().monitor?.subtasks;
      expect(before?.state.groups[0].children[0].source).toEqual(source);
      expect(before?.state.groups[0].children).toHaveLength(22);
      if (bytes > 65536)
        expect.soft(Reflect.get(h.monitor, "pendingSubtaskCurrent")).toBeNull();
      const reads = [reader.mock.calls.length, selectedModel.mock.calls.length];
      disposed = true;
      release?.();
      await vi.advanceTimersByTimeAsync(200);
      expect([
        reader.mock.calls.length,
        selectedModel.mock.calls.length,
      ]).toEqual(reads);
      const after = h.checkpoint().monitor?.subtasks;
      expect(after?.state).toEqual(before?.state);
      if (bytes > 65536) {
        expect(gates).toEqual([]);
        expect(after?.journal).toEqual(before?.journal);
        expect(Reflect.get(h.monitor, "capturedSubtaskCurrent")).toBeNull();
      } else {
        const secondId = target.state.tasks[1].id;
        expect(
          gates.filter(
            (request) =>
              (request.state as { parent: { id: string } }).parent.id ===
              secondId,
          ),
        ).toHaveLength(1);
      }
    } finally {
      h.monitor.stop();
      release?.();
      await vi.advanceTimersByTimeAsync(100);
    }
  },
);

it.each(["unchanged", "coalesced", "vetoed", "whole-request"])(
  "keeps a real parked report owner ahead of decomposition during a different parent's proposal drain (%s)",
  async (mode) => {
    let selected = false;
    let proposalAttempts = 0;
    let release: (() => void) | undefined;
    const proposeSubtasks: NonNullable<
      MonitorOptions["proposeSubtasks"]
    > = async (_request, _signal, onDispatch, onPhysicalFlight) => {
      proposalAttempts++;
      if (proposalAttempts === 1)
        throw new Error("Unavailable before dispatch");
      expect(onDispatch?.(Date.now())).toBe(true);
      const drain = new Promise<void>((resolve) => {
        release = resolve;
      });
      onPhysicalFlight?.(drain);
      await drain;
      throw new Error("Late aborted proposal must not publish");
    };
    const h = await fixture(
      false,
      false,
      2,
      {
        selectedModel: () => (selected ? "fixture/selected" : undefined),
        proposeSubtasks,
      },
      0,
    );
    const [a, p] = h.monitor.state.tasks;
    const gates: EvaluationRequest[] = [];
    const transport = h.fetch.getMockImplementation();
    if (!transport) throw new Error("Missing fixture transport");
    h.fetch.mockImplementation(async (url, init) => {
      const request = JSON.parse(String(init?.body)) as EvaluationRequest;
      if (request.questions["subtask:0"]) {
        gates.push(request);
        const state = request.state as {
          parent: { id: string };
          latest: { id: string };
        };
        return answer(
          request,
          state.parent.id === p.id && state.latest.id === "report-a"
            ? "yes"
            : "no",
        );
      }
      return transport(url, init);
    });
    try {
      selected = true;
      h.append("report-a", reportText);
      await h.settle("report-a");
      await vi.advanceTimersByTimeAsync(200);
      expect(proposalAttempts).toBe(1);
      const target = h.checkpoint();
      if (!target.monitor?.subtasks) throw new Error("Missing real yes gate");
      expect(
        target.monitor.subtasks.journal.records.find(
          (record) => record.parentTaskId === p.id,
        ),
      ).toMatchObject({ state: "ready" });
      expect(target.monitor.subtasks.journal.usage.extraction.calls).toBe(0);
      // Existing report-fixture admission boundary only; all gate/proposal/report
      // dispatches and the parked certificate below use real runtime hooks.
      const store = new SubtaskStore();
      expect(
        store.admit({
          ...subtaskAdmission(labels),
          parent: a,
          source: a.source,
          complete: true,
          knownTotal: 22,
          children: labels.map((label) => ({
            kind: "add",
            label,
            source: a.source,
          })),
        }),
      ).toEqual({ accepted: true });
      target.monitor.subtasks.state = store.checkpoint();
      h.setTransport(async (request) =>
        h.calls.length === 1
          ? new Response(null, {
              status: 503,
              headers: { "Retry-After": "10" },
            })
          : answer(request),
      );
      await h.monitor.restore(
        "/nonexistent-hybrid-test",
        target,
        false,
        h.reader,
      );
      await vi.advanceTimersByTimeAsync(200);
      expect(h.calls).toHaveLength(1);
      expect(proposalAttempts).toBe(2);
      expect(release).toBeTypeOf("function");
      const parked = h
        .checkpoint()
        .monitor?.subtasks?.journal.reports.find(
          (job) => job.parentTaskId === a.id,
        );
      expect(parked).toMatchObject({ state: "parked" });
      if (!parked?.parkedUntil)
        throw new Error("Missing admitted retry deadline");
      expect(parked.parkedUntil).toBeGreaterThan(Date.now());
      h.append(
        "report-b",
        "A newer report is waiting behind the parked assessment.",
      );
      await h.settle("report-b");
      const sameLineage = h.checkpoint();
      expect(
        sameLineage.monitor?.subtasks?.journal.reports.find(
          (job) => job.identity === parked.identity,
        ),
      ).toEqual(parked);
      gates.splice(0);
      await h.monitor.restore(
        "/nonexistent-hybrid-test",
        sameLineage,
        false,
        h.reader,
      );
      if (mode !== "unchanged") {
        const pendingTarget = h.checkpoint().monitor?.subtasks;
        const queuedBefore = (
          Reflect.get(h.monitor, "subtaskReportCandidates") as Map<
            string,
            { source: SourceRef }
          >
        ).get(a.id);
        const group = h.monitor
          .subtaskSnapshot()
          .groups.find((item) => item.parentTaskId === a.id);
        if (!queuedBefore || !group) throw new Error("Missing pending B/group");
        expect(queuedBefore.source.entryId).toBe("report-b");
        const text =
          mode === "whole-request"
            ? `PRIVATE_PENDING_ESCAPED ${"\\".repeat(9000)} end`
            : "A third eligible report replaces only never-admitted B.";
        if (mode === "whole-request") {
          expect(Buffer.byteLength(text)).toBeLessThanOrEqual(12 * 1024);
          expect(
            Buffer.byteLength(JSON.stringify({ text, group })),
          ).toBeGreaterThan(24 * 1024);
        }
        const c = observation("report-c", text, "assistant");
        const omittedIdentity = subtaskReportOmissionIdentity({
          sourceId: h.monitor.state.sourceId,
          parent: a,
          group,
          reportSource:
            mode === "whole-request"
              ? {
                  entryId: c.id,
                  messageHash: c.hash,
                  role: c.role,
                  start: 0,
                  end: c.text.length,
                  quoteHash: c.hash,
                }
              : queuedBefore.source,
        });
        expect(omittedIdentity).toMatch(/^[a-f0-9]{64}$/);
        expect(
          Reflect.get(h.monitor, "pendingSubtaskCheckpoint"),
        ).toBeDefined();
        expect(h.checkpoint().monitor?.subtaskOmissions).toBeUndefined();
        let allow = mode !== "vetoed";
        h.save.mockClear();
        h.save.mockImplementation((raw: unknown) => {
          if (!allow && (raw as Envelope).monitor?.subtaskOmissions)
            throw new Error("Pending coalescing veto");
        });
        h.append("report-c", text);
        await h.settle("report-c");
        if (!allow) {
          const queued = Reflect.get(
            h.monitor,
            "subtaskReportCandidates",
          ) as Map<string, { source: SourceRef }>;
          expect.soft(queued.get(a.id)?.source.entryId).toBe("report-b");
          expect(h.checkpoint().monitor?.subtaskOmissions).toBeUndefined();
          allow = true;
          h.observe();
          await vi.advanceTimersByTimeAsync(100);
        }
        const summary = h.checkpoint().monitor?.subtaskOmissions;
        expect(summary).toEqual({
          entries: [
            {
              identity: omittedIdentity,
              reason:
                mode === "whole-request" ? "report-oversized" : "coalesced",
            },
          ],
          saturated: false,
        });
        const queuedAfter = Reflect.get(
          h.monitor,
          "subtaskReportCandidates",
        ) as Map<string, { source: SourceRef }>;
        expect(queuedAfter.get(a.id)?.source.entryId).toBe(
          mode === "whole-request" ? "report-b" : "report-c",
        );
        const firstSummarySave = h.save.mock.calls
          .map(([raw]) => raw as Envelope)
          .find((saved) => saved.monitor?.subtaskOmissions);
        expect(firstSummarySave?.monitor?.subtasks).toEqual(pendingTarget);
        expect(firstSummarySave?.state.cursor?.id).toBe("report-c");
        expect(h.calls).toHaveLength(1);
      }
      release?.();
      await vi.advanceTimersByTimeAsync(200);
      expect(
        gates.filter(
          (request) =>
            (request.state as { parent: { id: string } }).parent.id === a.id,
        ),
      ).toEqual([]);
      expect(
        h
          .checkpoint()
          .monitor?.subtasks?.journal.reports.find(
            (job) => job.identity === parked.identity,
          ),
      ).toEqual(parked);
      expect(h.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(
        Math.max(0, parked.parkedUntil - Date.now()) + 1,
      );
      expect(h.calls).toHaveLength(1);
      h.observe();
      await vi.advanceTimersByTimeAsync(200);
      expect(h.calls.length).toBeGreaterThan(1);
      expect(sourceId(h.calls[1])).toBe("report-a");
    } finally {
      h.monitor.stop();
      release?.();
      await vi.advanceTimersByTimeAsync(100);
    }
  },
);

it("revokes an invalid pending wake and recovers identical generic work on the next named wake", async () => {
  let selected = false;
  let unavailable = false;
  let disposed = false;
  const selectedModel = vi.fn(() => {
    if (disposed) throw new Error("Disposed model reader");
    if (unavailable) throw new Error("Transient selected model lookup failure");
    return selected ? "fixture/selected" : undefined;
  });
  const proposeSubtasks = vi.fn(async () => {
    throw new Error("Unexpected proposal");
  });
  const h = await fixture(
    false,
    false,
    2,
    { selectedModel, proposeSubtasks },
    1,
  );
  let release: (() => void) | undefined;
  h.setTransport(async (request) => {
    if (h.calls.length === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return answer(request);
  });
  h.append("report", reportText);
  await h.settle("report");
  expect(release).toBeTypeOf("function");
  const target = h.checkpoint();
  if (!target.monitor?.subtasks) throw new Error("Missing history");
  target.monitor.subtasks.state = new SubtaskStore().checkpoint();
  expect(subtaskCheckpointStorageStatus(target)).toBe("supported");
  const gates: EvaluationRequest[] = [];
  const transport = h.fetch.getMockImplementation();
  if (!transport) throw new Error("Missing transport");
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body)) as EvaluationRequest;
    if (request.questions["subtask:0"]) {
      gates.push(request);
      return answer(request, "no");
    }
    return transport(url, init);
  });
  const reader = vi.fn(() => {
    if (disposed) throw new Error("Disposed canonical reader");
    return h.reader();
  });
  try {
    selected = true;
    await h.monitor.restore("/nonexistent-hybrid-test", target, false, reader);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.monitor.subtaskSnapshot().groups).toEqual([]);
    const original = Reflect.get(h.monitor, "pendingSubtaskCurrent") as
      | SubtaskRuntimeCurrent
      | null
      | undefined;
    expect(original?.resolve("goal")).toBeDefined();
    unavailable = true;
    h.monitor.observe(reader);
    expect.soft(Reflect.get(h.monitor, "pendingSubtaskCurrent")).toBeNull();
    expect.soft(original?.resolve("goal")).toBeUndefined();
    unavailable = false;
    h.monitor.observe(reader);
    const reads = [reader.mock.calls.length, selectedModel.mock.calls.length];
    disposed = true;
    release?.();
    await vi.advanceTimersByTimeAsync(200);
    expect([reader.mock.calls.length, selectedModel.mock.calls.length]).toEqual(
      reads,
    );
    const secondId = target.state.tasks[1].id;
    expect(
      gates.filter(
        (request) =>
          (request.state as { parent: { id: string } }).parent.id === secondId,
      ),
    ).toHaveLength(1);
    expect(proposeSubtasks).not.toHaveBeenCalled();
  } finally {
    h.monitor.stop();
    release?.();
    await vi.advanceTimersByTimeAsync(100);
  }
});

it("keeps a charged report across proposal-model selection without stranding its remaining children", async () => {
  const h = await fixture();
  let release: (() => void) | undefined;
  h.setTransport(async (request) => {
    if (h.calls.length === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return answer(request);
  });
  try {
    h.append("report-model-selection", reportText);
    await h.settle("report-model-selection");
    expect(h.calls).toHaveLength(1);
    const before = h.checkpoint().monitor?.subtasks?.journal.dispatches;
    h.monitor.modelSelected();
    expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(before);
    release?.();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.calls.map(sourceId)).toEqual([
      "report-model-selection",
      "report-model-selection",
    ]);
    expect(h.statuses()).toEqual(Array(22).fill("reported-completed"));
    expect(h.checkpoint().monitor?.subtasks?.journal.reports[0]).toMatchObject({
      state: "complete",
    });
    expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(
      (before ?? 0) + 1,
    );
  } finally {
    h.monitor.stop();
    release?.();
    await vi.advanceTimersByTimeAsync(100);
  }
});

it.each(["constant", "oversized", "throw"])(
  "builds bounded hook-free wake identities under inherited toJSON (%s)",
  async (kind) => {
    const h = await fixture();
    const pass = new CanonicalPass(h.reader());
    const current = Reflect.apply(
      Reflect.get(h.monitor, "subtaskCurrent"),
      h.monitor,
      [h.monitor.state, pass],
    ) as SubtaskRuntimeCurrent;
    expect(current).toBeDefined();
    const second = {
      ...current,
      latest: { ...current.latest, id: "different-canonical-id" },
    };
    const build = Reflect.get(h.monitor, "subtaskWakeKeyFor");
    const baseline = Reflect.apply(build, h.monitor, [current]) as string;
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "toJSON",
    );
    const hook = vi.fn(() => {
      if (kind === "throw") throw new Error("Inherited serialization hook");
      return kind === "oversized"
        ? "PRIVATE_WAKE_BODY".repeat(8192)
        : "same-key";
    });
    let keys: string[] = [];
    let error: unknown;
    try {
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        value: hook,
      });
      keys = [current, second].map(
        (value) => Reflect.apply(build, h.monitor, [value]) as string,
      );
    } catch (caught) {
      error = caught;
    } finally {
      if (descriptor)
        Object.defineProperty(Object.prototype, "toJSON", descriptor);
      else Reflect.deleteProperty(Object.prototype, "toJSON");
    }
    expect.soft(hook).not.toHaveBeenCalled();
    expect.soft(error).toBeUndefined();
    expect.soft(keys[0]).toBe(baseline);
    expect.soft(keys[0]).not.toBe(keys[1]);
    for (const key of keys) expect(key).toMatch(/^[a-f0-9]{64}$/);
  },
);

it("persists oversized C during pending proposal drain without captured body or disposed reads", async () => {
  let selected = false;
  let disposed = false;
  const selectedModel = vi.fn(() => {
    if (disposed) throw new Error("Disposed pending model reader");
    return selected ? "fixture/selected" : undefined;
  });
  let proposalAttempts = 0;
  let release: (() => void) | undefined;
  const proposeSubtasks: NonNullable<
    MonitorOptions["proposeSubtasks"]
  > = async (_request, _signal, onDispatch, onPhysicalFlight) => {
    proposalAttempts++;
    if (proposalAttempts === 1) throw new Error("Unavailable before dispatch");
    expect(onDispatch?.(Date.now())).toBe(true);
    const drain = new Promise<void>((resolve) => {
      release = resolve;
    });
    onPhysicalFlight?.(drain);
    await drain;
    throw new Error("Late aborted proposal must not publish");
  };
  const h = await fixture(
    false,
    false,
    2,
    {
      selectedModel,
      proposeSubtasks,
    },
    0,
  );
  const [a, p] = h.monitor.state.tasks;
  const gates: EvaluationRequest[] = [];
  const transport = h.fetch.getMockImplementation();
  if (!transport) throw new Error("Missing fixture transport");
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body)) as EvaluationRequest;
    if (request.questions["subtask:0"]) {
      gates.push(request);
      const state = request.state as {
        parent: { id: string };
        latest: { id: string };
      };
      return answer(
        request,
        state.parent.id === p.id && state.latest.id === "report-a"
          ? "yes"
          : "no",
      );
    }
    return transport(url, init);
  });
  try {
    selected = true;
    h.append("report-a", reportText);
    await h.settle("report-a");
    await vi.advanceTimersByTimeAsync(200);
    expect(proposalAttempts).toBe(1);
    const target = h.checkpoint();
    if (!target.monitor?.subtasks) throw new Error("Missing real yes gate");
    expect(
      target.monitor.subtasks.journal.records.find(
        (record) => record.parentTaskId === p.id,
      ),
    ).toMatchObject({ state: "ready" });
    expect(target.monitor.subtasks.journal.usage.extraction.calls).toBe(0);
    // Existing report-fixture admission boundary only; all gate/proposal/report
    // dispatches and the parked certificate below use real runtime hooks.
    const store = new SubtaskStore();
    expect(
      store.admit({
        ...subtaskAdmission(labels),
        parent: a,
        source: a.source,
        complete: true,
        knownTotal: 22,
        children: labels.map((label) => ({
          kind: "add",
          label,
          source: a.source,
        })),
      }),
    ).toEqual({ accepted: true });
    target.monitor.subtasks.state = store.checkpoint();
    h.setTransport(async (request) =>
      h.calls.length === 1
        ? new Response(null, { status: 503, headers: { "Retry-After": "10" } })
        : answer(request),
    );
    await h.monitor.restore(
      "/nonexistent-hybrid-test",
      target,
      false,
      h.reader,
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(h.calls).toHaveLength(1);
    expect(proposalAttempts).toBe(2);
    expect(release).toBeTypeOf("function");
    const parked = h
      .checkpoint()
      .monitor?.subtasks?.journal.reports.find(
        (job) => job.parentTaskId === a.id,
      );
    expect(parked).toMatchObject({ state: "parked" });
    if (!parked?.parkedUntil)
      throw new Error("Missing admitted retry deadline");
    expect(parked.parkedUntil).toBeGreaterThan(Date.now());
    const text = `PRIVATE_PENDING_OVERSIZED ${"oversized report evidence ".repeat(700)}`;
    const sameLineage = h.checkpoint();
    expect(sameLineage.monitor?.subtaskOmissions).toBeUndefined();
    const liveComponent = structuredClone(sameLineage.monitor?.subtasks);
    // Prepare target semantics without a public live observe/append wake for C.
    sameLineage.state = await processObservation(
      sameLineage.state,
      observation("oversized-c", text, "assistant"),
      backend(noPatch(), { gate: "unchanged" }),
    );
    expect(sameLineage.state.cursor?.id).toBe("oversized-c");
    expect(h.checkpoint().monitor?.subtaskOmissions).toBeUndefined();
    expect(
      sameLineage.monitor?.subtasks?.journal.reports.find(
        (job) => job.identity === parked.identity,
      ),
    ).toEqual(parked);
    gates.splice(0);
    const branch = h.reader();
    branch.push(branchEntry("oversized-c", text, "assistant"));
    h.save.mockClear();
    const reader = vi.fn(() => {
      if (disposed) throw new Error("Disposed pending canonical reader");
      return branch;
    });
    await h.monitor.restore(
      "/nonexistent-hybrid-test",
      sameLineage,
      false,
      reader,
    );
    // Let the named restore finish its ordinary mandatory scheduling before
    // disposing readers; only the held physical proposal remains outstanding.
    await vi.advanceTimersByTimeAsync(200);
    const installed = h.checkpoint();
    expect(installed.monitor?.subtaskOmissions).toMatchObject({
      entries: [{ reason: "report-oversized" }],
      saturated: false,
    });
    expect(Reflect.get(h.monitor, "pendingSubtaskCurrent")).toBeNull();
    expect(JSON.stringify(installed)).not.toContain(
      "PRIVATE_PENDING_OVERSIZED",
    );
    const boundarySaves = h.save.mock.calls.map(([raw]) => raw as Envelope);
    const targetSave = boundarySaves[0];
    expect(targetSave.monitor?.subtaskOmissions).toBeUndefined();
    expect(targetSave.state.cursor?.id).toBe("oversized-c");
    expect(targetSave.monitor?.subtasks).not.toEqual(liveComponent);
    const firstSummarySave = boundarySaves.find(
      (saved) => saved.monitor?.subtaskOmissions,
    );
    expect(firstSummarySave).toBeDefined();
    expect(firstSummarySave?.state).toEqual(targetSave.state);
    expect(firstSummarySave?.monitor?.subtasks).toEqual(
      targetSave.monitor?.subtasks,
    );
    expect(firstSummarySave?.monitor?.subtaskOmissions).toEqual(
      installed.monitor?.subtaskOmissions,
    );
    expect(installed.monitor?.subtasks).toEqual(targetSave.monitor?.subtasks);
    const reads = [reader.mock.calls.length, selectedModel.mock.calls.length];
    disposed = true;
    release?.();
    await vi.advanceTimersByTimeAsync(200);
    expect([reader.mock.calls.length, selectedModel.mock.calls.length]).toEqual(
      reads,
    );
    expect(Reflect.get(h.monitor, "capturedSubtaskCurrent")).toBeNull();
    expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(
      installed.monitor?.subtasks?.journal.dispatches,
    );
    expect(h.checkpoint().monitor?.subtasks?.state.groups).toEqual(
      installed.monitor?.subtasks?.state.groups,
    );
    expect(h.checkpoint().monitor?.subtaskOmissions).toEqual(
      installed.monitor?.subtaskOmissions,
    );
    expect(
      gates.filter(
        (request) =>
          (request.state as { parent: { id: string } }).parent.id === a.id,
      ),
    ).toEqual([]);
    expect(
      h
        .checkpoint()
        .monitor?.subtasks?.journal.reports.find(
          (job) => job.identity === parked.identity,
        ),
    ).toEqual(parked);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(
      Math.max(0, parked.parkedUntil - Date.now()) + 1,
    );
    expect(h.calls).toHaveLength(1);
    expect([reader.mock.calls.length, selectedModel.mock.calls.length]).toEqual(
      reads,
    );
    disposed = false;
    h.append("bounded-after-c", "The agreed work has a new bounded report.");
    await h.settle("bounded-after-c");
    await vi.advanceTimersByTimeAsync(200);
    expect(h.calls.length).toBeGreaterThan(1);
    expect(sourceId(h.calls[1])).toBe("report-a");
    expect(h.calls.map(sourceId)).not.toContain("oversized-c");
    expect(
      h
        .checkpoint()
        .monitor?.subtasks?.journal.reports.find(
          (job) => job.identity === parked.identity,
        ),
    ).toMatchObject({ state: "complete" });
  } finally {
    h.monitor.stop();
    release?.();
    await vi.advanceTimersByTimeAsync(100);
  }
});

it("reserves report launch before reentrant model selection in the dispatch persistence callback", async () => {
  const h = await fixture();
  let reentered = false;
  const before = h.checkpoint().monitor?.subtasks?.journal.dispatches ?? 0;
  h.save.mockImplementation((raw: unknown) => {
    const saved = raw as Envelope;
    if (
      !reentered &&
      saved.monitor?.subtasks?.journal.reports.some(
        (job) => job.state === "dispatched",
      )
    ) {
      reentered = true;
      expect(h.calls).toHaveLength(0);
      h.monitor.modelSelected();
    }
  });
  h.append("reentrant-report", reportText);
  await h.settle("reentrant-report");
  await vi.advanceTimersByTimeAsync(200);
  expect(reentered).toBe(true);
  expect(h.calls.map(sourceId)).toEqual([
    "reentrant-report",
    "reentrant-report",
  ]);
  expect(h.statuses()).toEqual(Array(22).fill("reported-completed"));
  expect(h.checkpoint().monitor?.subtasks?.journal.reports[0]).toMatchObject({
    state: "complete",
  });
  expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(before + 2);
});
