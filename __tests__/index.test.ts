import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import extension from "../src/index";
import { addPatch, observation } from "./fixtures/hybrid";
import { branchEntry, jevReply } from "./fixtures/hybrid-monitor";

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
  const ctx = {
    cwd: "/nonexistent-hybrid-test",
    mode: "tui",
    hasUI: true,
    model,
    modelRegistry: { complete },
    isIdle: () => true,
    sessionManager: {
      getBranch: () => entries,
      getLeafId: () => "goal",
      getSessionId: () => "session:test",
    },
    ui: { notify, setWidget },
  } as unknown as ExtensionContext;
  const pi = {
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
    notify,
    setWidget,
    emit: async (name: string, event = {}) => {
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
  expect(h.checkpoints.at(-1)).toMatchObject({ version: 6 });
  expect(JSON.stringify(h.checkpoints.at(-1))).toContain("Implement parser");
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

it.each([{ version: 5, state: {} }, { version: 6 }])(
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
