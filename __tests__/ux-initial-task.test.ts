import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { projectBoard } from "../src/core/board-projection";
import { emptyState, type HybridTask } from "../src/core/hybrid-state";

function fixture() {
  const recorded = JSON.parse(
    readFileSync(
      new URL("./fixtures/manual-advisory-reading.json", import.meta.url),
      "utf8",
    ),
  );
  const state = emptyState("manual-regression");
  state.tasks = structuredClone(recorded.recordedTasks) as HybridTask[];
  state.events = state.tasks.map((task, index) => ({
    id: `event:${index + 1}`,
    kind: "create" as const,
    taskId: task.id,
    revision: task.revision,
    source: task.source,
  }));
  delete state.focusTaskId;
  return {
    state,
    healthCards: new Map(),
    service: { code: "ready", label: "Ready" },
    unsettled: false,
  };
}
it("names an initial open task immediately without semantic focus or completion mutation", () => {
  const input = fixture();
  const before = structuredClone(input.state);
  const board = projectBoard(input);
  expect(board.currentTask).toMatchObject({ taskId: "task:1", status: "OPEN" });
  expect(board.currentTask?.qualifier).toBe("Selected · awaiting activity");
  expect(input.state).toEqual(before);
  expect(board.tasks.every((task) => task.status === "OPEN")).toBe(true);
});
it("keeps oldest admission as stable fallback across newest insertions", () => {
  const input = fixture();
  const extra = structuredClone(input.state.tasks[0]);
  if (!extra) throw new Error("Missing task");
  extra.id = "task:3";
  input.state.tasks.push(extra);
  input.state.events.push({
    id: "event:3",
    kind: "create",
    taskId: extra.id,
    revision: 1,
    source: extra.source,
  });
  expect(projectBoard(input).currentTask?.taskId).toBe("task:1");
});
it("accepted activity supersedes default, then eligible last display is preferred", () => {
  const input = fixture();
  input.state.focusTaskId = "task:2";
  expect(projectBoard(input).currentTask).toMatchObject({
    taskId: "task:2",
    status: "INPROG",
  });
  delete input.state.focusTaskId;
  expect(
    projectBoard({ ...input, lastDisplayedTaskId: "task:2" }).currentTask,
  ).toMatchObject({ taskId: "task:2", status: "OPEN" });
});
it("pending activity retains a named provisional task without claiming fresh INPROG", () => {
  const input = fixture();
  input.state.focusTaskId = "task:2";
  input.unsettled = true;
  expect(projectBoard(input).currentTask).toMatchObject({
    taskId: "task:1",
    status: "OPEN",
  });
  expect(
    projectBoard(input).tasks.every((task) => task.status !== "INPROG"),
  ).toBe(true);
});
it("skips completed and archived tasks and never fabricates eligible work", () => {
  const input = fixture();
  const [a, b] = input.state.tasks;
  if (!a || !b) throw new Error("Missing tasks");
  a.status = "done";
  expect(projectBoard(input).currentTask?.taskId).toBe(b.id);
  b.included = false;
  expect(projectBoard(input).currentTask).toBeUndefined();
  expect(
    projectBoard({ ...input, lastDisplayedTaskId: a.id }).currentTask,
  ).toMatchObject({ taskId: a.id, status: "DONE" });
});
