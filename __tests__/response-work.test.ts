import { describe, expect, it, vi } from "vitest";
import { reconcileLedger } from "../src/core/ledger";
import { Monitor } from "../src/core/monitor";
import { proposal } from "../src/sources/candidates";
import { Conversation } from "../src/sources/conversation";
import { reportChunks } from "../src/sources/reports";
import { hashText } from "../src/sources/trajectory";

function fixture() {
  const entry = {
    type: "message",
    id: "work",
    parentId: null,
    message: {
      role: "user",
      content:
        "1. Implement Unicode identifiers\n2. Explain what work remains\n3. Add parser regression tests",
    },
  };
  const conversation = new Conversation();
  conversation.update([entry]);
  const candidate = conversation.candidates[0];
  if (!candidate) throw new Error("Missing candidate");
  const spans = candidate.spans.filter((span) => span.kind === "list");
  const classes = Object.fromEntries(
    spans.map((span, index) => [span.id, index === 1 ? "response" : "task"]),
  );
  const proposed = proposal(candidate, classes);
  return { entry, conversation, proposed };
}

describe("Jev-derived response work", () => {
  it("keeps response classification without local semantic inference", () => {
    const f = fixture();
    expect(f.proposed.snapshot.tasks).toHaveLength(3);
    expect(f.proposed.snapshot.tasks[1]?.workKind).toBe("response");
    expect(f.proposed.snapshot.tasks[1]?.text).toBe(
      "Explain what work remains",
    );
    expect(f.proposed.snapshot.tasks[0]?.workKind).not.toBe("response");
  });

  it("round-trips bounded response kind through canonical reference-only sources", () => {
    const f = fixture();
    const source = f.conversation.source(f.proposed);
    expect(source.spans[1]?.workKind).toBe("response");
    expect(JSON.stringify(source)).not.toContain("Explain what work remains");
    expect(
      f.conversation.rehydrate(f.conversation.canonicalSource(source)).tasks[1]
        ?.workKind,
    ).toBe("response");
    const invalid = structuredClone(source);
    Object.assign(invalid.spans[1] ?? {}, { workKind: "invented" });
    expect(() => f.conversation.canonicalSource(invalid)).toThrow();
    const missing = structuredClone(source);
    Reflect.deleteProperty(missing.spans[1] ?? {}, "workKind");
    expect(() => f.conversation.canonicalSource(missing)).toThrow();
  });

  it("isolates response state while retaining ordinary action batching", () => {
    const f = fixture();
    const ledger = reconcileLedger(undefined, f.proposed.snapshot);
    const text =
      "Implementation and regression tests remain unfinished. This is the requested status answer.";
    const requests = reportChunks(ledger, {
      id: "reply",
      role: "assistant",
      text,
      hash: hashText(text),
    });
    const response = ledger.tasks.find((task) => task.workKind === "response");
    if (!response) throw new Error("Missing response task");
    const local = requests.find((request) =>
      Object.hasOwn(request.questions, response.id),
    );
    expect(local).toBeDefined();
    expect(local?.state).toMatchObject({
      task: { id: response.id, text: response.text },
    });
    expect(JSON.stringify(local?.state)).not.toContain(
      "Implement Unicode identifiers",
    );
    expect(JSON.stringify(local?.state)).not.toContain(
      "Add parser regression tests",
    );
    expect(requests).toHaveLength(2);
    expect(
      requests.filter(
        (request) => !Object.hasOwn(request.questions, response.id),
      )[0]?.questions,
    ).toHaveProperty(ledger.tasks[0]?.id ?? "missing");
  });

  it.each(["version", "task-kind", "source-kind"])(
    "rejects obsolete persisted shape: %s",
    async (mutation) => {
      vi.stubEnv("TYPESAFE_API_KEY", "");
      const f = fixture();
      const monitor = new Monitor(vi.fn(), vi.fn());
      const entries = [f.entry];
      monitor.observe(() => entries);
      monitor.conversation.update(entries);
      monitor.source = f.conversation.source(f.proposed);
      monitor.ledger = reconcileLedger(undefined, f.proposed.snapshot);
      const checkpoint = monitor.checkpoint();
      if (mutation === "version") Object.assign(checkpoint, { version: 2 });
      if (mutation === "task-kind")
        Reflect.deleteProperty(checkpoint.tasks[0] ?? {}, "workKind");
      if (mutation === "source-kind")
        Reflect.deleteProperty(checkpoint.source?.spans[0] ?? {}, "workKind");
      try {
        await monitor.restore("/nonexistent-offline-fixture", checkpoint);
        expect(monitor.ledger).toBeUndefined();
      } finally {
        monitor.stop();
        vi.unstubAllEnvs();
      }
    },
  );

  it("preserves response kind through a monitor checkpoint and reload", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const f = fixture();
    const monitor = new Monitor(vi.fn(), vi.fn());
    const entries = [f.entry];
    monitor.observe(() => entries);
    monitor.conversation.update(entries);
    monitor.source = f.conversation.source(f.proposed);
    monitor.ledger = reconcileLedger(undefined, f.proposed.snapshot);
    const checkpoint = monitor.checkpoint();
    try {
      expect(JSON.stringify(checkpoint)).not.toContain(
        "Explain what work remains",
      );
      await monitor.restore("/nonexistent-offline-fixture", checkpoint);
      expect(
        monitor.ledger?.tasks.filter((task) => task.workKind === "response"),
      ).toHaveLength(1);
    } finally {
      monitor.stop();
      vi.unstubAllEnvs();
    }
  });
});
