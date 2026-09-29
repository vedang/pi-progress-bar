import { expect, it, vi } from "vitest";
import { MODEL } from "../src/analysis/gateway";
import { buildSubtaskGate } from "../src/analysis/subtask-gate";
import {
  SubtaskRuntime,
  type SubtaskRuntimeCheckpoint,
  type SubtaskRuntimeOptions,
} from "../src/core/subtask-runtime";
import { subtaskQualificationFixture } from "./fixtures/subtask-qualification";

it.each(["user", "assistant", "intercom"] as const)(
  "qualification fixture preserves existing children and %s context through actual gate accounting",
  async (role) => {
    const h = subtaskQualificationFixture(
      {
        id: `fixture-${role}`,
        label: "Review two specifications",
        request: "Review the red and blue specifications.",
        need: "no",
        children: ["Review red specification", "Review blue specification"],
        latest: { role, text: "The tracked list is unchanged." },
        earlier: [{ role: "user", text: "A separate team owns the release." }],
        omissions: ["Unrelated release log omitted."],
        requiredConcepts: [],
        reports: [],
      },
      "fixture/selected",
    );
    const { latest, earlier, omissions, selectedModel, resolve } = h.current();
    const expected = buildSubtaskGate({
      parent: h.parent,
      group: h.group,
      latest,
      earlier,
      omissions,
      selectedModel,
      resolve,
    });
    expect(expected).toBeDefined();
    const propose = vi.fn(async () => undefined);
    const commits: SubtaskRuntimeCheckpoint[] = [];
    const gate = vi.fn<SubtaskRuntimeOptions["gate"]>(
      async (batch, signal, dispatch) => {
        expect(batch.request).toEqual(expected?.request);
        expect(batch.request.state).toMatchObject({
          latest: { role },
          omissions: ["Unrelated release log omitted."],
        });
        expect(signal.aborted).toBe(false);
        expect(dispatch(Date.now())).toBe(true);
        return {
          model: MODEL,
          usage: { input_tokens: 3, output_tokens: 2 },
          answers: {
            "subtask:0": {
              type: "choice" as const,
              choice: "no",
              confidence: 1,
              probabilities: { yes: 0, no: 1, uncertain: 0 },
            },
          },
        };
      },
    );
    const runtime = new SubtaskRuntime({
      initial: h.initial,
      current: h.current,
      gate,
      propose,
      commit: (candidate) => {
        commits.push(candidate);
        return true;
      },
      onPublish: () => {},
    });
    try {
      await runtime.run(h.parent.id);
      expect(gate).toHaveBeenCalledTimes(1);
      expect(propose).not.toHaveBeenCalled();
      expect(
        runtime.snapshot().groups[0].children.map((child) => child.label),
      ).toEqual(["Review red specification", "Review blue specification"]);
      expect(commits.at(-1)?.journal.records[0]).toMatchObject({
        phase: "gate-decided",
        state: "complete",
        gate: { outcome: "decided", choice: "no" },
      });
    } finally {
      runtime.invalidate();
    }
  },
);

it("records actual positive admission while a qualification-only fence spends no proposal ticket", async () => {
  const h = subtaskQualificationFixture(
    {
      id: "fence",
      label: "Give a number",
      request: "Give only the number seven.",
      need: "no",
      requiredConcepts: [],
      reports: [],
    },
    "fixture/selected",
  );
  let admitted = false,
    fenced = false;
  const runtime = new SubtaskRuntime({
    initial: h.initial,
    current: h.current,
    gate: async (_batch, _signal, dispatch) => {
      expect(dispatch(Date.now())).toBe(true);
      return {
        model: MODEL,
        usage: { input_tokens: 3, output_tokens: 2 },
        answers: {
          "subtask:0": {
            type: "choice",
            choice: "yes",
            confidence: 1,
            probabilities: { yes: 1, no: 0, uncertain: 0 },
          },
        },
      };
    },
    propose: async () => {
      expect(admitted).toBe(true);
      fenced = true;
      return undefined;
    },
    commit: (candidate) => {
      if (
        candidate.journal.records.some(
          (r) => r.phase === "gate-decided" && r.state === "ready",
        )
      )
        admitted = true;
      return true;
    },
    onPublish: () => {},
  });
  try {
    await runtime.run(h.parent.id);
    expect({ admitted, fenced }).toEqual({ admitted: true, fenced: true });
    expect(runtime.checkpoint().journal.dispatches).toBe(1);
    expect(runtime.checkpoint().journal.usage.extraction.calls).toBe(0);
    expect(runtime.snapshot().groups).toEqual([]);
  } finally {
    runtime.invalidate();
  }
});
