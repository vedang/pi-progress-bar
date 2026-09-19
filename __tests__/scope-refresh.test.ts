import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EvaluationRequest,
  ValidatedResult,
} from "../src/analysis/gateway";
import { reconcileLedger } from "../src/core/ledger";
import { Monitor } from "../src/core/monitor";
import { readBeadsExport } from "../src/sources/beads";
import { proposal } from "../src/sources/candidates";
import { collectTrajectory, findCandidates } from "../src/sources/trajectory";

vi.mock("../src/sources/beads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sources/beads")>();
  return {
    ...actual,
    readBeadsExport: vi.fn(async () => ({
      complete: false,
      records: new Map(),
      note: "unavailable",
    })),
  };
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(readBeadsExport).mockResolvedValue({
    complete: false,
    records: new Map(),
    note: "unavailable",
  });
});

function fixture() {
  vi.useFakeTimers();
  const candidates = findCandidates(
    collectTrajectory([
      {
        type: "message",
        id: "goal",
        parentId: null,
        message: { role: "user", content: "1. Implement parser" },
      },
      {
        type: "message",
        id: "later",
        parentId: "goal",
        message: { role: "user", content: "1. Improve help" },
      },
    ]),
  );
  const first = candidates[0];
  const second = candidates[1];
  if (!first || !second) throw new Error("Missing fixture candidates");
  const persist = vi.fn();
  const monitor = new Monitor(vi.fn(), persist);
  monitor.ledger = reconcileLedger(undefined, proposal(first).snapshot);
  monitor.conversation.proposals = [proposal(second)];
  // No turnOn: only exercise controller scheduling. No gateway or network.
  monitor.enabled = true;
  const jobs: {
    request: EvaluationRequest;
    admit: (result: ValidatedResult) => void;
  }[] = [];
  vi.spyOn(monitor, "enqueueAnalysis").mockImplementation(
    (purpose, request, admit) => {
      if (purpose === "scope") jobs.push({ request, admit });
    },
  );
  return { monitor, jobs, persist };
}

function respond(job: {
  request: EvaluationRequest;
  admit: (result: ValidatedResult) => void;
}) {
  const answers = Object.fromEntries(
    Object.entries(job.request.questions).map(([id, question]) => {
      const choice =
        id === "scope"
          ? "continue"
          : id === "current"
            ? "candidate:0"
            : id.startsWith("status:")
              ? "not-a-report"
              : "new";
      return [
        id,
        {
          type: "choice" as const,
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(question.criteria).map((key) => [
              key,
              key === choice ? 1 : 0,
            ]),
          ),
        },
      ];
    }),
  );
  job.admit({
    model: "jev-1.13.0",
    answers,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

function startRefresh(monitor: Monitor) {
  // ON is an enrichment boundary; idle clocks are no longer refresh triggers.
  vi.stubEnv("TYPESAFE_API_KEY", "offline-fixture-key");
  monitor.enabled = false;
  monitor.turnOn("/offline-fixture");
}

describe("scope transactions across event refresh", () => {
  it("preserves last valid Beads enrichment when export is unavailable", async () => {
    const { monitor } = fixture();
    if (!monitor.ledger) throw new Error("Missing ledger");
    const beads = {
      id: "proj-123",
      title: "Previously read export",
      conflict: false,
    };
    const task = monitor.ledger.tasks[0];
    if (!task) throw new Error("Missing task");
    task.beads = beads;
    startRefresh(monitor);
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.ledger.tasks[0]?.beads).toEqual(beads);
    monitor.stop();
  });

  it("preserves grounded epic and child metadata when readable export omits records", async () => {
    const { monitor, persist } = fixture();
    if (!monitor.ledger) throw new Error("Missing ledger");
    const first = monitor.ledger.tasks[0];
    if (!first) throw new Error("Missing first task");
    monitor.ledger.tasks = [
      {
        ...first,
        text: "Work on proj-epic",
        included: false,
        beads: {
          id: "proj-epic",
          title: "Parent",
          issueType: "epic",
          conflict: false,
        },
      },
      {
        ...first,
        id: `${first.id}:child`,
        text: "Work on proj-child",
        included: true,
        beads: { id: "proj-child", title: "Child", conflict: false },
      },
    ];
    const original = structuredClone(monitor.ledger.tasks);
    vi.mocked(readBeadsExport).mockResolvedValue({
      complete: true,
      records: new Map([
        [
          "proj-epic",
          {
            id: "proj-epic",
            title: "Parent",
            issueType: "epic",
            parentIds: [],
          },
        ],
      ]),
      note: "readable but missing child",
    });
    startRefresh(monitor);
    persist.mockClear();
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.ledger.tasks).toEqual(original);
    expect(persist).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("does not append checkpoint on unchanged or unavailable enrichment refresh", async () => {
    const { monitor, persist } = fixture();
    monitor.conversation.proposals = [];
    startRefresh(monitor);
    persist.mockClear();
    await vi.advanceTimersByTimeAsync(0);
    const reads = vi.mocked(readBeadsExport).mock.calls.length;
    await vi.advanceTimersByTimeAsync(45_000);
    expect(vi.mocked(readBeadsExport)).toHaveBeenCalledTimes(reads);
    expect(persist).not.toHaveBeenCalled();
    monitor.stop();
  });
  it("admits a valid scope result after lifecycle-driven unavailable Beads refresh", async () => {
    const { monitor, jobs } = fixture();
    const readsBefore = vi.mocked(readBeadsExport).mock.calls.length;
    startRefresh(monitor);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(readBeadsExport).mock.calls.length).toBeGreaterThan(
      readsBefore,
    );
    const pending = jobs[0];
    if (!pending) throw new Error("Scope request not scheduled");
    respond(pending);
    expect(monitor.ledger?.tasks.map((task) => task.text)).toEqual([
      "Implement parser",
      "Improve help",
    ]);
    expect(monitor.ledger?.currentTaskId).toBe(monitor.ledger?.tasks[1]?.id);
    monitor.stop();
  });

  it("preserves fresh display metadata while admitting semantically unchanged work", () => {
    const { monitor, jobs } = fixture();
    monitor.scheduleAnalysis();
    const pending = jobs[0];
    if (!pending || !monitor.ledger) throw new Error("Missing scope work");
    const beads = { id: "proj-123", title: "Fresh export", conflict: false };
    monitor.ledger = {
      ...monitor.ledger,
      tasks: monitor.ledger.tasks.map((task) => ({ ...task, beads })),
    };
    respond(pending);
    expect(monitor.ledger.tasks).toHaveLength(2);
    expect(monitor.ledger.tasks[0]?.beads).toEqual(beads);
    monitor.stop();
  });

  it("rejects an answer from a previous lifecycle generation", () => {
    const { monitor, jobs } = fixture();
    monitor.scheduleAnalysis();
    const pending = jobs[0];
    if (!pending) throw new Error("Missing scope work");
    monitor.epoch++;
    respond(pending);
    expect(monitor.ledger?.tasks).toHaveLength(1);
    monitor.stop();
  });

  it("rejects an answer when task state changes during evaluation", () => {
    const { monitor, jobs } = fixture();
    monitor.scheduleAnalysis();
    const pending = jobs[0];
    if (!pending || !monitor.ledger) throw new Error("Missing scope work");
    monitor.ledger = {
      ...monitor.ledger,
      tasks: monitor.ledger.tasks.map((task) => ({ ...task, status: "done" })),
    };
    respond(pending);
    expect(monitor.ledger.tasks).toHaveLength(1);
    expect(monitor.ledger.tasks[0]?.status).toBe("done");
    monitor.stop();
  });

  it("rejects an answer after a genuine scope revision change", () => {
    const { monitor, jobs } = fixture();
    monitor.scheduleAnalysis();
    const pending = jobs[0];
    if (!pending || !monitor.ledger) throw new Error("Missing scope work");
    monitor.ledger = { ...monitor.ledger, scopeRevision: "changed:2" };
    respond(pending);
    expect(monitor.ledger.tasks).toHaveLength(1);
    expect(monitor.ledger.scopeRevision).toBe("changed:2");
    monitor.stop();
  });
});
