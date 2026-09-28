import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { subtaskCheckpointStorageStatus } from "../src/core/hybrid-checkpoint";
import { subtaskMetadataMonitor } from "./fixtures/subtask-metadata-monitor";

const running: ReturnType<typeof subtaskMetadataMonitor>[] = [];
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
async function fixture() {
  const h = subtaskMetadataMonitor();
  running.push(h);
  h.start();
  await h.settle("goal");
  await h.map();
  await h.readAll();
  expect(h.monitor.subtaskSnapshot().groups[0]?.children).toHaveLength(22);
  expect(
    h.monitor
      .subtaskAccessSnapshot()
      .groups[0]?.children.map((child) => child.status),
  ).toEqual(Array(22).fill("observed"));
  h.monitor.turnOff();
  const saved = h.checkpoint();
  if (!saved.monitor?.subtasks)
    throw new Error("Missing live generic admission");
  // A supported exhausted wallet, not fabricated accepted provider receipts.
  saved.monitor.subtasks.journal.usage.jev.calls +=
    1024 - saved.monitor.subtasks.journal.dispatches;
  saved.monitor.subtasks.journal.dispatches = 1024;
  expect(subtaskCheckpointStorageStatus(saved)).toBe("supported");
  return { h, saved, calls: h.counts() };
}

it("loses ephemeral adapter links without losing semantic children, exhausted wallet or allocator", async () => {
  const { h, saved, calls } = await fixture();
  const branch = h.reader().filter((entry) => {
    const candidate = entry as { message?: { role?: string } };
    return candidate.message?.role !== "toolResult";
  });
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    saved,
    false,
    () => branch,
  );
  const restored = h.checkpoint();
  expect(restored.monitor?.subtasks?.state).toEqual(
    saved.monitor?.subtasks?.state,
  );
  expect(restored.monitor?.subtasks?.journal.dispatches).toBe(1024);
  expect(restored.monitor?.subtasks?.journal.usage).toEqual(
    saved.monitor?.subtasks?.journal.usage,
  );
  expect(h.monitor.subtaskSnapshot().groups[0]?.children).toHaveLength(22);
  expect(
    h.monitor
      .subtaskAccessSnapshot()
      .groups.flatMap((group) => group.children)
      .some((child) => child.status === "observed"),
  ).toBe(false);
  expect(h.counts()).toEqual(calls);
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    restored,
    false,
    () => branch,
  );
  expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(1024);
  expect(h.monitor.subtaskSnapshot().groups[0]?.children).toHaveLength(22);
});

it("restores exact canonical child sources beyond the newest 64 branch entries", async () => {
  const { h, saved, calls } = await fixture();
  const branch = [
    ...h.reader(),
    ...Array.from({ length: 80 }, (_, i) => ({
      type: "custom",
      id: `later-${i}`,
      customType: "unrelated",
      data: {},
    })),
  ];
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    saved,
    false,
    () => branch,
  );
  expect(h.checkpoint().monitor?.subtasks?.state).toEqual(
    saved.monitor?.subtasks?.state,
  );
  expect(h.monitor.subtaskSnapshot().groups[0]?.children).toHaveLength(22);
  expect(h.counts()).toEqual(calls);
});

it("prunes a structurally valid wrong child quote span without refunding wallet or disturbing parent health", async () => {
  const { h, saved, calls } = await fixture();
  const component = saved.monitor?.subtasks;
  if (!component) throw new Error("Missing generic component");
  const source = component.state.groups[0].children[0].source;
  // Whole message identity remains exact; only the quoted slice becomes invalid.
  source.start += 1;
  expect(source.start).toBeLessThan(source.end);
  expect(subtaskCheckpointStorageStatus(saved)).toBe("supported");
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  const restored = h.checkpoint();
  expect(restored.monitor?.subtasks?.state.groups).toEqual([]);
  expect(restored.monitor?.subtasks?.state.nextChildId).toBe(
    component.state.nextChildId,
  );
  expect(restored.monitor?.subtasks?.state.nextGroupId).toBe(
    component.state.nextGroupId,
  );
  expect(restored.monitor?.subtasks?.journal.dispatches).toBe(1024);
  expect(restored.monitor?.subtasks?.journal.usage).toEqual(
    component.journal.usage,
  );
  expect(h.monitor.state.tasks).toEqual(saved.state.tasks);
  expect(restored.monitor?.healthCards).toEqual(saved.monitor?.healthCards);
  expect(h.counts()).toEqual(calls);
});
