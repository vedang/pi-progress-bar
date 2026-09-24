import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { taskDetailRequest } from "../src/analysis/task-details";
import { processObservation } from "../src/core/hybrid";
import {
  checkpointBytes,
  checkpointStorageStatus,
  encodeCheckpoint,
  MAX_CHECKPOINT_BYTES,
  type MonitorCheckpointMetadata,
  monitorCheckpointMetadata,
} from "../src/core/hybrid-checkpoint";
import { requestHash } from "../src/core/hybrid-proof";
import { emptyState, type HybridState } from "../src/core/hybrid-state";
import {
  backend,
  initial,
  initialMessage,
  noPatch,
  observation,
} from "./fixtures/hybrid";
import { monitorHarness } from "./fixtures/hybrid-monitor";
import {
  type DetailRecord,
  detailAddExtraction,
  detailMetadata,
  detailRecord,
  isDetailRequest,
  required,
  savedDetails,
} from "./fixtures/task-details";

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
function fixture(enabled = true) {
  const h = monitorHarness(undefined, {
    richDetailsEnabled: enabled,
    extractionText: (input) =>
      JSON.stringify(
        input.latest.id === "goal" ? detailAddExtraction() : noPatch(),
      ),
  });
  running.push(h);
  return h;
}
async function ready() {
  const h = fixture();
  h.start();
  await h.settle("goal");
  await vi.advanceTimersByTimeAsync(100);
  return h;
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
it("uses strict v8; v7 is unsupported without migration", async () => {
  const state = await initial();
  const cp = encodeCheckpoint(
    state,
    detailMetadata([detailRecord(required(state.tasks[0]), initialMessage)]),
  );
  expect(cp.version).toBe(8);
  expect(checkpointStorageStatus(cp)).toBe("supported");
  expect(checkpointStorageStatus({ ...cp, version: 7 })).toBe("unsupported");
  expect(
    savedDetails(monitorCheckpointMetadata(cp) ? cp : undefined),
  ).toHaveLength(1);
  expect(JSON.stringify(cp)).not.toContain('"quote":');
});
it.each([
  [
    "unknown record field",
    (r: DetailRecord) => Object.assign(r, { surprise: true }),
  ],
  ["wrong task revision", (r: DetailRecord) => r.revision++],
  [
    "empty candidates",
    (r: DetailRecord) => {
      r.candidates = [];
    },
  ],
  [
    "duplicate keys",
    (r: DetailRecord) =>
      r.candidates.push(structuredClone(required(r.candidates[0]))),
  ],
  [
    "out of range criterion",
    (r: DetailRecord) => {
      Reflect.set(required(r.candidates[0]), "key", "acceptance:6");
    },
  ],
  [
    "unknown source field",
    (r: DetailRecord) =>
      Object.assign(required(r.candidates[0]).source, { text: "LEAK" }),
  ],
  [
    "bad receipt hash",
    (r: DetailRecord) =>
      r.receipts.push({
        requestHash: "bad",
        candidateKeys: ["description"],
        assessments: [],
        validatedAt: 1,
      }),
  ],
] as const)("strict metadata rejects %s", async (_name, mutate) => {
  const state = await initial();
  const cp = encodeCheckpoint(
    state,
    detailMetadata([detailRecord(required(state.tasks[0]), initialMessage)]),
  );
  expect(checkpointStorageStatus(cp)).toBe("supported");
  mutate(required(savedDetails(cp)[0]));
  expect(checkpointStorageStatus(cp)).toBe("corrupt");
});
it("offers exactly once on accepted patch save, never in mandatory pending/core", async () => {
  const saves: {
    state: HybridState;
    options?: { detailOffers?: DetailRecord[] };
  }[] = [];
  const providers = backend();
  providers.extract.mockResolvedValue(JSON.stringify(detailAddExtraction()));
  const state = await processObservation(
    emptyState("session:test"),
    initialMessage,
    {
      ...providers,
      save: (state, options?: { detailOffers?: DetailRecord[] }) =>
        saves.push({
          state: structuredClone(state),
          options: structuredClone(options),
        }),
    },
  );
  expect(state.cursor?.id).toBe(initialMessage.id);
  const offered = saves.filter((save) => save.options?.detailOffers?.length);
  expect(offered).toHaveLength(1);
  const offerSave = required(offered[0]);
  expect(offerSave.state.pending?.journal.patch).toBeDefined();
  expect(offerSave.state.cursor).toBeUndefined();
  const task = required(state.tasks[0]);
  const record = required(offerSave.options?.detailOffers?.[0]);
  expect(record).toMatchObject({
    taskId: task.id,
    revision: task.revision,
    label: task.label,
    taskSource: task.source,
    receipts: [],
  });
  expect(record.candidates.map((c) => c.key)).toEqual([
    "title",
    "description",
    "acceptance:0",
  ]);
  expect(JSON.stringify(state)).not.toContain("detailOffers");
  expect(JSON.stringify(state)).not.toContain("taskDetails");
});
it("durably admits jobs before cursor, but dispatches only after cursor commits", async () => {
  const h = fixture();
  const transport = required(h.fetch.getMockImplementation());
  const atDispatch: HybridState[] = [];
  h.fetch.mockImplementation(async (url, init) => {
    if (isDetailRequest(JSON.parse(String(init?.body))))
      atDispatch.push(structuredClone(h.monitor.state));
    return transport(url, init);
  });
  h.start();
  for (let i = 0; i < 250 && !atDispatch.length; i++)
    await vi.advanceTimersByTimeAsync(1);
  expect(atDispatch).toHaveLength(1);
  expect(atDispatch[0]?.cursor?.id).toBe("goal");
  expect(atDispatch[0]?.pending).toBeUndefined();
  expect(
    h.save.mock.calls.some(
      ([cp]) => cp.state.pending?.journal.patch && savedDetails(cp).length,
    ),
  ).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  expect(savedDetails(h.monitor.checkpoint())[0]?.receipts).toHaveLength(1);
});
it("dispatches ready task health before optional detail enrichment", async () => {
  const h = fixture();
  const transport = required(h.fetch.getMockImplementation());
  const order: string[] = [];
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.questions.clarity) order.push("health");
    if (isDetailRequest(request)) order.push("details");
    return transport(url, init);
  });
  h.start();
  await h.settle("goal");
  expect(order[0]).toBe("health");
  expect(order).toContain("details");
});

it("accepted receipt and usage share save; restoring a covered job never rebills", async () => {
  const h = await ready();
  const record = required(savedDetails(h.monitor.checkpoint())[0]);
  expect(record.receipts).toHaveLength(1);
  const cp = h.monitor.checkpoint();
  const calls = h.requests.filter(isDetailRequest).length;
  expect(calls).toBe(1);
  const firstAccepted = h.save.mock.calls.findIndex(
    ([saved]) => savedDetails(saved)[0]?.receipts.length,
  );
  expect(firstAccepted).toBeGreaterThan(0);
  const previous = required(h.save.mock.calls[firstAccepted - 1])[0];
  const accepted = required(h.save.mock.calls[firstAccepted])[0];
  const beforeUsage = required(monitorCheckpointMetadata(previous)).usage.jev;
  const afterUsage = required(monitorCheckpointMetadata(accepted)).usage.jev;
  expect(afterUsage.inputTokens - beforeUsage.inputTokens).toBe(2);
  expect(afterUsage.outputTokens - beforeUsage.outputTokens).toBe(1);
  h.monitor.turnOff();
  await h.monitor.restore("/nonexistent-hybrid-test", cp, false, h.reader);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.requests.filter(isDetailRequest)).toHaveLength(calls);
  expect(savedDetails(h.monitor.checkpoint())[0]?.receipts).toEqual(
    record.receipts,
  );
});
it("partial receipt restore requests only uncovered candidate keys", async () => {
  const h = await ready();
  const cp = h.monitor.checkpoint();
  const record = required(savedDetails(cp)[0]);
  const receipt = required(record.receipts[0]);
  const covered = required(record.candidates[0]).key;
  receipt.candidateKeys = [covered];
  receipt.assessments = [required(receipt.assessments[0])];
  const message = observation(
    "goal",
    "Implement parser, add regression, and validate it.",
  );
  const request = taskDetailRequest(record, [covered], (id: string) =>
    id === message.id ? message : undefined,
  );
  expect(request).toBeDefined();
  receipt.requestHash = requestHash(request);
  const calls = h.requests.filter(isDetailRequest).length;
  h.monitor.turnOff();
  await h.monitor.restore("/nonexistent-hybrid-test", cp, false, h.reader);
  await vi.advanceTimersByTimeAsync(150);
  const resumed = h.requests.filter(isDetailRequest).slice(calls);
  expect(resumed).toHaveLength(1);
  expect(Object.keys(required(resumed[0]).questions)).toEqual(
    record.candidates.slice(1).map((c) => `detail:${c.key}`),
  );
  expect(savedDetails(h.monitor.checkpoint())[0]?.receipts).toHaveLength(2);
});

it("production-off ignores offers, dispatch and display while mandatory tasks still commit", async () => {
  const h = fixture(false);
  h.start();
  await h.settle("goal");
  expect(h.monitor.state.tasks).toHaveLength(1);
  expect(h.requests.filter(isDetailRequest)).toHaveLength(0);
  expect(savedDetails(h.monitor.checkpoint())).toEqual([]);
  expect(
    Reflect.get(required(h.monitor.boardSnapshot().tasks[0]), "details"),
  ).toBeUndefined();
});
it("optional transport failure never blocks next semantic observation or creates retry timers", async () => {
  const h = fixture();
  const transport = required(h.fetch.getMockImplementation());
  let detailCalls = 0;
  h.fetch.mockImplementation(async (url, init) => {
    if (isDetailRequest(JSON.parse(String(init?.body)))) {
      detailCalls++;
      return new Response("unavailable", { status: 503 });
    }
    return transport(url, init);
  });
  h.start();
  await h.settle("goal");
  expect(detailCalls).toBe(1);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(detailCalls).toBe(1);
  expect(h.monitor.state.capacity).toBe("clear");
  h.append("after-details-error", "Work is continuing.");
  await h.settle("after-details-error");
  expect(h.monitor.state.capacity).toBe("clear");
  expect(h.monitor.state.pending).toBeUndefined();
});
it("late optional result is fenced by OFF", async () => {
  const h = fixture();
  const transport = required(h.fetch.getMockImplementation());
  let release: (() => void) | undefined;
  h.fetch.mockImplementation(async (url, init) => {
    if (isDetailRequest(JSON.parse(String(init?.body))))
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return transport(url, init);
  });
  h.start();
  await h.settle("goal");
  expect(release).toBeTypeOf("function");
  h.monitor.turnOff();
  const cp = h.monitor.checkpoint();
  required(release)();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.checkpoint()).toEqual(cp);
});
it("canonical optional mismatch drops only details, never resets/rebills semantic state", async () => {
  const h = await ready();
  const cp = h.monitor.checkpoint();
  required(required(savedDetails(cp)[0]).candidates[0]).source.quoteHash =
    "f".repeat(64);
  const state = structuredClone(h.monitor.state),
    calls = h.fetch.mock.calls.length,
    extracts = h.extract.mock.calls.length;
  h.monitor.turnOff();
  await h.monitor.restore("/nonexistent-hybrid-test", cp, false, h.reader);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.state).toEqual(state);
  expect(savedDetails(h.monitor.checkpoint())).toEqual([]);
  expect(h.fetch).toHaveBeenCalledTimes(calls);
  expect(h.extract).toHaveBeenCalledTimes(extracts);
});
it("real full-checkpoint byte edge denies optional detail without semantic capacity or health eviction", async () => {
  const h = await ready();
  const record = structuredClone(
    required(savedDetails(h.monitor.checkpoint())[0]),
  );
  record.receipts = [];
  h.monitor.state.scopeError = "";
  h.monitor.state.scopeError = "x".repeat(
    MAX_CHECKPOINT_BYTES - bytes(h.monitor.checkpoint()) - 2,
  );
  expect(bytes(h.monitor.checkpoint())).toBe(MAX_CHECKPOINT_BYTES - 2);
  const before = h.monitor.checkpoint();
  const state = structuredClone(h.monitor.state);
  const calls = h.fetch.mock.calls.length;
  const fn = Reflect.get(h.monitor, "admitDetails");
  expect(fn).toBeTypeOf("function");
  expect(Reflect.apply(fn, h.monitor, [record])).toBe(false);
  expect(h.monitor.checkpoint()).toEqual(before);
  expect(h.monitor.state).toEqual(state);
  expect(h.monitor.state.capacity).toBe("clear");
  expect(h.fetch).toHaveBeenCalledTimes(calls);
  expect(
    h.save.mock.calls.every(([cp]) => bytes(cp) <= MAX_CHECKPOINT_BYTES),
  ).toBe(true);
  delete h.monitor.state.scopeError;
  h.append("after-denial", "Continuing parser work.");
  await h.settle("after-denial");
});
it.each([
  ["yes", 0.5, 0.8, true],
  ["yes", 0.499, 0.8, false],
  ["yes", 0.5, 0.799, false],
  ["no", 1, 1, false],
  ["uncertain", 1, 1, false],
] as const)(
  "projects only accepted yes details (%s/%f/%f)",
  async (choice, confidence, probability, visible) => {
    const h = fixture();
    const transport = required(h.fetch.getMockImplementation());
    h.fetch.mockImplementation(async (url, init) => {
      const request = JSON.parse(String(init?.body));
      const response = await transport(url, init);
      if (!isDetailRequest(request)) return response;
      const body = (await response.json()) as {
        answers: Record<string, unknown>;
      };
      for (const key of Object.keys(body.answers))
        body.answers[key] = {
          type: "choice",
          choice,
          confidence,
          probabilities: Object.fromEntries(
            ["yes", "no", "uncertain"].map((key) => [
              key,
              key === choice ? probability : (1 - probability) / 2,
            ]),
          ),
        };
      return Response.json(body);
    });
    h.start();
    await h.settle("goal");
    await vi.advanceTimersByTimeAsync(100);
    const task = required(h.monitor.boardSnapshot().tasks[0]);
    const details = Reflect.get(task, "details");
    if (visible) {
      expect(details).toMatchObject({
        title: { text: "Implement parser" },
        description: { text: "add regression" },
        acceptanceCriteria: [{ text: "validate it" }],
      });
      expect(JSON.stringify(details)).not.toMatch(
        /quoteHash|messageHash|entryId|taskSource/,
      );
      details.title.text = "consumer mutation";
      expect(
        Reflect.get(required(h.monitor.boardSnapshot().tasks[0]), "details")
          .title.text,
      ).toBe("Implement parser");
    } else expect(details).toBeUndefined();
    const calls = h.fetch.mock.calls.length,
      reads = h.reader.mock.calls.length,
      saves = h.save.mock.calls.length;
    for (let i = 0; i < 25; i++) h.monitor.boardSnapshot();
    expect(h.fetch).toHaveBeenCalledTimes(calls);
    expect(h.reader).toHaveBeenCalledTimes(reads);
    expect(h.save).toHaveBeenCalledTimes(saves);
  },
);
it("mandatory admission evicts optional detail facts when only the core fits", async () => {
  const h = await ready();
  expect(savedDetails(h.monitor.checkpoint())).toHaveLength(1);
  const candidate = structuredClone(h.monitor.state);
  candidate.scopeError = "";
  const metadata = Reflect.apply(
    Reflect.get(h.monitor, "capacityMetadata"),
    h.monitor,
    [undefined, new Map(), candidate],
  ) as MonitorCheckpointMetadata;
  Reflect.deleteProperty(metadata, "taskDetails");
  candidate.scopeError = "x".repeat(
    MAX_CHECKPOINT_BYTES - checkpointBytes(candidate, metadata) - 128,
  );
  const calls = h.fetch.mock.calls.length;
  expect(
    Reflect.apply(Reflect.get(h.monitor, "admit"), h.monitor, [
      { phase: "gate", candidate, schemaBytes: 0 },
    ]),
  ).toBe(true);
  expect(savedDetails(h.monitor.checkpoint())).toEqual([]);
  expect(h.monitor.state.capacity).toBe("clear");
  expect(h.fetch).toHaveBeenCalledTimes(calls);
});

it("a new task revision removes accepted rich details immediately", async () => {
  const h = await ready();
  const task = required(h.monitor.state.tasks[0]);
  expect(
    Reflect.get(required(h.monitor.boardSnapshot().tasks[0]), "details"),
  ).toBeDefined();
  task.revision++;
  expect(
    Reflect.get(required(h.monitor.boardSnapshot().tasks[0]), "details"),
  ).toBeUndefined();
});
