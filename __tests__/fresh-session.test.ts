import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EvaluationRequest,
  ValidatedResult,
} from "../src/analysis/gateway";
import { countReported } from "../src/core/ledger";
import { type Checkpoint, Monitor } from "../src/core/monitor";
import { replayEntries } from "./fixtures/live-session";
import { renderWidget } from "./fixtures/render-widget";

interface TestState {
  candidates?: {
    id?: string;
    entryId?: string;
    text: string;
    ref?: { entryId?: string };
  }[];
  candidate?: { entryId: string };
  spans?: { id: string; kind: string }[];
  goal?: { id: string; text: string }[];
  tasks?: { id: string; text: string }[];
  observation?: { id: string };
  report?: { id: string };
}

/** Scripted fixture verdicts test controller composition, NOT Jev accuracy. */
function verdict(request: EvaluationRequest): ValidatedResult {
  const state = request.state as TestState;
  const answers = Object.fromEntries(
    Object.entries(request.questions).map(([id, question]) => {
      const keys = Object.keys(question.criteria);
      if (question.type === "score")
        return [
          id,
          {
            type: "score",
            score: 0,
            confidence: 1,
            legend: Object.fromEntries(
              question.criteria.map((label, i) => [String(i), label]),
            ),
            probabilities: Object.fromEntries(
              keys.map((key) => [key, key === "0" ? 1 : 0]),
            ),
          },
        ];
      let choice: string;
      if (id === "source") {
        const candidate = state.candidates?.[0];
        choice =
          candidate &&
          [
            "old-goal",
            "29acae97",
            "revision",
            "replacement",
            "assistant-plan",
          ].includes(candidate.entryId ?? "")
            ? (candidate.id ?? "none")
            : "none";
      } else if (state.spans) {
        const span = state.spans.find((span) => span.id === id);
        choice =
          span?.kind === "heading" ||
          (state.candidate?.entryId === "29acae97" && span?.kind !== "list")
            ? "context"
            : "task";
      } else if (state.goal && state.candidates) {
        const entry = state.candidates[0]?.ref?.entryId;
        const first = state.goal[0];
        if (id === "scope")
          choice =
            entry === "29acae97" || entry === "replacement"
              ? "new-goal"
              : "continue";
        else if (id === "current") choice = "unknown";
        else if (id.startsWith("status:")) choice = "not-a-report";
        else
          choice =
            entry === "revision" && first ? `revised:${first.id}` : "new";
      } else if (state.observation || state.report) {
        const entry = (state.observation ?? state.report)?.id;
        const task = state.tasks?.find((task) => task.id === id);
        const first = state.tasks?.[0];
        if (id === "__current")
          choice = entry === "working" && first ? first.id : "unknown";
        else if (
          entry === "old-done" ||
          entry === "2fd7cc52" ||
          entry === "new-done"
        )
          choice = "done";
        else if (entry === "working" && task?.id === first?.id)
          choice = "in-progress";
        else if (entry === "reopen" && task?.id === first?.id)
          choice = "reopened";
        else if (entry === "cancel" && task?.id !== first?.id)
          choice = "cancelled";
        else choice = "not-a-report";
      } else
        choice = keys.includes("unknown")
          ? "unknown"
          : keys.includes("not-a-report")
            ? "not-a-report"
            : (keys[0] ?? "");
      if (!keys.includes(choice))
        throw new Error(`Fixture answer ${choice} missing from ${id}`);
      return [
        id,
        {
          type: "choice",
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(
            keys.map((key) => [key, key === choice ? 1 : 0]),
          ),
        },
      ];
    }),
  );
  return {
    model: request.model,
    answers,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as ValidatedResult;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type Entry = {
  type: string;
  id: string;
  parentId: string | null;
  message: { role: "user" | "assistant"; content: string };
};

function runtime(initial: Entry[] = replayEntries(4), respond = verdict) {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline-fixture-key");
  const requests: EvaluationRequest[] = [];
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as EvaluationRequest;
    requests.push(request);
    return new Response(JSON.stringify(respond(request)), { status: 200 });
  });
  vi.stubGlobal("fetch", fetch);
  let entries = initial;
  const checkpoints: Checkpoint[] = [];
  const monitor = new Monitor(vi.fn(), (checkpoint) =>
    checkpoints.push(structuredClone(checkpoint)),
  );
  monitor.observe(() => entries);
  monitor.turnOn("/nonexistent-offline-fixture");
  const settle = async (id: string) => {
    for (let i = 0; i < 1500; i++) {
      monitor.scheduleAnalysis();
      await vi.advanceTimersByTimeAsync(1);
      if (monitor.conversation.cursor?.id === id) return;
    }
    throw new Error(
      `Replay stuck: target=${id}, cursor=${monitor.conversation.cursor?.id}; ${monitor.conversation.discoveryStatus}; ${monitor.conversation.reportStatus}; ${monitor.gateway.status}`,
    );
  };
  const append = (id: string, text: string, role = "user") => {
    entries = [
      ...entries,
      {
        type: "message",
        id,
        parentId: entries.at(-1)?.id ?? null,
        message: { role: role as "user" | "assistant", content: text },
      },
    ];
  };
  return {
    monitor,
    checkpoints,
    requests,
    fetch,
    settle,
    append,
    replace: (next: typeof initial) => {
      entries = next;
    },
  };
}

describe("fresh-session ordered production controller", () => {
  it("replaces historical scope, tracks current work, completes, reopens and cancels without rebilling unchanged history", async () => {
    const r = runtime([]);
    try {
      for (let length = 1; length <= 4; length++) {
        const prefix = replayEntries(length);
        r.replace(prefix);
        await r.settle(prefix.at(-1)?.id ?? "missing");
      }
      const active = () =>
        r.monitor.ledger?.tasks.filter((task) => task.included) ?? [];
      expect(active()).toHaveLength(2);
      expect(
        active()
          .map((task) => task.text)
          .join("\n"),
      ).not.toContain("First lock scope");
      expect(
        r.monitor.ledger?.tasks.some(
          (task) => !task.included && task.status === "done",
        ),
      ).toBe(true);
      const oldReport = r.requests.find(
        (request) =>
          (request.state as TestState).observation?.id === "old-done",
      );
      expect((oldReport?.state as TestState | undefined)?.tasks).toHaveLength(
        1,
      );
      const ids = active().map((task) => task.id);
      expect(ids.every((id) => id.includes(":task:"))).toBe(true);
      r.replace(replayEntries(5));
      await r.settle("working");
      expect(r.monitor.ledger?.currentTaskId).toBe(ids[0]);
      expect(active()[0]?.status).toBe("in-progress");
      r.replace(replayEntries());
      await r.settle("2fd7cc52");
      expect(countReported(r.monitor.ledger)).toMatchObject({
        done: 2,
        total: 2,
        percent: 100,
      });
      expect(active().map((task) => task.id)).toEqual(ids);
      r.append(
        "reopen",
        "Reopen the default interval task: it needs another correction.",
      );
      await r.settle("reopen");
      expect(active()[0]?.status).toBe("reopened");
      expect(countReported(r.monitor.ledger)).toMatchObject({
        done: 1,
        total: 2,
      });
      r.append(
        "cancel",
        "Cancel the help task; do not count it as completion.",
      );
      await r.settle("cancel");
      expect(active()[1]?.status).toBe("cancelled");
      expect(countReported(r.monitor.ledger)).toMatchObject({
        done: 0,
        total: 1,
      });
      // Let last scheduled health result settle before measuring no new evidence.
      for (let i = 0; i < 10; i++) {
        r.monitor.scheduleAnalysis();
        await vi.advanceTimersByTimeAsync(1);
      }
      const count = r.fetch.mock.calls.length;
      for (let i = 0; i < 10; i++) {
        r.monitor.scheduleAnalysis();
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(r.fetch).toHaveBeenCalledTimes(count);
    } finally {
      r.monitor.stop();
    }
  });

  it("does not let an ambiguous first source permanently block a later clear user plan", async () => {
    const r = runtime(replayEntries(4), (request) => {
      const result = verdict(request);
      const state = request.state as TestState;
      if (
        request.questions.source &&
        state.candidates?.[0]?.entryId === "old-goal"
      ) {
        const question = request.questions.source;
        result.answers.source = {
          type: "choice",
          choice: "none",
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(question.criteria).map((key) => [
              key,
              key === "none" ? 1 : 0,
            ]),
          ),
        };
      }
      if (
        request.questions.source &&
        state.candidates?.[0]?.entryId === "55f2ddf0"
      ) {
        const id = state.candidates[0].id ?? "missing";
        result.answers.source = {
          type: "choice",
          choice: id,
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(request.questions.source.criteria).map((key) => [
              key,
              key === id ? 1 : 0,
            ]),
          ),
        };
      }
      if (state.candidate?.entryId === "55f2ddf0") {
        for (const [id, question] of Object.entries(request.questions))
          result.answers[id] = {
            type: "choice",
            choice: "ambiguous",
            confidence: 1,
            probabilities: Object.fromEntries(
              Object.keys(question.criteria).map((key) => [
                key,
                key === "ambiguous" ? 1 : 0,
              ]),
            ),
          };
      }
      return result;
    });
    try {
      await r.settle("29acae97");
      expect(countReported(r.monitor.ledger)).toMatchObject({
        done: 0,
        total: 2,
      });
      expect(
        r.monitor.ledger?.tasks.map((task) => task.text).join("\n"),
      ).not.toContain("First lock scope");
    } finally {
      r.monitor.stop();
    }
  });

  it("discloses ambiguous scope but can follow a later clear replacement goal", async () => {
    const r = runtime(replayEntries(4), (request) => {
      const result = verdict(request);
      const state = request.state as TestState;
      if (
        request.questions.scope &&
        state.candidates?.[0]?.ref?.entryId === "29acae97"
      ) {
        result.answers.scope = {
          type: "choice",
          choice: "ambiguous",
          confidence: 1,
          probabilities: { continue: 0, "new-goal": 0, ambiguous: 1 },
        };
      }
      return result;
    });
    try {
      for (let i = 0; i < 50; i++) {
        r.monitor.scheduleAnalysis();
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(r.monitor.progressState()).toMatch(
        /uncertain|unknown|unresolved/i,
      );
      expect(renderWidget(r.monitor)[0]).toMatch(
        /unresolved|historical|last settled|unknown/i,
      );
      expect(r.monitor.ledger?.currentTaskId).toBeUndefined();
      r.append(
        "replacement",
        "1. Implement an unrelated CSV export feature instead of all previous goals.",
      );
      await r.settle("replacement");
      expect(countReported(r.monitor.ledger)).toMatchObject({
        done: 0,
        total: 1,
      });
      expect(
        r.monitor.ledger?.tasks.filter((task) => task.included)[0]?.text,
      ).toContain("CSV export");
    } finally {
      r.monitor.stop();
    }
  });

  it("restores between scope commit and report commit without repeating paid scope work", async () => {
    const r = runtime(replayEntries(4));
    try {
      await r.settle("29acae97");
      const checkpoint = r.checkpoints.find(
        (cp) =>
          cp.conversation?.cursor?.id === "old-done" &&
          cp.tasks.some(
            (task) => task.included && task.ref.entryId === "29acae97",
          ),
      );
      expect(checkpoint).toBeDefined();
      const before = r.requests.length;
      await r.monitor.restore("/nonexistent-offline-fixture", checkpoint);
      await r.settle("29acae97");
      expect(countReported(r.monitor.ledger)).toMatchObject({
        done: 0,
        total: 2,
      });
      expect(
        r.requests
          .slice(before)
          .filter(
            (request) => request.questions.source || request.questions.scope,
          ),
      ).toHaveLength(0);
    } finally {
      r.monitor.stop();
    }
  });

  it("does not lose queued goal changes when restoring across a 512-entry discovery window", async () => {
    const entries: Entry[] = [
      {
        type: "message",
        id: "old-goal",
        parentId: null,
        message: {
          role: "user",
          content: Array.from(
            { length: 24 },
            (_, i) => `${i + 1}. Initial task ${i + 1}`,
          ).join("\n"),
        },
      },
    ];
    for (let i = 1; i <= 520; i++) {
      const goal = replayEntries(4)[3];
      const item: Entry =
        i === 490 && goal
          ? { ...goal, parentId: entries.at(-1)?.id ?? null }
          : {
              type: "message",
              id: `noise-${i}`,
              parentId: entries.at(-1)?.id ?? null,
              message: {
                role: "assistant",
                content: "An unrelated explanatory note.",
              },
            };
      entries.push(item);
    }
    const final = replayEntries().at(-1);
    if (!final) throw new Error("Missing final report");
    entries.push({ ...final, parentId: entries.at(-1)?.id ?? null });
    const r = runtime(entries);
    try {
      await r.settle("2fd7cc52");
      expect(countReported(r.monitor.ledger)).toMatchObject({
        done: 2,
        total: 2,
      });
      const checkpoint = r.checkpoints.find(
        (cp) =>
          cp.conversation?.discoveryCursor &&
          cp.conversation.cursor?.id.startsWith("noise-") &&
          cp.tasks.filter((task) => task.included).length === 24,
      );
      expect(checkpoint).toBeDefined();
      await r.monitor.restore("/nonexistent-offline-fixture", checkpoint);
      await r.settle("2fd7cc52");
      expect(countReported(r.monitor.ledger)).toMatchObject({
        done: 2,
        total: 2,
      });
      expect(
        r.monitor.ledger?.tasks
          .filter((task) => task.included)
          .every((task) => task.ref.entryId === "29acae97"),
      ).toBe(true);
    } finally {
      r.monitor.stop();
    }
  }, 20_000);

  it("restores an evolved checkpoint without rediscovering paid history or duplicating tasks", async () => {
    const r = runtime(replayEntries());
    try {
      await r.settle("2fd7cc52");
      for (let i = 0; i < 10; i++) {
        r.monitor.scheduleAnalysis();
        await vi.advanceTimersByTimeAsync(1);
      }
      const checkpoint = r.monitor.checkpoint();
      const ids = r.monitor.ledger?.tasks.map((task) => task.id);
      const before = r.fetch.mock.calls.length;
      await r.monitor.restore("/nonexistent-offline-fixture", checkpoint);
      for (let i = 0; i < 20; i++) {
        r.monitor.scheduleAnalysis();
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(r.monitor.error).toBeUndefined();
      expect(countReported(r.monitor.ledger)).toMatchObject({
        done: 2,
        total: 2,
      });
      expect(r.monitor.ledger?.tasks.map((task) => task.id)).toEqual(ids);
      expect(r.fetch).toHaveBeenCalledTimes(before);
      r.append("reopen", "The interval task needs reopening.");
      await r.settle("reopen");
      expect(countReported(r.monitor.ledger)).toMatchObject({
        done: 1,
        total: 2,
      });
    } finally {
      r.monitor.stop();
    }
  });

  it("invalidates completion for revised requirements and archives a replaced goal", async () => {
    const r = runtime(replayEntries());
    try {
      await r.settle("2fd7cc52");
      expect(countReported(r.monitor.ledger)).toMatchObject({
        done: 2,
        total: 2,
      });
      const firstId = r.monitor.ledger?.tasks.find((task) => task.included)?.id;
      r.append(
        "revision",
        "1. Change the default progress interval to 30 seconds and preserve saved settings.",
      );
      await r.settle("revision");
      const revised = r.monitor.ledger?.tasks.find(
        (task) => task.id === firstId,
      );
      expect(revised).toMatchObject({ status: "not-started", included: true });
      expect(revised?.text).toContain("30 seconds");
      expect(countReported(r.monitor.ledger)).toMatchObject({
        done: 1,
        total: 2,
      });
      r.append(
        "replacement",
        "1. Implement an unrelated CSV export feature instead of the previous goal.",
      );
      await r.settle("replacement");
      expect(countReported(r.monitor.ledger)).toMatchObject({
        done: 0,
        total: 1,
      });
      expect(
        r.monitor.ledger?.tasks.find((task) => task.id === firstId)?.included,
      ).toBe(false);
      r.append("new-done", "The CSV export feature is complete.", "assistant");
      await r.settle("new-done");
      expect(countReported(r.monitor.ledger)).toMatchObject({
        done: 1,
        total: 1,
      });
    } finally {
      r.monitor.stop();
    }
  });

  it("interprets completion in the initial selected observation, not just later messages", async () => {
    const r = runtime(
      [
        {
          type: "message",
          id: "old-goal",
          parentId: null,
          message: {
            role: "user",
            content: "1. Implement parser (this task is already complete).",
          },
        },
      ],
      (request) => {
        const result = verdict(request);
        if ((request.state as TestState).observation?.id === "old-goal") {
          for (const [id, question] of Object.entries(request.questions)) {
            if (id !== "__current")
              result.answers[id] = {
                type: "choice",
                choice: "done",
                confidence: 1,
                probabilities: Object.fromEntries(
                  Object.keys(question.criteria).map((key) => [
                    key,
                    key === "done" ? 1 : 0,
                  ]),
                ),
              };
          }
        }
        return result;
      },
    );
    try {
      await r.settle("old-goal");
      expect(countReported(r.monitor.ledger)).toMatchObject({
        done: 1,
        total: 1,
      });
      expect(r.monitor.ledger?.reportOrder).toBe(1);
    } finally {
      r.monitor.stop();
    }
  });

  it("admits legitimate assistant-authored plans and preserves exact original references", async () => {
    const entries = [
      {
        type: "message",
        id: "request",
        parentId: null,
        message: {
          role: "user" as const,
          content: "Please plan and implement parser and help improvements.",
        },
      },
      {
        type: "message",
        id: "assistant-plan",
        parentId: "request",
        message: {
          role: "assistant" as const,
          content: "1. Implement parser\n2. Improve help",
        },
      },
    ];
    const r = runtime(entries);
    try {
      await r.settle("assistant-plan");
      expect(r.monitor.ledger?.tasks.map((task) => task.text)).toEqual([
        "Implement parser",
        "Improve help",
      ]);
      expect(
        r.monitor.ledger?.tasks.every(
          (task) => task.ref.provenance === "assistant",
        ),
      ).toBe(true);
      expect(r.monitor.ledger?.currentTaskId).toBeUndefined();
    } finally {
      r.monitor.stop();
    }
  });
});
