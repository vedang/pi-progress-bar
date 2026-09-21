import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  readLabelBindings,
  readLabelSelections,
} from "../src/analysis/activity-label";
import { MODEL, type ValidatedResult } from "../src/analysis/gateway";
import { ExecutionVisibilityStore } from "../src/core/execution-visibility";

const task = {
  id: "parser",
  label: "Implement CSV parser",
  revision: 1,
  sourceDigest: createHash("sha256").update("source").digest("hex"),
};
const reply = (choices: Record<string, string>): ValidatedResult => ({
  model: MODEL,
  usage: { input_tokens: 2, output_tokens: 1 },
  answers: Object.fromEntries(
    Object.entries(choices).map(([key, choice]) => [
      key,
      {
        type: "choice" as const,
        choice,
        confidence: 1,
        probabilities: { [choice]: 1 },
      },
    ]),
  ),
});
function fixture() {
  let now = 1000;
  const store = new ExecutionVisibilityStore({ now: () => now });
  store.startRun();
  const capture = (text = "I am inspecting the CSV parser.") => {
    const b = store.capture(text);
    if (!b) throw Error("fixture capture");
    const selections = readLabelSelections(
      b,
      reply({
        currentCandidate: b.candidates[0].id,
        historyCandidate: b.candidates[0].id,
      }),
    );
    const bindings = readLabelBindings(
      selections,
      [task],
      reply({ currentTask: task.id, historyTask: task.id }),
    );
    return { b, selections, bindings };
  };
  return {
    store,
    capture,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe("runtime-only execution visibility", () => {
  it("starts qualified, empty, with owner-approved independent 1024-call budget", () => {
    const { store } = fixture();
    expect(store.snapshot()).toMatchObject({
      coverage: "since-monitoring-resumed",
      actions: [],
      usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
      budgetRemaining: 1024,
    });
    expect(store.snapshot().current).toBeUndefined();
  });
  it("allows unbound provisional current but no history before canonical confirmation", () => {
    const { store, capture } = fixture();
    const { b, selections, bindings } = capture();
    store.acceptSelections(b.liveToken, selections);
    expect(store.snapshot().current).toMatchObject({
      kind: "reported",
      text: b.text,
      provisional: true,
    });
    expect(store.snapshot().current?.task).toBeUndefined();
    store.acceptBindings(b.liveToken, bindings, [task]);
    expect(store.snapshot().actions).toEqual([]);
    expect(store.confirm(b.liveToken, b.text)).toBe(true);
    store.acceptBindings(b.liveToken, bindings, [task]);
    expect(store.snapshot().current).toMatchObject({
      provisional: false,
      task,
    });
    expect(store.snapshot().actions).toHaveLength(1);
    expect(store.snapshot().actions[0]).toMatchObject({
      task,
      candidate: { quote: b.text },
    });
  });
  it("rejects changed canonical prose and stale early receipts", () => {
    const { store, capture } = fixture();
    const { b, selections, bindings } = capture();
    store.acceptSelections(b.liveToken, selections);
    expect(store.confirm(b.liveToken, "The listener removed the report.")).toBe(
      false,
    );
    store.acceptBindings(b.liveToken, bindings, [task]);
    expect(store.snapshot().current).toBeUndefined();
    expect(store.snapshot().actions).toEqual([]);
    expect(store.snapshot().coverage).toBe("incomplete");
  });
  it("admits current only within five seconds from ingress, not response", () => {
    const { store, capture, advance } = fixture();
    const { b, selections } = capture();
    advance(5001);
    store.acceptSelections(b.liveToken, selections);
    expect(store.snapshot().current).toBeUndefined();
  });
  it("latest source wins over older in-flight current results", () => {
    const { store, capture } = fixture();
    const old = capture();
    const latest = capture("I am fixing CSV escapes.");
    store.acceptSelections(latest.b.liveToken, latest.selections);
    store.acceptSelections(old.b.liveToken, old.selections);
    expect(store.snapshot().current?.text).toBe(latest.b.text);
  });
  it("settlement clears current but keeps canonical history and permits fresh history completion", () => {
    const { store, capture } = fixture();
    const { b, selections, bindings } = capture();
    store.acceptSelections(b.liveToken, selections);
    store.confirm(b.liveToken, b.text);
    store.settle();
    store.acceptBindings(b.liveToken, bindings, [task]);
    expect(store.snapshot().current).toBeUndefined();
    expect(store.snapshot().actions).toHaveLength(1);
    store.startRun();
    expect(store.snapshot().actions).toHaveLength(1);
  });
  it("rejects changed task source/revision and duplicate history receipts", () => {
    const { store, capture } = fixture();
    const { b, bindings } = capture();
    store.confirm(b.liveToken, b.text);
    store.acceptBindings(b.liveToken, bindings, [{ ...task, revision: 2 }]);
    expect(store.snapshot().actions).toHaveLength(0);
    store.acceptBindings(b.liveToken, bindings, [task]);
    store.acceptBindings(b.liveToken, bindings, [task]);
    expect(store.snapshot().actions).toHaveLength(1);
  });
  it("drops history outside latest eight observations", () => {
    const { store, capture } = fixture();
    const old = capture();
    store.confirm(old.b.liveToken, old.b.text);
    for (let i = 0; i < 8; i++) capture(`I am inspecting parser case ${i}.`);
    store.acceptBindings(old.b.liveToken, old.bindings, [task]);
    expect(store.snapshot().actions).toEqual([]);
    expect(store.snapshot().coverage).toBe("incomplete");
  });
  it("caps per-task history at16, retains newest with explicit gap", () => {
    const { store, capture } = fixture();
    for (let i = 0; i < 18; i++) {
      const { b, bindings } = capture(`I validated parser case ${i}.`);
      store.confirm(b.liveToken, b.text);
      store.acceptBindings(b.liveToken, bindings, [task]);
    }
    expect(store.snapshot().actions).toHaveLength(16);
    expect(store.snapshot().coverage).toBe("incomplete");
  });
  it("tool phases are unattributed, terminal clears only matching call, never add history", () => {
    const { store } = fixture();
    store.toolStart("call1", "Inspecting code");
    store.toolStart("call2", "Editing code");
    store.toolEnd("call1");
    expect(store.snapshot().current).toMatchObject({
      kind: "tool",
      text: "Editing code",
    });
    expect(store.snapshot().current?.task).toBeUndefined();
    store.toolEnd("call2");
    expect(store.snapshot().current).toBeUndefined();
    expect(store.snapshot().actions).toEqual([]);
  });
  it("counts dispatch including failures; budget exhaustion still allows local tool activity", () => {
    const { store } = fixture();
    for (let i = 0; i < 1024; i++) expect(store.recordDispatch()).toBe(true);
    expect(store.recordDispatch()).toBe(false);
    expect(store.snapshot().budgetRemaining).toBe(0);
    expect(store.snapshot().usage.calls).toBe(1024);
    store.recordUsage({ input_tokens: 10, output_tokens: 2 });
    expect(store.snapshot().usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
    });
    store.toolStart("local", "Using a tool");
    expect(store.snapshot().current?.text).toBe("Using a tool");
  });
  it("reset fences all prior replies and clears usage/history without restoration", () => {
    const { store, capture } = fixture();
    const { b, bindings } = capture();
    store.confirm(b.liveToken, b.text);
    store.recordDispatch();
    const generation = store.snapshot().generation;
    store.reset();
    store.acceptBindings(b.liveToken, bindings, [task]);
    expect(store.snapshot()).toMatchObject({
      generation: generation + 1,
      actions: [],
      budgetRemaining: 1024,
    });
    expect(store.snapshot().current).toBeUndefined();
  });
  it("snapshots are detached copies", () => {
    const { store, capture } = fixture();
    const { b, bindings } = capture();
    store.confirm(b.liveToken, b.text);
    store.acceptBindings(b.liveToken, bindings, [task]);
    const snapshot = store.snapshot();
    snapshot.actions[0].task.label = "MUTATED";
    snapshot.usage.calls = 999;
    expect(store.snapshot().actions[0].task.label).toBe(task.label);
    expect(store.snapshot().usage.calls).toBe(0);
  });
});

it("preserves MAYBE binding assessment without altering semantic task data", () => {
  const { store, capture } = fixture();
  const { b, selections } = capture();
  const r = reply({ currentTask: task.id, historyTask: task.id });
  for (const answer of Object.values(r.answers)) answer.confidence = 0.84;
  const bindings = readLabelBindings(selections, [task], r);
  store.confirm(b.liveToken, b.text);
  store.acceptBindings(b.liveToken, bindings, [task]);
  expect(store.snapshot().current).toMatchObject({ certainty: "maybe", task });
  expect(store.snapshot().actions[0]).toMatchObject({
    certainty: "maybe",
    assessment: { confidence: 0.84, probability: 1 },
  });
});

it("retains canonical current-only MAYBE across settlement and newer status prose", () => {
  const { store, capture } = fixture();
  const { b } = capture();
  const selections = readLabelSelections(
    b,
    reply({ currentCandidate: b.candidates[0].id, historyCandidate: "none" }),
  );
  const answer = reply({ currentTask: task.id });
  answer.answers.currentTask.confidence = 0.84;
  const bindings = readLabelBindings(selections, [task], answer);
  store.confirm(b.liveToken, b.text);
  store.acceptBindings(b.liveToken, bindings, [task]);
  expect(store.snapshot().actions).toHaveLength(0);
  store.settle();
  expect(store.maybeAssociations()).toHaveLength(1);
  store.startRun();
  capture("The task is still pending.");
  expect(store.maybeAssociations()).toHaveLength(1);
  store.reset();
  expect(store.maybeAssociations()).toEqual([]);
});
it("action snapshot never shares nested candidate assessment with internal state", () => {
  const { store, capture } = fixture();
  const { b, bindings } = capture();
  store.confirm(b.liveToken, b.text);
  store.acceptBindings(b.liveToken, bindings, [task]);
  const before = JSON.stringify(store.snapshot());
  const snapshot = store.snapshot();
  const extra = Reflect.get(snapshot.actions[0].candidate, "assessment");
  if (extra) extra.confidence = 0;
  expect(JSON.stringify(store.snapshot())).toBe(before);
});
