import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  EvaluationRequest,
  ValidatedResult,
} from "../src/analysis/gateway";
import { processObservation } from "../src/core/hybrid";
import { emptyState } from "../src/core/hybrid-state";
import { canonicalMessages } from "../src/sources/messages";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const message = (
  id: string,
  text: string,
  role: "user" | "assistant" = "user",
) => ({ id, text, role, hash: hash(text) });
const ci = message(
  "ci-request",
  "Inspect the latest CI runs and diagnose the coverage-unclassified failure. Fix its cause and verify the coverage check passes.",
);
const labels = [
  "Inspect and diagnose the CI failure",
  "Fix the coverage classification bug",
  "Verify the coverage check",
];
const blank = () => ({
  add: [] as { label: string; kind: string; basis: string; quote: string }[],
  revise: [],
  archive: [],
  restore: [],
  unresolved: false,
});
function additions(text: string, names = labels, kind = "action") {
  return {
    ...blank(),
    add: names.map((label) => ({
      label,
      kind,
      basis: "explicit",
      quote: text,
    })),
  };
}
type Judgment = { choice: string; confidence?: number; probability?: number };
function choice(
  question: EvaluationRequest["questions"][string],
  judgment: Judgment,
) {
  if (question.type !== "choice") throw new Error("Expected a choice question");
  const keys = Object.keys(question.criteria);
  expect(keys).toContain(judgment.choice);
  const probability = judgment.probability ?? 1;
  return {
    type: "choice" as const,
    choice: judgment.choice,
    confidence: judgment.confidence ?? 1,
    probabilities: Object.fromEntries(
      keys.map((key) => [
        key,
        key === judgment.choice
          ? probability
          : (1 - probability) / (keys.length - 1),
      ]),
    ),
  };
}
function providers(
  patch: unknown = additions(ci.text),
  gate: Judgment = { choice: "changed" },
  statuses: Record<string, Judgment> = {},
) {
  const evaluate = vi.fn(
    async (request: EvaluationRequest): Promise<ValidatedResult> => {
      expect(request.model).toBe("jev-1.13.0");
      expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(
        24 * 1024,
      );
      expect(Object.keys(request.questions).length).toBeLessThanOrEqual(20);
      return {
        model: "jev-1.13.0",
        usage: { input_tokens: 1, output_tokens: 1 },
        answers: Object.fromEntries(
          Object.entries(request.questions).map(([id, question]) => [
            id,
            choice(
              question,
              id === "gate" ? gate : (statuses[id] ?? { choice: "no" }),
            ),
          ]),
        ),
      };
    },
  );
  const extract = vi.fn(async (_input: unknown) =>
    typeof patch === "string" ? patch : JSON.stringify(patch),
  );
  return { evaluate, extract };
}
async function seeded() {
  return processObservation(emptyState("session:test"), ci, providers());
}

describe("hybrid fresh-session core vertical", () => {
  it("decomposes a compound request into code-owned grounded tasks, not source spans", async () => {
    const original = emptyState("session:test");
    const p = providers();
    const state = await processObservation(original, ci, p);
    expect(original.tasks).toEqual([]);
    expect(state.tasks.map((task) => task.label)).toEqual(labels);
    expect(state.tasks.map((task) => task.id)).toEqual([
      "task:1",
      "task:2",
      "task:3",
    ]);
    expect(state.nextTaskId).toBe(4);
    expect(
      state.tasks.every(
        (task) => task.status === "not-started" && task.included,
      ),
    ).toBe(true);
    expect(state.tasks[0]?.source).toMatchObject({
      entryId: ci.id,
      messageHash: ci.hash,
      role: "user",
      start: 0,
      end: ci.text.length,
      quoteHash: hash(ci.text),
    });
    expect(state.cursor).toMatchObject({ id: ci.id, hash: ci.hash });
    expect(state.focusTaskId).toBe("task:1");
    expect(p.extract).toHaveBeenCalledTimes(1);
    expect(
      p.evaluate.mock.calls.flatMap(([request]) =>
        Object.keys(request.questions),
      ),
    ).toEqual([
      "gate",
      "complete:task:1",
      "complete:task:2",
      "complete:task:3",
    ]);
  });
  it("skips extraction on accepted unchanged but independently completes later tasks", async () => {
    const initial = await seeded();
    const p = providers(
      blank(),
      { choice: "unchanged" },
      {
        "complete:task:2": { choice: "yes" },
        "complete:task:3": { choice: "yes" },
      },
    );
    const state = await processObservation(
      initial,
      message(
        "later",
        "The fix and validation are complete; investigation is still ongoing.",
        "assistant",
      ),
      p,
    );
    expect(p.extract).not.toHaveBeenCalled();
    expect(state.tasks.map((task) => task.status)).toEqual([
      "not-started",
      "done",
      "done",
    ]);
    expect(state.focusTaskId).toBe("task:1");
    expect(initial.tasks.every((task) => task.status === "not-started")).toBe(
      true,
    );
  });
  it("does not let one uncertain task block an independent task's completion", async () => {
    const p = providers(
      blank(),
      { choice: "unchanged" },
      {
        "complete:task:1": { choice: "uncertain" },
        "complete:task:3": { choice: "yes" },
      },
    );
    const state = await processObservation(
      await seeded(),
      message(
        "parallel",
        "Implementation and regression work continue; validation is finished.",
        "assistant",
      ),
      p,
    );
    expect(state.tasks.map((task) => task.status)).toEqual([
      "not-started",
      "not-started",
      "done",
    ]);
    expect(state.tasks[0]?.latestAssessment).toMatchObject({
      rawChoice: "uncertain",
      reason: "semantic-unknown",
      source: { entryId: "parallel" },
    });
  });
  it.each([
    [{ choice: "uncertain" }, "semantic-unknown"],
    [{ choice: "changed", probability: 0.79 }, "threshold-abstention"],
    [{ choice: "unchanged", confidence: 0.49 }, "threshold-abstention"],
  ] as const)(
    "forwards gate uncertainty without hiding its distinct reason: %j",
    async (gate, reason) => {
      const p = providers(additions(ci.text), gate);
      const state = await processObservation(emptyState("session:test"), ci, p);
      expect(p.extract).toHaveBeenCalledTimes(1);
      expect(state.scopeAssessment).toMatchObject({
        rawChoice: gate.choice,
        reason,
      });
      expect(state.tasks).toHaveLength(3);
    },
  );
  it("assesses newly discovered completed work in the SAME observation after extraction", async () => {
    const observation = message(
      "delivered",
      "I added the NFC normalization regression test.",
      "assistant",
    );
    const p = providers(
      additions(observation.text, ["Add an NFC normalization regression"]),
      { choice: "changed" },
      { "complete:task:1": { choice: "yes" } },
    );
    const state = await processObservation(
      emptyState("session:test"),
      observation,
      p,
    );
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]).toMatchObject({
      status: "done",
      id: "task:1",
      source: { entryId: "delivered" },
      latestAssessment: { rawChoice: "yes", source: { entryId: "delivered" } },
    });
    const completion = p.evaluate.mock.calls.find(
      ([request]) => "complete:task:1" in request.questions,
    )?.[0];
    expect(JSON.stringify(completion?.state)).toContain(
      "Add an NFC normalization regression",
    );
  });
  it.each([
    [
      { choice: "yes", confidence: 0.49, probability: 0.99 },
      "not-started",
      "threshold-abstention",
    ],
    [
      { choice: "yes", confidence: 1, probability: 0.79 },
      "not-started",
      "threshold-abstention",
    ],
    [{ choice: "yes", confidence: 0.5, probability: 0.8 }, "done", "accepted"],
  ] as const)(
    "keeps established completion thresholds: %j",
    async (judgment, expected, reason) => {
      const p = providers(
        additions(ci.text, [labels[0] as string]),
        { choice: "changed" },
        { "complete:task:1": judgment },
      );
      const state = await processObservation(emptyState("session:test"), ci, p);
      expect(state.tasks[0]?.status).toBe(expected);
      expect(state.tasks[0]?.latestAssessment).toMatchObject({
        rawChoice: "yes",
        reason,
        confidence: judgment.confidence,
        probability: judgment.probability,
      });
    },
  );
  it("allows answering response work without completing an action task", async () => {
    const observation = message(
      "question",
      "Explain the failure, then fix the parser.",
    );
    const patch = additions(observation.text, [
      "Explain the failure",
      "Fix the parser",
    ]);
    const first = patch.add[0];
    if (first) first.kind = "response";
    const state = await processObservation(
      emptyState("session:test"),
      observation,
      providers(patch),
    );
    const completed = await processObservation(
      state,
      message(
        "answer",
        "The failure occurs because the classifier omits the new prompt; I have not changed it yet.",
        "assistant",
      ),
      providers(
        blank(),
        { choice: "unchanged" },
        { "complete:task:1": { choice: "yes" } },
      ),
    );
    expect(completed.tasks.map((task) => [task.kind, task.status])).toEqual([
      ["response", "done"],
      ["action", "not-started"],
    ]);
  });
  it("keeps replay idempotent without duplicate provider work or tasks", async () => {
    const p = providers();
    const first = await processObservation(emptyState("session:test"), ci, p);
    p.evaluate.mockClear();
    p.extract.mockClear();
    const second = await processObservation(first, ci, p);
    expect(second).toEqual(first);
    expect(p.evaluate).not.toHaveBeenCalled();
    expect(p.extract).not.toHaveBeenCalled();
  });
  it("supplies earlier bounded context but not private tool bodies or full state", async () => {
    const p = providers();
    const earlier = message("earlier", "The repository check is failing.");
    await processObservation(emptyState("session:test"), ci, p, [earlier]);
    const input = JSON.stringify(p.extract.mock.calls[0]?.[0]);
    expect(input).toContain(ci.text);
    expect(input).toContain(earlier.text);
    expect(input).not.toContain("TYPESAFE_API_KEY");
  });
});

describe("strict atomic task extraction", () => {
  it.each([
    "malformed",
    "fenced",
    "unknown-key",
    "status",
    "model-id",
    "invalid-quote",
    "too-many",
    "too-long",
    "unresolved-mutation",
    "invalid-kind",
  ])(
    "rejects %s without mutating prior tasks, while completion remains independent",
    async (variant) => {
      const initial = await seeded();
      const observation = message(
        "bad-patch",
        "Please add a diagnostic report.",
      );
      const patch: Record<string, unknown> = additions(observation.text, [
        "Write diagnostic report",
      ]);
      const add = (patch.add as Record<string, unknown>[])[0] as Record<
        string,
        unknown
      >;
      if (variant === "unknown-key") patch.surprise = true;
      if (variant === "status") add.status = "done";
      if (variant === "model-id") add.id = "task:1";
      if (variant === "invalid-quote")
        add.quote = "This text does not occur in the message";
      if (variant === "too-many")
        patch.add = Array.from({ length: 7 }, (_, i) => ({
          ...add,
          label: `Distinct task ${i}`,
        }));
      if (variant === "too-long") add.label = "x".repeat(241);
      if (variant === "unresolved-mutation") patch.unresolved = true;
      if (variant === "invalid-kind") add.kind = "tool";
      const raw =
        variant === "malformed"
          ? "not JSON"
          : variant === "fenced"
            ? `\`\`\`json\n${JSON.stringify(patch)}\n\`\`\``
            : patch;
      const p = providers(
        raw,
        { choice: "changed" },
        { "complete:task:3": { choice: "yes" } },
      );
      const state = await processObservation(initial, observation, p);
      expect(state.tasks.map((task) => task.label)).toEqual(labels);
      expect(state.nextTaskId).toBe(initial.nextTaskId);
      expect(state.tasks.map((task) => task.status)).toEqual([
        "not-started",
        "not-started",
        "done",
      ]);
      expect(state.scopeError).toBeTruthy();
      expect(state.cursor?.id).toBe(observation.id);
      expect(initial.tasks.every((task) => task.status === "not-started")).toBe(
        true,
      );
    },
  );
  it("records a valid unresolved extraction without inventing tasks", async () => {
    const state = await processObservation(
      emptyState("session:test"),
      ci,
      providers({ ...blank(), unresolved: true }),
    );
    expect(state.tasks).toEqual([]);
    expect(state.scopeUnresolved).toBe(true);
    expect(state.cursor?.id).toBe(ci.id);
  });
});

describe("canonical whole-message observations", () => {
  it("preserves dotted paths and Unicode as whole canonical messages, not split task labels", () => {
    const text =
      "Read .agents/plans/2026/plan.md and https://example.test/v1.2. Use 🧪 and café.";
    const found = canonicalMessages([
      {
        type: "message",
        id: "canonical",
        parentId: null,
        message: { role: "user", content: text },
      },
    ]);
    expect(found).toEqual([message("canonical", text)]);
  });
  it("excludes tool/custom/error/aborted records and preserves eligible order", () => {
    const found = canonicalMessages([
      {
        type: "custom",
        id: "monitor",
        customType: "pi-progress-bar",
        data: { text: "PRIVATE" },
      },
      {
        type: "message",
        id: "user",
        message: { role: "user", content: "Request" },
      },
      {
        type: "message",
        id: "tool",
        message: { role: "toolResult", content: "PRIVATE" },
      },
      {
        type: "message",
        id: "failed",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Incorrect completion" }],
          stopReason: "error",
        },
      },
      {
        type: "message",
        id: "aborted",
        message: {
          role: "assistant",
          content: "Incorrect completion",
          stopReason: "aborted",
        },
      },
      {
        type: "message",
        id: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "PRIVATE" },
            { type: "text", text: "Visible result" },
          ],
          stopReason: "stop",
        },
      },
    ]);
    expect(found).toEqual([
      message("user", "Request"),
      message("assistant", "Visible result", "assistant"),
    ]);
    expect(JSON.stringify(found)).not.toContain("PRIVATE");
  });
});
