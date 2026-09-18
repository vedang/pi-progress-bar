import { describe, expect, it } from "vitest";
import type {
  EvaluationRequest,
  ValidatedResult,
} from "../src/analysis/gateway";
import { countReported, reconcileLedger } from "../src/core/ledger";
import { proposal } from "../src/sources/candidates";
import { Conversation } from "../src/sources/conversation";

const message = (id: string, text: string) => ({
  type: "message",
  id,
  parentId: null,
  message: { role: "assistant", content: text },
});
function answer(
  request: EvaluationRequest,
  choice: string,
  current = "unknown",
): ValidatedResult {
  return {
    model: request.model,
    usage: { input_tokens: 10, output_tokens: 0 },
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, q]) => [
        id,
        {
          type: "choice",
          choice: id === "__current" ? current : choice,
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(q.criteria).map((key) => [
              key,
              key === (id === "__current" ? current : choice) ? 1 : 0,
            ]),
          ),
        },
      ]),
    ),
  };
}
function fixture(tasks = 3) {
  const plan = message(
    "plan",
    Array.from({ length: tasks }, (_, i) => `${i + 1}. Task ${i + 1}`).join(
      "\n",
    ),
  );
  const conversation = new Conversation();
  conversation.update([plan]);
  const candidate = conversation.candidates[0];
  if (!candidate) throw new Error("Missing candidate");
  const source = conversation.source(proposal(candidate));
  let ledger = reconcileLedger(undefined, conversation.rehydrate(source));
  conversation.select(source);
  let live = true;
  let job:
    | { request: EvaluationRequest; admit: (result: ValidatedResult) => void }
    | undefined;
  const schedule = ():
    | {
        request: EvaluationRequest;
        admit: (result: ValidatedResult) => void;
      }
    | undefined => {
    job = undefined;
    // These fixtures isolate report semantics: explicitly classify every later
    // observation as no new plan before interpreting its status/current work.
    for (let i = 0; i < 100 && conversation.hasPendingDiscovery(); i++) {
      conversation.scheduleDiscovery(
        (_purpose, request, admit) => admit(answer(request, "none")),
        () => live,
      );
    }
    conversation.scheduleReports(
      ledger,
      source,
      1,
      (_purpose, request, admit) => {
        job = { request, admit };
      },
      () => (live ? ledger : undefined),
      (next) => {
        ledger = next;
      },
    );
    return job;
  };
  const reply = (choice: string) => {
    const pending = schedule();
    if (!pending) throw new Error("Missing report job");
    pending.admit(answer(pending.request, choice));
  };
  // Selection now interprets same-observation reports too. Fixture plan itself
  // makes no status/current assertion, so settle that transaction first.
  for (let i = 0; i < 20 && ledger.reportOrder === 0; i++)
    reply("not-a-report");
  return {
    conversation,
    source,
    plan,
    schedule,
    reply,
    ledger: () => ledger,
    invalidate: () => {
      live = false;
    },
  };
}

describe("ordered conversation reports", () => {
  it("applies multi-chunk reports atomically and never coalesces a later reopen", () => {
    const f = fixture(23);
    const done = message("done", "All 23 tasks are finished");
    const reopen = message("reopen", "All 23 tasks are reopened");
    f.conversation.update([f.plan, done, reopen]);
    const first = f.schedule();
    if (!first) throw new Error("Missing first chunk");
    expect(Object.keys(first.request.questions).length).toBeLessThanOrEqual(20);
    first.admit(answer(first.request, "done"));
    expect(countReported(f.ledger()).done).toBe(0);
    expect(f.conversation.cursor?.id).toBe("plan");
    // Further observations/discovery churn cannot erase an admitted partial chunk.
    f.conversation.update([
      f.plan,
      done,
      reopen,
      message("tail", "I intend to review tomorrow"),
    ]);
    for (let i = 0; i < 5 && f.conversation.cursor?.id !== "done"; i++)
      f.reply("done");
    expect(countReported(f.ledger()).done).toBe(23);
    for (let i = 0; i < 5 && f.conversation.cursor?.id !== "reopen"; i++)
      f.reply("reopened");
    expect(countReported(f.ledger()).done).toBe(0);
    expect(f.ledger().tasks.every((task) => task.status === "reopened")).toBe(
      true,
    );
    const before = f.ledger().reportOrder;
    for (let i = 0; i < 5 && f.conversation.cursor?.id !== "tail"; i++)
      f.reply("not-a-report");
    expect(f.ledger().reportOrder).toBe(before + 1);
    expect(f.conversation.cursor?.id).toBe("tail");
  });
  it("selects current task across chunks when unrelated chunks abstain", () => {
    const f = fixture(23);
    const currentId = f.ledger().tasks[22]?.id;
    if (!currentId) throw new Error("Missing last task");
    f.conversation.update([
      f.plan,
      message("working", "I am working on Task 23 now."),
    ]);
    for (let i = 0; i < 5 && f.conversation.cursor?.id !== "working"; i++) {
      const job = f.schedule();
      if (!job) throw new Error("Missing report chunk");
      const question = job.request.questions.__current;
      const current =
        question && Object.hasOwn(question.criteria, currentId)
          ? currentId
          : "unknown";
      job.admit(answer(job.request, "not-a-report", current));
    }
    expect(f.ledger().currentTaskId).toBe(currentId);
    expect(f.conversation.cursor?.id).toBe("working");
  });

  it("resumes a checkpointed partial report without rebilling accepted chunks", () => {
    const f = fixture(23);
    const done = message("done", "All 23 tasks are finished");
    f.conversation.update([f.plan, done]);
    const first = f.schedule();
    if (!first) throw new Error("Missing first report chunk");
    first.admit(answer(first.request, "done"));
    expect(countReported(f.ledger()).done).toBe(0);
    const checkpoint = f.conversation.checkpoint(f.ledger());
    expect(JSON.stringify(checkpoint)).not.toContain("All 23 tasks");
    expect(JSON.stringify(checkpoint)).not.toContain("probabilities");
    const restored = new Conversation();
    restored.update([f.plan, done]);
    let ledger = reconcileLedger(undefined, restored.rehydrate(f.source));
    restored.restore(ledger, checkpoint, f.source);
    let nextRequest: EvaluationRequest | undefined;
    for (let i = 0; i < 5 && restored.cursor?.id !== "done"; i++) {
      restored.scheduleReports(
        ledger,
        f.source,
        2,
        (_purpose, request, admit) => {
          nextRequest ??= request;
          admit(answer(request, "done"));
        },
        () => ledger,
        (next) => {
          ledger = next;
        },
      );
    }
    expect(nextRequest).toBeDefined();
    for (const id of Object.keys(first.request.questions).filter(
      (id) => id !== "__current",
    ))
      expect(nextRequest?.questions[id]).toBeUndefined();
    expect(countReported(ledger).done).toBe(23);
  });

  it("does not admit a late answer after branch invalidation", () => {
    const f = fixture();
    f.conversation.update([f.plan, message("done", "Everything finished")]);
    const job = f.schedule();
    if (!job) throw new Error("Missing job");
    f.invalidate();
    job.admit(answer(job.request, "done"));
    expect(countReported(f.ledger()).done).toBe(0);
    expect(f.conversation.cursor?.id).toBe("plan");
  });
  it("restores latest proofs after history eviction without report bodies or answers", () => {
    const f = fixture();
    const reports = Array.from({ length: 36 }, (_, i) =>
      message(`report-${i}`, `Task status assertion ${i}`),
    );
    f.conversation.update([f.plan, ...reports]);
    for (let i = 0; i < reports.length; i++)
      f.reply(i === reports.length - 1 ? "cancelled" : "done");
    expect(f.ledger().reports).toHaveLength(32);
    expect(f.conversation.reportEvidence).toHaveLength(20);
    const cp = f.conversation.checkpoint(f.ledger());
    expect(cp.proofs).toHaveLength(3);
    expect(JSON.stringify(cp)).not.toContain("Task status assertion");
    expect(JSON.stringify(cp)).not.toContain("probabilities");
    const restored = new Conversation();
    restored.update([f.plan, ...reports]);
    const ledger = reconcileLedger(undefined, restored.rehydrate(f.source));
    restored.restore(ledger, cp);
    expect(ledger.tasks.every((task) => task.status === "cancelled")).toBe(
      true,
    );
    expect(ledger.reportOrder).toBe(37);
    expect(restored.cursor?.id).toBe("report-35");
    const invalid = new Conversation();
    invalid.update([
      f.plan,
      ...reports.slice(0, -1),
      message("report-35", "Changed report"),
    ]);
    expect(() =>
      invalid.restore(
        reconcileLedger(undefined, invalid.rehydrate(f.source)),
        cp,
      ),
    ).toThrow(/cursor|proof/i);
  });
  it("marks missing original history stale without advancing cursor or denominator", () => {
    const f = fixture();
    f.conversation.update([
      f.plan,
      { ...message("done", "Everything finished"), parentId: "missing" },
    ]);
    expect(f.schedule()).toBeUndefined();
    expect(f.ledger().stale).toBe(true);
    expect(countReported(f.ledger())).toEqual({
      done: 0,
      total: 3,
      percent: 0,
    });
    expect(f.conversation.cursor?.id).toBe("plan");
  });
  it("keeps every candidate in the bounded window reachable automatically", () => {
    const f = fixture();
    f.conversation.update([
      f.plan,
      ...Array.from({ length: 20 }, (_, i) =>
        message(`later${i}`, `1. New work ${i}`),
      ),
    ]);
    expect(
      f.conversation.candidates.some((item) => item.entryId === "plan"),
    ).toBe(true);
    expect(f.conversation.candidates.length).toBeGreaterThan(12);
  });
});
