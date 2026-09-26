import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { selectedModelContinuation } from "../src/advisory/continuation-selected-model";
import { continuationDraftFixture } from "./fixtures/continuation-draft";
import { coverageHost } from "./fixtures/coverage-host";

it("uses actual host continuation dispatch with host-owned auth,512tokens and no tools/retries", async () => {
  const { host, ai } = await coverageHost();
  const cwd = await mkdtemp(join(tmpdir(), "progress-continuation-model-"));
  const providerId = "progress-continuation-proof";
  const key = "SYNTHETIC_HOST_ONLY_CREDENTIAL";
  const credentials = new ai.InMemoryCredentialStore();
  await credentials.modify(providerId, async () => ({ type: "api_key", key }));
  const runtime = await host.ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const faux = ai.fauxProvider({ provider: providerId });
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
  const { request, text } = continuationDraftFixture(
    `${providerId}/${faux.getModel().id}`,
  );
  let providerContext: unknown;
  let providerOptions: unknown;
  let callerOptions: unknown;
  let result: unknown;
  const dispatch = vi.fn(() => true);
  faux.setResponses([
    (context, options) => {
      providerContext = context;
      providerOptions = options;
      return ai.fauxAssistantMessage(text);
    },
  ]);
  const settingsManager = host.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const errors: unknown[] = [];
  const loader = new host.DefaultResourceLoader({
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
            result = await selectedModelContinuation(() => ctx)(
              request,
              new AbortController().signal,
              dispatch,
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
  const { session } = await host.createAgentSession({
    cwd,
    agentDir: join(cwd, "agent"),
    resourceLoader: loader,
    sessionManager: host.SessionManager.inMemory(cwd),
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
      text,
      requestHash: request.requestHash,
      provider: providerId,
      model: faux.getModel().id,
    });
    expect(faux.state.callCount).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const captured = providerContext as {
      systemPrompt?: string;
      tools?: unknown[];
      messages?: unknown[];
    };
    const transcript = ai as unknown as {
      getCurrentSystemPrompt?: (messages: unknown[]) => string;
    };
    const prompt = transcript.getCurrentSystemPrompt
      ? transcript.getCurrentSystemPrompt(captured.messages ?? [])
      : captured.systemPrompt;
    expect(prompt).toMatch(/continuation/i);
    expect(prompt).not.toContain("task lifecycle changes");
    expect(captured.tools ?? []).toEqual([]);
    expect(JSON.stringify(providerContext)).toContain("acceptedIndices");
    expect(providerOptions).toMatchObject({
      apiKey: key,
      maxTokens: 512,
      maxRetries: 0,
      timeoutMs: 60000,
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
}, 15000);
