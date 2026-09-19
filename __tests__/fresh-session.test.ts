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

function beyondWindow(entries: Entry[], enabled: boolean): Entry[] {
  if (!enabled) return entries;
  const first = entries[0];
  if (!first) throw new Error("Missing initial entry");
  const result = [first];
  for (let i = 0; i < 520; i++)
    result.push({
      type: "message",
      id: `padding-${i}`,
      parentId: result.at(-1)?.id ?? null,
      message: { role: "assistant", content: "An unrelated explanatory note." },
    });
  for (const entry of entries.slice(1))
    result.push({ ...entry, parentId: result.at(-1)?.id ?? null });
  return result;
}

function runtime(
  initial: Entry[] = replayEntries(4),
  respond: (
    request: EvaluationRequest,
  ) => ValidatedResult | Promise<ValidatedResult> = verdict,
  paced = false,
) {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline-fixture-key");
  const requests: EvaluationRequest[] = [];
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as EvaluationRequest;
    requests.push(request);
    if (paced) await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify(await respond(request)), {
      status: 200,
    });
  });
  vi.stubGlobal("fetch", fetch);
  let entries = initial;
  const checkpoints: Checkpoint[] = [];
  const saveRequestCounts: number[] = [];
  const monitor = new Monitor(vi.fn(), (checkpoint) => {
    checkpoints.push(structuredClone(checkpoint));
    saveRequestCounts.push(requests.length);
  });
  monitor.observe(() => entries);
  monitor.turnOn("/nonexistent-offline-fixture");
  const observe = () => monitor.observe(() => entries);
  const settle = async (id: string) => {
    observe();
    for (let i = 0; i < 1500; i++) {
      await vi.advanceTimersByTimeAsync(1);
      if (monitor.conversation.cursor?.id === id) return;
    }
    throw new Error(
      `Replay stuck: target=${id}, cursor=${monitor.conversation.cursor?.id}; ${monitor.conversation.discoveryStatus}; ${monitor.conversation.reportStatus}; ${monitor.gateway.status}; ${JSON.stringify(monitor.diagnostics())}`,
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
    saveRequestCounts,
    requests,
    fetch,
    settle,
    observe,
    append,
    replace: (next: typeof initial) => {
      entries = next;
    },
  };
}

describe("fresh-session ordered production controller", () => {
  it.each(["assistant", "overflow-user"])(
    "preserves post-boundary %s work arriving during fresh scope evaluation",
    async (kind) => {
      let release: (() => void) | undefined;
      const r = runtime(
        replayEntries(1),
        (request) => {
          const result = verdict(request);
          if (
            request.questions.scope &&
            (request.state as TestState).candidates?.[0]?.ref?.entryId ===
              "replacement"
          )
            return new Promise((resolve) => {
              release = () => resolve(result);
            });
          return result;
        },
        true,
      );
      try {
        await r.settle("old-goal");
        r.append(
          "replacement",
          "1. Implement the new requested parser instead.",
        );
        r.observe();
        await vi.advanceTimersByTimeAsync(100);
        expect(release).toBeDefined();
        if (kind === "overflow-user")
          for (let i = 0; i < 519; i++)
            r.append(`overflow-${i}`, "Thanks for that clarification.");
        r.append(
          "assistant-plan",
          "1. Add Unicode regression tests",
          kind === "assistant" ? "assistant" : "user",
        );
        r.observe();
        release?.();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(
          r.requests.some(
            (request) =>
              request.questions.source &&
              (request.state as TestState).candidates?.[0]?.entryId ===
                "assistant-plan",
          ),
        ).toBe(true);
        expect(
          r.monitor.ledger?.tasks.some(
            (task) => task.included && task.ref.entryId === "assistant-plan",
          ),
        ).toBe(true);
      } finally {
        release?.();
        r.monitor.stop();
      }
    },
  );

  it.each(["continue", "ambiguous", "low-confidence", "multi-chunk"])(
    "does not initialize a no-ledger fresh %s proposal ahead of unsettled history",
    async (outcome) => {
      const history: Entry[] = Array.from({ length: 40 }, (_, i) => ({
        type: "message",
        id: `veto-history-${i}`,
        parentId: i ? `veto-history-${i - 1}` : null,
        message: {
          role: "assistant",
          content: "An unrelated explanatory note.",
        },
      }));
      const r = runtime(
        history,
        (request) => {
          const result = verdict(request);
          if (request.questions.scope && outcome !== "multi-chunk") {
            const choice = outcome === "low-confidence" ? "new-goal" : outcome;
            result.answers.scope = {
              type: "choice",
              choice,
              confidence: outcome === "low-confidence" ? 0.4 : 1,
              probabilities: Object.fromEntries(
                Object.keys(request.questions.scope.criteria).map((key) => [
                  key,
                  key === choice ? 1 : 0,
                ]),
              ),
            };
          }
          return result;
        },
        true,
      );
      try {
        await vi.advanceTimersByTimeAsync(1);
        r.append(
          "replacement",
          outcome === "multi-chunk"
            ? Array.from(
                { length: 27 },
                (_, i) => `${i + 1}. Implement new feature ${i + 1}`,
              ).join("\n")
            : "1. Read the advisory plan instead.",
        );
        r.observe();
        await vi.advanceTimersByTimeAsync(100);
        expect(
          r.requests.some(
            (request) =>
              (request.state as TestState).candidate?.entryId === "replacement",
          ),
        ).toBe(true);
        expect(r.monitor.ledger).toBeUndefined();
        expect(
          r.checkpoints.at(-1)?.conversation?.discoveryCursor?.id,
        ).not.toBe("replacement");
        await vi.advanceTimersByTimeAsync(2000);
        expect(r.monitor.conversation.hasPendingDiscovery()).toBe(false);
        if (outcome === "continue" || outcome === "multi-chunk")
          expect(
            r.monitor.ledger?.tasks.some(
              (task) => task.included && task.ref.entryId === "replacement",
            ),
          ).toBe(true);
      } finally {
        r.monitor.stop();
      }
    },
  );

  it("preserves accepted scope chunks across OFF/ON without rebilling them", async () => {
    let release: (() => void) | undefined;
    let hold = true;
    let firstScope: string | undefined;
    const r = runtime(replayEntries(1), (request) => {
      const result = verdict(request);
      if (request.questions.scope) {
        if (Object.hasOwn(request.questions, "0"))
          firstScope ??= JSON.stringify(request);
        else if (hold)
          return new Promise((resolve) => {
            release = () => resolve(result);
          });
      }
      return result;
    });
    try {
      await r.settle("old-goal");
      r.append(
        "29acae97",
        Array.from(
          { length: 27 },
          (_, i) => `${i + 1}. New task ${i + 1}`,
        ).join("\n"),
      );
      r.observe();
      await vi.advanceTimersByTimeAsync(100);
      expect(release).toBeDefined();
      expect(r.monitor.checkpoint().partialScope?.index).toBe(1);
      r.monitor.turnOff();
      expect.soft(r.checkpoints.at(-1)?.partialScope?.index).toBe(1);
      hold = false;
      release?.();
      r.monitor.turnOn("/nonexistent-offline-fixture");
      await vi.advanceTimersByTimeAsync(1000);
      expect(
        r.requests.filter((request) => JSON.stringify(request) === firstScope),
      ).toHaveLength(1);
      expect(countReported(r.monitor.ledger).total).toBe(27);
    } finally {
      release?.();
      r.monitor.stop();
    }
  });

  it("bounds fresh-intake payload reads after a long-session baseline", async () => {
    let reads = 0;
    const history: Entry[] = Array.from({ length: 10_000 }, (_, i) => ({
      type: "message",
      id: `bounded-history-${i}`,
      parentId: i ? `bounded-history-${i - 1}` : null,
      get message() {
        reads++;
        return {
          role: "user" as const,
          content: "An unrelated explanatory note.",
        };
      },
    }));
    const r = runtime(history, () => new Promise(() => {}));
    try {
      await vi.advanceTimersByTimeAsync(0);
      reads = 0;
      r.append("replacement", "1. Read the new plan instead.");
      r.observe();
      expect(reads).toBeLessThan(4096);
      reads = 0;
      r.observe();
      expect(reads).toBeLessThan(4096);
    } finally {
      r.monitor.stop();
    }
  });
  it("retains later actionable burst turns across the first early cutover", async () => {
    const r = runtime(replayEntries(1), verdict, true);
    try {
      await r.settle("old-goal");
      for (let i = 0; i < 40; i++)
        r.append(
          `burst-history-${i}`,
          "An unrelated explanatory note.",
          "assistant",
        );
      r.append(
        "replacement",
        "1. Read the advisory plan instead of earlier work.",
      );
      r.append("29acae97", "1. Implement the new requested parser instead.");
      r.observe();
      await vi.advanceTimersByTimeAsync(1500);
      expect(
        r.checkpoints.some((cp) =>
          cp.tasks.some(
            (task) => task.included && task.ref.entryId === "replacement",
          ),
        ),
      ).toBe(true);
      expect(
        r.monitor.ledger?.tasks
          .filter((task) => task.included)
          .map((task) => task.ref.entryId),
      ).toEqual(["29acae97"]);
      const selected = r.requests
        .filter((request) => request.questions.source)
        .flatMap(
          (request) =>
            (request.state as TestState).candidates?.map(
              (candidate) => candidate.entryId,
            ) ?? [],
        );
      expect(selected.filter((id) => id === "replacement")).toHaveLength(1);
      expect(selected.filter((id) => id === "29acae97")).toHaveLength(1);
    } finally {
      r.monitor.stop();
    }
  });
  it("admits a fresh explicitly replacing goal without an established ledger", async () => {
    const history: Entry[] = Array.from({ length: 40 }, (_, i) => ({
      type: "message",
      id: `no-ledger-${i}`,
      parentId: i ? `no-ledger-${i - 1}` : null,
      message: { role: "assistant", content: "An unrelated explanatory note." },
    }));
    const r = runtime(history, verdict, true);
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(r.monitor.ledger).toBeUndefined();
      r.append(
        "replacement",
        "Read the advisory plan instead of all earlier work.",
      );
      const before = r.requests.length;
      r.observe();
      await vi.advanceTimersByTimeAsync(100);
      expect(
        r.requests
          .slice(before, before + 3)
          .some(
            (request) =>
              request.questions.source &&
              (request.state as TestState).candidates?.[0]?.entryId ===
                "replacement",
          ),
      ).toBe(true);
      expect(
        r.monitor.ledger?.tasks
          .filter((task) => task.included)
          .map((task) => task.ref.entryId),
      ).toEqual(["replacement"]);
      expect(
        r.monitor.ledger?.tasks.some((task) => task.status === "done"),
      ).toBe(false);
      expect(r.requests.some((request) => request.questions.scope)).toBe(true);
    } finally {
      r.monitor.stop();
    }
  });

  it("does not jump history for a fresh scope requiring multiple chunks", async () => {
    const r = runtime(replayEntries(1), verdict, true);
    try {
      await r.settle("old-goal");
      for (let i = 0; i < 40; i++)
        r.append(
          `multi-history-${i}`,
          "An unrelated explanatory note.",
          "assistant",
        );
      r.append(
        "replacement",
        Array.from(
          { length: 27 },
          (_, i) => `${i + 1}. Implement new feature ${i + 1}`,
        ).join("\n"),
      );
      r.observe();
      await vi.advanceTimersByTimeAsync(180);
      expect(
        r.requests.some(
          (request) =>
            (request.state as TestState).candidate?.entryId === "replacement",
        ),
      ).toBe(true);
      expect(
        r.monitor.ledger?.tasks
          .filter((task) => task.included)
          .map((task) => task.ref.entryId),
      ).toEqual(["old-goal"]);
      expect(r.checkpoints.at(-1)?.conversation?.discoveryCursor?.id).not.toBe(
        "replacement",
      );
    } finally {
      r.monitor.stop();
    }
  });
  it.each([40, 520])(
    "admits a Jev-confirmed fresh replacement without replaying %i older messages first",
    async (padding) => {
      const r = runtime(replayEntries(1), verdict, true);
      try {
        await r.settle("old-goal");
        for (let i = 0; i < padding; i++)
          r.append(
            `qa-backlog-${i}`,
            "An unrelated explanatory note.",
            "assistant",
          );
        r.append(
          "old-done",
          "The planned progress monitor implementation is complete.",
          "assistant",
        );
        r.append(
          "replacement",
          "Read the advisory plan and supporting documents instead.",
        );
        const before = r.requests.length;
        r.observe();
        // Three semantic stages, each serviced within three dispatch opportunities.
        // Fake transport pacing prevents full history draining before inspection.
        await vi.advanceTimersByTimeAsync(100);
        const selection = r.requests
          .slice(before, before + 3)
          .some(
            (request) =>
              request.questions.source &&
              (request.state as TestState).candidates?.[0]?.entryId ===
                "replacement",
          );
        expect(selection).toBe(true);
        const active =
          r.monitor.ledger?.tasks.filter((task) => task.included) ?? [];
        expect(active).toHaveLength(1);
        expect(active[0]?.ref.entryId).toBe("replacement");
        expect(active[0]?.status).not.toBe("done");
        expect(r.monitor.scopeIsUnresolved()).toBe(false);
        // Catch-up cannot let older scope or its completion overwrite newer work.
        await r.settle("replacement");
        const after =
          r.monitor.ledger?.tasks.filter((task) => task.included) ?? [];
        expect(after.map((task) => task.ref.entryId)).toEqual(["replacement"]);
        expect(after[0]?.status).not.toBe("done");
        const checkpoint = r.checkpoints.at(-1);
        expect(checkpoint).toBeDefined();
        await r.monitor.restore("/nonexistent-offline-fixture", checkpoint);
        await r.settle("replacement");
        expect(
          r.monitor.ledger?.tasks
            .filter((task) => task.included)
            .map((task) => task.ref.entryId),
        ).toEqual(["replacement"]);
        expect(r.monitor.scopeIsUnresolved()).toBe(false);
      } finally {
        r.monitor.stop();
      }
    },
  );
  it("considers every burst user while historical work receives bounded dispatch opportunities", async () => {
    const r = runtime(replayEntries(1), verdict, true);
    try {
      await r.settle("old-goal");
      for (let i = 0; i < 40; i++)
        r.append(
          `qa-fair-history-${i}`,
          "An unrelated explanatory note.",
          "assistant",
        );
      const ids = Array.from({ length: 5 }, (_, i) => `qa-burst-${i}`);
      for (const id of ids) r.append(id, "Thanks for that clarification.");
      const before = r.requests.length;
      r.observe();
      await vi.advanceTimersByTimeAsync(160);
      const selectionIds = r.requests
        .slice(before)
        .filter((request) => request.questions.source)
        .flatMap(
          (request) =>
            (request.state as TestState).candidates?.map(
              (candidate) => candidate.entryId,
            ) ?? [],
        );
      expect(selectionIds.filter((id) => ids.includes(id ?? ""))).toEqual(ids);
      expect(selectionIds.slice(0, 3)).toContain(ids[0]);
      expect(
        selectionIds
          .slice(0, 3)
          .some((id) => id?.startsWith("qa-fair-history-")),
      ).toBe(true);
      expect(
        selectionIds.some((id) => id?.startsWith("qa-fair-history-")),
      ).toBe(true);
      expect(
        r.monitor.ledger?.tasks
          .filter((task) => task.included)
          .map((task) => task.ref.entryId),
      ).toEqual(["old-goal"]);
    } finally {
      r.monitor.stop();
    }
  });

  it.each(["continue", "ambiguous", "low-confidence", "same", "revised"])(
    "does not cut over history on a fresh %s scope result",
    async (outcome) => {
      const r = runtime(
        replayEntries(1),
        (request) => {
          const result = verdict(request);
          if (
            request.questions.scope &&
            (request.state as TestState).candidates?.[0]?.ref?.entryId ===
              "replacement"
          ) {
            const choice = ["low-confidence", "same", "revised"].includes(
              outcome,
            )
              ? "new-goal"
              : outcome;
            if (outcome === "same" || outcome === "revised") {
              const taskId = (request.state as TestState).goal?.[0]?.id;
              for (const [id, question] of Object.entries(request.questions)) {
                const relation = `${outcome}:${taskId}`;
                if (Object.hasOwn(question.criteria, relation))
                  result.answers[id] = {
                    type: "choice",
                    choice: relation,
                    confidence: 1,
                    probabilities: Object.fromEntries(
                      Object.keys(question.criteria).map((key) => [
                        key,
                        key === relation ? 1 : 0,
                      ]),
                    ),
                  };
              }
            }
            result.answers.scope = {
              type: "choice",
              choice,
              confidence: outcome === "low-confidence" ? 0.4 : 1,
              probabilities:
                outcome === "low-confidence"
                  ? { "new-goal": 0.79, continue: 0.21, ambiguous: 0 }
                  : Object.fromEntries(
                      Object.keys(request.questions.scope.criteria).map(
                        (key) => [key, key === choice ? 1 : 0],
                      ),
                    ),
            };
          }
          return result;
        },
        true,
      );
      try {
        await r.settle("old-goal");
        for (let i = 0; i < 40; i++)
          r.append(
            `qa-guard-history-${i}`,
            "An unrelated explanatory note.",
            "assistant",
          );
        r.append(
          "replacement",
          "Read the advisory plan and supporting documents instead.",
        );
        r.observe();
        await vi.advanceTimersByTimeAsync(100);
        expect(
          r.requests.some(
            (request) =>
              request.questions.scope &&
              (request.state as TestState).candidates?.[0]?.ref?.entryId ===
                "replacement",
          ),
        ).toBe(true);
        expect(
          r.monitor.ledger?.tasks
            .filter((task) => task.included)
            .map((task) => task.ref.entryId),
        ).toEqual(["old-goal"]);
        expect(r.monitor.conversation.cursor?.id).not.toBe("replacement");
        expect(
          r.checkpoints.at(-1)?.conversation?.discoveryCursor?.id,
        ).not.toBe("replacement");
      } finally {
        r.monitor.stop();
      }
    },
  );

  it("discards an in-flight fresh cutover when monitoring turns off", async () => {
    const deferred: { release?: () => void } = {};
    const r = runtime(
      replayEntries(1),
      (request) => {
        const result = verdict(request);
        if (
          request.questions.scope &&
          (request.state as TestState).candidates?.[0]?.ref?.entryId ===
            "replacement"
        )
          return new Promise((resolve) => {
            deferred.release = () => resolve(result);
          });
        return result;
      },
      true,
    );
    try {
      await r.settle("old-goal");
      for (let i = 0; i < 40; i++)
        r.append(
          `qa-cancel-history-${i}`,
          "An unrelated explanatory note.",
          "assistant",
        );
      r.append(
        "replacement",
        "Read the advisory plan and supporting documents instead.",
      );
      r.observe();
      await vi.advanceTimersByTimeAsync(100);
      expect(deferred.release).toBeDefined();
      r.monitor.turnOff();
      const ledger = structuredClone(r.monitor.ledger);
      const calls = r.requests.length;
      deferred.release?.();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(r.monitor.ledger).toEqual(ledger);
      expect(r.requests).toHaveLength(calls);
      expect(r.monitor.enabled).toBe(false);
    } finally {
      deferred.release?.();
      r.monitor.stop();
    }
  });

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

  it.each([false, true])(
    "keeps unresolved history across reload/backoff beyond window=%s",
    async (long) => {
      const r = runtime(beyondWindow(replayEntries(4), long), (request) => {
        const result = verdict(request);
        if (request.questions.scope)
          result.answers.scope = {
            type: "choice",
            choice: "ambiguous",
            confidence: 1,
            probabilities: { continue: 0, "new-goal": 0, ambiguous: 1 },
          };
        return result;
      });
      try {
        for (let i = 0; i < 1500; i++) {
          r.monitor.scheduleAnalysis();
          await vi.advanceTimersByTimeAsync(1);
          if (/historical|unresolved/.test(renderWidget(r.monitor)[0] ?? ""))
            break;
        }
        expect(renderWidget(r.monitor)[0]).toMatch(/historical|unresolved/);
        const checkpoint = structuredClone(r.checkpoints.at(-1));
        const ref = checkpoint?.unresolvedScope?.candidates[0];
        if (!ref) throw new Error("Missing unresolved reference");
        Object.assign(ref, {
          text: "PRIVATE-UNRESOLVED-TEXT",
          probabilities: { done: 1 },
        });
        expect(checkpoint).toBeDefined();
        r.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
        await r.monitor.restore("/nonexistent-offline-fixture", checkpoint);
        expect(JSON.stringify(r.monitor.checkpoint())).not.toContain(
          "PRIVATE-UNRESOLVED-TEXT",
        );
        expect(renderWidget(r.monitor)[0]).toMatch(/historical|unresolved/);
        await vi.advanceTimersByTimeAsync(20);
        expect(renderWidget(r.monitor)[0]).toMatch(/historical|unresolved/);
      } finally {
        r.monitor.stop();
      }
    },
  );

  it.each([
    "valid",
    "valid-long",
    "extra-fields",
    "forged-anchor",
    "valid-relation",
    "hash",
    "index",
    "relation",
    "missing-relation",
    "later-ambiguous",
  ])(
    "resumes or safely discards partial scope journal: %s",
    async (mutation) => {
      const original = replayEntries(1)[0];
      if (!original) throw new Error("Missing initial goal");
      let rejectLater = false;
      const r = runtime(
        beyondWindow(
          [
            original,
            {
              type: "message",
              id: "29acae97",
              parentId: original.id,
              message: {
                role: "user",
                content: Array.from(
                  { length: 27 },
                  (_, i) => `${i + 1}. New task ${i + 1}`,
                ).join("\n"),
              },
            },
          ],
          mutation === "valid-long",
        ),
        (request) => {
          const result = verdict(request);
          if (rejectLater && request.questions.scope)
            result.answers.scope = {
              type: "choice",
              choice: "ambiguous",
              confidence: 1,
              probabilities: { continue: 0, "new-goal": 0, ambiguous: 1 },
            };
          return result;
        },
      );
      try {
        await r.settle("29acae97");
        const savedIndex = r.saveRequestCounts.findIndex(
          (count) =>
            r.requests
              .slice(0, count)
              .filter((request) => request.questions.scope).length === 1,
        );
        expect(savedIndex).toBeGreaterThanOrEqual(0);
        const checkpoint = structuredClone(r.checkpoints[savedIndex]);
        const partial = checkpoint?.partialScope;
        if (!partial) throw new Error("Missing partial scope journal");
        if (mutation === "hash") partial.requestHashes[0] = "0".repeat(64);
        if (mutation === "index") partial.index = 201;
        if (mutation === "relation")
          partial.relations[0] = { index: 0, relation: "same:invented" };
        if (mutation === "missing-relation") partial.relations.pop();
        if (mutation === "valid-relation") {
          const relation = partial.relations[0];
          if (!relation) throw new Error("Missing relation");
          relation.relation = `same:${checkpoint?.tasks[0]?.id}`;
        }
        if (mutation === "forged-anchor") {
          const span = partial.source.spans[0];
          if (!span) throw new Error("Missing span");
          span.id = "forged";
        }
        if (mutation === "extra-fields") {
          Object.assign(partial.source, { text: "PRIVATE-SOURCE-TEXT" });
          Object.assign(partial.source.spans[0] ?? {}, {
            text: "PRIVATE-SPAN-TEXT",
            probabilities: { done: 1 },
          });
        }
        expect(JSON.stringify(checkpoint)).not.toContain("New task");
        const before = r.requests.length;
        rejectLater = mutation === "later-ambiguous";
        await r.monitor.restore("/nonexistent-offline-fixture", checkpoint);
        expect(JSON.stringify(r.monitor.checkpoint())).not.toMatch(
          /PRIVATE-(SOURCE|SPAN)-TEXT/,
        );
        if (rejectLater) {
          for (let i = 0; i < 50; i++) {
            r.monitor.scheduleAnalysis();
            await vi.advanceTimersByTimeAsync(1);
          }
          expect(r.monitor.conversation.cursor?.id).toBe(original.id);
          expect(renderWidget(r.monitor)[0]).toMatch(/historical|unresolved/);
          rejectLater = false;
          r.append("replacement", "1. Implement a CSV export feature instead.");
          await r.settle("replacement");
          expect(
            r.monitor.ledger?.tasks.filter((task) => task.included)[0]?.text,
          ).toContain("CSV export");
          return;
        }
        await r.settle("29acae97");
        expect(countReported(r.monitor.ledger).total).toBe(27);
        const resumed = r.requests
          .slice(before)
          .filter((request) => request.questions.scope);
        expect(resumed.length).toBeGreaterThan(0);
        expect(
          resumed.every((request) => !Object.hasOwn(request.questions, "0")),
        ).toBe(["valid", "valid-long", "extra-fields"].includes(mutation));
        if (!["valid", "valid-long", "extra-fields"].includes(mutation))
          expect(
            r.monitor
              .diagnostics()
              .some((item) => item.code === "discarded-partial-scope"),
          ).toBe(true);
      } finally {
        r.monitor.stop();
      }
    },
  );

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
