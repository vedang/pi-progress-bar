import { expect, it } from "vitest";
import {
  groundPatch,
  parsePatch,
  type ScopePatch,
} from "../src/analysis/extractor";
import { type AdmissionPlan, processObservation } from "../src/core/hybrid";
import {
  checkpointBytes,
  encodeCheckpoint,
  restoreCheckpoint,
} from "../src/core/hybrid-checkpoint";
import type { HybridState } from "../src/core/hybrid-state";
import {
  backend,
  initial,
  initialMessage,
  noPatch,
  observation,
} from "./fixtures/hybrid";

const latest = observation(
  "fourth-review",
  `${"x".repeat(1000)} unique instruction`,
  "assistant",
);
const tiny = 0.0000010000000000000002;
async function ledger(active = 20, archived = 0) {
  const state = await initial();
  const task = state.tasks[0],
    event = state.events[0];
  if (!task || !event) throw new Error("Missing seed");
  state.tasks = Array.from({ length: active + archived }, (_, index) => ({
    ...structuredClone(task),
    id: `task:${index + 1}`,
    label: `Existing ${index + 1}`,
    included: index < active,
  }));
  state.events = state.tasks.map((task, index) => ({
    ...structuredClone(event),
    id: `event:${index + 1}`,
    taskId: task.id,
  }));
  state.nextTaskId = state.tasks.length + 1;
  return state;
}
function padEvents(state: HybridState, target: number) {
  const first = state.events[0];
  if (!first) throw new Error("Missing seed event");
  const start = state.events.length;
  for (let index = start; index < 900; index++)
    state.events.push({
      ...structuredClone(first),
      id: `event:${index + 1}`,
      kind: "revise",
    });
  const remaining = target - checkpointBytes(state);
  const padding = Math.floor(remaining / (900 - start));
  expect(padding).toBeGreaterThan(0);
  for (let index = start; index < 900; index++) {
    const event = state.events[index];
    if (event) event.source.entryId += "h".repeat(padding);
  }
  const tail = state.events.at(-1);
  if (!tail) throw new Error("Missing last event");
  tail.source.entryId += "r".repeat(target - checkpointBytes(state));
  expect(checkpointBytes(state)).toBe(target);
}
function restore(checkpoint: unknown) {
  return restoreCheckpoint(
    checkpoint,
    "session:test",
    (id) => [initialMessage, latest].find((o) => o.id === id),
    () => [],
  );
}
async function journal() {
  const saved: HybridState[] = [];
  await processObservation(
    await initial(),
    latest,
    backend(noPatch(), {
      gate: "unchanged",
      focus: "task:2",
      save: (state) => saved.push(structuredClone(state)),
    }),
  );
  const state = saved.find((s) => s.pending?.journal.completions.length);
  if (!state) throw new Error("Missing accepted completion");
  expect(restore(encodeCheckpoint(state))).toBeDefined();
  return state;
}

it.each(["confidence", "probability"] as const)(
  "rejects impossible accepted focus with low %s",
  async (field) => {
    const checkpoint = encodeCheckpoint(await journal());
    const assessment =
      checkpoint.state.pending?.journal.completions[0]?.focus?.assessment;
    if (!assessment) throw new Error("Missing focus");
    assessment[field] = field === "confidence" ? 0.49 : 0.79;
    expect(restore(checkpoint)).toBeUndefined();
  },
);
it("rejects a phase-invalid completion choice even with matching task copy", async () => {
  const checkpoint = encodeCheckpoint(await journal());
  const record = checkpoint.state.pending?.journal.completions[0];
  const assessment = record?.assessments[0];
  const task = checkpoint.state.tasks.find((t) => t.id === record?.chunkIds[0]);
  if (!assessment || !task?.latestAssessment)
    throw new Error("Missing assessment");
  assessment.rawChoice = "changed";
  task.latestAssessment.rawChoice = "changed";
  expect(restore(checkpoint)).toBeUndefined();
});
it.each(["hash", "range"])(
  "rejects corrupt archive journal source %s",
  async (kind) => {
    const saved: HybridState[] = [];
    const patch = {
      ...noPatch(),
      archive: [{ id: "task:1", quote: "unique instruction" }],
    };
    await processObservation(
      await initial(),
      latest,
      backend(patch, { save: (state) => saved.push(structuredClone(state)) }),
    );
    const state = saved.find((s) => s.pending?.journal.patch);
    if (!state) throw new Error("Missing accepted patch");
    const checkpoint = encodeCheckpoint(state);
    expect(restore(checkpoint)).toBeDefined();
    const source =
      checkpoint.state.pending?.journal.patch?.outcome.archive[0]?.source;
    if (!source) throw new Error("Missing archive source");
    if (kind === "hash") source.quoteHash = "0".repeat(64);
    else source.start = 0;
    expect(restore(checkpoint)).toBeUndefined();
  },
);

it.each(["archive-add-revise", "archive-restore-revise"])(
  "extraction admission dominates legal combined %s",
  async (kind) => {
    const state = await ledger(20, kind === "archive-restore-revise" ? 12 : 0);
    padEvents(state, 400 * 1024);
    const label = "\ud800".repeat(240);
    const quote = "unique instruction";
    const patch: ScopePatch =
      kind === "archive-add-revise"
        ? {
            ...noPatch(),
            archive: state.tasks.slice(0, 6).map((t) => ({ id: t.id, quote })),
            revise: state.tasks.slice(6, 18).map((t) => ({
              id: t.id,
              label,
              requirementsChanged: true,
              quote,
            })),
            add: Array.from({ length: 6 }, (_, i) => ({
              label: `${label.slice(1)}${String.fromCharCode(0xd801 + i)}`,
              kind: "action",
              basis: "explicit",
              quote,
            })),
          }
        : {
            ...noPatch(),
            archive: state.tasks.slice(0, 12).map((t) => ({ id: t.id, quote })),
            revise: state.tasks.slice(12, 20).map((t) => ({
              id: t.id,
              label,
              requirementsChanged: true,
              quote,
            })),
            restore: state.tasks.slice(20).map((t) => ({
              id: t.id,
              label,
              requirementsChanged: true,
              quote,
            })),
          };
    // Assert fixture is a legal parser outcome, not an oversized provider envelope.
    expect(parsePatch(JSON.stringify(patch))).toEqual(patch);
    let admitted = 0;
    const saved: HybridState[] = [];
    const p = Object.assign(
      backend(patch, { save: (s) => saved.push(structuredClone(s)) }),
      {
        admit: (plan: AdmissionPlan) => {
          if (plan.phase === "extraction")
            admitted = checkpointBytes(plan.candidate) + plan.schemaBytes;
          return plan.phase !== "completion";
        },
      },
    );
    await processObservation(state, latest, p);
    const accepted = saved.find((s) => s.pending?.journal.patch);
    expect(accepted).toBeDefined();
    if (!accepted) throw new Error("Patch never committed");
    expect(accepted.tasks.filter((t) => t.included)).toHaveLength(20);
    expect(Number.isFinite(admitted)).toBe(true);
    expect(checkpointBytes(accepted)).toBeLessThanOrEqual(admitted);
  },
);
it("gate admission covers both longest scalar/reason copies", async () => {
  const saved: HybridState[] = [];
  let admitted = 0;
  const p = Object.assign(
    backend(noPatch(), {
      gate: "unchanged",
      save: (s) => saved.push(structuredClone(s)),
    }),
    {
      admit: (plan: AdmissionPlan) => {
        if (plan.phase === "gate")
          admitted = checkpointBytes(plan.candidate) + plan.schemaBytes;
        return plan.phase === "gate";
      },
    },
  );
  const evaluate = p.evaluate.getMockImplementation();
  if (!evaluate) throw new Error("Missing evaluator");
  p.evaluate.mockImplementation(async (request) => {
    const result = await evaluate(request);
    const answer = result.answers.gate;
    if (answer?.type === "choice") {
      answer.confidence = tiny;
      answer.probabilities = {
        unchanged: tiny,
        changed: 1 - tiny,
        uncertain: 0,
      };
    }
    return result;
  });
  await processObservation(await initial(), latest, p);
  const accepted = saved.find((s) => s.pending?.journal.gate);
  if (!accepted) throw new Error("Gate never committed");
  expect(checkpointBytes(accepted)).toBeLessThanOrEqual(admitted);
});

it.each([false, true])(
  "completion envelope bounds duplicated abstention scalars and tied outside-chunk focus (abstain=%s)",
  async (abstain) => {
    const state = await ledger();
    state.tasks.forEach((task, index) => {
      task.id = `task:${index + 10}`;
    });
    state.events.forEach((event, index) => {
      event.taskId = `task:${index + 10}`;
    });
    state.nextTaskId = 30;
    state.focusTaskId = "task:10";
    const saved: HybridState[] = [];
    let admitted = 0,
      chunks = 0;
    const p = Object.assign(
      backend(noPatch(), {
        gate: "unchanged",
        complete: abstain ? "uncertain" : "yes",
        focus: "task:29",
        save: (s) => saved.push(structuredClone(s)),
      }),
      {
        admit: (plan: AdmissionPlan) => {
          if (plan.phase !== "completion") return true;
          if (++chunks > 1) return false;
          admitted = checkpointBytes(plan.candidate) + plan.schemaBytes;
          return true;
        },
      },
    );
    const evaluate = p.evaluate.getMockImplementation();
    if (!evaluate) throw new Error("Missing evaluator");
    p.evaluate.mockImplementation(async (request) => {
      const result = await evaluate(request);
      for (const [key, answer] of Object.entries(result.answers)) {
        if (!key.startsWith("complete:") || answer.type !== "choice") continue;
        answer.confidence = abstain ? tiny : 0.5000000000000001;
        answer.probabilities = abstain
          ? { yes: 1 - tiny, no: 0, uncertain: tiny }
          : { yes: 0.8000000000000002, no: 0.1999999999999998, uncertain: 0 };
      }
      return result;
    });
    await processObservation(state, latest, p);
    const accepted = saved.find((s) => s.pending?.journal.completions.length);
    if (!accepted) throw new Error("No accepted prefix");
    expect(accepted.pending?.journal.completions[0]?.chunkIds).not.toContain(
      "task:29",
    );
    expect(accepted.focusTaskId).toBe("task:29");
    expect(checkpointBytes(accepted)).toBeLessThanOrEqual(admitted);
  },
);

it.each(["bad\nlabel", "bad\u200blabel"])(
  "rejects checkpoint-ineligible generated label %j before mutation",
  (label) => {
    expect(() =>
      parsePatch(
        JSON.stringify({
          ...noPatch(),
          add: [
            {
              label,
              kind: "action",
              basis: "explicit",
              quote: "unique instruction",
            },
          ],
        }),
      ),
    ).toThrow();
  },
);
it.each([
  ["aaa", "aa"],
  ["界界界", "界界"],
])("rejects overlapping repeated quote in %s", (text, quote) => {
  const message = observation("overlap", text);
  const patch = parsePatch(
    JSON.stringify({
      ...noPatch(),
      add: [{ label: "Work", kind: "action", basis: "explicit", quote }],
    }),
  );
  expect(() => groundPatch(patch, message, new Set())).toThrow();
});
