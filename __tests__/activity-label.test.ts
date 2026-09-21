import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildLabelBindingRequest,
  buildLabelCandidates,
  buildLabelSelectionRequest,
  readLabelBindings,
  readLabelSelections,
} from "../src/analysis/activity-label";
import { MODEL, type ValidatedResult } from "../src/analysis/gateway";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const bundle = (
  text = "I am inspecting the parser.\n\nParser validation passed on both hosts.",
) => {
  const value = buildLabelCandidates(text, "live-1");
  if (!value) throw new Error("fixture must fit");
  return value;
};
const tasks = Array.from({ length: 20 }, (_, i) => ({
  id: `task:${i + 1}`,
  label: `Implement subsystem ${i + 1}`,
  revision: 2,
  sourceDigest: hash(`source-${i}`),
}));
function result(
  choices: Record<string, string>,
  confidence = 1,
  probability = 1,
): ValidatedResult {
  return {
    model: MODEL,
    usage: { input_tokens: 1, output_tokens: 1 },
    answers: Object.fromEntries(
      Object.entries(choices).map(([id, choice]) => [
        id,
        {
          type: "choice" as const,
          choice,
          confidence,
          probabilities: { [choice]: probability },
        },
      ]),
    ),
  };
}

describe("lossless visibility candidate gate", () => {
  it.each([
    "Inspecting src/core/parser.ts and docs/design.md. Then validating.",
    "I checked it; it failed, but the fix is ready.",
    "> Example: ‘I completed everything.’\n\nI have not completed it.",
    "If you want, I can review. I am not reviewing yet.",
    "Inline `a.b()` and https://example.invalid/?token=FAKE.\n\n```text\nFAKE_SECRET=abcd\nnot actual evidence\n```",
    "正在检查解析器。然后验证。 👩🏽‍💻 é family 👨‍👩‍👧‍👦",
    "# Heading\n\n- Inspecting code\n- Validation failed\n\nNext paragraph.",
    "a".repeat(480),
  ])("retains every non-whitespace scalar exactly once: %s", (text) => {
    const value = bundle(text);
    expect(value.liveToken).toBe("live-1");
    expect(value.messageHash).toBe(hash(text));
    expect(value.text).toBe(text);
    expect(value.candidates.length).toBeLessThanOrEqual(12);
    const coverage = Array(text.length).fill(0);
    for (const candidate of value.candidates) {
      expect(candidate.quote).toBe(text.slice(candidate.start, candidate.end));
      expect(candidate.quoteHash).toBe(hash(candidate.quote));
      expect([...candidate.quote].length).toBeLessThanOrEqual(240);
      expect(candidate.quote.trim()).not.toBe("");
      for (let i = candidate.start; i < candidate.end; i++) coverage[i]++;
    }
    for (let i = 0; i < text.length; i++) {
      if (!/\s/u.test(text[i])) expect(coverage[i]).toBe(1);
      expect(coverage[i]).toBeLessThanOrEqual(1);
    }
    expect(new Set(value.candidates.map((c) => c.id)).size).toBe(
      value.candidates.length,
    );
  });
  it("splits on grapheme boundaries rather than slicing clusters", () => {
    const text = `${"x".repeat(237)}👨‍👩‍👧‍👦${"y".repeat(240)}`;
    const value = bundle(text);
    const boundaries = new Set([
      0,
      text.length,
      ...Array.from(
        new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text),
        (s) => s.index,
      ),
    ]);
    for (const c of value.candidates) {
      expect(boundaries.has(c.start)).toBe(true);
      expect(boundaries.has(c.end)).toBe(true);
    }
  });
  it.each([
    "",
    " \n\t ",
    "x".repeat(12 * 1024 + 1),
    "a".repeat(240 * 12 + 1),
    `a${"\u0301".repeat(240)}`,
  ])("abstains whole-message overflow/empty, never samples", (text) => {
    expect(buildLabelCandidates(text, "live-1")).toBeUndefined();
  });
  it("is deterministic and token identity is distinct", () => {
    expect(bundle()).toEqual(bundle());
    expect(buildLabelCandidates(bundle().text, "live-2")?.liveToken).toBe(
      "live-2",
    );
  });
});

describe("typed two-stage label requests", () => {
  it("explicitly excludes quoted fictional voices and fenced examples from both selections", () => {
    const request = buildLabelSelectionRequest(bundle());
    for (const question of Object.values(request?.questions ?? {})) {
      expect(question.instructions).toMatch(
        /assistant.*(?:own|actual)|(?:own|actual).*assistant/i,
      );
      expect(question.instructions).toMatch(/fiction|hypothetical/i);
      expect(question.instructions).toMatch(/quot/i);
      expect(question.instructions).toMatch(/fenc|code block/i);
      expect(question.instructions).toMatch(/example|sample/i);
      expect(question.instructions).toMatch(/(?:not|without|no need).*verif/i);
      expect(question.instructions).toMatch(
        /quote.*(?:field|serialization)|(?:field|serialization).*quote/i,
      );
    }
  });
  it("asks only current/history selection with explicit abstention options", () => {
    const b = bundle();
    const request = buildLabelSelectionRequest(b);
    expect(request?.model).toBe(MODEL);
    expect(Object.keys(request?.questions ?? {}).sort()).toEqual([
      "currentCandidate",
      "historyCandidate",
    ]);
    for (const q of Object.values(request?.questions ?? {})) {
      expect(q.type).toBe("choice");
      expect(Object.keys(q.criteria).sort()).toEqual(
        [
          ...b.candidates.map((c) => c.id),
          "none",
          "concurrent",
          "uncertain",
        ].sort(),
      );
    }
    expect(JSON.stringify(request)).toContain("history");
    expect(JSON.stringify(request)).toContain(b.messageHash);
  });
  it.each([
    [0.49, 1],
    [1, 0.79],
    [1, Number.NaN],
  ])(
    "rejects low/invalid confidence or probability",
    (confidence, probability) => {
      const b = bundle();
      expect(
        readLabelSelections(
          b,
          result(
            {
              currentCandidate: b.candidates[0].id,
              historyCandidate: b.candidates[1].id,
            },
            confidence,
            probability,
          ),
        ),
      ).toEqual({});
    },
  );
  it.each(["none", "concurrent", "uncertain", "made-up-id"])(
    "rejects %s without inventing text",
    (choice) => {
      expect(
        readLabelSelections(
          bundle(),
          result({ currentCandidate: choice, historyCandidate: choice }),
        ),
      ).toEqual({});
    },
  );
  it("selects immutable exact references and binds each separately against ALL 20 tasks", () => {
    const b = bundle();
    const selected = readLabelSelections(
      b,
      result(
        {
          currentCandidate: b.candidates[0].id,
          historyCandidate: b.candidates[1].id,
        },
        0.5,
        0.8,
      ),
    );
    expect(selected.current?.quote).toBe(b.candidates[0].quote);
    expect(selected.history?.quote).toBe(b.candidates[1].quote);
    const request = buildLabelBindingRequest(b, selected, tasks, b.messageHash);
    expect(request).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(
      24 * 1024,
    );
    expect(Object.keys(request?.questions ?? {}).sort()).toEqual([
      "currentTask",
      "historyTask",
    ]);
    for (const q of Object.values(request?.questions ?? {})) {
      expect(Object.keys(q.criteria).sort()).toEqual(
        [...tasks.map((t) => t.id), "none", "concurrent", "uncertain"].sort(),
      );
    }
    const encoded = JSON.stringify(request?.state);
    expect(encoded).toContain(selected.current!.quoteHash);
    expect(encoded).toContain(selected.history!.quoteHash);
    const accepted = readLabelBindings(
      selected,
      tasks,
      result({ currentTask: tasks[0].id, historyTask: tasks[1].id }),
    );
    expect(accepted.current).toMatchObject({
      candidate: selected.current,
      task: tasks[0],
    });
    expect(accepted.history).toMatchObject({
      candidate: selected.history,
      task: tasks[1],
    });
  });
  it("cannot bind preappend mismatch, swapped/forged reference, partial board or overflow", () => {
    const b = bundle();
    const selected = readLabelSelections(
      b,
      result({ currentCandidate: b.candidates[0].id }),
    );
    expect(
      buildLabelBindingRequest(
        b,
        selected,
        tasks,
        hash("changed canonical text"),
      ),
    ).toBeUndefined();
    const forged = {
      current: { ...selected.current!, quote: "invented content" },
    };
    expect(
      buildLabelBindingRequest(b, forged, tasks, b.messageHash),
    ).toBeUndefined();
    expect(
      buildLabelBindingRequest(
        b,
        selected,
        [...tasks, tasks[0]],
        b.messageHash,
      ),
    ).toBeUndefined();
    expect(
      buildLabelBindingRequest(
        b,
        selected,
        [{ ...tasks[0], label: "x".repeat(25 * 1024) }],
        b.messageHash,
      ),
    ).toBeUndefined();
    expect(
      buildLabelBindingRequest(b, selected, [], b.messageHash),
    ).toBeUndefined();
  });
  it("binding uncertainty or unknown task cannot leak another candidate", () => {
    const b = bundle();
    const selected = readLabelSelections(
      b,
      result({
        currentCandidate: b.candidates[0].id,
        historyCandidate: b.candidates[1].id,
      }),
    );
    expect(
      readLabelBindings(
        selected,
        tasks,
        result({ currentTask: "concurrent", historyTask: "unknown-task" }),
      ),
    ).toEqual({});
  });
});
