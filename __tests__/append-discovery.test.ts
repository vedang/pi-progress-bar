import { describe, expect, it } from "vitest";
import type {
  EvaluationRequest,
  ValidatedResult,
} from "../src/analysis/gateway";
import { proposal } from "../src/sources/candidates";
import { Conversation } from "../src/sources/conversation";

type Entry = {
  type: string;
  id: string;
  parentId: string | null;
  message: { role: "user" | "assistant"; content: string };
};
type Selection = {
  candidates: { id: string; entryId: string }[];
  precedingUserMessages: { id: string; text: string }[];
};
function entry(
  id: string,
  parentId: string | null | undefined,
  role: "user" | "assistant" = "assistant",
  content = "An explanatory note.",
): Entry {
  return {
    type: "message",
    id,
    parentId: parentId ?? null,
    message: { role, content },
  };
}
function reject(request: EvaluationRequest): ValidatedResult {
  const source = request.questions.source;
  if (!source) throw new Error("Expected source selection");
  return {
    model: request.model,
    usage: { input_tokens: 1, output_tokens: 1 },
    answers: {
      source: {
        type: "choice",
        choice: "none",
        confidence: 1,
        probabilities: Object.fromEntries(
          Object.keys(source.criteria).map((key) => [
            key,
            key === "none" ? 1 : 0,
          ]),
        ),
      },
    },
  };
}
/** Drive synchronous discovery transitions; no gateway, timers, or paid requests. */
function drain(conversation: Conversation, entries: Entry[]) {
  const observations: { state: Selection; status: string }[] = [];
  for (let i = 0; i < 3000; i++) {
    const advanced = conversation.scheduleDiscovery(
      (_purpose, request, admit) => {
        observations.push({
          state: request.state as Selection,
          status: conversation.discoveryStatus,
        });
        admit(reject(request));
      },
      () => true,
    );
    conversation.releaseObservationCache();
    if (
      !advanced &&
      !conversation.hasPendingDiscovery() &&
      !conversation.isCatchingUp()
    )
      return observations;
    conversation.update(entries);
  }
  throw new Error("Discovery did not finish within finite transition budget");
}

describe("append discovery bounds and chronology", () => {
  it("considers the omitted prefix of a 513-entry append after catch-up", () => {
    const conversation = new Conversation();
    const entries = [entry("baseline", null)];
    conversation.update(entries);
    drain(conversation, entries);
    entries.push(
      entry(
        "prefix-request",
        "baseline",
        "user",
        "Please fix the Unicode parser.",
      ),
    );
    for (let i = 0; i < 512; i++)
      entries.push(entry(`filler-${i}`, entries.at(-1)?.id));
    conversation.update(entries, true);
    const observed = drain(conversation, entries);
    expect(
      observed.some(
        (item) => item.state.candidates[0]?.entryId === "prefix-request",
      ),
    ).toBe(true);
  });

  it("continues append extraction past the byte window", () => {
    const conversation = new Conversation();
    const entries = [entry("baseline", null)];
    conversation.update(entries);
    drain(conversation, entries);
    for (let i = 0; i < 40; i++)
      entries.push(
        entry(`large-${i}`, entries.at(-1)?.id, "assistant", "x".repeat(8000)),
      );
    entries.push(
      entry(
        "byte-tail-request",
        entries.at(-1)?.id,
        "user",
        "Please implement the correction.",
      ),
    );
    conversation.update(entries, true);
    const observed = drain(conversation, entries);
    expect(
      observed.some(
        (item) => item.state.candidates[0]?.entryId === "byte-tail-request",
      ),
    ).toBe(true);
  });

  it("retires settled candidates during long sequential catch-up-free operation", () => {
    const conversation = new Conversation();
    const entries = [entry("baseline", null)];
    conversation.update(entries);
    drain(conversation, entries);
    for (let i = 0; i < 1200; i++) {
      entries.push(entry(`settled-${i}`, entries.at(-1)?.id));
      conversation.update(entries, true);
      drain(conversation, entries);
    }
    expect(conversation.hasPendingDiscovery()).toBe(false);
    expect(conversation.candidates.length).toBeLessThanOrEqual(512);
  });

  it("bounds append payload reads with an already selected source", () => {
    let reads = 0;
    const entries: Entry[] = Array.from({ length: 10_000 }, (_, i) => ({
      type: "message",
      id: `history-${i}`,
      parentId: i ? `history-${i - 1}` : null,
      get message() {
        reads++;
        return { role: "user" as const, content: "1. Implement the parser." };
      },
    }));
    const conversation = new Conversation();
    conversation.update(entries);
    const candidate = conversation.candidates[0];
    if (!candidate) throw new Error("Expected source candidate");
    conversation.select(conversation.source(proposal(candidate)));
    reads = 0;
    entries.push(entry("append", entries.at(-1)?.id));
    conversation.update(entries, true);
    expect(reads).toBeLessThan(4096);
  });

  it.each(["context", "lane"])(
    "preserves historical %s across interleaved fresh append and page advance",
    (aspect) => {
      const conversation = new Conversation();
      const entries = [
        entry(
          "prior-user",
          null,
          "user",
          "Please inspect the original parser.",
        ),
      ];
      for (let i = 1; i < 512; i++)
        entries.push(entry(`page-one-${i}`, entries.at(-1)?.id));
      entries.push(
        entry(
          "historical-assistant",
          entries.at(-1)?.id,
          "assistant",
          "I will inspect the original parser.",
        ),
      );
      entries.push(
        entry(
          "historical-user",
          entries.at(-1)?.id,
          "user",
          "Please explain the earlier implementation.",
        ),
      );
      conversation.update(entries);
      entries.push(
        entry(
          "future",
          entries.at(-1)?.id,
          "user",
          "Instead implement the unrelated new feature.",
        ),
      );
      conversation.update(entries, true);
      const observed = drain(conversation, entries);
      if (aspect === "context") {
        const historical = observed.find(
          (item) =>
            item.state.candidates[0]?.entryId === "historical-assistant",
        );
        expect(historical).toBeDefined();
        expect(
          historical?.state.precedingUserMessages.map((item) => item.id),
        ).toContain("prior-user");
        expect(
          historical?.state.precedingUserMessages.map((item) => item.id),
        ).not.toContain("future");
      } else {
        const historical = observed.find(
          (item) => item.state.candidates[0]?.entryId === "historical-user",
        );
        expect(historical).toBeDefined();
        expect(historical?.status).toContain("chronological");
      }
    },
  );
});
