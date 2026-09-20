import { expect, it } from "vitest";
import * as activity from "../src/analysis/activity-focus";

async function api() {
  return activity;
}
const cwd = "/repo";
const call = (
  id: string,
  name = "read",
  args: unknown = { path: "src/a.ts" },
) => ({ type: "toolCall", id, name, arguments: args });
const message = (...calls: ReturnType<typeof call>[]) => ({
  role: "assistant",
  content: [{ type: "text", text: "PRIVATE_ASSISTANT_SENTINEL" }, ...calls],
});
const tasks = [
  { id: "task:1", label: "Fix parser", revision: 1 },
  { id: "task:2", label: "Fix database", revision: 2 },
];

it("captures every declared member without raw text, args or private IDs entering inference", async () => {
  const a = await api();
  const list = a.captureDeclaredTools(
    message(
      call("PRIVATE_ID", "write", {
        path: "/repo/src/a.ts",
        content: "PRIVATE_CONTENT",
      }),
      call("second", "unknown", { secret: "PRIVATE_ARG" }),
    ),
    cwd,
  );
  expect(list?.kind).toBe("ready");
  expect(list?.calls.map((item) => item.member)).toEqual([
    { toolName: "write", path: "src/a.ts" },
    { toolName: "unknown" },
  ]);
  const request = a.activityFocusRequest(
    list?.calls.map((item) => item.member) ?? [],
    tasks,
  );
  expect(request.questions.activityFocus).toBeDefined();
  expect(JSON.stringify(request)).not.toMatch(/PRIVATE_|second/);
  expect(JSON.stringify(request)).toContain("task:2");
});
it.each([
  "/outside/PRIVATE_PATH",
  "../PRIVATE_PATH",
  "src/../../PRIVATE_PATH",
  "",
])("omits escaping/external path %j", async (path) => {
  const a = await api();
  expect(
    a.captureStartedTool("id", "read", { path, extra: "SECRET" }, cwd).member,
  ).toEqual({ toolName: "read" });
});
it.each([
  ["npm test --token SECRET", "test"],
  ["make build", "build"],
  ["rg SECRET src", "search"],
  ["jj status", "vcs"],
  ["echo SECRET", "other"],
])("reduces shell command %s to fixed category", async (command, category) => {
  const a = await api();
  expect(
    a.captureStartedTool(
      "id",
      "bash",
      { command, env: { SECRET: "value" } },
      cwd,
    ).member,
  ).toEqual({ toolName: "bash", shellCategory: category });
});
it("unchanged safe list causes no correction despite hidden argument differences", async () => {
  const a = await api();
  const p = a.captureDeclaredTools(
    message(call("a", "write", { path: "src/a.ts", content: "BEFORE" })),
    cwd,
  );
  if (!p) throw new Error("Missing declared list");
  const started = a.captureStartedTool(
    "a",
    "write",
    { path: "src/a.ts", content: "AFTER" },
    cwd,
  );
  expect(
    a.reconcileStartedTools(
      p,
      new Map([["a", started]]),
      message(call("a", "write", { path: "src/a.ts", content: "AFTER" })),
      cwd,
    ).kind,
  ).toBe("unchanged");
});
it.each(["addition", "replacement", "path", "partial"])(
  "corrects changed %s list using all and only actual starts",
  async (kind) => {
    const a = await api();
    const initial =
      kind === "partial" ? message(call("a"), call("b")) : message(call("a"));
    const final =
      kind === "addition"
        ? message(call("a"), call("b"))
        : kind === "replacement"
          ? message(call("replacement"))
          : kind === "path"
            ? message(call("a", "read", { path: "src/b.ts" }))
            : initial;
    const startedCalls =
      kind === "partial"
        ? [call("a")]
        : (final.content.filter(
            (item) => item.type === "toolCall",
          ) as ReturnType<typeof call>[]);
    const starts = new Map(
      startedCalls.map((item) => [
        item.id,
        a.captureStartedTool(item.id, item.name, item.arguments, cwd),
      ]),
    );
    const provisional = a.captureDeclaredTools(initial, cwd);
    if (!provisional) throw new Error("Missing provisional");
    const result = a.reconcileStartedTools(provisional, starts, final, cwd);
    expect(result.kind).toBe("changed");
    if (result.kind !== "changed") throw new Error("Expected changed list");
    expect(result.calls.map((item) => item.callId)).toEqual(
      startedCalls.map((item) => item.id),
    );
  },
);
it("uses final source order rather than observed completion/start-map insertion order", async () => {
  const a = await api();
  const declared = message(call("a"), call("b"));
  const p = a.captureDeclaredTools(declared, cwd);
  if (!p) throw new Error("Missing provisional");
  const starts = new Map(
    [
      a.captureStartedTool("b", "read", { path: "src/a.ts" }, cwd),
      a.captureStartedTool("a", "read", { path: "src/a.ts" }, cwd),
    ].map((item) => [item.callId, item]),
  );
  expect(a.reconcileStartedTools(p, starts, declared, cwd).kind).toBe(
    "unchanged",
  );
});
it("no actual starts clears provisional without inventing provider evidence", async () => {
  const a = await api();
  const declared = message(call("a"));
  const p = a.captureDeclaredTools(declared, cwd);
  if (!p) throw new Error("Missing provisional");
  expect(a.reconcileStartedTools(p, new Map(), declared, cwd).kind).toBe(
    "empty",
  );
});
it.each(["duplicate", "unexpected"])(
  "fails closed for %s identity mismatch",
  async (kind) => {
    const a = await api();
    const p = a.captureDeclaredTools(message(call("a")), cwd);
    if (!p) throw new Error("Missing provisional");
    const start = a.captureStartedTool(
      kind === "unexpected" ? "bad" : "a",
      "read",
      { path: "src/a.ts" },
      cwd,
    );
    expect(
      a.reconcileStartedTools(
        p,
        new Map([[start.callId, start]]),
        kind === "duplicate"
          ? message(call("a"), call("a"))
          : message(call("a")),
        cwd,
      ).kind,
    ).toBe("boundary-uncertain");
  },
);
it("enforces exact 4096-byte safe envelope, not characters or sampled members", async () => {
  const a = await api();
  const overhead = Buffer.byteLength(
    JSON.stringify({ tools: [{ toolName: "" }] }),
  );
  const exactName = "x".repeat(4096 - overhead);
  expect(
    a.captureDeclaredTools(message(call("a", exactName, {})), cwd)?.kind,
  ).toBe("ready");
  const overflow = a.captureDeclaredTools(
    message(call("a", `${exactName}x`, {})),
    cwd,
  );
  expect(overflow?.kind).toBe("overflow");
  expect(overflow?.calls).toEqual([]);
  expect(
    a.captureDeclaredTools(message(call("a", "界".repeat(1400), {})), cwd)
      ?.kind,
  ).toBe("overflow");
});
it("does not create a batch from user text or tool-free assistant text", async () => {
  const a = await api();
  expect(
    a.captureDeclaredTools({ role: "user", content: [call("a")] }, cwd),
  ).toBeUndefined();
  expect(a.captureDeclaredTools(message(), cwd)).toBeUndefined();
});

it("corrects provisional overflow when actual started list genuinely shrinks to fit", async () => {
  const a = await api();
  const oversized = message(call("a"), call("big", "界".repeat(1400), {}));
  const provisional = a.captureDeclaredTools(oversized, cwd);
  if (!provisional) throw new Error("Missing provisional");
  expect(provisional.kind).toBe("overflow");
  const started = a.captureStartedTool("a", "read", { path: "src/a.ts" }, cwd);
  expect(
    a.reconcileStartedTools(
      provisional,
      new Map([["a", started]]),
      oversized,
      cwd,
    ),
  ).toEqual({ kind: "changed", calls: [started] });
});
