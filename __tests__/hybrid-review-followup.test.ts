import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encodeCheckpoint } from "../src/core/hybrid-checkpoint";
import { type HybridState, observationRef } from "../src/core/hybrid-state";
import {
  addPatch,
  initial,
  initialMessage,
  noPatch,
  observation,
} from "./fixtures/hybrid";
import { branchEntry, monitorHarness } from "./fixtures/hybrid-monitor";

const running: ReturnType<typeof monitorHarness>[] = [];
function fixture(entries?: ReturnType<typeof branchEntry>[]) {
  const h = monitorHarness(entries);
  running.push(h);
  return h;
}
const metadata = {
  enabled: false,
  usage: {
    jev: { calls: 0, inputTokens: 0, outputTokens: 0 },
    extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
  },
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline-key");
});
afterEach(() => {
  for (const h of running.splice(0)) h.monitor.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function fillEvents(
  state: HybridState,
  count: number,
  source: ReturnType<typeof observation>,
) {
  for (let i = state.events.length; i < count; i++)
    state.events.push({
      id: `event:${i + 1}`,
      kind: "revise",
      taskId: "task:1",
      revision: 1,
      source: observationRef(source),
    });
}

it("presents completion-event capacity as unresolved, not current progress", async () => {
  const state = await initial();
  fillEvents(state, 1000, initialMessage);
  const h = fixture([branchEntry(initialMessage.id, initialMessage.text)]);
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    encodeCheckpoint(state, metadata),
    false,
    h.reader,
  );
  h.monitor.turnOn("/nonexistent-hybrid-test");
  h.append("delivered", "The regression and validation are complete.");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.state.events).toHaveLength(1000);
  expect(h.monitor.state.cursor?.id).toBe(initialMessage.id);
  expect(h.monitor.presentationSnapshot().progress.kind).toBe("previous");
  expect(h.monitor.debugSnapshot().diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "capacity-exhausted" }),
    ]),
  );
});

it("never admits an in-memory patch or cursor beyond the checkpoint byte bound", async () => {
  const base = await initial();
  function candidate(padding: number) {
    const state = structuredClone(base);
    const source = observation(
      `history-${"h".repeat(padding)}`,
      "Historical report.",
      "assistant",
    );
    fillEvents(state, 900, source);
    state.cursor = { id: source.id, hash: source.hash, role: source.role };
    return { state, source };
  }
  const bytes = Buffer.byteLength(
    JSON.stringify(encodeCheckpoint(candidate(0).state, metadata)),
  );
  const padding = Math.floor((512 * 1024 - 4500 - bytes) / 898);
  const { state, source } = candidate(padding);
  const checkpoint = encodeCheckpoint(state, metadata);
  expect(Buffer.byteLength(JSON.stringify(checkpoint))).toBeGreaterThan(
    500 * 1024,
  );
  const h = fixture([
    branchEntry(initialMessage.id, initialMessage.text),
    branchEntry(source.id, source.text, source.role),
  ]);
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    checkpoint,
    false,
    h.reader,
  );
  h.monitor.turnOn("/nonexistent-hybrid-test");
  const message = observation(
    "extra",
    "Deliver six independent reports.",
    "assistant",
  );
  h.extract.mockResolvedValueOnce({
    text: JSON.stringify(
      addPatch(
        message,
        Array.from({ length: 6 }, (_, i) => `${i} ${"🧪".repeat(230)}`),
      ),
    ),
    provider: "offline",
    model: "fixture",
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  h.append(message.id, message.text);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.state.tasks).toHaveLength(3);
  expect(h.monitor.state.cursor).toEqual(state.cursor);
  expect(h.monitor.presentationSnapshot().progress.kind).toBe("previous");
  expect(
    Buffer.byteLength(JSON.stringify(h.monitor.checkpoint())),
  ).toBeLessThanOrEqual(512 * 1024);
  expect(
    h.save.mock.calls.every(
      ([saved]) => Buffer.byteLength(JSON.stringify(saved)) <= 512 * 1024,
    ),
  ).toBe(true);
});

it("validates archived historical authority on OFF, amendment, ON before admitting old work", async () => {
  const h = fixture();
  h.start();
  await h.settle("goal");
  const archive = "Archive the first deliverable.";
  h.extract.mockResolvedValueOnce({
    text: JSON.stringify({
      ...noPatch(),
      archive: [{ id: "task:1", quote: archive }],
    }),
    provider: "offline",
    model: "fixture",
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  h.append("extra", archive);
  await h.settle("extra");
  h.append("tail", "Acknowledged.");
  await h.settle("tail");
  expect(h.monitor.state.tasks[0]?.included).toBe(false);
  h.monitor.turnOff();
  const revised = "Implement the corrected parser and validate it.";
  h.replace([
    branchEntry("goal", revised),
    branchEntry("extra", archive, "assistant"),
    branchEntry("tail", "Acknowledged.", "assistant"),
  ]);
  h.monitor.turnOn("/nonexistent-hybrid-test");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.state.tasks[0]?.source.messageHash).toBe(
    observation("goal", revised).hash,
  );
});

async function afterOverflow(reload: boolean) {
  const h = fixture();
  h.start();
  await h.settle("goal");
  h.append("oversized", "x".repeat(13 * 1024));
  await h.settle("oversized");
  if (reload) {
    const saved = h.monitor.checkpoint();
    h.monitor.turnOff();
    await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  }
  h.append("extra", "Explain the preceding work.");
  await h.settle("extra");
  const context = h.extract.mock.calls.find(
    ([input]) => input.latest.id === "extra",
  )?.[0].earlier;
  h.monitor.stop();
  return context;
}
it("uses identical earlier context after an oversized predecessor with or without reload", async () => {
  expect(await afterOverflow(true)).toEqual(await afterOverflow(false));
});

it("resumes an accepted gate after overflow using exactly the original extraction context", async () => {
  const h = fixture();
  h.start();
  await h.settle("goal");
  const oversized = "x".repeat(13 * 1024);
  h.append("oversized", oversized);
  await h.settle("oversized");
  h.extract.mockImplementationOnce(() => new Promise<never>(() => {}));
  const latest = "Explain the preceding work.";
  h.append("extra", latest);
  await vi.advanceTimersByTimeAsync(5);
  expect(h.monitor.state.pending?.phase).toBe("extract");
  const before = h.extract.mock.calls.find(
    ([input]) => input.latest.id === "extra",
  )?.[0].earlier;
  const saved = h.monitor.checkpoint();
  h.monitor.stop();
  const restored = fixture([
    branchEntry("goal", "Implement parser, add regression, and validate it."),
    branchEntry("oversized", oversized, "assistant"),
    branchEntry("extra", latest, "assistant"),
  ]);
  await restored.monitor.restore(
    "/nonexistent-hybrid-test",
    saved,
    false,
    restored.reader,
  );
  await restored.settle("extra");
  expect(restored.requests.some((request) => "gate" in request.questions)).toBe(
    false,
  );
  expect(restored.extract.mock.calls[0]?.[0].earlier).toEqual(before);
});

it.each([10, 70])(
  "qualifies a held last page within %i historical messages as catching up",
  async (count) => {
    const h = fixture(
      Array.from({ length: count }, (_, i) =>
        branchEntry(`history-${i}`, `Historical observation ${i}.`),
      ),
    );
    const original = h.fetch.getMockImplementation();
    if (!original) throw new Error("Missing fetch");
    const heldId = `history-${count === 10 ? 0 : 64}`;
    h.fetch.mockImplementation((url, init) => {
      const request = JSON.parse(String(init?.body));
      return request.questions.gate && request.state.latest.id === heldId
        ? new Promise<never>(() => {})
        : original(url, init);
    });
    h.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(
      h.fetch.mock.calls.some(
        ([, init]) =>
          JSON.parse(String(init?.body)).state.latest?.id === heldId,
      ),
    ).toBe(true);
    expect(JSON.stringify(h.monitor.presentationSnapshot())).toMatch(
      /catching up history/i,
    );
  },
);

it("validates every distinct authoritative accessor once per duplicate hook", async () => {
  const state = await initial();
  let reads = 0;
  const entries: unknown[] = [
    branchEntry(initialMessage.id, initialMessage.text),
  ];
  for (let i = state.events.length; i < 1000; i++) {
    const source = observation(
      `event-source-${i}`,
      `Historical report ${i}.`,
      "assistant",
    );
    state.events.push({
      id: `event:${i + 1}`,
      kind: "revise",
      taskId: "task:1",
      revision: 1,
      source: observationRef(source),
    });
    entries.push({
      type: "message",
      id: source.id,
      message: {
        role: source.role,
        get content() {
          reads++;
          return source.text;
        },
      },
    });
    state.cursor = { id: source.id, hash: source.hash, role: source.role };
  }
  const h = fixture([]);
  h.replace(entries);
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    encodeCheckpoint(state, metadata),
    false,
    h.reader,
  );
  h.monitor.turnOn("/nonexistent-hybrid-test");
  h.observe();
  reads = 0;
  h.observe();
  h.observe();
  h.observe();
  // User explicitly replaced sampled validation with full relevant-source reads.
  // Three seed events share the plain initial source; 997 use distinct getters.
  expect(reads).toBe(3 * 997);
});

it.each(["string", "text-block"])(
  "authority indexing still detects an in-place %s amendment",
  async (variant) => {
    const original = "Implement parser, add regression, and validate it.";
    const entry = {
      type: "message",
      id: "goal",
      message: {
        role: "user",
        content:
          variant === "string" ? original : [{ type: "text", text: original }],
      },
    };
    const h = fixture([]);
    h.replace([entry, branchEntry("tail", "Acknowledged.", "assistant")]);
    h.start();
    await h.settle("tail");
    const revised = "Implement the updated parser and validate it.";
    if (typeof entry.message.content === "string")
      entry.message.content = revised;
    else {
      const block = entry.message.content[0];
      if (!block) throw new Error("Missing block");
      block.text = revised;
    }
    h.observe();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.monitor.state.tasks[0]?.source.messageHash).toBe(
      observation("goal", revised).hash,
    );
  },
);

it("detects a deep accessor amendment in one hook, without reading unrelated old payloads", async () => {
  const state = await initial();
  const entries: unknown[] = [
    branchEntry(initialMessage.id, initialMessage.text),
  ];
  let unrelatedReads = 0;
  for (let i = 0; i < 200; i++)
    entries.push({
      type: "message",
      id: `unrelated-${i}`,
      message: {
        role: "assistant",
        get content() {
          unrelatedReads++;
          return "Unrelated old payload.";
        },
      },
    });
  let amended = false;
  for (let i = state.events.length; i < 1000; i++) {
    const source = observation(
      `deep-source-${i}`,
      `Historical report ${i}.`,
      "assistant",
    );
    state.events.push({
      id: `event:${i + 1}`,
      kind: "revise",
      taskId: "task:1",
      revision: 1,
      source: observationRef(source),
    });
    entries.push({
      type: "message",
      id: source.id,
      message: {
        role: source.role,
        get content() {
          return amended && i === 800
            ? "Amended authoritative report."
            : source.text;
        },
      },
    });
    state.cursor = { id: source.id, hash: source.hash, role: source.role };
  }
  const h = fixture([]);
  h.replace(entries);
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    encodeCheckpoint(state, metadata),
    false,
    h.reader,
  );
  h.monitor.turnOn("/nonexistent-hybrid-test");
  unrelatedReads = 0;
  h.observe();
  expect(unrelatedReads).toBe(0);
  amended = true;
  h.observe();
  expect(h.monitor.state.events.length).toBeLessThan(1000);
  expect(h.monitor.state.cursor).toBeUndefined();
});

it("detects an in-place role amendment despite identical payload text", async () => {
  const entry = branchEntry(
    "goal",
    "Implement parser, add regression, and validate it.",
  );
  const h = fixture([entry, branchEntry("tail", "Acknowledged.", "assistant")]);
  h.start();
  await h.settle("tail");
  expect(h.monitor.state.tasks[0]?.source.role).toBe("user");
  entry.message.role = "assistant";
  h.observe();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.state.tasks[0]?.source.role).toBe("assistant");
});

it.each([10, 70])(
  "qualifies %i messages already after a restored cursor as history",
  async (count) => {
    const state = await initial();
    const h = fixture([
      branchEntry(initialMessage.id, initialMessage.text),
      ...Array.from({ length: count }, (_, i) =>
        branchEntry(`restored-${i}`, `Historical observation ${i}.`),
      ),
    ]);
    const original = h.fetch.getMockImplementation();
    if (!original) throw new Error("Missing fetch");
    const heldId = `restored-${count === 10 ? 0 : 64}`;
    h.fetch.mockImplementation((url, init) => {
      const request = JSON.parse(String(init?.body));
      return request.questions.gate && request.state.latest.id === heldId
        ? new Promise<never>(() => {})
        : original(url, init);
    });
    await h.monitor.restore(
      "/nonexistent-hybrid-test",
      encodeCheckpoint(state, metadata),
      false,
      h.reader,
    );
    h.monitor.turnOn("/nonexistent-hybrid-test");
    await vi.advanceTimersByTimeAsync(100);
    expect(
      h.fetch.mock.calls.some(
        ([, init]) =>
          JSON.parse(String(init?.body)).state.latest?.id === heldId,
      ),
    ).toBe(true);
    expect(JSON.stringify(h.monitor.presentationSnapshot())).toMatch(
      /catching up history/i,
    );
  },
);

it("gates every visible acknowledgement/question once regardless of role, never idle callbacks", async () => {
  const h = fixture([]);
  h.start();
  const messages = [
    branchEntry("user-ack", "Thanks."),
    branchEntry("user-question", "What is left?"),
    branchEntry("assistant-ack", "Understood.", "assistant"),
    branchEntry("assistant-question", "Can you approve this?", "assistant"),
  ];
  for (const entry of messages) {
    h.append(entry.id, entry.message.content, entry.message.role);
    await h.settle(entry.id);
  }
  h.replace([
    ...messages,
    {
      type: "message",
      id: "tool-only",
      message: { role: "toolResult", content: "Tool output." },
    },
    {
      type: "message",
      id: "thinking-only",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Private reasoning." }],
      },
    },
    branchEntry("blank", "   "),
  ]);
  const calls = h.fetch.mock.calls.length;
  h.observe();
  h.observe();
  h.observe();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(
    h.requests
      .filter((r) => "gate" in r.questions)
      .map((r) => {
        const latest = (r.state as { latest: { id: string; role: string } })
          .latest;
        return [latest.id, latest.role];
      }),
  ).toEqual(messages.map((entry) => [entry.id, entry.message.role]));
  expect(h.fetch).toHaveBeenCalledTimes(calls);
  expect(h.extract).not.toHaveBeenCalled();
});

it("invalidates a held gate when context order changes without any text amendment", async () => {
  const entries = [
    branchEntry("goal", "Implement parser, add regression, and validate it."),
    branchEntry("context-a", "First clarification."),
    branchEntry("context-b", "Second clarification."),
  ];
  const h = fixture(entries);
  h.start();
  await h.settle("context-b");
  const original = h.fetch.getMockImplementation();
  if (!original) throw new Error("Missing fetch");
  let release: () => void = () => {};
  let held = false;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (
      request.questions.gate &&
      request.state.latest.id === "latest" &&
      !held
    ) {
      held = true;
      await barrier;
    }
    return original(url, init);
  });
  const latest = branchEntry("latest", "Acknowledged.", "assistant");
  h.append(latest.id, latest.message.content, latest.message.role);
  await vi.advanceTimersByTimeAsync(5);
  expect(held).toBe(true);
  h.replace([
    ...entries,
    branchEntry("inserted-context", "New intervening clarification."),
    latest,
  ]);
  release();
  await vi.advanceTimersByTimeAsync(200);
  const gates = h.requests.filter(
    (r) =>
      "gate" in r.questions &&
      (r.state as { latest: { id: string } }).latest.id === "latest",
  );
  const current = gates.at(-1)?.state as
    | { earlier?: { id: string }[] }
    | undefined;
  expect(current?.earlier?.map((message) => message.id)).toEqual([
    "context-b",
    "inserted-context",
  ]);
  expect(h.monitor.state.cursor?.id).toBe("latest");
});

it("does not label a single live append after restoration as historical catch-up", async () => {
  const state = await initial();
  const h = fixture([branchEntry(initialMessage.id, initialMessage.text)]);
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    encodeCheckpoint(state, metadata),
    false,
    h.reader,
  );
  h.monitor.turnOn("/nonexistent-hybrid-test");
  h.fetch.mockImplementationOnce(() => new Promise<never>(() => {}));
  h.append("live-append", "Acknowledged.", "user");
  await vi.advanceTimersByTimeAsync(5);
  expect(h.fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(h.monitor.presentationSnapshot())).not.toMatch(
    /catching up history/i,
  );
});

it.each(["observe", "off-on"])(
  "uses one canonical reader snapshot across a %s boundary",
  async (boundary) => {
    const original = branchEntry(
      "goal",
      "Implement parser, add regression, and validate it.",
    );
    const revised = branchEntry(
      "goal",
      "Implement the revised parser and validate it.",
    );
    const h = fixture([original]);
    h.start();
    await h.settle("goal");
    if (boundary === "off-on") h.monitor.turnOff();
    h.reader.mockClear();
    h.reader.mockReturnValueOnce([original]).mockReturnValue([revised]);
    if (boundary === "off-on") h.monitor.turnOn("/nonexistent-hybrid-test");
    else h.observe();
    expect(h.reader).toHaveBeenCalledTimes(1);
    expect(h.monitor.state.tasks[0]?.source.messageHash).toBe(
      observation(original.id, original.message.content).hash,
    );
    // A genuinely subsequent boundary sees the changed branch. Do not retain
    // this boundary's canonical pass as a cross-hook authority cache.
    h.observe();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.monitor.state.tasks[0]?.source.messageHash).toBe(
      observation(revised.id, revised.message.content).hash,
    );
  },
);

it("restores from one reader snapshot even when a second read would return a different branch", async () => {
  const state = await initial();
  const original = branchEntry(initialMessage.id, initialMessage.text);
  const revised = branchEntry(
    initialMessage.id,
    "The authoritative requirements have changed.",
  );
  const h = fixture([original]);
  h.reader.mockReturnValueOnce([original]).mockReturnValue([revised]);
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    encodeCheckpoint(state, metadata),
    false,
    h.reader,
  );
  expect(h.reader).toHaveBeenCalledTimes(1);
  expect(h.monitor.state.tasks[0]?.source.messageHash).toBe(
    initialMessage.hash,
  );
  h.monitor.turnOn("/nonexistent-hybrid-test");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.state.scopeAssessment?.source.messageHash).toBe(
    observation(revised.id, revised.message.content).hash,
  );
});
