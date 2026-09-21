import { expect, it } from "vitest";

const write = {
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
};
const review = {
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
};
function receipt() {
  return {
    content: [{ type: "text", text: "PRIVATE_CHILD_OUTPUT" }],
    details: {
      mode: "workflow",
      runId: "workflow-1",
      results: [],
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
        parentToolCallId: "call-1",
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
}
async function fixture(tools: unknown[] = [write, review]) {
  const path = "../src/advisory/correction-adapter.ts";
  const module = await import(path);
  return new module.CorrectionAdapter({ tools: () => tools });
}
it("admits builtin attempted write using exact provenance/schema, not raw content", async () => {
  const adapter = await fixture();
  const attempt = adapter.start(
    "call-1",
    "write",
    { path: "/repo/__tests__/parser.test.ts", content: "PRIVATE_BODY" },
    "/repo",
  );
  expect(attempt).toEqual({
    kind: "test",
    id: "call-1",
    toolName: "write",
    path: "__tests__/parser.test.ts",
  });
  expect(JSON.stringify(attempt)).not.toContain("PRIVATE_BODY");
});
it("does not locally infer a new test from filename: classifier decides", async () => {
  const adapter = await fixture();
  expect(
    adapter.start(
      "call-1",
      "write",
      { path: "src/parser.ts", content: "content" },
      "/repo",
    ),
  ).toMatchObject({ kind: "test", path: "src/parser.ts" });
});
it.each(["custom", "schema", "outside", "invalid-args"])(
  "rejects unsupported write %s",
  async (why) => {
    const tool = structuredClone(write);
    if (why === "custom") tool.sourceInfo.source = "some-extension";
    if (why === "schema") tool.parameters.properties.content.type = "number";
    const adapter = await fixture([tool]);
    expect(
      adapter.start(
        "call-1",
        "write",
        {
          path: why === "outside" ? "/private/a.ts" : "test.ts",
          content: why === "invalid-args" ? 7 : "text",
        },
        "/repo",
      ),
    ).toBeUndefined();
  },
);
it("observes named review without launching or nudging before a correlated running receipt", async () => {
  const adapter = await fixture();
  expect(
    adapter.start(
      "call-1",
      "subagent",
      {
        workflow: "review",
        args: { task: "PRIVATE_REVIEW_TEXT" },
        async: false,
      },
      "/repo",
    ),
  ).toBeUndefined();
  expect(adapter.update("call-1", "subagent", receipt())).toEqual({
    kind: "review",
    id: "call-1",
    toolName: "subagent",
    runId: "child-1",
  });
  expect(adapter.update("call-1", "subagent", receipt())).toBeUndefined();
});
it.each(["raw-script", "agent-name", "background", "spoofed-source"])(
  "does not infer review purpose from %s",
  async (why) => {
    const tool = structuredClone(review);
    if (why === "spoofed-source") tool.sourceInfo.source = "unknown";
    const adapter = await fixture([tool]);
    const args =
      why === "raw-script"
        ? { workflowScript: "review()" }
        : why === "agent-name"
          ? { agent: "reviewer", task: "review" }
          : {
              workflow: "review",
              args: { task: "review" },
              async: why === "background",
            };
    adapter.start("call-1", "subagent", args, "/repo");
    expect(adapter.update("call-1", "subagent", receipt())).toBeUndefined();
  },
);
it.each([
  "wrong-call",
  "wrong-workflow",
  "no-run",
  "pending",
  "completed",
  "wrong-resource",
])("rejects review receipt %s", async (why) => {
  const adapter = await fixture();
  adapter.start(
    "call-1",
    "subagent",
    { workflow: "review", args: { task: "review" }, async: false },
    "/repo",
  );
  const value = receipt();
  if (why === "wrong-call")
    value.details.workflowChildren.parentToolCallId = "other";
  if (why === "wrong-workflow")
    value.details.workflowChildren.workflowRunId = "other";
  if (why === "no-run") value.details.workflowChildren.children[0].runId = "";
  if (why === "pending")
    value.details.workflowChildren.children[0].state = "pending";
  if (why === "completed")
    value.details.workflowChildren.workflowState = "completed";
  if (why === "wrong-resource") value.details.workflow.resource.name = "run-ci";
  expect(adapter.update("call-1", "subagent", value)).toBeUndefined();
});
it("clears outstanding review correlation on lifecycle reset", async () => {
  const adapter = await fixture();
  adapter.start(
    "call-1",
    "subagent",
    { workflow: "review", args: { task: "review" }, async: false },
    "/repo",
  );
  adapter.reset();
  expect(adapter.update("call-1", "subagent", receipt())).toBeUndefined();
});
