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

async function chargedFixture(sourceId = () => "session:test") {
  const h = subtaskMetadataMonitor(sourceId);
  running.push(h);
  h.start();
  await h.settle("goal");
  await h.map();
  expect(h.monitor.subtaskSnapshot().groups[0]?.children).toHaveLength(22);
  const older = h.checkpoint();
  const beforeReport = h.counts();
  const olderBranch = structuredClone(h.reader());
  h.append(
    "wallet-report",
    "I reviewed the workbook; the remaining checks are still pending.",
  );
  await h.settle("wallet-report");
  expect(h.counts()).toMatchObject({
    report: 2,
    gate: beforeReport.gate + 1,
    proposal: beforeReport.proposal,
  });
  const charged = h.checkpoint().monitor?.subtasks?.journal;
  if (!charged || !older.monitor?.subtasks)
    throw new Error("Missing public-ingress journal");
  expect(charged.dispatches).toBe(
    older.monitor.subtasks.journal.dispatches + 3,
  );
  expect(charged.usage.jev.calls + charged.usage.extraction.calls).toBe(
    charged.dispatches,
  );
  return { h, older, olderBranch, charged, calls: h.counts() };
}

it.each([
  { enabled: false, preserveControls: false },
  { enabled: true, preserveControls: false },
  { enabled: false, preserveControls: true },
  { enabled: true, preserveControls: true },
])(
  "preserves real charges on older same-source restore (enabled=$enabled preserveControls=$preserveControls)",
  async ({ enabled, preserveControls }) => {
    const { h, older, olderBranch, charged, calls } = await chargedFixture();
    if (!older.monitor?.subtasks)
      throw new Error("Missing checkpoint metadata");
    if (!enabled && preserveControls) h.monitor.turnOff();
    older.monitor.enabled = preserveControls ? !enabled : enabled;
    await h.monitor.restore(
      "/nonexistent-hybrid-test",
      older,
      preserveControls,
      () => olderBranch,
    );
    // Lifecycle completion does not await optional transport settlement.
    if (enabled) await vi.advanceTimersByTimeAsync(100);
    const restored = h.checkpoint().monitor?.subtasks?.journal;
    expect(restored?.dispatches).toBe(charged.dispatches + Number(enabled));
    if (!restored) throw new Error("Missing restored journal");
    expect(restored.records.map((record) => record.identity)).toEqual(
      expect.arrayContaining(charged.records.map((record) => record.identity)),
    );
    expect(restored.reports.map((job) => job.identity)).toEqual(
      expect.arrayContaining(charged.reports.map((job) => job.identity)),
    );
    expect(restored.usage.extraction).toEqual(charged.usage.extraction);
    if (!enabled) {
      expect(restored.usage).toEqual(charged.usage);
      expect(h.counts()).toEqual(calls);
      return;
    }
    // Restore drops ephemeral metadata: goal + current group + no metadata is a
    // genuinely new gate context, not permission to replay an old paid identity.
    const prior = new Set(charged.records.map((record) => record.identity));
    const fresh = restored.records.filter(
      (record) => !prior.has(record.identity),
    );
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({
      source: { entryId: "goal" },
      listRevision: older.monitor.subtasks.state.groups[0].listRevision,
      gate: { dispatch: charged.dispatches + 1, choice: "no" },
    });
    const admission = charged.records.find(
      (record) => record.gate?.choice === "yes",
    );
    expect(admission).toBeDefined();
    expect(fresh[0].triggerHash).not.toBe(admission?.triggerHash);
    expect(charged.records.map((record) => record.contextHash)).not.toContain(
      fresh[0].contextHash,
    );
    expect(restored.usage.jev.calls).toBe(charged.usage.jev.calls + 1);
    expect(restored.usage.jev.inputTokens).toBeGreaterThanOrEqual(
      charged.usage.jev.inputTokens,
    );
    expect(restored.usage.jev.outputTokens).toBeGreaterThanOrEqual(
      charged.usage.jev.outputTokens,
    );
    expect(h.counts()).toEqual({ ...calls, gate: calls.gate + 1 });
    const afterRestore = h.counts();
    for (let i = 0; i < 3; i++) {
      h.monitor.observe(() => olderBranch);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(h.counts()).toEqual(afterRestore);
    expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(
      restored.dispatches,
    );
  },
);

it.each(["stop", "restore"])(
  "retains a newly persisted real wallet across reentrant %s without adopting stale queue authority",
  async (mode) => {
    const donor = await chargedFixture();
    donor.h.monitor.turnOff();
    const incoming = donor.h.checkpoint();
    const older = structuredClone(donor.older);
    if (!older.monitor) throw new Error("Missing metadata");
    older.monitor.enabled = false;
    const branch = structuredClone(donor.h.reader());
    const h = subtaskMetadataMonitor();
    running.push(h);
    await h.monitor.restore(
      "/nonexistent-hybrid-test",
      older,
      false,
      () => branch,
    );
    expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(
      older.monitor.subtasks?.journal.dispatches,
    );
    const calls = h.counts();
    let nested: Promise<void> | undefined;
    let interrupted = false;
    h.save.mockImplementationOnce(() => {
      interrupted = true;
      if (mode === "stop") h.monitor.stop();
      else
        nested = h.monitor.restore(
          "/nonexistent-hybrid-test",
          older,
          false,
          () => branch,
        );
    });
    await h.monitor.restore(
      "/nonexistent-hybrid-test",
      incoming,
      false,
      () => branch,
    );
    await nested;
    expect(interrupted).toBe(true);
    expect
      .soft(h.checkpoint().monitor?.subtasks?.journal.dispatches)
      .toBe(donor.charged.dispatches);
    await h.monitor.restore(
      "/nonexistent-hybrid-test",
      older,
      false,
      () => branch,
    );
    const durable = h.save.mock.calls.at(-1)?.[0] as typeof incoming;
    const restored = h.checkpoint().monitor?.subtasks?.journal;
    expect
      .soft(durable.monitor?.subtasks?.journal.dispatches)
      .toBe(donor.charged.dispatches);
    expect(restored?.dispatches).toBe(donor.charged.dispatches);
    expect(restored?.usage).toEqual(donor.charged.usage);
    expect(restored?.records.map((record) => record.identity)).toEqual(
      expect.arrayContaining(
        donor.charged.records.map((record) => record.identity),
      ),
    );
    expect(restored?.reports.map((job) => job.identity)).toEqual(
      expect.arrayContaining(donor.charged.reports.map((job) => job.identity)),
    );
    expect(h.monitor.enabled).toBe(false);
    expect(h.counts()).toEqual(calls);
  },
);

it.each(["stop", "nested-save-failure"])(
  "adopts saved wallet before plain ON after reentrant %s and preserves new charges through OFF/reload",
  async (mode) => {
    const donor = await chargedFixture();
    donor.h.monitor.turnOff();
    const incoming = donor.h.checkpoint();
    const older = structuredClone(donor.older);
    if (!older.monitor) throw new Error("Missing metadata");
    older.monitor.enabled = false;
    const h = subtaskMetadataMonitor();
    running.push(h);
    h.replace(structuredClone(donor.h.reader()));
    await h.monitor.restore("/nonexistent-hybrid-test", older, false, h.reader);
    let nested: Promise<void> | undefined;
    h.save.mockImplementationOnce(() => {
      if (mode === "stop") h.monitor.stop();
      else {
        h.save.mockImplementationOnce(() => {
          throw new Error("Nested restore save refused");
        });
        nested = h.monitor.restore(
          "/nonexistent-hybrid-test",
          older,
          false,
          h.reader,
        );
      }
    });
    await h.monitor.restore(
      "/nonexistent-hybrid-test",
      incoming,
      false,
      h.reader,
    );
    await nested;
    expect(h.monitor.enabled).toBe(false);
    expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(
      donor.charged.dispatches,
    );
    h.save.mockReset();
    h.monitor.turnOn("/nonexistent-hybrid-test");
    await h.settle("wallet-report");
    await vi.advanceTimersByTimeAsync(200);
    expect.soft(h.counts().report).toBe(0); // The donor already paid for this exact source/roster.
    h.append("new-paid-report", "Further workbook checks are still pending.");
    await h.settle("new-paid-report");
    await vi.advanceTimersByTimeAsync(200);
    const calls = h.counts();
    expect.soft(calls.report).toBe(2);
    const expectedDispatches =
      donor.charged.dispatches + calls.gate + calls.report + calls.proposal;
    const beforeOff = h.checkpoint().monitor?.subtasks?.journal;
    expect.soft(beforeOff?.dispatches).toBe(expectedDispatches);
    h.monitor.turnOff();
    const durable = h.save.mock.calls.at(-1)?.[0] as typeof incoming;
    const journal = durable.monitor?.subtasks?.journal;
    expect.soft(journal?.dispatches).toBe(expectedDispatches);
    expect
      .soft(journal?.reports.map((job) => job.identity))
      .toEqual(
        expect.arrayContaining(
          donor.charged.reports.map((job) => job.identity),
        ),
      );
    expect
      .soft(
        journal?.reports.some(
          (job) =>
            job.source.entryId === "new-paid-report" &&
            job.state === "complete",
        ),
      )
      .toBe(true);
    expect
      .soft(journal?.usage.jev.calls)
      .toBe(donor.charged.usage.jev.calls + calls.gate + calls.report);
    await h.monitor.restore(
      "/nonexistent-hybrid-test",
      durable,
      false,
      h.reader,
    );
    h.monitor.turnOn("/nonexistent-hybrid-test");
    await vi.advanceTimersByTimeAsync(200);
    expect(h.counts()).toEqual(calls);
    expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(
      expectedDispatches,
    );
  },
);

it("does not let an outer staged wallet override newer nested history during a second nested restore", async () => {
  const donor = await chargedFixture();
  const incoming = donor.h.checkpoint();
  donor.h.append(
    "later-wallet-report",
    "The additional workbook checks remain pending.",
  );
  await donor.h.settle("later-wallet-report");
  donor.h.monitor.turnOff();
  const newest = donor.h.checkpoint();
  const latest = newest.monitor?.subtasks?.journal;
  if (!latest || !incoming.monitor || !donor.older.monitor)
    throw new Error("Missing real history");
  expect(latest.dispatches).toBeGreaterThan(donor.charged.dispatches);
  incoming.monitor.enabled = false;
  donor.older.monitor.enabled = false;
  const branch = structuredClone(donor.h.reader());
  const h = subtaskMetadataMonitor();
  running.push(h);
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    donor.older,
    false,
    () => branch,
  );
  const calls = h.counts();
  const nested: Promise<void>[] = [];
  h.save.mockImplementationOnce(() => {
    nested.push(
      h.monitor.restore(
        "/nonexistent-hybrid-test",
        newest,
        false,
        () => branch,
      ),
    );
    nested.push(
      h.monitor.restore(
        "/nonexistent-hybrid-test",
        donor.older,
        false,
        () => branch,
      ),
    );
  });
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    incoming,
    false,
    () => branch,
  );
  await Promise.all(nested);
  expect(nested).toHaveLength(2);
  const durable = h.save.mock.calls.at(-1)?.[0] as typeof incoming;
  expect
    .soft(durable.monitor?.subtasks?.journal.dispatches)
    .toBe(latest.dispatches);
  expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(
    latest.dispatches,
  );
  expect(h.checkpoint().monitor?.subtasks?.journal.usage).toEqual(latest.usage);
  expect(h.monitor.enabled).toBe(false);
  expect(h.counts()).toEqual(calls);
});

it("refuses a thrown restore save without adopting target history or dispatching", async () => {
  const { h, older, olderBranch, charged, calls } = await chargedFixture();
  if (!older.monitor) throw new Error("Missing metadata");
  older.monitor.enabled = false;
  const state = structuredClone(h.monitor.state);
  const telemetry = h.checkpoint().monitor;
  h.save.mockClear();
  h.save.mockImplementation(() => {
    throw new Error("PRIVATE_RESTORE_WRITE_FAILURE");
  });
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    older,
    false,
    () => olderBranch,
  );
  expect(h.save).toHaveBeenCalled();
  expect(h.monitor.enabled).toBe(false);
  expect(h.checkpoint().monitor?.subtasks?.journal).toEqual(charged);
  expect(h.monitor.state).toEqual(state);
  const retained = h.checkpoint().monitor;
  expect(retained?.usage).toEqual(telemetry?.usage);
  expect(retained?.lastJevCallAt).toEqual(telemetry?.lastJevCallAt);
  expect(retained?.lastExtractionCallAt).toEqual(
    telemetry?.lastExtractionCallAt,
  );
  expect(h.counts()).toEqual(calls);
  expect(JSON.stringify(h.monitor.debugSnapshot())).not.toContain(
    "PRIVATE_RESTORE_WRITE_FAILURE",
  );
});

it("refuses individually valid but incomparable supplied accounting without overwriting live history", async () => {
  const { h, older, olderBranch, charged, calls } = await chargedFixture();
  if (!older.monitor?.subtasks) throw new Error("Missing metadata");
  older.monitor.enabled = false;
  // Adversarial supplied checkpoint, not a claim these calls occurred in this fixture.
  older.monitor.subtasks.journal.dispatches++;
  older.monitor.subtasks.journal.usage.extraction.calls++;
  expect(subtaskCheckpointStorageStatus(older)).toBe("supported");
  h.save.mockClear();
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    older,
    false,
    () => olderBranch,
  );
  expect(h.monitor.enabled).toBe(false);
  expect(h.checkpoint().monitor?.subtasks?.journal).toEqual(charged);
  expect(h.save).not.toHaveBeenCalled();
  expect(h.counts()).toEqual(calls);
  expect(h.monitor.subtaskDiagnosticsSnapshot().exhausted).toBe(false);
});

it("does not carry another source's wallet, identities, or allocator floors", async () => {
  let sourceId = "session:test";
  const { h, older, calls } = await chargedFixture(() => sourceId);
  if (!older.monitor) throw new Error("Missing metadata");
  older.monitor.enabled = false;
  sourceId = "session:another";
  await h.monitor.restore("/nonexistent-hybrid-test", older, false, () => []);
  expect(h.monitor.state.sourceId).toBe(sourceId);
  const component = h.checkpoint().monitor?.subtasks;
  expect(component?.journal.dispatches ?? 0).toBe(0);
  expect(component?.journal.records ?? []).toEqual([]);
  expect(component?.journal.reports ?? []).toEqual([]);
  expect(h.monitor.subtaskSnapshot().groups).toEqual([]);
  expect(component?.state.nextGroupId ?? 1).toBe(1);
  expect(component?.state.nextChildId ?? 1).toBe(1);
  expect(h.counts()).toEqual(calls);
});

it("preserves charges and allocator floors when canonical reset removes stale semantic groups", async () => {
  const { h, older, olderBranch, charged, calls } = await chargedFixture();
  if (!older.monitor?.subtasks) throw new Error("Missing metadata");
  older.monitor.enabled = false;
  const allocator = older.monitor.subtasks.state;
  const amended = olderBranch.map((entry) =>
    (entry as { id?: string }).id === "goal"
      ? {
          type: "message",
          id: "goal",
          message: {
            role: "user",
            content:
              "Different request invalidates the earlier canonical source.",
          },
        }
      : entry,
  );
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    older,
    false,
    () => amended,
  );
  const component = h.checkpoint().monitor?.subtasks;
  expect(component?.journal.dispatches).toBe(charged.dispatches);
  expect(component?.journal.usage).toEqual(charged.usage);
  expect(component?.journal.records.map((record) => record.identity)).toEqual(
    expect.arrayContaining(charged.records.map((record) => record.identity)),
  );
  expect(component?.state.nextGroupId).toBe(allocator.nextGroupId);
  expect(component?.state.nextChildId).toBe(allocator.nextChildId);
  expect(h.monitor.subtaskSnapshot().groups).toEqual([]);
  expect(h.counts()).toEqual(calls);
});

it("uses committed history as the floor through repeated restores while old transport ignores abort", async () => {
  const { h, older, olderBranch, charged } = await chargedFixture();
  if (!older.monitor) throw new Error("Missing metadata");
  const transport = h.fetch.getMockImplementation();
  if (!transport) throw new Error("Missing fixture transport");
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
  let floor = charged.dispatches;
  let calls = h.counts();
  try {
    h.append(
      "held-report",
      "Additional workbook checks remain pending; no new completion is claimed.",
    );
    await h.settle("held-report");
    expect(held).toBe(true);
    const inFlight = h.checkpoint().monitor?.subtasks?.journal;
    if (!inFlight) throw new Error("Missing dispatched journal");
    floor = inFlight.dispatches;
    expect(floor).toBeGreaterThan(charged.dispatches);
    expect(
      inFlight.reports.some((job) =>
        job.attempts.some((attempt) => attempt.outcome === "dispatched"),
      ),
    ).toBe(true);
    calls = h.counts();
    older.monitor.enabled = false;
    for (let i = 0; i < 2; i++) {
      await h.monitor.restore(
        "/nonexistent-hybrid-test",
        older,
        false,
        () => olderBranch,
      );
      expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(floor);
      expect(h.counts()).toEqual(calls);
    }
  } finally {
    release?.();
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(h.checkpoint().monitor?.subtasks?.journal.dispatches).toBe(floor);
  expect(h.counts()).toEqual(calls);
  expect(
    h.monitor
      .subtaskSnapshot()
      .groups[0]?.children.every((child) => child.status === "pending"),
  ).toBe(true);
});

it("persists the same preserved mandatory telemetry that OFF restore adopts", async () => {
  const { h, older, olderBranch } = await chargedFixture();
  if (!older.monitor) throw new Error("Missing older metadata");
  h.monitor.turnOff();
  const before = h.checkpoint().monitor;
  if (!before) throw new Error("Missing live metadata");
  expect(
    before.usage.jev.calls + before.usage.extraction.calls,
  ).toBeGreaterThan(
    older.monitor.usage.jev.calls + older.monitor.usage.extraction.calls,
  );
  older.monitor.enabled = true; // preserveControls must keep live OFF.
  h.save.mockClear();
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    older,
    true,
    () => olderBranch,
  );
  expect(h.monitor.enabled).toBe(false);
  expect(h.save).toHaveBeenCalled();
  const saved = h.save.mock.calls.at(-1)?.[0] as ReturnType<
    typeof h.checkpoint
  >;
  const adopted = h.checkpoint().monitor;
  expect(adopted?.usage).toEqual(before.usage);
  expect(saved.monitor?.usage).toEqual(adopted?.usage);
  expect(saved.monitor?.lastJevCallAt).toEqual(adopted?.lastJevCallAt);
  expect(saved.monitor?.lastExtractionCallAt).toEqual(
    adopted?.lastExtractionCallAt,
  );
});

it("normalizes stale optional health facts before saving a disabled history restore", async () => {
  const { h } = await chargedFixture();
  const target = h.checkpoint();
  if (!target.monitor?.subtasks) throw new Error("Missing generic history");
  const card = target.monitor.healthCards?.[0];
  expect(card).toBeDefined();
  if (!card) throw new Error("Missing actual health assessment");
  // Strictly valid supplied metadata, but not the target task's revision.
  card.revision++;
  target.monitor.enabled = false;
  expect(subtaskCheckpointStorageStatus(target)).toBe("supported");
  h.save.mockClear();
  await h.monitor.restore("/nonexistent-hybrid-test", target, false, h.reader);
  expect(h.monitor.enabled).toBe(false);
  const adopted = h.checkpoint().monitor;
  expect(adopted?.healthCards ?? []).toEqual([]);
  expect(h.save).toHaveBeenCalled();
  const saved = h.save.mock.calls.at(-1)?.[0] as ReturnType<
    typeof h.checkpoint
  >;
  expect(saved.monitor?.healthCards ?? []).toEqual(adopted?.healthCards ?? []);
  expect(saved.monitor?.subtasks).toEqual(adopted?.subtasks);
});
