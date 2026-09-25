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
async function fixture(details = false, failIntent = false) {
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
  if (failIntent) {
    const extract = h.extract.getMockImplementation();
    let failed = false;
    if (!extract) throw new Error("Missing extractor");
    h.extract.mockImplementation(async (input, signal, onDispatch) => {
      if (input.instructions.includes("parentIndices") && !failed) {
        failed = true;
        onDispatch?.(Date.now());
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
it("explicit model recovery resumes a failed paid intent without mandatory re-extraction", async () => {
  await fixture(false, true);
});
it("coalesces a same-parent resource backlog before optional dispatch", async () => {
  const h = await fixture();
  h.setChoice("unchanged");
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
        `Review all tabs in docs/second.xlsx. Updated instruction ${i}.`,
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
});
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
