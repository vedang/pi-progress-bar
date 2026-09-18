import { describe, expect, it, vi } from "vitest";
import type {
  EvaluationRequest,
  ValidatedResult,
} from "../src/analysis/gateway";
import { reconcileLedger } from "../src/core/ledger";
import { Monitor } from "../src/core/monitor";
import { proposal } from "../src/sources/candidates";
import { Conversation } from "../src/sources/conversation";
import { replayEntries } from "./fixtures/live-session";

function answer(request: EvaluationRequest, choice: string): ValidatedResult {
  return {
    model: request.model,
    usage: { input_tokens: 1, output_tokens: 1 },
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, q]) => [
        id,
        {
          type: "choice",
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(q.criteria).map((k) => [k, k === choice ? 1 : 0]),
          ),
        },
      ]),
    ),
  };
}

describe("chronological grounded discovery", () => {
  it("includes source role and applicable prior user request in assistant discovery evidence", () => {
    const conversation = new Conversation();
    conversation.update(replayEntries(2));
    const requests: EvaluationRequest[] = [];
    const enqueue = (
      _purpose: string,
      request: EvaluationRequest,
      admit: (r: ValidatedResult) => void,
    ) => {
      requests.push(request);
      admit(answer(request, "none"));
    };
    conversation.scheduleDiscovery(enqueue, () => true);
    conversation.scheduleDiscovery(enqueue, () => true);
    const insight = requests.find((r) =>
      JSON.stringify(r.state).includes("First lock scope"),
    );
    expect(insight).toBeDefined();
    expect(JSON.stringify(insight?.state)).toContain("assistant");
    expect(JSON.stringify(insight?.state)).toContain(
      "Implement the planned progress monitor features from the tickets.",
    );
    expect(insight?.questions.source?.instructions).not.toContain(
      "requiring user confirmation",
    );
  });

  it("classifies selected chronological candidate before selecting later candidates", () => {
    const conversation = new Conversation();
    conversation.update(replayEntries());
    let first: EvaluationRequest | undefined;
    conversation.scheduleDiscovery(
      (_purpose, request, admit) => {
        first = request;
        const candidate = conversation.candidates[0];
        if (!candidate) throw new Error("missing candidate");
        admit(answer(request, candidate.id));
      },
      () => true,
    );
    expect(first?.questions.source).toBeDefined();
    let next: EvaluationRequest | undefined;
    conversation.scheduleDiscovery(
      (_purpose, request) => {
        next = request;
      },
      () => true,
    );
    expect(next).toBeDefined();
    expect(next?.questions.source).toBeUndefined();
  });

  it("does not consume reports while earlier scope discovery remains unresolved", () => {
    const entries = replayEntries();
    const monitor = new Monitor(vi.fn(), vi.fn());
    monitor.enabled = true;
    monitor.observe(() => entries);
    const candidate = monitor.conversation.candidates[0];
    if (!candidate) throw new Error("missing candidate");
    const p = proposal(
      candidate,
      Object.fromEntries(candidate.spans.map((s) => [s.id, "task"])),
    );
    monitor.ledger = reconcileLedger(undefined, p.snapshot);
    monitor.source = monitor.conversation.source(p);
    monitor.conversation.select(monitor.source);
    const purposes: string[] = [];
    vi.spyOn(monitor, "enqueueAnalysis").mockImplementation((purpose) => {
      purposes.push(purpose);
    });
    monitor.scheduleAnalysis(false);
    expect(purposes).toContain("discovery");
    expect(purposes).not.toContain("reports");
    expect(monitor.conversation.cursor?.id).toBe(candidate.entryId);
    monitor.stop();
  });
});
