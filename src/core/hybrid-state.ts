export type ObservationRole = "user" | "assistant";
export type TaskKind = "action" | "response";
export type TaskBasis = "explicit" | "derived";
type TaskStatus = "not-started" | "reopened" | "done";
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

type MutationEventKind =
  | "create"
  | "revise"
  | "archive"
  | "restore"
  | "complete"
  | "withdraw";

/** Immutable accepted mutation evidence; assessment-only updates add none. */
export interface MutationEvent {
  id: string;
  kind: MutationEventKind;
  taskId: string;
  revision: number;
  source: ObservationRef;
}

export interface PendingObservation {
  observation: ObservationRef;
  phase: "extract" | "complete";
  completedTaskIds: string[];
  completionHashes: string[];
  gateHash?: string;
  patchHash?: string;
}

export type ScopeFailure = "capacity" | "invalid" | "overflow";

export interface HybridState {
  sourceId: string;
  tasks: HybridTask[];
  events: MutationEvent[];
  nextTaskId: number;
  cursor?: { id: string; hash: string };
  pending?: PendingObservation;
  focusTaskId?: string;
  scopeAssessment?: Assessment;
  scopeError?: string;
  /** Typed unresolved outcome; display logic must not inspect error text. */
  scopeFailure?: ScopeFailure;
  scopeUnresolved: boolean;
  completionError?: string;
}

export function emptyState(sourceId: string): HybridState {
  if (!sourceId.trim()) throw new Error("Source ID is required");
  return {
    sourceId,
    tasks: [],
    events: [],
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
    events: state.events.map((event) => ({
      ...event,
      source: { ...event.source },
    })),
    ...(state.cursor ? { cursor: { ...state.cursor } } : {}),
    ...(state.pending
      ? {
          pending: {
            ...state.pending,
            observation: { ...state.pending.observation },
            completedTaskIds: [...state.pending.completedTaskIds],
            completionHashes: [...state.pending.completionHashes],
          },
        }
      : {}),
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
