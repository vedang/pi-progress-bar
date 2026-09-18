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
  vi.unstubAllEnvs();
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

  it("refreshes 2/5 to 3/5 and bounds narrow Unicode rendering across reload", async () => {
    const h = await harness();
    const body = (checked: boolean) =>
      `# Tasks\n- [x] ${"界🙂".repeat(200)}\n- [x] Second\n- [${checked ? "x" : " "}] Third\n- [ ] Fourth\n- [ ] Fifth`;
    await writeFile(join(h.cwd, "plan.md"), body(false));
    h.ui.select.mockImplementation(async (title, options) =>
      /current task/i.test(title) ? options[1] : options[0],
    );
    await h.event("session_start");
    await h.command("source plan.md#Tasks");
    expect(h.render().join(" ")).toContain("40%");
    await writeFile(join(h.cwd, "plan.md"), body(true));
    await vi.advanceTimersByTimeAsync(15000);
    await vi.waitFor(() => expect(h.render().join(" ")).toContain("60%"));
    for (const width of [1, 2, 8, 30]) {
      const rows = h.render(width);
      expect(rows.length).toBeLessThanOrEqual(12);
      for (const row of rows)
        expect(
          Array.from(row).reduce(
            (n, character) =>
              n + (character === "界" || character === "🙂" ? 2 : 1),
            0,
          ),
        ).toBeLessThanOrEqual(width);
    }
    const checkpoint = h.api.appendEntry.mock.calls.at(-1)?.[1];
    h.setBranch([
      {
        type: "custom",
        id: "checkpoint",
        customType: "pi-progress-bar",
        data: checkpoint,
      },
    ]);
    await h.event("session_start");
    expect(h.render().join(" ")).toContain("60%");
    expect(vi.getTimerCount()).toBe(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await h.event("session_shutdown");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requires consent then displays separate Jev signals without changing reported counts", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "unit-key-never-in-state");
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const answers = Object.fromEntries(
        Object.entries(body.questions).map(([id, raw]) => {
          const question = raw as {
            type: string;
            criteria: string[] | Record<string, string>;
          };
          if (question.type === "score") {
            const levels = question.criteria as string[];
            return [
              id,
              {
                type: "score",
                score: levels.length - 1,
                legend: Object.fromEntries(
                  levels.map((label, i) => [String(i), label]),
                ),
                probabilities: Object.fromEntries(
                  levels.map((_, i) => [
                    String(i),
                    i === levels.length - 1 ? 1 : 0,
                  ]),
                ),
                confidence: 1,
              },
            ];
          }
          const keys = Object.keys(question.criteria);
          const choice = keys.find((key) => key === "explicit") ?? keys[0];
          return [
            id,
            {
              type: "choice",
              choice,
              probabilities: Object.fromEntries(
                keys.map((key) => [key, key === choice ? 1 : 0]),
              ),
              confidence: 1,
            },
          ];
        }),
      );
      return Response.json({
        model: body.model,
        answers,
        usage: { input_tokens: 100, output_tokens: 0 },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const h = await harness();
    h.ui.select.mockImplementation(async (title, options) =>
      /current task/i.test(title) ? options[1] : options[0],
    );
    await writeFile(
      join(h.cwd, "plan.md"),
      "# Tasks\n- [ ] Implement cancellation that stops pending requests\n  - Criteria: cancelling aborts pending requests\n- [ ] Other",
    );
    await h.event("session_start");
    await h.command("source plan.md#Tasks");
    expect(fetcher).not.toHaveBeenCalled();
    h.ui.confirm.mockResolvedValueOnce(false);
    await h.command("enable");
    expect(fetcher).not.toHaveBeenCalled();
    await h.command("enable");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(h.render().join(" ")).toMatch(/clarity:\s*3\/3/i),
    );
    expect(h.render().join(" ")).toMatch(/acceptance:\s*explicit/i);
    expect(h.render().join(" ")).toMatch(/0\s*\/\s*2/);
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).not.toContain(
      "unit-key-never-in-state",
    );
    expect(JSON.stringify(h.api.appendEntry.mock.calls)).not.toContain(
      "unit-key-never-in-state",
    );
    await h.command("pause");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(h.render().join(" ")).toMatch(/paused/i);
    await h.event("session_shutdown");
  });

  it("discovers conversation tasks and applies ordered reports without counting intentions", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "unit-key");
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const report = String(body.state?.report?.text ?? "");
      const answers = Object.fromEntries(
        Object.entries(body.questions).map(([id, raw], i) => {
          const q = raw as {
            type: string;
            criteria: string[] | Record<string, string>;
          };
          if (q.type === "score") {
            const levels = q.criteria as string[];
            return [
              id,
              {
                type: "score",
                score: 0,
                legend: Object.fromEntries(
                  levels.map((s, j) => [String(j), s]),
                ),
                probabilities: Object.fromEntries(
                  levels.map((_, j) => [String(j), j === 0 ? 1 : 0]),
                ),
                confidence: 1,
              },
            ];
          }
          const keys = Object.keys(q.criteria);
          let choice =
            keys.find(
              (key) => !["none", "ambiguous", "unknown"].includes(key),
            ) ?? keys[0];
          if (keys.includes("task")) choice = "task";
          if (keys.includes("not-a-report"))
            choice = report.includes("Reopen")
              ? i === 0
                ? "reopened"
                : "not-a-report"
              : report.startsWith("Finished") && i < 2
                ? "done"
                : "not-a-report";
          return [
            id,
            {
              type: "choice",
              choice,
              probabilities: Object.fromEntries(
                keys.map((key) => [key, key === choice ? 1 : 0]),
              ),
              confidence: 1,
            },
          ];
        }),
      );
      return Response.json({
        model: body.model,
        answers,
        usage: { input_tokens: 100, output_tokens: 0 },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const h = await harness();
    const entry = (id: string, text: string) => ({
      type: "message",
      id,
      parentId: null,
      timestamp: "2026-09-18T00:00:00Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: 1,
      },
    });
    const plan = entry(
      "plan",
      "Plan:\n1. Research docs\n2. Build widget\n3. Write tests",
    );
    h.setBranch([plan]);
    await h.event("session_start");
    await h.command("enable");
    await vi.advanceTimersByTimeAsync(60_000);
    await h.command("source conversation");
    expect(h.render().join(" ")).toMatch(/0\s*\/\s*3/);
    await h.command("enable");
    const done = entry(
      "r-done",
      "Finished research and build. Tests remain pending.",
    );
    h.setBranch([plan, done]);
    await h.event("message_end");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.render().join(" ")).toMatch(/2\s*\/\s*3/);
    const intent = entry(
      "r-intent",
      "I will finish Write tests next; example: all tasks done.",
    );
    h.setBranch([plan, done, intent]);
    await h.event("message_end");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.render().join(" ")).toMatch(/2\s*\/\s*3/);
    const reopen = entry(
      "r-reopen",
      "Reopen Research docs; discovery incomplete.",
    );
    h.setBranch([plan, done, intent, reopen]);
    await h.event("message_end");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.render().join(" ")).toMatch(/1\s*\/\s*3/);
    expect(JSON.stringify(h.api.appendEntry.mock.calls)).not.toContain(
      "Finished research",
    );
    await h.event("session_shutdown");
    expect(h.api.sendMessage).not.toHaveBeenCalled();
    expect(h.api.exec).not.toHaveBeenCalled();
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
