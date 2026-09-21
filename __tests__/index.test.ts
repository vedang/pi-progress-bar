import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import extension from "../src/index";
import { addPatch, observation } from "./fixtures/hybrid";
import { branchEntry, jevReply } from "./fixtures/hybrid-monitor";
import {
  detailAddExtraction,
  isDetailRequest,
  savedDetails,
} from "./fixtures/task-details";

type Handler = (event: never, ctx: ExtensionContext) => unknown;
function host() {
  let entries: unknown[] = [];
  const handlers = new Map<string, Handler>();
  let command:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  const checkpoints: unknown[] = [];
  const model = { id: "selected-model", provider: "offline" };
  const complete = vi.fn(async () => ({
    role: "assistant",
    content: [
      {
        type: "text",
        text: JSON.stringify(
          addPatch(
            observation(
              "goal",
              "Implement parser, add regression, and validate it.",
            ),
          ),
        ),
      },
    ],
    stopReason: "stop",
    usage: { input: 3, output: 2 },
  }));
  const notify = vi.fn();
  const setWidget = vi.fn();
  const sendMessage = vi.fn();
  const hasPendingMessages = vi.fn(() => false);
  const ctx = {
    cwd: "/nonexistent-hybrid-test",
    mode: "tui",
    hasUI: true,
    model,
    modelRegistry: { complete },
    isIdle: () => true,
    hasPendingMessages,
    sessionManager: {
      getBranch: () => entries,
      getLeafId: () => {
        const last = entries.at(-1);
        return last && typeof last === "object"
          ? Reflect.get(last, "id")
          : "goal";
      },
      getSessionId: () => "session:test",
    },
    ui: { notify, setWidget },
  } as unknown as ExtensionContext;
  const pi = {
    sendMessage,
    getAllTools: () => [
      {
        name: "write",
        sourceInfo: {
          path: "<builtin:write>",
          source: "builtin",
          scope: "temporary",
          origin: "top-level",
        },
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
      {
        name: "subagent",
        sourceInfo: {
          path: "/agent/git/github.com/nicobailon/pi-subagents/index.ts",
          source: "git:github.com/nicobailon/pi-subagents",
          scope: "user",
          origin: "package",
        },
        parameters: {
          type: "object",
          properties: {
            workflow: { type: "string" },
            args: { type: "object" },
            async: { type: "boolean" },
          },
        },
      },
    ],
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (_name: string, options: { handler: typeof command }) => {
      command = options.handler;
    },
    appendEntry: (_name: string, value: unknown) =>
      checkpoints.push(structuredClone(value)),
  } as unknown as ExtensionAPI;
  extension(pi);
  return {
    handlers,
    ctx,
    model,
    complete,
    checkpoints,
    sendMessage,
    hasPendingMessages,
    notify,
    setWidget,
    emit: async (name: string, event = {}) => {
      if (name === "agent_start")
        await handlers.get("before_agent_start")?.(
          {
            systemPromptOptions: {
              cwd: ctx.cwd,
              contextFiles: [
                {
                  path: `${ctx.cwd}/AGENTS.md`,
                  content:
                    "Preserve existing validation. No mandatory new tests.",
                },
              ],
            },
          } as never,
          ctx,
        );
      if (name === "tool_execution_start") {
        const toolCallId = Reflect.get(event, "toolCallId");
        entries = [
          ...entries,
          {
            type: "message",
            id: `assistant-${toolCallId}`,
            parentId: ctx.sessionManager.getLeafId(),
            message: {
              role: "assistant",
              stopReason: "toolUse",
              content: [
                {
                  type: "text",
                  text: "Starting a new failing parser test or the declared review of partial parser work.",
                },
                {
                  type: "toolCall",
                  id: toolCallId,
                  name: Reflect.get(event, "toolName"),
                  arguments: Reflect.get(event, "args"),
                },
              ],
            },
          },
        ];
      }
      await handlers.get(name)?.(event as never, ctx);
    },
    setEntries: (next: unknown[]) => {
      entries = next;
    },
    command: async (text: string) => {
      if (!command) throw new Error("No progress command");
      await command(text, ctx as ExtensionCommandContext);
    },
  };
}
const hosts: ReturnType<typeof host>[] = [];
function fixture() {
  const h = host();
  hosts.push(h);
  return h;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) =>
      jevReply(JSON.parse(String(init?.body))),
    ),
  );
});
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.emit("session_shutdown");
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("uses canonical context rather than preappend message_end, through the host-selected model", async () => {
  const h = fixture();
  await h.emit("session_start");
  await h.emit("message_end", {
    message: { role: "user", content: "uncommitted" },
  });
  await vi.advanceTimersByTimeAsync(20);
  expect(h.complete).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  h.setEntries([
    branchEntry("goal", "Implement parser, add regression, and validate it."),
  ]);
  await h.emit("context");
  await vi.advanceTimersByTimeAsync(500);
  expect(h.complete).toHaveBeenCalledTimes(1);
  const args = h.complete.mock.calls[0] as unknown as [
    unknown,
    { tools: unknown[]; messages: unknown[]; systemPrompt: string },
    { maxRetries: number; maxTokens: number; signal: AbortSignal },
  ];
  expect(args[0]).toBe(h.model);
  expect(args[1].tools).toEqual([]);
  expect(args[1].messages).toHaveLength(1);
  expect(args[2]).toMatchObject({ maxRetries: 0, maxTokens: 2048 });
  expect(args[2].signal).toBeInstanceOf(AbortSignal);
  expect(JSON.stringify(args[1])).not.toContain("offline-key");
  expect(h.checkpoints.at(-1)).toMatchObject({ version: 8 });
  expect(JSON.stringify(h.checkpoints.at(-1))).toContain("Implement parser");
});
it("enables calibrated grounded details on the production extension path", async () => {
  const h = fixture();
  const reply = await h.complete();
  h.complete.mockClear();
  h.complete.mockResolvedValue({
    ...reply,
    content: [{ type: "text", text: JSON.stringify(detailAddExtraction()) }],
  });
  await h.emit("session_start");
  h.setEntries([
    branchEntry("goal", "Implement parser, add regression, and validate it."),
  ]);
  await h.emit("context");
  await vi.advanceTimersByTimeAsync(500);
  expect(h.complete).toHaveBeenCalledTimes(1);
  const requests = vi
    .mocked(fetch)
    .mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(requests.filter(isDetailRequest)).toHaveLength(1);
  expect(savedDetails(h.checkpoints.at(-1))[0]?.receipts).toHaveLength(1);
});

it("keeps commands passive and OFF idempotent without enabling debugger commands", async () => {
  const h = fixture();
  await h.emit("session_start");
  await h.command("");
  expect(h.notify).toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  await h.command("off");
  await h.command("off");
  expect(h.setWidget).toHaveBeenCalledWith("pi-progress-bar", undefined);
  await h.command("debugger on");
  expect(h.notify.mock.calls.at(-1)?.[0]).toMatch(/Unknown progress command/i);
  expect(h.handlers.has("model_select")).toBe(true);
});
it("holds a provider failure without leaking it or rebilling the gate, then resumes on model selection", async () => {
  const h = fixture();
  h.complete.mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_SENTINEL"));
  h.setEntries([
    branchEntry("goal", "Implement parser, add regression, and validate it."),
  ]);
  await h.emit("session_start");
  await vi.advanceTimersByTimeAsync(500);
  expect(h.complete).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(h.checkpoints)).not.toContain(
    "PRIVATE_PROVIDER_SENTINEL",
  );
  await h.emit("context");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.complete).toHaveBeenCalledTimes(1);
  await h.emit("model_select", { model: h.model });
  await vi.advanceTimersByTimeAsync(500);
  expect(h.complete).toHaveBeenCalledTimes(2);
  const calls = vi
    .mocked(fetch)
    .mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(calls.filter((request) => request.questions.gate)).toHaveLength(1);
  expect(JSON.stringify(h.checkpoints.at(-1))).toContain("Implement parser");
});

it("stays OFF without a key and does not invoke the selected model", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "");
  const h = fixture();
  h.setEntries([
    branchEntry("goal", "Implement parser, add regression, and validate it."),
  ]);
  await h.emit("session_start");
  await vi.advanceTimersByTimeAsync(500);
  expect(h.complete).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(JSON.stringify(h.notify.mock.calls)).toMatch(/TYPESAFE_API_KEY/);
});

it.each([{ version: 7, state: {} }, { version: 8 }])(
  "preserves rejected stored checkpoint through host restore and progress on: %j",
  async (data) => {
    const h = fixture();
    const saved = {
      type: "custom",
      id: "saved-progress",
      customType: "pi-progress-bar",
      data,
    };
    h.setEntries([
      branchEntry("goal", "Implement parser, add regression, and validate it."),
      saved,
    ]);
    await h.emit("session_start");
    await vi.advanceTimersByTimeAsync(100);
    await h.command("on");
    await h.emit("context");
    await h.emit("turn_end");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.checkpoints).toEqual([]);
    expect(h.complete).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(
      h.notify.mock.calls.some(([message]) =>
        /fresh session/i.test(String(message)),
      ),
    ).toBe(true);
    expect(saved.data).toEqual(data);
  },
);

it("preserves a matching saved entry with no data as corrupt storage", async () => {
  const h = fixture();
  const saved = {
    type: "custom",
    id: "saved-progress",
    customType: "pi-progress-bar",
  };
  h.setEntries([
    branchEntry("goal", "Implement parser, add regression, and validate it."),
    saved,
  ]);
  await h.emit("session_start");
  await vi.advanceTimersByTimeAsync(100);
  await h.command("on");
  await h.emit("context");
  await h.emit("turn_end");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.checkpoints).toEqual([]);
  expect(h.complete).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(
    h.notify.mock.calls.some(([message]) =>
      /fresh session/i.test(String(message)),
    ),
  ).toBe(true);
  expect(Object.hasOwn(saved, "data")).toBe(false);
});

it("explains widget inspection without exposing debugger aggregates in ordinary help", async () => {
  const h = fixture();
  await h.emit("session_start");
  await h.command("");
  const help = String(h.notify.mock.calls.at(-1)?.[0]);
  expect(help).toMatch(/Right|→/);
  expect(help).toMatch(/Enter/i);
  expect(help).toMatch(/Left|Esc/i);
  expect(help).not.toMatch(/Diagnostics:/);
  expect(help).toMatch(/dispatch|requests/i);
});

it("keeps one widget generation across fresh per-event context wrappers", async () => {
  const h = fixture();
  await h.emit("session_start");
  const installs = () =>
    h.setWidget.mock.calls.filter(([, widget]) => typeof widget === "function")
      .length;
  expect(installs()).toBe(1);
  const start = h.handlers.get("agent_start");
  await start?.({} as never, { ...h.ctx });
  const end = h.handlers.get("agent_settled");
  await end?.({} as never, { ...h.ctx });
  expect(installs()).toBe(1);
});

async function advisoryFixture() {
  const h = fixture();
  h.setEntries([
    branchEntry("goal", "Implement parser, add regression, and validate it."),
  ]);
  await h.emit("session_start");
  await vi.advanceTimersByTimeAsync(100);
  await h.emit("agent_start");
  await h.emit("agent_settled");
  return h;
}
it("wires settled readiness to one custom reconciliation question at60s", async () => {
  const h = await advisoryFixture();
  await vi.advanceTimersByTimeAsync(59_999);
  expect(h.sendMessage).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
  expect(h.sendMessage.mock.calls[0]).toEqual([
    expect.objectContaining({
      customType: "pi-progress-advisory",
      display: true,
      content: expect.stringContaining(
        "What is the actual status of each task?",
      ),
      details: {
        kind: "reconciliation",
        opportunityId: expect.any(String),
        sendId: expect.any(String),
      },
    }),
    { deliverAs: "steer", triggerTurn: true },
  ]);
});
it("master OFF cancels pending reminder; ON alone does not revive it", async () => {
  const h = await advisoryFixture();
  await vi.advanceTimersByTimeAsync(30_000);
  await h.command("off");
  await vi.advanceTimersByTimeAsync(40_000);
  await h.command("on");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.sendMessage).not.toHaveBeenCalled();
  await h.emit("agent_start");
  await h.emit("agent_settled");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
});
it("new input cancels the prior opportunity before the next run starts", async () => {
  const h = await advisoryFixture();
  await vi.advanceTimersByTimeAsync(30_000);
  await h.emit("input", {
    text: "Continue implementation",
    source: "interactive",
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.sendMessage).not.toHaveBeenCalled();
});
it.each(["print", "json"] as const)(
  "does not deliver delayed advice in %s mode",
  async (mode) => {
    const h = await advisoryFixture();
    Reflect.set(h.ctx, "mode", mode);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sendMessage).not.toHaveBeenCalled();
  },
);
it("RPC delivers custom message without requiring TUI rendering", async () => {
  const h = await advisoryFixture();
  Reflect.set(h.ctx, "mode", "rpc");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
});
it("shutdown/reload abandons pending opportunity until a fresh independent settlement", async () => {
  const h = await advisoryFixture();
  await vi.advanceTimersByTimeAsync(30_000);
  await h.emit("session_shutdown");
  await h.emit("session_start");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.sendMessage).not.toHaveBeenCalled();
  await h.emit("agent_start");
  await h.emit("agent_settled");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
});
it("canonical own response and duplicate settlement never recursively rearm", async () => {
  const h = await advisoryFixture();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
  const sent = h.sendMessage.mock.calls[0][0];
  await h.emit("agent_start");
  h.setEntries([
    ...h.ctx.sessionManager.getBranch(),
    { type: "custom_message", id: "advice", parentId: "goal", ...sent },
  ]);
  await h.emit("context");
  await h.emit("agent_settled");
  await h.emit("agent_settled");
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
});

it("active user steer preserves the current run for the next independent opportunity", async () => {
  const h = await advisoryFixture();
  await h.emit("agent_start");
  await h.emit("input", {
    text: "Also continue the regression",
    source: "interactive",
  });
  // Real Pi may finish queued active input without another agent_start.
  await h.emit("agent_settled");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
});

function admitCorrection() {
  const transport = vi.mocked(fetch).getMockImplementation();
  if (!transport) throw new Error("Missing fetch fixture");
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (
      !Object.keys(request.questions).some((key) => key.startsWith("correct:"))
    )
      return transport(url, init);
    return Response.json({
      model: "jev-1.13.0",
      usage: { input_tokens: 2, output_tokens: 1 },
      answers: Object.fromEntries(
        Object.keys(request.questions).map((key) => [
          key,
          {
            type: "choice",
            choice: key === "correct:task:1" ? "nudge" : "unrelated",
            confidence: 1,
            probabilities: {
              nudge: key === "correct:task:1" ? 1 : 0,
              required: 0,
              unrelated: key === "correct:task:1" ? 0 : 1,
              unknown: 0,
            },
          },
        ]),
      ),
    });
  });
}
it("delivers attempted-write correction immediately under master ON", async () => {
  const h = await advisoryFixture();
  admitCorrection();
  Reflect.set(h.ctx, "isIdle", () => false);
  await h.emit("agent_start");
  const event = {
    toolCallId: "test-attempt",
    toolName: "write",
    args: {
      path: "__tests__/parser.test.ts",
      content: "PRIVATE_RAW_TEST_BODY",
    },
  };
  await h.emit("tool_execution_start", event);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
  expect(h.sendMessage.mock.calls[0][0]).toMatchObject({
    details: { kind: "test-correction" },
    content: expect.stringContaining("does not need a failing test"),
  });
  expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain(
    "PRIVATE_RAW_TEST_BODY",
  );
  await h.emit("tool_execution_start", event);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
});
it("observes a named launched review passively and emits exact corrective advice", async () => {
  const h = await advisoryFixture();
  admitCorrection();
  Reflect.set(h.ctx, "isIdle", () => false);
  await h.emit("agent_start");
  const args = {
    workflow: "review",
    args: { task: "PRIVATE_REVIEW_TASK" },
    async: false,
  };
  await h.emit("tool_execution_start", {
    toolCallId: "review-attempt",
    toolName: "subagent",
    args,
  });
  expect(h.sendMessage).not.toHaveBeenCalled();
  const partialResult = {
    content: [{ type: "text", text: "PRIVATE_CHILD_BODY" }],
    details: {
      mode: "workflow",
      runId: "workflow-1",
      workflow: {
        resource: {
          kind: "workflow",
          name: "review",
          version: 1,
          invocation: "named",
          expansion: "resolved",
          id: "00000000-0000-4000-8000-000000000001",
        },
      },
      workflowChildren: {
        version: 1,
        parentToolCallId: "review-attempt",
        workflowRunId: "workflow-1",
        inventoryComplete: false,
        workflowState: "running",
        children: [
          {
            childId: "review",
            state: "running",
            runId: "child-1",
            agent: "reviewer",
          },
        ],
      },
    },
  };
  await h.emit("tool_execution_update", {
    toolCallId: "review-attempt",
    toolName: "subagent",
    args,
    partialResult,
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
  expect(h.sendMessage.mock.calls[0][0]).toMatchObject({
    details: { kind: "review-correction" },
    content:
      "Reviewing the work done so far is premature. Please cancel the review and continue with the implementation. It is better to review the work when a bigger chunk of it has been completed.",
  });
  expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain(
    "PRIVATE_CHILD_BODY",
  );
  expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain(
    "PRIVATE_REVIEW_TASK",
  );
});

it.each(["settled", "new-start", "blocked-tool"] as const)(
  "fences held correction across %s without cancelling a blocked attempt",
  async (boundary) => {
    const h = await advisoryFixture();
    admitCorrection();
    const transport = vi.mocked(fetch).getMockImplementation();
    if (!transport) throw new Error("transport");
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const request = JSON.parse(String(init?.body));
      if (
        Object.keys(request.questions).some((key) => key.startsWith("correct:"))
      )
        await pending;
      return transport(url, init);
    });
    Reflect.set(h.ctx, "isIdle", () => false);
    await h.emit("agent_start");
    await h.emit("tool_execution_start", {
      toolCallId: "late-test",
      toolName: "write",
      args: { path: "tests/parser.test.ts", content: "// test" },
    });
    await vi.advanceTimersByTimeAsync(20);
    if (boundary === "settled") {
      Reflect.set(h.ctx, "isIdle", () => true);
      await h.emit("agent_settled");
    } else if (boundary === "new-start") {
      await h.emit("agent_start");
    } else {
      await h.emit("tool_execution_end", {
        toolCallId: "late-test",
        toolName: "write",
        result: { content: [{ type: "text", text: "blocked" }] },
        isError: true,
      });
    }
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sendMessage).toHaveBeenCalledTimes(
      boundary === "blocked-tool" ? 1 : 0,
    );
  },
);

it("cancels correction retries when its canonical relevance changes", async () => {
  const h = await advisoryFixture();
  admitCorrection();
  Reflect.set(h.ctx, "isIdle", () => false);
  await h.emit("agent_start");
  await h.emit("tool_execution_start", {
    toolCallId: "stale-retry",
    toolName: "write",
    args: { path: "tests/parser.test.ts", content: "// test" },
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
  h.setEntries([
    ...h.ctx.sessionManager.getBranch(),
    branchEntry(
      "revised-authority",
      "The implementation is complete; reconsider the prior test assessment.",
      "assistant",
    ),
  ]);
  await h.emit("context");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
});
