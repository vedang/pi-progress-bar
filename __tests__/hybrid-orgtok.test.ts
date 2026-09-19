import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { extractionInput } from "../src/analysis/extractor";
import { gateRequest } from "../src/analysis/gate";
import { emptyState } from "../src/core/hybrid-state";
import { selectedModelExtractor } from "../src/core/selected-model";
import {
  initial,
  initialMessage,
  noPatch,
  observation,
} from "./fixtures/hybrid";
import { monitorHarness } from "./fixtures/hybrid-monitor";

let running: ReturnType<typeof monitorHarness> | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline-key");
});
afterEach(() => {
  running?.monitor.stop();
  running = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("states the follow-up response lifecycle explicitly in the semantic gate rubric", async () => {
  const state = await initial(true);
  const request = gateRequest(
    state,
    observation(
      "2e3df26e",
      "Alright. I want to finish V2-13 ASAP. Please tell me what the blocker is",
    ),
    [],
  );
  const instruction = request.questions.gate?.instructions;
  // Prompt policy contract only: actual semantic evidence is the bounded paid replay.
  expect(instruction).toContain("new response deliverable");
  expect(instruction).toContain(
    "A completed task does not satisfy a later request",
  );
  expect(instruction).toContain("acknowledgments");
  expect(JSON.stringify(request.questions.gate?.criteria)).toContain(
    "response",
  );
  expect(
    (request.state as { tasks: { status: string }[] }).tasks.every(
      (task) => task.status === "done",
    ),
  ).toBe(true);
});

it("does not bill semantic analysis for tool-only, thinking-only, or blank assistant messages", async () => {
  const h = monitorHarness([]);
  running = h;
  h.replace([
    {
      type: "message",
      id: "tool-only",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "bash",
            arguments: { command: "echo data" },
          },
        ],
      },
    },
    {
      type: "message",
      id: "thinking-only",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "PRIVATE_THINKING" }],
      },
    },
    {
      type: "message",
      id: "blank",
      message: { role: "assistant", content: " \n\t " },
    },
  ]);
  h.start();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.fetch).not.toHaveBeenCalled();
  expect(h.extract).not.toHaveBeenCalled();
  expect(h.monitor.state.tasks).toEqual([]);
});

it("accepts valid model JSON alongside SDK thinking metadata without using or retaining the thinking", async () => {
  const text = JSON.stringify(noPatch());
  const complete = vi.fn(async () => ({
    stopReason: "stop",
    content: [
      { type: "thinking", thinking: "PRIVATE_THINKING" },
      { type: "text", text },
    ],
    usage: { input: 1, output: 1 },
  }));
  const ctx = {
    model: { id: "offline", provider: "offline" },
    modelRegistry: { complete },
  } as unknown as Pick<ExtensionContext, "model" | "modelRegistry">;
  const result = await selectedModelExtractor(() => ctx)(
    extractionInput(emptyState("session:test"), initialMessage, []),
    new AbortController().signal,
  );
  expect(result.text).toBe(text);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_THINKING");
});

it("still rejects model tool calls even when valid JSON text is also present", async () => {
  const complete = vi.fn(async () => ({
    stopReason: "stop",
    content: [
      { type: "text", text: JSON.stringify(noPatch()) },
      { type: "toolCall", name: "bash", arguments: { command: "do not run" } },
    ],
    usage: { input: 1, output: 1 },
  }));
  const ctx = {
    model: { id: "offline", provider: "offline" },
    modelRegistry: { complete },
  } as unknown as Pick<ExtensionContext, "model" | "modelRegistry">;
  const result = await selectedModelExtractor(() => ctx)(
    extractionInput(emptyState("session:test"), initialMessage, []),
    new AbortController().signal,
  );
  expect(result.text).toBe("");
});
