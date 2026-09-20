import type {
  TerminalInputHandler,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import type { ScopePatch } from "../src/analysis/extractor";
import type { EvaluationRequest } from "../src/analysis/gateway";
import { createUiController } from "../src/ui/controller";
import type { UiHost } from "../src/ui/host";
import { addPatch, noPatch } from "./fixtures/hybrid";
import { monitorHarness } from "./fixtures/hybrid-monitor";
import { required } from "./fixtures/task-details";

const running: ReturnType<typeof monitorHarness>[] = [];
afterEach(() => {
  for (const h of running.splice(0)) h.monitor.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
it("one live monitor updates widget and already-open board through focus, abstention, DONE, revision, archive, restore and OFF", async () => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline-key");
  let operation: "none" | "revise" | "archive" | "restore" = "none";
  const h = monitorHarness(undefined, {
    extractionText: (input) => {
      if (input.latest.id === "goal")
        return JSON.stringify(
          addPatch(input.latest, ["Implement parser", "Add regression"]),
        );
      const patch: ScopePatch = noPatch();
      if (operation === "archive")
        patch.archive = [{ id: "task:2", quote: input.latest.text }];
      else if (operation !== "none")
        patch[operation] = [
          {
            id: "task:2",
            label: "Expand regression",
            requirementsChanged: operation === "revise",
            quote: input.latest.text,
          },
        ];
      return JSON.stringify(patch);
    },
  });
  running.push(h);
  let focus = "none",
    complete = "no",
    lowConfidence = false;
  const transport = required(h.fetch.getMockImplementation());
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body)) as EvaluationRequest;
    const response = await transport(url, init);
    const body = (await response.json()) as {
      answers: Record<string, unknown>;
    };
    for (const [key, question] of Object.entries(request.questions)) {
      const choice =
        key === "focus"
          ? focus
          : key === "activityFocus"
            ? "task:2"
            : key.startsWith("complete:")
              ? complete
              : key === "gate" && operation !== "none"
                ? "changed"
                : undefined;
      if (!choice || question.type !== "choice") continue;
      const weak = lowConfidence && key.startsWith("complete:");
      const probability = weak ? (key.endsWith("1") ? 0.54 : 0.69) : 1;
      const confidence = weak ? (key.endsWith("1") ? 0.31 : 0.53) : 1;
      const keys = Object.keys(question.criteria);
      body.answers[key] = {
        type: "choice",
        choice,
        confidence,
        probabilities: Object.fromEntries(
          keys.map((key) => [
            key,
            key === choice
              ? probability
              : (1 - probability) / (keys.length - 1),
          ]),
        ),
      };
    }
    return Response.json(body);
  });
  h.start();
  await h.settle("goal");
  let widget: Component | undefined,
    board: Component | undefined,
    listener: TerminalInputHandler | undefined,
    overlayOpen = false;
  const close = vi.fn(() => {
    overlayOpen = false;
  });
  const unsubscribe = vi.fn();
  const theme = {
    fg: (_: string, text: string) => text,
    bg: (_: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  const host: UiHost = {
    attach: (factory) => {
      widget = factory({ terminal: { rows: 60 } } as TUI, theme);
    },
    canActivate: (data) => !overlayOpen && data === "\u001b[C",
    onInput: (fn) => {
      listener = fn;
      return unsubscribe;
    },
    requestRender: vi.fn(),
    dispose: vi.fn(),
    openOverlay: vi.fn((component) => {
      board = component;
      overlayOpen = true;
      return { isFocused: () => overlayOpen, close };
    }),
  };
  const snapshot = () => ({
    presentation: h.monitor.presentationSnapshot(),
    board: h.monitor.boardSnapshot(),
  });
  const controller = createUiController(host, snapshot());
  h.changed.mockImplementation(() => controller.update(snapshot()));
  const widgetText = () => required(widget).render(180).join("\n");
  const boardText = () => required(board).render(180).join("\n");
  const assertStatus = (id: string, label: string, status: string) => {
    expect(
      h.monitor.boardSnapshot().tasks.find((task) => task.taskId === id)
        ?.status,
    ).toBe(status);
    expect(
      boardText()
        .split("\n")
        .some((line) => line.includes(label) && line.includes(status)),
    ).toBe(true);
  };
  expect(widgetText()).toContain("(OPEN)");
  expect(widgetText()).toContain("0/2");
  required(listener)("\u001b[C");
  required(listener)("\r");
  assertStatus("task:1", "Implement parser", "OPEN");
  focus = "task:1";
  h.append("working", "I am implementing the parser.");
  await h.settle("working");
  assertStatus("task:1", "Implement parser", "INPROG");
  expect(widgetText()).toContain("(INPROG)");
  const tool = {
    type: "toolCall",
    id: "live-switch",
    name: "edit",
    arguments: { path: "regression.test.ts" },
  };
  h.monitor.observeActivityDeclaration({ role: "assistant", content: [tool] });
  h.monitor.observeActivityStart(tool.id, tool.name, tool.arguments);
  h.monitor.observeActivityTurnEnd({ role: "assistant", content: [tool] });
  await vi.advanceTimersByTimeAsync(100);
  assertStatus("task:2", "Add regression", "INPROG");
  expect(widgetText()).toContain("Add regression");
  focus = "none";
  complete = "yes";
  lowConfidence = true;
  h.append(
    "manual-abstention",
    "Read and validated the work; waiting for your go-ahead.",
  );
  await h.settle("manual-abstention");
  expect(widgetText()).toContain("0/2");
  for (const task of h.monitor.boardSnapshot().tasks)
    expect(task.status).toBe("OPEN");
  const displayedId = h.monitor.boardSnapshot().currentTask?.taskId;
  const displayedLabel = required(
    h.monitor.boardSnapshot().tasks.find((task) => task.taskId === displayedId),
  ).label;
  lowConfidence = false;
  h.append(
    "accepted-done",
    "Both parser and regression deliverables are complete.",
  );
  await h.settle("accepted-done");
  expect(widgetText()).toContain("2/2");
  expect(widgetText()).toContain("(DONE)");
  expect(widgetText()).toContain(displayedLabel);
  expect(h.monitor.boardSnapshot().currentTask?.taskId).toBe(displayedId);
  assertStatus("task:2", "Add regression", "DONE");
  complete = "no";
  operation = "revise";
  h.append(
    "revise-regression",
    "Expand regression coverage to empty input.",
    "user",
  );
  await h.settle("revise-regression");
  assertStatus("task:2", "Expand regression", "OPEN");
  expect(widgetText()).toContain("(OPEN)");
  operation = "archive";
  h.append("archive-regression", "Remove the regression task.", "user");
  await h.settle("archive-regression");
  assertStatus("task:2", "Expand regression", "ARCHIVED");
  expect(widgetText()).not.toContain("Expand regression (DONE)");
  operation = "restore";
  h.append("restore-regression", "Restore the regression task.", "user");
  await h.settle("restore-regression");
  assertStatus("task:2", "Expand regression", "OPEN");
  const calls = h.fetch.mock.calls.length,
    reads = h.reader.mock.calls.length,
    saves = h.save.mock.calls.length;
  for (let i = 0; i < 20; i++) {
    widgetText();
    boardText();
  }
  expect(h.fetch).toHaveBeenCalledTimes(calls);
  expect(h.reader).toHaveBeenCalledTimes(reads);
  expect(h.save).toHaveBeenCalledTimes(saves);
  expect(host.openOverlay).toHaveBeenCalledTimes(1);
  h.monitor.turnOff();
  await vi.advanceTimersByTimeAsync(20);
  expect(close).toHaveBeenCalledTimes(1);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  controller.dispose();
  expect(close).toHaveBeenCalledTimes(1);
});
