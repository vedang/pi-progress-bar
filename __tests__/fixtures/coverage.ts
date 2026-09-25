import { createHash } from "node:crypto";
import type { HybridTask, SourceRef } from "../../src/core/hybrid-state";

/** Synthetic worksheet inventory: same22-item shape, no customer workbook data. */
export const coverageNames = [
  "Overview",
  "Phase 1",
  "Phase 2",
  "Catalogue",
  "Delivery Plan",
  "Questions",
  "Risks",
  "Decisions",
  "Dashboard",
  "Sprint Board",
  "Gates",
  "Obligations",
  "Client View",
  "Overdue",
  "Due Next Week",
  "Timeline",
  "Capacity",
  "Scenario",
  "Setup Calendar",
  "Setup Gates",
  "Setup Config",
  "Lookup",
];
const coverageHash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const coverageSource = (
  id = "intent",
  text = "Review every tab in docs/plan.xlsx.",
): SourceRef => ({
  entryId: id,
  role: "user",
  messageHash: coverageHash(text),
  start: 0,
  end: text.length,
  quoteHash: coverageHash(text),
});
export const coverageParent = (): HybridTask => ({
  id: "task:1",
  label: "Summarize workbook",
  revision: 1,
  source: coverageSource(),
  kind: "response",
  basis: "explicit",
  included: true,
  status: "not-started",
});
export const coverageInventory = (names = coverageNames) => ({
  resourceKey: "docs/plan.xlsx",
  revision: 1,
  complete: true,
  source: {
    entryId: "inventory",
    messageHash: coverageHash(names.join("\n")),
    callId: "manifest-call",
  },
  items: names.map((label, i) => ({ key: `sheet:${i + 1}`, label })),
});

/** Frozen tuning set. Do not move held-out examples here after observing failures. */
export const coverageTuning = [
  {
    id: "t1",
    text: "I reviewed Overview.",
    expected: "reviewed",
    items: ["Overview"],
  },
  {
    id: "t2",
    text: "I will review Overview next.",
    expected: "none",
    items: [],
  },
  {
    id: "t3",
    text: "Overview is blocked on missing inputs.",
    expected: "blocked",
    items: ["Overview"],
  },
  {
    id: "t4",
    text: "I did not finish reviewing Overview.",
    expected: "retracted",
    items: ["Overview"],
  },
];
