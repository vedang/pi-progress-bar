import { createHash } from "node:crypto";
import { expect, vi } from "vitest";
import type { ScopePatch } from "../../src/analysis/extractor";
import type {
  EvaluationRequest,
  ValidatedResult,
} from "../../src/analysis/gateway";
import { processObservation } from "../../src/core/hybrid";
import {
  emptyState,
  type HybridState,
  type Observation,
  type ObservationRole,
} from "../../src/core/hybrid-state";

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const observation = (
  id: string,
  text: string,
  role: ObservationRole = "user",
): Observation => ({ id, text, role, hash: digest(text) });
export const noPatch = (): ScopePatch => ({
  add: [],
  revise: [],
  archive: [],
  restore: [],
  unresolved: false,
});
export function addPatch(
  message: Observation,
  labels = ["Implement parser", "Add regression", "Validate parser"],
): ScopePatch {
  return {
    ...noPatch(),
    add: labels.map((label) => ({
      label,
      kind: "action",
      basis: "explicit",
      quote: message.text,
    })),
  };
}
export function backend(
  patch = noPatch(),
  options: {
    gate?: string;
    focus?: string;
    focusConfidence?: number;
    focusProbability?: number;
    complete?: string | Record<string, string>;
    withdraw?: Record<string, string>;
    save?: (state: HybridState) => void;
  } = {},
) {
  const evaluate = vi.fn(
    async (request: EvaluationRequest): Promise<ValidatedResult> => {
      expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(
        24 * 1024,
      );
      expect(Object.keys(request.questions).length).toBeLessThanOrEqual(20);
      return {
        model: "jev-1.13.0",
        usage: { input_tokens: 1, output_tokens: 1 },
        answers: Object.fromEntries(
          Object.entries(request.questions).map(([key, question]) => {
            if (question.type !== "choice") throw new Error("Expected choice");
            const id = key.slice(key.indexOf(":") + 1);
            const choice =
              key === "focus"
                ? (options.focus ??
                  Object.keys(question.criteria).find((id) =>
                    id.startsWith("task:"),
                  ) ??
                  "none")
                : key === "gate"
                  ? (options.gate ?? "changed")
                  : key.startsWith("withdraw:")
                    ? (options.withdraw?.[id] ?? "no")
                    : typeof options.complete === "string"
                      ? options.complete
                      : (options.complete?.[id] ?? "no");
            expect(Object.keys(question.criteria)).toContain(choice);
            return [
              key,
              {
                type: "choice",
                choice,
                confidence:
                  key === "focus" ? (options.focusConfidence ?? 1) : 1,
                probabilities: Object.fromEntries(
                  Object.keys(question.criteria).map((candidate) => [
                    candidate,
                    candidate === choice
                      ? key === "focus"
                        ? (options.focusProbability ?? 1)
                        : 1
                      : key === "focus"
                        ? (1 - (options.focusProbability ?? 1)) /
                          (Object.keys(question.criteria).length - 1)
                        : 0,
                  ]),
                ),
              },
            ];
          }),
        ),
      };
    },
  );
  return {
    // Pure-core fixtures explicitly admit; Monitor tests exercise real byte envelopes.
    admit: vi.fn(() => true),
    evaluate,
    extract: vi.fn(async () => JSON.stringify(patch)),
    ...(options.save ? { save: options.save } : {}),
  };
}
export const initialMessage = observation(
  "initial",
  "Implement parser, add regression and validate it. PRIVATE_CONTEXT_SENTINEL.",
);
export async function initial(done = false) {
  return processObservation(
    emptyState("session:test"),
    initialMessage,
    backend(addPatch(initialMessage), { complete: done ? "yes" : "no" }),
  );
}
