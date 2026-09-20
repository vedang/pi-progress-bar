import { expect, it } from "vitest";
import {
  completionDecisions,
  completionRequest,
} from "../src/analysis/completion";
import { extractionInput, groundPatch } from "../src/analysis/extractor";
import { gateRequest } from "../src/analysis/gate";
import { processObservation } from "../src/core/hybrid";
import {
  encodeCheckpoint,
  restoreCheckpoint,
} from "../src/core/hybrid-checkpoint";
import type { HybridState } from "../src/core/hybrid-state";
import { canonicalMessages } from "../src/sources/messages";
import {
  backend,
  initial,
  initialMessage,
  noPatch,
  observation,
} from "./fixtures/hybrid";

// H1 characterizes CURRENT consumers, not the future safety contract. Adversarial
// typed answers below demonstrate structural acceptance, not live Jev accuracy.
// S0 must decide the minimal prerequisite before real delivery is enabled.
const row = "task:1 — Implement parser";
const directive =
  "Status reconciliation only: explain which listed items are complete, pending, blocked, or no longer required, and any tracking mismatch. Do not start or continue work because of this message, and do not claim completion merely to clear the display.";
const content = `[Progress advisory]\n${row}\n${directive}`;
const custom = {
  type: "custom_message",
  id: "advisory-1",
  customType: "pi-progress-advisory",
  content,
  display: true,
  details: { sendId: "send-1", opportunityId: "run-1" },
};
const answerEntry = (text: string) => ({
  type: "message",
  id: "answer-1",
  parentId: custom.id,
  message: { role: "assistant", content: text, stopReason: "stop" },
});

it("H1 excludes advisory custom/state entries but admits exact correlated assistant echoes unchanged", () => {
  const entries = [
    custom,
    {
      type: "custom",
      id: "state-1",
      customType: "pi-progress-advisory-state",
      data: {},
    },
    answerEntry(content),
  ];
  const observations = canonicalMessages(entries);
  expect(observations).toEqual([observation("answer-1", content, "assistant")]);
  // No host details/run correlation or excluded spans survive canonical intake.
  expect(Object.keys(observations[0] ?? {}).sort()).toEqual([
    "hash",
    "id",
    "role",
    "text",
  ]);
});

it.each([
  ["full-echo", content],
  ["copied-directive", directive],
  ["copied-row", row],
  [
    "mixed-answer",
    `${row}\nThe parser implementation is complete; regression and validation remain pending.`,
  ],
  [
    "independent-status",
    "The parser implementation is complete; regression and validation remain pending.",
  ],
])(
  "H1 current whole-message contracts have no advisory exclusion proof: %s",
  async (_kind, text) => {
    const state = await initial();
    const latest = observation("answer-1", text ?? "", "assistant");
    const gate = gateRequest(state, latest, []);
    const extraction = extractionInput(state, latest, []);
    const completion = completionRequest(latest, state.tasks, []);
    expect((gate.state as { latest: unknown }).latest).toEqual(latest);
    expect(extraction.latest).toEqual(latest);
    expect((completion.state as { latest: unknown }).latest).toEqual(latest);
    const transport = backend(noPatch(), {
      gate: "unchanged",
      complete: { "task:1": "yes" },
      focus: "none",
    });
    const result = await transport.evaluate(completion);
    const decisions = completionDecisions(result, latest, state.tasks);
    expect(decisions[0]?.status).toBe("done");
    expect(decisions[0]?.assessment.source).toEqual({
      entryId: latest.id,
      messageHash: latest.hash,
      role: "assistant",
    });
    // No claim-support span can distinguish copied material from the independent
    // status sentence; high-confidence yes is structurally accepted for either.
    expect(Object.keys(decisions[0]?.assessment.source ?? {}).sort()).toEqual([
      "entryId",
      "messageHash",
      "role",
    ]);
  },
);

it("H1 exact extraction grounding accepts a copied row and independent status without distinguishing authority", async () => {
  const state = await initial();
  const latest = observation(
    "answer-1",
    `${row}\nThe parser is complete.`,
    "assistant",
  );
  const patch = {
    ...noPatch(),
    add: [
      {
        label: "Implement parser",
        kind: "action" as const,
        basis: "explicit" as const,
        quote: row,
      },
    ],
  };
  const grounded = groundPatch(
    patch,
    latest,
    new Set(state.tasks.map((t) => t.id)),
  );
  expect(grounded.add[0]?.source).toMatchObject({
    entryId: latest.id,
    start: 0,
    end: row.length,
  });
  expect(
    latest.text.slice(
      grounded.add[0]?.source.start,
      grounded.add[0]?.source.end,
    ),
  ).toBe(row);
});

it("H1 real status answers can update the existing board and resume accepted pending completion without rebilling", async () => {
  const state = await initial();
  const latest = observation(
    "answer-1",
    `${row}\nThe parser implementation is complete; regression and validation remain pending.`,
    "assistant",
  );
  const snapshots: HybridState[] = [];
  const transport = backend(noPatch(), {
    gate: "unchanged",
    complete: { "task:1": "yes" },
    focus: "none",
    save: (value) => snapshots.push(structuredClone(value)),
  });
  const completed = await processObservation(state, latest, transport);
  expect(completed.tasks.map((t) => t.status)).toEqual([
    "done",
    "not-started",
    "not-started",
  ]);
  expect(completed.tasks.map((t) => t.label)).toEqual(
    state.tasks.map((t) => t.label),
  );
  expect(transport.extract).not.toHaveBeenCalled();
  const pending = [...snapshots]
    .reverse()
    .find((s) => s.pending?.journal.completions.length);
  if (!pending)
    throw new Error("Missing accepted pending-completion checkpoint");
  const sources = [initialMessage, latest];
  const restored = restoreCheckpoint(
    encodeCheckpoint(pending),
    "session:test",
    (id) => sources.find((s) => s.id === id),
    () => [],
  );
  expect(restored).toBeDefined();
  if (!restored) throw new Error("Could not restore current proof");
  const resumedTransport = backend();
  const resumed = await processObservation(restored, latest, resumedTransport);
  expect(resumed.tasks.map((t) => t.status)).toEqual(
    completed.tasks.map((t) => t.status),
  );
  expect(resumedTransport.evaluate).not.toHaveBeenCalled();
  expect(resumedTransport.extract).not.toHaveBeenCalled();
});

it("H1 truthful blocked response may leave board unchanged without forced completion", async () => {
  const state = await initial();
  const latest = observation(
    "answer-1",
    "Parser remains blocked waiting for the user to clarify the format.",
    "assistant",
  );
  const transport = backend(noPatch(), {
    gate: "unchanged",
    complete: "no",
    focus: "none",
  });
  const next = await processObservation(state, latest, transport);
  expect(next.tasks.map((t) => [t.id, t.status, t.revision])).toEqual(
    state.tasks.map((t) => [t.id, t.status, t.revision]),
  );
  expect(next.cursor?.id).toBe(latest.id);
  expect(transport.extract).not.toHaveBeenCalled();
});
