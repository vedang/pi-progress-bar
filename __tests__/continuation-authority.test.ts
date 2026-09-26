import { describe, expect, it, vi } from "vitest";
import { projectContinuationAuthority } from "../src/advisory/continuation-authority";
import { captureContinuationPolicy } from "../src/advisory/continuation-policy";
import { continuationAuthorityFixture } from "./fixtures/continuation";
import { subtaskHash, subtaskSource } from "./fixtures/subtasks";

describe("canonical continuation authority projection", () => {
  it("copies full included board and canonical authority through exact accepted reply", () => {
    const { input } = continuationAuthorityFixture();
    const done = {
      ...structuredClone(input.tasks[0]),
      id: "task:2",
      status: "done" as const,
    };
    input.tasks.push(done);
    input.events.push({
      ...structuredClone(input.events[0]),
      id: "event:2",
      taskId: done.id,
    });
    const before = structuredClone(input);
    const result = projectContinuationAuthority(input);
    expect(result.available).toBe(true);
    if (!result.available)
      throw new Error("Expected complete bounded authority");
    expect(result.context.map((item) => item.id)).toEqual([
      "authorization",
      "reply",
    ]);
    expect(result.tasks.map((task) => task.id)).toEqual(["task:1", "task:2"]);
    expect(result.receipt).toEqual(input.receipt);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.originalRunId).toBe(7);
    result.tasks[0].label = "Changed copy";
    result.context[0].text = "Changed copy";
    expect(input).toEqual(before);
    expect(projectContinuationAuthority(input)).not.toEqual(result);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it.each(["not-ready", "missing", "older", "wrong-hash"])(
    "requires accepted mandatory frontier, not merely ready (%s)",
    (mode) => {
      const { input } = continuationAuthorityFixture();
      if (mode === "not-ready") input.ready = false;
      if (mode === "missing") input.cursor = undefined;
      if (mode === "older")
        input.cursor = {
          id: "authorization",
          hash: input.events[0].source.messageHash,
          role: "user",
        };
      if (mode === "wrong-hash" && input.cursor)
        input.cursor.hash = subtaskHash("unaccepted reply");
      expect(projectContinuationAuthority(input)).toEqual({
        available: false,
        reason: "frontier",
      });
    },
  );

  it("keeps earlier user veto and intercom evidence despite later task wording", () => {
    const { input, task } = continuationAuthorityFixture();
    const pause = {
      type: "message",
      id: "pause",
      message: {
        role: "user",
        content: "Pause implementation until I approve.",
      },
    };
    const renameText =
      "Call the task Deployment recommendation; this is a wording edit only.";
    const rename = {
      type: "message",
      id: "rename",
      message: { role: "user", content: renameText },
    };
    const peer = {
      type: "custom_message",
      id: "peer",
      customType: "intercom_message",
      content: "I am working on the comparison; do not duplicate it.",
    };
    input.branch.splice(1, 0, pause, rename, peer);
    task.source = subtaskSource("rename", renameText);
    const result = projectContinuationAuthority(input);
    expect(result.available).toBe(true);
    if (!result.available)
      throw new Error("Expected preserved whole authority interval");
    expect(result.context.map((item) => item.id)).toEqual([
      "authorization",
      "pause",
      "rename",
      "peer",
      "reply",
    ]);
    expect(result.context.find((item) => item.id === "peer")?.role).toBe(
      "intercom",
    );
    // Complete coverage does not mean permission; N02 must judge the pause.
    expect(result.context[1].text).toBe(pause.message.content);
  });

  it.each([
    "missing-create",
    "missing-source",
    "changed-source",
    "bad-range",
    "bad-quote",
    "duplicate-id",
  ])("marks unresolved history/source authority unavailable (%s)", (mode) => {
    const { input, authorization, task } = continuationAuthorityFixture();
    if (mode === "missing-create") input.events = [];
    if (mode === "missing-source") input.branch.shift();
    if (mode === "changed-source")
      authorization.message.content = "Different authorization";
    if (mode === "bad-range") task.source.end = 99999;
    if (mode === "bad-quote")
      task.source.quoteHash = subtaskHash("invented quote");
    if (mode === "duplicate-id")
      input.branch.unshift(structuredClone(authorization));
    expect(projectContinuationAuthority(input).available).toBe(false);
  });

  it("requires earlier user evidence for assistant-created tasks without claiming it grants permission", () => {
    const { input, task } = continuationAuthorityFixture();
    const text = "I will prepare the deployment recommendation.";
    const proposed = {
      type: "message",
      id: "proposed",
      message: { role: "assistant", content: text, stopReason: "stop" },
    };
    input.branch.splice(1, 0, proposed);
    task.source = { ...subtaskSource("proposed", text), role: "assistant" };
    input.events[0].source = {
      entryId: "proposed",
      messageHash: subtaskHash(text),
      role: "assistant",
    };
    const result = projectContinuationAuthority(input);
    expect(result.available).toBe(true);
    if (!result.available) throw new Error("Expected earlier user context");
    expect(result.context.map((item) => item.id)).toEqual([
      "authorization",
      "proposed",
      "reply",
    ]);
    input.branch.shift();
    expect(projectContinuationAuthority(input)).toEqual({
      available: false,
      reason: "authority",
    });
  });

  it.each(["question", "reply", "session", "branch", "later-user"])(
    "rejects stale receipt/control bindings (%s)",
    (mode) => {
      const { input, question, reply } = continuationAuthorityFixture();
      if (mode === "question") question.content = "Changed custom question";
      if (mode === "reply") reply.message.content = "Changed reply";
      if (mode === "session") input.sessionEpoch++;
      if (mode === "branch") input.branchEpoch++;
      if (mode === "later-user")
        input.branch.push({
          type: "message",
          id: "later",
          message: { role: "user", content: "Stop." },
        });
      expect(projectContinuationAuthority(input)).toEqual({
        available: false,
        reason: "stale",
      });
    },
  );

  it.each(["duplicate-question", "display-change"])(
    "revalidates unique full delivery question shape (%s)",
    (mode) => {
      const { input, question } = continuationAuthorityFixture();
      expect(projectContinuationAuthority(input).available).toBe(true);
      if (mode === "duplicate-question")
        input.branch.splice(2, 0, {
          ...structuredClone(question),
          id: "second-question",
        });
      else question.display = false;
      expect(projectContinuationAuthority(input)).toEqual({
        available: false,
        reason: "stale",
      });
    },
  );

  it("abstains for unknown policy or no unfinished included work", () => {
    const { input, task } = continuationAuthorityFixture();
    input.policy = { coverage: "unknown" };
    expect(projectContinuationAuthority(input)).toEqual({
      available: false,
      reason: "authority",
    });
    const other = continuationAuthorityFixture();
    other.task.status = "done";
    expect(projectContinuationAuthority(other.input)).toEqual({
      available: false,
      reason: "no-work",
    });
    task.included = false;
    expect(
      projectContinuationAuthority({ ...other.input, tasks: [task] }),
    ).toEqual({ available: false, reason: "no-work" });
  });

  it.each([16, 17])(
    "bounds whole conversational observations (%s)",
    (count) => {
      const { input } = continuationAuthorityFixture();
      input.branch.splice(
        1,
        0,
        ...Array.from({ length: count - 2 }, (_, index) => ({
          type: "message",
          id: `update-${index}`,
          message: {
            role: "user",
            content: `Update ${index}: keep existing restrictions.`,
          },
        })),
      );
      expect(projectContinuationAuthority(input).available).toBe(count === 16);
    },
  );

  it("rejects byte overflow and board overflow without sampling", () => {
    const { input } = continuationAuthorityFixture();
    input.branch.splice(1, 0, {
      type: "message",
      id: "large",
      message: { role: "user", content: "x".repeat(12 * 1024) },
    });
    expect(projectContinuationAuthority(input)).toEqual({
      available: false,
      reason: "capacity",
    });
    const other = continuationAuthorityFixture();
    other.input.tasks = Array.from({ length: 21 }, (_, i) => ({
      ...other.task,
      id: `task:${i + 1}`,
    }));
    expect(projectContinuationAuthority(other.input)).toEqual({
      available: false,
      reason: "capacity",
    });
  });

  it("enforces full24KiB projection even when each component fits its own cap", () => {
    const { input } = continuationAuthorityFixture();
    input.tasks = Array.from({ length: 20 }, (_, index) => ({
      ...input.tasks[0],
      id: `task:${index + 1}`,
      label: "L".repeat(240),
    }));
    input.events = input.tasks.map((task, index) => ({
      ...input.events[0],
      id: `event:${index + 1}`,
      taskId: task.id,
    }));
    input.branch.splice(1, 0, {
      type: "message",
      id: "context",
      message: { role: "user", content: "x".repeat(10000) },
    });
    expect(projectContinuationAuthority(input).available).toBe(true);
    input.policy = captureContinuationPolicy("p".repeat(7000));
    expect(input.policy.coverage).toBe("complete");
    expect(projectContinuationAuthority(input)).toEqual({
      available: false,
      reason: "capacity",
    });
  });

  it("fingerprints semantic/control/model/policy facts while remaining deterministic", () => {
    const { input } = continuationAuthorityFixture();
    const before = projectContinuationAuthority(input);
    expect(projectContinuationAuthority(structuredClone(input))).toEqual(
      before,
    );
    for (const changed of [
      { ...input, model: "different/model" },
      { ...input, controlEpoch: 4 },
      { ...input, originalRunId: 6 },
      { ...input, tasks: [{ ...input.tasks[0], status: "reopened" as const }] },
    ]) {
      const next = projectContinuationAuthority(changed);
      expect(next.available).toBe(true);
      if (before.available && next.available)
        expect(next.fingerprint).not.toBe(before.fingerprint);
    }
  });

  it("never reads raw tool or thinking payloads outside required visible observations", () => {
    const { input } = continuationAuthorityFixture();
    const forbidden = vi.fn(() => {
      throw new Error("Private payload accessed");
    });
    const tool = {
      type: "message",
      id: "old-tool",
      message: { role: "toolResult" },
    };
    Object.defineProperty(tool.message, "content", { get: forbidden });
    input.branch.unshift(tool);
    const thinking = { type: "thinking" };
    Object.defineProperty(thinking, "thinking", { get: forbidden });
    input.branch.splice(2, 0, {
      type: "message",
      id: "status-note",
      message: {
        role: "assistant",
        content: [thinking, { type: "text", text: "Comparison underway." }],
        stopReason: "stop",
      },
    });
    const result = projectContinuationAuthority(input);
    expect(result.available).toBe(true);
    expect(forbidden).not.toHaveBeenCalled();
  });
});
