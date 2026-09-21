import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as pinnedPi from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { processObservation } from "../src/core/hybrid";
import { encodeCheckpoint } from "../src/core/hybrid-checkpoint";
import { emptyState } from "../src/core/hybrid-state";
import progressBar from "../src/index";
import { addPatch, backend, observation } from "./fixtures/hybrid";
import { jevReply } from "./fixtures/hybrid-monitor";

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
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Advisory host probe stalled")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Mode = "tui" | "print" | "json" | "rpc";
type Trace = {
  hook: string;
  at: number;
  idle: boolean;
  pending: boolean;
  leaf: string | null;
  customIds: string[];
  roles: string[];
  stop?: string;
};
const message = {
  customType: "pi-progress-advisory",
  content:
    "[Progress advisory] Status reconciliation only: explain task status.",
  display: true,
  details: {
    opportunityId: "opportunity-1",
    sendId: "send-1",
    kind: "reconciliation",
  },
};

async function host(
  mode: Mode,
  settings: Parameters<typeof pinnedPi.SettingsManager.inMemory>[0] = {},
  production = false,
  correctionProof = false,
) {
  const pi = process.env.PROGRESS_PI_HOST_ROOT
    ? ((await import(
        pathToFileURL(join(process.env.PROGRESS_PI_HOST_ROOT, "dist/index.js"))
          .href
      )) as typeof pinnedPi)
    : pinnedPi;
  const cwd = await mkdtemp(join(tmpdir(), "progress-advisory-host-"));
  const settingsManager = pi.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    ...settings,
  });
  const manager = pi.SessionManager.create(cwd, join(cwd, "sessions"));
  if (production) {
    const text = "Implement parser and add regression tests.";
    const id = manager.appendMessage({
      role: "user",
      content: text,
      timestamp: Date.now(),
    });
    const source = observation(id, text);
    const state = await processObservation(
      emptyState(manager.getSessionId()),
      source,
      backend(addPatch(source)),
    );
    manager.appendCustomEntry("pi-progress-bar", encodeCheckpoint(state));
  }
  const runtime = await pi.ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const faux = fauxProvider({ provider: "progress-advisory-host" });
  runtime.registerNativeProvider(faux.provider);
  let api: ExtensionAPI | undefined;
  let context: ExtensionContext | undefined;
  const trace: Trace[] = [];
  const errors: unknown[] = [];
  const sent: Parameters<ExtensionAPI["sendMessage"]>[0][] = [];
  const settled = latch();
  const record = (hook: string, ctx: ExtensionContext, stop?: string) => {
    context = ctx;
    const branch = ctx.sessionManager.getBranch();
    trace.push({
      hook,
      at: performance.now(),
      idle: ctx.isIdle(),
      pending: ctx.hasPendingMessages(),
      leaf: ctx.sessionManager.getLeafId(),
      customIds: branch
        .filter((e) => e.type === "custom_message")
        .map((e) => e.id),
      roles: branch.flatMap((e) =>
        e.type === "message" ? [e.message.role] : [],
      ),
      stop,
    });
  };
  const loader = new pi.DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    appendSystemPrompt: correctionProof
      ? ["Loaded policy: preserve existing validation; new tests are optional."]
      : [],
    extensionFactories: [
      ...(production
        ? [
            (extension: ExtensionAPI) =>
              progressBar({
                ...extension,
                sendMessage: (message, options) => {
                  sent.push(message);
                  extension.sendMessage(message, options);
                },
              }),
          ]
        : []),
      (extension) => {
        api = extension;
        if (correctionProof)
          extension.on("tool_call", async () => {
            await vi.waitFor(() => expect(sent).toHaveLength(1), {
              timeout: 3000,
            });
            return {
              block: true,
              reason: "Offline attempted-start transport proof",
            };
          });
        extension.on("session_start", (_e, ctx) =>
          record("session_start", ctx),
        );
        extension.on("input", (e, ctx) => record(`input:${e.source}`, ctx));
        extension.on("before_agent_start", (_e, ctx) =>
          record("before_agent_start", ctx),
        );
        extension.on("agent_start", (_e, ctx) => record("agent_start", ctx));
        extension.on("context", (_e, ctx) => record("context", ctx));
        extension.on("message_end", (e, ctx) => {
          if (
            correctionProof &&
            e.message.role === "assistant" &&
            e.message.content.some((block) => block.type === "toolCall")
          ) {
            e.message.content.unshift({
              type: "text",
              text: "FINAL_POST_LISTENER: starting a new failing parser test now.",
            });
          }
          record(
            `message_end:${e.message.role}`,
            ctx,
            e.message.role === "assistant" ? e.message.stopReason : undefined,
          );
        });
        extension.on("agent_end", (_e, ctx) => record("agent_end", ctx));
        extension.on("agent_settled", (_e, ctx) => {
          record("agent_settled", ctx);
          settled.release();
        });
        extension.on("session_before_tree", (_e, ctx) =>
          record("session_before_tree", ctx),
        );
        extension.on("session_tree", (_e, ctx) => record("session_tree", ctx));
        extension.on("session_shutdown", (e, ctx) =>
          record(`session_shutdown:${e.reason}`, ctx),
        );
        extension.on("session_before_compact", (event, ctx) => {
          record(`session_before_compact:${event.reason}`, ctx);
          return {
            compaction: {
              summary: "Synthetic host summary",
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
            },
          };
        });
        extension.on("session_compact", (event, ctx) =>
          record(`session_compact:${event.reason}`, ctx),
        );
        extension.registerCommand("probe-off", {
          handler: async (_args, ctx) => {
            record("master_off", ctx);
          },
        });
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
    tools: correctionProof ? ["write"] : [],
    thinkingLevel: "off",
  });
  await session.bindExtensions({ mode, onError: (e) => errors.push(e) });
  if (!api || !context) throw new Error("Host did not bind extension");
  return {
    api,
    context,
    manager,
    session,
    faux,
    trace,
    errors,
    sent,
    settled,
    async dispose() {
      if (process.env.PROGRESS_ADVISORY_HOST_ARTIFACT_DIR) {
        await writeFile(
          join(
            process.env.PROGRESS_ADVISORY_HOST_ARTIFACT_DIR,
            `${mode}-${manager.getSessionId()}.json`,
          ),
          JSON.stringify(
            {
              host: process.env.PROGRESS_PI_HOST_ROOT ?? "pinned",
              mode,
              trace,
            },
            null,
            2,
          ),
        );
      }
      await session.abort();
      session.dispose();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

// [tag:advisory_host_origin] This is a real SDK lifecycle matrix, not a claim
// that binding mode alone proves CLI output or TUI rendering.
it.each(["tui", "print", "json", "rpc"] as const)(
  "actual Pi %s binding preserves idle advisory identity without user input or before_agent_start",
  async (mode) => {
    const h = await host(mode);
    try {
      h.faux.setResponses([fauxAssistantMessage("The task remains blocked.")]);
      h.trace.push({
        hook: "send_invocation",
        at: performance.now(),
        idle: h.context.isIdle(),
        pending: h.context.hasPendingMessages(),
        leaf: h.manager.getLeafId(),
        customIds: [],
        roles: [],
      });
      const result = h.api.sendMessage(message, { triggerTurn: true });
      expect(result).toBeUndefined(); // Public ExtensionAPI is fire-and-forget.
      await bounded(h.settled.promise);
      const custom = h.manager
        .getBranch()
        .filter((e) => e.type === "custom_message");
      expect(custom).toHaveLength(1);
      expect(custom[0]).toMatchObject(message);
      expect(h.trace.some((t) => t.hook.startsWith("input:"))).toBe(false);
      expect(h.trace.some((t) => t.hook === "before_agent_start")).toBe(false);
      expect(h.trace.filter((t) => t.hook === "agent_start")).toHaveLength(1);
      expect(h.trace.find((t) => t.hook === "agent_start")?.customIds).toEqual(
        [],
      );
      expect(h.trace.find((t) => t.hook === "context")?.customIds).toEqual([
        custom[0]?.id,
      ]);
      expect(h.trace.filter((t) => t.hook === "agent_settled")).toMatchObject([
        { idle: true, pending: false, roles: ["assistant"] },
      ]);
      expect(h.errors).toEqual([]);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    } finally {
      await h.dispose();
    }
  },
  10000,
);

it.each(["steer", "followUp"] as const)(
  "actual Pi %s queues advisory through public API, then preserves custom identity with mixed user input",
  async (deliverAs) => {
    const h = await host("print");
    const started = latch();
    const release = latch();
    let running: Promise<void> | undefined;
    try {
      h.faux.setResponses([
        async () => {
          started.release();
          await release.promise;
          return fauxAssistantMessage("First answer");
        },
        fauxAssistantMessage("Mixed answer"),
        fauxAssistantMessage("Remaining answer"),
      ]);
      running = h.session.prompt("Independent request");
      await bounded(started.promise);
      h.api.sendMessage(message, { deliverAs });
      // Public pending-message count tracks user queues, not custom steering.
      expect(h.context.hasPendingMessages()).toBe(false);
      expect(
        h.manager.getBranch().some((e) => e.type === "custom_message"),
      ).toBe(false);
      // Measured host visibility, not inferred from our local send intention.
      await h.session.prompt("New external request", {
        streamingBehavior: "steer",
        source: "rpc",
      });
      expect(h.trace.find((t) => t.hook === "input:rpc")).toBeDefined();
      await h.session.prompt("/probe-off");
      expect(h.trace.find((t) => t.hook === "master_off")).toBeDefined();
      release.release();
      await bounded(running);
      await bounded(h.settled.promise);
      // OFF cannot retract an already invoked custom message: this probe's OFF
      // handler intentionally owns no queue API and the host still delivers it.
      expect(
        h.manager.getBranch().filter((e) => e.type === "custom_message"),
      ).toMatchObject([message]);
      expect(h.trace.filter((t) => t.hook === "agent_settled")).toHaveLength(1);
      expect(h.trace.at(-1)).toMatchObject({
        hook: "agent_settled",
        idle: true,
        pending: false,
      });
      expect(h.errors).toEqual([]);
    } finally {
      release.release();
      await running?.catch(() => {});
      await h.dispose();
    }
  },
  10000,
);

it("actual Pi navigation and own custom entries are distinguishable; idle saves do not settle runs", async () => {
  const h = await host("print");
  try {
    h.faux.setResponses([fauxAssistantMessage("Independent answer")]);
    await h.session.prompt("Independent request");
    const anchor = h.manager.getLeafId();
    if (!anchor) throw new Error("Missing anchor");
    const count = h.trace.length;
    h.api.appendEntry("pi-progress-state", { fixture: true });
    const stateLeaf = h.manager.getLeafId();
    expect(stateLeaf).not.toBe(anchor);
    expect(h.manager.getLeafEntry()).toMatchObject({
      type: "custom",
      customType: "pi-progress-state",
      data: { fixture: true },
    });
    h.api.sendMessage(message, { triggerTurn: false });
    expect(h.manager.getLeafId()).not.toBe(stateLeaf);
    expect(h.manager.getLeafEntry()).toMatchObject({
      type: "custom_message",
      ...message,
    });
    expect(h.trace).toHaveLength(count);
    expect(h.api).not.toHaveProperty("clearQueue");
    expect(h.context).not.toHaveProperty("clearQueue");
    await h.session.navigateTree(anchor, { summarize: false });
    expect(h.trace.slice(count).map((t) => t.hook)).toEqual([
      "session_before_tree",
      "session_tree",
    ]);
    expect(h.manager.getBranch().some((e) => e.type === "custom_message")).toBe(
      false,
    );
    expect(h.trace.filter((t) => t.hook === "agent_settled")).toHaveLength(1);
  } finally {
    await h.dispose();
  }
}, 10000);

it("actual Pi mixed advisory/intercom run exposes external custom identity without input hooks", async () => {
  const h = await host("print");
  const started = latch();
  const release = latch();
  let running: Promise<void> | undefined;
  try {
    h.faux.setResponses([
      async () => {
        started.release();
        await release.promise;
        return fauxAssistantMessage("First");
      },
      fauxAssistantMessage("Advisory answer"),
      fauxAssistantMessage("External assignment answer"),
    ]);
    running = h.session.prompt("Independent request");
    await bounded(started.promise);
    const count = h.trace.length;
    h.api.sendMessage(message, { deliverAs: "steer" });
    h.api.sendMessage(
      {
        customType: "intercom_message",
        content: "External assignment",
        display: true,
        details: { message: { id: "external-1" } },
      },
      { deliverAs: "steer" },
    );
    release.release();
    await bounded(running);
    expect(h.trace.slice(count).some((t) => t.hook.startsWith("input:"))).toBe(
      false,
    );
    expect(
      h.manager
        .getBranch()
        .filter((e) => e.type === "custom_message")
        .map((e) => e.customType),
    ).toEqual(["pi-progress-advisory", "intercom_message"]);
    expect(
      h.trace.filter((t) => t.hook === "context").at(-1)?.customIds,
    ).toHaveLength(2);
    expect(h.trace.filter((t) => t.hook === "agent_settled")).toHaveLength(1);
    expect(h.errors).toEqual([]);
  } finally {
    release.release();
    await running?.catch(() => {});
    await h.dispose();
  }
}, 10000);

it("actual Pi transient retry emits one final settlement, not one per low-level agent_end", async () => {
  const h = await host("print", {
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
  });
  try {
    h.faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "429 rate limit",
      }),
      fauxAssistantMessage("Recovered"),
    ]);
    await bounded(h.session.prompt("Independent request"));
    expect(h.faux.state.callCount).toBe(2);
    expect(h.trace.filter((t) => t.hook === "agent_end")).toHaveLength(2);
    expect(h.trace.filter((t) => t.hook === "agent_settled")).toHaveLength(1);
    expect(h.trace.at(-1)).toMatchObject({ hook: "agent_settled", idle: true });
    expect(h.errors).toEqual([]);
  } finally {
    await h.dispose();
  }
}, 10000);

it("actual Pi overflow compacts and retries before final settlement", async () => {
  const h = await host("print", {
    compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 10 },
  });
  try {
    h.faux.setResponses([
      fauxAssistantMessage("First answer"),
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "prompt is too long: 200000 tokens > 128000 maximum",
      }),
      fauxAssistantMessage("Recovered after compaction"),
    ]);
    await h.session.prompt("Earlier request ".repeat(100));
    const count = h.trace.length;
    await bounded(h.session.prompt("Independent later request"));
    const hooks = h.trace.slice(count).map((t) => t.hook);
    expect(h.faux.state.callCount).toBe(3);
    expect(hooks).toContain("session_before_compact:overflow");
    expect(hooks).toContain("session_compact:overflow");
    expect(hooks.filter((hook) => hook === "agent_end")).toHaveLength(2);
    expect(hooks.filter((hook) => hook === "agent_settled")).toHaveLength(1);
    expect(hooks.at(-1)).toBe("agent_settled");
    expect(h.errors).toEqual([]);
  } finally {
    await h.dispose();
  }
}, 10000);

it("actual Pi explicit abort exposes terminal aborted assistant before settlement", async () => {
  const h = await host("print");
  const started = latch();
  let running: Promise<void> | undefined;
  try {
    h.faux.setResponses([
      async (_ctx, options) => {
        started.release();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else
            options?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
        return fauxAssistantMessage("Interrupted");
      },
    ]);
    running = h.session.prompt("Independent request");
    await bounded(started.promise);
    await bounded(h.session.abort());
    await bounded(running);
    const terminal = h.trace.findIndex(
      (t) => t.hook === "message_end:assistant" && t.stop === "aborted",
    );
    expect(terminal).toBeGreaterThan(-1);
    expect(
      h.trace.findIndex((t) => t.hook === "agent_settled"),
    ).toBeGreaterThan(terminal);
    expect(h.trace.filter((t) => t.hook === "agent_settled")).toHaveLength(1);
    const last = h.manager.getBranch().at(-1);
    expect(last).toMatchObject({
      type: "message",
      message: { role: "assistant", stopReason: "aborted" },
    });
  } finally {
    await h.session.abort();
    await running?.catch(() => {});
    await h.dispose();
  }
}, 10000);

it("actual Pi reload emits shutdown then fresh start without rearming a settled run", async () => {
  const h = await host("print");
  try {
    h.faux.setResponses([fauxAssistantMessage("Status remains pending")]);
    h.api.sendMessage(message, { triggerTurn: true });
    await bounded(h.settled.promise);
    const count = h.trace.length;
    await h.session.reload();
    expect(h.trace.slice(count).map((t) => t.hook)).toEqual([
      "session_shutdown:reload",
      "session_start",
    ]);
    expect(
      h.manager.getBranch().filter((e) => e.type === "custom_message"),
    ).toMatchObject([message]);
    expect(h.faux.state.callCount).toBe(1);
    expect(h.trace.filter((t) => t.hook === "agent_settled")).toHaveLength(1);
  } finally {
    await h.dispose();
  }
}, 10000);

it.each([
  ["tui", "normal"],
  ["rpc", "normal"],
  ["rpc", "retry"],
  ["rpc", "compaction"],
] as const)(
  "actual Pi %s runs production reconciliation without recursion through %s",
  async (mode, recovery) => {
    vi.stubEnv("TYPESAFE_API_KEY", "offline-advisory-acceptance");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) =>
        jevReply(JSON.parse(String(init?.body))),
      ),
    );
    const h = await host(
      mode,
      {
        retry: { enabled: recovery === "retry", maxRetries: 1, baseDelayMs: 1 },
        compaction: {
          enabled: recovery === "compaction",
          reserveTokens: 100,
          keepRecentTokens: 10,
        },
      },
      true,
    );
    const nativeTimeout = globalThis.setTimeout;
    const deadlines: Array<{
      callback: () => void;
      timer: ReturnType<typeof setTimeout>;
    }> = [];
    const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      const timer = nativeTimeout(callback, delay, ...args);
      if (delay === 60_000)
        deadlines.push({ callback: () => callback(...args), timer });
      return timer;
    }) as typeof setTimeout);
    let dateSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      h.faux.setResponses([
        fauxAssistantMessage("The parser is still pending."),
        ...(recovery === "normal"
          ? []
          : [
              fauxAssistantMessage("", {
                stopReason: "error",
                errorMessage:
                  recovery === "retry"
                    ? "429 rate limit"
                    : "prompt is too long: 200000 tokens > 128000 maximum",
              }),
            ]),
        fauxAssistantMessage(
          "All three tasks remain pending; no implementation has been completed.",
        ),
      ]);
      await bounded(
        h.session.prompt("Report current status without changing scope."),
      );
      await vi.waitFor(() => expect(deadlines).toHaveLength(1));
      const deadline = deadlines[0];
      const now = Date.now();
      // Accelerate only the extension deadline; actual Pi lifecycle/provider remain real.
      dateSpy = vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
      clearTimeout(deadline.timer);
      deadline.callback();
      await vi.waitFor(() =>
        expect(
          h.manager
            .getBranch()
            .filter(
              (entry) =>
                entry.type === "custom_message" &&
                entry.customType === "pi-progress-advisory",
            ),
        ).toHaveLength(1),
      );
      await vi.waitFor(() =>
        expect(
          h.trace.filter((entry) => entry.hook === "agent_settled"),
        ).toHaveLength(2),
      );
      expect(
        h.trace.filter((entry) => entry.hook === "agent_start"),
      ).toHaveLength(recovery === "normal" ? 2 : 3);
      expect(deadlines).toHaveLength(1);
      const sent = h.manager
        .getBranch()
        .find(
          (entry) =>
            entry.type === "custom_message" &&
            entry.customType === "pi-progress-advisory",
        );
      expect(sent).toMatchObject({
        display: true,
        content: expect.stringContaining(
          "What is the actual status of each task?",
        ),
        details: {
          kind: "reconciliation",
          opportunityId: expect.any(String),
          sendId: expect.any(String),
        },
      });
      expect(h.errors).toEqual([]);
    } finally {
      dateSpy?.mockRestore();
      timerSpy.mockRestore();
      for (const deadline of deadlines) clearTimeout(deadline.timer);
      await h.dispose();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  },
);

it.each(["tui", "rpc"] as const)(
  "actual Pi %s delivers production correction during a builtin attempted start",
  async (mode) => {
    vi.stubEnv("TYPESAFE_API_KEY", "offline-correction-proof");
    let healthCalls = 0;
    let correctionCalls = 0;
    let correctionRequest: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body));
        if (request.questions.redApplicability) healthCalls++;
        const reply = (await jevReply(request).json()) as {
          answers: Record<string, unknown>;
        };
        for (const key of Object.keys(request.questions)) {
          if (!key.startsWith("correct:")) continue;
          if (key === "correct:task:1") {
            correctionCalls++;
            correctionRequest = request;
          }
          const choice = key === "correct:task:1" ? "nudge" : "unrelated";
          reply.answers[key] = {
            type: "choice",
            choice,
            confidence: 1,
            probabilities: {
              nudge: choice === "nudge" ? 1 : 0,
              unrelated: choice === "unrelated" ? 1 : 0,
              required: 0,
              unknown: 0,
            },
          };
        }
        return Response.json(reply);
      }),
    );
    const h = await host(mode, {}, true, true);
    try {
      const initialHealthCalls = healthCalls;
      h.faux.setResponses([
        async () => {
          await vi.waitFor(() =>
            expect(healthCalls).toBeGreaterThan(initialHealthCalls),
          );
          return fauxAssistantMessage(
            [
              fauxToolCall("write", {
                path: "regression.test.ts",
                content: "// PRIVATE_TEST_BODY",
              }),
            ],
            { stopReason: "toolUse" },
          );
        },
        fauxAssistantMessage("The implementation remains pending."),
      ]);
      await bounded(h.session.prompt("Continue the current task."));
      expect(correctionCalls).toBe(1);
      expect(correctionRequest).toMatchObject({
        state: {
          authority: {
            policy: {
              coverage: "complete",
              entries: expect.arrayContaining([
                {
                  role: "system",
                  source: "appendSystemPrompt",
                  text: expect.stringContaining("Loaded policy"),
                },
              ]),
            },
            conversation: expect.arrayContaining([
              { role: "user", text: expect.any(String) },
            ]),
            action: {
              coverage: "complete",
              role: "assistant",
              text: expect.stringContaining("FINAL_POST_LISTENER"),
            },
          },
        },
      });
      expect(JSON.stringify(correctionRequest)).not.toContain(
        "PRIVATE_TEST_BODY",
      );
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]).toMatchObject({
        details: { kind: "test-correction" },
        display: true,
      });
      expect(
        h.manager
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "custom_message" &&
              entry.customType === "pi-progress-advisory",
          ),
      ).toHaveLength(1);
      expect(
        h.trace.filter((entry) => entry.hook === "agent_start"),
      ).toHaveLength(1);
      expect(h.errors).toEqual([]);
    } finally {
      await h.dispose();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  },
);
