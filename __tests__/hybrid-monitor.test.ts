import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addPatch, noPatch, observation } from "./fixtures/hybrid";
import { branchEntry, monitorHarness } from "./fixtures/hybrid-monitor";
import { qaEntry, userMessageQa } from "./fixtures/user-message-qa";

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

describe("integrated hybrid monitor", () => {
  it("preserves the exact path-containing reading request as whole source evidence", async () => {
    const h = fixture([]);
    const reading = userMessageQa.reading;
    h.replace([qaEntry(reading, null)]);
    h.extract.mockResolvedValueOnce({
      text: JSON.stringify(
        addPatch(observation(reading.id, reading.text), [
          "Read and understand the advisory plan",
        ]),
      ),
      provider: "offline",
      model: "fixture",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    h.start();
    await h.settle(reading.id);
    expect(h.extract.mock.calls[0]?.[0].latest.id).toBe(reading.id);
    expect(h.extract.mock.calls[0]?.[0].latest.text).toBe(reading.text);
    expect(h.monitor.state.tasks.map((task) => task.label)).toEqual([
      "Read and understand the advisory plan",
    ]);
  });
  it("runs the actual hybrid transaction and independent completion from canonical branch observations", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    expect(h.extract).toHaveBeenCalledTimes(1);
    expect(h.monitor.state.tasks).toHaveLength(3);
    h.append(
      "delivered",
      "Regression and validation complete; parser unfinished.",
    );
    await h.settle("delivered");
    expect(h.extract).toHaveBeenCalledTimes(1);
    expect(h.monitor.state.tasks.map((task) => task.status)).toEqual([
      "not-started",
      "done",
      "done",
    ]);
    expect(h.monitor.presentationSnapshot()).toMatchObject({
      enabled: true,
      progress: { done: 2, total: 3 },
    });
    expect(h.monitor.checkpoint()).toMatchObject({ version: 7 });
    expect(
      h.requests.every(
        (request) =>
          !("source" in request.questions) && !("scope" in request.questions),
      ),
    ).toBe(true);
  });
  it("is idle without eligible evidence and never gains interval controls", async () => {
    const h = fixture([]);
    h.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.extract).not.toHaveBeenCalled();
    expect(h.monitor).not.toHaveProperty("interval");
    h.replace([
      { type: "custom", id: "custom", data: "SECRET" },
      {
        type: "message",
        id: "tool",
        message: { role: "toolResult", content: "SECRET" },
      },
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("does not rebill duplicate observations, display reads or idle time", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    const calls = h.fetch.mock.calls.length;
    const models = h.extract.mock.calls.length;
    const saves = h.save.mock.calls.length;
    for (let i = 0; i < 5; i++) {
      h.observe();
      h.monitor.presentationSnapshot();
      h.monitor.debugSnapshot();
    }
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.fetch).toHaveBeenCalledTimes(calls);
    expect(h.extract).toHaveBeenCalledTimes(models);
    expect(h.save).toHaveBeenCalledTimes(saves);
  });
  it("retains a held extraction in one flight while later work queues", async () => {
    const h = fixture();
    const original = h.extract.getMockImplementation();
    if (!original) throw new Error("Missing model fake");
    let release: (() => void) | undefined;
    h.extract.mockImplementationOnce(
      (input, signal) =>
        new Promise((resolve) => {
          release = () => {
            void original(input, signal).then(resolve);
          };
        }),
    );
    h.start();
    await vi.advanceTimersByTimeAsync(30);
    expect(release).toBeDefined();
    const calls = h.fetch.mock.calls.length;
    h.append(
      "delivered",
      "Regression and validation complete; parser unfinished.",
    );
    await vi.advanceTimersByTimeAsync(30);
    expect(h.fetch).toHaveBeenCalledTimes(calls);
    expect(h.extract).toHaveBeenCalledTimes(1);
    release?.();
    await h.settle("delivered");
    expect(h.monitor.state.tasks.map((task) => task.status)).toEqual([
      "not-started",
      "done",
      "done",
    ]);
  });
  it("OFF aborts selected-model work and rejects a late provider result", async () => {
    const h = fixture();
    const original = h.extract.getMockImplementation();
    if (!original) throw new Error("Missing fake");
    let signal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    h.extract.mockImplementationOnce(
      (input, current) =>
        new Promise((resolve) => {
          signal = current;
          release = () => {
            void original(input, current).then(resolve);
          };
        }),
    );
    h.start();
    await vi.advanceTimersByTimeAsync(30);
    expect(release).toBeDefined();
    h.monitor.turnOff();
    const state = structuredClone(h.monitor.state);
    const calls = h.fetch.mock.calls.length;
    expect(signal?.aborted).toBe(true);
    release?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.monitor.state).toEqual(state);
    expect(h.fetch).toHaveBeenCalledTimes(calls);
    expect(h.monitor.enabled).toBe(false);
  });
  it("restores a settled checkpoint without re-extracting or rebilling", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    const checkpoint = h.monitor.checkpoint();
    const ids = h.monitor.state.tasks.map((task) => task.id);
    const calls = h.fetch.mock.calls.length;
    const models = h.extract.mock.calls.length;
    await h.monitor.restore("/nonexistent-hybrid-test", checkpoint);
    await h.settle("goal");
    expect(h.monitor.state.tasks.map((task) => task.id)).toEqual(ids);
    expect(h.extract).toHaveBeenCalledTimes(models);
    expect(h.fetch).toHaveBeenCalledTimes(calls);
  });
  it("clears prior-session tasks on restore without a checkpoint", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    h.monitor.turnOff();
    h.replace([]);
    await h.monitor.restore("/new-session", undefined);
    expect(h.monitor.state.tasks).toEqual([]);
    expect(JSON.stringify(h.monitor.presentationSnapshot())).not.toContain(
      "Implement parser",
    );
  });
  it("does not attribute tool work or completion merely from display focus", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    expect(h.monitor.state.focusTaskId).toBeDefined();
    expect(h.monitor.evidenceLink()).toBeUndefined();
    h.monitor.observeToolStart("unlinked", "bash", { command: "npm test" });
    h.monitor.observeToolEnd(
      "unlinked",
      "bash",
      { content: [{ type: "text", text: "AssertionError: expected true" }] },
      true,
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(
      h.monitor.state.tasks.every((task) => task.status === "not-started"),
    ).toBe(true);
    expect(JSON.stringify(h.monitor.presentationSnapshot())).not.toContain(
      "Observed red",
    );
  });
  it("exposes the five conservative health fields and separate provider usage", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    const view = h.monitor.presentationSnapshot();
    expect(view.card?.health).toMatchObject({
      requirements: expect.any(String),
      acceptance: expect.any(String),
      newRedTest: expect.any(String),
      redEvidence: expect.any(String),
      implementation: expect.any(String),
    });
    expect(h.requests.some((request) => "clarity" in request.questions)).toBe(
      true,
    );
    expect(view.usage).toMatchObject({
      jev: { inputTokens: expect.any(Number) },
      extraction: { inputTokens: 3, outputTokens: 2 },
    });
    expect(view.lastJevCallAt).toEqual(expect.any(Number));
    expect(view.lastExtractionCallAt).toEqual(expect.any(Number));
  });
});

describe("pure safe display publication groundwork", () => {
  it.each(["addition", "wording-only"])(
    "retains coherent label and five assessed values while %s health is pending",
    async (kind) => {
      const h = fixture();
      h.start();
      await h.settle("goal");
      const before = structuredClone(h.monitor.presentationSnapshot().card);
      expect(before?.health).toBeDefined();
      const text = "Also investigate the extension lifecycle.";
      const patch =
        kind === "addition"
          ? addPatch(observation("extra", text), [
              "Investigate extension lifecycle",
            ])
          : {
              ...noPatch(),
              revise: [
                {
                  id: "task:1",
                  label: "Implement a carefully documented parser",
                  requirementsChanged: false,
                  quote: text,
                },
              ],
            };
      h.extract.mockResolvedValueOnce({
        text: JSON.stringify(patch),
        provider: "offline",
        model: "fixture",
        usage: { inputTokens: 3, outputTokens: 2 },
      });
      const original = h.fetch.getMockImplementation();
      if (!original) throw new Error("Missing fetch");
      let release: (() => void) | undefined;
      h.fetch.mockImplementation(async (url, init) => {
        const request = JSON.parse(String(init?.body));
        if (request.questions.clarity)
          return new Promise<Response>((resolve) => {
            release = () => {
              void original(url, init).then(resolve);
            };
          });
        const response = await original(url, init);
        if (!request.questions.focus || kind !== "addition") return response;
        const body = (await response.json()) as {
          answers: Record<string, unknown>;
        };
        body.answers.focus = {
          type: "choice",
          choice: "task:4",
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(request.questions.focus.criteria).map((key) => [
              key,
              key === "task:4" ? 1 : 0,
            ]),
          ),
        };
        return Response.json(body);
      });
      h.append("extra", text, "user");
      await vi.advanceTimersByTimeAsync(100);
      expect(release).toBeDefined();
      const pending = h.monitor.presentationSnapshot().card;
      expect(pending?.label).toBe(before?.label);
      expect(pending?.health).toEqual(before?.health);
      expect(pending).toMatchObject({
        retained: true,
        replacementPending: true,
      });
      release?.();
      await vi.advanceTimersByTimeAsync(50);
      expect(h.monitor.presentationSnapshot().card?.label).toBe(
        kind === "addition"
          ? "Investigate extension lifecycle"
          : "Implement a carefully documented parser",
      );
    },
  );
  it("returns detached snapshots with no read, write, or scheduling effects", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    const before = [
      h.reader.mock.calls.length,
      h.save.mock.calls.length,
      h.fetch.mock.calls.length,
      h.extract.mock.calls.length,
      h.changed.mock.calls.length,
    ];
    const state = structuredClone(h.monitor.state);
    for (let i = 0; i < 10; i++) {
      h.monitor.presentationSnapshot();
      h.monitor.debugSnapshot();
    }
    expect([
      h.reader.mock.calls.length,
      h.save.mock.calls.length,
      h.fetch.mock.calls.length,
      h.extract.mock.calls.length,
      h.changed.mock.calls.length,
    ]).toEqual(before);
    expect(h.monitor.state).toEqual(state);
    const copied = h.monitor.presentationSnapshot();
    if (copied.card) copied.card.label = "mutated presentation";
    expect(JSON.stringify(h.monitor.presentationSnapshot())).not.toContain(
      "mutated presentation",
    );
  });
  it("does not expose labels, IDs, source text or arbitrary provider exceptions in diagnostic projection", async () => {
    const h = fixture([branchEntry("secret", "PRIVATE_SOURCE_SENTINEL")]);
    h.extract.mockRejectedValue(
      new Error("Bearer PRIVATE_KEY_SENTINEL /provider PRIVATE_REPLY_SENTINEL"),
    );
    h.start();
    await vi.advanceTimersByTimeAsync(100);
    const safe = JSON.stringify(h.monitor.debugSnapshot());
    expect(safe).not.toMatch(/PRIVATE_|task:|session:test/);
    expect(JSON.stringify(h.monitor.presentationSnapshot())).not.toMatch(
      /PRIVATE_KEY_SENTINEL|PRIVATE_REPLY_SENTINEL/,
    );
    expect(h.monitor.enabled).toBe(true);
  });
  it("publishes terminal idle and OFF and isolates a throwing display observer", async () => {
    const h = fixture();
    h.changed.mockImplementation(() => {
      throw new Error("Renderer failed");
    });
    h.start();
    await h.settle("goal");
    expect(h.monitor.debugSnapshot()).toMatchObject({
      processing: "idle",
      enabled: true,
    });
    h.changed.mockReset();
    h.monitor.turnOff();
    expect(h.changed).toHaveBeenCalled();
    expect(h.monitor.debugSnapshot()).toMatchObject({ enabled: false });
  });
});
