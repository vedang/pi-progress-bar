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
