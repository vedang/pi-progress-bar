import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { processObservation } from "../src/core/hybrid";
import {
  encodeCheckpoint,
  restoreCheckpoint,
} from "../src/core/hybrid-checkpoint";
import { emptyState } from "../src/core/hybrid-state";
import {
  backend,
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

function retainedPayloads(value: unknown) {
  const seen = new Set<unknown>();
  const payloads = new Map<string, string>();
  function visit(item: unknown) {
    if (!item || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    const record = item as Record<string, unknown>;
    if (
      typeof record.id === "string" &&
      typeof record.hash === "string" &&
      typeof record.text === "string"
    )
      payloads.set(`${record.id}:${record.hash}`, record.text);
    for (const child of item instanceof Map
      ? item.values()
      : Object.values(item))
      visit(child);
  }
  visit(value);
  return [...payloads.values()];
}

it("drains all 513 append IDs in order rather than keeping only a bounded suffix", async () => {
  const h = fixture([]);
  h.start();
  const ids = Array.from({ length: 513 }, (_, i) => `append-${i}`);
  h.replace(ids.map((id) => branchEntry(id, `Acknowledgment ${id}.`)));
  await h.settle(ids.at(-1) ?? "missing");
  expect(
    h.requests
      .filter((r) => "gate" in r.questions)
      .map((r) => (r.state as { latest: { id: string } }).latest.id),
  ).toEqual(ids);
  expect(h.extract).not.toHaveBeenCalled();
});

it("pages a >256KiB append without reading or retaining the full payload window at admission", async () => {
  const h = fixture([]);
  h.start();
  let reads = 0;
  const entries = Array.from({ length: 100 }, (_, i) => ({
    type: "message",
    id: `bytes-${i}`,
    parentId: null,
    message: {
      role: "user",
      get content() {
        reads++;
        return `Message ${i}: ${"x".repeat(4000)}`;
      },
    },
  }));
  h.replace(entries);
  expect(reads).toBeLessThanOrEqual(66);
  expect(
    retainedPayloads(h.monitor).reduce(
      (n, text) => n + Buffer.byteLength(text),
      0,
    ),
  ).toBeLessThanOrEqual(256 * 1024 + 4096);
  await h.settle("bytes-99");
  const ids = h.requests
    .filter((r) => "gate" in r.questions)
    .map((r) => (r.state as { latest: { id: string } }).latest.id);
  expect(ids).toEqual(entries.map((entry) => entry.id));
});

it("does not reread 10k settled historical payloads on ordinary append or duplicate hooks", async () => {
  let reads = 0;
  const entries = Array.from({ length: 10_000 }, (_, i) => ({
    type: "message",
    id: `history-${i}`,
    parentId: null,
    message: {
      role: "user" as const,
      get content() {
        reads++;
        return `History ${i}.`;
      },
    },
  }));
  const h = monitorHarness(entries);
  running.push(h);
  h.observe();
  const last = observation("history-9999", "History 9999.");
  const checkpoint = encodeCheckpoint(
    { ...emptyState("session:test"), cursor: { id: last.id, hash: last.hash } },
    {
      enabled: false,
      usage: {
        jev: { calls: 0, inputTokens: 0, outputTokens: 0 },
        extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
      },
    },
  );
  await h.monitor.restore("/nonexistent-hybrid-test", checkpoint);
  reads = 0;
  h.monitor.turnOn("/nonexistent-hybrid-test");
  h.append("new-message", "Acknowledged.");
  await h.settle("new-message");
  h.observe();
  h.observe();
  expect(reads).toBeLessThanOrEqual(8);
  expect(h.requests.filter((r) => "gate" in r.questions)).toHaveLength(1);
});

it("retains bounded canonical payloads after 1201 sequential settled messages", async () => {
  const h = fixture([]);
  h.start();
  for (let i = 0; i < 1201; i++) {
    const id = `sequential-${i}`;
    h.append(id, `Acknowledgment ${i}. ${"x".repeat(700)}`);
    await h.settle(id);
  }
  const payloads = retainedPayloads(h.monitor);
  expect(payloads.length).toBeLessThanOrEqual(66);
  expect(
    payloads.reduce((n, text) => n + Buffer.byteLength(text), 0),
  ).toBeLessThanOrEqual(256 * 1024 + 4096);
  expect(h.monitor.state.events.length).toBeLessThanOrEqual(1000);
  expect(
    Buffer.byteLength(JSON.stringify(h.monitor.checkpoint())),
  ).toBeLessThanOrEqual(512 * 1024);
}, 30_000);

it("reports an oversized whole message without truncating tasks or blocking the following observation", async () => {
  const h = fixture();
  h.start();
  await h.settle("goal");
  const tasks = structuredClone(h.monitor.state.tasks);
  // Bound a broken microtask retry loop so the regression cannot hang the suite.
  let publications = 0;
  let guardTripped = false;
  h.changed.mockImplementation(() => {
    if (++publications > 100 && !guardTripped) {
      guardTripped = true;
      h.monitor.turnOff();
    }
  });
  h.append("oversized", "秘密".repeat(5000));
  await vi.advanceTimersByTimeAsync(100);
  expect(guardTripped).toBe(false);
  expect(h.monitor.state.tasks.map((t) => [t.id, t.status])).toEqual(
    tasks.map((t) => [t.id, t.status]),
  );
  expect(JSON.stringify(h.monitor.debugSnapshot())).toMatch(
    /oversiz|overflow|limit|capacity/i,
  );
  h.append("after-overflow", "Acknowledged.");
  await h.settle("after-overflow");
  expect(
    h.requests.some(
      (r) =>
        (r.state as { latest?: { id: string } }).latest?.id === "oversized",
    ),
  ).toBe(false);
});

it("does not send future branch messages as earlier observation context", async () => {
  const h = fixture([
    branchEntry("goal", "Implement parser, add regression, and validate it."),
    branchEntry("future", "FUTURE_PRIVATE_MARKER: cancel all this work."),
  ]);
  h.start();
  await h.settle("future");
  const initialRequests = h.requests.filter(
    (r) => (r.state as { latest?: { id: string } }).latest?.id === "goal",
  );
  expect(initialRequests.length).toBeGreaterThan(0);
  expect(JSON.stringify(initialRequests)).not.toContain(
    "FUTURE_PRIVATE_MARKER",
  );
  expect(JSON.stringify(h.extract.mock.calls[0]?.[0])).not.toContain(
    "FUTURE_PRIVATE_MARKER",
  );
});

it("rejects event-cap mutation before admitting unpersistable completion", async () => {
  const state = await initial();
  const source = state.events[0]?.source;
  if (!source) throw new Error("Missing source");
  while (state.events.length < 1000)
    state.events.push({
      id: `event:${state.events.length + 1}`,
      kind: "revise",
      taskId: "task:1",
      revision: 1,
      source: { ...source },
    });
  expect(() => encodeCheckpoint(state)).not.toThrow();
  const delivery = observation(
    "capacity-delivery",
    "All tasks are complete.",
    "assistant",
  );
  const next = await processObservation(
    state,
    delivery,
    backend(noPatch(), { gate: "unchanged", complete: "yes" }),
  );
  expect(next.events.length).toBeLessThanOrEqual(1000);
  expect(() => encodeCheckpoint(next)).not.toThrow();
  expect(next.tasks.map((t) => t.status)).toEqual(
    state.tasks.map((t) => t.status),
  );
  expect(next.cursor).toEqual(state.cursor);
  expect(`${next.scopeError ?? ""} ${next.completionError ?? ""}`).toMatch(
    /capacity|limit|1000/i,
  );
});

it.each([false, true])(
  "rejects a forged accepted-chunk journal without matching latest assessments (hash=%s)",
  async (withHash) => {
    const state = await initial();
    const report = observation(
      "pending-report",
      "Work is ongoing.",
      "assistant",
    );
    const raw = JSON.parse(JSON.stringify(encodeCheckpoint(state)));
    raw.state.pending = {
      observation: {
        entryId: report.id,
        messageHash: report.hash,
        role: report.role,
      },
      phase: "complete",
      completedTaskIds: ["task:1"],
      completionHashes: withHash ? ["a".repeat(64)] : [],
    };
    expect(
      restoreCheckpoint(raw, "session:test", (id) =>
        [initialMessage, report].find((m) => m.id === id),
      ),
    ).toBeUndefined();
  },
);

it("does not persist malformed model response text through JSON parser exceptions", async () => {
  const p = backend();
  p.extract.mockResolvedValue("PRIVATE_PROVIDER_SENTINEL malformed JSON");
  const state = await processObservation(
    emptyState("session:test"),
    initialMessage,
    p,
  );
  expect(state.scopeError).toBeDefined();
  expect(JSON.stringify(encodeCheckpoint(state))).not.toContain(
    "PRIVATE_PROVIDER_SENTINEL",
  );
});

it("does not turn a capacity-rejected scope patch into accepted completion work after restart", async () => {
  const state = await initial();
  const source = state.events[0]?.source;
  if (!source) throw new Error("Missing source");
  while (state.events.length < 1000)
    state.events.push({
      id: `event:${state.events.length + 1}`,
      kind: "revise",
      taskId: "task:1",
      revision: 1,
      source: { ...source },
    });
  const message = observation(
    "capacity-scope",
    "Revise the parser requirement.",
  );
  const patch = {
    ...noPatch(),
    revise: [
      {
        id: "task:1",
        label: "Implement Unicode parser",
        requirementsChanged: true,
        quote: message.text,
      },
    ],
  };
  const first = await processObservation(state, message, backend(patch));
  expect(first.cursor).toEqual(state.cursor);
  expect(first.pending?.phase).toBe("extract");
  const restored = restoreCheckpoint(
    encodeCheckpoint(first),
    "session:test",
    (id) => [initialMessage, message].find((m) => m.id === id),
  );
  expect(restored).toBeDefined();
  if (!restored) throw new Error("Missing restored blocked state");
  const next = await processObservation(restored, message, backend(patch));
  expect(next.cursor).toEqual(state.cursor);
  expect(next.tasks).toEqual(state.tasks);
  expect(next.events).toEqual(state.events);
});

it("notices a changed canonical latest message with the same ID without rereading history", async () => {
  const h = fixture();
  h.start();
  await h.settle("goal");
  const text =
    "Implement parser, add regression, and validate it. Also clarify Unicode handling.";
  h.replace([branchEntry("goal", text)]);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.state.cursor?.hash).toBe(observation("goal", text).hash);
  expect(h.extract.mock.calls.at(-1)?.[0].latest.text).toBe(text);
  expect(
    restoreCheckpoint(h.monitor.checkpoint(), "session:test", (id) =>
      id === "goal" ? observation("goal", text) : undefined,
    ),
  ).toBeDefined();
});

it("retains no cross-hook authority index after 1201 settled observations", async () => {
  const h = fixture([]);
  h.start();
  for (let i = 0; i < 1201; i++) {
    const id = `authority-growth-${i}`;
    h.append(id, `Acknowledgement ${i}.`, "user");
    await h.settle(id);
  }
  expect(retainedPayloads(h.monitor).length).toBeLessThanOrEqual(66);
  expect(h.monitor).not.toHaveProperty("authorityIndex");
  expect(h.monitor).not.toHaveProperty("authoritySampleCursor");
});
