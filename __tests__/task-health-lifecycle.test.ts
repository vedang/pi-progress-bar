import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EvaluationRequest } from "../src/analysis/gateway";
import { CanonicalPass } from "../src/sources/messages";
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
function fixture(count = 3) {
  const h = taskHealthHarness(count);
  running.push(h);
  return h;
}
const taskId = (r: EvaluationRequest) =>
  (r.state as { evidence: { taskId: string } }).evidence.taskId;
function editEvidence(h: ReturnType<typeof fixture>, id = "edit") {
  h.monitor.observeToolStart(id, "edit", { path: "src/parser.ts" });
  h.monitor.observeToolEnd(
    id,
    "edit",
    { content: [{ type: "text", text: "Successfully edited src/parser.ts" }] },
    false,
  );
}
function heldHealth(h: ReturnType<typeof fixture>) {
  const transport = h.fetch.getMockImplementation();
  if (!transport) throw new Error("transport");
  const releases: (() => void)[] = [];
  let hold = true;
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    const response = await transport(url, init);
    if (hold && request.questions.clarity)
      await new Promise<void>((resolve) => releases.push(resolve));
    return response;
  });
  return {
    releases,
    releaseAll: () => {
      hold = false;
      for (const release of releases) release();
    },
  };
}

it("attempts all twenty tasks once in order after settled work", async () => {
  const h = fixture(20);
  h.start();
  await h.settle(h.initialTarget);
  expect(h.cards()).toHaveLength(20);
  expect(h.healthRequests().map(taskId)).toEqual(
    Array.from({ length: 20 }, (_, i) => `task:${i + 1}`),
  );
  const calls = h.fetch.mock.calls.length;
  for (let i = 0; i < 20; i++) {
    h.monitor.boardSnapshot();
    h.monitor.presentationSnapshot();
  }
  await vi.advanceTimersByTimeAsync(5000);
  expect(h.fetch).toHaveBeenCalledTimes(calls);
});

it("preemption preserves each task and coalesces a burst without unbounded successor calls", async () => {
  const h = fixture(20);
  const held = heldHealth(h);
  h.start();
  await h.settle(h.initialTarget);
  for (let i = 0; i < 5; i++) h.append(`burst-${i}`, `Parser update ${i}.`);
  await h.settle("burst-4");
  held.releaseAll();
  await vi.advanceTimersByTimeAsync(200);
  expect(h.cards()).toHaveLength(20);
  expect(
    h.cards().every((c) => c.provenance.observation.entryId === "burst-4"),
  ).toBe(true);
  const latest = h.healthRequests().slice(-20).map(taskId);
  expect(new Set(latest).size).toBe(20);
  expect(h.healthRequests().length).toBeLessThanOrEqual(22);
});

it("transient health failure waits for deadline AND a named evidence wake, without losing jobs", async () => {
  const h = fixture();
  const transport = h.fetch.getMockImplementation();
  if (!transport) throw new Error("transport");
  let failed = false;
  let attempts = 0;
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.questions.clarity) {
      attempts++;
      if (!failed) {
        failed = true;
        return new Response("unavailable", {
          status: 503,
          headers: { "retry-after": "2" },
        });
      }
    }
    return transport(url, init);
  });
  h.start();
  await h.settle("goal");
  expect(attempts).toBe(1);
  await vi.advanceTimersByTimeAsync(10000);
  expect(attempts).toBe(1);
  expect(h.cards()).toHaveLength(0);
  editEvidence(h);
  await vi.advanceTimersByTimeAsync(200);
  expect(h.cards()).toHaveLength(3);
  expect(h.monitor.advisorySettlementSnapshot().reason).toBe("ready");
});

it("invalid health response cannot spin or head-block healthy tasks", async () => {
  const h = fixture();
  const transport = h.fetch.getMockImplementation();
  if (!transport) throw new Error("transport");
  let invalid = true;
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body)) as EvaluationRequest;
    const response = await transport(url, init);
    if (request.questions.clarity && taskId(request) === "task:1" && invalid)
      return Response.json({ invalid: true });
    return response;
  });
  h.start();
  await h.settle("goal");
  expect(h.cards().map((c) => c.taskId)).toEqual(["task:2", "task:3"]);
  const count = h.healthRequests().length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(h.healthRequests()).toHaveLength(count);
  invalid = false;
  h.monitor.modelSelected();
  await vi.advanceTimersByTimeAsync(200);
  expect(h.cards()).toHaveLength(3);
});

// [ref:health_runtime_evidence_recovery]
it.each(["model", "off-on"])(
  "%s recovery retries failed evidence replacement without a new report",
  async (recovery) => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    const transport = h.fetch.getMockImplementation();
    if (!transport) throw new Error("transport");
    let invalid = true;
    h.fetch.mockImplementation(async (url, init) => {
      if (invalid && JSON.parse(String(init?.body)).questions.clarity)
        return Response.json({ invalid: true });
      return transport(url, init);
    });
    editEvidence(h);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.cards().every((card) => card.provenance.codeRevision === 0)).toBe(
      true,
    );
    invalid = false;
    if (recovery === "model") h.monitor.modelSelected();
    else {
      h.monitor.turnOff();
      h.monitor.turnOn("/nonexistent-hybrid-test");
    }
    await vi.advanceTimersByTimeAsync(200);
    expect(
      h
        .cards()
        .every(
          (card) =>
            card.provenance.codeRevision === h.monitor.evidence.codeRevision(),
        ),
    ).toBe(true);
  },
);

it("permanent health failure stays paused until explicit model recovery", async () => {
  const h = fixture();
  const transport = h.fetch.getMockImplementation();
  if (!transport) throw new Error("transport");
  let reject = true;
  let attempts = 0;
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.questions.clarity) {
      attempts++;
      if (reject) return new Response("bad request", { status: 400 });
    }
    return transport(url, init);
  });
  h.start();
  await h.settle("goal");
  expect(attempts).toBe(1);
  reject = false;
  h.append("ordinary", "Still working.");
  await h.settle("ordinary");
  expect(attempts).toBe(1);
  expect(h.monitor.enabled).toBe(true);
  h.monitor.modelSelected();
  await vi.advanceTimersByTimeAsync(200);
  expect(h.cards()).toHaveLength(3);
});

it("evidence racing a flight rejects stale result and schedules one current successor per task", async () => {
  const h = fixture();
  const held = heldHealth(h);
  h.start();
  await h.settle("goal");
  editEvidence(h);
  held.releaseAll();
  await vi.advanceTimersByTimeAsync(200);
  expect(h.cards()).toHaveLength(3);
  expect(
    h
      .cards()
      .every(
        (c) => c.provenance.codeRevision === h.monitor.evidence.codeRevision(),
      ),
  ).toBe(true);
  expect(h.healthRequests().length).toBeLessThanOrEqual(4);
});

it("OFF fences held results and ON reconstructs still-required initial work", async () => {
  const h = fixture();
  const held = heldHealth(h);
  h.start();
  await h.settle("goal");
  h.monitor.turnOff();
  held.releaseAll();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.cards()).toHaveLength(0);
  h.monitor.turnOn("/nonexistent-hybrid-test");
  await vi.advanceTimersByTimeAsync(200);
  expect(h.cards()).toHaveLength(3);
});

it("background health does not steal focused A or downgrade its live proof", async () => {
  const h = fixture();
  h.focus("task:1");
  h.start();
  await h.settle("goal");
  expect(h.cards()).toHaveLength(3);
  expect(h.monitor.boardSnapshot().currentTask?.taskId).toBe("task:1");
  expect(
    h.monitor.boardSnapshot().tasks.find((t) => t.taskId === "task:1")
      ?.provenance.state,
  ).toBe("current");
  expect(h.monitor.presentationSnapshot().card).toMatchObject({
    taskId: "task:1",
    retained: false,
  });
});

it("all pending replacements have task-local provenance while reconciliation stays ready", async () => {
  const h = fixture();
  h.start();
  await h.settle("goal");
  const held = heldHealth(h);
  h.append("replacement", "Reassess all current tasks.");
  await h.settle("replacement");
  expect(
    h.monitor
      .boardSnapshot()
      .tasks.every((t) => t.provenance.state === "replacement-pending"),
  ).toBe(true);
  expect(h.monitor.advisorySettlementSnapshot().reason).toBe("ready");
  expect(h.monitor.correctionSnapshot().tasks.every((t) => !t.red)).toBe(true);
  held.releaseAll();
  await vi.advanceTimersByTimeAsync(100);
});

it("terminal task correction facts survive unrelated open-task replacement", async () => {
  const h = fixture();
  h.start();
  await h.settle("goal");
  h.completed.add("task:3");
  h.append("terminal", "Research option 2 complete.");
  await h.settle("terminal");
  expect(
    h.monitor.correctionSnapshot().tasks.find((t) => t.id === "task:3")?.red,
  ).toBeDefined();
  const held = heldHealth(h);
  h.append("open", "Parser and documentation still changing.");
  await h.settle("open");
  expect(
    h.monitor.correctionSnapshot().tasks.find((t) => t.id === "task:2")?.red,
  ).toBeUndefined();
  expect(
    h.monitor.correctionSnapshot().tasks.find((t) => t.id === "task:3")?.red,
  ).toBeDefined();
  held.releaseAll();
  await vi.advanceTimersByTimeAsync(100);
});

it("capacity-denied job does not spin or block others and recovers on changed input", async () => {
  const h = fixture();
  const method = h.monitor as unknown as {
    admitHealth: (task: { id: string }, ...args: unknown[]) => boolean;
  };
  const original = method.admitHealth.bind(h.monitor);
  let deny = true;
  const admission = vi
    .spyOn(method, "admitHealth")
    .mockImplementation((task, ...args) =>
      task.id === "task:1" && deny ? false : original(task, ...args),
    );
  h.start();
  await h.settle("goal");
  expect(h.cards().map((c) => c.taskId)).toEqual(["task:2", "task:3"]);
  const calls = admission.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(admission).toHaveBeenCalledTimes(calls);
  expect(h.monitor.state.capacity).toBe("clear");
  deny = false;
  h.append("changed", "New parser evidence.");
  await h.settle("changed");
  expect(h.cards()).toHaveLength(3);
  admission.mockRestore();
});

it("bounded report context exposes omitted oversized target without authoritative truncation", () => {
  const context = new CanonicalPass([
    branchEntry("goal", "old report"),
    branchEntry("large", "x".repeat(5000)),
  ]).healthReportContext("large");
  expect(context?.complete).toBe(false);
  expect(context?.reports).toHaveLength(0);
  expect(context?.omissions.length).toBeGreaterThan(0);
});

it("wakes parked terminal repair on a later canonical commit without changing its target", async () => {
  const h = fixture(1);
  h.start();
  await h.settle("goal");
  const transport = h.fetch.getMockImplementation();
  if (!transport) throw new Error("transport");
  let fail = true;
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (fail && request.questions.clarity) {
      fail = false;
      return new Response("unavailable", { status: 503 });
    }
    return transport(url, init);
  });
  h.completed.add("task:1");
  h.append("terminal", "Parser is complete.");
  await h.settle("terminal");
  expect(h.cards()[0]?.provenance.observation.entryId).toBe("goal");
  await vi.advanceTimersByTimeAsync(10000);
  h.append("later", "Acknowledged.");
  await h.settle("later");
  expect(h.cards()[0]?.provenance.observation.entryId).toBe("terminal");
});

it("counts array punctuation inside the serialized report byte budget", () => {
  const goal = branchEntry("goal", "tiny");
  const empty = branchEntry("target", "x");
  const pass = new CanonicalPass([goal, empty]);
  const overhead =
    ["goal", "target"].reduce(
      (n, id) => n + Buffer.byteLength(JSON.stringify(pass.observation(id))),
      0,
    ) - 1;
  const context = new CanonicalPass([
    goal,
    branchEntry("target", "x".repeat(4095 - overhead)),
  ]).healthReportContext("target");
  expect(
    Buffer.byteLength(JSON.stringify(context?.reports)),
  ).toBeLessThanOrEqual(4096);
});

it("keeps unattempted peers ahead of refreshed tasks after an evidence wake", async () => {
  const h = fixture();
  const transport = h.fetch.getMockImplementation();
  if (!transport) throw new Error("transport");
  let release: (() => void) | undefined;
  let hold = true;
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body)) as EvaluationRequest;
    const response = await transport(url, init);
    if (hold && request.questions.clarity && taskId(request) === "task:2") {
      hold = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return response;
  });
  h.start();
  await h.settle("goal");
  expect(h.healthRequests().map(taskId)).toEqual(["task:1", "task:2"]);
  editEvidence(h);
  release?.();
  await vi.advanceTimersByTimeAsync(200);
  expect(h.healthRequests().map(taskId).slice(0, 3)).toEqual([
    "task:1",
    "task:2",
    "task:3",
  ]);
  expect(h.cards()).toHaveLength(3);
});

it("preserves the terminal target when a cardless task is preempted by later prose", async () => {
  const h = fixture();
  const held = heldHealth(h);
  h.start();
  await h.settle("goal");
  h.completed.add("task:1");
  h.append("terminal", "Parser complete after PARSER_RED_REPORT.");
  await h.settle("terminal");
  h.append("later", "Documentation still in progress.");
  await h.settle("later");
  held.releaseAll();
  await vi.advanceTimersByTimeAsync(200);
  expect(
    h.cards().find((card) => card.taskId === "task:1")?.provenance.observation
      .entryId,
  ).toBe("terminal");
  expect(
    h.cards().find((card) => card.taskId === "task:2")?.provenance.observation
      .entryId,
  ).toBe("later");
});

it("report membership and coverage digest are independent of prior exploratory reads", () => {
  const entries = Array.from({ length: 100 }, (_, i) =>
    branchEntry(`r${i}`, `Report ${i}`),
  );
  const baseline = new CanonicalPass(entries).healthReportContext("r99");
  const used = new CanonicalPass(entries);
  used.page();
  expect(used.healthReportContext("r99")).toEqual(baseline);
  expect(baseline?.references).toHaveLength(16);
  expect(
    Buffer.byteLength(JSON.stringify(baseline?.reports)),
  ).toBeLessThanOrEqual(4096);
});
