import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  Type,
} from "@earendil-works/pi-ai";
import type * as Pi from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";

function latch() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function bounded(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Host ordering proof stalled")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const hostRoot = process.env.PROGRESS_PI_HOST_ROOT;
const cases = [
  "sequential",
  "parallel",
  "partial",
  "truncated",
  "aborted",
  "error",
  "transform-before",
  "transform-after",
] as const;

it.skipIf(!hostRoot).each(cases)(
  "installed Pi 0.85.1 proves provisional/final tool boundary: %s",
  async (scenario) => {
    if (!hostRoot) throw new Error("Installed host root required");
    expect(
      JSON.parse(readFileSync(join(hostRoot, "package.json"), "utf8")).version,
    ).toBe("0.85.1");
    const {
      createAgentSession,
      DefaultResourceLoader,
      ModelRuntime,
      SessionManager,
      SettingsManager,
    } = (await import(
      pathToFileURL(join(hostRoot, "dist/index.js")).href
    )) as typeof Pi;
    const cwd = await mkdtemp(join(tmpdir(), "progress-activity-host-"));
    const a = latch(),
      b = latch(),
      releaseA = latch(),
      releaseB = latch();
    const events: { kind: string; ids: string[] }[] = [];
    const errors: unknown[] = [];
    const calls = [fauxToolCall("proof_a", {}), fauxToolCall("proof_b", {})];
    const ids = calls.map((call) => call.id);
    const transformed = scenario.startsWith("transform-");
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const faux = fauxProvider({ provider: "activity-host-proof" });
    runtime.registerNativeProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(transformed ? calls.slice(0, 1) : calls, {
        stopReason:
          scenario === "truncated"
            ? "length"
            : scenario === "aborted"
              ? "aborted"
              : scenario === "error"
                ? "error"
                : "toolUse",
      }),
      fauxAssistantMessage("Finished"),
    ]);
    const transform = (pi: ExtensionAPI) => {
      pi.on("message_end", (event) => {
        if (
          event.message.role !== "assistant" ||
          !event.message.content.some((part) => part.type === "toolCall")
        )
          return;
        return { message: { ...event.message, content: calls } };
      });
    };
    const observer = (pi: ExtensionAPI) => {
      for (const [name, started, released] of [
        ["proof_a", a, releaseA],
        ["proof_b", b, releaseB],
      ] as const) {
        pi.registerTool({
          name,
          label: name,
          description: "Offline ordering proof",
          parameters: Type.Object({}),
          executionMode:
            scenario === "sequential" || scenario === "partial"
              ? "sequential"
              : "parallel",
          async execute(id, _params, signal) {
            events.push({ kind: "execute", ids: [id] });
            started.release();
            await Promise.race([
              released.promise,
              new Promise<void>((resolve) => {
                if (signal?.aborted) resolve();
                else
                  signal?.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
              }),
            ]);
            return {
              content: [{ type: "text", text: "offline" }],
              details: {},
            };
          },
        });
      }
      pi.on("message_end", (event) => {
        if (event.message.role !== "assistant") return;
        const declared = event.message.content.flatMap((part) =>
          part.type === "toolCall" ? [part.id] : [],
        );
        if (declared.length)
          events.push({ kind: "provisional", ids: [...declared] });
      });
      pi.on("tool_execution_start", (event) => {
        events.push({ kind: "start", ids: [event.toolCallId] });
      });
      pi.on("tool_execution_end", (event) => {
        events.push({ kind: "end", ids: [event.toolCallId] });
      });
      pi.on("turn_end", (event) => {
        if (event.message.role !== "assistant") return;
        const declared = event.message.content.flatMap((part) =>
          part.type === "toolCall" ? [part.id] : [],
        );
        if (declared.length) {
          events.push({ kind: "final", ids: declared });
          events.push({
            kind: "results",
            ids: event.toolResults.map((result) => result.toolCallId),
          });
        }
      });
    };
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: join(cwd, "agent"),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories:
        scenario === "transform-before"
          ? [transform, observer]
          : scenario === "transform-after"
            ? [observer, transform]
            : [observer],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir: join(cwd, "agent"),
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      modelRuntime: runtime,
      model: faux.getModel(),
      tools: ["proof_a", "proof_b"],
      thinkingLevel: "off",
    });
    let running: Promise<void> | undefined;
    try {
      await session.bindExtensions({
        mode: "print",
        onError: (error) => errors.push(error),
      });
      running = session.prompt("Run the offline proof tools");
      if (!["truncated", "aborted", "error"].includes(scenario)) {
        await bounded(
          Promise.race([
            a.promise,
            running.then(() => {
              throw new Error(
                `Tools did not execute: ${JSON.stringify({ events, errors })}`,
              );
            }),
          ]),
        );
        expect(events[0]).toEqual({
          kind: "provisional",
          ids: scenario === "transform-after" ? ids.slice(0, 1) : ids,
        });
        expect(events.some((event) => event.kind === "final")).toBe(false);
        if (scenario === "partial") await bounded(session.abort());
        else if (scenario === "sequential") {
          expect(
            events
              .filter((event) => event.kind === "start")
              .flatMap((event) => event.ids),
          ).toEqual(ids.slice(0, 1));
          releaseA.release();
          await bounded(b.promise);
          releaseB.release();
        } else {
          await bounded(b.promise);
          expect(
            events
              .filter((event) => event.kind === "start")
              .flatMap((event) => event.ids),
          ).toEqual(ids);
          releaseB.release();
          // Let the real event chain emit B's end before releasing A.
          await new Promise<void>((resolve) => setImmediate(resolve));
          releaseA.release();
        }
      }
      await bounded(running);
      const started = events
        .filter((event) => event.kind === "start")
        .flatMap((event) => event.ids);
      const expectedStarts = ["aborted", "error"].includes(scenario)
        ? []
        : scenario === "partial"
          ? ids.slice(0, 1)
          : ids;
      expect(started).toEqual(expectedStarts);
      expect(events.find((event) => event.kind === "final")?.ids).toEqual(ids);
      if (scenario === "parallel")
        expect(
          events
            .filter((event) => event.kind === "end")
            .flatMap((event) => event.ids),
        ).toEqual([...ids].reverse());
      if (scenario === "truncated")
        expect(events.some((event) => event.kind === "execute")).toBe(false);
      if (scenario !== "partial")
        expect(events.find((event) => event.kind === "results")?.ids).toEqual(
          expectedStarts,
        );
      expect(errors).toEqual([]);
    } finally {
      releaseA.release();
      releaseB.release();
      await session.abort();
      await running?.catch(() => {});
      session.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  15000,
);
