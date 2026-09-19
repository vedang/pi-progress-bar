export type ObservationRole = "user" | "assistant";
export type TaskKind = "action" | "response";
export type TaskBasis = "explicit" | "derived";
type TaskStatus = "not-started" | "done";
type AssessmentReason =
  | "accepted"
  | "semantic-unknown"
  | "threshold-abstention";

export interface Observation {
  id: string;
  role: ObservationRole;
  text: string;
  hash: string;
}

export interface ObservationRef {
  entryId: string;
  messageHash: string;
  role: ObservationRole;
}

export interface SourceRef extends ObservationRef {
  start: number;
  end: number;
  quoteHash: string;
}

export interface Assessment {
  rawChoice: string;
  confidence: number;
  probability: number;
  reason: AssessmentReason;
  source: ObservationRef;
}

export interface HybridTask {
  id: string;
  label: string;
  kind: TaskKind;
  basis: TaskBasis;
  status: TaskStatus;
  included: boolean;
  revision: number;
  source: SourceRef;
  latestAssessment?: Assessment;
}

export interface HybridState {
  sourceId: string;
  tasks: HybridTask[];
  nextTaskId: number;
  cursor?: { id: string; hash: string };
  focusTaskId?: string;
  scopeAssessment?: Assessment;
  scopeError?: string;
  scopeUnresolved: boolean;
  completionError?: string;
}

export function emptyState(sourceId: string): HybridState {
  if (!sourceId.trim()) throw new Error("Source ID is required");
  return {
    sourceId,
    tasks: [],
    nextTaskId: 1,
    scopeUnresolved: false,
  };
}

export function observationRef(observation: Observation): ObservationRef {
  return {
    entryId: observation.id,
    messageHash: observation.hash,
    role: observation.role,
  };
}

/** Clone each mutable branch so pure reducers never alter caller-owned state. */
export function copyState(state: HybridState): HybridState {
  return {
    ...state,
    tasks: state.tasks.map((task) => ({
      ...task,
      source: { ...task.source },
      ...(task.latestAssessment
        ? {
            latestAssessment: {
              ...task.latestAssessment,
              source: { ...task.latestAssessment.source },
            },
          }
        : {}),
    })),
    ...(state.cursor ? { cursor: { ...state.cursor } } : {}),
    ...(state.scopeAssessment
      ? {
          scopeAssessment: {
            ...state.scopeAssessment,
            source: { ...state.scopeAssessment.source },
          },
        }
      : {}),
  };
}
