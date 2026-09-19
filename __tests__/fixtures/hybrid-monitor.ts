import { vi } from "vitest";
import type { EvaluationRequest } from "../../src/analysis/gateway";
import type { ObservationRole } from "../../src/core/hybrid-state";
import { Monitor, type MonitorOptions } from "../../src/core/monitor";
import { addPatch, noPatch, observation } from "./hybrid";
import { userMessageQa } from "./user-message-qa";

export const branchEntry = (
  id: string,
  text: string,
  role: ObservationRole = "user",
) => {
  // This helper models ordinary Pi messages; intercom tests use custom_message.
  if (role === "intercom")
    throw new Error("Use an intercom custom_message fixture");
  return {
    type: "message",
    id,
    parentId: null,
    message: { role, content: text },
  };
};
export function jevReply(request: EvaluationRequest) {
  const state = request.state as {
    latest?: { id?: string };
    latestMessage?: { id?: string };
  };
  const id = state.latest?.id ?? state.latestMessage?.id;
  return Response.json({
    model: "jev-1.13.0",
    usage: { input_tokens: 2, output_tokens: 1 },
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([key, question]) => {
        if (question.type === "score") {
          const labels = question.criteria as string[];
          const score = labels.length - 1;
          return [
            key,
            {
              type: "score",
              score,
              confidence: 1,
              probabilities: Object.fromEntries(
                labels.map((_, i) => [i, i === score ? 1 : 0]),
              ),
              legend: Object.fromEntries(labels.map((label, i) => [i, label])),
            },
          ];
        }
        const keys = Object.keys(question.criteria);
        let choice = keys.includes("unknown")
          ? "unknown"
          : keys.includes("insufficient")
            ? "insufficient"
            : keys.includes("no")
              ? "no"
              : keys[0];
        if (key === "gate")
          choice =
            id === "goal" ||
            id === "extra" ||
            id === "secret" ||
            id === userMessageQa.reading.id
              ? "changed"
              : "unchanged";
        if (
          key.startsWith("complete:") &&
          id === "delivered" &&
          key !== "complete:task:1"
        )
          choice = "yes";
        if (key === "focus")
          choice =
            keys.find((candidate) => candidate.startsWith("task:")) ?? "none";
        if (key === "acceptance") choice = "explicit";
        if (key === "redApplicability") choice = "not-needed";
        if (key === "redReport") choice = "not-found";
        return [
          key,
          {
            type: "choice",
            choice,
            confidence: 1,
            probabilities: Object.fromEntries(
              keys.map((candidate) => [
                candidate,
                candidate === choice ? 1 : 0,
              ]),
            ),
          },
        ];
      }),
    ),
  });
}
export function monitorHarness(
  initial: unknown[] = [
    branchEntry("goal", "Implement parser, add regression, and validate it."),
  ],
) {
  let entries: unknown[] = [...initial];
  const requests: EvaluationRequest[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as EvaluationRequest;
    requests.push(request);
    return jevReply(request);
  });
  vi.stubGlobal("fetch", fetch);
  const changed = vi.fn();
  const save = vi.fn();
  const extract = vi.fn<MonitorOptions["extract"]>(
    async (input, _signal, onDispatch?: (at: number) => void) => {
      // The fake transport emits its own dispatch, just like the real host adapter.
      onDispatch?.(Date.now());
      return {
        text: JSON.stringify(
          input.latest.id === "goal" || input.latest.id === "secret"
            ? addPatch(
                observation(
                  input.latest.id,
                  input.latest.text,
                  input.latest.role,
                ),
              )
            : noPatch(),
        ),
        provider: "offline",
        model: "fixture",
        usage: { inputTokens: 3, outputTokens: 2 },
      };
    },
  );
  const monitor = new Monitor(changed, save, {
    sourceId: () => "session:test",
    extract,
  });
  const reader = vi.fn(() => entries);
  const observe = () => monitor.observe(reader);
  const settle = async (id: string) => {
    for (let i = 0; i < 2000 && monitor.state.cursor?.id !== id; i++)
      await vi.advanceTimersByTimeAsync(1);
    if (monitor.state.cursor?.id !== id)
      throw new Error(`Cursor did not settle: ${id}`);
    await vi.advanceTimersByTimeAsync(50);
  };
  return {
    monitor,
    reader,
    changed,
    save,
    extract,
    fetch,
    requests,
    observe,
    settle,
    start: () => {
      observe();
      monitor.turnOn("/nonexistent-hybrid-test");
    },
    append: (
      id: string,
      text: string,
      role: "user" | "assistant" = "assistant",
    ) => {
      entries = [...entries, branchEntry(id, text, role)];
      observe();
    },
    replace: (next: unknown[]) => {
      entries = next;
      observe();
    },
  };
}
