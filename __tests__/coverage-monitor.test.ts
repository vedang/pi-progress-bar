import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBoard } from "../src/ui/board";
import { renderWidget } from "../src/ui/widget";
import { coverageNames } from "./fixtures/coverage";
import {
  metadataCommand as command,
  type MetadataEnvelope,
  subtaskMetadataMonitor,
  metadataXml as xml,
} from "./fixtures/subtask-metadata-monitor";

const running: ReturnType<typeof subtaskMetadataMonitor>[] = [];
const releases: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline");
});
afterEach(() => {
  for (const h of running.splice(0)) h.monitor.stop();
  for (const release of releases.splice(0)) release();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function fixture() {
  const h = subtaskMetadataMonitor();
  running.push(h);
  return h;
}
async function ready() {
  const h = fixture();
  h.start();
  await h.settle("goal");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.counts()).toMatchObject({ gate: 1, proposal: 0, report: 0 });
  expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(1);
  return h;
}
async function mapped() {
  const h = await ready();
  await h.map();
  expect(h.monitor.subtaskSnapshot().groups[0].children).toHaveLength(22);
  expect(
    h.monitor
      .subtaskAccessSnapshot()
      .groups[0].children.map((child) => child.status),
  ).toEqual(Array(22).fill("no-observation"));
  const before = h.counts();
  await h.readAll();
  expect(
    h.monitor
      .subtaskAccessSnapshot()
      .groups[0].children.map((child) => child.status),
  ).toEqual(Array(22).fill("observed"));
  expect(
    h.monitor
      .subtaskSnapshot()
      .groups[0].children.every((child) => child.status === "pending"),
  ).toBe(true);
  expect(h.counts()).toEqual(before);
  return h;
}
const theme = {
  fg: (_: string, text: string) => text,
  bg: (_: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
function view(h: ReturnType<typeof fixture>) {
  return {
    presentation: h.monitor.presentationSnapshot(),
    board: h.monitor.boardSnapshot(),
    visibility: h.monitor.visibilitySnapshot(),
    subtasks: h.monitor.subtaskSnapshot(),
    subtaskAccess: h.monitor.subtaskAccessSnapshot(),
    subtaskDiagnostics: h.monitor.subtaskDiagnosticsSnapshot(),
  };
}

it("does not dispatch the selected proposer when its pre-network budget checkpoint fails", async () => {
  const h = await ready();
  h.save.mockImplementation((raw: unknown) => {
    if (
      (raw as MetadataEnvelope).monitor?.subtasks?.journal.records.some(
        (record) => record.proposal?.outcome === "dispatched",
      )
    )
      throw new Error("proposal budget write denied");
  });
  await h.run("manifest", "bash", { command }, xml);
  expect(h.proposeSubtasks).toHaveBeenCalledTimes(1);
  expect(h.admissions).toEqual([false]);
  expect(h.proposalNetwork).not.toHaveBeenCalled();
  expect(h.monitor.subtaskSnapshot().groups).toEqual([]);
  expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(2);
  expect(h.monitor.state.tasks).toHaveLength(1);
  expect(h.monitor.state.cursor?.id).toBe("goal");
});
it("creates22pending children through gate and proposal without changing parent health or mandatory billing", async () => {
  const h = await ready();
  const tasks = structuredClone(h.monitor.state.tasks);
  const health = structuredClone(h.monitor.boardSnapshot().tasks[0].health);
  const before = h.counts();
  await h.run("manifest", "bash", { command }, xml);
  const group = h.monitor.subtaskSnapshot().groups[0];
  expect(group.children.map((child) => child.label)).toEqual(coverageNames);
  expect(group.children.every((child) => child.status === "pending")).toBe(
    true,
  );
  expect(h.monitor.subtaskSnapshot().groups).toHaveLength(1);
  expect(h.monitor.state.tasks).toEqual(tasks);
  expect(h.monitor.boardSnapshot().tasks[0].health).toEqual(health);
  expect(h.counts()).toEqual({
    ...before,
    gate: before.gate + 1,
    proposal: before.proposal + 1,
  });
  expect(h.checkpoint().monitor?.subtasks?.state.groups).toHaveLength(1);
  expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(3);
});
it("keeps preappend results provisional and never publishes children before admission storage succeeds", async () => {
  const h = await ready();
  const calls = h.counts();
  h.monitor.observeCoverageToolStart("manifest", "bash", { command });
  h.monitor.observeCoverageToolEnd("manifest", "bash");
  h.monitor.confirmCoverageBranch(h.reader());
  expect(h.monitor.subtaskSnapshot().groups).toEqual([]);
  expect(h.counts()).toEqual(calls);
  h.save.mockImplementation((raw: unknown) => {
    if ((raw as MetadataEnvelope).monitor?.subtasks?.state.groups.length)
      throw new Error("group publication unavailable");
  });
  const before = structuredClone(h.monitor.state.tasks);
  await h.run("manifest", "bash", { command }, xml);
  expect(h.proposalNetwork).toHaveBeenCalledTimes(1);
  expect(h.admissions).toEqual([true]);
  expect(h.monitor.subtaskSnapshot().groups).toEqual([]);
  expect(h.checkpoint().monitor?.subtasks?.state.groups).toEqual([]);
  expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(3);
  expect(h.monitor.state.tasks).toEqual(before);
});
it("retains metadata confirmed before held mandatory extraction creates its parent", async () => {
  const h = fixture();
  const extract = h.extract.getMockImplementation();
  if (!extract) throw new Error("Missing mandatory transport");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  h.extract.mockImplementation(async (...args) => {
    await held;
    return extract(...args);
  });
  h.start();
  await vi.advanceTimersByTimeAsync(20);
  expect(h.extract).toHaveBeenCalledTimes(1);
  await h.run("manifest", "bash", { command }, xml);
  expect(h.monitor.state.tasks).toEqual([]);
  expect(h.monitor.subtaskSnapshot().groups).toEqual([]);
  expect(h.counts()).toMatchObject({ gate: 0, proposal: 0, report: 0 });
  release();
  await h.settle("goal");
  await vi.advanceTimersByTimeAsync(200);
  expect(h.monitor.subtaskSnapshot().groups[0]?.children).toHaveLength(22);
  expect(h.counts()).toMatchObject({ gate: 1, proposal: 1, report: 0 });
  expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(2);
});
it("shows immediate exact item/batch access with no network calls or reported completion", async () => {
  const h = await mapped();
  const calls = h.counts();
  const active = () =>
    h.monitor
      .subtaskAccessSnapshot()
      .groups[0].children.map((child) => child.activeCallHashes);
  h.monitor.observeCoverageToolStart("a", "bash", {
    command: "cat extracted/tab-0.txt",
  });
  h.monitor.observeCoverageToolStart("b", "bash", {
    command: "cat extracted/tab-1.txt extracted/tab-2.txt",
  });
  const hashes = active();
  expect(hashes.slice(0, 3).map((item) => item.length)).toEqual([1, 1, 1]);
  expect(hashes[1]).toEqual(hashes[2]);
  expect(hashes[0]).not.toEqual(hashes[1]);
  expect(hashes.slice(3).flat()).toEqual([]);
  h.monitor.observeCoverageToolEnd("unmatched", "bash");
  expect(active()).toEqual(hashes);
  h.monitor.observeCoverageToolEnd("a", "bash");
  expect(active().slice(0, 3)).toEqual([[], hashes[1], hashes[2]]);
  h.monitor.observeCoverageToolEnd("b", "bash");
  expect(active().flat()).toEqual([]);
  expect(
    h.monitor
      .subtaskSnapshot()
      .groups[0].children.every((child) => child.status === "pending"),
  ).toBe(true);
  expect(h.counts()).toEqual(calls);
});
it("OFF and reload preserve children allocator and wallet but clear runtime access without rebilling", async () => {
  const h = await mapped();
  h.monitor.observeCoverageToolStart("active", "bash", {
    command: "cat extracted/tab-0.txt",
  });
  expect(
    h.monitor.subtaskAccessSnapshot().groups[0].children[0].activeCallHashes,
  ).toHaveLength(1);
  const before = h.checkpoint().monitor?.subtasks;
  const calls = h.counts();
  h.monitor.turnOff();
  const saved = h.checkpoint();
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  expect(h.checkpoint().monitor?.subtasks?.state).toEqual(before?.state);
  expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(
    before?.journal.dispatches,
  );
  // OFF restore has no initialized access runtime. Missing bindings mean
  // unavailable (not observed zero); the detached semantic projection survives.
  expect(h.monitor.subtaskAccessSnapshot().groups).toEqual([]);
  expect(h.monitor.subtaskSnapshot().groups[0].children).toHaveLength(22);
  expect(h.counts()).toEqual(calls);
  expect(JSON.stringify(saved)).not.toContain("PRIVATE_CONFIRMED_READ_BODY");
});
it("canonical metadata amendment invalidates links but retains conversation children with one negative gate", async () => {
  const h = await mapped();
  const groups = h.monitor.subtaskSnapshot();
  const tasks = structuredClone(h.monitor.state.tasks);
  const health = h.monitor.boardSnapshot().tasks[0].health;
  const calls = h.counts();
  h.replace(
    h
      .reader()
      .filter((entry) => (entry as { id?: string }).id !== "result-manifest"),
  );
  h.monitor.confirmCoverageBranch(h.reader());
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.subtaskSnapshot()).toEqual(groups);
  expect(h.monitor.state.tasks).toEqual(tasks);
  expect(h.monitor.boardSnapshot().tasks[0].health).toEqual(health);
  expect(
    h.monitor
      .subtaskAccessSnapshot()
      .groups[0].children.map((child) => child.status),
  ).toEqual(Array(22).fill("unavailable"));
  expect(h.counts()).toEqual({ ...calls, gate: calls.gate + 1 });
  const after = h.counts();
  h.monitor.confirmCoverageBranch(h.reader());
  await vi.advanceTimersByTimeAsync(100);
  expect(h.counts()).toEqual(after);
});
it("bounds confirmed shared metadata allocation with distinct resources, stable confirmation and OFF reset", async () => {
  const h = await ready();
  const empty = h.monitor.subtaskDiagnosticsSnapshot().adapter;
  const names = Array.from({ length: 52 }, (_, i) => `${i}-${"x".repeat(200)}`);
  const body = `<workbook><sheets>${names.map((name) => `<sheet name="${name}"/>`).join("")}</sheets></workbook>`;
  for (let i = 0; i < 8; i++)
    await h.run(
      `unbound-${i}`,
      "bash",
      { command: `unzip -p docs/other-${i}.xlsx xl/workbook.xml` },
      body,
    );
  const snapshot = h.monitor.subtaskDiagnosticsSnapshot().adapter;
  expect(snapshot.retainedBytes).toBeGreaterThan(empty.retainedBytes);
  expect(snapshot.retainedBytes).toBeLessThanOrEqual(65536);
  expect(snapshot.omissions).toBeGreaterThan(0);
  expect(h.monitor.subtaskSnapshot().groups).toEqual([]);
  expect(h.proposalNetwork).not.toHaveBeenCalled();
  expect(h.monitor.state.tasks).toHaveLength(1);
  const calls = h.counts();
  h.monitor.confirmCoverageBranch(h.reader());
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.subtaskDiagnosticsSnapshot().adapter).toEqual(snapshot);
  expect(h.counts()).toEqual(calls);
  h.monitor.turnOff();
  expect(h.monitor.subtaskDiagnosticsSnapshot().adapter).toEqual({
    ...empty,
    pendingCount: 0,
    pendingBytes: 0,
  });
});
it("enforces one16-candidate preconfirmation limit shared by metadata and mapped reads", async () => {
  const h = await ready();
  await h.run(
    "foreign",
    "bash",
    { command: "unzip -p docs/foreign.xlsx xl/workbook.xml" },
    '<workbook><sheets><sheet name="One"/></sheets></workbook>',
  );
  await h.run(
    "script-write",
    "write",
    { path: "foreign.sh", content: "script" },
    "written",
  );
  await h.run("script-read", "read", { path: "foreign.sh" }, "script");
  await h.run(
    "foreign-list",
    "bash",
    { command: "bash foreign.sh docs/foreign.xlsx" },
    "One rows 2 nonempty rows 1 file extracted/foreign.txt",
  );
  const calls = h.counts();
  for (let i = 0; i < 20; i++)
    h.monitor.observeCoverageToolStart(
      `pending-${i}`,
      i % 2 ? "read" : "bash",
      i % 2
        ? { path: "extracted/foreign.txt" }
        : { command: `unzip -p docs/pending-${i}.xlsx xl/workbook.xml` },
    );
  const snapshot = h.monitor.subtaskDiagnosticsSnapshot().adapter;
  expect(snapshot.pendingCount).toBe(16);
  expect(snapshot.pendingBytes).toBeGreaterThan(0);
  expect(snapshot.retainedBytes).toBeLessThanOrEqual(65536);
  expect(snapshot.omissions).toBeGreaterThanOrEqual(4);
  expect(h.monitor.subtaskSnapshot().groups).toEqual([]);
  expect(h.counts()).toEqual(calls);
});
it("shows omitted generic subtasks even before any group exists", async () => {
  const h = await ready();
  const snapshot = view(h);
  expect(snapshot.subtasks.groups).toEqual([]);
  snapshot.subtaskDiagnostics.adapter.omissions = 3;
  const board = await createBoard(snapshot, {
    theme,
    screenRows: () => 40,
    isFocused: () => true,
    onClose: () => {},
    requestRender: () => {},
  });
  expect(board.render(120).join("\n")).toContain(
    "3 optional candidates omitted",
  );
  expect(renderWidget(snapshot, true, 120, theme).join("\n")).toMatch(
    /Subtasks incomplete.*3 optional candidates omitted/,
  );
  expect(h.monitor.state.tasks).toHaveLength(1);
  board.dispose();
});
it("projects detached generic reconciliation gaps without changing settlement or correction authority", async () => {
  const h = await mapped();
  const calls = h.counts();
  const tasks = structuredClone(h.monitor.state.tasks);
  const correction = h.monitor.correctionSnapshot();
  const group = h.monitor.subtaskSnapshot().groups[0];
  const snapshot = h.monitor.advisorySettlementSnapshot();
  expect(snapshot).toMatchObject({
    reason: "ready",
    tasks: [{ id: "task:1" }],
    subtasks: [
      {
        parentTaskId: "task:1",
        parentRevision: 1,
        groupId: group.id,
        listRevision: group.listRevision,
        complete: true,
        knownTotal: 22,
        reportedCompleted: 0,
        reportedBlocked: 0,
        pending: 22,
        observedAccess: 22,
        gaps: coverageNames.slice(0, 3),
        omittedChildren: 19,
      },
    ],
  });
  expect(snapshot.tasks).toHaveLength(1);
  expect(snapshot).not.toHaveProperty("coverage");
  if (!snapshot.subtasks) throw new Error("Missing summary");
  snapshot.subtasks[0].gaps[0] = "MUTATED";
  expect(JSON.stringify(h.monitor.advisorySettlementSnapshot())).not.toContain(
    "MUTATED",
  );
  expect(h.monitor.correctionSnapshot()).toEqual(correction);
  expect(h.monitor.state.tasks).toEqual(tasks);
  expect(h.counts()).toEqual(calls);
});
it("renders read-only generic subtasks on the selected parent board", async () => {
  const h = await mapped();
  const calls = h.counts();
  const parents = structuredClone(h.monitor.state.tasks);
  const board = await createBoard(view(h), {
    theme,
    screenRows: () => 50,
    isFocused: () => true,
    onClose: () => {},
    requestRender: () => {},
  });
  const rendered = board.render(120).join("\n");
  expect(rendered).toMatch(/subtasks/i);
  expect(rendered).toContain("22");
  expect(rendered).toContain("Overview");
  expect(h.monitor.state.tasks).toHaveLength(1);
  expect(h.monitor.state.tasks).toEqual(parents);
  expect(h.counts()).toEqual(calls);
  board.dispose();
});
