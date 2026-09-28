import { describe, expect, it, vi } from "vitest";
import {
  type ContinuationAuthorityProjection,
  projectContinuationAuthority,
} from "../src/advisory/continuation-authority";
import { ContinuationController } from "../src/advisory/continuation-controller";
import type {
  AppliedContinuationDraft,
  ContinuationDraftRequest,
} from "../src/advisory/continuation-draft";
import type { ContinuationGateBatch } from "../src/analysis/continuation-gate";
import { MODEL, type ValidatedResult } from "../src/analysis/gateway";
import { continuationAuthorityFixture } from "./fixtures/continuation";

function projection(run = 7) {
  const { input, question } = continuationAuthorityFixture();
  input.originalRunId = run;
  const opportunityId = `00000000-0000-4000-8000-${String(run).padStart(12, "0")}`;
  input.receipt = { ...input.receipt, opportunityId };
  question.details.opportunityId = opportunityId;
  const current = projectContinuationAuthority(input);
  if (!current.available) throw new Error("Expected authority");
  return current;
}
function yes(batch: ContinuationGateBatch): ValidatedResult {
  return {
    model: MODEL,
    answers: Object.fromEntries(
      Object.keys(batch.request.questions).map((key) => [
        key,
        {
          type: "choice",
          choice: "yes",
          confidence: 1,
          probabilities: { yes: 1, no: 0, uncertain: 0 },
        },
      ]),
    ),
    usage: { input_tokens: 2, output_tokens: 3 },
  };
}
const rootFor = (current: ReturnType<typeof projection>) => ({
  opportunityId: current.receipt.opportunityId,
  sessionEpoch: current.sessionEpoch,
  branchEpoch: current.branchEpoch,
  originalRunId: current.originalRunId,
});
function fixture() {
  let current: ContinuationAuthorityProjection = projection();
  let allowed = true;
  const gate = vi.fn(
    async (
      batch: ContinuationGateBatch,
      _signal: AbortSignal,
      admit: () => boolean,
    ): Promise<ValidatedResult | undefined> =>
      admit() ? yes(batch) : undefined,
  );
  const draft = vi.fn(
    async (
      request: ContinuationDraftRequest,
      _signal: AbortSignal,
      admit: () => boolean,
    ) => {
      if (!admit()) return undefined;
      return {
        text: JSON.stringify({
          targetIndex: 0,
          action: "Compare deployment options",
          evidence: [{ contextIndex: 0, start: 0, end: 26 }],
        }),
        requestHash: request.requestHash,
        model: "selected",
        provider: "fixture",
        usage: { inputTokens: 5, outputTokens: 7 },
      };
    },
  );
  const emit = vi.fn((_output: AppliedContinuationDraft) => true);
  const authority = vi.fn(() => current);
  const canStart = vi.fn(() => allowed);
  const controller = new ContinuationController({
    authority,
    canStart,
    gate,
    draft,
    emit,
  });
  const start = (next = projection()) => {
    current = next;
    expect(controller.arm(rootFor(next))).toBe(true);
    expect(controller.settle(next.receipt)).toBe(true);
  };
  return {
    controller,
    gate,
    draft,
    emit,
    authority,
    canStart,
    start,
    setCurrent: (next: ContinuationAuthorityProjection) => {
      current = next;
    },
    allow: (value: boolean) => {
      allowed = value;
    },
  };
}

describe("one-shot continuation controller", () => {
  it.each(["authority", "scheduler"])(
    "reserves advancement before synchronous %s reentry",
    async (callback) => {
      const h = fixture();
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      h.gate.mockImplementation(async (batch, _signal, admit) => {
        admit();
        await held;
        return yes(batch);
      });
      let nested: Promise<void> | undefined;
      if (callback === "authority")
        h.authority.mockImplementationOnce(() => {
          nested = h.controller.wake();
          return projection();
        });
      else
        h.canStart.mockImplementationOnce(() => {
          nested = h.controller.wake();
          return true;
        });
      h.start();
      const outer = h.controller.wake();
      const callsWhileHeld = h.gate.mock.calls.length;
      h.controller.invalidate();
      const armedWhileHeld = h.controller.arm(rootFor(projection(8)));
      release();
      await outer;
      await nested;
      expect(callsWhileHeld).toBe(1);
      expect(armedWhileHeld).toBe(false);
      expect(h.emit).not.toHaveBeenCalled();
    },
  );

  it.each(["before-draft", "before-emit"])(
    "does not resurrect phase after scheduler invalidation %s",
    async (stage) => {
      const h = fixture();
      let cancel = false;
      const originalGate = h.gate.getMockImplementation();
      const originalDraft = h.draft.getMockImplementation();
      h.gate.mockImplementation(async (...args) => {
        const result = await originalGate?.(...args);
        if (stage === "before-draft") cancel = true;
        return result;
      });
      h.draft.mockImplementation(async (...args) => {
        const result = await originalDraft?.(...args);
        if (stage === "before-emit") cancel = true;
        return result;
      });
      h.canStart.mockImplementation(() => {
        if (cancel) h.controller.invalidate();
        return true;
      });
      h.start();
      await h.controller.wake();
      expect(h.emit).not.toHaveBeenCalled();
      if (stage === "before-draft") expect(h.draft).not.toHaveBeenCalled();
      expect(h.controller.snapshot().phase).toBe("consumed");
      expect(h.controller.arm(rootFor(projection(8)))).toBe(true);
    },
  );

  it("rechecks authority changed by final scheduling callback before emission", async () => {
    const h = fixture();
    let finished = false;
    const original = h.draft.getMockImplementation();
    h.draft.mockImplementation(async (...args) => {
      const result = await original?.(...args);
      finished = true;
      return result;
    });
    h.canStart.mockImplementation(() => {
      if (finished) h.setCurrent(projection(8));
      return true;
    });
    h.start();
    await h.controller.wake();
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.controller.snapshot().phase).toBe("consumed");
  });

  it.each(["replies", "send-id", "question-id", "reply-id", "serialized"])(
    "rejects over-bound receipt %s before retention",
    (mode) => {
      const h = fixture();
      const current = projection();
      const receipt = {
        ...current.receipt,
        question: { ...current.receipt.question },
        replies: current.receipt.replies.map((reply) => ({ ...reply })),
      };
      if (mode === "replies")
        receipt.replies = Array.from({ length: 17 }, (_, i) => ({
          ...receipt.replies[0],
          entryId: `reply:${i}`,
        }));
      if (mode === "send-id") receipt.sendId = "s".repeat(12289);
      if (mode === "question-id") receipt.question.entryId = "q".repeat(12289);
      if (mode === "reply-id") receipt.replies[0].entryId = "r".repeat(12289);
      if (mode === "serialized")
        receipt.replies = Array.from({ length: 16 }, (_, i) => ({
          ...receipt.replies[0],
          entryId: `${i}:${"r".repeat(1600)}`,
        }));
      h.controller.arm(rootFor(current));
      expect(h.controller.settle(receipt)).toBe(false);
      expect(h.controller.snapshot().phase).toBe("await-reply");
    },
  );
  it("advances only a correlated settled root and emits one validated conditional draft", async () => {
    const h = fixture();
    const current = projection();
    expect(h.controller.arm(rootFor(current))).toBe(true);
    expect(h.controller.snapshot().phase).toBe("await-reply");
    await h.controller.wake();
    expect(h.gate).not.toHaveBeenCalled();
    expect(h.controller.settle(current.receipt)).toBe(true);
    await h.controller.wake();
    expect(h.gate).toHaveBeenCalledTimes(1);
    expect(h.draft).toHaveBeenCalledTimes(1);
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.controller.snapshot()).toMatchObject({
      phase: "consumed",
      gateDispatches: 1,
      draftDispatches: 1,
      usage: { inputTokens: 7, outputTokens: 10 },
    });
    expect(h.emit.mock.calls[0][0].message).toContain(
      "untrusted suggested next step",
    );
    expect(h.controller.arm(rootFor(current))).toBe(false);
    expect(h.controller.settle(current.receipt)).toBe(false);
    await h.controller.wake();
    expect(h.gate).toHaveBeenCalledTimes(1);
  });
  it("waits for mandatory frontier and scheduler permission without timers or polling", async () => {
    const h = fixture();
    h.start();
    h.setCurrent({ available: false, reason: "frontier" });
    await h.controller.wake();
    expect(h.controller.snapshot().phase).toBe("await-frontier");
    expect(h.gate).not.toHaveBeenCalled();
    h.setCurrent(projection());
    h.allow(false);
    await h.controller.wake();
    expect(h.gate).not.toHaveBeenCalled();
    h.allow(true);
    await h.controller.wake();
    expect(h.emit).toHaveBeenCalledTimes(1);
  });
  it.each(["no", "uncertain", "failure", "unadmitted"])(
    "makes %s gate result terminal without drafting or retry",
    async (mode) => {
      const h = fixture();
      h.gate.mockImplementation(async (batch, _signal, admit) => {
        if (mode === "unadmitted") return yes(batch);
        expect(admit()).toBe(true);
        if (mode === "failure") throw new Error("private provider failure");
        const result = yes(batch);
        for (const key of Object.keys(result.answers))
          result.answers[key] = {
            type: "choice",
            choice: mode,
            confidence: 1,
            probabilities: {
              yes: 0,
              no: mode === "no" ? 1 : 0,
              uncertain: mode === "uncertain" ? 1 : 0,
            },
          };
        return result;
      });
      h.start();
      await h.controller.wake();
      await h.controller.wake();
      expect(h.draft).not.toHaveBeenCalled();
      expect(h.emit).not.toHaveBeenCalled();
      expect(h.gate).toHaveBeenCalledTimes(1);
      expect(h.controller.snapshot()).toMatchObject({
        phase: "consumed",
        gateDispatches: mode === "unadmitted" ? 0 : 1,
        draftDispatches: 0,
        unavailable: mode === "failure",
      });
      expect(JSON.stringify(h.controller.snapshot())).not.toContain(
        "private provider failure",
      );
    },
  );
  it.each(["stale", "cancel", "admission-drift"])(
    "fences %s gate work",
    async (mode) => {
      const h = fixture();
      h.gate.mockImplementation(async (batch, signal, admit) => {
        if (mode === "admission-drift") h.setCurrent(projection(8));
        expect(admit()).toBe(mode !== "admission-drift");
        if (mode === "stale") h.setCurrent(projection(8));
        if (mode === "cancel") {
          h.controller.invalidate();
          expect(signal.aborted).toBe(true);
        }
        return yes(batch);
      });
      h.start();
      await h.controller.wake();
      expect(h.draft).not.toHaveBeenCalled();
      expect(h.emit).not.toHaveBeenCalled();
    },
  );
  it("keeps one provider flight and charges a repeated admission hook only once", async () => {
    const h = fixture();
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.gate.mockImplementation(async (batch, _signal, admit) => {
      expect(admit()).toBe(true);
      expect(admit()).toBe(false);
      await pending;
      return yes(batch);
    });
    h.start();
    const running = h.controller.wake();
    await h.controller.wake();
    expect(h.gate).toHaveBeenCalledTimes(1);
    h.controller.invalidate();
    expect(h.controller.arm(rootFor(projection(8)))).toBe(false);
    release();
    await running;
    expect(h.draft).not.toHaveBeenCalled();
    expect(h.controller.snapshot().gateDispatches).toBe(1);
  });
  it.each(["error", "invalid", "stale", "unadmitted", "foreign-model"])(
    "contains %s draft without fallback send",
    async (mode) => {
      const h = fixture();
      const implementation = h.draft.getMockImplementation();
      h.draft.mockImplementation(async (request, signal, admit) => {
        const output = await implementation?.(
          request,
          signal,
          mode === "unadmitted" ? () => true : admit,
        );
        if (mode === "error") throw new Error("private draft failure");
        if (mode === "stale") h.setCurrent(projection(8));
        if (output && mode === "invalid") output.text = "keep going";
        if (output && mode === "foreign-model") output.model = "other";
        return output;
      });
      h.start();
      await h.controller.wake();
      await h.controller.wake();
      expect(h.emit).not.toHaveBeenCalled();
      expect(h.draft).toHaveBeenCalledTimes(1);
      expect(h.controller.snapshot()).toMatchObject({
        phase: "consumed",
        unavailable: ["error", "invalid", "foreign-model"].includes(mode),
      });
      expect(JSON.stringify(h.controller.snapshot())).not.toContain(
        "private draft failure",
      );
    },
  );
  it("enforces32gate32draft64total across invalidations and fresh roots", async () => {
    const h = fixture();
    for (let run = 7; run < 39; run++) {
      h.start(projection(run));
      await h.controller.wake();
      h.controller.invalidate();
    }
    expect(h.controller.snapshot()).toMatchObject({
      gateDispatches: 32,
      draftDispatches: 32,
      exhausted: true,
    });
    const next = projection(39);
    h.controller.arm(rootFor(next));
    h.controller.settle(next.receipt);
    h.setCurrent(next);
    await h.controller.wake();
    expect(h.gate).toHaveBeenCalledTimes(32);
    expect(h.draft).toHaveBeenCalledTimes(32);
    expect(fixture().controller.snapshot()).toMatchObject({
      gateDispatches: 0,
      draftDispatches: 0,
    });
  });
  it("rejects mismatched receipt and exposes detached content-free diagnostics", async () => {
    const h = fixture();
    const current = projection();
    h.controller.arm(rootFor(current));
    expect(h.controller.settle(projection(8).receipt)).toBe(false);
    await h.controller.wake();
    expect(h.gate).not.toHaveBeenCalled();
    const snapshot = h.controller.snapshot();
    snapshot.usage.inputTokens = 999;
    expect(h.controller.snapshot().usage.inputTokens).toBe(0);
    expect(JSON.stringify(h.controller.snapshot())).not.toContain(
      "Compare deployment",
    );
  });
});
