import { createHash } from "node:crypto";

import type {
  Assessment,
  Cursor,
  HybridState,
  Presence,
  ReplayCore,
} from "./hybrid-state";

const proofHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const absent = <T>(): Presence<T> => ({ present: false });
export const present = <T>(value: T): Presence<T> => ({ present: true, value });

/** Own undefined and checkpoint null both normalize to journal absence. */
export const optionalPresence = <T>(
  value: T | undefined | null,
): Presence<T> =>
  value === undefined || value === null ? absent() : present(value);

export const replayCore = (state: HybridState): ReplayCore => ({
  sourceId: state.sourceId,
  cursor: optionalPresence<Cursor>(state.cursor),
  tasks: structuredClone(state.tasks),
  events: structuredClone(state.events),
  nextTaskId: state.nextTaskId,
  focusTaskId: optionalPresence(state.focusTaskId),
  scopeAssessment: optionalPresence(state.scopeAssessment),
  scopeUnresolved: state.scopeUnresolved,
});

/** Consistency digest only; it is not an authenticity or provenance signature. */
export const originHash = (state: HybridState) => proofHash(replayCore(state));
export const requestHash = (request: unknown) => proofHash(request);

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Gate semantics shared by live mutation and checkpoint replay. */
export const gateDecision = (assessment: Assessment) => {
  if (assessment.reason !== "accepted") return "extract" as const;
  if (assessment.rawChoice === "changed") return "changed" as const;
  if (assessment.rawChoice === "unchanged") return "unchanged" as const;
  return "extract" as const;
};

/** Completion status is normalized from prestate plus accepted assessment. */
export const completionStatus = (
  status: "not-started" | "reopened" | "done",
  assessment: Assessment,
) =>
  assessment.reason === "accepted" && assessment.rawChoice === "yes"
    ? status === "done"
      ? ("reopened" as const)
      : ("done" as const)
    : status;
