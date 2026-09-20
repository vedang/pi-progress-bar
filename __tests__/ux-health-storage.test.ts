import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  checkpointBytes,
  type HealthCard,
  MAX_CHECKPOINT_BYTES,
  type MonitorCheckpointMetadata,
} from "../src/core/hybrid-checkpoint";
import { initialMessage, observation } from "./fixtures/hybrid";
import { monitorHarness } from "./fixtures/hybrid-monitor";

const running: ReturnType<typeof monitorHarness>[] = [];
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
function fixture() {
  const h = monitorHarness();
  running.push(h);
  return h;
}
interface HealthRecord {
  taskId: string;
  provenance: {
    taskSource: unknown;
    observation: { entryId: string; messageHash: string; role: string };
    snapshotHash: string;
    requestHashes: string[];
    evidenceHash: string;
    codeRevision: number;
  };
}
function records(h: ReturnType<typeof fixture>): HealthRecord[] {
  const saved = h.monitor.checkpoint() as unknown as {
    monitor: { healthCards?: HealthRecord[] };
  };
  expect(
    saved.monitor.healthCards,
    "durable per-task health map",
  ).toBeDefined();
  if (!saved.monitor.healthCards) throw new Error("Missing health map");
  return saved.monitor.healthCards;
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

it("persists exact source, report, request, snapshot and evidence identities without raw requests", async () => {
  const h = fixture();
  h.start();
  await h.settle("goal");
  const cards = records(h);
  expect(cards).toHaveLength(1);
  const card = cards[0];
  const first = h.monitor.state.tasks[0];
  expect(card?.taskId).toBe(first?.id);
  expect(card?.provenance.taskSource).toEqual(first?.source);
  expect(card?.provenance.observation).toEqual({
    entryId: "goal",
    messageHash: h.monitor.state.cursor?.hash,
    role: "user",
  });
  const healthRequests = h.requests.filter(
    (r) =>
      "clarity" in r.questions ||
      Object.keys(r.questions).some((q) => q.startsWith("criterion:")),
  );
  expect(card?.provenance.requestHashes).toEqual(healthRequests.map(digest));
  expect(card?.provenance.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  expect(card?.provenance.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
  expect(card?.provenance.codeRevision).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(cards)).not.toContain("Canonical task requirements:");
  expect(JSON.stringify(cards)).not.toContain("Latest canonical");
});

it.each(["taskSource", "observation"] as const)(
  "never presents a restored card with mismatched %s canonical provenance as current",
  async (field) => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    records(h);
    const saved = h.monitor.checkpoint() as unknown as {
      monitor: { healthCards: HealthRecord[] };
    };
    const card = saved.monitor.healthCards[0];
    if (!card) throw new Error("Missing card");
    const source = card.provenance[field] as Record<string, unknown>;
    source.entryId = "NO_SUCH_CANONICAL_SOURCE";
    const calls = h.fetch.mock.calls.length;
    const extracts = h.extract.mock.calls.length;
    await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
    await vi.advanceTimersByTimeAsync(100);
    const snapshot = Reflect.apply(
      Reflect.get(h.monitor, "boardSnapshot"),
      h.monitor,
      [],
    ) as {
      tasks: {
        taskId: string;
        provenance: { state: string };
        health: { acceptance: string };
      }[];
    };
    const restored = snapshot.tasks.find((task) => task.taskId === "task:1");
    expect(restored?.provenance.state).not.toBe("current");
    expect(restored?.health.acceptance).not.toBe("explicit");
    expect(h.monitor.presentationSnapshot().card).toBeUndefined();
    expect(h.fetch).toHaveBeenCalledTimes(calls);
    expect(h.extract).toHaveBeenCalledTimes(extracts);
  },
);

it("denies optional health at full-map byte edge without setting semantic capacity or changing accepted state", async () => {
  const h = fixture();
  h.start();
  await h.settle("goal");
  records(h);
  h.monitor.state.scopeError = "";
  const remaining = MAX_CHECKPOINT_BYTES - bytes(h.monitor.checkpoint()) - 2;
  expect(remaining).toBeGreaterThan(0);
  h.monitor.state.scopeError = "x".repeat(remaining);
  expect(bytes(h.monitor.checkpoint())).toBe(MAX_CHECKPOINT_BYTES - 2);
  const before = structuredClone(h.monitor.state);
  const cards = records(h);
  const calls = h.fetch.mock.calls.length;
  const admitted = Reflect.apply(
    Reflect.get(h.monitor, "admitHealth"),
    h.monitor,
    [h.monitor.state.tasks[0], initialMessage, 2],
  );
  expect(admitted).toBe(false);
  expect(h.fetch).toHaveBeenCalledTimes(calls);
  expect(h.monitor.state).toEqual(before);
  expect(h.monitor.state.capacity).toBe("clear");
  expect(records(h)).toEqual(cards);
  expect(bytes(h.monitor.checkpoint())).toBeLessThanOrEqual(
    MAX_CHECKPOINT_BYTES,
  );
  expect(
    h.save.mock.calls.every(([saved]) => bytes(saved) <= MAX_CHECKPOINT_BYTES),
  ).toBe(true);
  // Remove synthetic byte pressure, not any latch; normal tracking must proceed.
  delete h.monitor.state.scopeError;
  h.append("after-denial", "Parser work is continuing.");
  await h.settle("after-denial");
  expect(h.monitor.state.capacity).toBe("clear");
});

it("preflights the actual long triggering observation ID before any optional dispatch", async () => {
  const h = fixture();
  h.start();
  await h.settle("goal");
  const longId = `report-${"x".repeat(8000)}`;
  const report = observation(longId, "Parser work continues.", "assistant");
  // Establish canonical semantic work without assessing its optional card yet.
  const admission = vi
    .spyOn(
      h.monitor as unknown as { admitHealth: (...args: unknown[]) => boolean },
      "admitHealth",
    )
    .mockReturnValue(false);
  h.append(report.id, report.text);
  await h.settle(report.id);
  admission.mockRestore();
  h.monitor.state.scopeError = "";
  h.monitor.state.scopeError = "p".repeat(
    MAX_CHECKPOINT_BYTES - bytes(h.monitor.checkpoint()) - 4096,
  );
  const before = structuredClone(h.monitor.state);
  const calls = h.fetch.mock.calls.length;
  Reflect.apply(Reflect.get(h.monitor, "scheduleHealth"), h.monitor, [report]);
  h.observe();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.fetch).toHaveBeenCalledTimes(calls);
  expect(h.monitor.state).toEqual(before);
  expect(h.monitor.state.capacity).toBe("clear");
  expect(() => h.monitor.checkpoint()).not.toThrow();
  expect(
    h.save.mock.calls.every(([saved]) => bytes(saved) <= MAX_CHECKPOINT_BYTES),
  ).toBe(true);
});

it.each([
  "snapshotHash",
  "requestHashes",
  "evidenceHash",
  "codeRevision",
] as const)(
  "restored health never claims current from unverified %s",
  async (field) => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    const saved = h.monitor.checkpoint() as {
      monitor: { healthCards: HealthRecord[] };
    };
    const card = saved.monitor.healthCards[0];
    if (!card) throw new Error("Missing card");
    if (field === "requestHashes")
      card.provenance.requestHashes = ["0".repeat(64)];
    else if (field === "codeRevision") card.provenance.codeRevision += 1;
    else card.provenance[field] = "0".repeat(64);
    const calls = h.fetch.mock.calls.length;
    await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
    await vi.advanceTimersByTimeAsync(100);
    const restored = h.monitor
      .boardSnapshot()
      .tasks.find((task) => task.taskId === "task:1");
    expect(restored?.provenance.state).not.toBe("current");
    expect(h.fetch).toHaveBeenCalledTimes(calls);
  },
);

it("rejects strict-v7 provenance-free legacy current-card storage without replay", async () => {
  const h = fixture();
  h.start();
  await h.settle("goal");
  const saved = h.monitor.checkpoint() as {
    version: number;
    monitor: Record<string, unknown>;
  };
  saved.monitor.card = h.monitor.presentationSnapshot().card;
  delete saved.monitor.healthCards;
  const calls = h.fetch.mock.calls.length;
  const saves = h.save.mock.calls.length;
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.enabled).toBe(false);
  expect(h.monitor.presentationSnapshot().service.code).toBe(
    "saved-state-corrupt",
  );
  expect(h.fetch).toHaveBeenCalledTimes(calls);
  expect(h.save).toHaveBeenCalledTimes(saves);
});

it("evicts optional health when mandatory core work fits only without the map", async () => {
  const h = fixture();
  h.start();
  await h.settle("goal");
  expect(records(h)).toHaveLength(1);
  const candidate = structuredClone(h.monitor.state);
  candidate.scopeError = "";
  const coreMetadata = Reflect.apply(
    Reflect.get(h.monitor, "capacityMetadata"),
    h.monitor,
    [undefined, new Map(), candidate],
  ) as MonitorCheckpointMetadata;
  candidate.scopeError = "x".repeat(
    MAX_CHECKPOINT_BYTES - checkpointBytes(candidate, coreMetadata) - 128,
  );
  expect(checkpointBytes(candidate, coreMetadata)).toBeLessThan(
    MAX_CHECKPOINT_BYTES,
  );
  const before = structuredClone(h.monitor.state);
  const calls = h.fetch.mock.calls.length;
  const admitted = Reflect.apply(Reflect.get(h.monitor, "admit"), h.monitor, [
    { phase: "gate", candidate, schemaBytes: 0 },
  ]);
  expect(admitted).toBe(true);
  expect(h.monitor.state).toEqual(before);
  expect(h.monitor.state.capacity).toBe("clear");
  expect(h.monitor.presentationSnapshot().card).toBeUndefined();
  expect(h.fetch).toHaveBeenCalledTimes(calls);
  expect(() => h.monitor.checkpoint()).not.toThrow();
});

it("preflights prospective idle-DONE selector after restored-open work completes", async () => {
  const h = fixture();
  h.start();
  await h.settle("goal");
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    h.monitor.checkpoint(),
    false,
    h.reader,
  );
  const transport = h.fetch.getMockImplementation();
  if (!transport) throw new Error("Missing transport");
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    const response = await transport(url, init);
    const body = (await response.json()) as {
      answers: Record<string, unknown>;
    };
    for (const [key, question] of Object.entries(request.questions)) {
      const choice = key.startsWith("complete:")
        ? "yes"
        : key === "focus"
          ? "none"
          : undefined;
      if (!choice) continue;
      body.answers[key] = {
        type: "choice",
        choice,
        confidence: 1,
        probabilities: Object.fromEntries(
          Object.keys((question as { criteria: object }).criteria).map(
            (key) => [key, key === choice ? 1 : 0],
          ),
        ),
      };
    }
    return Response.json(body);
  });
  const admission = vi
    .spyOn(
      h.monitor as unknown as { admitHealth: (...args: unknown[]) => boolean },
      "admitHealth",
    )
    .mockReturnValue(false);
  const report = observation(
    "all-done",
    "All requested tasks complete.",
    "assistant",
  );
  h.append(report.id, report.text);
  await h.settle(report.id);
  admission.mockRestore();
  expect(h.monitor.state.tasks.every((task) => task.status === "done")).toBe(
    true,
  );
  expect(h.monitor.checkpoint()).not.toHaveProperty("monitor.idleDoneTaskId");
  const task = h.monitor.state.tasks[0];
  if (!task) throw new Error("Missing task");
  const prospective = Reflect.apply(
    Reflect.get(h.monitor, "maximumHealthCard"),
    h.monitor,
    [task, report],
  ) as HealthCard;
  const saved = h.monitor.checkpoint() as {
    monitor: { healthCards: HealthCard[] };
  };
  const map = new Map(
    saved.monitor.healthCards.map((card) => [card.taskId, card]),
  );
  map.set(task.id, prospective);
  const withoutSelector = Reflect.apply(
    Reflect.get(h.monitor, "capacityMetadata"),
    h.monitor,
    [undefined, map, h.monitor.state],
  ) as MonitorCheckpointMetadata;
  delete withoutSelector.idleDoneTaskId;
  h.monitor.state.scopeError = "";
  h.monitor.state.scopeError = "x".repeat(
    MAX_CHECKPOINT_BYTES - checkpointBytes(h.monitor.state, withoutSelector),
  );
  expect(checkpointBytes(h.monitor.state, withoutSelector)).toBe(
    MAX_CHECKPOINT_BYTES,
  );
  expect(
    checkpointBytes(h.monitor.state, {
      ...withoutSelector,
      idleDoneTaskId: task.id,
    }),
  ).toBeGreaterThan(MAX_CHECKPOINT_BYTES);
  const calls = h.fetch.mock.calls.length;
  expect(
    Reflect.apply(Reflect.get(h.monitor, "admitHealth"), h.monitor, [
      task,
      report,
      1,
    ]),
  ).toBe(false);
  expect(h.fetch).toHaveBeenCalledTimes(calls);
  expect(h.monitor.state.capacity).toBe("clear");
  expect(() => h.monitor.checkpoint()).not.toThrow();
});

it("optional provider failure never prevents later canonical completion", async () => {
  const h = fixture();
  const transport = h.fetch.getMockImplementation();
  if (!transport) throw new Error("Missing transport");
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.questions.clarity) throw new Error("PRIVATE_OPTIONAL_FAILURE");
    return transport(url, init);
  });
  h.start();
  await h.settle("goal");
  expect(h.monitor.state.capacity).toBe("clear");
  h.append("delivered", "Regression and validation are complete.");
  await h.settle("delivered");
  expect(
    h.monitor.state.tasks.filter((task) => task.status === "done"),
  ).toHaveLength(2);
  expect(h.monitor.state.capacity).toBe("clear");
});
