import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EvaluationRequest } from "../src/analysis/gateway";
import type { encodeCheckpoint } from "../src/core/hybrid-checkpoint";
import { coverageNames } from "./fixtures/coverage";
import { branchEntry, monitorHarness } from "./fixtures/hybrid-monitor";

const text = "Review every tab in docs/plan.xlsx and summarize the workbook.";
const reportText =
  "I reviewed all tabs in docs/plan.xlsx; synthesis is still pending.";
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
function answer(request: EvaluationRequest, choice: string) {
  return Response.json({
    model: request.model,
    usage: { input_tokens: 7, output_tokens: 3 },
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([key, question]) => {
        if (question.type !== "choice") throw new Error("Expected choices");
        return [
          key,
          {
            type: "choice",
            choice,
            confidence: 1,
            probabilities: Object.fromEntries(
              Object.keys(question.criteria).map((value) => [
                value,
                value === choice ? 1 : 0,
              ]),
            ),
          },
        ];
      }),
    ),
  });
}
async function fixture(
  details = false,
  failIntent: boolean | "malformed" | "persist" = false,
) {
  const h = monitorHarness([branchEntry("goal", text)], {
    richDetailsEnabled: details,
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
            add: input.tasks.length
              ? []
              : [
                  {
                    label: "Summarize workbook",
                    kind: "response",
                    basis: "explicit",
                    quote: text,
                    ...(details ? { details: { title: { quote: text } } } : {}),
                  },
                ],
            revise: [],
            archive: [],
            restore: [],
            unresolved: false,
          }),
  });
  running.push(h);
  const calls: EvaluationRequest[] = [];
  const all: EvaluationRequest[] = [];
  let choice = "reviewed";
  let transport:
    | ((request: EvaluationRequest, init?: RequestInit) => Promise<Response>)
    | undefined;
  const original = h.fetch.getMockImplementation();
  if (!original) throw new Error("Missing transport");
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body)) as EvaluationRequest;
    all.push(request);
    if (
      !Object.keys(request.questions).some((key) => key.startsWith("coverage:"))
    )
      return original(url, init);
    calls.push(request);
    return transport ? transport(request, init) : answer(request, choice);
  });
  if (failIntent === "persist") {
    let denied = false;
    h.save.mockImplementation((value) => {
      if (
        !denied &&
        (value as ReturnType<typeof encodeCheckpoint>).monitor?.coverage
          ?.intents?.accepted.length
      ) {
        denied = true;
        throw new Error("intent receipt storage denied once");
      }
    });
  }
  if (failIntent && failIntent !== "persist") {
    const extract = h.extract.getMockImplementation();
    let failed = false;
    if (!extract) throw new Error("Missing extractor");
    h.extract.mockImplementation(async (input, signal, onDispatch) => {
      if (input.instructions.includes("parentIndices") && !failed) {
        failed = true;
        onDispatch?.(Date.now());
        if (failIntent === "malformed")
          return {
            text: "{invalid-json",
            provider: "offline",
            model: "fixture",
            usage: { inputTokens: 3, outputTokens: 2 },
          };
        throw new Error("temporary extraction failure");
      }
      return extract(input, signal, onDispatch);
    });
  }
  h.start();
  await h.settle("goal");
  await vi.advanceTimersByTimeAsync(200);
  if (failIntent) {
    h.monitor.modelSelected();
    await vi.advanceTimersByTimeAsync(200);
    expect(
      h.extract.mock.calls.filter(([input]) =>
        input.instructions.includes("parentIndices"),
      ),
    ).toHaveLength(2);
  }
  h.monitor.observeCoverageToolStart("manifest", "bash", {
    command: "unzip -p docs/plan.xlsx xl/workbook.xml",
  });
  h.monitor.observeCoverageToolEnd("manifest", "bash");
  h.replace([
    ...h.reader(),
    {
      type: "message",
      id: "manifest-result",
      message: {
        role: "toolResult",
        toolCallId: "manifest",
        toolName: "bash",
        isError: false,
        content: [
          {
            type: "text",
            text: `<workbook><sheets>${coverageNames.map((name) => `<sheet name="${name}"/>`).join("")}</sheets></workbook>`,
          },
        ],
      },
    },
  ]);
  h.monitor.confirmCoverageBranch(h.reader());
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.coverageSnapshot().groups[0].children).toHaveLength(22);
  calls.splice(0);
  all.splice(0);
  return {
    ...h,
    calls,
    all,
    setChoice: (value: string) => {
      choice = value;
    },
    setTransport: (value: typeof transport) => {
      transport = value;
    },
    checkpoint: () =>
      h.monitor.checkpoint() as ReturnType<typeof encodeCheckpoint>,
  };
}
async function restoreBeforeInventory(h: Awaited<ReturnType<typeof fixture>>) {
  const saved = h.save.mock.calls
    .map(([value]) => value as ReturnType<typeof encodeCheckpoint>)
    .filter(
      (value) =>
        value.monitor?.coverage?.state.groups.length === 0 &&
        (value.monitor.coverage.intents?.accepted.length ?? 0) > 0,
    )
    .at(-1);
  if (!saved) throw new Error("Missing accepted pre-inventory checkpoint");
  h.replace([branchEntry("goal", text)]);
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  expect(h.monitor.coverageSnapshot().groups).toHaveLength(0);
}
async function addUncoveredParent(h: Awaited<ReturnType<typeof fixture>>) {
  const extract = h.extract.getMockImplementation();
  if (!extract) throw new Error("Missing extractor");
  const quote = "Also summarize the second workbook.";
  h.extract.mockImplementation(async (input, signal, onDispatch) => {
    if (
      input.latest.id !== "extra" ||
      input.instructions.includes("parentIndices")
    )
      return extract(input, signal, onDispatch);
    onDispatch?.(Date.now());
    return {
      text: JSON.stringify({
        add: [
          {
            label: "Second workbook summary",
            kind: "response",
            basis: "explicit",
            quote,
          },
        ],
        revise: [],
        archive: [],
        restore: [],
        unresolved: false,
      }),
      provider: "offline",
      model: "fixture",
      usage: { inputTokens: 3, outputTokens: 2 },
    };
  });
  h.append("extra", quote, "user");
  await h.settle("extra");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.state.tasks).toHaveLength(2);
  h.extract.mockImplementation(extract);
}
it.each([true, "malformed", "persist"] as const)(
  "explicit model recovery resumes paid intent failure (%s) without mandatory re-extraction",
  async (failure) => {
    await fixture(false, failure);
  },
);
it.each([false, true])(
  "coalesces a same-parent resource backlog before optional dispatch (vary resource=%s)",
  async (varyResource) => {
    const h = await fixture();
    h.setChoice("unchanged");
    await addUncoveredParent(h);
    const extract = h.extract.getMockImplementation();
    if (!extract) throw new Error("Missing extractor");
    h.extract.mockImplementation(async (input, signal, onDispatch) => {
      if (input.instructions.includes("parentIndices")) {
        onDispatch?.(Date.now());
        return {
          text: '{"intents":[]}',
          provider: "offline",
          model: "fixture",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      return extract(input, signal, onDispatch);
    });
    h.replace([
      ...h.reader(),
      ...[0, 1, 2].map((i) =>
        branchEntry(
          `burst-${i}`,
          `Review all tabs in docs/second-${varyResource ? i : "shared"}.xlsx. Updated instruction ${i}.`,
        ),
      ),
    ]);
    await h.settle("burst-2");
    await vi.advanceTimersByTimeAsync(200);
    expect(
      h.extract.mock.calls.filter(
        ([input]) =>
          input.instructions.includes("parentIndices") &&
          input.latest.id.startsWith("burst-"),
      ),
    ).toHaveLength(1);
    expect(h.monitor.coverageSnapshot().omissions).toBeGreaterThanOrEqual(2);
  },
);
it("never resumes an older report from the semantic-commit supersession crash window", async () => {
  const h = await fixture();
  h.setTransport(() => new Promise<Response>(() => {}));
  h.append("older", reportText);
  await h.settle("older");
  await vi.advanceTimersByTimeAsync(100);
  h.append("newer", "I retract all earlier workbook review claims.");
  await h.settle("newer");
  await vi.advanceTimersByTimeAsync(100);
  const saved = h.save.mock.calls
    .map(([value]) => value as ReturnType<typeof encodeCheckpoint>)
    .find(
      (value) =>
        value.state.cursor?.id === "newer" &&
        value.monitor?.coverage?.jobs?.some(
          (job) => job.source.entryId === "older",
        ),
    );
  // Atomic supersession may eliminate this intermediate checkpoint altogether.
  if (!saved) return;
  h.setTransport(undefined);
  h.calls.splice(0);
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  await vi.advanceTimersByTimeAsync(200);
  expect(
    h.calls.some(
      (request) =>
        (request.state as { report: { id: string } }).report.id === "older",
    ),
  ).toBe(false);
});
it("retains coalescing omissions through same-version reload", async () => {
  const h = await fixture();
  h.setTransport(() => new Promise<Response>(() => {}));
  h.append("older", reportText);
  await h.settle("older");
  await vi.advanceTimersByTimeAsync(100);
  h.append("newer", "I retract all earlier workbook review claims.");
  await h.settle("newer");
  await vi.advanceTimersByTimeAsync(100);
  const omissions = h.monitor.coverageSnapshot().omissions;
  expect(omissions).toBeGreaterThan(0);
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    h.checkpoint(),
    false,
    h.reader,
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.coverageSnapshot().omissions).toBe(omissions);
});
it("records report dispatch time rather than response completion time", async () => {
  const h = await fixture();
  let dispatched = 0;
  let release: (() => void) | undefined;
  h.setTransport((request) => {
    dispatched = Date.now();
    return new Promise<Response>((resolve) => {
      release = () => resolve(answer(request, "reviewed"));
    });
  });
  h.append("report", reportText);
  await h.settle("report");
  await vi.advanceTimersByTimeAsync(100);
  const started = dispatched;
  await vi.advanceTimersByTimeAsync(2000);
  release?.();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.checkpoint().monitor?.coverage?.reportReceipts?.[0].at).toBe(
    started,
  );
});
it("retains content-free per-dispatch proof for selected-model intent", async () => {
  const start = Date.now();
  const h = await fixture();
  function records(value: unknown): Record<string, unknown>[] {
    if (!value || typeof value !== "object") return [];
    return [
      value as Record<string, unknown>,
      ...Object.values(value).flatMap(records),
    ];
  }
  const coverage = h.checkpoint().monitor?.coverage;
  const receipt = records(coverage).find(
    (record) => typeof record.requestHash === "string" && record.dispatch === 1,
  );
  expect(receipt).toMatchObject({
    requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    dispatch: 1,
    at: expect.any(Number),
    usage: { inputTokens: 3, outputTokens: 2 },
    outcome: "accepted",
  });
  expect(Number(receipt?.at)).toBeGreaterThanOrEqual(start);
  expect(Number(receipt?.at)).toBeLessThanOrEqual(Date.now());
  expect(receipt?.identity ?? receipt?.jobIdentity).toBe(
    coverage?.intents?.accepted[0].identity,
  );
});
it("journal saturation either admits later intent or exposes an explicit omission", async () => {
  const h = await fixture();
  h.setChoice("unchanged");
  await addUncoveredParent(h);
  const extract = h.extract.getMockImplementation();
  if (!extract) throw new Error("Missing extractor");
  h.extract.mockImplementation(async (input, signal, onDispatch) => {
    if (input.instructions.includes("parentIndices")) {
      onDispatch?.(Date.now());
      return {
        text: '{"intents":[]}',
        provider: "offline",
        model: "fixture",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    return extract(input, signal, onDispatch);
  });
  for (let i = 0; i < 21; i++) {
    h.append(`candidate-${i}`, "Review all tabs in docs/second.xlsx.", "user");
    await h.settle(`candidate-${i}`);
    await vi.advanceTimersByTimeAsync(100);
  }
  const calls = h.extract.mock.calls.filter(([input]) =>
    input.instructions.includes("parentIndices"),
  ).length;
  expect(calls === 22 || h.monitor.coverageSnapshot().omissions > 0).toBe(true);
});
it("later intent does not leapfrog an earlier report queue position", async () => {
  const h = await fixture();
  h.setChoice("unchanged");
  await addUncoveredParent(h);
  const order: string[] = [];
  const extract = h.extract.getMockImplementation();
  if (!extract) throw new Error("Missing extractor");
  h.extract.mockImplementation(async (input, signal, onDispatch) => {
    if (!input.instructions.includes("parentIndices"))
      return extract(input, signal, onDispatch);
    order.push("intent");
    onDispatch?.(Date.now());
    return {
      text: '{"intents":[]}',
      provider: "offline",
      model: "fixture",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  h.setTransport(async (request) => {
    order.push("report");
    return answer(request, "unchanged");
  });
  h.replace([
    ...h.reader(),
    branchEntry("early-report", "I reviewed Overview.", "assistant"),
    branchEntry("later-intent", "Review all tabs in docs/second.xlsx."),
  ]);
  await h.settle("later-intent");
  await vi.advanceTimersByTimeAsync(200);
  expect(order).toContain("intent");
  expect(order[0]).toBe("report");
});
it("newer report fences dispatch1024 even when replacement cannot dispatch", async () => {
  const h = await fixture();
  const saved = h.checkpoint();
  if (!saved.monitor?.coverage) throw new Error("Missing coverage");
  saved.monitor.coverage.dispatches = 1023;
  saved.monitor.coverage.usage.jev.calls =
    1023 - saved.monitor.coverage.usage.extraction.calls;
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  let release: (() => void) | undefined;
  h.setTransport(
    (request) =>
      new Promise<Response>((resolve) => {
        release = () => resolve(answer(request, "reviewed"));
      }),
  );
  h.append("older", reportText);
  await h.settle("older");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.calls).toHaveLength(1);
  h.append("newer", "I retract all prior workbook review claims.");
  await h.settle("newer");
  release?.();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.calls).toHaveLength(1);
  expect(
    h.monitor
      .coverageSnapshot()
      .groups[0].children.every((child) => child.status === "pending"),
  ).toBe(true);
});
it("oversized canonical report records one durable omission without a provider call", async () => {
  const h = await fixture();
  const before = h.monitor.coverageSnapshot().omissions;
  h.append("oversized-report", `I reviewed Overview. ${"x".repeat(13000)}`);
  await h.settle("oversized-report");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.calls).toHaveLength(0);
  expect(h.monitor.coverageSnapshot().omissions).toBe(before + 1);
  const saved = h.checkpoint();
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  h.observe();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.coverageSnapshot().omissions).toBe(before + 1);
});
it("rejects cached stale intent before spending after a queued parent revision", async () => {
  const h = await fixture();
  h.setChoice("unchanged");
  await addUncoveredParent(h);
  const extract = h.extract.getMockImplementation();
  if (!extract) throw new Error("Missing extractor");
  const quote = "Change the second summary to a risk register.";
  h.extract.mockImplementation(async (input, signal, onDispatch) => {
    if (input.instructions.includes("parentIndices")) {
      onDispatch?.(Date.now());
      return {
        text: '{"intents":[]}',
        provider: "offline",
        model: "fixture",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    if (input.latest.id !== "secret") return extract(input, signal, onDispatch);
    onDispatch?.(Date.now());
    return {
      text: JSON.stringify({
        add: [],
        revise: [
          {
            id: "task:2",
            label: "Second risk register",
            requirementsChanged: true,
            quote,
          },
        ],
        archive: [],
        restore: [],
        unresolved: false,
      }),
      provider: "offline",
      model: "fixture",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  h.replace([
    ...h.reader(),
    branchEntry("stale-intent", "Review every tab in docs/second.xlsx."),
    branchEntry("secret", quote),
  ]);
  await h.settle("secret");
  await vi.advanceTimersByTimeAsync(200);
  expect(h.monitor.state.tasks[1].revision).toBe(2);
  expect(
    h.extract.mock.calls.filter(
      ([input]) =>
        input.instructions.includes("parentIndices") &&
        input.latest.id === "stale-intent",
    ),
  ).toHaveLength(0);
});
it("newer intent fences selected-model dispatch1024 before its late result is accepted", async () => {
  const h = await fixture();
  const saved = h.save.mock.calls
    .map(([value]) => value as ReturnType<typeof encodeCheckpoint>)
    .filter(
      (value) =>
        value.monitor?.coverage?.state.groups.length === 0 &&
        (value.monitor.coverage.intents?.accepted.length ?? 0) > 0,
    )
    .at(-1);
  if (!saved?.monitor?.coverage)
    throw new Error("Missing pre-inventory intent checkpoint");
  saved.monitor.coverage.dispatches = 1023;
  saved.monitor.coverage.usage.jev.calls =
    1023 - saved.monitor.coverage.usage.extraction.calls;
  h.replace([branchEntry("goal", text)]);
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  const extract = h.extract.getMockImplementation();
  if (!extract) throw new Error("Missing extractor");
  let release: (() => void) | undefined;
  h.extract.mockImplementation(async (input, signal, onDispatch) => {
    if (!input.instructions.includes("parentIndices"))
      return extract(input, signal, onDispatch);
    onDispatch?.(Date.now());
    return new Promise((resolve) => {
      release = () =>
        resolve({
          text: JSON.stringify({
            intents: [
              {
                parentIndices: [0],
                quote: input.latest.text,
                resource: "docs/old.xlsx",
                kind: "unconditional-enumerable",
              },
            ],
          }),
          provider: "offline",
          model: "fixture",
          usage: { inputTokens: 3, outputTokens: 2 },
        });
    });
  });
  h.append("older-intent", "Review every tab in docs/old.xlsx.", "user");
  await h.settle("older-intent");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.checkpoint().monitor?.coverage?.dispatches).toBe(1024);
  expect(release).toBeDefined();
  h.append(
    "newer-intent",
    "Review every tab in docs/new.xlsx instead.",
    "user",
  );
  await h.settle("newer-intent");
  release?.();
  await vi.advanceTimersByTimeAsync(100);
  expect(
    h
      .checkpoint()
      .monitor?.coverage?.intents?.accepted.some(
        (receipt) => receipt.source.entryId === "older-intent",
      ),
  ).toBe(false);
});
it("normalizes mixed permanent/ready owner overlaps on restore before newer work completes", async () => {
  const h = await fixture();
  await restoreBeforeInventory(h);
  const extract = h.extract.getMockImplementation();
  if (!extract) throw new Error("Missing extractor");
  let malformed = true;
  h.extract.mockImplementation(async (input, signal, onDispatch) => {
    if (!input.instructions.includes("parentIndices"))
      return extract(input, signal, onDispatch);
    onDispatch?.(Date.now());
    return {
      text: malformed ? "{bad-json" : '{"intents":[]}',
      provider: "offline",
      model: "fixture",
      usage: { inputTokens: 3, outputTokens: 2 },
    };
  });
  h.append("older-owner", "Review every tab in docs/old.xlsx.", "user");
  await h.settle("older-owner");
  await vi.advanceTimersByTimeAsync(100);
  const older = h
    .checkpoint()
    .monitor?.coverage?.intentJobs?.find(
      (job) => job.source.entryId === "older-owner",
    );
  expect(older?.state).toBe("permanent");
  await addUncoveredParent(h);
  h.append("newer-owner", "Review every tab in docs/new.xlsx.", "user");
  await h.settle("newer-owner");
  await vi.advanceTimersByTimeAsync(100);
  const saved = h.checkpoint();
  const coverage = saved.monitor?.coverage;
  const newer = coverage?.intentJobs?.find(
    (job) => job.source.entryId === "newer-owner",
  );
  if (!older || !newer || !coverage) throw new Error("Missing owner jobs");
  expect(older.owners).toHaveLength(1);
  expect(newer.owners).toHaveLength(2);
  // Legal persisted mixed state: old permanent owner is unqueued; newer owner ready.
  newer.state = "ready";
  coverage.intentJobs = [older, newer];
  coverage.queue = [{ kind: "intent", key: newer.targetKey }];
  malformed = false;
  const before = h.extract.mock.calls.length;
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  await vi.advanceTimersByTimeAsync(200);
  h.monitor.modelSelected();
  await vi.advanceTimersByTimeAsync(200);
  expect(
    h.extract.mock.calls
      .slice(before)
      .filter(([input]) => input.instructions.includes("parentIndices"))
      .map(([input]) => input.latest.id),
  ).toEqual(["newer-owner"]);
});
it("inventory admission fences a held competing intent before accepting its response", async () => {
  const h = await fixture();
  await restoreBeforeInventory(h);
  const extract = h.extract.getMockImplementation();
  if (!extract) throw new Error("Missing extractor");
  let release: (() => void) | undefined;
  h.extract.mockImplementation(async (input, signal, onDispatch) => {
    if (!input.instructions.includes("parentIndices"))
      return extract(input, signal, onDispatch);
    onDispatch?.(Date.now());
    return new Promise((resolve) => {
      release = () =>
        resolve({
          text: JSON.stringify({
            intents: [
              {
                parentIndices: [0],
                quote: input.latest.text,
                resource: "docs/new.xlsx",
                kind: "unconditional-enumerable",
              },
            ],
          }),
          provider: "offline",
          model: "fixture",
          usage: { inputTokens: 3, outputTokens: 2 },
        });
    });
  });
  h.append("held-intent", "Review every tab in docs/new.xlsx.", "user");
  await h.settle("held-intent");
  await vi.advanceTimersByTimeAsync(100);
  expect(release).toBeDefined();
  const spent = h.checkpoint().monitor?.coverage?.dispatches;
  h.monitor.observeCoverageToolStart("late-inventory", "bash", {
    command: "unzip -p docs/plan.xlsx xl/workbook.xml",
  });
  h.monitor.observeCoverageToolEnd("late-inventory", "bash");
  h.replace([
    ...h.reader(),
    {
      type: "message",
      id: "late-inventory-result",
      message: {
        role: "toolResult",
        toolCallId: "late-inventory",
        toolName: "bash",
        isError: false,
        content: [
          {
            type: "text",
            text: `<workbook><sheets>${coverageNames.map((name) => `<sheet name="${name}"/>`).join("")}</sheets></workbook>`,
          },
        ],
      },
    },
  ]);
  h.monitor.confirmCoverageBranch(h.reader());
  expect(h.monitor.coverageSnapshot().groups[0]?.children).toHaveLength(22);
  release?.();
  await vi.advanceTimersByTimeAsync(100);
  expect(
    h
      .checkpoint()
      .monitor?.coverage?.intents?.accepted.some(
        (receipt) => receipt.source.entryId === "held-intent",
      ),
  ).toBe(false);
  expect(h.checkpoint().monitor?.coverage?.dispatches).toBe(spent);
});
it("schedules20+2report judgments after semantics/readyhealth with isolated usage", async () => {
  const h = await fixture();
  const before = h.checkpoint().monitor?.coverage;
  h.append("report", reportText);
  await h.settle("report");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.calls.map((call) => Object.keys(call.questions).length)).toEqual([
    20, 2,
  ]);
  const first = h.all.findIndex((request) =>
    Object.keys(request.questions).some((key) => key.startsWith("coverage:")),
  );
  const health = h.all.reduce(
    (last, request, index) => ("clarity" in request.questions ? index : last),
    -1,
  );
  expect(health).toBeGreaterThanOrEqual(0);
  expect(first).toBeGreaterThan(health);
  expect(
    h.monitor
      .coverageSnapshot()
      .groups[0].children.every(
        (child) => child.status === "reported-reviewed",
      ),
  ).toBe(true);
  expect(h.monitor.state.tasks[0].status).toBe("not-started");
  const saved = h.checkpoint().monitor?.coverage;
  expect(saved?.dispatches).toBe((before?.dispatches ?? 0) + 2);
  expect(saved?.usage.jev.calls).toBe((before?.usage.jev.calls ?? 0) + 2);
  expect(saved?.usage.jev.inputTokens).toBe(
    (before?.usage.jev.inputTokens ?? 0) + 14,
  );
  expect(JSON.stringify(saved)).not.toContain(reportText);
});
it.each(["reviewed", "unchanged", "uncertain"])(
  "does not rebill accepted %s chunks on redraw, wake, or reload",
  async (choice) => {
    const h = await fixture();
    h.setChoice(choice);
    h.append("report", reportText);
    await h.settle("report");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.calls).toHaveLength(2);
    const saved = h.checkpoint();
    const before = h.calls.length;
    for (let i = 0; i < 3; i++) {
      h.monitor.coverageSnapshot();
      h.monitor.boardSnapshot();
      h.observe();
    }
    await vi.advanceTimersByTimeAsync(100);
    await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.calls).toHaveLength(before);
  },
);
it("resumes only unfinished report chunks after transport failure and reload", async () => {
  const h = await fixture();
  h.setTransport(async (request) =>
    h.calls.length === 2
      ? new Response("unavailable", { status: 503 })
      : answer(request, "reviewed"),
  );
  h.append("report", reportText);
  await h.settle("report");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.calls).toHaveLength(2);
  expect(
    h.monitor
      .coverageSnapshot()
      .groups[0].children.filter(
        (child) => child.status === "reported-reviewed",
      ),
  ).toHaveLength(20);
  const saved = h.checkpoint();
  h.setTransport(undefined);
  const before = h.calls.length;
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  await vi.advanceTimersByTimeAsync(11000);
  h.observe();
  await vi.advanceTimersByTimeAsync(100);
  expect(
    h.calls
      .slice(before)
      .map((request) => Object.keys(request.questions).length),
  ).toEqual([2]);
  expect(
    h.monitor
      .coverageSnapshot()
      .groups[0].children.every(
        (child) => child.status === "reported-reviewed",
      ),
  ).toBe(true);
});
it("parks retryable failures until deadline AND a named wake, never timer-polls", async () => {
  const h = await fixture();
  h.setTransport(async () => new Response("unavailable", { status: 503 }));
  h.append("report", reportText);
  await h.settle("report");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.calls).toHaveLength(1);
  const spent = h.checkpoint().monitor?.coverage?.dispatches;
  await vi.advanceTimersByTimeAsync(60000);
  expect(h.calls).toHaveLength(1);
  h.observe();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.calls).toHaveLength(2);
  expect(h.checkpoint().monitor?.coverage?.dispatches).toBe((spent ?? 0) + 1);
});
it("enforces1024dispatch cap including failures and leaves incomplete child statuses visible", async () => {
  const h = await fixture();
  const saved = h.checkpoint();
  if (!saved.monitor?.coverage) throw new Error("Missing coverage");
  saved.monitor.coverage.dispatches = 1023;
  saved.monitor.coverage.usage.jev.calls =
    1023 - saved.monitor.coverage.usage.extraction.calls;
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  h.append("report", reportText);
  await h.settle("report");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.calls).toHaveLength(1);
  expect(h.checkpoint().monitor?.coverage?.dispatches).toBe(1024);
  const children = h.monitor.coverageSnapshot().groups[0].children;
  expect(
    children.filter((child) => child.status === "reported-reviewed"),
  ).toHaveLength(20);
  expect(children.filter((child) => child.status === "pending")).toHaveLength(
    2,
  );
  expect(h.monitor.coverageSnapshot()).toMatchObject({ exhausted: true });
  await h.monitor.restore(
    "/nonexistent-hybrid-test",
    h.checkpoint(),
    false,
    h.reader,
  );
  expect(h.monitor.coverageSnapshot()).toMatchObject({ exhausted: true });
  h.observe();
  await vi.advanceTimersByTimeAsync(60000);
  expect(h.calls).toHaveLength(1);
});
it("gives ready detail work an opportunity between coverage chunks after finite higher-priority work", async () => {
  const h = await fixture(true);
  h.setTransport(() => new Promise<Response>(() => {}));
  h.append("report", reportText);
  await h.settle("report");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.calls).toHaveLength(1);
  const saved = h.checkpoint();
  const details = saved.monitor?.taskDetails as
    | { candidates: { key: string }[]; receipts: unknown[] }[]
    | undefined;
  expect(details?.length).toBeGreaterThan(0);
  if (!details) throw new Error("Missing details");
  for (const record of details) {
    record.receipts = [];
    record.candidates[0].key = "description";
  }
  h.setTransport(undefined);
  h.all.splice(0);
  h.calls.splice(0);
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  await vi.advanceTimersByTimeAsync(300);
  const optional = h.all.filter((request) =>
    Object.keys(request.questions).some(
      (key) => key.startsWith("coverage:") || key.startsWith("detail:"),
    ),
  );
  const secondCoverage = optional.flatMap((request, index) =>
    Object.keys(request.questions).some((key) => key.startsWith("coverage:"))
      ? [index]
      : [],
  )[1];
  const detail = optional.findIndex((request) =>
    Object.keys(request.questions).some((key) => key.startsWith("detail:")),
  );
  expect(detail).toBeGreaterThanOrEqual(0);
  expect(secondCoverage).toBeGreaterThan(detail);
  expect(h.calls).toHaveLength(2);
});
it("accepts canonical user review reports through the same isolated pipeline", async () => {
  const h = await fixture();
  h.append("report", reportText, "user");
  await h.settle("report");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.calls).toHaveLength(2);
  expect(
    h.monitor
      .coverageSnapshot()
      .groups[0].children.every(
        (child) => child.status === "reported-reviewed",
      ),
  ).toBe(true);
});
it.each([false, true])(
  "existing coverage does not block a second workbook intent (in-flight=%s)",
  async (inFlight) => {
    const h = await fixture();
    if (inFlight) {
      h.setTransport((request) =>
        (request.state as { report: { id: string } }).report.id === "older"
          ? new Promise<Response>(() => {})
          : Promise.resolve(answer(request, "unchanged")),
      );
      h.append("older", reportText);
      await h.settle("older");
      await vi.advanceTimersByTimeAsync(100);
      expect(h.calls).toHaveLength(1);
    }
    const second = "Review every tab in docs/second.xlsx and summarize it.";
    h.extract.mockImplementation(async (input, _signal, onDispatch) => {
      onDispatch?.(Date.now());
      return {
        text: JSON.stringify(
          input.instructions.includes("parentIndices")
            ? {
                intents: [
                  {
                    parentIndices: [1],
                    quote: second,
                    resource: "docs/second.xlsx",
                    kind: "unconditional-enumerable",
                  },
                ],
              }
            : {
                add: [
                  {
                    label: "Second workbook summary",
                    kind: "response",
                    basis: "explicit",
                    quote: second,
                  },
                ],
                revise: [],
                archive: [],
                restore: [],
                unresolved: false,
              },
        ),
        provider: "offline",
        model: "fixture",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });
    h.append("extra", second, "user");
    await h.settle("extra");
    await vi.advanceTimersByTimeAsync(100);
    h.monitor.observeCoverageToolStart("second", "bash", {
      command: "unzip -p docs/second.xlsx xl/workbook.xml",
    });
    h.monitor.observeCoverageToolEnd("second", "bash");
    h.replace([
      ...h.reader(),
      {
        type: "message",
        id: "second-result",
        message: {
          role: "toolResult",
          toolCallId: "second",
          toolName: "bash",
          isError: false,
          content: [
            {
              type: "text",
              text: '<workbook><sheets><sheet name="Overview"/></sheets></workbook>',
            },
          ],
        },
      },
    ]);
    h.monitor.confirmCoverageBranch(h.reader());
    await vi.advanceTimersByTimeAsync(100);
    expect(h.monitor.state.tasks).toHaveLength(2);
    expect(
      h.monitor.coverageSnapshot().groups.map((group) => group.parentTaskId),
    ).toEqual(["task:1", "task:2"]);
  },
);
it("a newer same-parent report fences late old results and exposes coalescing omissions", async () => {
  const h = await fixture();
  let release: (() => void) | undefined;
  h.setTransport((request) =>
    (request.state as { report: { id: string } }).report.id === "older"
      ? new Promise<Response>((resolve) => {
          release = () => resolve(answer(request, "reviewed"));
        })
      : Promise.resolve(answer(request, "retracted")),
  );
  h.append("older", reportText);
  await h.settle("older");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.calls).toHaveLength(1);
  h.append(
    "newer",
    "All previous review claims for this workbook are retracted; every tab remains unfinished.",
  );
  await h.settle("newer");
  const beforeRelease = h.save.mock.calls.length;
  release?.();
  await vi.advanceTimersByTimeAsync(200);
  expect(h.monitor.coverageSnapshot().omissions).toBeGreaterThan(0);
  expect(
    h.monitor
      .coverageSnapshot()
      .groups[0].children.every((child) => child.status === "pending"),
  ).toBe(true);
  expect(
    h.save.mock.calls
      .slice(beforeRelease)
      .every(
        ([value]) =>
          !(
            value as ReturnType<typeof encodeCheckpoint>
          ).monitor?.coverage?.state.groups.some((group) =>
            group.children.some(
              (child) => child.status === "reported-reviewed",
            ),
          ),
      ),
  ).toBe(true);
});
it("parks rejected pre-network admission without a synchronous redispatch loop", async () => {
  const h = await fixture();
  const spent = h.checkpoint().monitor?.coverage?.dispatches ?? 0;
  let attempts = 0;
  h.save.mockImplementation((value) => {
    if (
      ((value as ReturnType<typeof encodeCheckpoint>).monitor?.coverage
        ?.dispatches ?? 0) > spent
    ) {
      attempts++;
      // Bound the buggy microtask loop so this regression can fail without hanging CI.
      if (attempts >= 3) h.monitor.stop();
      throw new Error("coverage storage denied");
    }
  });
  h.append("report", reportText);
  await h.settle("report");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.calls).toHaveLength(0);
  expect(attempts).toBe(1);
  expect(h.monitor.coverageSnapshot().omissions).toBeGreaterThan(0);
});
it("restores accepted intent before inventory arrives without re-extraction", async () => {
  const h = await fixture();
  const saved = h.save.mock.calls
    .map(([value]) => value as ReturnType<typeof encodeCheckpoint>)
    .filter(
      (checkpoint) =>
        checkpoint.monitor?.coverage?.state.groups.length === 0 &&
        (checkpoint.monitor.coverage.usage.extraction.outputTokens ?? 0) > 0,
    )
    .at(-1);
  if (!saved) throw new Error("Missing accepted pre-inventory checkpoint");
  h.replace([branchEntry("goal", text)]);
  await h.monitor.restore("/nonexistent-hybrid-test", saved, false, h.reader);
  const extracts = h.extract.mock.calls.length;
  h.monitor.observeCoverageToolStart("later-manifest", "bash", {
    command: "unzip -p docs/plan.xlsx xl/workbook.xml",
  });
  h.monitor.observeCoverageToolEnd("later-manifest", "bash");
  h.replace([
    ...h.reader(),
    {
      type: "message",
      id: "later-result",
      message: {
        role: "toolResult",
        toolCallId: "later-manifest",
        toolName: "bash",
        isError: false,
        content: [
          {
            type: "text",
            text: `<workbook><sheets>${coverageNames.map((name) => `<sheet name="${name}"/>`).join("")}</sheets></workbook>`,
          },
        ],
      },
    },
  ]);
  h.monitor.confirmCoverageBranch(h.reader());
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.coverageSnapshot().groups[0]?.children).toHaveLength(22);
  expect(h.extract.mock.calls.length).toBe(extracts);
});
it("parks a post-response receipt write failure instead of immediately rebilling", async () => {
  const h = await fixture();
  let rejected = 0;
  h.save.mockImplementation((value) => {
    if (
      (value as ReturnType<typeof encodeCheckpoint>).monitor?.coverage
        ?.reportReceipts?.length
    ) {
      rejected++;
      if (rejected >= 2) h.monitor.stop(); // Bound the bad retry loop.
      throw new Error("receipt storage denied");
    }
  });
  h.append("report", reportText);
  await h.settle("report");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.calls).toHaveLength(1);
  expect(
    h.monitor
      .coverageSnapshot()
      .groups[0].children.every((child) => child.status === "pending"),
  ).toBe(true);
});
it("optional coverage flight never blocks advisory readiness and OFF fences its late result", async () => {
  const h = await fixture();
  let release: (() => void) | undefined;
  h.setTransport(
    (request) =>
      new Promise<Response>((resolve) => {
        release = () => resolve(answer(request, "reviewed"));
      }),
  );
  h.append("report", reportText);
  await h.settle("report");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.calls).toHaveLength(1);
  expect(h.monitor.advisorySettlementSnapshot().reason).toBe("ready");
  h.monitor.turnOff();
  release?.();
  await vi.advanceTimersByTimeAsync(100);
  expect(
    h.monitor
      .coverageSnapshot()
      .groups[0].children.every((child) => child.status === "pending"),
  ).toBe(true);
  expect(h.calls).toHaveLength(1);
});
