import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { extractionInput } from "../src/analysis/extractor";
import {
  checkpointBytes,
  encodeCheckpoint,
  type MonitorCheckpointMetadata,
} from "../src/core/hybrid-checkpoint";
import { selectedModelExtractor } from "../src/core/selected-model";
import { initial, initialMessage, noPatch } from "./fixtures/hybrid";
import { branchEntry, monitorHarness } from "./fixtures/hybrid-monitor";

const running: ReturnType<typeof monitorHarness>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline-key");
});
afterEach(() => {
  for (const h of running.splice(0)) h.monitor.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
const usage = (value = 0) => ({
  calls: value,
  inputTokens: value,
  outputTokens: value,
});
it.each(["jev", "extraction"] as const)(
  "saturates cumulative %s usage and keeps accepted checkpoints encodable",
  async (phase) => {
    const state = await initial();
    const metadata: MonitorCheckpointMetadata = {
      enabled: false,
      usage: { jev: usage(), extraction: usage() },
    };
    metadata.usage[phase] = usage(Number.MAX_SAFE_INTEGER);
    const h = monitorHarness([
      branchEntry(initialMessage.id, initialMessage.text, initialMessage.role),
    ]);
    running.push(h);
    await h.monitor.restore(
      "/nonexistent-hybrid-test",
      encodeCheckpoint(state, metadata),
      false,
      h.reader,
    );
    h.monitor.turnOn("/nonexistent-hybrid-test");
    h.append("extra", "Please add a separate task.", "user");
    await vi.advanceTimersByTimeAsync(200);
    expect(h.fetch).toHaveBeenCalled();
    if (phase === "extraction") expect(h.extract).toHaveBeenCalled();
    expect(() => h.monitor.checkpoint()).not.toThrow();
    expect(h.monitor.checkpoint()).toMatchObject({
      monitor: { usage: { [phase]: usage(Number.MAX_SAFE_INTEGER) } },
    });
    expect(h.monitor.state.cursor?.id).toBe("extra");
  },
);

it.each([0.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects or safely normalizes invalid selected-model usage %s",
  async (tokens) => {
    const complete = vi.fn(async () => ({
      stopReason: "stop",
      content: [{ type: "text", text: JSON.stringify(noPatch()) }],
      usage: { input: tokens, output: tokens },
    }));
    const context = {
      model: { id: "fake", provider: "fake" },
      modelRegistry: { complete },
    } as unknown as Pick<ExtensionContext, "model" | "modelRegistry">;
    const request = extractionInput(await initial(), initialMessage, []);
    const result = await selectedModelExtractor(() => context)(
      request,
      new AbortController().signal,
    ).catch(() => undefined);
    // Either invalid transport result is rejected or invalid counters become safe;
    // it must never expose a fractional/unsafe checkpoint counter.
    if (result) {
      expect(Number.isSafeInteger(result.usage.inputTokens)).toBe(true);
      expect(Number.isSafeInteger(result.usage.outputTokens)).toBe(true);
      expect(result.usage.inputTokens).toBeGreaterThanOrEqual(0);
    }
  },
);

it("health envelope covers retained old card with prospective dispatch and usage metadata", async () => {
  const state = await initial();
  const first = state.tasks[0],
    second = state.tasks[1];
  if (!first || !second) throw new Error("Missing tasks");
  first.status = "done";
  first.label = "\ud800".repeat(240);
  state.focusTaskId = second.id;
  const oldCard = {
    taskId: first.id,
    revision: first.revision,
    label: first.label,
    retained: true,
    replacementPending: true,
    assessedAt: 1,
    health: {
      requirements: "Clear",
      acceptance: "explicit",
      newRedTest: "Not needed",
      redEvidence: "Not needed",
      implementation: "unverified",
    },
  };
  const metadata: MonitorCheckpointMetadata = {
    enabled: false,
    usage: { jev: usage(), extraction: usage() },
    card: oldCard,
  };
  const h = monitorHarness([
    branchEntry(initialMessage.id, initialMessage.text, initialMessage.role),
  ]);
  running.push(h);
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    encodeCheckpoint(state, metadata),
    false,
    h.reader,
  );
  expect(h.monitor.state.focusTaskId).toBe(second.id);
  const projected = {
    ...oldCard,
    taskId: second.id,
    label: second.label,
    retained: false,
    replacementPending: false,
    assessedAt: Number.MAX_SAFE_INTEGER,
  };
  const envelope = Reflect.apply(
    Reflect.get(h.monitor, "capacityEnvelope"),
    h.monitor,
    ["health", h.monitor.state, projected],
  ) as { maximum: number };
  const dispatched = {
    ...metadata,
    usage: {
      jev: usage(Number.MAX_SAFE_INTEGER),
      extraction: usage(Number.MAX_SAFE_INTEGER),
    },
    lastJevCallAt: Number.MAX_SAFE_INTEGER,
    lastExtractionCallAt: Number.MAX_SAFE_INTEGER,
  };
  expect(checkpointBytes(h.monitor.state, dispatched)).toBeLessThanOrEqual(
    envelope.maximum,
  );
});
