import { mkdtemp, rm } from "node:fs/promises";
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
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => unknown;
};
const directories: string[] = [];

const entry = (id: string, role: "user" | "assistant", text: string) => ({
  type: "message",
  id,
  parentId: null as string | null,
  timestamp: "2026-09-18T00:00:00Z",
  message: { role, content: [{ type: "text", text }], timestamp: 1 },
});

interface JevBody {
  model: string;
  state?: {
    observation?: { text?: string };
    tasks?: { id: string; text: string }[];
    spans?: { id: string; text: string }[];
  };
  questions: Record<
    string,
    {
      type: "choice" | "score";
      criteria: string[] | Record<string, string | null>;
    }
  >;
}

function jevResponse(body: JevBody): Response {
  const report = String(body.state?.observation?.text ?? "");
  const tasks = new Map(
    (body.state?.tasks ?? []).map((task: { id: string; text: string }) => [
      task.id,
      task.text,
    ]),
  );
  const spans = new Map(
    (body.state?.spans ?? []).map((span) => [span.id, span.text]),
  );
  const answers = Object.fromEntries(
    Object.entries(body.questions).map(([id, question]) => {
      if (question.type === "score") {
        const labels = question.criteria as string[];
        return [
          id,
          {
            type: "score",
            score: labels.length - 1,
            legend: Object.fromEntries(
              labels.map((label, i) => [String(i), label]),
            ),
            probabilities: Object.fromEntries(
              labels.map((_, i) => [
                String(i),
                i === labels.length - 1 ? 1 : 0,
              ]),
            ),
            confidence: 1,
          },
        ];
      }
      const keys = Object.keys(question.criteria);
      let choice = keys[0] ?? "unknown";
      if (id === "source")
        choice = keys.find((key) => key.startsWith("candidate:")) ?? choice;
      else if (keys.includes("task"))
        choice = /^plan:?$/i.test(spans.get(id)?.trim() ?? "")
          ? "context"
          : "task";
      else if (keys.includes("not-a-report"))
        choice =
          report.includes("finished") && /parser/i.test(tasks.get(id) ?? "")
            ? "done"
            : "not-a-report";
      else if (keys.includes("explicit")) choice = "explicit";
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
    usage: { input_tokens: 10, output_tokens: 0 },
  });
}

async function harness(branch: unknown[] = [], mode = "tui") {
  const cwd = await mkdtemp(join(tmpdir(), "progress-host-"));
  directories.push(cwd);
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
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
    confirm: vi.fn(),
    input: vi.fn(),
    select: vi.fn(),
    custom: vi.fn(),
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
      getLeafId: () => "leaf-a",
      getEntry: (id: string) =>
        branch.find((value) => (value as { id?: string }).id === id),
    },
  } as unknown as ExtensionCommandContext;
  extension(api as unknown as ExtensionAPI);
  const event = async (name: string, payload: Record<string, unknown> = {}) => {
    await handlers.get(name)?.(
      { type: name, reason: "startup", ...payload } as never,
      ctx,
    );
  };
  const command = async (args: string) => {
    const registered = commands.get("progress");
    if (!registered) throw new Error("progress command not registered");
    await registered.handler(args, ctx);
  };
  const render = (width = 120): string[] => {
    const call = ui.setWidget.mock.calls.at(-1);
    if (!call || call[1] === undefined) return [];
    if (Array.isArray(call[1])) return call[1];
    return call[1]({ requestRender: vi.fn() }, ui.theme).render(width);
  };
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
    setBranch: (next: unknown[]) => {
      branch = next;
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

describe("automatic Pi host contract", () => {
  it.each([undefined, "", "   "])(
    "starts OFF with one clear error when TYPESAFE_API_KEY is %j",
    async (key) => {
      if (key === undefined) delete process.env.TYPESAFE_API_KEY;
      else vi.stubEnv("TYPESAFE_API_KEY", key);
      const h = await harness([
        entry("goal", "user", "Implement parser and add tests."),
      ]);
      await h.event("session_start");
      expect(h.ui.notify).toHaveBeenCalledTimes(1);
      expect(h.ui.notify.mock.calls[0]?.join(" ")).toMatch(
        /TYPESAFE_API_KEY.*off/i,
      );
      expect(h.render()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );

  it("turns OFF after one rejected-credential error", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "rejected-key");
    const fetcher = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    const h = await harness([
      entry("goal", "user", "Plan:\n1. Implement parser\n2. Add tests"),
    ]);
    await h.event("session_start");
    await vi.waitFor(() => expect(h.ui.notify).toHaveBeenCalledTimes(1));
    expect(h.ui.notify.mock.calls[0]?.join(" ")).toMatch(
      /rejected.*off|off.*rejected/i,
    );
    expect(h.render()).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("starts ON without consent/source UI and immediately analyzes ordinary conversation", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "unit-key");
    const fetcher = vi.fn(
      (_url: string, _init?: RequestInit) => new Promise<Response>(() => {}),
    );
    vi.stubGlobal("fetch", fetcher);
    const h = await harness([
      entry("goal", "user", "Plan:\n1. Implement parser\n2. Add tests"),
    ]);
    await h.event("session_start");
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(h.ui.confirm).not.toHaveBeenCalled();
    expect(h.ui.select).not.toHaveBeenCalled();
    expect(h.ui.input).not.toHaveBeenCalled();
    expect(h.render().join(" ")).toMatch(/catching up|pending|progress/i);
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).not.toContain("unit-key");
    await h.event("session_shutdown");
  });

  it("exposes only bare usage/state, on and off", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "unit-key");
    const h = await harness();
    await h.event("session_start");
    await h.command("");
    const help = String(h.ui.notify.mock.calls.at(-1)?.[0]);
    expect(help).toContain("Automatic progress monitor");
    expect(help).toContain("State: ON");
    expect(help).not.toMatch(/interval/i);
    expect(help).toContain("/progress on");
    expect(help).toContain("/progress off");

    expect(help).toMatch(/Jev usage: \d+ calls/i);
    expect(h.ui.select).not.toHaveBeenCalled();
    for (const obsolete of [
      "interval 5",
      "interval 86400",
      "source conversation",
      "details",
      "enable",
      "pause",
      "resume",
    ]) {
      await h.command(obsolete);
      expect(h.ui.notify.mock.calls.at(-1)?.join(" ")).toMatch(/usage|use/i);
    }
    expect(vi.getTimerCount()).toBe(0);
    await h.event("session_shutdown");
  });

  it("off is idempotent, aborts pending work, hides widget, and on resumes once", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "unit-key");
    const fetcher = vi.fn(
      (_url: string, _init?: RequestInit) => new Promise<Response>(() => {}),
    );
    vi.stubGlobal("fetch", fetcher);
    const h = await harness([
      entry("goal", "user", "Plan:\n1. Implement parser\n2. Add tests"),
    ]);
    await h.event("session_start");
    await Promise.resolve();
    const signal = fetcher.mock.calls[0]?.[1]?.signal;
    await h.command("off");
    await h.command("off");
    expect(signal?.aborted).toBe(true);
    expect(h.render()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await h.command("");
    expect(vi.getTimerCount()).toBe(0);
    await h.command("on");
    await h.command("on");
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await h.event("session_shutdown");
  });

  it("discovers a short plan and explicit completion without commands", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "unit-key");
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
      jevResponse(JSON.parse(String(init?.body)) as JevBody),
    );
    vi.stubGlobal("fetch", fetcher);
    const plan = entry(
      "goal",
      "user",
      "Plan:\n1. Implement parser\n2. Add tests",
    );
    const h = await harness([plan]);
    await h.event("session_start");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(h.render().join(" ")).toMatch(/0\s*\/\s*2/));
    h.setBranch([
      plan,
      entry(
        "done",
        "assistant",
        "Implement parser is finished. Add tests remains.",
      ),
    ]);
    await h.event("turn_end");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(h.render().join(" ")).toMatch(/1\s*\/\s*2/));
    expect(h.ui.confirm).not.toHaveBeenCalled();
    expect(h.ui.select).not.toHaveBeenCalled();
    await h.event("session_shutdown");
  });

  it("stays passive and does not call Jev for empty or unchanged successful history", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "unit-key");
    const h = await harness();
    await h.event("session_start");
    await vi.advanceTimersByTimeAsync(180_000);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    for (const fn of [
      h.api.exec,
      h.api.sendMessage,
      h.api.sendUserMessage,
      h.api.registerTool,
    ])
      expect(fn).not.toHaveBeenCalled();
    await h.event("session_shutdown");
  });
});

// Event-driven contract supersedes interval assertions; the real host ordering
// proof lives in host-events.integration.test.ts, not this synthetic harness.
describe("event-driven host contract", () => {
  it("keeps one flight while distinct accepted messages arrive; OFF aborts without late work", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "unit-key");
    let finish: ((response: Response) => void) | undefined;
    const fetcher = vi.fn(
      (_url: string, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const branch = [entry("first", "user", "Explain the parser.")];
    const h = await harness(branch);
    await h.event("session_start");
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 5; i++) {
      branch.push({
        ...entry(`next-${i}`, "user", `Explain issue ${i}.`),
        parentId: branch.at(-1)?.id ?? null,
      });
      await h.event("context");
      await h.event("context");
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const signal = fetcher.mock.calls[0]?.[1]?.signal;
    await h.command("off");
    expect(signal?.aborted).toBe(true);
    const body = JSON.parse(
      String(fetcher.mock.calls[0]?.[1]?.body),
    ) as JevBody;
    finish?.(jevResponse(body));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await h.event("session_shutdown");
  });

  it("never discovers custom or tool-result text and clears pending retry on OFF", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "unit-key");
    const fetcher = vi.fn(
      async () =>
        new Response(null, { status: 429, headers: { "Retry-After": "2" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    const branch: unknown[] = [
      {
        type: "custom",
        id: "own",
        customType: "pi-progress-bar",
        data: { text: "PRIVATE" },
      },
      {
        type: "message",
        id: "tool",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "PRIVATE" }],
        },
      },
      {
        type: "message",
        id: "private",
        message: { role: "custom", content: "PRIVATE" },
      },
    ];
    const h = await harness(branch);
    await h.event("session_start");
    await h.event("context");
    await h.event("turn_end");
    await vi.advanceTimersByTimeAsync(100);
    expect(fetcher).not.toHaveBeenCalled();
    branch.push(entry("retry", "user", "Explain parser behavior."));
    await h.event("context");
    await vi.advanceTimersByTimeAsync(100);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await h.command("off");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await h.event("session_shutdown");
  });
  function noWorkTransport() {
    const requests: { state?: { candidates?: { entryId: string }[] } }[] = [];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      return Response.json({
        model: "jev-1.13.0",
        answers: {
          source: {
            type: "choice",
            choice: "none",
            confidence: 1,
            probabilities: Object.fromEntries(
              Object.keys(body.questions.source.criteria).map((key) => [
                key,
                key === "none" ? 1 : 0,
              ]),
            ),
          },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    return { fetcher, requests };
  }

  it("observes accepted refs at context/turn_end, not raw message_end, without waiting for settled", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "unit-key");
    const { fetcher, requests } = noWorkTransport();
    const h = await harness();
    await h.event("session_start");
    expect(h.handlers.has("context")).toBe(true);
    expect(h.handlers.has("turn_end")).toBe(true);
    const user = entry("accepted-user", "user", "Explain the parser.");
    await h.event("message_end", { message: user.message });
    await vi.advanceTimersByTimeAsync(100);
    expect(fetcher).not.toHaveBeenCalled();
    h.setBranch([user]);
    await h.event("context");
    await vi.advanceTimersByTimeAsync(100);
    expect(
      requests.flatMap(
        (request) =>
          request.state?.candidates?.map((candidate) => candidate.entryId) ??
          [],
      ),
    ).toEqual(["accepted-user"]);
    h.setBranch([
      user,
      {
        ...entry(
          "accepted-answer",
          "assistant",
          "The parser preserves source spans.",
        ),
        parentId: user.id,
      },
    ]);
    await h.event("turn_end");
    await vi.advanceTimersByTimeAsync(100);
    expect(
      requests.flatMap(
        (request) =>
          request.state?.candidates?.map((candidate) => candidate.entryId) ??
          [],
      ),
    ).toContain("accepted-answer");
    await h.event("session_shutdown");
  });

  it.each([12, 520])(
    "drains %i finite observations across budgets/windows and coalesces duplicate notifications",
    async (count) => {
      vi.stubEnv("TYPESAFE_API_KEY", "unit-key");
      const { fetcher, requests } = noWorkTransport();
      const branch = Array.from({ length: count }, (_, index) => ({
        ...entry(`context-${index}`, "user", `Context note number ${index}.`),
        parentId: index ? `context-${index - 1}` : null,
      }));
      const h = await harness(branch);
      await h.event("session_start");
      // No periodic interval or synthetic per-cycle calls; allow yielded local work.
      await vi.advanceTimersByTimeAsync(1000);
      expect(
        requests.flatMap(
          (request) =>
            request.state?.candidates?.map((candidate) => candidate.entryId) ??
            [],
        ),
      ).toEqual(branch.map((value) => value.id));
      expect(vi.getTimerCount()).toBe(0);
      for (const hook of ["context", "turn_end", "agent_settled", "context"])
        await h.event(hook);
      await h.command("");
      await vi.advanceTimersByTimeAsync(600_000);
      expect(fetcher).toHaveBeenCalledTimes(count);
      expect(vi.getTimerCount()).toBe(0);
      await h.event("session_shutdown");
    },
  );

  it("has no idle analysis timer or interval control", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "unit-key");
    const h = await harness();
    await h.event("session_start");
    await h.command("");
    const help = String(h.ui.notify.mock.calls.at(-1)?.[0]);
    expect(help).toContain("/progress on");
    expect(help).toContain("/progress off");
    expect(help).not.toMatch(/interval/i);
    expect(h.commands.get("progress")?.description).not.toMatch(/interval/i);
    await h.command("interval 5");
    expect(h.ui.notify.mock.calls.at(-1)?.join(" ")).toMatch(
      /unknown|use|usage/i,
    );
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetch).not.toHaveBeenCalled();
    await h.event("session_shutdown");
  });

  it.each([2, 65])(
    "retries 429 work with Retry-After=%is respecting the longer existing backoff, without a fresh event",
    async (retrySeconds) => {
      vi.stubEnv("TYPESAFE_API_KEY", "unit-key");
      const { fetcher } = noWorkTransport();
      fetcher.mockImplementationOnce(
        async () =>
          new Response(null, {
            status: 429,
            headers: { "Retry-After": String(retrySeconds) },
          }),
      );
      const h = await harness([
        entry("retry-user", "user", "Context for the work."),
      ]);
      await h.event("session_start");
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(Math.max(60, retrySeconds) * 1000 - 1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(101);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      await h.event("session_shutdown");
    },
  );
});
