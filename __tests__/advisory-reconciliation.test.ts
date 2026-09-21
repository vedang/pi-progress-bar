import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Row = {
  id: string;
  label: string;
  status: "not-started" | "in-progress" | "done";
  included: boolean;
  revision: number;
};
type Board = { enabled: boolean; reason: string; tasks: Row[] };
type Request = { runId: number; content: string };
type Controller = {
  runStarted(runId: number): void;
  settled(
    runId: number,
    origin:
      | "independent"
      | "advisory-only"
      | "mixed-external"
      | "external"
      | "uncertain-advisory",
  ): void;
  refresh(): void;
  cancel(): void;
  dispose(): void;
};
const active: Controller[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  for (const c of active.splice(0)) c.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
});
const row = (id = "task:1", label = "Implement parser"): Row => ({
  id,
  label,
  status: "not-started",
  included: true,
  revision: 1,
});
const heading = "The progress board still lists these tasks as unfinished:";
const question =
  "What is the actual status of each task? Please report what is complete, still pending, or blocked, and why. This is a status question, not evidence that any task is complete.";
const message = (rows: Row[]) =>
  `${heading}\n${rows.map((r) => `${r.id} — ${r.label}`).join("\n")}\n\n${question}`;
async function fixture() {
  // Dynamic path keeps the red phase type-checkable before the module exists.
  const path = "../src/advisory/reconciliation.ts";
  const module = await import(path);
  let board: Board = { enabled: true, reason: "ready", tasks: [row()] };
  const emit = vi.fn<(request: Request) => void>();
  const snapshot = vi.fn(() => board);
  const controller: Controller = new module.ReconciliationController({
    snapshot,
    emit,
    clock: {
      now: () => Date.now(),
      setTimeout: (fn: () => void, delay: number) => setTimeout(fn, delay),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) =>
        clearTimeout(timer),
    },
  });
  active.push(controller);
  return {
    controller,
    emit,
    snapshot,
    set: (value: Board) => {
      board = value;
    },
    board: () => board,
  };
}
function begin(h: Awaited<ReturnType<typeof fixture>>, run = 1) {
  h.controller.runStarted(run);
  h.controller.settled(run, "independent");
}

it("sends exact whole unfinished board at +60, not readiness at +20", async () => {
  const h = await fixture();
  h.set({ enabled: true, reason: "active-observation", tasks: [] });
  begin(h);
  await vi.advanceTimersByTimeAsync(20_000);
  const rows = [row(), row("task:2", "Add regression")];
  h.set({
    enabled: true,
    reason: "ready",
    tasks: [
      ...rows,
      { ...row("task:3", "Done"), status: "done" },
      { ...row("task:4", "Archived"), included: false },
    ],
  });
  h.controller.refresh();
  await vi.advanceTimersByTimeAsync(39_999);
  expect(h.emit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.emit).toHaveBeenCalledExactlyOnceWith({
    runId: 1,
    content: message(rows),
  });
  expect(vi.getTimerCount()).toBe(0);
});
it("late readiness at +80 sends immediately without restarting deadline or polling", async () => {
  const h = await fixture();
  h.set({ ...h.board(), reason: "pending-journal" });
  begin(h);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.emit).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(20_000);
  h.set({ ...h.board(), reason: "ready" });
  h.controller.refresh();
  expect(h.emit).toHaveBeenCalledTimes(1);
});
it("same-run reprocessing refreshes rows but preserves original deadline", async () => {
  const h = await fixture();
  begin(h);
  await vi.advanceTimersByTimeAsync(30_000);
  h.set({ ...h.board(), reason: "active-observation" });
  h.controller.refresh();
  await vi.advanceTimersByTimeAsync(10_000);
  h.set({
    enabled: true,
    reason: "ready",
    tasks: [row("task:2", "Updated task")],
  });
  h.controller.refresh();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(h.emit).toHaveBeenCalledExactlyOnceWith({
    runId: 1,
    content: message(h.board().tasks),
  });
});
it("dedupes settlement and refresh; unchanged board is eligible on a fresh run", async () => {
  const h = await fixture();
  begin(h);
  await vi.advanceTimersByTimeAsync(10_000);
  h.controller.settled(1, "independent");
  await vi.advanceTimersByTimeAsync(50_000);
  h.controller.refresh();
  h.controller.settled(1, "independent");
  await vi.advanceTimersByTimeAsync(100_000);
  expect(h.emit).toHaveBeenCalledTimes(1);
  begin(h, 2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.emit).toHaveBeenCalledTimes(2);
});
it.each(["advisory-only", "uncertain-advisory"] as const)(
  "never rearms %s",
  async (origin) => {
    const h = await fixture();
    h.controller.runStarted(1);
    h.controller.settled(1, origin);
    h.controller.refresh();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.emit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);
it.each(["mixed-external", "external"] as const)(
  "arms %s as external work",
  async (origin) => {
    const h = await fixture();
    h.controller.runStarted(1);
    h.controller.settled(1, origin);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.emit).toHaveBeenCalledTimes(1);
  },
);
it.each(["cancel", "dispose", "new-run", "off"])(
  "cancels old opportunity on %s",
  async (event) => {
    const h = await fixture();
    begin(h);
    await vi.advanceTimersByTimeAsync(30_000);
    if (event === "new-run") h.controller.runStarted(2);
    else if (event === "off") {
      h.set({ ...h.board(), enabled: false, reason: "disabled" });
      h.controller.refresh();
    } else if (event === "dispose") h.controller.dispose();
    else h.controller.cancel();
    await vi.advanceTimersByTimeAsync(90_000);
    h.set({ ...h.board(), enabled: true, reason: "ready" });
    h.controller.refresh();
    h.controller.settled(1, "independent");
    expect(h.emit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("ignores missing, stale, and out-of-order run settlement", async () => {
  const h = await fixture();
  h.controller.settled(1, "independent");
  h.controller.runStarted(2);
  h.controller.settled(1, "independent");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.emit).not.toHaveBeenCalled();
});
it("uses fresh board and master state at final timer even without refresh", async () => {
  const h = await fixture();
  begin(h);
  h.set({ ...h.board(), enabled: false });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.emit).not.toHaveBeenCalled();
});
it.each([
  "unresolved",
  "capacity",
  "blocked",
  "canonical-scan",
  "model-wait",
  "retry-timer",
])("never emits against %s authority", async (reason) => {
  const h = await fixture();
  begin(h);
  h.set({ ...h.board(), reason });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.emit).not.toHaveBeenCalled();
});
it("does not send complete or empty board", async () => {
  const h = await fixture();
  h.set({ ...h.board(), tasks: [{ ...row(), status: "done" }] });
  begin(h);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.emit).not.toHaveBeenCalled();
  h.set({ ...h.board(), tasks: [] });
  begin(h, 2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.emit).not.toHaveBeenCalled();
});
it("admits all 20 maximum Unicode rows without truncation", async () => {
  const h = await fixture();
  const rows = Array.from({ length: 20 }, (_, i) =>
    row(`task:${i + 1}`, "😀".repeat(240)),
  );
  h.set({ ...h.board(), tasks: rows });
  begin(h);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.emit).toHaveBeenCalledExactlyOnceWith({
    runId: 1,
    content: message(rows),
  });
  expect(
    Buffer.byteLength(h.emit.mock.calls[0][0].content),
  ).toBeLessThanOrEqual(24_576);
  expect(
    Buffer.byteLength(JSON.stringify(h.emit.mock.calls[0][0].content)) - 2,
  ).toBeLessThanOrEqual(32_768);
});
it.each(["too-many", "long-label", "invalid-id", "raw-bytes", "json-bytes"])(
  "suppresses whole message for %s, never a partial board",
  async (overflow) => {
    const h = await fixture();
    let rows = [row()];
    if (overflow === "too-many")
      rows = Array.from({ length: 21 }, (_, i) => row(`task:${i + 1}`));
    if (overflow === "long-label") rows = [row("task:1", "x".repeat(241))];
    if (overflow === "invalid-id") rows = [row("task:9007199254740992")];
    if (overflow === "raw-bytes") rows = [row("task:1", "😀".repeat(7_000))];
    if (overflow === "json-bytes")
      rows = [row("task:1", "\ud800".repeat(6_000))];
    h.set({ ...h.board(), tasks: rows });
    begin(h);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.emit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("cannot emit twice through a synchronous reentrant callback", async () => {
  const h = await fixture();
  h.emit.mockImplementation(() => {
    h.controller.refresh();
    h.controller.settled(1, "independent");
  });
  begin(h);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.emit).toHaveBeenCalledTimes(1);
});
