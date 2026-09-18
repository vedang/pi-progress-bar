import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileLedger } from "../src/core/ledger";
import { Monitor } from "../src/core/monitor";
import { proposal } from "../src/sources/candidates";
import { collectTrajectory, findCandidates } from "../src/sources/trajectory";
import { renderWidget } from "./fixtures/render-widget";

function fixture() {
  const monitor = new Monitor(vi.fn(), vi.fn());
  const candidate = findCandidates(
    collectTrajectory([
      {
        type: "message",
        id: "goal",
        parentId: null,
        message: {
          role: "user",
          content: "1. Implement parser\n2. Improve help",
        },
      },
    ]),
  )[0];
  if (!candidate) throw new Error("Missing candidate");
  monitor.ledger = reconcileLedger(undefined, proposal(candidate).snapshot);
  monitor.enabled = true;
  const first = monitor.ledger.tasks[0];
  const second = monitor.ledger.tasks[1];
  if (!first || !second) throw new Error("Missing task");
  const assess = (id: string, score: number) => {
    if (!monitor.ledger) throw new Error("Missing ledger");
    monitor.ledger.currentTaskId = id;
    const snapshot = monitor.snapshot();
    if (!snapshot) throw new Error("Missing snapshot");
    monitor.health = {
      snapshot,
      evaluatedAt: 1000,
      result: {
        model: "jev-1.13.0",
        usage: { input_tokens: 1, output_tokens: 1 },
        answers: {
          clarity: {
            type: "score",
            score,
            confidence: 1,
            probabilities: { 0: 0, 1: 0, 2: 1, 3: 0 },
            legend: {
              0: "Missing",
              1: "Ambiguous",
              2: "Mostly clear",
              3: "Clear",
            },
          },
          acceptance: {
            type: "choice",
            choice: "explicit",
            confidence: 1,
            probabilities: { explicit: 1 },
          },
          redApplicability: {
            type: "choice",
            choice: "not-needed",
            confidence: 1,
            probabilities: { "not-needed": 1 },
          },
        },
      },
    };
  };
  return {
    monitor,
    first,
    second,
    assess,
    text: () => renderWidget(monitor).join("\n"),
  };
}
afterEach(() => vi.restoreAllMocks());

describe("retained task card", () => {
  it("names a known task without fabricating semantic current", () => {
    const f = fixture();
    expect(f.text()).toContain("Implement parser");
    expect(f.text()).not.toMatch(/Task: unknown/i);
    expect(f.monitor.ledger?.currentTaskId).toBeUndefined();
    expect(f.monitor.evidenceLink()).toBeUndefined();
    f.monitor.stop();
  });
  it("retains completed task fields after current/health become unavailable", () => {
    const f = fixture();
    f.assess(f.first.id, 2.7);
    expect(f.text()).toContain("Requirements: mostly clear");
    if (!f.monitor.ledger) throw new Error("Missing ledger");
    f.first.status = "done";
    f.monitor.ledger.currentTaskId = undefined;
    f.monitor.health = undefined;
    const text = f.text();
    expect(text).toContain("Implement parser");
    expect(text).toContain("Requirements: mostly clear");
    expect(text).toContain("Acceptance: explicit");
    expect(text).toContain("New red test: Not needed");
    expect(text).toMatch(/retained|last assessed|as.of/i);
    expect(f.monitor.evidenceLink()).toBeUndefined();
    f.monitor.stop();
  });
  it("keeps old task label and values together while replacement is pending", () => {
    const f = fixture();
    f.assess(f.first.id, 2.7);
    f.text();
    if (!f.monitor.ledger) throw new Error("Missing ledger");
    f.monitor.ledger.currentTaskId = f.second.id;
    f.monitor.health = undefined;
    const pending = f.text();
    expect(pending).toContain("Implement parser");
    expect(pending).toContain("Requirements: mostly clear");
    expect(pending).toMatch(/pending|retained|previous|updating/i);
    f.assess(f.second.id, 1.5);
    const next = f.text();
    expect(next).toContain("Task: Improve help");
    expect(next).toContain("Requirements: partly clear");
    expect(next).not.toContain("Requirements: mostly clear");
    f.monitor.stop();
  });
  it.each([true, false])(
    "captures evidence at health admission, before first render=%s",
    (renderFirst) => {
      const f = fixture();
      f.first.criteria.push("Parser accepts valid input");
      if (!f.monitor.ledger) throw new Error("Missing ledger");
      f.monitor.ledger.currentTaskId = f.first.id;
      const link = f.monitor.evidenceLink();
      if (!link) throw new Error("Missing evidence link");
      f.monitor.evidence.start(
        "edit-first",
        "edit",
        { path: "parser.ts" },
        1,
        undefined,
        link,
      );
      f.monitor.evidence.finish("edit-first", "edit", { isError: false }, 2);
      f.monitor.evidence.start(
        "red-first",
        "bash",
        { command: "npm test" },
        3,
        undefined,
        link,
      );
      f.monitor.evidence.finish(
        "red-first",
        "bash",
        {
          isError: true,
          content: [
            { type: "text", text: "AssertionError: expected valid input" },
          ],
        },
        4,
      );
      f.assess(f.first.id, 2.7);
      if (!f.monitor.health) throw new Error("Missing assessment");
      f.monitor.health.snapshot.implementationEvidenceComplete = true;
      f.monitor.health.result.answers["criterion:0"] = {
        type: "choice",
        choice: "supports",
        confidence: 1,
        probabilities: { supports: 1, contradicts: 0, insufficient: 0 },
      };
      const acceptedResult = f.monitor.health.result;
      f.monitor.health = undefined;
      vi.spyOn(f.monitor, "enqueueAnalysis").mockImplementation(
        (purpose, _request, admit) => {
          if (purpose === "health") admit(acceptedResult);
        },
      );
      // Exercise actual health admission without a widget render callback.
      f.monitor.scheduleAnalysis();
      expect(f.monitor.health).toBeDefined();
      if (renderFirst) {
        const assessed = f.text();
        expect(assessed).toContain("Red evidence: Observed red");
        expect(assessed).toContain("Implementation: appears complete");
      }
      f.first.status = "done";
      f.monitor.ledger.currentTaskId = undefined;
      f.monitor.health = undefined;
      f.monitor.evidence.start("later-edit", "edit", { path: "another.ts" }, 5);
      f.monitor.evidence.finish("later-edit", "edit", { isError: false }, 6);
      expect(f.monitor.evidence.redObservation(link)).toBeUndefined();
      const retained = f.text();
      expect(retained).toContain("Red evidence: Observed red");
      expect(retained).toContain("Implementation: appears complete");
      expect(retained).toMatch(/retained|as.of|last assessed/i);
      expect(f.monitor.evidenceLink()).toBeUndefined();
      f.monitor.stop();
    },
  );

  it("does not attach old-revision labels to a revised task title", () => {
    const f = fixture();
    f.assess(f.first.id, 2.7);
    f.text();
    f.first.text = "Implement strict parser";
    f.first.revision = "revised-task";
    f.monitor.health = undefined;
    const pending = f.text();
    expect(pending).toContain("Implement parser");
    expect(pending).not.toContain("Task: Implement strict parser");
    expect(pending).toContain("Requirements: mostly clear");
    expect(pending).toMatch(/retained|previous|pending|as.of/i);
    f.assess(f.first.id, 1.5);
    const fresh = f.text();
    expect(fresh).toContain("Task: Implement strict parser");
    expect(fresh).toContain("Requirements: partly clear");
    expect(fresh).not.toContain("Requirements: mostly clear");
    f.monitor.stop();
  });

  it("does not present another task's still-present assessment as current", () => {
    const f = fixture();
    f.assess(f.first.id, 2.7);
    f.text();
    if (!f.monitor.ledger) throw new Error("Missing ledger");
    f.monitor.ledger.currentTaskId = f.second.id;
    const pending = f.text();
    expect(pending).toContain("Implement parser");
    expect(pending).not.toContain("Task: Improve help");
    expect(pending).toMatch(/retained|previous|pending|as.of/i);
    f.monitor.stop();
  });

  it("shows never before actual inference without hiding failure state", () => {
    const f = fixture();
    f.monitor.error = "Provider unavailable";
    expect(f.text()).toMatch(/Last Jev call[^\n]*never/i);
    expect(f.text()).toContain("Provider unavailable");
    f.monitor.stop();
  });

  it("does not leak retained task text into a different session", async () => {
    const f = fixture();
    f.assess(f.first.id, 2.7);
    f.text();
    vi.stubEnv("TYPESAFE_API_KEY", "");
    f.monitor.observe(() => []);
    await f.monitor.restore("/nonexistent", undefined);
    f.monitor.enabled = true;
    expect(f.text()).not.toContain("Implement parser");
    expect(f.text()).not.toContain("Requirements: mostly clear");
    f.monitor.stop();
    vi.unstubAllEnvs();
  });
});
