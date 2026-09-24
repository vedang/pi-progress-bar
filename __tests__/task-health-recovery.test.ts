import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  checkpointStorageStatus,
  MAX_CHECKPOINT_BYTES,
} from "../src/core/hybrid-checkpoint";
import { noPatch } from "./fixtures/hybrid";
import { branchEntry } from "./fixtures/hybrid-monitor";
import { taskHealthHarness } from "./fixtures/task-health";

const running: ReturnType<typeof taskHealthHarness>[] = [];
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
async function ready() {
  const h = taskHealthHarness();
  running.push(h);
  h.start();
  await h.settle("goal");
  return h;
}
async function reload(
  h: ReturnType<typeof taskHealthHarness>,
  checkpoint = h.monitor.checkpoint(),
) {
  h.monitor.stop();
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    checkpoint,
    false,
    h.reader,
  );
  await vi.advanceTimersByTimeAsync(300);
}
function hold(h: ReturnType<typeof taskHealthHarness>) {
  const transport = h.fetch.getMockImplementation();
  if (!transport) throw new Error("transport");
  h.fetch.mockImplementation(async (url, init) => {
    if (JSON.parse(String(init?.body)).questions.clarity)
      return new Promise<Response>(() => {});
    return transport(url, init);
  });
  return () => h.fetch.mockImplementation(transport);
}

it("writes a new version with bounded durable report coverage, never raw report text", async () => {
  const h = await ready();
  h.append("red", "PRIVATE_REPORT_SENTINEL parser failure");
  await h.settle("red");
  const saved = h.monitor.checkpoint() as {
    version: number;
    monitor: { healthCards: { provenance: Record<string, unknown> }[] };
  };
  expect(saved.version).toBe(9);
  expect(checkpointStorageStatus(saved)).toBe("supported");
  for (const card of saved.monitor.healthCards) {
    expect(card.provenance.coverage).toMatchObject({
      references: expect.any(Array),
      coverageDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      complete: expect.any(Boolean),
      omissions: expect.any(Array),
    });
    const refs = (card.provenance.coverage as { references: unknown[] })
      .references;
    expect(refs.length).toBeLessThanOrEqual(16);
  }
  expect(JSON.stringify(saved)).not.toContain("PRIVATE_REPORT_SENTINEL");
  expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThan(
    MAX_CHECKPOINT_BYTES,
  );
});

it("v8 checkpoints stay OFF with no migration, semantic replay or provider call", async () => {
  const h = await ready();
  const saved = { ...(h.monitor.checkpoint() as object), version: 8 };
  const calls = h.fetch.mock.calls.length;
  const extracts = h.extract.mock.calls.length;
  await reload(h, saved);
  expect(h.monitor.enabled).toBe(false);
  expect(h.fetch).toHaveBeenCalledTimes(calls);
  expect(h.extract).toHaveBeenCalledTimes(extracts);
});

it("matching accepted coverage reloads without health rebilling or current runtime proof", async () => {
  const h = await ready();
  h.focus("task:1");
  h.append("latest", "PARSER_RED_REPORT failing regression.");
  await h.settle("latest");
  const before = h.cards();
  const calls = h.fetch.mock.calls.length;
  const extracts = h.extract.mock.calls.length;
  await reload(h);
  expect(h.cards()).toEqual(before);
  expect(h.fetch).toHaveBeenCalledTimes(calls);
  expect(h.extract).toHaveBeenCalledTimes(extracts);
  expect(
    h.monitor
      .boardSnapshot()
      .tasks.every((t) => t.provenance.state !== "current"),
  ).toBe(true);
});

it("recovers a stale open card whose queued replacement was lost before dispatch", async () => {
  const h = await ready();
  const resume = hold(h);
  h.append("newer", "PARSER_RED_REPORT failing regression is now reported.");
  await h.settle("newer");
  const saved = h.monitor.checkpoint();
  expect(h.cards()[0]?.provenance.observation.entryId).toBe("goal");
  h.monitor.stop();
  resume();
  const extracts = h.extract.mock.calls.length;
  await reload(h, saved);
  expect(
    h.cards().every((c) => c.provenance.observation.entryId === "newer"),
  ).toBe(true);
  expect(h.cards().find((c) => c.taskId === "task:1")?.health.redEvidence).toBe(
    "Reported red",
  );
  expect(h.extract).toHaveBeenCalledTimes(extracts);
});

it("recovers lost terminal assessment using completion report, not later idle prose", async () => {
  const h = await ready();
  const resume = hold(h);
  h.completed.add("task:1");
  h.append("terminal", "Parser complete after PARSER_RED_REPORT regression.");
  await h.settle("terminal");
  h.append("later", "Documentation remains open.");
  await h.settle("later");
  const saved = h.monitor.checkpoint();
  h.monitor.stop();
  resume();
  await reload(h, saved);
  expect(
    h.cards().find((c) => c.taskId === "task:1")?.provenance.observation
      .entryId,
  ).toBe("terminal");
  expect(
    h.cards().find((c) => c.taskId === "task:2")?.provenance.observation
      .entryId,
  ).toBe("later");
});

it("repairs missing done card from terminal context and never queues archived task", async () => {
  const h = await ready();
  h.completed.add("task:1");
  h.append("terminal", "Parser complete.");
  await h.settle("terminal");
  h.patches.set("archive", {
    ...noPatch(),
    archive: [{ id: "task:3", quote: "Drop research." }],
  });
  h.append("archive", "Drop research.", "user");
  await h.settle("archive");
  const saved = h.monitor.checkpoint() as {
    monitor: { healthCards: { taskId: string }[] };
  };
  saved.monitor.healthCards = saved.monitor.healthCards.filter(
    (c) => c.taskId !== "task:1",
  );
  const count = h.healthRequests().length;
  await reload(h, saved);
  expect(
    h.cards().find((c) => c.taskId === "task:1")?.provenance.observation
      .entryId,
  ).toBe("terminal");
  expect(
    h
      .healthRequests()
      .slice(count)
      .map(
        (r) => (r.state as { evidence: { taskId: string } }).evidence.taskId,
      ),
  ).toEqual(["task:1"]);
});

it("earlier report amendment invalidates coverage even when target and task source match", async () => {
  const h = await ready();
  h.append("earlier", "PARSER_RED_REPORT failing regression.");
  await h.settle("earlier");
  for (let i = 0; i < 4; i++) {
    h.append(`later-${i}`, `Documentation progress ${i}`);
    await h.settle(`later-${i}`);
  }
  const saved = h.monitor.checkpoint();
  const before = structuredClone(h.monitor.state);
  const entries = h
    .reader()
    .map((e) =>
      (e as { id: string }).id === "earlier"
        ? branchEntry(
            "earlier",
            "Previous failing report was withdrawn.",
            "assistant",
          )
        : e,
    );
  const calls = h.healthRequests().length;
  const extracts = h.extract.mock.calls.length;
  h.monitor.stop();
  h.replace(entries);
  await reload(h, saved);
  expect(h.healthRequests().length).toBeGreaterThan(calls);
  expect(h.monitor.state).toEqual(before);
  expect(h.extract).toHaveBeenCalledTimes(extracts);
  expect(
    h.cards().find((c) => c.taskId === "task:1")?.health.redEvidence,
  ).not.toBe("Reported red");
});

it("omitted reports remain honest across reload without repeat calls for matching proof", async () => {
  const h = await ready();
  for (let i = 0; i < 20; i++) h.append(`r-${i}`, `Canonical update ${i}.`);
  await h.settle("r-19");
  expect(h.cards().every((c) => c.health.redEvidence === "Unknown")).toBe(true);
  const calls = h.fetch.mock.calls.length;
  await reload(h);
  expect(h.fetch).toHaveBeenCalledTimes(calls);
});

it.each(["raw-text", "too-many-refs", "wrong-complete", "unknown-field"])(
  "rejects malformed coverage %s before any provider dispatch",
  async (kind) => {
    const h = await ready();
    const saved = h.monitor.checkpoint() as {
      version: number;
      monitor: { healthCards: { provenance: Record<string, unknown> }[] };
    };
    expect(saved.version).toBe(9);
    const coverage = saved.monitor.healthCards[0].provenance.coverage as Record<
      string,
      unknown
    >;
    expect(coverage).toBeDefined();
    if (kind === "raw-text") coverage.reports = [{ text: "PRIVATE_RAW_TEXT" }];
    else if (kind === "too-many-refs")
      coverage.references = Array.from(
        { length: 17 },
        () => (coverage.references as unknown[])[0],
      );
    else if (kind === "wrong-complete") coverage.complete = "yes";
    else coverage.unexpected = true;
    const calls = h.fetch.mock.calls.length;
    expect(checkpointStorageStatus(saved)).toBe("corrupt");
    await reload(h, saved);
    expect(h.monitor.enabled).toBe(false);
    expect(h.fetch).toHaveBeenCalledTimes(calls);
  },
);

it("corrupt coverage proof remains OFF, never silently rebuilds or rebills", async () => {
  const h = await ready();
  const saved = h.monitor.checkpoint() as {
    monitor: { healthCards: { provenance: Record<string, unknown> }[] };
  };
  saved.monitor.healthCards[0].provenance.coverage = {
    references: [{ entryId: "bad" }],
    coverageDigest: "invalid",
    complete: true,
    omissions: [],
  };
  const calls = h.fetch.mock.calls.length;
  await reload(h, saved);
  expect(h.monitor.enabled).toBe(false);
  expect(h.fetch).toHaveBeenCalledTimes(calls);
});
