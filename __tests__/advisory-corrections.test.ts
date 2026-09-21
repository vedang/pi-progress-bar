import { afterEach, expect, it, vi } from "vitest";
import { CorrectionController } from "../src/advisory/corrections";
import type {
  EvaluationRequest,
  ValidatedResult,
} from "../src/analysis/gateway";
import { correctionSource } from "./fixtures/correction-source";

type Task = {
  id: string;
  label: string;
  revision: number;
  included: boolean;
  status: string;
  red?: {
    choice: string;
    confidence: number;
    probability: number;
    revision: number;
  };
};
type Snapshot = {
  enabled: boolean;
  ready: boolean;
  identity: string;
  tasks: Task[];
  context: string[];
};
type Attempt = {
  kind: "test" | "review";
  id: string;
  toolName: string;
  path?: string;
  runId?: string;
};
type Controller = { observe(attempt: Attempt): Promise<void>; dispose(): void };
const active: Controller[] = [];
afterEach(() => {
  for (const c of active.splice(0)) c.dispose();
});
const task = (id = "task:1"): Task => ({
  id,
  label: "Implement parser",
  revision: 1,
  included: true,
  status: "not-started",
  red: { choice: "not-needed", confidence: 1, probability: 1, revision: 1 },
});
function result(
  request: EvaluationRequest,
  choice = "nudge",
  confidence = 1,
  probability = 1,
): ValidatedResult {
  return {
    model: "jev-1.13.0",
    usage: { input_tokens: 1, output_tokens: 1 },
    answers: Object.fromEntries(
      Object.keys(request.questions).map((id) => [
        id,
        {
          type: "choice",
          choice,
          confidence,
          probabilities: {
            nudge: choice === "nudge" ? probability : 0,
            required: choice === "required" ? probability : 0,
            unrelated: choice === "unrelated" ? probability : 0,
            unknown: choice === "unknown" ? probability : 1 - probability,
          },
        },
      ]),
    ),
  };
}
async function fixture() {
  let state: Snapshot = {
    enabled: true,
    ready: true,
    identity: "session:1",
    tasks: [task()],
    context: [
      "Implement the parser. No requirement to add a new test.",
      "Starting a new failing parser test.",
    ],
  };
  const emit = vi.fn();
  const evaluate = vi.fn(async (r: EvaluationRequest) => result(r));
  const underlying = new CorrectionController({
    snapshot: () => ({
      ...structuredClone(state),
      authority: {
        coverage: "complete" as const,
        conversation: state.context.map((text, index) => ({
          role: index === 0 ? ("user" as const) : ("assistant" as const),
          text,
        })),
      },
    }),
    evaluate,
    emit,
  });
  const controller: Controller = {
    observe: (value) =>
      Reflect.apply(underlying.observe, underlying, [
        value,
        correctionSource(value),
      ]),
    dispose: () => underlying.dispose(),
  };
  active.push(controller);
  return {
    controller,
    emit,
    evaluate,
    set: (patch: Partial<Snapshot>) => {
      state = { ...state, ...patch };
    },
    state: () => state,
  };
}
const attempt: Attempt = {
  kind: "test",
  id: "call-1",
  toolName: "write",
  path: "__tests__/parser.test.ts",
};
it("asks only task/attempt/policy binding and reuses existing not-needed fact", async () => {
  const h = await fixture();
  await h.controller.observe(attempt);
  expect(h.evaluate).toHaveBeenCalledTimes(1);
  const request = h.evaluate.mock.calls[0][0];
  expect(Object.keys(request.questions)).toEqual(["correct:task:1"]);
  expect(JSON.stringify(request)).not.toContain("redApplicability");
  expect(h.emit).toHaveBeenCalledExactlyOnceWith({
    kind: "test-correction",
    attemptId: "call-1",
    binding: { attemptId: "call-1", sourceRun: 1, fingerprint: "session:1" },
    content:
      "Task Implement parser does not need a failing test, as the test will not provide any long-term value. Please directly start with the implementation instead.",
  });
});
it("includes full board, never only focused task", async () => {
  const h = await fixture();
  h.set({
    tasks: [
      task(),
      { ...task("task:2"), label: "Validate changes", red: undefined },
    ],
  });
  await h.controller.observe(attempt);
  const request = h.evaluate.mock.calls[0][0];
  expect(JSON.stringify(request.state)).toContain("Validate changes");
  expect(JSON.stringify(request.state)).toContain("Implement parser");
});
it.each(["needed", "unknown", "missing", "stale", "weak"])(
  "does not dispatch necessity again for %s health",
  async (reason) => {
    const h = await fixture();
    const t = task();
    if (!t.red) throw new Error("Missing fixture health");
    if (reason === "missing") t.red = undefined;
    else if (reason === "stale") t.red.revision = 2;
    else if (reason === "weak") t.red.probability = 0.79;
    else t.red.choice = reason;
    h.set({ tasks: [t] });
    await h.controller.observe(attempt);
    expect(h.evaluate).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  },
);
it.each(["required", "unrelated", "unknown"])(
  "abstains for %s binding/policy",
  async (choice) => {
    const h = await fixture();
    h.evaluate.mockImplementation(async (r) => result(r, choice));
    await h.controller.observe(attempt);
    expect(h.emit).not.toHaveBeenCalled();
  },
);
it("dedupes exact tool event, allows distinct attempt, passes bounded prior attempt context", async () => {
  const h = await fixture();
  await h.controller.observe(attempt);
  await h.controller.observe(attempt);
  expect(h.evaluate).toHaveBeenCalledTimes(1);
  await h.controller.observe({ ...attempt, id: "call-2" });
  expect(h.evaluate).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(h.evaluate.mock.calls[1][0].state)).toContain(
    "parser.test.ts",
  );
  expect(h.emit).toHaveBeenCalledTimes(2);
});
it("never accepts weak classifier confidence/probability", async () => {
  const h = await fixture();
  h.evaluate.mockImplementation(async (r) => result(r, "nudge", 0.49, 1));
  await h.controller.observe(attempt);
  expect(h.emit).not.toHaveBeenCalled();
  h.evaluate.mockImplementation(async (r) => result(r, "nudge", 1, 0.79));
  await h.controller.observe({ ...attempt, id: "call-2" });
  expect(h.emit).not.toHaveBeenCalled();
});
it.each(["off", "unready", "too-many", "context-overflow", "unsafe-path"])(
  "suppresses %s before provider dispatch",
  async (reason) => {
    const h = await fixture();
    if (reason === "off") h.set({ enabled: false });
    if (reason === "unready") h.set({ ready: false });
    if (reason === "too-many")
      h.set({
        tasks: Array.from({ length: 21 }, (_, i) => task(`task:${i + 1}`)),
      });
    if (reason === "context-overflow") h.set({ context: ["x".repeat(25_000)] });
    await h.controller.observe(
      reason === "unsafe-path"
        ? { ...attempt, path: "../../private.ts" }
        : attempt,
    );
    expect(h.evaluate).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  },
);
it("discards result after authority changes", async () => {
  const h = await fixture();
  h.evaluate.mockImplementation(async (r) => {
    h.set({ identity: "session:2" });
    return result(r);
  });
  await h.controller.observe(attempt);
  expect(h.emit).not.toHaveBeenCalled();
});
it("uses exact review message after trusted adapter supplies launched run id", async () => {
  const h = await fixture();
  h.set({ tasks: [{ ...task(), red: undefined }] });
  await h.controller.observe({
    kind: "review",
    id: "review-call",
    toolName: "subagent",
    runId: "launched-run",
  });
  expect(h.emit).toHaveBeenCalledExactlyOnceWith({
    kind: "review-correction",
    attemptId: "review-call",
    binding: {
      attemptId: "review-call",
      sourceRun: 1,
      fingerprint: "session:1",
    },
    content:
      "Reviewing the work done so far is premature. Please cancel the review and continue with the implementation. It is better to review the work when a bigger chunk of it has been completed.",
  });
});
it("never treats a review declaration without launch receipt as launched", async () => {
  const h = await fixture();
  await h.controller.observe({
    kind: "review",
    id: "review-call",
    toolName: "subagent",
  });
  expect(h.evaluate).not.toHaveBeenCalled();
});
it("does not retain or send extra raw tool fields", async () => {
  const h = await fixture();
  await h.controller.observe({
    ...attempt,
    content: "PRIVATE_TOOL_BODY",
    arguments: "PRIVATE_ARGUMENTS",
  } as Attempt);
  expect(JSON.stringify(h.evaluate.mock.calls)).not.toContain("PRIVATE_");
});

it("does not confuse existing validation or a later review requirement with authority to do the corrective action now", async () => {
  const h = await fixture();
  await h.controller.observe(attempt);
  const testPolicy = JSON.stringify(h.evaluate.mock.calls[0][0]);
  expect(testPolicy).toContain(
    "Existing tests and validation remain required, but that alone does not require a NEW failing test",
  );
  await h.controller.observe({
    kind: "review",
    id: "review-policy",
    toolName: "subagent",
    runId: "running",
  });
  const reviewPolicy = JSON.stringify(h.evaluate.mock.calls[1][0]);
  expect(reviewPolicy).toContain(
    "A requirement to review later, after completion, is not a requirement to review now",
  );
});

it("fits twenty ordinary task questions without duplicating the common policy per row", async () => {
  const h = await fixture();
  h.set({ tasks: Array.from({ length: 20 }, (_, i) => task(`task:${i + 1}`)) });
  await h.controller.observe(attempt);
  expect(h.evaluate).toHaveBeenCalledTimes(1);
  expect(Object.keys(h.evaluate.mock.calls[0][0].questions)).toHaveLength(20);
  expect(
    Buffer.byteLength(JSON.stringify(h.evaluate.mock.calls[0][0])),
  ).toBeLessThanOrEqual(24 * 1024);
});

it("does not choose a unique target merely because only one of two nudge claims crosses threshold", async () => {
  const h = await fixture();
  h.set({ tasks: [task(), task("task:2")] });
  h.evaluate.mockImplementation(async (r) => {
    const value = result(r);
    value.answers["correct:task:1"] = {
      type: "choice",
      choice: "nudge",
      confidence: 0.57,
      probabilities: {
        nudge: 0.67,
        unknown: 0.2,
        unrelated: 0.13,
        required: 0,
      },
    };
    value.answers["correct:task:2"] = {
      type: "choice",
      choice: "nudge",
      confidence: 0.76,
      probabilities: {
        nudge: 0.82,
        unknown: 0.09,
        unrelated: 0.09,
        required: 0,
      },
    };
    return value;
  });
  await h.controller.observe(attempt);
  expect(h.emit).not.toHaveBeenCalled();
});
