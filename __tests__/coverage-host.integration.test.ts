import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { coverageHost } from "./fixtures/coverage-host";

// [ref:coverage_not_task_authority] Host proof, not a classifier or production adapter.
it("coverage host pairs canonical results and rejects preappend authority", async () => {
  const { host, ai } = await coverageHost();
  const {
    fauxAssistantMessage,
    fauxProvider,
    fauxToolCall,
    InMemoryCredentialStore,
  } = ai;
  const cwd = await mkdtemp(join(tmpdir(), "coverage-host-"));
  const file = join(cwd, "inventory.txt");
  await writeFile(file, "inventory before late listener");
  const manager = host.SessionManager.inMemory(cwd);
  const settingsManager = host.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const runtime = await host.ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const faux = fauxProvider({ provider: "coverage-host" });
  runtime.registerNativeProvider(faux.provider);
  const read = fauxToolCall("read", { path: file });
  const missing = fauxToolCall("read", { path: join(cwd, "missing.txt") });
  faux.setResponses([
    fauxAssistantMessage([read, missing], { stopReason: "toolUse" }),
    fauxAssistantMessage("Finished the attempted reads."),
  ]);
  const starts: string[] = [];
  const ends: { id: string; error: boolean; alreadyCanonical: boolean }[] = [];
  const preappend: string[] = [];
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
        pi.on("tool_execution_start", (event) => {
          starts.push(event.toolCallId);
        });
        pi.on("tool_execution_end", (event, ctx) => {
          ends.push({
            id: event.toolCallId,
            error: event.isError,
            alreadyCanonical: ctx.sessionManager
              .getBranch()
              .some(
                (entry) =>
                  entry.type === "message" &&
                  entry.message.role === "toolResult" &&
                  entry.message.toolCallId === event.toolCallId,
              ),
          });
        });
        pi.on("message_end", (event, ctx) => {
          const message = event.message;
          if (message.role !== "toolResult") return;
          expect(
            ctx.sessionManager
              .getBranch()
              .some(
                (entry) =>
                  entry.type === "message" &&
                  entry.message.role === "toolResult" &&
                  entry.message.toolCallId === message.toolCallId,
              ),
          ).toBe(false);
          preappend.push(message.toolCallId);
        });
      },
      (pi) => {
        pi.on("message_end", (event) => {
          if (
            event.message.role === "toolResult" &&
            event.message.toolCallId === read.id
          ) {
            return {
              message: {
                ...event.message,
                content: [
                  { type: "text", text: "canonical replacement inventory" },
                ],
              },
            };
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
    sessionManager: manager,
    settingsManager,
    modelRuntime: runtime,
    model: faux.getModel(),
    tools: ["read"],
    thinkingLevel: "off",
  });
  try {
    await session.bindExtensions({
      mode: "print",
      onError: (error) => errors.push(error),
    });
    await session.prompt("Read every item in the inventory.");
    expect(errors).toEqual([]);
    expect(
      session.messages.filter(
        (message) =>
          message.role === "assistant" && message.stopReason === "error",
      ),
    ).toEqual([]);
    expect(starts).toEqual([read.id, missing.id]);
    expect(preappend).toEqual([read.id, missing.id]);
    expect(ends).toEqual(
      expect.arrayContaining([
        { id: read.id, error: false, alreadyCanonical: false },
        { id: missing.id, error: true, alreadyCanonical: false },
      ]),
    );
    const branch = manager.getBranch();
    const results = branch.filter(
      (entry) =>
        entry.type === "message" && entry.message.role === "toolResult",
    );
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      message: {
        toolCallId: read.id,
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "canonical replacement inventory" }],
      },
    });
    expect(results[1]).toMatchObject({
      message: { toolCallId: missing.id, isError: true },
    });
    const first = branch.find(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    if (!first) throw new Error("Missing canonical root");
    manager.branch(first.id);
    expect(
      manager
        .getBranch()
        .some((entry) => results.some((result) => result.id === entry.id)),
    ).toBe(false);
    expect(
      manager
        .getEntries()
        .some((entry) => results.some((result) => result.id === entry.id)),
    ).toBe(true);
    expect(faux.state.callCount).toBe(2);
  } finally {
    await session.abort();
    session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}, 15000);
