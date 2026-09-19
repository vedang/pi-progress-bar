/** Canonical conversation provenance; intercom is not a typed human user. */
export type ObservationRole = "user" | "assistant" | "intercom";
export type TaskKind = "action" | "response";
export type TaskBasis = "explicit" | "derived";
export type TaskStatus = "not-started" | "reopened" | "done";

/** One persisted task-label domain shared by extraction and checkpoint validation. */
const MAX_TASK_LABEL_CODE_POINTS = 240;
export const taskLabelIsValid = (value: unknown): value is string =>
  typeof value === "string" &&
  !!value.trim() &&
  Array.from(value).length <= MAX_TASK_LABEL_CODE_POINTS &&
  !/[\p{Cc}\p{Cf}]/u.test(value);

export type AssessmentReason =
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

export type Presence<T> = { present: false } | { present: true; value: T };
export interface Cursor {
  id: string;
  hash: string;
  role: ObservationRole;
}

export interface ReplayCore {
  sourceId: string;
  cursor: Presence<Cursor>;
  tasks: HybridTask[];
  events: MutationEvent[];
  nextTaskId: number;
  focusTaskId: Presence<string>;
  scopeAssessment: Presence<Assessment>;
  scopeUnresolved: boolean;
}

export interface GateRecord {
  originHash: string;
  requestHash: string;
  context: ObservationRef[];
  assessment: Assessment;
  priorScopeAssessment: Presence<Assessment>;
}

export interface NormalizedPatch {
  add: Array<{
    label: string;
    kind: TaskKind;
    basis: TaskBasis;
    source: SourceRef;
  }>;
  revise: Array<{
    id: string;
    label: string;
    requirementsChanged: boolean;
    source: SourceRef;
  }>;
  archive: Array<{ id: string; source: SourceRef }>;
  restore: Array<{
    id: string;
    label: string;
    requirementsChanged: boolean;
    source: SourceRef;
  }>;
  unresolved: boolean;
}

export interface PatchUndo {
  revise: Array<{
    index: number;
    label: string;
    status: TaskStatus;
    revision: number;
    source: SourceRef;
  }>;
  archive: Array<{ index: number; included: boolean }>;
  restore: Array<{
    index: number;
    label: string;
    status: TaskStatus;
    included: boolean;
    revision: number;
    source: SourceRef;
  }>;
  nextTaskId: number;
  focusTaskId: Presence<string>;
  scopeUnresolved: boolean;
  eventLength: number;
}

export interface PatchRecord {
  requestHash: string;
  outcome: NormalizedPatch;
  undo: PatchUndo;
}

interface FocusRecord {
  assessment: Assessment;
  /** Exact focus presence before first combined completion/focus reduction. */
  priorFocusTaskId: Presence<string>;
}

export interface CompletionRecord {
  requestHash: string;
  chunkIds: string[];
  assessments: Assessment[];
  /** Mandatory only on first chunk when pre-completion open candidates exist. */
  focus?: FocusRecord;
  undo: {
    tasks: Array<{
      status: TaskStatus;
      latestAssessment: Presence<Assessment>;
    }>;
    eventLength: number;
  };
}

export type PendingBlock =
  | "invalid-patch"
  | "input-overflow"
  | "task-capacity"
  | "event-capacity"
  | "completion-build";

export interface PendingObservation {
  observation: ObservationRef;
  phase: "extract" | "complete";
  block: Presence<PendingBlock>;
  journal: {
    gate: GateRecord;
    patch?: PatchRecord;
    completions: CompletionRecord[];
  };
}

export type ScopeFailure = "capacity" | "invalid" | "overflow";
type CapacityState = "clear" | "limit";

export interface HybridState {
  sourceId: string;
  /** Fixed-width durable admission marker; `limit` blocks paid phase work. */
  capacity: CapacityState;
  tasks: HybridTask[];
  events: MutationEvent[];
  nextTaskId: number;
  cursor?: Cursor;
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
    capacity: "clear",
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
  return structuredClone(state);
}

/**
 * Detached board order from immutable accepted create events, never mutable task
 * array order, revision time, completion, or render selection.
 *
 * Valid checkpoint state contains exactly one create event for each task.
 */
export function tasksNewestFirst(state: HybridState): HybridTask[] {
  const createOrder = new Map<string, number>();
  state.events.forEach((event, index) => {
    if (event.kind === "create") createOrder.set(event.taskId, index);
  });
  return [...state.tasks].sort((left, right) => {
    const leftOrder = createOrder.get(left.id) ?? -1;
    const rightOrder = createOrder.get(right.id) ?? -1;
    if (leftOrder !== rightOrder) return rightOrder - leftOrder;
    return right.id.localeCompare(left.id);
  });
}
