import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  JevGateway,
  MAX_REQUEST_BYTES,
  MODEL,
  type ValidatedResult,
} from "../../src/analysis/gateway";
import { countReported, reconcileLedger } from "../../src/core/ledger";
import { Monitor } from "../../src/core/monitor";
import {
  candidateRequest,
  classificationRequest,
  proposal,
} from "../../src/sources/candidates";
import { reportRequest, reportStates } from "../../src/sources/reports";
import {
  collectTrajectory,
  findCandidates,
  hashText,
} from "../../src/sources/trajectory";
import { replayEntries } from "../fixtures/live-session";
import { renderWidget } from "../fixtures/render-widget";

// [tag:live_budget] All paid calls, including failed/aborted ones, pass this
// process-wide cap. No retries/reruns or hidden direct semantic substitutes.
const MAX_ATTEMPTS = Number(process.env.PROGRESS_LIVE_MAX_ATTEMPTS ?? 64);
const directory = resolve(
  ".agents/plans/20260918T230453--retain-tasks-show-freshness__active",
);
const artifact = resolve(directory, `live-${Date.now()}.jsonl`);
const realFetch = globalThis.fetch;
let attempts = 0;
let active = 0;
let blocked = 0;
let ready = false;
const usage = { input_tokens: 0, output_tokens: 0 };
const record = (value: unknown) =>
  appendFileSync(artifact, `${JSON.stringify(value)}\n`);

beforeAll(() => {
  if (
    !Number.isSafeInteger(MAX_ATTEMPTS) ||
    MAX_ATTEMPTS < 1 ||
    MAX_ATTEMPTS > 64
  )
    throw new Error("Live attempt budget must be an integer from 1 through 64");
  if (process.env.PROGRESS_LIVE !== "1")
    throw new Error("Paid suite requires explicit PROGRESS_LIVE=1");
  if (!process.env.TYPESAFE_API_KEY?.trim())
    throw new Error("Paid suite requires TYPESAFE_API_KEY");
  mkdirSync(directory, { recursive: true });
  ready = true;
  record({
    type: "budget",
    model: MODEL,
    maxAttempts: MAX_ATTEMPTS,
    maxRequestBytes: MAX_REQUEST_BYTES,
    fixture: "sanitized incremental live-session reconstruction",
    timestamp: new Date().toISOString(),
  });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (
      url !== "https://api.typesafe.ai/v1/systemone" ||
      !body ||
      Buffer.byteLength(body) > MAX_REQUEST_BYTES ||
      attempts >= MAX_ATTEMPTS
    ) {
      blocked++;
      record({ type: "blocked", attempts });
      throw new Error(
        "Live evaluation request budget or endpoint boundary reached",
      );
    }
    const request = JSON.parse(body);
    if (request.model !== MODEL) throw new Error("Unexpected live model");
    const attempt = ++attempts;
    active++;
    // Only synthetic fixture states/questions; never persist credentials/headers.
    record({
      type: "attempt",
      attempt,
      request,
      bytes: Buffer.byteLength(body),
    });
    try {
      const response = await realFetch(url, init);
      const data = (await response.clone().json()) as Partial<ValidatedResult>;
      if (response.ok && data.usage) {
        usage.input_tokens += data.usage.input_tokens ?? 0;
        usage.output_tokens += data.usage.output_tokens ?? 0;
      }
      record({
        type: "response",
        attempt,
        status: response.status,
        model: data.model,
        usage: data.usage,
        answers: data.answers,
      });
      return response;
    } catch (error) {
      record({
        type: "failure",
        attempt,
        errorType: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    } finally {
      active--;
    }
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (ready) {
    record({ type: "totals", attempts, blocked, usage });
    console.info(
      `Live Jev evidence: ${artifact}; ${attempts}/${MAX_ATTEMPTS} attempts; ${JSON.stringify(usage)}`,
    );
  }
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("fresh-session production pipeline follows a changed goal and consumes completion only after scope", async () => {
  let entries: {
    type: string;
    id: string;
    parentId: string | null;
    message: { role: string; content: string };
  }[] = replayEntries(4);
  const monitor = new Monitor(
    () => {},
    () => {},
  );
  monitor.observe(() => entries);
  const settleThrough = async (entryId: string) => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (blocked) throw new Error(`Live attempt cap reached; see ${artifact}`);
      if (!monitor.enabled)
        throw new Error(monitor.error ?? "Monitor stopped unexpectedly");
      monitor.scheduleAnalysis();
      if (monitor.conversation.cursor?.id === entryId && active === 0) {
        await pause(100);
        if (!active) return;
      }
      await pause(25);
    }
    throw new Error(
      `Production replay did not settle through ${entryId}; cursor=${monitor.conversation.cursor?.id}; discovery=${monitor.conversation.discoveryStatus}; reports=${monitor.conversation.reportStatus}; gateway=${monitor.gateway.status}; artifact=${artifact}`,
    );
  };
  try {
    expect(monitor.turnOn("/nonexistent-live-fixture")).toBeUndefined();
    await settleThrough("29acae97");
    const tasks = monitor.ledger?.tasks.filter((task) => task.included) ?? [];
    record({
      type: "goal-checkpoint",
      tasks,
      cursor: monitor.conversation.cursor,
    });
    expect(tasks).toHaveLength(2);
    expect(tasks.map((task) => task.text).join("\n")).toContain("15s");
    expect(tasks.map((task) => task.text).join("\n")).toContain("/progress");
    expect(tasks.map((task) => task.text).join("\n")).not.toContain(
      "First lock scope",
    );

    entries = replayEntries(5);
    await settleThrough("working");
    const current = monitor.ledger?.tasks.find(
      (task) => task.id === monitor.ledger?.currentTaskId,
    );
    record({
      type: "current-checkpoint",
      current,
      cursor: monitor.conversation.cursor,
    });
    expect(current?.text).toContain("15s");

    entries = [
      ...replayEntries(5),
      {
        type: "message",
        id: "approval",
        parentId: "working",
        message: {
          role: "user",
          content: "Yes, proceed with those same two changes.",
        },
      },
    ];
    await settleThrough("approval");
    expect(countReported(monitor.ledger).total).toBe(2);
    const final = replayEntries().at(-1);
    if (!final) throw new Error("Missing final report");
    entries = [...entries, { ...final, parentId: "approval" }];
    await settleThrough("2fd7cc52");
    record({
      type: "final-checkpoint",
      ledger: monitor.ledger,
      usage: monitor.usage,
      cursor: monitor.conversation.cursor,
    });
    expect(countReported(monitor.ledger)).toMatchObject({
      done: 2,
      total: 2,
      percent: 100,
    });
    const widget = renderWidget(monitor).join("\n");
    expect(widget).not.toMatch(/Task: unknown/i);
    expect(widget).toMatch(/Last Jev call/i);
    // Same history may hit local cache, but must never generate new paid requests.
    const before = attempts;
    for (let i = 0; i < 20; i++) {
      monitor.scheduleAnalysis();
      await pause(10);
    }
    expect(attempts).toBe(before);
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThanOrEqual(MAX_ATTEMPTS);
  } finally {
    monitor.stop();
  }
});

it.each([
  [
    "intention",
    "Tomorrow I plan to implement the 15-second default interval and improve /progress help.",
    false,
  ],
  [
    "quoted example",
    "Here is an example final message, not a claim about this session: 'Implemented the 15-second default interval and improved /progress help.' Neither change has been implemented yet.",
    false,
  ],
  [
    "test activity",
    "I ran unit tests and inspected files. I have not yet implemented the default interval or /progress help changes.",
    false,
  ],
  [
    "delivery paraphrase",
    "Shipped both requested updates: the default analysis interval is now fifteen seconds. /progress now prints clear help explaining all supported commands and how to use them.",
    true,
  ],
])("report semantics: %s", async (name, text, completed) => {
  const candidate = findCandidates(collectTrajectory(replayEntries(4))).find(
    (candidate) => candidate.entryId === "29acae97",
  );
  if (!candidate) throw new Error("Missing original task request");
  // Known fixture task boundaries isolate report semantics, while the test above
  // also exercises real discovery/classification in the complete controller.
  const scope = proposal(
    candidate,
    Object.fromEntries(
      candidate.spans.map((span) => [
        span.id,
        span.kind === "list" ? "task" : "context",
      ]),
    ),
  );
  const ledger = reconcileLedger(undefined, scope.snapshot);
  const request = reportRequest(ledger, {
    id: `live-${name}`,
    role: "assistant",
    text,
    hash: hashText(text),
  });
  const gateway = new JevGateway({
    fetch: (url, init) => globalThis.fetch(url, init),
    getApiKey: () => process.env.TYPESAFE_API_KEY,
  });
  const identity = `report-semantics:${name}`;
  gateway.enable(identity);
  try {
    const result = await gateway.evaluate(request, identity);
    expect(
      result,
      `No validated Jev response: ${gateway.status}`,
    ).toBeDefined();
    if (!result) return;
    const states = reportStates(ledger, request, result);
    record({ type: "report-case", name, completed, states });
    if (completed) expect(Object.values(states)).toEqual(["done", "done"]);
    else expect(Object.values(states)).not.toContain("done");
  } finally {
    gateway.pause();
  }
});

it.each([
  ["explanation", "Explain how this parser handles Unicode."],
  ["status question", "What is left to do on the parser change?"],
  ["fresh answer", "List the health fields again, please."],
  ["code directive", "Change the parser to accept Unicode identifiers."],
])("conversational user work: %s", async (name, text) => {
  const candidate = findCandidates(
    collectTrajectory([
      {
        type: "message",
        id: `user-${name}`,
        parentId: null,
        message: { role: "user", content: text },
      },
    ]),
  )[0];
  if (!candidate) throw new Error("Missing original user candidate");
  const gateway = new JevGateway({
    fetch: (url, init) => globalThis.fetch(url, init),
    getApiKey: () => process.env.TYPESAFE_API_KEY,
  });
  const identity = `user-work:${name}`;
  gateway.enable(identity);
  try {
    const selected = await gateway.evaluate(
      candidateRequest([candidate]),
      identity,
    );
    expect(selected?.answers.source).toMatchObject({
      type: "choice",
      choice: candidate.id,
    });
    const classified = await gateway.evaluate(
      classificationRequest(candidate, candidate.spans),
      identity,
    );
    expect(classified, gateway.status).toBeDefined();
    const choices = Object.fromEntries(
      Object.entries(classified?.answers ?? {}).map(([id, answer]) => [
        id,
        answer.type === "choice" ? answer.choice : "unknown",
      ]),
    );
    const work = proposal(candidate, choices);
    record({ type: "user-work", name, taskCount: work.snapshot.tasks.length });
    expect(work.snapshot.tasks).toHaveLength(1);
    expect(work.snapshot.tasks[0]?.text).toBe(text);
  } finally {
    gateway.pause();
  }
});

it("status questions preserve ongoing work and repeated requests do not inherit completion", async () => {
  let entries = [
    {
      type: "message",
      id: "parser-task",
      parentId: null as string | null,
      message: {
        role: "user",
        content:
          "Implement Unicode identifier support in the parser and add regression tests.",
      },
    },
  ];
  const monitor = new Monitor(
    () => {},
    () => {},
  );
  monitor.observe(() => entries);
  const settle = async (id: string) => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (blocked) throw new Error(`Live cap reached: ${artifact}`);
      monitor.scheduleAnalysis();
      if (monitor.conversation.cursor?.id === id && active === 0) return;
      await pause(25);
    }
    throw new Error(
      `Unsettled conversational turn ${id}: ${monitor.progressState()}; ${artifact}`,
    );
  };
  const append = (id: string, role: string, content: string) => {
    entries = [
      ...entries,
      {
        type: "message",
        id,
        parentId: entries.at(-1)?.id ?? null,
        message: { role, content },
      },
    ];
  };
  try {
    expect(monitor.turnOn("/nonexistent-live-fixture")).toBeUndefined();
    await settle("parser-task");
    const original =
      monitor.ledger?.tasks
        .filter((task) => task.included)
        .map((task) => task.id) ?? [];
    expect(original.length).toBeGreaterThan(0);
    append(
      "status-question",
      "user",
      "While that implementation is still in progress, explain what work remains. This is a status question, not a replacement for the implementation.",
    );
    await settle("status-question");
    expect(
      monitor.ledger?.tasks.filter(
        (task) => task.included && original.includes(task.id),
      ).length,
    ).toBe(original.length);
    const questions =
      monitor.ledger?.tasks.filter(
        (task) => task.included && task.ref.entryId === "status-question",
      ) ?? [];
    expect(questions.length).toBeGreaterThan(0);
    append(
      "status-answer",
      "assistant",
      "Here is the requested status: Unicode identifier implementation and its regression tests remain unfinished. That answers your status question; implementation is still in progress.",
    );
    await settle("status-answer");
    expect(
      monitor.ledger?.tasks
        .filter((task) => original.includes(task.id))
        .every((task) => task.status !== "done"),
    ).toBe(true);
    expect(
      monitor.ledger?.tasks
        .filter((task) => questions.some((question) => question.id === task.id))
        .some((task) => task.status === "done"),
    ).toBe(true);
    append(
      "repeat-question",
      "user",
      "Please explain what work remains again. I want a fresh status answer; keep the implementation task active.",
    );
    await settle("repeat-question");
    const repeated =
      monitor.ledger?.tasks.filter(
        (task) => task.included && task.ref.entryId === "repeat-question",
      ) ?? [];
    record({ type: "repeated-question", tasks: monitor.ledger?.tasks });
    expect(repeated.length).toBeGreaterThan(0);
    expect(repeated.every((task) => task.status !== "done")).toBe(true);
    expect(
      monitor.ledger?.tasks.filter(
        (task) => task.included && original.includes(task.id),
      ).length,
    ).toBe(original.length);
  } finally {
    monitor.stop();
  }
});
