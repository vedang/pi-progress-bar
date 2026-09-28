import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { encodeCheckpoint } from "../src/core/hybrid-checkpoint";
import { createBoard } from "../src/ui/board";
import { renderWidget } from "../src/ui/widget";
import { coverageNames } from "./fixtures/coverage";
import { branchEntry, monitorHarness } from "./fixtures/hybrid-monitor";

const text = "Review every tab in docs/plan.xlsx and summarize the workbook.";
const command = "unzip -p docs/plan.xlsx xl/workbook.xml";
const xml = `<workbook><sheets>${coverageNames.map((name) => `<sheet name="${name}"/>`).join("")}</sheets></workbook>`;
const running: ReturnType<typeof monitorHarness>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline");
});
afterEach(() => {
  for (const h of running.splice(0)) h.monitor.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
function fixture() {
  const h = monitorHarness([branchEntry("goal", text)], {
    extractionText: (input) =>
      input.instructions.includes("parentIndices")
        ? JSON.stringify({
            intents: [
              {
                parentIndices: [0],
                quote: text,
                resource: "docs/plan.xlsx",
                kind: "unconditional-enumerable",
              },
            ],
          })
        : JSON.stringify({
            add: [
              {
                label: "Summarize workbook",
                kind: "response",
                basis: "explicit",
                quote: text,
              },
            ],
            revise: [],
            archive: [],
            restore: [],
            unresolved: false,
          }),
  });
  running.push(h);
  async function run(
    id: string,
    toolName: string,
    args: Record<string, unknown>,
    body: string,
    error = false,
  ) {
    h.monitor.observeCoverageToolStart(id, toolName, args);
    h.monitor.observeCoverageToolEnd(id, toolName);
    h.replace([
      ...h.reader(),
      {
        type: "message",
        id: `result-${id}`,
        message: {
          role: "toolResult",
          toolCallId: id,
          toolName,
          content: [{ type: "text", text: body }],
          isError: error,
        },
      },
    ]);
    h.monitor.confirmCoverageBranch(h.reader());
    await vi.advanceTimersByTimeAsync(100);
  }
  return { ...h, run };
}
async function ready() {
  const h = fixture();
  h.start();
  await h.settle("goal");
  await vi.advanceTimersByTimeAsync(200);
  return h;
}
async function mapped() {
  const h = await ready();
  await h.run("manifest", "bash", { command }, xml);
  await h.run(
    "write",
    "write",
    { path: "export.sh", content: "script" },
    "written",
  );
  await h.run("read", "read", { path: "export.sh" }, "script");
  await h.run(
    "listing",
    "bash",
    { command: "bash export.sh docs/plan.xlsx" },
    coverageNames
      .map(
        (name, i) =>
          `${name} rows 2 nonempty rows 1 file extracted/tab-${i}.txt`,
      )
      .join("\n"),
  );
  return h;
}
it("does not dispatch optional extraction when its pre-network budget checkpoint fails", async () => {
  const h = fixture();
  let optionalNetworkCalls = 0;
  const extract = h.extract.getMockImplementation();
  if (!extract) throw new Error("Missing transport");
  h.extract.mockImplementation(async (input, signal, onDispatch) => {
    if (!input.instructions.includes("parentIndices"))
      return extract(input, signal, onDispatch);
    onDispatch?.(Date.now());
    if (signal.aborted) throw new Error("cancelled");
    optionalNetworkCalls++;
    return {
      text: '{"intents":[]}',
      provider: "offline",
      model: "fixture",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  h.save.mockImplementation((value) => {
    const checkpoint = value as ReturnType<typeof encodeCheckpoint>;
    if ((checkpoint.monitor?.coverage?.dispatches ?? 0) > 0)
      throw new Error("budget write denied");
  });
  h.start();
  await h.settle("goal");
  await vi.advanceTimersByTimeAsync(200);
  expect(optionalNetworkCalls).toBe(0);
  expect(h.monitor.state.tasks).toHaveLength(1);
  expect(h.monitor.state.cursor?.id).toBe("goal");
});
it("creates22pending children under1parent without changing parent health or billing on tools", async () => {
  const h = await ready();
  const tasks = structuredClone(h.monitor.state.tasks);
  const health = structuredClone(h.monitor.boardSnapshot().tasks[0].health);
  const fetchCalls = h.fetch.mock.calls.length;
  const extractionCalls = h.extract.mock.calls.length;
  await h.run("manifest", "bash", { command }, xml);
  const group = h.monitor.coverageSnapshot().groups[0];
  expect(group.children.map((child) => child.label)).toEqual(coverageNames);
  expect(group.children.every((child) => child.status === "pending")).toBe(
    true,
  );
  expect(h.monitor.state.tasks).toEqual(tasks);
  expect(h.monitor.boardSnapshot().tasks[0].health).toEqual(health);
  expect(h.fetch.mock.calls.length).toBe(fetchCalls);
  expect(h.extract.mock.calls.length).toBe(extractionCalls);
  expect(
    (h.monitor.checkpoint() as ReturnType<typeof encodeCheckpoint>).monitor
      ?.coverage?.state.groups,
  ).toHaveLength(1);
});
it("keeps preappend results provisional and never displays durable coverage before storage succeeds", async () => {
  const h = await ready();
  h.monitor.observeCoverageToolStart("manifest", "bash", { command });
  h.monitor.observeCoverageToolEnd("manifest", "bash");
  h.monitor.confirmCoverageBranch(h.reader());
  expect(h.monitor.coverageSnapshot().groups).toEqual([]);
  h.save.mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  const before = structuredClone(h.monitor.state.tasks);
  await h.run("manifest", "bash", { command }, xml);
  expect(h.monitor.coverageSnapshot().groups).toEqual([]);
  expect(h.monitor.state.tasks).toEqual(before);
});
it("retains inventory captured while chronological semantics has not yet created its parent", async () => {
  const h = fixture();
  h.start();
  await h.run("manifest", "bash", { command }, xml);
  await h.settle("goal");
  await vi.advanceTimersByTimeAsync(200);
  h.monitor.confirmCoverageBranch(h.reader());
  expect(h.monitor.coverageSnapshot().groups[0]?.children).toHaveLength(22);
});
it("shows immediate exact item/batch access with no network calls and no reviewed statuses", async () => {
  const h = await mapped();
  const calls = [h.fetch.mock.calls.length, h.extract.mock.calls.length];
  const group = h.monitor.coverageSnapshot().groups[0];
  expect(group.children.every((child) => child.status === "pending")).toBe(
    true,
  );
  h.monitor.observeCoverageToolStart("a", "bash", {
    command: "cat extracted/tab-0.txt",
  });
  h.monitor.observeCoverageToolStart("b", "bash", {
    command: "cat extracted/tab-1.txt extracted/tab-2.txt",
  });
  expect(h.monitor.coverageSnapshot().current).toHaveLength(2);
  expect(h.monitor.coverageSnapshot().current[0].childIds).toEqual([
    group.children[0].id,
  ]);
  h.monitor.observeCoverageToolEnd("unmatched", "bash");
  expect(h.monitor.coverageSnapshot().current).toHaveLength(2);
  h.monitor.observeCoverageToolEnd("a", "bash");
  expect(h.monitor.coverageSnapshot().current).toHaveLength(1);
  h.monitor.observeCoverageToolEnd("b", "bash");
  expect(h.monitor.coverageSnapshot().current).toEqual([]);
  expect([h.fetch.mock.calls.length, h.extract.mock.calls.length]).toEqual(
    calls,
  );
});
it("OFF and reload clear runtime focus but preserve exact durable access without rebilling", async () => {
  const h = await mapped();
  h.monitor.observeCoverageToolStart("active", "bash", {
    command: "cat extracted/tab-0.txt",
  });
  expect(h.monitor.coverageSnapshot().current).toHaveLength(1);
  h.monitor.turnOff();
  expect(h.monitor.coverageSnapshot().current).toEqual([]);
  const saved = h.monitor.checkpoint();
  const calls = [h.fetch.mock.calls.length, h.extract.mock.calls.length];
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  expect(h.monitor.coverageSnapshot().groups[0].children[0].accessed).toBe(
    true,
  );
  expect(h.monitor.coverageSnapshot().current).toEqual([]);
  expect([h.fetch.mock.calls.length, h.extract.mock.calls.length]).toEqual(
    calls,
  );
});
it("canonical inventory amendment drops coverage without modifying parent or rebilling", async () => {
  const h = await mapped();
  const tasks = structuredClone(h.monitor.state.tasks);
  const calls = [h.fetch.mock.calls.length, h.extract.mock.calls.length];
  h.replace(
    h
      .reader()
      .filter((entry) => (entry as { id?: string }).id !== "result-manifest"),
  );
  h.monitor.confirmCoverageBranch(h.reader());
  expect(h.monitor.coverageSnapshot().groups).toEqual([]);
  expect(h.monitor.state.tasks).toEqual(tasks);
  expect([h.fetch.mock.calls.length, h.extract.mock.calls.length]).toEqual(
    calls,
  );
});
it("bounds pending projected bytes across repeated unbound inventories and reports omissions", async () => {
  const h = await ready();
  const names = Array.from({ length: 52 }, (_, i) => `${i}-${"x".repeat(200)}`);
  const body = `<workbook><sheets>${names.map((name) => `<sheet name="${name}"/>`).join("")}</sheets></workbook>`;
  for (let i = 0; i < 8; i++)
    await h.run(
      `unbound-${i}`,
      "bash",
      { command: "unzip -p docs/other.xlsx xl/workbook.xml" },
      body,
    );
  const snapshot = h.monitor.coverageSnapshot();
  expect(snapshot.pendingBytes).toBeLessThanOrEqual(65536);
  expect(snapshot.pendingCount).toBeGreaterThan(0);
  expect(snapshot.omissions).toBeGreaterThan(0);
  expect(snapshot.groups).toEqual([]);
  expect(h.monitor.state.tasks).toHaveLength(1);
  const before = h.monitor.coverageSnapshot();
  h.monitor.confirmCoverageBranch(h.reader());
  expect(h.monitor.coverageSnapshot()).toEqual(before);
  h.monitor.turnOff();
  expect(h.monitor.coverageSnapshot().pendingCount).toBe(0);
  expect(h.monitor.coverageSnapshot().pendingBytes).toBe(0);
});
it("enforces one16-candidate limit shared by pending inventories and access", async () => {
  const h = await ready();
  await h.run(
    "script-write",
    "write",
    { path: "foreign.sh", content: "script" },
    "written",
  );
  await h.run("script-read", "read", { path: "foreign.sh" }, "script");
  for (let i = 0; i < 10; i++) {
    await h.run(
      `foreign-manifest-${i}`,
      "bash",
      { command: `unzip -p docs/foreign-${i}.xlsx xl/workbook.xml` },
      '<workbook><sheets><sheet name="One"/></sheets></workbook>',
    );
    await h.run(
      `foreign-list-${i}`,
      "bash",
      { command: `bash foreign.sh docs/foreign-${i}.xlsx` },
      `One rows 2 nonempty rows 1 file extracted/foreign-${i}.txt`,
    );
  }
  expect(h.monitor.coverageSnapshot().pendingCount).toBeLessThanOrEqual(16);
  expect(h.monitor.coverageSnapshot().omissions).toBeGreaterThan(0);
  expect(h.monitor.coverageSnapshot().groups).toEqual([]);
});
it("shows omitted generic subtasks even before any group exists", async () => {
  const h = await ready();
  const snapshot = {
    presentation: h.monitor.presentationSnapshot(),
    board: h.monitor.boardSnapshot(),
    subtasks: { ...h.monitor.subtaskSnapshot(), groups: [] },
    subtaskAccess: h.monitor.subtaskAccessSnapshot(),
    subtaskDiagnostics: {
      ...h.monitor.subtaskDiagnosticsSnapshot(),
      adapter: {
        ...h.monitor.subtaskDiagnosticsSnapshot().adapter,
        omissions: 3,
      },
    },
  };
  const theme = {
    fg: (_: string, t: string) => t,
    bg: (_: string, t: string) => t,
    bold: (t: string) => t,
  } as Theme;
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
});
it("projects detached bounded reconciliation gaps without changing settlement or correction authority", async () => {
  const h = await mapped();
  const calls = [h.fetch.mock.calls.length, h.extract.mock.calls.length];
  const tasks = structuredClone(h.monitor.state.tasks);
  const correction = h.monitor.correctionSnapshot();
  // The attested worksheet listing records observed access, not review.
  expect(
    h.monitor
      .coverageSnapshot()
      .groups[0].children.filter((child) => child.accessed),
  ).toHaveLength(22);
  const snapshot = h.monitor.advisorySettlementSnapshot();
  expect(snapshot).toMatchObject({
    reason: "ready",
    tasks: [{ id: "task:1" }],
    coverage: [
      {
        parentTaskId: "task:1",
        parentRevision: 1,
        complete: true,
        knownTotal: 22,
        reviewed: 0,
        blocked: 0,
        pending: 22,
        accessed: 22,
        gaps: coverageNames.slice(0, 3),
        omittedChildren: 19,
      },
    ],
  });
  expect(snapshot.tasks).toHaveLength(1);
  const coverage = Reflect.get(snapshot, "coverage") as
    | Array<{ gaps: string[] }>
    | undefined;
  if (!coverage) throw new Error("Missing coverage summary");
  coverage[0].gaps[0] = "MUTATED";
  expect(JSON.stringify(h.monitor.advisorySettlementSnapshot())).not.toContain(
    "MUTATED",
  );
  expect(h.monitor.correctionSnapshot()).toEqual(correction);
  expect(h.monitor.state.tasks).toEqual(tasks);
  expect([h.fetch.mock.calls.length, h.extract.mock.calls.length]).toEqual(
    calls,
  );
});
it("renders minimal read-only coverage on the selected parent board", async () => {
  const h = await mapped();
  const snapshot = {
    presentation: h.monitor.presentationSnapshot(),
    board: h.monitor.boardSnapshot(),
    visibility: h.monitor.visibilitySnapshot(),
    coverage: h.monitor.coverageSnapshot(),
  };
  const theme = {
    fg: (_: string, t: string) => t,
    bg: (_: string, t: string) => t,
    bold: (t: string) => t,
  } as Theme;
  const board = await createBoard(snapshot, {
    theme,
    screenRows: () => 50,
    isFocused: () => true,
    onClose: () => {},
    requestRender: () => {},
  });
  const rendered = board.render(120).join("\n");
  expect(rendered).toMatch(/coverage/i);
  expect(rendered).toContain("22");
  expect(rendered).toContain("Overview");
});
