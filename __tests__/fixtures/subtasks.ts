import { createHash } from "node:crypto";
import type { HybridTask, SourceRef } from "../../src/core/hybrid-state";

export const subtaskHash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const subtaskSource = (
  id = "request",
  text = "Compare the deployment options and recommend an approach.",
): SourceRef => ({
  entryId: id,
  role: "user",
  messageHash: subtaskHash(text),
  start: 0,
  end: text.length,
  quoteHash: subtaskHash(text),
});
export const subtaskParent = (): HybridTask => ({
  id: "task:1",
  label: "Recommend deployment approach",
  revision: 1,
  source: subtaskSource(),
  kind: "response",
  basis: "explicit",
  included: true,
  status: "not-started",
});
export const subtaskAdmission = (
  labels = ["Compare operational tradeoffs", "Formulate recommendation"],
) => ({
  parent: subtaskParent(),
  expectedListRevision: 0,
  source: subtaskSource(),
  proof: {
    contextHash: subtaskHash("context"),
    gateRequestHash: subtaskHash("accepted-yes-gate"),
    proposalRequestHash: subtaskHash("selected-model-proposal"),
  },
  children: labels.map((label) => ({
    kind: "add" as const,
    label,
    source: subtaskSource(),
  })),
  removals: [],
  complete: false,
});

/** Tuning only. The separate held-out corpus is not added here after failures. */
export const subtaskTuning = [
  {
    id: "st1",
    text: "Compare the deployment options and recommend an approach.",
    need: "yes",
  },
  { id: "st2", text: "What is 6 times 7?", need: "no" },
  {
    id: "st3",
    text: "I compared operational tradeoffs; the recommendation is still pending.",
    completed: ["Compare operational tradeoffs"],
  },
];
