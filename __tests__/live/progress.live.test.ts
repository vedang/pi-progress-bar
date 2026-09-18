import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  MAX_REQUEST_BYTES,
  MODEL,
  type ValidatedResult,
} from "../../src/analysis/gateway";
import { countReported } from "../../src/core/ledger";
import { Monitor } from "../../src/core/monitor";
import { replayEntries } from "../fixtures/live-session";

// [tag:live_budget] All paid calls, including failed/aborted ones, pass this
// process-wide cap. No retries/reruns or hidden direct semantic substitutes.
const MAX_ATTEMPTS = 24;
const directory = resolve(
  ".agents/plans/20260918T165248--repair-session-progress-correctness__active",
);
const artifact = resolve(directory, `live-${Date.now()}.jsonl`);
const realFetch = globalThis.fetch;
let attempts = 0;
let active = 0;
let blocked = 0;
let ready = false;
const usage = { input_tokens: 0, output_tokens: 0 };
const record = (value: unknown) =>
  appendFileSync(artifact, `${JSON.stringify(value)}\n`);

beforeAll(() => {
  if (process.env.PROGRESS_LIVE !== "1")
    throw new Error("Paid suite requires explicit PROGRESS_LIVE=1");
  if (!process.env.TYPESAFE_API_KEY?.trim())
    throw new Error("Paid suite requires TYPESAFE_API_KEY");
  mkdirSync(directory, { recursive: true });
  ready = true;
  record({
    type: "budget",
    model: MODEL,
    maxAttempts: MAX_ATTEMPTS,
    maxRequestBytes: MAX_REQUEST_BYTES,
    fixture: "sanitized incremental live-session reconstruction",
    timestamp: new Date().toISOString(),
  });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (
      url !== "https://api.typesafe.ai/v1/systemone" ||
      !body ||
      Buffer.byteLength(body) > MAX_REQUEST_BYTES ||
      attempts >= MAX_ATTEMPTS
    ) {
      blocked++;
      record({ type: "blocked", attempts });
      throw new Error(
        "Live evaluation request budget or endpoint boundary reached",
      );
    }
    const request = JSON.parse(body);
    if (request.model !== MODEL) throw new Error("Unexpected live model");
    const attempt = ++attempts;
    active++;
    // Only synthetic fixture states/questions; never persist credentials/headers.
    record({
      type: "attempt",
      attempt,
      request,
      bytes: Buffer.byteLength(body),
    });
    try {
      const response = await realFetch(url, init);
      const data = (await response.clone().json()) as Partial<ValidatedResult>;
      if (response.ok && data.usage) {
        usage.input_tokens += data.usage.input_tokens ?? 0;
        usage.output_tokens += data.usage.output_tokens ?? 0;
      }
      record({
        type: "response",
        attempt,
        status: response.status,
        model: data.model,
        usage: data.usage,
        answers: data.answers,
      });
      return response;
    } catch (error) {
      record({
        type: "failure",
        attempt,
        errorType: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    } finally {
      active--;
    }
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (ready) {
    record({ type: "totals", attempts, blocked, usage });
    console.info(
      `Live Jev evidence: ${artifact}; ${attempts}/${MAX_ATTEMPTS} attempts; ${JSON.stringify(usage)}`,
    );
  }
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("fresh-session production pipeline follows a changed goal and consumes completion only after scope", async () => {
  let entries = replayEntries(4);
  const monitor = new Monitor(
    () => {},
    () => {},
  );
  monitor.observe(() => entries);
  const settleThrough = async (entryId: string) => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (blocked) throw new Error(`Live attempt cap reached; see ${artifact}`);
      if (!monitor.enabled)
        throw new Error(monitor.error ?? "Monitor stopped unexpectedly");
      monitor.scheduleAnalysis();
      if (monitor.conversation.cursor?.id === entryId && active === 0) {
        await pause(100);
        if (!active) return;
      }
      await pause(25);
    }
    throw new Error(
      `Production replay did not settle through ${entryId}; cursor=${monitor.conversation.cursor?.id}; discovery=${monitor.conversation.discoveryStatus}; reports=${monitor.conversation.reportStatus}; gateway=${monitor.gateway.status}; artifact=${artifact}`,
    );
  };
  try {
    expect(monitor.turnOn("/nonexistent-live-fixture")).toBeUndefined();
    await settleThrough("29acae97");
    const tasks = monitor.ledger?.tasks.filter((task) => task.included) ?? [];
    record({
      type: "goal-checkpoint",
      tasks,
      cursor: monitor.conversation.cursor,
    });
    expect(tasks).toHaveLength(2);
    expect(tasks.map((task) => task.text).join("\n")).toContain("15s");
    expect(tasks.map((task) => task.text).join("\n")).toContain("/progress");
    expect(tasks.map((task) => task.text).join("\n")).not.toContain(
      "First lock scope",
    );

    entries = replayEntries(5);
    await settleThrough("working");
    const current = monitor.ledger?.tasks.find(
      (task) => task.id === monitor.ledger?.currentTaskId,
    );
    record({
      type: "current-checkpoint",
      current,
      cursor: monitor.conversation.cursor,
    });
    expect(current?.text).toContain("15s");

    entries = replayEntries();
    await settleThrough("2fd7cc52");
    record({
      type: "final-checkpoint",
      ledger: monitor.ledger,
      usage: monitor.usage,
      cursor: monitor.conversation.cursor,
    });
    expect(countReported(monitor.ledger)).toMatchObject({
      done: 2,
      total: 2,
      percent: 100,
    });
    // Same history may hit local cache, but must never generate new paid requests.
    const before = attempts;
    for (let i = 0; i < 20; i++) {
      monitor.scheduleAnalysis();
      await pause(10);
    }
    expect(attempts).toBe(before);
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThanOrEqual(MAX_ATTEMPTS);
  } finally {
    monitor.stop();
  }
});
