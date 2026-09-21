import { afterEach, beforeEach, expect, it, vi } from "vitest";

const opportunityId = "00000000-0000-4000-8000-000000000001";
const content = "What is the actual status of task:1 — Implement parser?";
const request = {
  kind: "reconciliation",
  opportunityId,
  content,
  sessionEpoch: 1,
  branchEpoch: 1,
} as const;
type Origin =
  | "independent"
  | "advisory-only"
  | "mixed-external"
  | "external"
  | "uncertain-advisory";
type Delivery = {
  request(value: {
    kind: "reconciliation";
    opportunityId: string;
    content: string;
    sessionEpoch: number;
    branchEpoch: number;
  }): "started" | "duplicate" | "suppressed";
  onInput(): void;
  onAgentStart(): void;
  onMessageEnd(message: unknown, branch: readonly unknown[]): void;
  onContext(branch: readonly unknown[]): void;
  onAgentSettled(branch: readonly unknown[]): Origin | undefined;
  onMasterOff(): void;
  onNavigation(): void;
  onSessionShutdown(): void;
  dispose(): void;
};
type State = {
  enabled: boolean;
  mode: string;
  sessionEpoch: number;
  branchEpoch: number;
  opportunityId: string;
  relevant: boolean;
  idle: boolean;
  pendingMessages: boolean;
};
const active: Delivery[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  for (const d of active.splice(0)) d.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
});
async function fixture() {
  const path = "../src/advisory/delivery.ts";
  const module = await import(path);
  let state: State = {
    enabled: true,
    mode: "tui",
    sessionEpoch: 1,
    branchEpoch: 1,
    opportunityId,
    relevant: true,
    idle: true,
    pendingMessages: false,
  };
  const branch: unknown[] = [
    { type: "custom", id: "baseline", customType: "pi-progress-bar", data: {} },
  ];
  const sendMessage = vi.fn();
  let id = 10;
  const delivery: Delivery = new module.ReconciliationDelivery({
    state: () => state,
    branch: () => branch,
    sendMessage,
    uuid: () => `00000000-0000-4000-8000-${String(id++).padStart(12, "0")}`,
    clock: {
      now: () => Date.now(),
      setTimeout: (fn: () => void, delay: number) => setTimeout(fn, delay),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) =>
        clearTimeout(timer),
    },
  });
  active.push(delivery);
  const canonical = () => ({
    type: "custom_message",
    id: "own",
    parentId: "baseline",
    ...sendMessage.mock.calls[0][0],
  });
  return {
    delivery,
    branch,
    sendMessage,
    canonical,
    set: (patch: Partial<State>) => {
      state = { ...state, ...patch };
    },
  };
}
it("invokes exact custom message with three distinct sends at0/2/10 seconds then exhausts", async () => {
  const h = await fixture();
  expect(h.delivery.request(request)).toBe("started");
  expect(h.sendMessage).toHaveBeenCalledExactlyOnceWith(
    {
      customType: "pi-progress-advisory",
      content,
      display: true,
      details: {
        kind: "reconciliation",
        opportunityId,
        sendId: "00000000-0000-4000-8000-000000000010",
      },
    },
    { deliverAs: "steer", triggerTurn: true },
  );
  await vi.advanceTimersByTimeAsync(1_999);
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.sendMessage).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(7_999);
  expect(h.sendMessage).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.sendMessage).toHaveBeenCalledTimes(3);
  expect(
    new Set(h.sendMessage.mock.calls.map(([message]) => message.details.sendId))
      .size,
  ).toBe(3);
  await vi.advanceTimersByTimeAsync(8_000);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(100_000);
  expect(h.sendMessage).toHaveBeenCalledTimes(3);
});
it("dedupes request and never treats void return as acknowledgement", async () => {
  const h = await fixture();
  h.delivery.request(request);
  expect(h.delivery.request(request)).toBe("duplicate");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(h.sendMessage).toHaveBeenCalledTimes(2);
});
it("synchronous throws consume attempts without immediate loops", async () => {
  const h = await fixture();
  h.sendMessage.mockImplementation(() => {
    throw new Error("host error");
  });
  expect(() => h.delivery.request(request)).not.toThrow();
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(18_000);
  expect(h.sendMessage).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});
it("synchronous matching message_end stops retries before post-invocation timer arm", async () => {
  const h = await fixture();
  h.sendMessage.mockImplementation((message) =>
    h.delivery.onMessageEnd({ role: "custom", ...message }, h.branch),
  );
  h.delivery.request(request);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
});
it("canonical confirmation before retry cancels retries without requiring a changed board", async () => {
  const h = await fixture();
  h.delivery.request(request);
  h.branch.push(h.canonical());
  await vi.advanceTimersByTimeAsync(18_000);
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["content", "display", "sendId", "opportunityId", "extra-details"])(
  "does not accept mismatched %s as delivery evidence",
  async (field) => {
    const h = await fixture();
    h.delivery.request(request);
    const message = structuredClone({
      role: "custom",
      ...h.sendMessage.mock.calls[0][0],
    });
    if (field === "content") message.content += " changed";
    else if (field === "display") message.display = false;
    else if (field === "extra-details") message.details.extra = true;
    else message.details[field] = "00000000-0000-4000-8000-000000000099";
    h.delivery.onMessageEnd(message, h.branch);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
  },
);
it.each([
  ["master", { enabled: false }],
  ["print", { mode: "print" }],
  ["json", { mode: "json" }],
  ["session", { sessionEpoch: 2 }],
  ["branch", { branchEpoch: 2 }],
  ["opportunity", { opportunityId: "stale" }],
  ["irrelevant", { relevant: false }],
  ["user queue", { pendingMessages: true }],
  ["busy", { idle: false }],
] as const)("suppresses initial send for %s", async (_name, patch) => {
  const h = await fixture();
  h.set(patch);
  expect(h.delivery.request(request)).toBe("suppressed");
  expect(h.sendMessage).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it.each([
  "onInput",
  "onMasterOff",
  "onNavigation",
  "onSessionShutdown",
  "dispose",
] as const)(
  "stops future retries on %s without retracting invoked message",
  async (event) => {
    const h = await fixture();
    h.delivery.request(request);
    h.delivery[event]();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("rechecks queued-user guard before retry", async () => {
  const h = await fixture();
  h.delivery.request(request);
  h.set({ pendingMessages: true });
  await vi.advanceTimersByTimeAsync(18_000);
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
});
it("own start before context does not cancel; exact canonical match classifies own settlement once", async () => {
  const h = await fixture();
  h.sendMessage.mockImplementation(() => {
    h.set({ idle: false });
    h.delivery.onAgentStart();
  });
  h.delivery.request(request);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(h.sendMessage).toHaveBeenCalledTimes(2);
  h.branch.push(h.canonical());
  h.delivery.onContext(h.branch);
  expect(h.delivery.onAgentSettled(h.branch)).toBe("advisory-only");
  expect(h.delivery.onAgentSettled(h.branch)).toBeUndefined();
  h.delivery.onAgentStart();
  expect(h.delivery.onAgentSettled(h.branch)).toBe("independent");
});
it.each(["user", "intercom"])(
  "genuine %s alongside own message wins as mixed external",
  async (kind) => {
    const h = await fixture();
    h.delivery.request(request);
    h.delivery.onAgentStart();
    h.branch.push(h.canonical());
    h.branch.push(
      kind === "user"
        ? {
            type: "message",
            id: "external",
            message: { role: "user", content: "Continue implementation" },
          }
        : {
            type: "custom_message",
            id: "external",
            customType: "intercom_message",
            content: "New work",
          },
    );
    h.delivery.onContext(h.branch);
    expect(h.delivery.onAgentSettled(h.branch)).toBe("mixed-external");
    await vi.advanceTimersByTimeAsync(18_000);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  },
);
it("candidate settlement lacking confirmation never rearms and keeps only bounded retries", async () => {
  const h = await fixture();
  h.delivery.request(request);
  h.delivery.onAgentStart();
  expect(h.delivery.onAgentSettled(h.branch)).toBe("uncertain-advisory");
  expect(h.delivery.onAgentSettled(h.branch)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(18_000);
  expect(h.sendMessage).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});
it("unobserved duplicate settlement cannot invent an independent opportunity", async () => {
  const h = await fixture();
  expect(h.delivery.onAgentSettled(h.branch)).toBeUndefined();
  h.delivery.onAgentStart();
  expect(h.delivery.onAgentSettled(h.branch)).toBe("independent");
  expect(h.delivery.onAgentSettled(h.branch)).toBeUndefined();
});
it("branch-prefix change cancels retries while own custom/checkpoint appends do not", async () => {
  const h = await fixture();
  h.delivery.request(request);
  h.branch[0] = { type: "custom", id: "different" };
  await vi.advanceTimersByTimeAsync(18_000);
  expect(h.sendMessage).toHaveBeenCalledTimes(1);
});

it("retains input-hook authority when user entry is not yet canonical", async () => {
  const h = await fixture();
  h.delivery.request(request);
  h.delivery.onAgentStart();
  h.delivery.onInput();
  h.branch.push(h.canonical());
  h.delivery.onContext(h.branch);
  expect(h.delivery.onAgentSettled(h.branch)).toBe("mixed-external");
});
it.each([
  "exhaust-before-settle",
  "late-confirm-after-settle",
  "new-external-start",
])("releases terminal chain for fresh opportunity: %s", async (scenario) => {
  const h = await fixture();
  h.delivery.request(request);
  h.delivery.onAgentStart();
  if (scenario === "exhaust-before-settle") {
    await vi.advanceTimersByTimeAsync(18_000);
    expect(h.delivery.onAgentSettled(h.branch)).toBe("uncertain-advisory");
  } else if (scenario === "late-confirm-after-settle") {
    expect(h.delivery.onAgentSettled(h.branch)).toBe("uncertain-advisory");
    h.branch.push(h.canonical());
    h.delivery.onContext(h.branch);
  } else {
    h.delivery.onAgentStart();
    expect(h.delivery.onAgentSettled(h.branch)).toBe("independent");
  }
  const nextId = "00000000-0000-4000-8000-000000000002";
  h.set({ opportunityId: nextId, idle: true });
  expect(h.delivery.request({ ...request, opportunityId: nextId })).toBe(
    "started",
  );
});
