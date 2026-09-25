import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CoverageStore } from "../src/core/coverage";
import type { encodeCheckpoint } from "../src/core/hybrid-checkpoint";
import { coverageInventory, coverageNames } from "./fixtures/coverage";
import { monitorHarness } from "./fixtures/hybrid-monitor";

const running: ReturnType<typeof monitorHarness>[] = [];
// Tests deliberately construct storage fixtures; production retains unknown boundary.
function checkpoint(h: ReturnType<typeof monitorHarness>) {
  return h.monitor.checkpoint() as ReturnType<typeof encodeCheckpoint>;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline-key");
});
afterEach(() => {
  for (const h of running.splice(0)) h.monitor.stop();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
async function fixture() {
  const h = monitorHarness();
  running.push(h);
  h.start();
  await h.settle("goal");
  const parent = h.monitor.state.tasks[0];
  const text = coverageNames.join("\n");
  const entry = {
    type: "message",
    id: "inventory",
    parentId: "goal",
    message: {
      role: "toolResult",
      toolName: "bash",
      toolCallId: "manifest-call",
      content: [{ type: "text", text }],
      isError: false,
    },
  };
  h.replace([...h.reader(), entry]);
  const store = new CoverageStore();
  store.admit({
    parent,
    intent: parent.source,
    inventory: {
      ...coverageInventory(),
      source: {
        entryId: entry.id,
        messageHash: hash(text),
        callId: "manifest-call",
      },
    },
  });
  const saved = checkpoint(h);
  if (!saved.monitor) throw new Error("Missing monitor metadata");
  saved.monitor.coverage = {
    state: store.checkpoint(),
    dispatches: 1024,
    usage: {
      jev: { calls: 1024, inputTokens: 8, outputTokens: 4 },
      extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
    },
  };
  return { h, saved, entry, parent };
}
it("restores canonical tool inventory without semantic or health rebilling", async () => {
  const { h, saved } = await fixture();
  const calls = h.fetch.mock.calls.length;
  const extraction = h.extract.mock.calls.length;
  const cards = structuredClone(saved.monitor?.healthCards);
  const restoreSpy = vi.spyOn(CoverageStore, "restore");
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  expect(checkpoint(h).monitor?.coverage?.state.groups).toHaveLength(1);
  expect(checkpoint(h).monitor?.healthCards).toEqual(cards);
  expect(h.monitor.state.tasks).toEqual(saved.state.tasks);
  expect(h.fetch.mock.calls.length).toBe(calls);
  expect(h.extract.mock.calls.length).toBe(extraction);
  expect(restoreSpy).toHaveBeenCalledTimes(1);
});
it.each(["missing", "duplicate", "hash", "error", "excluded", "call"])(
  "drops %s inventory but retains exhausted budget and allocator",
  async (variant) => {
    const { h, saved, entry } = await fixture();
    const entries = h.reader().filter((candidate) => candidate !== entry);
    const changed = structuredClone(entry);
    if (variant === "duplicate") entries.push(entry, structuredClone(entry));
    else if (variant !== "missing") {
      if (variant === "hash") changed.message.content[0].text = "amended";
      if (variant === "error") changed.message.isError = true;
      if (variant === "excluded")
        Object.assign(changed.message, { excludeFromContext: true });
      if (variant === "call") changed.message.toolCallId = "different-call";
      entries.push(changed);
    }
    h.replace(entries);
    await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
    const coverage = checkpoint(h).monitor?.coverage;
    expect(coverage?.state.groups).toEqual([]);
    expect(coverage?.dispatches).toBe(1024);
    expect(coverage?.usage.jev.calls).toBe(1024);
    expect(coverage?.state.nextChildId).toBe(
      saved.monitor?.coverage?.state.nextChildId,
    );
    const first = checkpoint(h);
    await h.monitor.restore("/nonexistent-hybrid-test", first, false, h.reader);
    expect(checkpoint(h).monitor?.coverage?.dispatches).toBe(1024);
  },
);
it("retains exact inventory references beyond the newest64entries", async () => {
  const { h, saved } = await fixture();
  h.replace([
    ...h.reader(),
    ...Array.from({ length: 80 }, (_, i) => ({
      type: "custom",
      id: `later-${i}`,
      customType: "unrelated",
      data: {},
    })),
  ]);
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  expect(checkpoint(h).monitor?.coverage?.state.groups).toHaveLength(1);
});
it("same-source navigation cannot reset charged coverage budget from an older checkpoint", async () => {
  const { h, saved } = await fixture();
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  const older = structuredClone(saved);
  if (!older.monitor?.coverage) throw new Error("Missing fixture coverage");
  older.monitor.coverage.dispatches = 0;
  older.monitor.coverage.usage.jev = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  await h.monitor.restore("/nonexistent-hybrid-test", older, true, h.reader);
  expect(checkpoint(h).monitor?.coverage?.dispatches).toBe(1024);
  expect(checkpoint(h).monitor?.coverage?.usage.jev.calls).toBe(1024);
});
it("validates exact quote spans rather than only whole-message identity", async () => {
  const { h, saved, parent } = await fixture();
  const coverage = saved.monitor?.coverage;
  if (!coverage) throw new Error("Missing fixture coverage");
  coverage.state.groups[0].intent.start = 1;
  const seen: boolean[] = [];
  const restore = CoverageStore.restore;
  vi.spyOn(CoverageStore, "restore").mockImplementation((data, options) => {
    seen.push(options.sourceCurrent({ ...parent.source, start: 1 }));
    return restore(data, options);
  });
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((current) => current === false)).toBe(true);
  expect(checkpoint(h).monitor?.coverage?.state.groups).toEqual([]);
});
