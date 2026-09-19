import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { processObservation } from "../src/core/hybrid";
import { encodeCheckpoint } from "../src/core/hybrid-checkpoint";
import { emptyState } from "../src/core/hybrid-state";
import { addPatch, backend, observation } from "./fixtures/hybrid";
import { branchEntry, monitorHarness } from "./fixtures/hybrid-monitor";

let running: ReturnType<typeof monitorHarness> | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline-key");
});
afterEach(() => {
  running?.monitor.stop();
  running = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("restores an OFF-interrupted completion chunk without rebilling any accepted prefix", async () => {
  let state = emptyState("session:test");
  const entries: ReturnType<typeof branchEntry>[] = [];
  for (let batch = 0; batch < 4; batch++) {
    const message = observation(
      `batch-${batch}`,
      `Add tasks from batch ${batch}.`,
    );
    entries.push(branchEntry(message.id, message.text));
    const labels = Array.from(
      { length: 5 },
      (_, i) =>
        `Task ${batch * 5 + i + 1}: ${"specific requirement ".repeat(10)}`,
    );
    state = await processObservation(
      state,
      message,
      backend(addPatch(message, labels)),
    );
  }
  const h = monitorHarness(entries);
  running = h;
  h.observe();
  await h.monitor.restore("/nonexistent-hybrid-test", encodeCheckpoint(state));
  const original = h.fetch.getMockImplementation();
  if (!original) throw new Error("Missing fake");
  let completionCalls = 0;
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    const ids = Object.keys(request.questions).filter((key) =>
      key.startsWith("complete:"),
    );
    if (ids.length && ++completionCalls === 2)
      return new Promise<Response>(() => {});
    const response = await original(url, init);
    if (!ids.length) return response;
    const body = (await response.json()) as {
      answers: Record<string, unknown>;
    };
    for (const id of ids)
      body.answers[id] = {
        type: "choice",
        choice: "yes",
        confidence: 1,
        probabilities: { yes: 1, no: 0, uncertain: 0 },
      };
    return Response.json(body);
  });
  h.append(
    "chunk-delivery",
    `All twenty requested tasks are completed. ${"Detailed supporting report. ".repeat(350)}`,
  );
  for (let i = 0; i < 200 && completionCalls < 2; i++)
    await vi.advanceTimersByTimeAsync(1);
  expect(completionCalls).toBe(2);
  const accepted = [
    ...(h.monitor.state.pending?.journal.completions.flatMap(
      (record) => record.chunkIds,
    ) ?? []),
  ];
  expect(accepted.length).toBeGreaterThan(0);
  expect(accepted.length).toBeLessThan(20);
  const checkpoint = h.monitor.checkpoint();
  const beforeResume = h.fetch.mock.calls.length;
  h.monitor.turnOff();
  await h.monitor.restore("/nonexistent-hybrid-test", checkpoint);
  await h.settle("chunk-delivery");
  expect(h.monitor.state.tasks.every((task) => task.status === "done")).toBe(
    true,
  );
  expect(h.extract).not.toHaveBeenCalled();
  const resumed = h.fetch.mock.calls
    .slice(beforeResume)
    .map(([, init]) => JSON.parse(String(init?.body)));
  expect(resumed.length).toBeGreaterThan(0);
  expect(resumed.some((request) => "gate" in request.questions)).toBe(false);
  for (const taskId of accepted)
    expect(
      resumed.some(
        (request) =>
          `complete:${taskId}` in request.questions ||
          `withdraw:${taskId}` in request.questions,
      ),
    ).toBe(false);
});
