import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { selectedModelSubtasks } from "../src/core/subtask-selected-model";
import { coverageHost } from "./fixtures/coverage-host";
import { subtaskSelectedFixture } from "./fixtures/subtask-proposal";

it("actual paired host exposes an abort-ignoring request drain after logical cancellation", async () => {
  const { host, ai } = await coverageHost();
  const cwd = await mkdtemp(join(tmpdir(), "subtask-drain-host-"));
  const runtime = await host.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const faux = ai.fauxProvider({ provider: "subtask-drain-host" });
  runtime.registerNativeProvider(faux.provider);
  const fixture = subtaskSelectedFixture(
    `${faux.getModel().provider}/${faux.getModel().id}`,
  );
  let release = () => {};
  let started = () => {};
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let providerFinished = false;
  faux.setResponses([
    async () => {
      started();
      await pending;
      providerFinished = true;
      return ai.fauxAssistantMessage(fixture.text);
    },
  ]);
  const controller = new AbortController();
  const drains: Promise<void>[] = [];
  let drained = false;
  let outcome: Promise<unknown> | undefined;
  const settingsManager = host.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
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
        pi.on("session_start", (_event, ctx) => {
          outcome = selectedModelSubtasks(() => ctx)(
            fixture.request,
            controller.signal,
            () => true,
            (physical: Promise<void>) => {
              drains.push(physical);
              void physical.then(() => {
                drained = true;
              });
            },
          ).catch((error: unknown) => error);
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
  const errors: unknown[] = [];
  try {
    await session.bindExtensions({
      mode: "print",
      onError: (error) => errors.push(error),
    });
    await entered;
    controller.abort();
    expect(await outcome).toEqual(new Error("Subtask proposal unavailable"));
    expect(errors).toEqual([]);
    expect(providerFinished).toBe(false);
    expect(drains).toHaveLength(1);
    expect(drained).toBe(false);
    release();
    await drains[0];
    expect(providerFinished).toBe(true);
    expect(drained).toBe(true);
    expect(faux.state.callCount).toBe(1);
  } finally {
    controller.abort();
    release();
    await outcome;
    await Promise.all(drains);
    await session.abort();
    session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}, 10000);
