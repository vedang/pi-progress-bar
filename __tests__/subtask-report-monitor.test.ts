import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EvaluationRequest } from "../src/analysis/gateway";
import { processObservation } from "../src/core/hybrid";
import * as checkpointCodec from "../src/core/hybrid-checkpoint";
import {
  type encodeSubtaskCheckpoint,
  subtaskCheckpointStorageStatus,
} from "../src/core/hybrid-checkpoint";
import type { SourceRef } from "../src/core/hybrid-state";
import type { MonitorOptions } from "../src/core/monitor";
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
async function fixture(
  details = false,
  throwingModel = false,
  parentCount = 1,
  monitorOptions: Partial<MonitorOptions> = {},
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
  for (const parent of h.monitor.state.tasks)
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
  h.save.mockReset();
  h.calls.splice(0);
  await h.monitor.restore("/nonexistent-hybrid-test", midway, false, h.reader);
  await vi.advanceTimersByTimeAsync(200);
  const covered = h.calls.flatMap((request) => Object.keys(request.questions));
  expect(covered).toEqual(expectedKeys);
  expect(new Set(covered).size).toBe(expectedKeys.length);
  expect(
    h.calls.every(
      (request) =>
        sourceId(request) === "report" &&
        Object.keys(request.questions).length <= 20,
    ),
  ).toBe(true);
  const journal = h.checkpoint().monitor?.subtasks?.journal;
  expect(
    journal?.reports
      .filter((job) => job.state === "complete")
      .map((job) => job.parentTaskId)
      .sort(),
  ).toEqual([first.id, second.id].sort());
  expect(journal?.dispatches).toBe(
    (midway.monitor?.subtasks?.journal.dispatches ?? 0) + h.calls.length,
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
