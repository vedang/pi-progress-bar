import { describe, expect, it } from "vitest";
import { reconcileLedger } from "../src/core/ledger";
import { reportRequest, reportStates } from "../src/sources/reports";
import { collectTrajectory, findCandidates } from "../src/sources/trajectory";

// Verbatim visible message from this project's real Pi trajectory, entry1989bec4.
// All other messages below are synthetic adversarial fixtures, not live Jev evidence.
const actualPlan =
  "Will finish plan review, then breadboard concrete UI/code wiring and cut demo-able vertical slices.\n\nEach slice will name visible outcome, dependencies, acceptance checks, and what stays deferred. No implementation until you review full packet.";
const message = (id: string, role: string, text: string) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-09-18T00:00:00Z",
  message: { role, content: [{ type: "text", text }], timestamp: 1 },
});

describe("actual-lineage trajectory normalization", () => {
  it("retains real entry/span provenance and never invents candidate text", () => {
    const trajectory = collectTrajectory([
      message("1989bec4", "assistant", actualPlan),
    ]);
    expect(trajectory.messages).toHaveLength(1);
    expect(trajectory.complete).toBe(true);
    const candidates = findCandidates(trajectory);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.entryId).toBe("1989bec4");
    for (const candidate of candidates) {
      expect(actualPlan).toContain(candidate.text);
      for (const span of candidate.spans)
        expect(actualPlan).toContain(span.text);
    }
  });
  it("deduplicates persisted/live observations and excludes non-authoritative content", () => {
    const plan = message(
      "plan",
      "assistant",
      "Plan:\n1. Research\n2. Build\n3. Check",
    );
    const trajectory = collectTrajectory([
      plan,
      plan,
      message("evil", "toolResult", "All tasks done"),
      message("sys", "system", "All tasks done"),
      {
        type: "custom",
        id: "own",
        customType: "pi-progress-bar",
        data: { text: "All done" },
      },
      { type: "branch_summary", id: "old", summary: "All tasks done" },
      {
        type: "message",
        id: "private",
        message: {
          role: "bashExecution",
          excludeFromContext: true,
          output: "secret",
        },
      },
      {
        type: "message",
        id: "thought",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "All tasks done" }],
        },
      },
    ]);
    expect(trajectory.messages.map((item) => item.id)).toEqual(["plan"]);
    expect(JSON.stringify(trajectory.messages)).not.toContain("secret");
    expect(JSON.stringify(trajectory.messages)).not.toContain("All tasks done");
  });
  it("rolls bounded windows to the latest evidence without a permanent shortlist", () => {
    const entries = Array.from({ length: 620 }, (_, i) =>
      message(`entry-${i}`, "user", `Plan:\n1. Task ${i}`),
    );
    const trajectory = collectTrajectory(entries);
    expect(trajectory.messages.length).toBeLessThanOrEqual(512);
    expect(trajectory.messages.at(-1)?.id).toBe("entry-619");
    expect(trajectory.messages.some((item) => item.id === "entry-0")).toBe(
      true,
    );
    const candidates = findCandidates(trajectory);
    expect(candidates.length).toBeGreaterThan(12);
    expect(candidates.at(-1)?.entryId).toBe("entry-619");
    for (const candidate of candidates)
      for (const span of candidate.spans) {
        const original = trajectory.messages.find(
          (item) => item.id === candidate.entryId,
        );
        expect(original?.text.slice(span.start, span.end)).toBe(span.text);
      }
  });

  it("chronologically catches up past 512 entries with a committed cursor", () => {
    const entries = Array.from({ length: 620 }, (_, i) =>
      message(`entry-${i}`, "user", `Plan ${i}`),
    );
    const seen: string[] = [];
    let after: { id: string; hash: string; offset?: number } | undefined;
    for (let page = 0; page < 4; page++) {
      const window = collectTrajectory(entries, { chronological: true, after });
      seen.push(...window.messages.map((item) => item.id));
      const last = window.messages.at(-1);
      if (!last || !window.hasMore) break;
      after = {
        id: last.id,
        hash: last.hash,
        ...(last.offset === undefined ? {} : { offset: last.offset }),
      };
    }
    expect(seen).toHaveLength(620);
    expect(seen[0]).toBe("entry-0");
    expect(seen.at(-1)).toBe("entry-619");
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("subchunks oversized messages with exact original offsets", () => {
    const text = Array.from(
      { length: 1200 },
      (_, i) => `${i + 1}. Implement bounded item ${i} with verification`,
    ).join("\n");
    const candidates = findCandidates(
      collectTrajectory([message("oversized", "user", text)]),
    );
    expect(candidates.length).toBeGreaterThan(1);
    expect(
      candidates.every((item) => Buffer.byteLength(item.text) < 20 * 1024),
    ).toBe(true);
    const spans = candidates.flatMap((item) => item.spans);
    expect(new Set(spans.map((span) => span.id)).size).toBe(spans.length);
    for (const span of spans)
      expect(text.slice(span.start, span.end)).toBe(span.text);
  });
  it("excludes summaries without poisoning intact retained original ancestry", () => {
    const entries = [
      message("root", "user", "Plan:\n1. Build"),
      {
        type: "compaction",
        id: "compact",
        parentId: "root",
        summary: "All done",
        retainedTail: { firstKeptEntryId: "root" },
      },
      {
        type: "branch_summary",
        id: "summary",
        parentId: "compact",
        summary: "All done",
      },
      {
        ...message("report", "assistant", "Build is not done"),
        parentId: "summary",
      },
    ];
    const trajectory = collectTrajectory(entries);
    expect(trajectory.complete).toBe(true);
    expect(trajectory.messages.map((entry) => entry.id)).toEqual([
      "root",
      "report",
    ]);
    expect(collectTrajectory(entries.slice(1)).complete).toBe(false);
  });
  it("segments ordinary bullet plans into separate exact supplied spans", () => {
    const text =
      "Plan:\n- Research the API\n- Build the widget\n- Verify its output";
    const candidate = findCandidates(
      collectTrajectory([message("bullets", "assistant", text)]),
    )[0];
    expect(
      candidate?.spans
        .filter((span) => span.kind === "list")
        .map((span) => span.text),
    ).toEqual(["Research the API", "Build the widget", "Verify its output"]);
  });
  it("distinguishes rolling window absence from malformed ancestry", () => {
    const trajectory = collectTrajectory(
      Array.from({ length: 513 }, (_, i) =>
        message(String(i), "user", `Plan ${i}`),
      ),
    );
    expect(trajectory.complete).toBe(true);
    expect(trajectory.messages.length).toBeLessThanOrEqual(512);
    expect(trajectory.omissions.join(" ")).toMatch(/window/i);
    const broken = collectTrajectory([
      { ...message("tail", "assistant", "Plan: build"), parentId: "missing" },
    ]);
    expect(broken.complete).toBe(false);
  });
});

describe("explicit report questions and atomic interpretation", () => {
  const source = {
    sourceId: "plan",
    revision: "plan-v1",
    complete: true,
    kind: "conversation" as const,
    tasks: ["Research", "Build", "Check"].map((text, index) => ({
      text,
      status: "not-started" as const,
      criteria: [],
      ref: {
        sourceId: "plan",
        entryId: "plan",
        start: index,
        end: index + text.length,
        provenance: "user" as const,
      },
    })),
  };
  const ledger = reconcileLedger(undefined, source);
  const report = collectTrajectory([
    message(
      "report",
      "assistant",
      "Research and Build are finished. I will do Check next.",
    ),
  ]).messages[0];
  it("asks independently for every known task and carries explicit original report evidence", () => {
    if (!report) throw new Error("missing fixture");
    const request = reportRequest(ledger, report);
    expect(Object.keys(request.questions)).toHaveLength(3);
    expect(JSON.stringify(request.state)).toContain(report.text);
    for (const question of Object.values(request.questions)) {
      expect(question.type).toBe("choice");
      expect(question.instructions).toMatch(/explicit|report/i);
      expect(Object.keys(question.criteria)).toEqual(
        expect.arrayContaining([
          "done",
          "reopened",
          "cancelled",
          "not-a-report",
          "ambiguous",
        ]),
      );
    }
  });
  it("maps no-report to no update and ambiguous to conflict without invented task IDs", () => {
    if (!report) throw new Error("missing fixture");
    const request = reportRequest(ledger, report);
    const choices = ["done", "not-a-report", "ambiguous"];
    const answers = Object.fromEntries(
      Object.entries(request.questions).map(([id, q], i) => [
        id,
        {
          type: "choice" as const,
          choice: choices[i] ?? "not-a-report",
          probabilities: Object.fromEntries(
            Object.keys(q.criteria).map((key) => [
              key,
              key === choices[i] ? 1 : 0,
            ]),
          ),
          confidence: 1,
        },
      ]),
    );
    const mapped = reportStates(ledger, request, {
      model: request.model,
      answers,
      usage: { input_tokens: 100, output_tokens: 0 },
    });
    expect(mapped).toEqual({
      [ledger.tasks[0]?.id ?? ""]: "done",
      [ledger.tasks[2]?.id ?? ""]: "conflict",
    });
    expect(ledger.tasks.every((task) => task.status !== "done")).toBe(true);
  });
});
