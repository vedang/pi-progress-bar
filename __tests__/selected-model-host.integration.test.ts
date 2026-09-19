import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  fauxAssistantMessage,
  fauxProvider,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import * as pinnedPi from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { extractionInput } from "../src/analysis/extractor";
import { emptyState } from "../src/core/hybrid-state";
import { selectedModelExtractor } from "../src/core/selected-model";
import { initialMessage, noPatch } from "./fixtures/hybrid";

it("uses actual Pi selected-model dispatch and host-managed credentials with no tools or provider retry", async () => {
  const {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
  } = process.env.PROGRESS_PI_HOST_ROOT
    ? ((await import(
        pathToFileURL(join(process.env.PROGRESS_PI_HOST_ROOT, "dist/index.js"))
          .href
      )) as typeof pinnedPi)
    : pinnedPi;
  const cwd = await mkdtemp(join(tmpdir(), "progress-selected-model-"));
  const credentials = new InMemoryCredentialStore();
  const providerId = "progress-selected-model-proof";
  const key = "SYNTHETIC_HOST_ONLY_CREDENTIAL";
  await credentials.modify(providerId, async () => ({ type: "api_key", key }));
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const faux = fauxProvider({ provider: providerId });
  runtime.registerNativeProvider({
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Synthetic credential",
        resolve: async ({ credential }) =>
          credential?.key ? { auth: { apiKey: credential.key } } : undefined,
      },
    },
  });
  let providerOptions: unknown;
  let providerContext: unknown;
  faux.setResponses([
    (context, options) => {
      providerContext = context;
      providerOptions = options;
      return fauxAssistantMessage(JSON.stringify(noPatch()));
    },
  ]);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const errors: unknown[] = [];
  let result: unknown;
  let callerOptions: unknown;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        pi.on("session_start", async (_event, ctx) => {
          const spy = vi.spyOn(ctx.modelRegistry, "complete");
          try {
            result = await selectedModelExtractor(() => ctx)(
              extractionInput(emptyState("session:test"), initialMessage, []),
              new AbortController().signal,
            );
            callerOptions = spy.mock.calls[0]?.[2];
          } finally {
            spy.mockRestore();
          }
        });
      },
    ],
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
    tools: [],
    thinkingLevel: "off",
  });
  try {
    await session.bindExtensions({
      mode: "print",
      onError: (error) => errors.push(error),
    });
    expect(errors).toEqual([]);
    expect(result).toMatchObject({
      text: JSON.stringify(noPatch()),
      provider: providerId,
      model: faux.getModel().id,
    });
    expect(faux.state.callCount).toBe(1);
    expect(providerContext).toMatchObject({
      tools: [],
      messages: [{ role: "user" }],
    });
    expect((providerContext as { messages: unknown[] }).messages).toHaveLength(
      1,
    );
    expect(providerOptions).toMatchObject({
      apiKey: key,
      maxTokens: 2048,
      maxRetries: 0,
      timeoutMs: 60_000,
      signal: expect.any(AbortSignal),
    });
    expect(callerOptions).not.toHaveProperty("apiKey");
    expect(JSON.stringify(providerContext)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally {
    await session.abort();
    session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}, 15_000);
