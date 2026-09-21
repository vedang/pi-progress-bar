import { expect, it, vi } from "vitest";
import { CorrectionController } from "../src/advisory/corrections";
import type {
  EvaluationRequest,
  ValidatedResult,
} from "../src/analysis/gateway";

const source = () => ({
  sourceRun: 1,
  policy: {
    coverage: "complete",
    entries: [
      {
        role: "system",
        source: "contextFile",
        path: "/repo/AGENTS.md",
        text: "Preserve existing validation; new disposable tests are optional.",
      },
    ],
  },
  action: {
    coverage: "complete",
    role: "assistant",
    text: "Starting a new failing test for the disposable parser now.",
    batch: [{ toolName: "write", path: "tests/parser.ts", current: true }],
  },
});
const conversation = () => [
  {
    role: "user",
    text: "Implement the disposable parser; no new test required.",
  },
  {
    role: "intercom",
    text: "Peer suggests writing a test, not a user requirement.",
  },
];
async function exercise(
  origin: unknown,
  authority: unknown = { coverage: "complete", conversation: conversation() },
) {
  const emit = vi.fn();
  const evaluate = vi.fn(
    async (request: EvaluationRequest): Promise<ValidatedResult> => ({
      model: "jev-1.13.0",
      usage: { input_tokens: 1, output_tokens: 1 },
      answers: Object.fromEntries(
        Object.keys(request.questions).map((key) => [
          key,
          {
            type: "choice",
            choice: "nudge",
            confidence: 1,
            probabilities: { nudge: 1, required: 0, unrelated: 0, unknown: 0 },
          },
        ]),
      ),
    }),
  );
  const controller = Reflect.construct(CorrectionController, [
    {
      snapshot: () => ({
        enabled: true,
        ready: true,
        identity: "production-fingerprint",
        sourceRun: 1,
        context: [],
        authority,
        tasks: [
          {
            id: "task:1",
            label: "Implement disposable parser",
            revision: 1,
            included: true,
            status: "not-started",
            red: {
              choice: "not-needed",
              revision: 1,
              confidence: 1,
              probability: 1,
            },
          },
        ],
      }),
      evaluate,
      emit,
    },
  ]) as CorrectionController;
  try {
    await Reflect.apply(controller.observe, controller, [
      {
        kind: "test",
        id: "write-1",
        toolName: "write",
        path: "tests/parser.ts",
      },
      origin,
    ]);
    return { evaluate, emit };
  } finally {
    controller.dispose();
  }
}
it("carries observed policy, canonical roles and current action in the single binding request", async () => {
  const h = await exercise(source());
  expect(h.evaluate).toHaveBeenCalledTimes(1);
  const request = h.evaluate.mock.calls[0][0];
  expect(request.state).toMatchObject({
    authority: {
      policy: source().policy,
      conversation: conversation(),
      action: source().action,
    },
  });
  expect(Object.keys(request.questions)).toEqual(["correct:task:1"]);
  expect(JSON.stringify(request)).toContain("hasCurrentNotNeededFact");
  expect(Object.keys(request.questions)).not.toContain("redApplicability");
  expect(h.emit).toHaveBeenCalledTimes(1);
});
it.each([
  "missing-source",
  "policy-unknown",
  "action-unknown",
  "conversation-unknown",
  "invalid-role",
  "oversized-conversation",
])(
  "abstains before dispatch for incomplete authority: %s",
  async (scenario) => {
    const origin = source();
    let authority: unknown = {
      coverage: "complete",
      conversation: conversation(),
    };
    if (scenario === "policy-unknown") origin.policy.coverage = "unknown";
    if (scenario === "action-unknown") origin.action.coverage = "unknown";
    if (scenario === "conversation-unknown")
      authority = { coverage: "unknown", conversation: [] };
    if (scenario === "invalid-role")
      authority = {
        coverage: "complete",
        conversation: [{ role: "tool", text: "PRIVATE_TOOL_OUTPUT" }],
      };
    if (scenario === "oversized-conversation")
      authority = {
        coverage: "complete",
        conversation: [{ role: "user", text: "x".repeat(4097) }],
      };
    const h = await exercise(
      scenario === "missing-source" ? undefined : origin,
      authority,
    );
    expect(h.evaluate).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  },
);
