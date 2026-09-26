import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  JevGateway,
  MODEL,
  type ValidatedResult,
} from "../src/analysis/gateway";
import {
  applySubtaskGate,
  buildSubtaskGate,
  reusableSubtaskGate,
} from "../src/analysis/subtask-gate";
import type { Observation } from "../src/core/hybrid-state";
import type { SubtaskJournalCheckpoint } from "../src/core/subtask-journal";
import { SubtaskStore } from "../src/core/subtasks";
import {
  subtaskAdmission,
  subtaskHash,
  subtaskParent,
} from "./fixtures/subtasks";

function fixture(
  text = "Compare deployment options, then explain your recommendation.",
) {
  const parent = subtaskParent();
  const parentSource: Observation = {
    id: "request",
    role: "user",
    text: "Compare the deployment options and recommend an approach.",
    hash: parent.source.messageHash,
  };
  const latest: Observation = {
    id: "latest",
    role: "user",
    text,
    hash: subtaskHash(text),
  };
  const observations = [parentSource, latest];
  const options = {
    parent,
    latest,
    earlier: [] as Observation[],
    omissions: [] as string[],
    selectedModel: "fixture/selected",
    group: undefined as
      | ReturnType<SubtaskStore["snapshot"]>["groups"][number]
      | undefined,
    resolve: (id: string) => observations.find((item) => item.id === id),
  };
  const batch = buildSubtaskGate(options);
  if (!batch) throw new Error("Expected non-file subtask gate");
  const result: ValidatedResult = {
    model: MODEL,
    answers: Object.fromEntries(
      Object.keys(batch.request.questions).map((key) => [
        key,
        {
          type: "choice",
          choice: "yes",
          confidence: 0.5,
          probabilities: { yes: 0.8, no: 0.1, uncertain: 0.1 },
        },
      ]),
    ),
    usage: { input_tokens: 3, output_tokens: 5 },
  };
  return { parentSource, latest, observations, options, batch, result };
}
const ticket = { dispatch: 1, at: 123 };

describe("conversation-grounded per-parent subtask gate", () => {
  it("permits grounded reword/removal-only refinement without requiring additional steps", () => {
    const h = fixture(
      "Reword the comparison step for clarity and remove the recommendation step; do not add work.",
    );
    const store = new SubtaskStore();
    expect(store.admit(subtaskAdmission())).toEqual({ accepted: true });
    h.options.group = store.snapshot().groups[0];
    const batch = buildSubtaskGate(h.options);
    if (!batch) throw new Error("Expected refinement gate");
    const instructions = Object.values(batch.request.questions)[0].instructions;
    expect(instructions).not.toMatch(
      /yes only when meaningful additional steps/i,
    );
    expect(instructions).toMatch(/reword/i);
    expect(instructions).toMatch(/remov/i);
    // Rubric coverage only; semantic quality still requires C10 fresh evaluation.
  });

  it("accepts nonempty canonical earlier context and preserves source roles/order", () => {
    const h = fixture();
    const prior: Observation = {
      id: "prior-answer",
      role: "assistant",
      text: "I will compare costs before recommending an approach.",
      hash: subtaskHash(
        "I will compare costs before recommending an approach.",
      ),
    };
    h.observations.push(prior);
    h.options.earlier = [h.parentSource, prior];
    const batch = buildSubtaskGate(h.options);
    expect(batch?.request).toMatchObject({
      state: { earlier: h.options.earlier },
    });
    expect(batch?.identity).not.toBe(h.batch.identity);
  });

  it.each([Object.prototype, Array.prototype])(
    "transmits and deduplicates exactly hashed context despite inherited toJSON on %s",
    async (prototype) => {
      const h = fixture();
      const store = new SubtaskStore();
      store.admit(subtaskAdmission());
      h.options.group = store.snapshot().groups[0];
      h.options.omissions = ["Two older unrelated observations omitted"];
      const batch = buildSubtaskGate(h.options);
      if (!batch) throw new Error("Expected bounded group/context gate");
      const response = new Response(JSON.stringify(h.result), {
        headers: { "content-type": "application/json" },
      });
      const bodies: string[] = [];
      let now = 0;
      const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return response;
      });
      const gateway = new JevGateway({
        fetch: fetcher,
        getApiKey: () => "fixture-key",
        now: () => now,
      });
      gateway.enable("gate-context");
      const previous = Object.getOwnPropertyDescriptor(prototype, "toJSON");
      let hookReads = 0;
      let first: ValidatedResult | undefined;
      try {
        Object.defineProperty(prototype, "toJSON", {
          configurable: true,
          get() {
            hookReads++;
            return () => ({ erased: true });
          },
        });
        first = await gateway.evaluate(batch.request, "gate-context");
      } finally {
        if (previous) Object.defineProperty(prototype, "toJSON", previous);
        else Reflect.deleteProperty(prototype, "toJSON");
      }
      expect(first).toEqual(h.result);
      expect(hookReads).toBe(0);
      expect(bodies).toHaveLength(1);
      expect(createHash("sha256").update(bodies[0], "utf8").digest("hex")).toBe(
        batch.requestHash,
      );
      expect(JSON.parse(bodies[0]).state).toEqual(batch.request.state);
      now = 20_000;
      expect(
        await gateway.evaluate(batch.request, "gate-context"),
      ).toBeUndefined();
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("builds a bounded independent question with required old parent source and no resource prerequisite", () => {
    const { options, batch, parentSource } = fixture();
    expect(batch.request.model).toBe("jev-1.13.0");
    expect(Object.keys(batch.request.questions)).toHaveLength(1);
    expect(batch.request.state).toMatchObject({
      parent: options.parent,
      parentSource,
      latest: options.latest,
      earlier: [],
      omissions: [],
    });
    expect(batch.identity).toMatch(/^[a-f0-9]{64}$/);
    expect(batch.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.request.state)).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(batch.request)),
    ).toBeLessThanOrEqual(24576);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it("produces a content-free durable accepted-yes record for exactly this parent", () => {
    const { options, batch, result } = fixture();
    const record = applySubtaskGate(batch, result, options, ticket);
    expect(record).toMatchObject({
      identity: batch.identity,
      parentTaskId: options.parent.id,
      parentRevision: 1,
      listRevision: 0,
      phase: "gate-decided",
      state: "ready",
      gateModel: MODEL,
      selectedModel: "fixture/selected",
      gate: {
        requestHash: batch.requestHash,
        dispatch: 1,
        at: 123,
        outcome: "decided",
        choice: "yes",
        confidence: 0.5,
        probability: 0.8,
        usage: { inputTokens: 3, outputTokens: 5 },
      },
    });
    expect(JSON.stringify(record)).not.toContain(options.latest.text);
    expect(JSON.stringify(record)).not.toContain(options.parent.label);
    expect(options.parent.status).toBe("not-started");
  });
  it.each(["no", "uncertain", "low-confidence", "low-probability"])(
    "persists %s as terminal without proposal eligibility",
    (mode) => {
      const { options, batch, result } = fixture("What is six times seven?");
      const key = Object.keys(result.answers)[0];
      result.answers[key] = {
        type: "choice",
        choice: mode === "no" || mode === "uncertain" ? mode : "yes",
        confidence: mode === "low-confidence" ? 0.499 : 1,
        probabilities:
          mode === "no"
            ? { yes: 0, no: 1, uncertain: 0 }
            : mode === "uncertain"
              ? { yes: 0, no: 0, uncertain: 1 }
              : {
                  yes: mode === "low-probability" ? 0.799 : 0.8,
                  no: 0.1,
                  uncertain: mode === "low-probability" ? 0.101 : 0.1,
                },
      };
      expect(applySubtaskGate(batch, result, options, ticket)).toMatchObject({
        phase: "gate-decided",
        state: "complete",
      });
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    },
  );
  it.each([
    "parent",
    "revision",
    "source",
    "latest",
    "omissions",
    "model",
    "list",
  ])("rejects stale or other-parent yes after %s change", (mode) => {
    const { options, batch, result, observations } = fixture();
    if (mode === "parent") options.parent.id = "task:2";
    if (mode === "revision") options.parent.revision++;
    if (mode === "source") options.parent.source.quoteHash = "0".repeat(64);
    if (mode === "latest") {
      options.latest.text += " Instead, keep this atomic.";
      options.latest.hash = subtaskHash(options.latest.text);
    }
    if (mode === "omissions") options.omissions.push("Earlier context omitted");
    if (mode === "model") options.selectedModel = "fixture/other";
    if (mode === "list") {
      const store = new SubtaskStore();
      store.admit(subtaskAdmission());
      options.group = store.snapshot().groups[0];
    }
    expect(observations).toHaveLength(2);
    expect(applySubtaskGate(batch, result, options, ticket)).toBeUndefined();
  });
  it("does not change identity for assessment-only parent metadata", () => {
    const { options, batch } = fixture();
    options.parent.latestAssessment = {
      rawChoice: "pending",
      confidence: 1,
      probability: 1,
      reason: "accepted",
      source: {
        entryId: options.latest.id,
        messageHash: options.latest.hash,
        role: options.latest.role,
      },
    };
    expect(buildSubtaskGate(options)?.identity).toBe(batch.identity);
  });
  it("reuses restored exact-context positive or negative receipts without provider activity", () => {
    for (const negative of [false, true]) {
      const { options, batch, result } = fixture();
      if (negative)
        result.answers[Object.keys(result.answers)[0]] = {
          type: "choice",
          choice: "no",
          confidence: 1,
          probabilities: { yes: 0, no: 1, uncertain: 0 },
        };
      const record = applySubtaskGate(batch, result, options, ticket);
      if (!record) throw new Error("Expected receipt");
      const journal: SubtaskJournalCheckpoint = {
        version: 1,
        dispatches: 1,
        usage: {
          jev: { calls: 1, inputTokens: 3, outputTokens: 5 },
          extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
        },
        records: [record],
      };
      expect(reusableSubtaskGate(structuredClone(journal), batch)).toEqual(
        record,
      );
      options.latest.text += " New requirement.";
      options.latest.hash = subtaskHash(options.latest.text);
      const next = buildSubtaskGate(options);
      if (!next) throw new Error("Expected changed-context gate");
      expect(next.identity).not.toBe(batch.identity);
      expect(reusableSubtaskGate(journal, next)).toBeUndefined();
    }
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it.each(["missing", "model", "extra", "distribution", "usage", "ticket"])(
    "rejects malformed result/proof %s atomically",
    (mode) => {
      const { options, batch, result } = fixture();
      if (mode === "model") result.model = "jev-latest";
      if (mode === "extra")
        result.answers.extra = structuredClone(
          Object.values(result.answers)[0],
        );
      if (mode === "distribution")
        Object.values(result.answers)[0].probabilities.yes = 1;
      if (mode === "usage") result.usage.input_tokens = -1;
      expect(
        applySubtaskGate(
          batch,
          mode === "missing" ? undefined : result,
          options,
          mode === "ticket" ? { dispatch: 0, at: 1 } : ticket,
        ),
      ).toBeUndefined();
    },
  );
  it("abstains when required canonical parent source is absent, archived or newest whole message exceeds bound", () => {
    const h = fixture();
    h.observations.shift();
    expect(buildSubtaskGate(h.options)).toBeUndefined();
    const archived = fixture();
    archived.options.parent.included = false;
    expect(buildSubtaskGate(archived.options)).toBeUndefined();
    const big = fixture();
    big.options.latest.text = "x".repeat(12289);
    big.options.latest.hash = subtaskHash(big.options.latest.text);
    expect(buildSubtaskGate(big.options)).toBeUndefined();
  });
  it("bounds earlier context without truncating or dropping mandatory source", () => {
    const h = fixture();
    h.options.earlier = Array.from({ length: 17 }, (_, i) => ({
      id: `earlier:${i}`,
      role: "assistant" as const,
      text: "Report",
      hash: subtaskHash("Report"),
    }));
    h.observations.push(...h.options.earlier);
    expect(buildSubtaskGate(h.options)).toBeUndefined();
  });
});
