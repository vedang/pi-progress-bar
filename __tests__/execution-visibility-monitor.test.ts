import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReconciliationController } from "../src/advisory/reconciliation";
import type { EvaluationRequest } from "../src/analysis/gateway";
import { correctionSource } from "./fixtures/correction-source";
import { branchEntry, monitorHarness } from "./fixtures/hybrid-monitor";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "fixture-key");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const text = "I am inspecting the parser implementation.";
const message = (value = text) => ({
  role: "assistant",
  content: [{ type: "text", text: value }],
  stopReason: "toolUse",
});
const visibility = (request: EvaluationRequest) =>
  "currentCandidate" in request.questions ||
  "historyCandidate" in request.questions ||
  "currentTask" in request.questions ||
  "historyTask" in request.questions;
async function setup() {
  const h = monitorHarness();
  h.start();
  await h.settle("goal");
  const transport = h.fetch.getMockImplementation();
  if (!transport) throw Error("fixture");
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body)) as EvaluationRequest;
    if (!visibility(request)) return transport(url, init);
    h.requests.push(request);
    return Response.json({
      model: "jev-1.13.0",
      usage: { input_tokens: 5, output_tokens: 2 },
      answers: Object.fromEntries(
        Object.entries(request.questions).map(([key, question]) => {
          const choices = Object.keys(question.criteria);
          const choice =
            choices.find(
              (id) => id.startsWith("candidate:") || id.startsWith("task:"),
            ) ?? "none";
          return [
            key,
            {
              type: "choice",
              choice,
              confidence: 1,
              probabilities: Object.fromEntries(
                choices.map((id) => [id, id === choice ? 1 : 0]),
              ),
            },
          ];
        }),
      ),
    });
  });
  h.monitor.visibilityRunStarted();
  return h;
}
describe("optional live visibility integration", () => {
  it("current-only MAYBE survives settlement into the single delayed clarification", async () => {
    const h = await setup();
    const original = h.fetch.getMockImplementation();
    if (!original) throw Error("fixture");
    h.fetch.mockImplementation(async (url, init) => {
      const request = JSON.parse(String(init?.body));
      const response = await original(url, init);
      if (!visibility(request)) return response;
      const body = (await response.json()) as {
        answers: Record<
          string,
          {
            choice: string;
            confidence: number;
            probabilities: Record<string, number>;
          }
        >;
      };
      if (body.answers.historyCandidate) {
        body.answers.historyCandidate.choice = "none";
        for (const key of Object.keys(
          body.answers.historyCandidate.probabilities,
        ))
          body.answers.historyCandidate.probabilities[key] =
            key === "none" ? 1 : 0;
      }
      if (body.answers.currentTask) body.answers.currentTask.confidence = 0.84;
      return Response.json(body);
    });
    h.monitor.observeVisibilityMessage(message(), h.reader());
    await vi.advanceTimersByTimeAsync(100);
    h.append("maybe-report", text);
    h.monitor.confirmVisibilityBranch(h.reader());
    await h.settle("maybe-report");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.monitor.visibilitySnapshot().actions).toHaveLength(0);
    h.monitor.visibilityRunSettled();
    const emit = vi.fn();
    const controller = new ReconciliationController({
      snapshot: () => h.monitor.advisorySettlementSnapshot(),
      emit,
      clock: { now: () => Date.now(), setTimeout, clearTimeout },
    });
    controller.runStarted(1);
    controller.settled(1, "independent");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0].content).toContain(text);
    expect(emit.mock.calls[0][0].content).toContain("MAYBE");
    h.append("generic-status", "The parser task is still pending.");
    await h.settle("generic-status");
    expect(
      h.monitor.advisorySettlementSnapshot().uncertainActivities,
    ).toHaveLength(1);
    controller.dispose();
    h.monitor.stop();
  });

  it.each([1, 2])(
    "correction dispatch preempts held visibility stage %s without retry",
    async (stage) => {
      const h = await setup();
      const original = h.fetch.getMockImplementation();
      if (!original) throw Error("fixture");
      let signal: AbortSignal | undefined;
      let count = 0;
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      h.fetch.mockImplementation(async (url, init) => {
        const request = JSON.parse(String(init?.body));
        const selectedStage = stage === 1 ? "currentCandidate" : "currentTask";
        if (selectedStage in request.questions) {
          count++;
          signal = init?.signal ?? undefined;
          await held;
        }
        return original(url, init);
      });
      h.monitor.observeVisibilityMessage(message(), h.reader());
      await vi.advanceTimersByTimeAsync(100);
      if (stage === 2) {
        h.append("live-report", text);
        h.monitor.confirmVisibilityBranch(h.reader());
        await h.settle("live-report");
      }
      expect(signal).toBeDefined();
      expect(signal?.aborted).toBe(false);
      const attempt = {
        kind: "test" as const,
        id: "new-corrective-write",
        toolName: "write",
        path: "__tests__/parser.test.ts",
      };
      await h.monitor.observeCorrectionAttempt(
        attempt,
        correctionSource(attempt),
      );
      expect(signal?.aborted).toBe(true);
      release();
      await vi.advanceTimersByTimeAsync(100);
      h.monitor.confirmVisibilityBranch(h.reader());
      h.monitor.modelSelected();
      await vi.advanceTimersByTimeAsync(100);
      expect(count).toBe(1);
      h.monitor.stop();
    },
  );

  it.each(["aborted", "error", "toolUse"])(
    "never confirms newer %s prose against an identical older canonical entry",
    async (stopReason) => {
      const h = await setup();
      h.append("prior-report", text);
      await h.settle("prior-report");
      h.monitor.observeVisibilityMessage(
        { ...message(), stopReason },
        h.reader(),
      );
      await vi.advanceTimersByTimeAsync(100);
      h.monitor.confirmVisibilityBranch(h.reader());
      await vi.advanceTimersByTimeAsync(100);
      expect(
        h.requests.filter((r) => "currentTask" in r.questions),
      ).toHaveLength(0);
      expect(h.monitor.visibilitySnapshot().actions).toEqual([]);
      h.monitor.stop();
    },
  );
  it.each(["", "x".repeat(13000)])(
    "new inadmissible assistant text clears older current",
    async (newText) => {
      const h = await setup();
      h.monitor.observeVisibilityMessage(message());
      await vi.advanceTimersByTimeAsync(100);
      expect(h.monitor.visibilitySnapshot().current).toBeDefined();
      h.monitor.observeVisibilityMessage(message(newText));
      await vi.advanceTimersByTimeAsync(100);
      expect(h.monitor.visibilitySnapshot().current).toBeUndefined();
      h.monitor.stop();
    },
  );
  it("unchanged canonical confirmation cannot rebill an already classified source", async () => {
    const h = await setup();
    h.monitor.observeVisibilityMessage(message());
    await vi.advanceTimersByTimeAsync(100);
    h.append("live-report", text);
    h.monitor.confirmVisibilityBranch(h.reader());
    await h.settle("live-report");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.requests.filter((r) => "currentTask" in r.questions)).toHaveLength(
      1,
    );
    h.monitor.modelSelected();
    h.monitor.confirmVisibilityBranch(h.reader());
    await vi.advanceTimersByTimeAsync(100);
    expect(h.requests.filter((r) => "currentTask" in r.questions)).toHaveLength(
      1,
    );
    h.monitor.stop();
  });

  it("captures provisional commentary independently and never marks semantic input consumed", async () => {
    const h = await setup();
    const cursor = h.monitor.state.cursor;
    const state = JSON.stringify(h.monitor.state);
    h.monitor.observeVisibilityMessage(message());
    await vi.advanceTimersByTimeAsync(100);
    expect(h.monitor.visibilitySnapshot().current).toMatchObject({
      text,
      provisional: true,
    });
    expect(h.monitor.state.cursor).toEqual(cursor);
    expect(JSON.stringify(h.monitor.state)).toBe(state);
    expect(h.monitor.visibilitySnapshot().actions).toHaveLength(0);
    h.monitor.stop();
  });
  it("task-binds only after exact canonical confirmation and semantic cursor commit", async () => {
    const h = await setup();
    h.monitor.observeVisibilityMessage(message());
    await vi.advanceTimersByTimeAsync(100);
    expect(h.requests.filter((r) => "currentTask" in r.questions)).toHaveLength(
      0,
    );
    h.append("live-report", text);
    h.monitor.confirmVisibilityBranch(h.reader());
    await h.settle("live-report");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.requests.some((r) => "currentTask" in r.questions)).toBe(true);
    expect(h.monitor.visibilitySnapshot().actions).toHaveLength(1);
    expect(h.monitor.state.cursor?.id).toBe("live-report");
    h.monitor.stop();
  });
  it("never captures historical canonical assistant messages as live activity", async () => {
    const h = monitorHarness([
      branchEntry("goal", "Implement parser, add regression, and validate it."),
      branchEntry("old-report", text, "assistant"),
    ]);
    h.start();
    await h.settle("old-report");
    expect(h.requests.filter(visibility)).toHaveLength(0);
    expect(h.monitor.visibilitySnapshot().actions).toEqual([]);
    h.monitor.stop();
  });
  it("visibility-only work never saves checkpoints or alters existing provider usage", async () => {
    const h = await setup();
    const usage = h.monitor.presentationSnapshot().usage;
    const saved = h.save.mock.calls.length;
    h.monitor.observeVisibilityMessage(message());
    await vi.advanceTimersByTimeAsync(100);
    expect(h.monitor.visibilitySnapshot().usage.calls).toBe(1);
    expect(h.monitor.visibilitySnapshot().usage.inputTokens).toBe(5);
    expect(h.monitor.presentationSnapshot().usage).toEqual(usage);
    expect(h.save).toHaveBeenCalledTimes(saved);
    h.monitor.stop();
  });
  it("settlement cannot resurrect current from late visibility responses", async () => {
    const h = await setup();
    const original = h.fetch.getMockImplementation();
    if (!original) throw Error("fixture");
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.fetch.mockImplementation(async (url, init) => {
      const request = JSON.parse(String(init?.body));
      if (visibility(request)) await held;
      return original(url, init);
    });
    h.monitor.observeVisibilityMessage(message());
    await vi.advanceTimersByTimeAsync(10);
    h.monitor.visibilityRunSettled();
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.monitor.visibilitySnapshot().current).toBeUndefined();
    h.monitor.stop();
  });
  it("canonical text replacement invalidates early selection, never binds the old quote", async () => {
    const h = await setup();
    h.monitor.observeVisibilityMessage(message());
    await vi.advanceTimersByTimeAsync(100);
    h.append("changed-report", "The listener replaced this report.");
    h.monitor.confirmVisibilityBranch(h.reader());
    await h.settle("changed-report");
    expect(
      h.monitor
        .visibilitySnapshot()
        .actions.some((action) => action.candidate.quote === text),
    ).toBe(false);
    h.monitor.stop();
  });
  it("OFF destroys runtime history and usage; ON does not backfill", async () => {
    const h = await setup();
    h.monitor.observeVisibilityMessage(message());
    await vi.advanceTimersByTimeAsync(100);
    h.monitor.turnOff();
    expect(h.monitor.visibilitySnapshot().current).toBeUndefined();
    expect(h.monitor.visibilitySnapshot().usage.calls).toBe(0);
    h.monitor.turnOn("/nonexistent-hybrid-test");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.monitor.visibilitySnapshot().actions).toEqual([]);
    expect(h.monitor.visibilitySnapshot().usage.calls).toBe(0);
    h.monitor.stop();
  });
});
