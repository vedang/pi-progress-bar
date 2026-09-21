import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import * as pinnedPi from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { CorrectionAdapter } from "../src/advisory/correction-adapter";

// Characterization only: a public start event is not proof a write executed.
it.each(["blocked", "truncated", "valid"] as const)(
  "actual Pi write start precedes mutation admission: %s",
  async (scenario) => {
    const pi = process.env.PROGRESS_PI_HOST_ROOT
      ? ((await import(
          pathToFileURL(
            join(process.env.PROGRESS_PI_HOST_ROOT, "dist/index.js"),
          ).href
        )) as typeof pinnedPi)
      : pinnedPi;
    const cwd = await mkdtemp(join(tmpdir(), "advisory-action-"));
    const path = join(cwd, "regression.test.ts");
    const events: Array<{ kind: string; exists: boolean; id: string }> = [];
    const settingsManager = pi.SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const runtime = await pi.ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const faux = fauxProvider({ provider: "advisory-action-proof" });
    runtime.registerNativeProvider(faux.provider);
    const call = fauxToolCall("write", {
      path,
      content: "// synthetic test-file payload\n",
    });
    faux.setResponses([
      fauxAssistantMessage([call], {
        stopReason: scenario === "truncated" ? "length" : "toolUse",
      }),
      fauxAssistantMessage("Finished"),
    ]);
    const errors: unknown[] = [];
    const attempts: unknown[] = [];
    let registered: ReturnType<pinnedPi.ExtensionAPI["getAllTools"]> = [];
    const loader = new pi.DefaultResourceLoader({
      cwd,
      agentDir: join(cwd, "agent"),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (api) => {
          const adapter = new CorrectionAdapter({
            tools: () => api.getAllTools(),
          });
          api.on("session_start", () => {
            registered = api.getAllTools();
          });
          api.on("tool_execution_start", (event) => {
            attempts.push(
              adapter.start(event.toolCallId, event.toolName, event.args, cwd),
            );
            events.push({
              kind: "start",
              exists: existsSync(path),
              id: event.toolCallId,
            });
          });
          api.on("tool_call", (event) => {
            events.push({
              kind: "admission",
              exists: existsSync(path),
              id: event.toolCallId,
            });
            if (scenario === "blocked")
              return { block: true, reason: "Synthetic later blocker" };
          });
          api.on("tool_execution_update", (event) => {
            events.push({
              kind: "update",
              exists: existsSync(path),
              id: event.toolCallId,
            });
          });
          api.on("tool_execution_end", (event) => {
            events.push({
              kind: event.isError ? "error" : "end",
              exists: existsSync(path),
              id: event.toolCallId,
            });
          });
        },
      ],
    });
    await loader.reload();
    const { session } = await pi.createAgentSession({
      cwd,
      agentDir: join(cwd, "agent"),
      resourceLoader: loader,
      settingsManager,
      sessionManager: pi.SessionManager.inMemory(cwd),
      modelRuntime: runtime,
      model: faux.getModel(),
      tools: ["write"],
      thinkingLevel: "off",
    });
    try {
      await session.bindExtensions({
        mode: "rpc",
        onError: (error) => errors.push(error),
      });
      await session.prompt("Run the synthetic write proof.");
      expect(registered.find((tool) => tool.name === "write")).toMatchObject({
        sourceInfo: { source: "builtin", path: "<builtin:write>" },
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
        },
      });
      expect(attempts).toEqual([
        {
          kind: "test",
          id: call.id,
          toolName: "write",
          path: "regression.test.ts",
        },
      ]);
      expect(events[0]).toEqual({ kind: "start", exists: false, id: call.id });
      expect(events.every((event) => event.id === call.id)).toBe(true);
      expect(events.filter((event) => event.kind === "update")).toEqual([]);
      expect(events.map((event) => event.kind)).toEqual(
        scenario === "truncated"
          ? ["start", "error"]
          : ["start", "admission", scenario === "blocked" ? "error" : "end"],
      );
      expect(existsSync(path)).toBe(scenario === "valid");
      expect(errors).toEqual([]);
    } finally {
      await session.abort();
      session.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  10_000,
);
