import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { processObservation } from "../src/core/hybrid";
import { encodeCheckpoint } from "../src/core/hybrid-checkpoint";
import { emptyState, type HybridState } from "../src/core/hybrid-state";
import { selectedModelExtractor } from "../src/core/selected-model";
import { backend, noPatch, observation } from "./fixtures/hybrid";
import { branchEntry, monitorHarness } from "./fixtures/hybrid-monitor";

const running: ReturnType<typeof monitorHarness>[] = [];
function fixture(entries?: ReturnType<typeof branchEntry>[]) {
  const h = monitorHarness(entries);
  running.push(h);
  return h;
}
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

it("publishes rejected scope as previous with an allowlisted diagnostic", async () => {
  const h = fixture();
  h.start();
  await h.settle("goal");
  h.extract.mockResolvedValueOnce({
    text: "invalid JSON",
    provider: "offline",
    model: "fixture",
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  h.append("extra", "Also deliver a separate report.");
  await h.settle("extra");
  expect(h.monitor.presentationSnapshot().progress.kind).toBe("previous");
  expect(h.monitor.debugSnapshot().diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "invalid-scope-result" }),
    ]),
  );
});

it("invalidates an amended observation while its gate is still held, before stale extraction", async () => {
  const h = fixture();
  const original = h.fetch.getMockImplementation();
  if (!original) throw new Error("Missing fetch");
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.fetch.mockImplementationOnce(async (url, init) => {
    await held;
    return original(url, init);
  });
  h.start();
  await vi.advanceTimersByTimeAsync(5);
  const revised = "Implement the revised parser and validate it.";
  h.replace([branchEntry("goal", revised)]);
  release();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.extract.mock.calls.length).toBeGreaterThan(0);
  expect(
    h.extract.mock.calls.every(([input]) => input.latest.text === revised),
  ).toBe(true);
  expect(
    h.monitor.state.tasks.every(
      (task) => task.source.messageHash === observation("goal", revised).hash,
    ),
  ).toBe(true);
});

it("never retries amended text from the stale backoff observation", async () => {
  const h = fixture();
  h.fetch.mockResolvedValueOnce(
    new Response("unavailable", {
      status: 429,
      headers: { "retry-after": "5" },
    }),
  );
  h.start();
  await vi.advanceTimersByTimeAsync(100);
  const revised = "Implement the corrected parser.";
  h.replace([branchEntry("goal", revised)]);
  await vi.advanceTimersByTimeAsync(6000);
  const retried = h.fetch.mock.calls
    .slice(1)
    .map(([, init]) => JSON.parse(String(init?.body)))
    .filter((request) => request.questions.gate);
  expect(retried.length).toBeGreaterThan(0);
  expect(
    retried.every((request) => request.state.latest.text === revised),
  ).toBe(true);
});

it("invalidates an archived historical source even when the later cursor is unchanged", async () => {
  const h = fixture();
  h.start();
  await h.settle("goal");
  const archive = "Archive the first deliverable.";
  h.extract.mockResolvedValueOnce({
    text: JSON.stringify({
      ...noPatch(),
      archive: [{ id: "task:1", quote: archive }],
    }),
    provider: "offline",
    model: "fixture",
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  h.append("extra", archive);
  await h.settle("extra");
  expect(h.monitor.state.tasks[0]?.included).toBe(false);
  h.append("tail", "Acknowledged.");
  await h.settle("tail");
  const revised = "Implement the amended parser and validate it.";
  h.replace([
    branchEntry("goal", revised),
    branchEntry("extra", archive, "assistant"),
    branchEntry("tail", "Acknowledged.", "assistant"),
  ]);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.state.tasks[0]?.source.messageHash).toBe(
    observation("goal", revised).hash,
  );
});

it("rehydrates the two earlier messages for the first new request after reload", async () => {
  const h = fixture();
  h.start();
  await h.settle("goal");
  h.append("context", "This is the parser we discussed.");
  await h.settle("context");
  const checkpoint = h.monitor.checkpoint();
  h.monitor.turnOff();
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    checkpoint,
    false,
    h.reader,
  );
  h.append("extra", "Explain that parser.");
  await h.settle("extra");
  const input = h.extract.mock.calls.find(
    ([input]) => input.latest.id === "extra",
  )?.[0];
  expect(input?.earlier.map((message) => message.id)).toEqual([
    "goal",
    "context",
  ]);
});

it("resumes an accepted gate with the same earlier evidence, without rebilling that gate", async () => {
  const a = observation("context-a", "We are discussing the parser.");
  const b = observation(
    "context-b",
    "Its streaming mode matters.",
    "assistant",
  );
  const latest = observation("extra", "Explain that mode.");
  const saved: HybridState[] = [];
  await processObservation(
    { ...emptyState("session:test"), cursor: { id: b.id, hash: b.hash } },
    latest,
    backend(noPatch(), { save: (state) => saved.push(structuredClone(state)) }),
    [a, b],
  );
  const gated = saved.find((state) => state.pending?.phase === "extract");
  if (!gated) throw new Error("Missing gate snapshot");
  const h = fixture([
    branchEntry(a.id, a.text),
    branchEntry(b.id, b.text, b.role),
    branchEntry(latest.id, latest.text),
  ]);
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    encodeCheckpoint(gated),
    false,
    h.reader,
  );
  await h.settle("extra");
  expect(h.requests.some((request) => "gate" in request.questions)).toBe(false);
  expect(
    h.extract.mock.calls[0]?.[0].earlier.map((message) => message.id),
  ).toEqual([a.id, b.id]);
});

function hostAdapter(complete: ReturnType<typeof vi.fn>, hasModel = true) {
  return selectedModelExtractor(
    () =>
      ({
        model: hasModel
          ? { id: "offline-model", provider: "offline" }
          : undefined,
        modelRegistry: { complete },
      }) as unknown as Pick<ExtensionContext, "model" | "modelRegistry">,
  );
}

it("does not claim actual extraction dispatch when no selected model exists", async () => {
  const h = fixture();
  const complete = vi.fn();
  h.extract.mockImplementation(hostAdapter(complete, false));
  h.start();
  await vi.advanceTimersByTimeAsync(100);
  expect(complete).not.toHaveBeenCalled();
  expect(h.monitor.presentationSnapshot().lastExtractionCallAt).toBeUndefined();
});

it.each(["held", "failed"])(
  "persists an actual %s host dispatch before its result",
  async (mode) => {
    const h = fixture();
    const complete = vi.fn(() =>
      mode === "held"
        ? new Promise<never>(() => {})
        : Promise.reject(new Error("offline failure")),
    );
    h.extract.mockImplementation(hostAdapter(complete));
    h.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(complete).toHaveBeenCalledTimes(1);
    const at = h.monitor.presentationSnapshot().lastExtractionCallAt;
    expect(at).toBeTypeOf("number");
    expect(
      h.save.mock.calls.some(
        ([checkpoint]) =>
          (checkpoint as { monitor?: { lastExtractionCallAt?: number } })
            .monitor?.lastExtractionCallAt === at,
      ),
    ).toBe(true);
  },
);

it("qualifies a held first page as catching up history rather than current complete scope", async () => {
  const h = fixture(
    Array.from({ length: 513 }, (_, i) =>
      branchEntry(`history-${i}`, `Historical observation ${i}.`),
    ),
  );
  h.fetch.mockImplementationOnce(() => new Promise<never>(() => {}));
  h.start();
  await vi.advanceTimersByTimeAsync(1);
  expect(JSON.stringify(h.monitor.presentationSnapshot())).toMatch(
    /catching up history/i,
  );
});

it("clears replacement pending when a revised task completes in the same observation", async () => {
  const h = fixture();
  h.start();
  await h.settle("goal");
  const before = h.monitor.presentationSnapshot().card;
  expect(before).toBeDefined();
  const report =
    "The parser now supports streaming and that revised parser is complete.";
  h.extract.mockResolvedValueOnce({
    text: JSON.stringify({
      ...noPatch(),
      revise: [
        {
          id: "task:1",
          label: "Implement streaming parser",
          requirementsChanged: true,
          quote: report,
        },
      ],
    }),
    provider: "offline",
    model: "fixture",
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  const original = h.fetch.getMockImplementation();
  if (!original) throw new Error("Missing fetch");
  h.fetch.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    const body = (await response.json()) as {
      answers: Record<string, unknown>;
    };
    if (body.answers["complete:task:1"])
      body.answers["complete:task:1"] = {
        type: "choice",
        choice: "yes",
        confidence: 1,
        probabilities: { yes: 1, no: 0, uncertain: 0 },
      };
    return Response.json(body);
  });
  h.append("extra", report);
  await h.settle("extra");
  expect(h.monitor.state.tasks[0]).toMatchObject({
    revision: 2,
    status: "done",
  });
  expect(h.monitor.presentationSnapshot().card).toMatchObject({
    label: before?.label,
    retained: true,
    replacementPending: false,
  });
});
