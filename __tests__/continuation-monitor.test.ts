import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContinuationController } from "../src/advisory/continuation-controller";
import type { EvaluationRequest } from "../src/analysis/gateway";
import { continuationAuthorityFixture } from "./fixtures/continuation";
import { branchEntry, monitorHarness } from "./fixtures/hybrid-monitor";

type Projection = ReturnType<
  typeof import("../src/advisory/continuation-authority").projectContinuationAuthority
>;
type Harness = ReturnType<typeof monitorHarness>;
const active: Harness[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline-key");
});
afterEach(() => {
  for (const h of active.splice(0)) h.monitor.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
function binding() {
  const { input } = continuationAuthorityFixture();
  const {
    receipt,
    policy,
    originalRunId,
    sessionEpoch,
    branchEpoch,
    controlEpoch,
    model,
  } = input;
  return {
    receipt,
    policy,
    originalRunId,
    sessionEpoch,
    branchEpoch,
    controlEpoch,
    model,
  };
}
function project(h: Harness): Projection {
  const method = Reflect.get(h.monitor, "continuationAuthority");
  expect(method, "Missing dedicated canonical authority projection").toBeTypeOf(
    "function",
  );
  return Reflect.apply(method, h.monitor, [binding()]);
}
async function fixture() {
  const h = monitorHarness();
  active.push(h);
  h.start();
  await h.settle("goal");
  return h;
}
function withReply(h: Harness) {
  const { question, reply } = continuationAuthorityFixture();
  h.replace([
    branchEntry("goal", "Implement parser, add regression, and validate it."),
    { ...question, parentId: "goal" },
    reply,
  ]);
}

it("does not mistake an older ready board for the accepted reply frontier", async () => {
  const h = await fixture();
  expect(h.monitor.advisorySettlementSnapshot().reason).toBe("ready");
  expect(project(h).available).toBe(false);
  withReply(h);
  expect(project(h).available).toBe(false);
  await h.settle("reply");
  expect(project(h).available).toBe(true);
});

it("projects current canonical history without mutating state, checkpoint or optional/provider work", async () => {
  const h = await fixture();
  withReply(h);
  await h.settle("reply");
  const state = structuredClone(h.monitor.state);
  const checkpoint = JSON.stringify(h.monitor.checkpoint());
  const counts = [
    h.fetch.mock.calls.length,
    h.extract.mock.calls.length,
    h.save.mock.calls.length,
    h.changed.mock.calls.length,
    vi.getTimerCount(),
  ];
  const result = project(h);
  expect(result.available).toBe(true);
  if (!result.available) throw new Error("Expected canonical projection");
  expect(result.context.map((item) => item.id)).toEqual(["goal", "reply"]);
  expect(result.tasks).toHaveLength(3);
  result.tasks[0].label = "Changed detached result";
  expect(h.monitor.state).toEqual(state);
  expect(JSON.stringify(h.monitor.checkpoint())).toBe(checkpoint);
  expect([
    h.fetch.mock.calls.length,
    h.extract.mock.calls.length,
    h.save.mock.calls.length,
    h.changed.mock.calls.length,
    vi.getTimerCount(),
  ]).toEqual(counts);
});

it("drops continuation authority immediately on OFF", async () => {
  const h = await fixture();
  withReply(h);
  await h.settle("reply");
  expect(project(h).available).toBe(true);
  h.monitor.turnOff();
  expect(project(h).available).toBe(false);
});

it.each([false, true])(
  "restores fresh continuation dispatch after amendment without releasing an old physical flight (held=%s)",
  async (held) => {
    const h = await fixture();
    let current: Projection = h.monitor.continuationAuthority(binding());
    const publish = async (text: string, run: number) => {
      const next = binding();
      const { question, reply } = continuationAuthorityFixture();
      next.originalRunId = run;
      next.receipt = {
        ...next.receipt,
        opportunityId: `00000000-0000-4000-8000-${String(run).padStart(12, "0")}`,
      };
      question.details.opportunityId = next.receipt.opportunityId;
      h.replace([
        branchEntry("goal", text),
        { ...question, parentId: "goal" },
        reply,
      ]);
      await h.settle("reply");
      current = h.monitor.continuationAuthority(next);
      if (!current.available)
        throw new Error("Expected fresh canonical authority");
      return {
        opportunityId: current.receipt.opportunityId,
        sessionEpoch: current.sessionEpoch,
        branchEpoch: current.branchEpoch,
        originalRunId: current.originalRunId,
      };
    };
    const transport = h.fetch.getMockImplementation();
    if (!transport) throw new Error("Missing offline transport");
    let dispatches = 0,
      release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.fetch.mockImplementation(async (url, init) => {
      const request = JSON.parse(String(init?.body)) as EvaluationRequest;
      const response = await transport(url, init);
      if (
        !Object.keys(request.questions).some((key) =>
          key.startsWith("continuation:"),
        )
      )
        return response;
      dispatches++;
      if (held && dispatches === 1) {
        const body = (await response.json()) as {
          answers: Record<string, unknown>;
        };
        for (const key of Object.keys(body.answers))
          body.answers[key] = {
            type: "choice",
            choice: "yes",
            confidence: 1,
            probabilities: { yes: 1, no: 0, uncertain: 0 },
          };
        await pending; // Raw provider deliberately ignores abort.
        return Response.json(body);
      }
      return response;
    });
    const draft = vi.fn(async () => undefined);
    const emit = vi.fn(() => true);
    const controller = new ContinuationController({
      authority: () => current,
      canStart: () => h.monitor.continuationCanStart(),
      gate: (...args) => h.monitor.evaluateContinuationGate(...args),
      draft,
      emit,
    });
    let old: Promise<void> | undefined;
    try {
      const text = "Implement parser, add regression, and validate it.";
      const initial = await publish(text, 7);
      expect(controller.arm(initial)).toBe(true);
      if (!current.available) throw new Error("Expected authority");
      expect(controller.settle(current.receipt)).toBe(true);
      old = controller.wake();
      await vi.advanceTimersByTimeAsync(10);
      expect(dispatches).toBe(1);
      if (!held) await old;
      controller.invalidate(); // The owner invalidates the old root on amendment.
      const fresh = await publish(`${text} Include malformed inputs.`, 9);
      if (held) {
        expect(controller.arm(fresh)).toBe(false);
        expect(dispatches).toBe(1);
        expect(draft).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
      }
      release();
      await old;
      await vi.advanceTimersByTimeAsync(10);
      expect(controller.arm(fresh)).toBe(true);
      if (!current.available) throw new Error("Expected amended authority");
      expect(controller.settle(current.receipt)).toBe(true);
      await controller.wake();
      expect(dispatches).toBe(2);
      expect(draft).not.toHaveBeenCalled(); // Fresh gate returns no; stale yes cannot draft.
      expect(emit).not.toHaveBeenCalled();
    } finally {
      controller.invalidate();
      release();
      await old;
    }
  },
);
