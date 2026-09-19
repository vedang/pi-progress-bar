import { expect, it } from "vitest";
import { processObservation } from "../src/core/hybrid";
import {
  encodeCheckpoint,
  restoreCheckpoint,
} from "../src/core/hybrid-checkpoint";
import type { HybridState, Observation } from "../src/core/hybrid-state";
import {
  backend,
  initial,
  initialMessage,
  noPatch,
  observation,
} from "./fixtures/hybrid";

function object(value: unknown): Record<string, unknown> {
  expect(value).toBeDefined();
  expect(value).toBeTypeOf("object");
  if (!value || typeof value !== "object")
    throw new Error("Required journal object");
  return value as Record<string, unknown>;
}
function first(value: unknown) {
  expect(Array.isArray(value)).toBe(true);
  return object((value as unknown[])[0]);
}
function record(state: HybridState) {
  return object(object(state.pending).journal);
}
function restore(checkpoint: unknown, messages: Observation[]) {
  return Reflect.apply(restoreCheckpoint, undefined, [
    checkpoint,
    "session:test",
    (id: string) => messages.find((message) => message.id === id),
    () => [],
  ]);
}
async function capture(patch = false) {
  const state = await initial();
  if (patch && state.tasks[2]) state.tasks[2].included = false;
  const latest = observation(
    "replay",
    "Revise the parser, archive the regression, restore validation, and add a report.",
  );
  const outcome = patch
    ? {
        add: [
          {
            label: "Deliver report",
            kind: "action" as const,
            basis: "explicit" as const,
            quote: latest.text,
          },
        ],
        revise: [
          {
            id: "task:1",
            label: "Revised parser",
            requirementsChanged: true,
            quote: latest.text,
          },
        ],
        archive: [{ id: "task:2", quote: latest.text }],
        restore: [
          {
            id: "task:3",
            label: "Revalidate parser",
            requirementsChanged: true,
            quote: latest.text,
          },
        ],
        unresolved: false,
      }
    : noPatch();
  const saved: HybridState[] = [];
  await processObservation(
    state,
    latest,
    backend(outcome, {
      gate: "changed",
      complete: "yes",
      save: (value) => saved.push(structuredClone(value)),
    }),
  );
  const gate = saved.find((value) => value.pending?.phase === "extract");
  const complete = saved.filter((value) => value.pending?.phase === "complete");
  if (!gate || !complete[0] || !complete.at(-1))
    throw new Error("Missing accepted snapshots");
  return {
    gate,
    patched: complete[0],
    completed: complete.at(-1) as HybridState,
    messages: [initialMessage, latest],
  };
}

it.each([
  "prior-assessment",
  "assessment",
  "focus",
  "counter",
  "unresolved",
  "cursor-role",
])("anchors gate origin and transition: %s", async (variant) => {
  const c = await capture();
  const checkpoint = encodeCheckpoint(c.gate);
  const gate = object(record(checkpoint.state).gate);
  expect(restore(checkpoint, c.messages)).toBeDefined();
  if (variant === "prior-assessment") {
    expect(object(gate.priorScopeAssessment).present).toBe(true);
    gate.priorScopeAssessment = { present: false };
  }
  if (variant === "assessment") object(gate.assessment).rawChoice = "unchanged";
  if (variant === "focus") delete checkpoint.state.focusTaskId;
  if (variant === "counter") checkpoint.state.nextTaskId++;
  if (variant === "unresolved")
    checkpoint.state.scopeUnresolved = !checkpoint.state.scopeUnresolved;
  if (variant === "cursor-role")
    Reflect.set(object(checkpoint.state.cursor), "role", "assistant");
  expect(restore(checkpoint, c.messages)).toBeUndefined();
});

it.each([
  "revise-label",
  "revise-status",
  "revise-revision",
  "index",
  "archive-included",
  "restore-included",
  "counter",
  "focus",
  "unresolved",
  "event-length",
])("rejects corrupt patch undo: %s", async (variant) => {
  const c = await capture(true);
  const checkpoint = encodeCheckpoint(c.patched);
  const undo = object(object(record(checkpoint.state).patch).undo);
  expect(restore(checkpoint, c.messages)).toBeDefined();
  if (variant === "revise-label")
    first(undo.revise).label = "Forged previous label";
  if (variant === "revise-status") first(undo.revise).status = "done";
  if (variant === "revise-revision") first(undo.revise).revision = 2;
  if (variant === "index") first(undo.revise).index = 1;
  if (variant === "archive-included") first(undo.archive).included = false;
  if (variant === "restore-included") first(undo.restore).included = true;
  if (variant === "counter") undo.nextTaskId = 100;
  if (variant === "focus") undo.focusTaskId = { present: false };
  if (variant === "unresolved") undo.scopeUnresolved = true;
  if (variant === "event-length") undo.eventLength = 0;
  expect(restore(checkpoint, c.messages)).toBeUndefined();
});

it.each([
  "prior-status",
  "assessment-presence",
  "assessment-value",
  "event-length",
  "chunk-order",
  "event-prefix",
  "event-suffix",
])("replays completion against the exact prior state: %s", async (variant) => {
  const c = await capture();
  const checkpoint = encodeCheckpoint(c.completed);
  const completion = first(record(checkpoint.state).completions);
  const undo = object(completion.undo);
  expect(restore(checkpoint, c.messages)).toBeDefined();
  if (variant === "prior-status") first(undo.tasks).status = "done";
  if (variant === "assessment-presence")
    first(undo.tasks).latestAssessment = { present: false };
  if (variant === "assessment-value")
    object(object(first(undo.tasks).latestAssessment).value).confidence = 0.6;
  if (variant === "event-length") undo.eventLength = 0;
  if (variant === "chunk-order") (completion.chunkIds as unknown[]).reverse();
  if (variant === "event-prefix" && checkpoint.state.events[0])
    checkpoint.state.events[0].kind = "revise";
  if (variant === "event-suffix") {
    const event = checkpoint.state.events.at(-1);
    if (event) event.kind = "withdraw";
  }
  expect(restore(checkpoint, c.messages)).toBeUndefined();
});

it("stores normalized outcomes and undo, not redundant projection/hash/event aliases or raw quotes", async () => {
  const c = await capture(true);
  const pending = object(c.completed.pending);
  const journal = record(c.completed);
  expect(Object.keys(pending).sort()).toEqual([
    "block",
    "journal",
    "observation",
    "phase",
  ]);
  expect(Object.keys(journal).sort()).toEqual(["completions", "gate", "patch"]);
  for (const item of [
    object(journal.gate),
    object(journal.patch),
    first(journal.completions),
  ]) {
    for (const field of [
      "tasks",
      "events",
      "inputHash",
      "resultHash",
      "results",
      "taskIds",
    ])
      expect(item).not.toHaveProperty(field);
  }
  expect(JSON.stringify(encodeCheckpoint(c.completed))).not.toContain(
    initialMessage.text,
  );
  expect(JSON.stringify(encodeCheckpoint(c.completed))).not.toContain(
    c.messages[1]?.text,
  );
  expect(JSON.stringify(journal)).not.toContain('"quote":');
  expect(restore(encodeCheckpoint(c.completed), c.messages)).toBeDefined();
});

it.each(["gate", "patch", "completion"])(
  "rebuilds the actual %s request instead of treating requestHash as opaque",
  async (phase) => {
    const c = await capture(true);
    const state =
      phase === "gate" ? c.gate : phase === "patch" ? c.patched : c.completed;
    const checkpoint = encodeCheckpoint(state);
    const journal = record(checkpoint.state);
    expect(restore(checkpoint, c.messages)).toBeDefined();
    const request =
      phase === "completion"
        ? first(journal.completions)
        : object(journal[phase]);
    request.requestHash = "f".repeat(64);
    expect(restore(checkpoint, c.messages)).toBeUndefined();
  },
);

it("has no hidden runtime compatibility aliases on pending transactions", async () => {
  const c = await capture();
  record(c.completed);
  for (const field of [
    "completedTaskIds",
    "completionHashes",
    "gateHash",
    "patchHash",
    "proofs",
  ]) {
    expect(c.completed.pending).not.toHaveProperty(field);
    expect(
      Object.getOwnPropertyDescriptor(c.completed.pending, field),
    ).toBeUndefined();
  }
});
