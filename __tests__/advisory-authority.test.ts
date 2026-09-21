import { expect, it } from "vitest";
import * as adapter from "../src/advisory/correction-adapter";

function policy(options: unknown) {
  const project = Reflect.get(adapter, "projectCorrectionPolicy");
  expect(project).toBeTypeOf("function");
  return Reflect.apply(project, undefined, [options]) as {
    coverage: string;
    entries: unknown[];
  };
}
function action(branch: unknown[], leaf = "assistant-1", call = "write-1") {
  const project = Reflect.get(adapter, "projectCorrectionAction");
  expect(project).toBeTypeOf("function");
  return Reflect.apply(project, undefined, [branch, leaf, call, "/repo"]) as {
    coverage: string;
  };
}
const unknownPolicy = { coverage: "unknown", entries: [] };
const entry = (): {
  type: string;
  id: string;
  parentId: string;
  message: {
    role: string;
    stopReason: string;
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      arguments?: Record<string, unknown>;
    }>;
  };
} => ({
  type: "message",
  id: "assistant-1",
  parentId: "goal",
  message: {
    role: "assistant",
    stopReason: "toolUse",
    content: [
      {
        type: "text",
        text: "I am starting a new failing test for the disposable parser.",
      },
      {
        type: "toolCall",
        id: "write-1",
        name: "write",
        arguments: {
          path: "/repo/tests/parser.ts",
          content: "PRIVATE_WRITE_BODY",
        },
      },
      {
        type: "toolCall",
        id: "edit-1",
        name: "edit",
        arguments: {
          path: "src/parser.ts",
          edits: [{ oldText: "PRIVATE_OLD", newText: "PRIVATE_NEW" }],
        },
      },
      {
        type: "toolCall",
        id: "shell-1",
        name: "bash",
        arguments: { command: "echo PRIVATE_SHELL_COMMAND" },
      },
    ],
  },
});
it("projects every relevant loaded policy source with provenance, not the skill catalog", () => {
  const result = policy({
    cwd: "/repo",
    customPrompt: "Custom authority",
    appendSystemPrompt: "Appended authority",
    promptGuidelines: ["Always add a regression test"],
    contextFiles: [
      { path: "/repo/AGENTS.md", content: "A failing test is mandatory" },
    ],
    skills: [{ description: "PRIVATE_SKILL_CATALOG" }],
    toolSnippets: { bash: "PRIVATE_TOOL_SNIPPET" },
  });
  expect(result).toEqual({
    coverage: "complete",
    entries: [
      { role: "system", source: "customPrompt", text: "Custom authority" },
      {
        role: "system",
        source: "appendSystemPrompt",
        text: "Appended authority",
      },
      {
        role: "system",
        source: "promptGuideline",
        index: 0,
        text: "Always add a regression test",
      },
      {
        role: "system",
        source: "contextFile",
        path: "/repo/AGENTS.md",
        text: "A failing test is mandatory",
      },
    ],
  });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_SKILL|PRIVATE_TOOL/);
});
it.each([
  undefined,
  null,
  {},
  { cwd: "/repo", customPrompt: 1 },
  { cwd: "/repo", appendSystemPrompt: false },
  { cwd: "/repo", promptGuidelines: ["valid", null] },
  { cwd: "/repo", contextFiles: [{ path: "AGENTS.md" }] },
  {
    cwd: "/repo",
    contextFiles: [{ path: "AGENTS.md", content: "x".repeat(8192) }],
  },
])("abstains on missing, malformed or overflowing policy: %j", (value) => {
  expect(policy(value)).toEqual(unknownPolicy);
});
it("admits a complete empty loaded-policy set, distinct from missing host authority", () => {
  expect(policy({ cwd: "/repo" })).toEqual({
    coverage: "complete",
    entries: [],
  });
});
it("uses an all-or-nothing 8 KiB policy envelope at the exact byte boundary", () => {
  const framing = JSON.stringify({
    coverage: "complete",
    entries: [{ role: "system", source: "customPrompt", text: "" }],
  });
  const text = "x".repeat(8192 - Buffer.byteLength(framing));
  expect(policy({ cwd: "/repo", customPrompt: text }).coverage).toBe(
    "complete",
  );
  expect(policy({ cwd: "/repo", customPrompt: `${text}x` })).toEqual(
    unknownPolicy,
  );
});
it("reduces the finalized exact assistant leaf and current call without raw arguments", () => {
  const original = entry();
  original.message.content[0] = {
    type: "text",
    text: "Final post-listener declaration: new failing parser test",
  };
  const result = action([original]);
  expect(result).toMatchObject({
    coverage: "complete",
    role: "assistant",
    text: "Final post-listener declaration: new failing parser test",
    batch: [
      { toolName: "write", path: "tests/parser.ts", current: true },
      { toolName: "edit", path: "src/parser.ts", current: false },
      { toolName: "bash", current: false },
    ],
  });
  expect(JSON.stringify(result)).not.toMatch(
    /PRIVATE_|arguments|content|oldText|newText/,
  );
  expect(original.message.content[1]).toHaveProperty(
    "arguments.content",
    "PRIVATE_WRITE_BODY",
  );
});
it.each([
  "missing-leaf",
  "missing-call",
  "wrong-role",
  "ambiguous-call",
  "oversized-text",
  "oversized-batch",
])("abstains on incomplete action projection: %s", (scenario) => {
  const value = entry();
  if (scenario === "wrong-role") value.message.role = "user";
  if (scenario === "ambiguous-call")
    value.message.content.push(value.message.content[1]);
  if (scenario === "oversized-text")
    value.message.content[0] = { type: "text", text: "x".repeat(4097) };
  if (scenario === "oversized-batch")
    value.message.content.push(
      ...Array.from({ length: 33 }, (_, i) => ({
        type: "toolCall",
        id: `call-${i}`,
        name: "read",
        arguments: { path: "safe.ts" },
      })),
    );
  expect(
    action(
      [value],
      scenario === "missing-leaf" ? "absent" : "assistant-1",
      scenario === "missing-call" ? "absent" : "write-1",
    ).coverage,
  ).toBe("unknown");
});
