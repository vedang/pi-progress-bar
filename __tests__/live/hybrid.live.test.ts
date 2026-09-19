import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { Monitor } from "../../src/core/monitor";
import { selectedModelExtractor } from "../../src/core/selected-model";
import { userMessageQa } from "../fixtures/user-message-qa";

// Explicit paid opt-in; a missing opt-in must not look like a successful QA run.
if (process.env.PROGRESS_LIVE !== "1" || !process.env.TYPESAFE_API_KEY?.trim())
  throw new Error(
    "Paid hybrid QA requires PROGRESS_LIVE=1 and an existing TYPESAFE_API_KEY",
  );
const group = process.env.PROGRESS_LIVE_GROUP;
if (group !== "ci" && group !== "remaining")
  throw new Error("Choose ci or remaining paid group");
const artifactDir = process.env.PROGRESS_LIVE_ARTIFACT_DIR;
const revision = process.env.PROGRESS_LIVE_REVISION;
if (!artifactDir || !revision)
  throw new Error("Frozen revision and artifact directory required");
const caps = group === "ci" ? { jev: 32, model: 8 } : { jev: 64, model: 16 };
const path = join(
  resolve(artifactDir),
  `hybrid-${group}-${Date.now()}-${randomUUID()}.jsonl`,
);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function sources(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
      const path = join(dir, item.name);
      return item.isDirectory()
        ? Object.entries(sources(path))
        : [[path, hash(readFileSync(path, "utf8"))]];
    }),
  );
}
writeFileSync(path, "", { flag: "wx" });
const record = (value: unknown) =>
  appendFileSync(path, `${JSON.stringify(value)}\n`);

type Message = { id: string; role: "user" | "assistant"; text: string };
const ci = JSON.parse(
  readFileSync(new URL("../fixtures/hybrid-ci.json", import.meta.url), "utf8"),
) as Message[];
const attempts = { jev: 0, model: 0 };
const totals = {
  jevInput: 0,
  jevOutput: 0,
  modelInput: 0,
  modelOutput: 0,
  modelCacheRead: 0,
  modelReportedCost: 0,
};
const monitors = new Set<Monitor>();
let current = "preflight";
let fatal: string | undefined;
function fail(kind: string): never {
  fatal = kind;
  for (const monitor of monitors) monitor.stop();
  throw new Error(kind);
}
function admit(kind: keyof typeof attempts) {
  if (fatal) throw new Error(fatal);
  if (attempts[kind] >= caps[kind]) {
    record({
      type: "cap-rejected",
      case: current,
      kind,
      attempts: { ...attempts },
    });
    return fail(`${kind} budget exhausted`);
  }
  return ++attempts[kind];
}
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

it(`paid production hybrid group: ${group}`, async () => {
  const provider = process.env.PI_PROVIDER;
  const modelId = process.env.PI_MODEL;
  if (!provider || !modelId)
    throw new Error("Selected host provider/model environment required");
  const runtime = await ModelRuntime.create({
    allowModelNetwork: false,
    signal: AbortSignal.timeout(15_000),
  });
  const model = runtime.getModel(provider, modelId);
  if (!model) throw new Error("Selected host model unavailable");
  const registry = new ModelRegistry(runtime);
  const originalComplete = registry.complete.bind(registry);
  const originalFetch = globalThis.fetch;
  record({
    type: "manifest",
    revision,
    group,
    caps,
    provider,
    model: modelId,
    sourceHashes: sources("src"),
    fixtureHash: hash(JSON.stringify(ci)),
    testHash: hash(readFileSync(import.meta.filename, "utf8")),
    startedAt: new Date().toISOString(),
  });
  registry.complete = async (selected, context, options) => {
    const attempt = admit("model"),
      started = Date.now(),
      fixture = current;
    expect(options).toMatchObject({
      maxRetries: 0,
      maxTokens: 2048,
      timeoutMs: 60_000,
    });
    expect(options).not.toHaveProperty("apiKey");
    expect(context.tools).toEqual([]);
    expect(context.messages).toHaveLength(1);
    record({
      type: "model-attempt",
      case: fixture,
      attempt,
      provider: selected.provider,
      model: selected.id,
      context,
    });
    try {
      const result = await originalComplete(selected, context, options);
      const text = result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      record({
        type: "model-response",
        case: fixture,
        attempt,
        ms: Date.now() - started,
        stopReason: result.stopReason,
        model: result.model,
        provider: result.provider,
        text: Buffer.byteLength(text) <= 32 * 1024 ? text : undefined,
        usage: result.usage,
      });
      totals.modelInput += result.usage.input;
      totals.modelOutput += result.usage.output;
      totals.modelCacheRead += result.usage.cacheRead;
      totals.modelReportedCost += result.usage.cost.total;
      if (result.stopReason === "error" || result.stopReason === "aborted")
        fail("Selected model transport failed");
      if (Buffer.byteLength(text) > 32 * 1024)
        fail("Selected model output exceeded cap");
      return result;
    } catch {
      record({
        type: "model-failure",
        case: fixture,
        attempt,
        ms: Date.now() - started,
        kind: fatal ?? "provider-failure",
      });
      return fail(fatal ?? "Selected model provider failed");
    }
  };
  globalThis.fetch = async (url, init) => {
    if (String(url) !== "https://api.typesafe.ai/v1/systemone")
      return originalFetch(url, init);
    const request = JSON.parse(String(init?.body));
    if (
      Buffer.byteLength(String(init?.body)) > 24 * 1024 ||
      Object.keys(request.questions).length > 20
    )
      fail("Jev request exceeded cap");
    const attempt = admit("jev"),
      started = Date.now(),
      fixture = current;
    record({ type: "jev-attempt", case: fixture, attempt, request });
    try {
      const response = await originalFetch(url, init);
      const text = await response.clone().text();
      if (Buffer.byteLength(text) > 128 * 1024)
        fail("Jev response exceeded cap");
      const body = JSON.parse(text);
      record({
        type: "jev-response",
        case: fixture,
        attempt,
        status: response.status,
        ms: Date.now() - started,
        model: body.model,
        answers: body.answers,
        usage: body.usage,
      });
      totals.jevInput += body.usage?.input_tokens ?? 0;
      totals.jevOutput += body.usage?.output_tokens ?? 0;
      if (!response.ok) fail(`Jev HTTP ${response.status}`);
      return response;
    } catch {
      record({
        type: "jev-failure",
        case: fixture,
        attempt,
        ms: Date.now() - started,
        kind: fatal ?? "transport-or-envelope-failure",
      });
      return fail(fatal ?? "Jev transport failed");
    }
  };
  function harness(name: string) {
    current = name;
    let entries: unknown[] = [];
    const monitor = new Monitor(
      () => {},
      () => {},
      {
        sourceId: () => `live:${name}`,
        extract: selectedModelExtractor(() => ({
          model,
          modelRegistry: registry,
        })),
      },
    );
    monitors.add(monitor);
    const observe = () => monitor.observe(() => entries);
    observe();
    monitor.turnOn("/nonexistent-progress-live-fixture");
    const settle = async (id: string) => {
      const deadline = Date.now() + 120_000;
      while (
        monitor.state.cursor?.id !== id ||
        monitor.debugSnapshot().processing !== "idle"
      ) {
        if (fatal) throw new Error(fatal);
        if (Date.now() > deadline) fail("Live observation deadline exceeded");
        await pause();
      }
    };
    return {
      monitor,
      observe,
      settle,
      append: async (message: Message) => {
        entries = [
          ...entries,
          {
            type: "message",
            id: message.id,
            parentId: entries.length
              ? (entries.at(-1) as { id: string }).id
              : null,
            message: { role: message.role, content: message.text },
          },
        ];
        observe();
        await settle(message.id);
        record({
          type: "observation-result",
          case: name,
          messageId: message.id,
          state: monitor.state,
          view: monitor.presentationSnapshot(),
          checkpoint: monitor.checkpoint(),
        });
      },
      stop: () => {
        monitor.stop();
        monitors.delete(monitor);
      },
    };
  }
  let outcome = "failed";
  try {
    if (group === "ci") {
      const h = harness("exact-ci");
      let ids: string[] = [];
      for (const [index, message] of ci.entries()) {
        await h.append(message);
        const active = h.monitor.state.tasks.filter((task) => task.included);
        if (index === 0) {
          expect(active).toHaveLength(3);
          expect(active.every((task) => task.status !== "done")).toBe(true);
          ids = active.map((task) => task.id);
        }
        if (index === 1)
          expect(
            active.filter((task) => task.status === "done").length,
          ).toBeLessThan(3);
      }
      const final = h.monitor.state.tasks.filter((task) => task.included);
      expect(final.map((task) => task.id)).toEqual(ids);
      expect(
        final.filter((task) => task.status === "done").length,
      ).toBeGreaterThanOrEqual(2);
      record({
        type: "case-outcome",
        case: current,
        outcome: "passed",
        done: final.filter((task) => task.status === "done").length,
        total: final.length,
      });
      h.stop();
    } else {
      const reading = harness("reading-only");
      await reading.append({ ...userMessageQa.reading, role: "user" });
      const tasks = reading.monitor.state.tasks.filter((task) => task.included);
      expect(tasks.length).toBeGreaterThan(0);
      expect(
        tasks.every(
          (task) => !/^(implement|build|develop)\b/i.test(task.label),
        ),
      ).toBe(true);
      await reading.append({
        id: "read-done",
        role: "assistant",
        text: "I have read and understood the advisory plan and all supporting documents. I can explain the proposed phases and constraints. I made no implementation changes.",
      });
      expect(
        reading.monitor.state.tasks
          .filter((task) => task.included)
          .every((task) => task.status === "done"),
      ).toBe(true);
      record({ type: "case-outcome", case: current, outcome: "passed" });
      reading.stop();
      const qa = harness("question-answer");
      await qa.append({
        id: "question",
        role: "user",
        text: "Explain the difference between unit tests and integration tests.",
      });
      expect(
        qa.monitor.state.tasks.filter((task) => task.included),
      ).toHaveLength(1);
      expect(qa.monitor.state.tasks[0]?.kind).toBe("response");
      await qa.append({
        id: "answer",
        role: "assistant",
        text: "Unit tests check one component in isolation, often replacing its dependencies with test doubles. Integration tests exercise collaborating components and their boundaries, such as a service with a real database. Unit tests give precise, fast feedback; integration tests reveal wiring and contract failures that isolated tests miss.",
      });
      expect(qa.monitor.state.tasks[0]?.status).toBe("done");
      record({ type: "case-outcome", case: current, outcome: "passed" });
      qa.stop();
      const parallel = harness("parallel-withdrawal-reload");
      await parallel.append({
        id: "parallel-request",
        role: "user",
        text: "Please do these three separate tasks: (A) implement the parser, (B) add the regression test, and (C) validate the configuration. Track them independently.",
      });
      expect(
        parallel.monitor.state.tasks.filter((task) => task.included),
      ).toHaveLength(3);
      await parallel.append({
        id: "parallel-delivery",
        role: "assistant",
        text: "Task B, adding the regression test, is complete. Task C, validating the configuration, is complete. Task A, implementing the parser, is still unfinished; I have not implemented it.",
      });
      expect(parallel.monitor.presentationSnapshot().progress).toMatchObject({
        done: 2,
        total: 3,
      });
      const previouslyDone = parallel.monitor.state.tasks
        .filter((task) => task.status === "done")
        .map((task) => task.id);
      await parallel.append({
        id: "withdrawal",
        role: "assistant",
        text: "Correction: Task B, the regression test, is not finished after all. Task C, configuration validation, remains complete. Task A, parser implementation, is still unfinished.",
      });
      expect(parallel.monitor.presentationSnapshot().progress).toMatchObject({
        done: 1,
        total: 3,
      });
      expect(
        parallel.monitor.state.tasks.filter(
          (task) => task.status === "reopened",
        ),
      ).toHaveLength(1);
      expect(
        parallel.monitor.state.tasks.some(
          (task) => task.status === "done" && previouslyDone.includes(task.id),
        ),
      ).toBe(true);
      const checkpoint = parallel.monitor.checkpoint();
      const before = { ...attempts };
      parallel.monitor.turnOff();
      await parallel.monitor.restore(
        "/nonexistent-progress-live-fixture",
        checkpoint,
      );
      parallel.observe();
      await parallel.settle("withdrawal");
      expect(attempts).toEqual(before);
      record({
        type: "case-outcome",
        case: current,
        outcome: "passed",
        settledReloadRebilled: false,
      });
      parallel.stop();
    }
    outcome = "passed";
  } finally {
    for (const monitor of monitors) monitor.stop();
    monitors.clear();
    globalThis.fetch = originalFetch;
    registry.complete = originalComplete;
    record({
      type: "summary",
      group,
      outcome,
      fatal,
      attempts,
      totals,
      endedAt: new Date().toISOString(),
    });
    console.log(`Paid hybrid artifact: ${path}`);
  }
}, 900_000);
