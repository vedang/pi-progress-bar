import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from "vitest";
import type { SubtaskDiagnosticsSnapshot } from "../src/core/monitor";
import type { projectSubtaskOmissions } from "../src/core/subtask-omissions";

expectTypeOf<SubtaskDiagnosticsSnapshot["semanticOmissions"]>().toEqualTypeOf<
  ReturnType<typeof projectSubtaskOmissions>
>();

import {
  type SubtaskOmissionSummary,
  subtaskCheckpointStorageStatus,
} from "../src/core/hybrid-checkpoint";
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
async function mapped() {
  const h = subtaskMetadataMonitor();
  running.push(h);
  h.start();
  await h.settle("goal");
  await h.map();
  expect(h.monitor.subtaskSnapshot().groups[0]?.children).toHaveLength(22);
  expect(h.counts().report).toBe(0);
  return h;
}

it("persists one oversized report omission through OFF/reload without a report call or raw body", async () => {
  const h = await mapped();
  const text = `PRIVATE_OVERSIZED_REPORT ${"measured evidence ".repeat(800)}`;
  expect(Buffer.byteLength(text)).toBeGreaterThan(12 * 1024);
  h.append("oversized-report", text);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.counts().report).toBe(0);
  const saved = h.checkpoint();
  expect(saved.monitor?.subtaskOmissions).toEqual({
    entries: [
      {
        identity: expect.stringMatching(/^[0-9a-f]{64}$/),
        reason: "report-oversized",
      },
    ],
    saturated: false,
  });
  expect(JSON.stringify(saved)).not.toContain("PRIVATE_OVERSIZED_REPORT");
  const summary = structuredClone(saved.monitor?.subtaskOmissions);
  for (let i = 0; i < 3; i++) {
    h.observe();
    h.monitor.modelSelected();
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(h.checkpoint().monitor?.subtaskOmissions).toEqual(summary);
  h.monitor.turnOff();
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    h.checkpoint(),
    false,
    h.reader,
  );
  expect(h.checkpoint().monitor?.subtaskOmissions).toEqual(summary);
  expect(h.monitor.subtaskDiagnosticsSnapshot()).toMatchObject({
    semanticOmissions: {
      total: 1,
      byReason: { "report-oversized": 1, coalesced: 0, capacity: 0 },
      saturated: false,
    },
  });
  expect(h.counts().report).toBe(0);
});

it("restores summary-only saturated metadata as passive diagnostics without inventing a group", async () => {
  const h = subtaskMetadataMonitor();
  running.push(h);
  const saved = h.checkpoint();
  if (!saved.monitor) throw new Error("Missing Monitor metadata");
  saved.monitor.enabled = false;
  saved.monitor.subtaskOmissions = { entries: [], saturated: true };
  const before = h.counts();
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  expect(h.checkpoint().monitor?.subtaskOmissions).toEqual({
    entries: [],
    saturated: true,
  });
  expect(h.monitor.subtaskSnapshot().groups).toEqual([]);
  expect(h.monitor.subtaskDiagnosticsSnapshot()).toMatchObject({
    semanticOmissions: { total: 0, saturated: true },
  });
  expect(h.counts()).toEqual(before);
});

// Supplied diagnostic history fixtures; these hashes do not claim provider calls.
const omitted = (
  n: number,
  reason: SubtaskOmissionSummary["entries"][number]["reason"] = "capacity",
) => ({ identity: n.toString(16).padStart(64, "0"), reason });
function summaryFixture(sourceId = () => "session:test") {
  const h = subtaskMetadataMonitor(sourceId);
  running.push(h);
  const base = h.checkpoint();
  if (!base.monitor) throw new Error("Missing metadata");
  base.monitor.enabled = false;
  const withSummary = (summary: SubtaskOmissionSummary) => {
    const candidate = structuredClone(base);
    if (!candidate.monitor) throw new Error("Missing metadata");
    candidate.monitor.subtaskOmissions = structuredClone(summary);
    expect(subtaskCheckpointStorageStatus(candidate)).toBe("supported");
    return candidate;
  };
  return { h, base, withSummary };
}
it.each([false, true])(
  "restores same-source omission union live-first without a sidecar (preserveControls=%s)",
  async (preserveControls) => {
    const { h, withSummary } = summaryFixture();
    await h.monitor.restore(
      "/nonexistent-hybrid-test",
      withSummary({ entries: [omitted(1, "coalesced")], saturated: false }),
      false,
      h.reader,
    );
    await h.monitor.restore(
      "/nonexistent-hybrid-test",
      withSummary({ entries: [omitted(1), omitted(2)], saturated: true }),
      preserveControls,
      h.reader,
    );
    const expected = {
      entries: [omitted(1, "coalesced"), omitted(2)],
      saturated: true,
    };
    expect(h.checkpoint().monitor?.subtaskOmissions).toEqual(expected);
    expect(h.checkpoint().monitor?.subtasks).toBeUndefined();
    expect(h.monitor.subtaskSnapshot().groups).toEqual([]);
    const last = h.save.mock.calls.at(-1)?.[0] as ReturnType<
      typeof h.checkpoint
    >;
    expect(last.monitor?.subtaskOmissions).toEqual(expected);
    expect(last.monitor?.subtasks).toBeUndefined();
    expect(h.counts()).toEqual({
      gate: 0,
      proposal: 0,
      report: 0,
      mandatory: 0,
      extraction: 0,
    });
  },
);
it("retains same-source omission history when an older target has no summary", async () => {
  const { h, base, withSummary } = summaryFixture();
  const summary = { entries: [omitted(1)], saturated: false };
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    withSummary(summary),
    false,
    h.reader,
  );
  await h.monitor.restore("/nonexistent-hybrid-test", base, false, h.reader);
  expect(h.checkpoint().monitor?.subtaskOmissions).toEqual(summary);
});
it("truncates only incoming union tail and makes the durable count explicitly incomplete", async () => {
  const { h, withSummary } = summaryFixture();
  const live = Array.from({ length: 64 }, (_, index) => omitted(index));
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    withSummary({ entries: live, saturated: false }),
    false,
    h.reader,
  );
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    withSummary({ entries: [omitted(64)], saturated: false }),
    false,
    h.reader,
  );
  expect(h.checkpoint().monitor?.subtaskOmissions).toEqual({
    entries: live,
    saturated: true,
  });
  expect(h.monitor.subtaskDiagnosticsSnapshot()).toMatchObject({
    semanticOmissions: { total: 64, saturated: true },
  });
});
it("does not publish an omission union when its restore persistence is vetoed", async () => {
  const { h, withSummary } = summaryFixture();
  const live = { entries: [omitted(1)], saturated: false };
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    withSummary(live),
    false,
    h.reader,
  );
  h.save.mockClear();
  h.save.mockImplementation(() => {
    throw new Error("PRIVATE_OMISSION_RESTORE_VETO");
  });
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    withSummary({ entries: [omitted(2)], saturated: false }),
    false,
    h.reader,
  );
  expect(h.save).toHaveBeenCalled();
  expect(h.monitor.enabled).toBe(false);
  expect(h.checkpoint().monitor?.subtaskOmissions).toEqual(live);
  expect(JSON.stringify(h.monitor.debugSnapshot())).not.toContain(
    "PRIVATE_OMISSION_RESTORE_VETO",
  );
});
it("isolates omission history when the session source changes", async () => {
  let source = "session:test";
  const { h, withSummary } = summaryFixture(() => source);
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    withSummary({ entries: [omitted(1)], saturated: true }),
    false,
    h.reader,
  );
  source = "session:other";
  const target = withSummary({ entries: [omitted(2)], saturated: false });
  target.state.sourceId = source;
  expect(subtaskCheckpointStorageStatus(target)).toBe("supported");
  await h.monitor.restore("/nonexistent-hybrid-test", target, false, () => []);
  expect(h.monitor.state.sourceId).toBe(source);
  expect(h.checkpoint().monitor?.subtaskOmissions).toEqual({
    entries: [omitted(2)],
    saturated: false,
  });
});
it("projects detached omission counts without identities, provider work or host reads", async () => {
  const { h, withSummary } = summaryFixture();
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    withSummary({
      entries: [omitted(1, "coalesced"), omitted(2, "report-oversized")],
      saturated: false,
    }),
    false,
    h.reader,
  );
  const calls = h.counts();
  const saves = h.save.mock.calls.length;
  h.reader.mockImplementation(() => {
    throw new Error("Disposed reader");
  });
  const reads = h.reader.mock.calls.length;
  for (let i = 0; i < 3; i++) {
    const snapshot = h.monitor.subtaskDiagnosticsSnapshot();
    expect(snapshot).toMatchObject({
      semanticOmissions: {
        total: 2,
        byReason: { "report-oversized": 1, coalesced: 1, capacity: 0 },
        saturated: false,
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain(omitted(1).identity);
    const projection = Reflect.get(snapshot, "semanticOmissions") as {
      total: number;
      byReason: Record<string, number>;
    };
    projection.total = 999;
    projection.byReason.capacity = 999;
  }
  expect(h.counts()).toEqual(calls);
  expect(h.save.mock.calls.length).toBe(saves);
  expect(h.reader.mock.calls.length).toBe(reads);
});
it("retains omissions and real wallet history through same-source canonical group reset", async () => {
  const h = await mapped();
  const target = h.checkpoint();
  if (!target.monitor?.subtasks)
    throw new Error("Missing public-ingress groups");
  const wallet = target.monitor.subtasks.journal.dispatches;
  const summary = { entries: [omitted(1)], saturated: false };
  target.monitor.subtaskOmissions = summary;
  target.monitor.enabled = false;
  await h.monitor.restore("/nonexistent-hybrid-test", target, false, h.reader);
  const amended = h.reader().map((entry) =>
    (entry as { id?: string }).id === "goal"
      ? {
          type: "message",
          id: "goal",
          message: {
            role: "user",
            content: "Replace the previous request entirely.",
          },
        }
      : entry,
  );
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    target,
    false,
    () => amended,
  );
  expect(h.monitor.subtaskSnapshot().groups).toEqual([]);
  expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(wallet);
  expect(h.checkpoint().monitor?.subtaskOmissions).toEqual(summary);
});

it("does not publish an older source's summary after a reentrant source-switch restore during save", async () => {
  let source = "session:test";
  const { h, base, withSummary } = summaryFixture(() => source);
  const next = structuredClone(base);
  next.state.sourceId = "session:next";
  let switched: Promise<void> | undefined;
  h.save.mockImplementationOnce(() => {
    source = "session:next";
    switched = h.monitor.restore(
      "/nonexistent-hybrid-test",
      next,
      false,
      () => [],
    );
  });
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    withSummary({ entries: [omitted(1)], saturated: false }),
    false,
    h.reader,
  );
  expect(switched).toBeDefined();
  await switched;
  expect(h.monitor.state.sourceId).toBe("session:next");
  expect(h.monitor.enabled).toBe(false);
  expect(h.checkpoint().monitor?.subtaskOmissions).toBeUndefined();
  expect(h.monitor.subtaskSnapshot().groups).toEqual([]);
});

const largeReport = `PRIVATE_OVERSIZED_REPORT ${"measured evidence ".repeat(800)}`;
const reportSources = (h: ReturnType<typeof subtaskMetadataMonitor>) =>
  h.requests
    .filter((request) =>
      Object.keys(request.questions).some((key) =>
        key.startsWith("subtask:subtask-child:"),
      ),
    )
    .map(
      (request) =>
        (request.state as { report: { source: { entryId: string } } }).report
          .source.entryId,
    );

it("does not count oversized prose when no valid subtask group was admitted", async () => {
  const h = subtaskMetadataMonitor();
  running.push(h);
  h.start();
  await h.settle("goal");
  h.append("oversized-without-group", largeReport);
  await h.settle("oversized-without-group");
  expect(h.monitor.subtaskSnapshot().groups).toEqual([]);
  expect(h.checkpoint().monitor?.subtaskOmissions).toBeUndefined();
  expect(h.counts().report).toBe(0);
});
it("does not publish a vetoed oversize receipt or retry it without a named wake", async () => {
  const h = await mapped();
  let attempts = 0;
  h.save.mockImplementation((raw: unknown) => {
    const candidate = raw as ReturnType<typeof h.checkpoint>;
    if (candidate.monitor?.subtaskOmissions) {
      attempts++;
      throw new Error("PRIVATE_OMISSION_SAVE_VETO");
    }
  });
  h.append("oversized-veto", largeReport);
  await h.settle("oversized-veto");
  expect.soft(attempts).toBeGreaterThan(0);
  expect(h.checkpoint().monitor?.subtaskOmissions).toBeUndefined();
  expect(h.counts().report).toBe(0);
  h.save.mockReset();
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.checkpoint().monitor?.subtaskOmissions).toBeUndefined();
  h.observe();
  await vi.advanceTimersByTimeAsync(200);
  expect(h.checkpoint().monitor?.subtaskOmissions).toMatchObject({
    entries: [{ reason: "report-oversized" }],
    saturated: false,
  });
  expect(h.counts().report).toBe(0);
  expect(JSON.stringify(h.monitor.debugSnapshot())).not.toContain(
    "PRIVATE_OMISSION_SAVE_VETO",
  );
});
it("preserves real parked report A across oversized C and restore, then retries only A after deadline and wake", async () => {
  const h = await mapped();
  const transport = h.fetch.getMockImplementation();
  if (!transport) throw new Error("Missing transport");
  let first = true;
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body)) as {
      questions: Record<string, unknown>;
    };
    const response = await transport(url, init);
    if (
      first &&
      Object.keys(request.questions).some((key) =>
        key.startsWith("subtask:subtask-child:"),
      )
    ) {
      first = false;
      return new Response(null, {
        status: 503,
        headers: { "Retry-After": "10" },
      });
    }
    return response;
  });
  h.append("saved-report-a", "The workbook checks remain pending.");
  await h.settle("saved-report-a");
  expect(reportSources(h)).toEqual(["saved-report-a"]);
  const parked = h
    .checkpoint()
    .monitor?.subtasks?.journal.reports.find(
      (job) => job.source.entryId === "saved-report-a",
    );
  expect(parked).toMatchObject({ state: "parked" });
  if (!parked?.parkedUntil) throw new Error("Missing real retry deadline");
  h.append("oversized-c", largeReport);
  await h.settle("oversized-c");
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    h.checkpoint(),
    false,
    h.reader,
  );
  expect
    .soft(
      h
        .checkpoint()
        .monitor?.subtasks?.journal.reports.find(
          (job) => job.identity === parked.identity,
        ),
    )
    .toEqual(parked);
  expect.soft(h.checkpoint().monitor?.subtaskOmissions).toMatchObject({
    entries: [{ reason: "report-oversized" }],
    saturated: false,
  });
  await vi.advanceTimersByTimeAsync(
    Math.max(0, parked.parkedUntil - Date.now()) + 1,
  );
  expect(reportSources(h)).toEqual(["saved-report-a"]);
  h.observe();
  await vi.advanceTimersByTimeAsync(200);
  expect(reportSources(h)).toEqual([
    "saved-report-a",
    "saved-report-a",
    "saved-report-a",
  ]);
  expect(
    h
      .checkpoint()
      .monitor?.subtasks?.journal.reports.find(
        (job) => job.identity === parked.identity,
      ),
  ).toMatchObject({ state: "complete" });
});
it("keeps eligible B behind held A when newest C is oversized, and retains C's receipt after report commits", async () => {
  const h = await mapped();
  const transport = h.fetch.getMockImplementation();
  if (!transport) throw new Error("Missing transport");
  let release: (() => void) | undefined;
  let held = false;
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body)) as {
      questions: Record<string, unknown>;
    };
    const response = await transport(url, init);
    if (
      !held &&
      Object.keys(request.questions).some((key) =>
        key.startsWith("subtask:subtask-child:"),
      )
    ) {
      held = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return response;
  });
  try {
    h.append("held-a", "The initial workbook checks remain pending.");
    await h.settle("held-a");
    expect(held).toBe(true);
    h.append(
      "eligible-b",
      "A later eligible workbook report still has pending work.",
    );
    await h.settle("eligible-b");
    h.append("oversized-c", largeReport);
    await h.settle("oversized-c");
    expect(reportSources(h)).toEqual(["held-a"]);
    const summary = h.checkpoint().monitor?.subtaskOmissions;
    expect.soft(summary).toMatchObject({
      entries: [{ reason: "report-oversized" }],
      saturated: false,
    });
    release?.();
    await vi.advanceTimersByTimeAsync(300);
    const reports = reportSources(h);
    expect(reports).not.toContain("oversized-c");
    expect(reports.filter((id) => id === "held-a")).toHaveLength(2);
    expect(reports.filter((id) => id === "eligible-b")).toHaveLength(2);
    expect(reports.indexOf("eligible-b")).toBeGreaterThan(
      reports.lastIndexOf("held-a"),
    );
    expect(h.checkpoint().monitor?.subtaskOmissions).toEqual(summary);
    expect(
      h
        .checkpoint()
        .monitor?.subtasks?.journal.reports.find(
          (job) => job.source.entryId === "eligible-b",
        ),
    ).toMatchObject({ state: "complete" });
  } finally {
    h.monitor.stop();
    release?.();
    await vi.advanceTimersByTimeAsync(100);
  }
});
it("saturates retained omissions once without disabling later valid report admission", async () => {
  const h = await mapped();
  const target = h.checkpoint();
  if (!target.monitor) throw new Error("Missing metadata");
  const entries = Array.from({ length: 64 }, (_, index) => omitted(index));
  target.monitor.subtaskOmissions = { entries, saturated: false };
  await h.monitor.restore("/nonexistent-hybrid-test", target, false, h.reader);
  await vi.advanceTimersByTimeAsync(200);
  h.append("overflow-omission", largeReport);
  await h.settle("overflow-omission");
  await vi.advanceTimersByTimeAsync(200);
  expect
    .soft(h.checkpoint().monitor?.subtaskOmissions)
    .toEqual({ entries, saturated: true });
  h.save.mockClear();
  for (let i = 0; i < 3; i++) {
    h.observe();
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(h.save).not.toHaveBeenCalled();
  const before = h.counts().report;
  h.append(
    "eligible-after-saturation",
    "A short eligible report confirms more checks remain pending.",
  );
  await h.settle("eligible-after-saturation");
  expect(h.counts().report).toBe(before + 2);
  expect(h.checkpoint().monitor?.subtaskOmissions).toEqual({
    entries,
    saturated: true,
  });
  expect(h.monitor.subtaskDiagnosticsSnapshot().exhausted).toBe(false);
});
