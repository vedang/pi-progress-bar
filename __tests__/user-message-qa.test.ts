import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvaluationRequest } from "../src/analysis/gateway";
import { Monitor } from "../src/core/monitor";
import { qaEntry, userMessageQa } from "./fixtures/user-message-qa";

const monitors: Monitor[] = [];
afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.stop();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("September 19 user-message QA: reassessment latency", () => {
  it.each([0, 40, 520])(
    "considers new user messages within three eligible dispatches with %i historical entries pending",
    async (padding) => {
      vi.useFakeTimers();
      vi.stubEnv("TYPESAFE_API_KEY", "offline-fixture-key");
      const entries = [qaEntry(userMessageQa.historical, null)];
      for (let i = 0; i < padding; i++)
        entries.push(
          qaEntry(
            {
              id: `synthetic-history-${i}`,
              text: "An unrelated explanatory note.",
            },
            entries.at(-1)?.id ?? null,
            "assistant",
          ),
        );
      const requests: EvaluationRequest[] = [];
      // Deliberately decline every source. This test proves consideration only,
      // not semantic correctness, successful scope admission or task completion.
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          const request = JSON.parse(String(init?.body)) as EvaluationRequest;
          requests.push(request);
          expect(Object.keys(request.questions)).toEqual(["source"]);
          const source = request.questions.source;
          if (!source) throw new Error("Missing source-selection question");
          // Hold each request long enough to observe dispatch order, not polling cadence.
          await new Promise((resolve) => setTimeout(resolve, 5));
          return new Response(
            JSON.stringify({
              model: request.model,
              usage: { input_tokens: 1, output_tokens: 1 },
              answers: {
                source: {
                  type: "choice",
                  choice: "none",
                  confidence: 1,
                  probabilities: Object.fromEntries(
                    Object.keys(source.criteria).map((key) => [
                      key,
                      key === "none" ? 1 : 0,
                    ]),
                  ),
                },
              },
            }),
            { status: 200 },
          );
        }),
      );
      const monitor = new Monitor(vi.fn(), vi.fn());
      monitors.push(monitor);
      monitor.observe(() => entries);
      monitor.turnOn("/nonexistent-offline-fixture");
      await vi.advanceTimersByTimeAsync(0);
      for (const message of [
        userMessageQa.reading,
        userMessageQa.clarification,
        userMessageQa.investigation,
        userMessageQa.stillHistorical,
        userMessageQa.regression,
      ]) {
        const before = requests.length;
        entries.push(qaEntry(message, entries.at(-1)?.id ?? null));
        monitor.observe(() => entries);
        await vi.advanceTimersByTimeAsync(20);
        const opportunities = requests.slice(before, before + 3);
        const assessedIds = opportunities.flatMap((request) => {
          const state = request.state as { candidates?: { entryId: string }[] };
          return state.candidates?.map((candidate) => candidate.entryId) ?? [];
        });
        expect
          .soft(assessedIds, `Unassessed user message: ${message.id}`)
          .toContain(message.id);
      }
    },
  );
});
