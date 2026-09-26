import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReconciliationDelivery } from "../src/advisory/delivery";
import type { ObservationRef } from "../src/core/hybrid-state";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const opportunityId = "00000000-0000-4000-8000-000000000001";
const sendId = "00000000-0000-4000-8000-000000000002";
const content = "What remains complete, pending, or blocked?";
const response =
  "The comparison is complete; the recommendation remains pending and unblocked.";
interface Receipt {
  kind: "reconciliation";
  opportunityId: string;
  sendId: string;
  sessionEpoch: number;
  branchEpoch: number;
  replyRunId: number;
  question: { entryId: string; contentHash: string };
  replies: readonly ObservationRef[];
}
const active: ReconciliationDelivery[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const delivery of active.splice(0)) delivery.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
});
function fixture(
  kind: "reconciliation" | "test-correction" = "reconciliation",
) {
  const branch: unknown[] = [
    { type: "custom", id: "baseline", customType: "pi-progress-bar", data: {} },
  ];
  const state = {
    enabled: true,
    mode: "tui",
    sessionEpoch: 1,
    branchEpoch: 2,
    opportunityId,
    relevant: true,
    idle: true,
    pendingMessages: false,
  };
  const receipts: Receipt[] = [];
  const onReconciliationSettled = vi.fn((receipt: Receipt) => {
    receipts.push(receipt);
  });
  const send = vi.fn();
  let nextSendId = 2;
  const delivery = new ReconciliationDelivery({
    state: () => state,
    branch: () => branch,
    sendMessage: send,
    uuid: () =>
      `00000000-0000-4000-8000-${String(nextSendId++).padStart(12, "0")}`,
    onReconciliationSettled,
  });
  active.push(delivery);
  const request = {
    kind,
    opportunityId,
    content,
    sessionEpoch: 1,
    branchEpoch: 2,
  };
  expect(delivery.request(request)).toBe("started");
  delivery.onAgentStart();
  const question = {
    type: "custom_message",
    id: "question",
    parentId: "baseline",
    ...send.mock.calls[0][0],
  };
  const reply = {
    type: "message",
    id: "reply",
    parentId: "question",
    message: {
      role: "assistant",
      content: [{ type: "text", text: response }],
      stopReason: "stop",
    },
  };
  const append = () => {
    branch.push(question, reply);
    delivery.onContext(branch);
  };
  return {
    branch,
    state,
    receipts,
    onReconciliationSettled,
    send,
    delivery,
    request,
    question,
    reply,
    append,
  };
}

describe("passive continuation settlement receipt", () => {
  it("emits exact canonical identity once after successful own reply", () => {
    const h = fixture();
    h.append();
    expect(h.delivery.onAgentSettled(h.branch)).toBe("advisory-only");
    expect(h.receipts).toEqual([
      {
        kind: "reconciliation",
        opportunityId,
        sendId,
        sessionEpoch: 1,
        branchEpoch: 2,
        replyRunId: 1,
        question: { entryId: "question", contentHash: hash(content) },
        replies: [
          { entryId: "reply", messageHash: hash(response), role: "assistant" },
        ],
      },
    ]);
    expect(h.delivery.onAgentSettled(h.branch)).toBeUndefined();
    expect(h.onReconciliationSettled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not turn preappend reply evidence into a receipt", () => {
    const h = fixture();
    h.branch.push(h.question);
    h.delivery.onMessageEnd(h.reply.message, h.branch);
    expect(h.delivery.onAgentSettled(h.branch)).toBe("advisory-only");
    expect(h.receipts).toEqual([]);
  });

  it.each(["error", "aborted", "toolUse", "pending"])(
    "rejects unsuccessful or nonterminal reply (%s)",
    (reason) => {
      const h = fixture();
      h.reply.message.stopReason = reason;
      h.append();
      h.delivery.onAgentSettled(h.branch);
      expect(h.receipts).toEqual([]);
    },
  );

  it("rejects an empty canonical reply", () => {
    const h = fixture();
    h.reply.message.content = [];
    h.append();
    h.delivery.onAgentSettled(h.branch);
    expect(h.receipts).toEqual([]);
  });

  it("requires reply to follow the matching question", () => {
    const h = fixture();
    h.branch.push(h.reply, h.question);
    h.delivery.onContext(h.branch);
    h.delivery.onAgentSettled(h.branch);
    expect(h.receipts).toEqual([]);
  });

  it("does not revive uncertain settlement when confirmation arrives late", () => {
    const h = fixture();
    h.branch.push(h.reply);
    expect(h.delivery.onAgentSettled(h.branch)).toBe("uncertain-advisory");
    h.branch.splice(1, 0, h.question);
    h.delivery.onContext(h.branch);
    h.delivery.onAgentSettled(h.branch);
    expect(h.receipts).toEqual([]);
  });

  it("never revives receipt after uncertain settlement through retry and settlement-only confirmation", async () => {
    const h = fixture();
    expect(h.delivery.onAgentSettled(h.branch)).toBe("uncertain-advisory");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.send).toHaveBeenCalledTimes(2);
    h.delivery.onAgentStart();
    h.branch.push({ ...h.question, ...h.send.mock.calls[1][0] }, h.reply);
    // Preserve existing transport classification; only receipt eligibility is terminal.
    expect(h.delivery.onAgentSettled(h.branch)).toBe("advisory-only");
    expect(h.receipts).toEqual([]);
    expect(h.onReconciliationSettled).not.toHaveBeenCalled();
  });

  it.each(["amended", "duplicate-question", "duplicate-reply"])(
    "rejects ambiguous or amended canonical identity (%s)",
    (mode) => {
      const h = fixture();
      h.append();
      if (mode === "amended") h.question.content = "Changed question";
      if (mode === "duplicate-question")
        h.branch.splice(2, 0, { ...h.question, id: "question-copy" });
      if (mode === "duplicate-reply") h.branch.push(structuredClone(h.reply));
      h.delivery.onAgentSettled(h.branch);
      expect(h.receipts).toEqual([]);
    },
  );

  it.each(["input", "user", "intercom"])(
    "rejects mixed external origin (%s)",
    (mode) => {
      const h = fixture();
      h.append();
      if (mode === "input") h.delivery.onInput();
      else
        h.branch.push(
          mode === "user"
            ? {
                type: "message",
                id: "external",
                message: { role: "user", content: "Pause." },
              }
            : {
                type: "custom_message",
                id: "external",
                customType: "intercom_message",
                content: "Peer owns this.",
              },
        );
      h.delivery.onAgentSettled(h.branch);
      expect(h.receipts).toEqual([]);
    },
  );

  it.each([
    "disabled",
    "active",
    "pending",
    "session",
    "branch",
    "opportunity",
    "irrelevant",
    "print",
  ])("fences current transport state (%s)", (mode) => {
    const h = fixture();
    h.append();
    if (mode === "disabled") h.state.enabled = false;
    if (mode === "active") h.state.idle = false;
    if (mode === "pending") h.state.pendingMessages = true;
    if (mode === "session") h.state.sessionEpoch++;
    if (mode === "branch") h.state.branchEpoch++;
    if (mode === "opportunity")
      h.state.opportunityId = "00000000-0000-4000-8000-000000000099";
    if (mode === "irrelevant") h.state.relevant = false;
    if (mode === "print") h.state.mode = "print";
    h.delivery.onAgentSettled(h.branch);
    expect(h.receipts).toEqual([]);
  });

  it("does not expose correction replies as continuation roots", () => {
    const h = fixture("test-correction");
    h.append();
    h.delivery.onAgentSettled(h.branch);
    expect(h.receipts).toEqual([]);
  });

  it("rejects substantive tool execution without reading tool arguments or results", () => {
    const h = fixture();
    const forbidden = vi.fn(() => {
      throw new Error("Private payload read");
    });
    const tool = { type: "toolCall", id: "call", name: "bash" };
    Object.defineProperty(tool, "arguments", { get: forbidden });
    h.branch.push(
      h.question,
      {
        type: "message",
        id: "action",
        message: { role: "assistant", content: [tool], stopReason: "toolUse" },
      },
      h.reply,
    );
    h.delivery.onContext(h.branch);
    h.delivery.onAgentSettled(h.branch);
    expect(h.receipts).toEqual([]);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("binds final own-run identity through a retry start", () => {
    const h = fixture();
    h.delivery.onAgentStart();
    h.append();
    h.delivery.onAgentSettled(h.branch);
    expect(h.receipts).toHaveLength(1);
    expect(h.receipts[0].replyRunId).toBe(2);
  });

  it("releases original chain before callback and copies provenance", () => {
    const h = fixture();
    let admitted: string | undefined;
    h.onReconciliationSettled.mockImplementation((receipt) => {
      h.receipts.push(receipt);
      h.state.opportunityId = "00000000-0000-4000-8000-000000000099";
      admitted = h.delivery.request({
        ...h.request,
        opportunityId: h.state.opportunityId,
      });
    });
    h.append();
    h.delivery.onAgentSettled(h.branch);
    expect(admitted).toBe("started");
    h.question.id = "mutated";
    h.reply.message.content[0].text = "mutated";
    expect(h.receipts[0].question.entryId).toBe("question");
    expect(h.receipts[0].replies[0].messageHash).toBe(hash(response));
  });

  it.each([16, 17])(
    "bounds canonical reply count without truncation (%s)",
    (count) => {
      const h = fixture();
      h.branch.push(
        h.question,
        ...Array.from({ length: count }, (_, index) => ({
          ...structuredClone(h.reply),
          id: `reply-${index}`,
          parentId: index === 0 ? "question" : `reply-${index - 1}`,
        })),
      );
      h.delivery.onContext(h.branch);
      h.delivery.onAgentSettled(h.branch);
      expect(h.receipts).toHaveLength(count === 16 ? 1 : 0);
      if (count === 16) expect(h.receipts[0].replies).toHaveLength(16);
    },
  );

  it("rejects oversized visible reply evidence rather than hashing an unbounded payload", () => {
    const h = fixture();
    h.reply.message.content[0].text = "x".repeat(12 * 1024);
    h.append();
    h.delivery.onAgentSettled(h.branch);
    expect(h.receipts).toEqual([]);
  });

  it("bounds suffix scanning at64 entries", () => {
    const h = fixture();
    h.append();
    h.branch.push(
      ...Array.from({ length: 63 }, (_, index) => ({
        type: "custom",
        id: `metadata-${index}`,
        customType: "pi-progress-bar",
        data: {},
      })),
    );
    h.delivery.onAgentSettled(h.branch);
    expect(h.receipts).toEqual([]);
  });

  it.each(["onMasterOff", "onNavigation", "onSessionShutdown"] as const)(
    "revokes receipt eligibility at lifecycle boundary (%s)",
    (method) => {
      const h = fixture();
      h.append();
      h.delivery[method]();
      h.delivery.onAgentSettled(h.branch);
      expect(h.receipts).toEqual([]);
    },
  );

  it("contains callback failure without changing settlement classification", () => {
    const h = fixture();
    h.onReconciliationSettled.mockImplementation(() => {
      throw new Error("Observer failed");
    });
    h.append();
    expect(h.delivery.onAgentSettled(h.branch)).toBe("advisory-only");
    expect(h.onReconciliationSettled).toHaveBeenCalledTimes(1);
    expect(h.delivery.onAgentSettled(h.branch)).toBeUndefined();
  });
});
