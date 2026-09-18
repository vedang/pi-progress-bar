import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index";

type Handler = (event: never, ctx: ExtensionContext) => unknown;
type Command = {
  handler: (args: string, ctx: ExtensionCommandContext) => unknown;
};
const directories: string[] = [];

async function harness(mode = "tui") {
  const cwd = await mkdtemp(join(tmpdir(), "progress-host-"));
  directories.push(cwd);
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  let branch: unknown[] = [];
  const api = {
    on: vi.fn((name: string, fn: Handler) => handlers.set(name, fn)),
    registerCommand: vi.fn((name: string, cmd: Command) =>
      commands.set(name, cmd),
    ),
    appendEntry: vi.fn(),
    registerTool: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    exec: vi.fn(),
    getAllTools: vi.fn(() => []),
  };
  const ui = {
    setWidget: vi.fn(),
    notify: vi.fn(),
    confirm: vi.fn(async () => true),
    input: vi.fn(async () => ""),
    select: vi.fn(async (_title: string, options: string[]) => options[0]),
    custom: vi.fn(async () => undefined),
    theme: {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    },
  };
  const ctx = {
    cwd,
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui,
    isIdle: () => true,
    isProjectTrusted: () => true,
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => "session-a",
      getLeafId: () => "leaf",
      getEntry: (id: string) =>
        branch.find((x) => (x as { id: string }).id === id),
    },
  } as unknown as ExtensionCommandContext;
  extension(api as unknown as ExtensionAPI);
  async function event(name: string) {
    await handlers.get(name)?.({ type: name, reason: "startup" } as never, ctx);
  }
  async function command(args: string) {
    const registered = commands.get("progress");
    if (!registered) throw new Error("progress command not registered");
    await registered.handler(args, ctx);
  }
  function render(width = 120): string[] {
    const call = ui.setWidget.mock.calls.at(-1);
    if (!call || call[1] === undefined) return [];
    if (Array.isArray(call[1])) return call[1];
    return call[1]({ requestRender: vi.fn() }, ui.theme).render(width);
  }
  return {
    cwd,
    api,
    ui,
    ctx,
    commands,
    handlers,
    event,
    command,
    render,
    setBranch: (entries: unknown[]) => {
      branch = entries;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network");
    }),
  );
});
afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Pi host integration", () => {
  it("registers passively and only starts resources on session start", async () => {
    const h = await harness();
    expect(h.commands.has("progress")).toBe(true);
    expect(h.handlers.has("session_start")).toBe(true);
    expect(h.handlers.has("session_shutdown")).toBe(true);
    expect(h.handlers.has("session_tree")).toBe(true);
    expect(h.handlers.has("agent_settled")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.ui.setWidget).not.toHaveBeenCalled();
    await h.event("session_start");
    expect(h.render().join(" ")).toMatch(/plan|source/i);
    expect(vi.getTimerCount()).toBe(1);
    await h.command("interval 5");
    expect(vi.getTimerCount()).toBe(1);
    await h.command("interval -1");
    expect(vi.getTimerCount()).toBe(1);
    await h.event("session_shutdown");
    expect(vi.getTimerCount()).toBe(0);
    expect(h.render()).toEqual([]);
    for (const fn of [
      h.api.exec,
      h.api.sendMessage,
      h.api.sendUserMessage,
      h.api.registerTool,
      globalThis.fetch,
    ])
      expect(fn).not.toHaveBeenCalled();
  });

  it("shows reported checklist counts, honors cancellation, and excludes text from checkpoints", async () => {
    const h = await harness();
    await writeFile(
      join(h.cwd, "plan.md"),
      "# Tasks\n- [x] Private task alpha\n- [ ] Private task beta\n- [x] Private task gamma\n- [ ] Fourth\n- [ ] Fifth",
    );
    await h.event("session_start");
    await h.command("source plan.md#Tasks");
    expect(h.render().join(" ")).toMatch(/2\s*\/\s*5/);
    expect(h.render().join(" ")).toMatch(/40%/);
    expect(h.render().join(" ")).toMatch(/reported/i);
    expect(h.render().join(" ")).toMatch(/\[[#-]+\]/);
    expect(h.render().join(" ")).toContain("plan.md");
    expect(h.render().join(" ")).toMatch(/task:.*unknown/i);
    const checkpoint = JSON.stringify(h.api.appendEntry.mock.calls);
    expect(checkpoint).not.toContain("Private task");
    h.ui.confirm.mockResolvedValueOnce(false);
    await writeFile(join(h.cwd, "other.md"), "# Tasks\n- [x] Different");
    await h.command("source other.md#Tasks");
    expect(h.render().join(" ")).toMatch(/2\s*\/\s*5/);
    await h.event("session_tree");
    expect(h.render().join(" ")).not.toMatch(/2\s*\/\s*5/);
    await h.event("session_shutdown");
  });

  it("does not use terminal-only widgets in RPC and never starts remote inference", async () => {
    const h = await harness("rpc");
    await h.event("session_start");
    expect(h.ui.setWidget).not.toHaveBeenCalled();
    expect(h.ui.custom).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await h.event("session_shutdown");
  });
});
