import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  fauxAssistantMessage,
  fauxProvider,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as pinnedPi from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import progressBar from "../src/index";

it.each(["trigger", "steer", "followUp", "idle"] as const)(
  "actual Pi admits intercom %s delivery once from the canonical branch",
  async (mode) => {
    const pi = process.env.PROGRESS_PI_HOST_ROOT
      ? ((await import(
          pathToFileURL(
            join(process.env.PROGRESS_PI_HOST_ROOT, "dist/index.js"),
          ).href
        )) as typeof pinnedPi)
      : pinnedPi;
    const cwd = await mkdtemp(join(tmpdir(), "progress-intercom-host-"));
    const settingsManager = pi.SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const manager = pi.SessionManager.create(cwd, join(cwd, "sessions"));
    const runtime = await pi.ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const faux = fauxProvider({ provider: "progress-intercom-host" });
    runtime.registerNativeProvider(faux.provider);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    faux.setResponses([
      async () => {
        started = true;
        if (mode === "steer" || mode === "followUp") await held;
        return fauxAssistantMessage("Acknowledged.");
      },
      fauxAssistantMessage("Delegation acknowledged."),
    ]);
    const assessed: { id: string; role: string; text: string }[] = [];
    vi.stubEnv("TYPESAFE_API_KEY", "offline-host-fixture");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body));
        expect(Object.keys(request.questions)).toEqual(["gate"]);
        assessed.push(request.state.latest);
        return Response.json({
          model: "jev-1.13.0",
          usage: { input_tokens: 1, output_tokens: 1 },
          answers: {
            gate: {
              type: "choice",
              choice: "unchanged",
              confidence: 1,
              probabilities: { changed: 0, unchanged: 1, uncertain: 0 },
            },
          },
        });
      }),
    );
    let api: ExtensionAPI | undefined;
    const errors: unknown[] = [];
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
        progressBar,
        (extension) => {
          api = extension;
        },
      ],
    });
    await loader.reload();
    const { session } = await pi.createAgentSession({
      cwd,
      agentDir: join(cwd, "agent"),
      resourceLoader: loader,
      sessionManager: manager,
      settingsManager,
      modelRuntime: runtime,
      model: faux.getModel(),
      tools: [],
      thinkingLevel: "off",
    });
    let running: Promise<void> | undefined;
    try {
      await session.bindExtensions({
        mode: "print",
        onError: (error) => errors.push(error),
      });
      if (mode === "steer" || mode === "followUp") {
        running = session.prompt("Initial unrelated greeting.");
        await vi.waitFor(() => expect(started).toBe(true));
      }
      const content =
        "**From orgtok** (/work/orgtok.v2)\n\nPlease inspect the parser regression.";
      api?.sendMessage(
        {
          customType: "intercom_message",
          content,
          display: true,
          details: {
            from: { id: "orgtok", cwd: "/work/orgtok.v2" },
            message: { id: "delivery-1", expectsReply: mode === "trigger" },
          },
        },
        mode === "trigger"
          ? { triggerTurn: true }
          : mode === "idle"
            ? { triggerTurn: false }
            : { deliverAs: mode },
      );
      release();
      await running;
      if (mode === "idle") {
        // Pi persists idle custom messages without firing ExtensionRunner hooks.
        // No polling: the next actual turn exposes the pending canonical record.
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(assessed.filter((o) => o.role === "intercom")).toHaveLength(0);
        await session.prompt("Please continue with the delegated request.");
      }
      await vi.waitFor(
        () =>
          expect(assessed.filter((o) => o.role === "intercom")).toHaveLength(1),
        { timeout: 2000 },
      );
      const custom = manager
        .getBranch()
        .find(
          (entry) =>
            entry.type === "custom_message" &&
            entry.customType === "intercom_message",
        );
      expect(custom).toBeDefined();
      expect(assessed.find((o) => o.role === "intercom")).toMatchObject({
        id: custom?.id,
        text: content,
      });
      expect(
        manager
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "message" && entry.message.role === "user",
          ),
      ).toHaveLength(mode === "trigger" ? 0 : 1);
      await session.agent.waitForIdle();
      // Re-observing on ON must not bill the accepted inbound entry again.
      await session.prompt("/progress on");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(assessed.filter((o) => o.role === "intercom")).toHaveLength(1);
      expect(errors).toEqual([]);
      await session.prompt("/progress off");
    } finally {
      release();
      await session.abort();
      await running?.catch(() => {});
      session.dispose();
      vi.unstubAllEnvs();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  10000,
);
