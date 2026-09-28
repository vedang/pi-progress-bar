import { createHash } from "node:crypto";
import {
  type ContinuationAuthorityBinding,
  type ContinuationAuthorityProjection,
  projectContinuationAuthority,
} from "../advisory/continuation-authority";
import {
  type CorrectionAttempt,
  type CorrectionAttemptSource,
  type CorrectionAuthority,
  type CorrectionBinding,
  CorrectionController,
  type CorrectionEmission,
  type CorrectionRedFact,
  type CorrectionSnapshot,
  type CorrectionTask,
} from "../advisory/corrections";
import type {
  ReconciliationSubtaskSummary,
  ReconciliationUncertainActivity,
} from "../advisory/reconciliation";
import {
  type ActivityCall,
  type ActivityList,
  activityFocusRequest,
  captureDeclaredTools,
  captureStartedTool,
  reconcileStartedTools,
} from "../analysis/activity-focus";
import {
  buildLabelBindingRequest,
  buildLabelSelectionRequest,
  type LabelCandidateBundle,
  type LabelSelections,
  readLabelBindings,
  readLabelSelections,
  type VisibilityTask,
} from "../analysis/activity-label";
import type { ExtractionInput } from "../analysis/extractor";
import {
  type EvaluationRequest,
  JevGateway,
  type ValidatedResult,
} from "../analysis/gateway";
import { type HealthSnapshot, healthSnapshot } from "../analysis/health";
import { implementationFromResult } from "../analysis/implementation";
import { ownDataJson } from "../analysis/own-data-json";
import type { SubtaskGateBatch } from "../analysis/subtask-gate";
import type { SubtaskProposalRequest } from "../analysis/subtask-proposal";
import {
  type SubtaskReportBatch,
  subtaskReportBatches,
  subtaskReportOmissionIdentity,
  subtaskReportRequestSize,
} from "../analysis/subtask-report";
import {
  detailQuestionKeys,
  detailReceipt,
  detailRecordMatchesTask,
  isDetailRequest,
  type MaterializedTaskDetails,
  materializeTaskDetails,
  type TaskDetailRecord,
  taskDetailRequest,
  uncoveredDetailKeys,
} from "../analysis/task-details";
import {
  type BeadsPresentation,
  beadsPresentation,
  readBeadsExport,
} from "../sources/beads";
import {
  CoverageAdapter,
  isCurrentSubtaskEvidence,
  type SubtaskEvidence,
} from "../sources/coverage";
import { EvidenceStore, redEvidenceLabel } from "../sources/evidence";
import {
  type CanonicalFrontier,
  type CanonicalHealthReportContext,
  CanonicalPass,
} from "../sources/messages";
import {
  type BoardDetailRecord,
  type BoardSnapshot,
  projectBoard,
  visibilityTaskSourceDigest,
} from "./board-projection";
import {
  type ExecutionVisibilitySnapshot,
  ExecutionVisibilityStore,
  type VisibilityToolPhase,
} from "./execution-visibility";
import {
  type AcceptedSaveOptions,
  type AdmissionPlan,
  DurabilityCapacityError,
  processObservation,
  RetryableProviderError,
} from "./hybrid";
import {
  canCommitSubtaskCheckpoint,
  commitSubtaskCheckpoint,
  encodeSubtaskCheckpoint,
  type HealthCard,
  type HealthCoverage,
  type HealthFields,
  MAX_CHECKPOINT_BYTES,
  restoreSubtaskCheckpoint,
  type SubtaskMonitorCheckpointMetadata,
  type SubtaskOmissionSummary,
  type SubtaskRestoreContext,
  subtaskCheckpointBytes,
  subtaskCheckpointStorageStatus,
  subtaskMonitorCheckpointMetadata,
} from "./hybrid-checkpoint";
import { requestHash } from "./hybrid-proof";
import {
  copyState,
  emptyState,
  type HybridState,
  type HybridTask,
  type Observation,
  type ObservationRole,
  observationRef,
  type SourceRef,
  tasksNewestFirst,
} from "./hybrid-state";
import type { SubtaskAccessSnapshot } from "./subtask-access";
import {
  restoreSubtaskJournal,
  type SubtaskPhaseRecord,
  type SubtaskReportJob,
} from "./subtask-journal";
import {
  appendSubtaskOmission,
  mergeSubtaskOmissions,
  projectSubtaskOmissions,
  saturateSubtaskOmissions,
} from "./subtask-omissions";
import { mergeSubtaskRestoreHistory } from "./subtask-restore-history";
import {
  type SubtaskPhysicalFlightObserver,
  type SubtaskProposalTransportResult,
  SubtaskRuntime,
  type SubtaskRuntimeCheckpoint,
  type SubtaskRuntimeCurrent,
  subtaskRuntimeRecordIsCurrent,
  subtaskRuntimeReportIsCurrent,
} from "./subtask-runtime";
import { type SubtaskSnapshot, SubtaskStore } from "./subtasks";
import type { Ledger } from "./types";

export interface SelectedModelResult {
  text: string;
  model: string;
  provider: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface MonitorOptions {
  sourceId: () => string;
  extract: (
    input: ExtractionInput,
    signal: AbortSignal,
    onDispatch?: (at: number) => void,
  ) => Promise<SelectedModelResult>;
  /** Optional selected host model identity for generic subtask proposals. */
  selectedModel?: () => string | undefined;
  /** Optional selected-host transport; missing transport never affects mandatory work. */
  proposeSubtasks?: (
    request: SubtaskProposalRequest,
    signal: AbortSignal,
    onDispatch?: (at: number) => boolean,
    onPhysicalFlight?: SubtaskPhysicalFlightObserver,
  ) => Promise<SubtaskProposalTransportResult>;
  /** Runtime-only grounded-detail gate; production enables it and tests may disable it. */
  richDetailsEnabled?: boolean;
  /** Accepted correction advice is runtime-only and delivered by the host seam. */
  onCorrection?: (emission: CorrectionEmission) => void;
}

interface ProviderUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

interface RetainedCard {
  taskId: string;
  revision: number;
  label: string;
  retained: boolean;
  replacementPending: boolean;
  assessedAt: number;
  health: HealthFields;
}

interface PresentationCard extends RetainedCard {
  beads?: BeadsPresentation;
}

/** Runtime-only exact optional-health input; only bounded coverage receipts persist. */
interface HealthWork {
  observation: Observation;
  reports: CanonicalHealthReportContext;
  taskId: string;
  revision: number;
  taskSource: HybridTask["source"];
  /** Only a just-completed task may replace an already valid terminal card. */
  terminal: boolean;
  epoch: number;
  evidenceGeneration: string;
}

type HealthWorkState = "ready" | "in-flight" | "parked" | "terminal";

/** One task identity owns one bounded job plus at most one in-flight successor. */
interface HealthJob {
  work: HealthWork;
  identity: string;
  state: HealthWorkState;
  /** Retry deadline is inert until a later named wake observes it elapsed. */
  parkedUntil?: number;
  /** A job state prevents a second attempt until another named wake changes it. */
  lastAttemptWake?: number;
  /** Coalesced input that arrived while this exact identity was in flight. */
  successor?: HealthWork;
}

interface HealthFlight {
  epoch: number;
  token: number;
  taskId: string;
  work: HealthWork;
}

type HealthAttempt =
  | { kind: "terminal" }
  | { kind: "parked"; until: number }
  | { kind: "paused" };

interface CorrectionFact extends CorrectionRedFact {
  epoch: number;
  taskSource: HybridTask["source"];
  /** Exact runtime health input that admitted this advisory fact. */
  healthIdentity: string;
  /** Digest binds the fact to its accepted task-local health receipt. */
  snapshotHash: string;
}

interface ActivityBatch {
  token: number;
  epoch: number;
  calls: ActivityCall[];
  candidates?: { id: string; label: string; revision: number }[];
}

interface ActivityDeclaration {
  batch: ActivityBatch;
  provisional: ActivityList;
  starts: Map<string, ActivityCall>;
}

interface ActivityFocus {
  id: string;
  label: string;
  revision: number;
}

interface VisibilityCanonicalFrontier {
  length: number;
  digest: string;
  lastId?: string;
  lastRole?: string;
}

interface VisibilitySource {
  bundle: LabelCandidateBundle;
  frontier: VisibilityCanonicalFrontier;
  selections?: LabelSelections;
  confirmed: boolean;
  stage2: "unseen" | "queued" | "in-flight" | "terminal";
}

interface VisibilityFlight {
  token: string;
  stage: 1 | 2;
  epoch: number;
  generation: number;
}

interface ContextTarget {
  id: string;
  includeTarget: boolean;
}

/** Partial reverse scan; never used as a transaction context. */
interface ContextScan {
  target: ContextTarget;
  frontier?: CanonicalFrontier;
  partial: Observation[];
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

interface ActiveWork {
  observation: Observation;
  epoch: number;
  /** Immutable transaction input retained through provider result admission. */
  requestContext: Observation[];
  scan?: ContextScan;
  barrier?: Deferred;
}

interface Telemetry {
  sourceId: string;
  usage: { jev: ProviderUsage; extraction: ProviderUsage };
  lastJevCallAt?: number;
  lastExtractionCallAt?: number;
}

interface ControlWork {
  kind: "restore" | "enable";
  wantEnabled: boolean;
  epoch: number;
  target?: ContextTarget;
  scan?: ContextScan;
  data?: unknown;
  sourceId: string;
  metadata?: SubtaskMonitorCheckpointMetadata;
  preserveControls: boolean;
  telemetry: Telemetry;
  /** Raw strict-v11 metadata retains original-store proof for history merge. */
  subtaskMetadata?: SubtaskMonitorCheckpointMetadata;
  /** Captured before invalidation; a committed pending target takes precedence. */
  liveSubtasks?: SubtaskRuntimeCheckpoint;
  /** Monitor-owned durable history, independent of runtime checkpoint state. */
  liveSubtaskOmissions?: SubtaskOmissionSummary;
  persisted?: boolean;
  done?: Deferred;
}

/** Complete same-source history saved before a reentrant control may observe it. */
interface StagedRestoredSubtaskHistory {
  sourceId: string;
  serial: number;
  component: SubtaskRuntimeCheckpoint;
  subtaskOmissions?: SubtaskOmissionSummary;
}

interface CapacityEnvelope {
  boundaries: Record<string, number>;
  maximum: number;
}

export interface PresentationSnapshot {
  enabled: boolean;
  progress: {
    done: number;
    total: number;
    kind: "current" | "previous" | "empty";
    catchup?: "Catching up history";
  };
  card?: PresentationCard;
  activity: string;
  service: { code: string; label: string };
  usage: { jev: ProviderUsage; extraction: ProviderUsage };
  lastJevCallAt?: number;
  lastExtractionCallAt?: number;
}

export interface DebugSnapshot {
  enabled: boolean;
  processing: "idle" | "processing" | "waiting";
  service: { code: string; label: string };
  diagnostics: { code: string; label: string; count: number }[];
}

/** Detached generic sidecar projection. It cannot change parent task state. */
export type SubtaskMonitorSnapshot = Readonly<SubtaskSnapshot>;

/** Detached durable generic wallet and adapter allocation facts. */
export interface SubtaskDiagnosticsSnapshot {
  dispatches: number;
  exhausted: boolean;
  semanticOmissions: {
    total: number;
    byReason: Record<
      SubtaskOmissionSummary["entries"][number]["reason"],
      number
    >;
    saturated: boolean;
  };
  parkedOwners?: number;
  permanentOwners?: number;
  adapter: {
    pendingCount: number;
    pendingBytes: number;
    retainedBytes: number;
    omissions: number;
  };
}

interface SubtaskDiagnosticAuthority {
  parked: Set<string>;
  permanent: Set<string>;
}

type SubtaskReportOpportunity =
  | { kind: "eligible"; source: SourceRef; identity: string }
  | { kind: "oversized"; parent: HybridTask; source: SourceRef };
type SubtaskReportOmissionReceipt = "recorded" | "not-recorded" | "stale";

export type AdvisorySettlementReason =
  | "disabled"
  | "canonical-scan"
  | "active-observation"
  | "queued-observation"
  | "pending-journal"
  | "retry-timer"
  | "model-wait"
  | "unresolved"
  | "capacity"
  | "blocked"
  | "ready";

interface AdvisorySettlementTask {
  id: string;
  label: string;
  status: HybridTask["status"];
  included: true;
  revision: number;
}

/** Copied semantic board authority for advisory readiness; never persisted. */
export interface AdvisorySettlementSnapshot {
  enabled: boolean;
  reason: AdvisorySettlementReason;
  tasks: AdvisorySettlementTask[];
  uncertainActivities?: ReconciliationUncertainActivity[];
  subtasks?: ReconciliationSubtaskSummary[];
}

const rejectedStorageMessage = (kind: "unsupported" | "corrupt") =>
  kind === "unsupported"
    ? "Saved progress state is unsupported; start a fresh session. Existing progress data was not changed."
    : "Saved progress state is corrupt; start a fresh session. Existing progress data was not changed.";

const diagnosticLabels: Record<string, string> = {
  "invalid-scope-result": "Scope result rejected",
  "jev-unavailable": "Jev service unavailable",
  "model-unavailable": "Selected model unavailable",
  "saved-state-rejected": "Saved state rejected",
  "beads-unavailable": "Beads export unavailable",
  "unresolved-overflow": "Progress input exceeds safe limit",
  "capacity-exhausted": "Progress state capacity reached",
  "health-capacity-skipped": "Optional task health skipped at capacity",
  "detail-capacity-skipped": "Optional task details skipped at capacity",
};

class RetryableJevError extends RetryableProviderError {}

const copyUsage = (usage: ProviderUsage): ProviderUsage => ({ ...usage });
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const safeUsageValue = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const validUsage = (usage: ProviderUsage) => {
  if (
    !safeUsageValue(usage.calls) ||
    !safeUsageValue(usage.inputTokens) ||
    !safeUsageValue(usage.outputTokens)
  )
    throw new Error("Invalid provider usage");
  return { ...usage };
};
/** Never form an unsafe intermediate while preserving monotonic lifetime usage. */
const saturatingAdd = (current: number, delta: number) => {
  if (!safeUsageValue(current) || !safeUsageValue(delta))
    throw new RetryableProviderError();
  return delta > Number.MAX_SAFE_INTEGER - current
    ? Number.MAX_SAFE_INTEGER
    : current + delta;
};
const copyCard = (card: RetainedCard): RetainedCard => ({
  ...card,
  health: { ...card.health },
});
const copyDetailRecord = (record: TaskDetailRecord): TaskDetailRecord =>
  structuredClone(record);
const copyHealthCoverage = (coverage: HealthCoverage): HealthCoverage => ({
  target: { ...coverage.target },
  references: coverage.references.map((reference) => ({ ...reference })),
  complete: coverage.complete,
  omissions: [...coverage.omissions],
  coverageDigest: coverage.coverageDigest,
});
const coverageFor = (
  reports: CanonicalHealthReportContext,
): HealthCoverage => ({
  target: { ...reports.target },
  references: reports.references.map((reference) => ({ ...reference })),
  complete: reports.complete,
  omissions: [...reports.omissions],
  coverageDigest: reports.coverageDigest,
});
const sameObservation = (
  left: { entryId: string; messageHash: string; role: string },
  right: { entryId: string; messageHash: string; role: string },
) =>
  left.entryId === right.entryId &&
  left.messageHash === right.messageHash &&
  left.role === right.role;
const sameHealthCoverage = (
  left: HealthCoverage,
  right: CanonicalHealthReportContext,
) =>
  sameObservation(left.target, right.target) &&
  left.complete === right.complete &&
  left.coverageDigest === right.coverageDigest &&
  left.omissions.length === right.omissions.length &&
  left.omissions.every(
    (omission, index) => omission === right.omissions[index],
  ) &&
  left.references.length === right.references.length &&
  left.references.every((reference, index) => {
    const candidate = right.references[index];
    return !!candidate && sameObservation(reference, candidate);
  });
const copyHealthCard = (card: HealthCard): HealthCard => ({
  ...card,
  health: { ...card.health },
  provenance: {
    ...card.provenance,
    taskSource: { ...card.provenance.taskSource },
    observation: { ...card.provenance.observation },
    coverage: copyHealthCoverage(card.provenance.coverage),
    requestHashes: [...card.provenance.requestHashes],
  },
});
const sameSource = (left: HybridTask["source"], right: HybridTask["source"]) =>
  left.entryId === right.entryId &&
  left.messageHash === right.messageHash &&
  left.role === right.role &&
  left.start === right.start &&
  left.end === right.end &&
  left.quoteHash === right.quoteHash;
const presentationCard = (
  card: RetainedCard,
  beads?: BeadsPresentation,
): PresentationCard => ({
  ...copyCard(card),
  ...(beads ? { beads: { ...beads } } : {}),
});
const MAX_HEALTH_REQUIREMENTS_BYTES = 4 * 1024;
const MAX_CORRECTION_FACTS = 20;
/** Blank/thinking history cannot force unbounded optional context reads. */
const MAX_SUBTASK_CONTEXT_CANDIDATES = 64;

const boundedHealthText = (text: string, maxBytes: number) => {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let bounded = "";
  for (const character of text) {
    if (Buffer.byteLength(bounded) + Buffer.byteLength(character) > maxBytes)
      break;
    bounded += character;
  }
  return `${bounded}\n[bounded canonical text omitted]`;
};

const sameBeads = (
  left: ReadonlyMap<string, BeadsPresentation>,
  right: ReadonlyMap<string, BeadsPresentation>,
) =>
  left.size === right.size &&
  [...left].every(([taskId, value]) => {
    const candidate = right.get(taskId);
    return !!candidate && JSON.stringify(candidate) === JSON.stringify(value);
  });

const healthRequirements = (answer: ValidatedResult["answers"][string]) => {
  if (answer?.type !== "score") return "unknown";
  if (answer.score < 1) return "unclear";
  if (answer.score < 2) return "partly clear";
  if (answer.score < 3) return "mostly clear";
  return answer.score === 3 ? "clear" : "unknown";
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Exact assistant-visible prose only; tool blocks and other roles are ineligible. */
const assistantVisibleText = (message: unknown) => {
  const value = record(message);
  if (value?.role !== "assistant") return;
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return;
  const text: string[] = [];
  for (const part of value.content) {
    const item = record(part);
    if (item?.type === "text" && typeof item.text === "string")
      text.push(item.text);
  }
  return text.join("");
};

const MAX_PENDING_SUBTASK_CAPTURE_BYTES = 64 * 1024;

/**
 * Atomic host runtime for hybrid transactions. Display reads receive copied
 * projections only; focus is never evidence or tool-ownership authority.
 */
export class Monitor {
  state: HybridState;
  enabled = false;
  activity = "Idle";
  /** Safe local status only. Raw provider errors never enter display/persistence. */
  error?: string;
  readonly gateway: JevGateway;
  /** Optional health has independent retry/permanent-failure state. */
  private readonly healthGateway: JevGateway;
  /** Optional display-only tool activity never shares semantic transport authority. */
  private readonly activityGateway: JevGateway;
  /** Optional grounded details never share semantic/health retry state. */
  private readonly detailGateway: JevGateway;
  /** Generic subtask gate has its own durable runtime admission callback. */
  private readonly subtaskGateway: JevGateway;
  private subtaskGateDispatch?: (at: number) => boolean;
  private subtaskPhysicalFlight?: SubtaskPhysicalFlightObserver;
  /** Optional corrective binding has its own one-flight transport authority. */
  private readonly correctionGateway: JevGateway;
  /** Visibility transport and spend are isolated from semantic/advisory telemetry. */
  private readonly visibilityGateway: JevGateway;
  private readonly visibility = new ExecutionVisibilityStore();
  private visibilitySources = new Map<string, VisibilitySource>();
  /** Last branch frontier observed before a one-argument live capture. */
  private visibilityCanonicalFrontier?: VisibilityCanonicalFrontier;
  private visibilityLatestToken?: string;
  private visibilityStage1?: string;
  private visibilityStage2: string[] = [];
  private visibilityFlight?: VisibilityFlight;
  /** Monitor-owned correction admission count gates optional visibility drain. */
  private correctionActive = 0;
  private correctionActivityGeneration = 0;
  private correctionController!: CorrectionController;
  /** Ephemeral raw rubric facts; never display or checkpoint data. */
  private correctionFacts = new Map<string, CorrectionFact>();
  private correctionEpoch = 0;
  readonly evidence = new EvidenceStore();
  readonly usage = {
    jev: { calls: 0, inputTokens: 0, outputTokens: 0 },
    extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
  };
  /** Passive host ingress feeds generic subtask evidence and access gates. */
  private coverageAdapter = new CoverageAdapter();
  private coverageAdapterEpoch = 0;
  /** Runtime owns subtask store/journal; Monitor owns envelope publication. */
  private subtaskRuntime?: SubtaskRuntime;
  /** Last authority-validated projection; passive views never reopen host history. */
  private subtaskProjection?: SubtaskSnapshot;
  private subtaskFlight?: Promise<void>;
  /** Generic invalidation may wait for an oversized report receipt. */
  private subtaskFlightIsReport = false;
  /** Proposal-model reset waits for a charged report's physical drain. */
  private subtaskGatewayResetAfterReportDrain = false;
  private subtaskFlightReportParentId?: string;
  private subtaskFlightReportMayBeSuperseded = false;
  private subtaskOwners: string[] = [];
  private subtaskReportOwners: Array<{
    parentTaskId: string;
    source?: SourceRef;
  }> = [];
  private subtaskReportCandidates = new Map<
    string,
    { source: SourceRef; identity: string }
  >();
  /** Valid oversized report opportunities suppress generic work for this wake. */
  private subtaskOversizedReportParents = new Set<string>();
  private subtaskReportBlocked = new Map<string, SourceRef>();
  private subtaskReportFrontiers = new Map<
    string,
    { decided: Set<string>; advances: number }
  >();
  /** Named-wake validated report owners; drains never reopen host authority. */
  private subtaskActiveReportParents = new Set<string>();
  /** Bounded validated parked/permanent parents; no reader survives capture. */
  private subtaskDiagnosticAuthority?: SubtaskDiagnosticAuthority;
  private subtaskScheduleGeneration = 0;
  private subtaskOptionalTurn: "subtask" | "detail" = "subtask";
  /** One adapter-issued capability stays stable until canonical metadata changes. */
  private subtaskEvidence?: SubtaskEvidence;
  private subtaskWakeKey?: string;
  /** Pending target authority: live unset, blocked null, or detached capture. */
  private pendingSubtaskCurrent?: SubtaskRuntimeCurrent | null;
  private pendingSubtaskCurrentRevoke?: () => void;
  /** Installed target authority: live unset, blocked null, or detached capture. */
  private capturedSubtaskCurrent?: SubtaskRuntimeCurrent | null;
  private capturedSubtaskCurrentRevoke?: () => void;
  private pendingSubtaskCheckpoint?: SubtaskRuntimeCheckpoint;

  private reader?: () => readonly unknown[];
  private cwd?: string;
  /** Current bounded canonical page; historical source stays behind reader. */
  private page: Observation[] = [];
  private pageBytes = 0;
  private pageFrontier?: CanonicalFrontier;
  /** Complete-only context used to form a future transaction. */
  private settledContext: Observation[] = [];
  private pendingScan?: ContextScan;
  private canonicalWakeTimer?: ReturnType<typeof setTimeout>;
  private controlWork?: ControlWork;
  private queued: Observation[] = [];
  private processing = false;
  private waitingForWake = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryObservation?: Observation;
  private blockedPending?: { id: string; hash: string };
  private activeObservation?: ActiveWork;
  private catchingUp = false;
  /** Initial backlog target; remains set until its observation commits. */
  private catchupTarget?: { id: string; hash: string };
  /** Set only by startup/restore history boundaries, never live appends. */
  private latchHistoricalCatchup = false;
  private epoch = 0;
  private extractionController?: AbortController;
  /** Insertion-ordered explicit health lifecycle states, capped at 20 tasks. */
  private healthJobs = new Map<string, HealthJob>();
  private healthFlight?: HealthFlight;
  private healthWake = 0;
  /** Gateway backoff expires inertly; later named wake is still required. */
  private healthBackoffWake?: number;
  private detailFlight?: { epoch: number; token: number; taskId: string };
  private nextDetailToken = 0;
  /** Durable optional task records; never part of semantic state. */
  private taskDetails = new Map<string, TaskDetailRecord>();
  /** Detached canonical text materialized only on update, never at board read. */
  private detailValues = new Map<string, MaterializedTaskDetails>();
  /** Optional transport failures park until a named semantic/control wake. */
  private parkedDetails = new Set<string>();
  private nextHealthToken = 0;
  private activityDeclaration?: ActivityDeclaration;
  private activityFlight?: ActivityBatch;
  private activityQueued?: ActivityBatch;
  private nextActivityToken = 0;
  /** Runtime-only activity can supersede semantic display, never semantic authority. */
  private activityFocus?: ActivityFocus;
  private activitySupersedesSemantic = false;
  /** Runtime-only projection derived from exact task-local cards. */
  private card?: RetainedCard;
  /** Bounded durable map, the only persisted health authority. */
  private healthCards = new Map<string, HealthCard>();
  /** Runtime task-local proof; snapshot identities cannot survive reload. */
  private currentHealthProofs = new Map<string, string>();
  private lastDisplayedTaskId?: string;
  /** New unclassified work immediately disqualifies retained idle DONE display. */
  private idleDoneInvalidated = false;
  private beads = new Map<string, BeadsPresentation>();
  private beadsGeneration = 0;
  private beadsInFlight = false;
  private beadsRefreshQueued = false;
  private lastJevCallAt?: number;
  private lastExtractionCallAt?: number;
  private diagnostics = new Map<string, number>();
  /** A rejected persisted shape remains OFF until a new restore boundary. */
  private restoreRejection?: "unsupported" | "corrupt";
  /** Monitor-owned durable omission history survives runtime replacement. */
  private subtaskOmissions?: SubtaskOmissionSummary;
  /** Source-scoped save candidate visible only to reentrant persistence writers. */
  private savingSubtaskOmissionSummary?: {
    sourceId: string;
    summary: SubtaskOmissionSummary;
  };
  /** Complete restore candidate visible while its synchronous save callback runs. */
  private savingRestoredSubtaskHistory?: StagedRestoredSubtaskHistory;
  /** Successfully saved same-source history awaiting adoption by a current control. */
  private restoredSubtaskHistoryFloor?: StagedRestoredSubtaskHistory;
  private nextRestoredSubtaskHistorySerial = 0;
  private latestRestoredSubtaskHistorySerial = 0;

  constructor(
    private readonly changed: () => void,
    private readonly persist: (checkpoint: unknown) => void,
    private readonly options: MonitorOptions,
  ) {
    this.state = emptyState(options.sourceId());
    this.gateway = new JevGateway({
      fetch: (url, init) => globalThis.fetch(url, init),
      getApiKey: () => process.env.TYPESAFE_API_KEY,
      onDispatch: (at) => this.recordJevDispatch(at),
      onPermanentError: () => this.forceOff(),
    });
    this.healthGateway = new JevGateway({
      fetch: (url, init) => globalThis.fetch(url, init),
      getApiKey: () => process.env.TYPESAFE_API_KEY,
      onDispatch: (at) => this.recordJevDispatch(at),
      // Health is optional: a permanent health transport error cannot turn OFF tracking.
      onPermanentError: () => this.note("model-unavailable"),
    });
    this.activityGateway = new JevGateway({
      fetch: (url, init) => globalThis.fetch(url, init),
      getApiKey: () => process.env.TYPESAFE_API_KEY,
      onDispatch: (at) => this.recordJevDispatch(at),
      // Activity is optional display enrichment; it never disables core tracking.
      onPermanentError: () => this.note("jev-unavailable"),
    });
    this.detailGateway = new JevGateway({
      fetch: (url, init) => globalThis.fetch(url, init),
      getApiKey: () => process.env.TYPESAFE_API_KEY,
      onDispatch: (at) => this.recordJevDispatch(at),
      onPermanentError: () => this.note("detail-capacity-skipped"),
    });
    this.subtaskGateway = new JevGateway({
      fetch: (url, init) => globalThis.fetch(url, init),
      getApiKey: () => process.env.TYPESAFE_API_KEY,
      // SubtaskRuntime commits dispatch proof before this callback returns true.
      beforeDispatch: (at) => this.subtaskGateDispatch?.(at) === true,
      onPhysicalFlight: (drain) => {
        try {
          this.subtaskPhysicalFlight?.(drain);
        } catch {
          // Observation is never gateway dispatch authority.
        }
      },
      onPermanentError: () => this.note("jev-unavailable"),
    });
    this.correctionGateway = new JevGateway({
      fetch: (url, init) => globalThis.fetch(url, init),
      getApiKey: () => process.env.TYPESAFE_API_KEY,
      onDispatch: (at) => this.recordJevDispatch(at),
      // Corrections are optional and never disable semantic progress tracking.
      onPermanentError: () => this.note("model-unavailable"),
    });
    this.visibilityGateway = new JevGateway({
      fetch: (url, init) => globalThis.fetch(url, init),
      getApiKey: () => process.env.TYPESAFE_API_KEY,
      onDispatch: () => {
        this.visibility.recordDispatch();
        this.publish();
      },
      // Visibility is optional and must never change semantic/advisory availability.
      onPermanentError: () => {
        this.visibility.markIncomplete();
        this.publish();
      },
    });
    this.correctionController = this.newCorrectionController();
    this.installSubtaskRuntime(this.emptySubtaskCheckpoint());
  }

  /** Display focus never establishes tool evidence authority. */
  evidenceLink() {
    return undefined;
  }

  /** Runtime tool start is candidate-only until later canonical confirmation. */
  observeCoverageToolStart(
    callId: string,
    toolName: string,
    args: unknown,
  ): void {
    if (!this.enabled) return;
    this.coverageAdapter.start(
      { toolCallId: callId, toolName, args },
      this.coverageAdapterEpoch,
    );
    this.publish();
  }

  /** Runtime tool end clears only its exact optional candidate. */
  observeCoverageToolEnd(callId: string, toolName: string): void {
    if (!this.enabled) return;
    this.coverageAdapter.end(
      { toolCallId: callId, toolName },
      this.coverageAdapterEpoch,
    );
    this.publish();
  }

  /**
   * Re-read active canonical branch after host append. Tool listener payloads
   * remain passive adapter ingress; metadata may only wake generic evaluation.
   */
  confirmCoverageBranch(entries: readonly unknown[]): void {
    if (!this.enabled) return;
    const pass = new CanonicalPass(entries);
    try {
      this.coverageAdapter.confirm(pass.entries, this.coverageAdapterEpoch);
    } catch {
      // Optional adapter confirmation never changes mandatory scheduling.
    }
    this.wakeSubtasks(pass);
    this.drain();
    this.publish();
  }

  subtaskSnapshot(): SubtaskMonitorSnapshot {
    if (this.pendingSubtaskCheckpoint)
      return structuredClone(
        this.subtaskProjection ?? new SubtaskStore().snapshot(),
      );
    const runtime = this.subtaskRuntime;
    if (!runtime) return new SubtaskStore().snapshot();
    const snapshot = runtime.snapshot();
    return snapshot.groups.length
      ? snapshot
      : structuredClone(this.subtaskProjection ?? snapshot);
  }

  /** Detached C04 access view. It cannot admit, report, or schedule subtasks. */
  subtaskAccessSnapshot(): SubtaskAccessSnapshot {
    return (
      this.subtaskRuntime?.accessSnapshot(
        this.coverageAdapter.accessEvidence(),
      ) ?? { groups: [], omissions: 0 }
    );
  }

  /** Passive durable generic wallet and captured-owner projection. */
  subtaskDiagnosticsSnapshot(): SubtaskDiagnosticsSnapshot {
    const journal = this.authoritativeSubtaskCheckpoint().journal;
    const dispatches = journal?.dispatches ?? 0;
    const adapter = this.coverageAdapter.snapshot();
    const authority = this.subtaskDiagnosticAuthority;
    return {
      dispatches,
      exhausted: dispatches === 1024,
      ...(authority === undefined
        ? {}
        : {
            parkedOwners: authority.parked.size,
            permanentOwners: authority.permanent.size,
          }),
      semanticOmissions: projectSubtaskOmissions(this.subtaskOmissions),
      adapter: {
        pendingCount: adapter.pendingCount,
        pendingBytes: adapter.pendingBytes,
        retainedBytes: adapter.retainedBytes,
        omissions: adapter.omissions,
      },
    };
  }

  /** Provisional declared calls dispatch immediately; final reconciliation is turn-bound. */
  observeActivityDeclaration(message: unknown) {
    if (!this.enabled || !this.cwd) return;
    const provisional = captureDeclaredTools(message, this.cwd);
    if (!provisional) return;
    const batch = this.newActivityBatch(provisional.calls);
    this.activityDeclaration = { batch, provisional, starts: new Map() };
    this.activityFocus = undefined;
    this.activitySupersedesSemantic = true;
    this.publish();
    if (provisional.kind === "ready") this.scheduleActivity(batch);
  }

  /** Actual starts remain runtime-only matching material; never evidence or provider data. */
  observeActivityStart(callId: string, toolName: string, args: unknown) {
    const declaration = this.activityDeclaration;
    if (!this.enabled || !this.cwd || !declaration) return;
    const call = captureStartedTool(callId, toolName, args, this.cwd);
    declaration.starts.set(callId, call);
  }

  /** Reconcile only once all host tool starts for this turn are known. */
  observeActivityTurnEnd(message: unknown) {
    const declaration = this.activityDeclaration;
    if (!this.enabled || !this.cwd || !declaration) return;
    this.activityDeclaration = undefined;
    const result = reconcileStartedTools(
      declaration.provisional,
      declaration.starts,
      message,
      this.cwd,
    );
    if (result.kind === "unchanged") return;
    // Later evidence supersedes provisional response before an optional correction.
    this.nextActivityToken++;
    this.activityFocus = undefined;
    if (result.kind !== "changed" || !result.calls?.length) {
      // Empty observed starts restore semantic/fallback display. Every malformed
      // boundary remains newer-but-uncertain work and must hide stale INPROG/DONE.
      this.activitySupersedesSemantic = result.kind !== "empty";
      this.publish();
      return;
    }
    const batch = this.newActivityBatch(result.calls);
    this.activitySupersedesSemantic = true;
    this.publish();
    this.scheduleActivity(batch);
  }

  observeToolStart(
    callId: string,
    toolName: string,
    args: unknown,
    entryId?: string,
  ) {
    if (!this.enabled) return;
    this.evidence.start(callId, toolName, args, Date.now(), entryId);
  }

  observeToolEnd(
    callId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
  ) {
    if (!this.enabled) return;
    const evidence = JSON.stringify(this.evidence.snapshot());
    const value =
      result && typeof result === "object"
        ? { ...(result as object), isError }
        : { isError };
    this.evidence.finish(callId, toolName, value, Date.now());
    if (JSON.stringify(this.evidence.snapshot()) !== evidence) {
      // Validated passive evidence is a named health wake, never semantic work.
      this.currentHealthProofs.clear();
      this.wakeHealthFromCurrent("evidence");
      this.syncPresentationCard();
      this.publish();
      this.drain();
    }
  }

  /** Start a live run without restoring or changing runtime history. */
  visibilityRunStarted(): void {
    if (!this.enabled) return;
    this.visibility.startRun();
    this.publish();
  }

  /** Settlement clears current display; a confirmed history flight may still finish. */
  visibilityRunSettled(): void {
    if (!this.enabled) return;
    this.visibility.settle();
    if (this.visibilityFlight?.stage === 1) this.dropVisibilityFlight();
    this.visibilityStage1 = undefined;
    this.publish();
  }

  /**
   * Capture listener-relative live assistant text. The optional active branch is
   * a preappend canonical frontier, never evidence selected by text alone.
   */
  observeVisibilityMessage(
    message: unknown,
    branch?: readonly unknown[],
  ): void {
    if (!this.enabled) return;
    const value = record(message);
    if (value?.role !== "assistant") return;
    // Every assistant ingress clears older provisional current and its pending
    // Stage 1 before this message can abstain, overflow, or be rejected.
    this.supersedeVisibilityMessage();
    if (value.stopReason === "error" || value.stopReason === "aborted") {
      this.visibility.markIncomplete();
      this.publish();
      return;
    }
    const frontier = this.visibilityFrontier(branch);
    const text = assistantVisibleText(message);
    if (!frontier || text === undefined) {
      this.visibility.markIncomplete();
      this.publish();
      return;
    }
    const bundle = this.visibility.capture(text);
    if (!bundle) {
      this.publish();
      return;
    }
    this.visibilitySources.set(bundle.liveToken, {
      bundle,
      frontier,
      confirmed: false,
      stage2: "unseen",
    });
    this.visibilityLatestToken = bundle.liveToken;
    this.visibilityStage1 = bundle.liveToken;
    while (this.visibilitySources.size > 8) {
      const token = this.visibilitySources.keys().next().value as
        | string
        | undefined;
      if (!token) break;
      this.dropVisibilitySource(token);
    }
    this.drainVisibility();
    this.publish();
  }

  /** Match only a new canonical assistant entry after this source's frontier. */
  confirmVisibilityBranch(branch: readonly unknown[]): void {
    if (!this.enabled || !this.visibilityLatestToken) return;
    const token = this.visibilityLatestToken;
    const source = this.visibilitySources.get(token);
    if (!source) return;
    const pass = new CanonicalPass(branch);
    const canonical = this.visibilityCanonicalAfter(pass, source.frontier);
    if (!this.visibility.confirm(token, canonical?.text ?? "")) {
      this.dropVisibilitySource(token);
    } else {
      source.confirmed = true;
      if (source.selections) this.enqueueVisibilityStage2(token);
    }
    this.drainVisibility();
    this.publish();
  }

  /** Finite local tool phase only; no path, argument, output, or tool name escapes. */
  observeVisibilityToolStart(
    callId: string,
    toolName: string,
    args: unknown,
  ): void {
    if (!this.enabled) return;
    this.visibility.toolStart(callId, this.visibilityPhase(toolName, args));
    this.publish();
  }

  /** A terminal tool event only clears its matching local phase. */
  observeVisibilityToolEnd(callId: string): void {
    if (!this.enabled) return;
    this.visibility.toolEnd(callId);
    this.publish();
  }

  /** Detached runtime-only visibility projection; never semantic/checkpoint data. */
  visibilitySnapshot(): ExecutionVisibilitySnapshot {
    return this.visibility.snapshot();
  }

  /** Navigation is a lifetime boundary; no volatile report survives a tree change. */
  invalidateVisibility(): void {
    this.resetVisibility();
    this.publish();
  }

  setActivity(activity: string) {
    if (this.activity === activity) return;
    this.activity = activity;
    this.publish();
  }

  turnOn(cwd: string): string | undefined {
    this.cwd = cwd;
    if (this.restoreRejection) {
      this.publish();
      return this.error ?? rejectedStorageMessage(this.restoreRejection);
    }
    if (this.enabled) return;
    if (this.controlWork) {
      this.controlWork.wantEnabled = true;
      this.scheduleCanonicalWake();
      return;
    }
    if (!process.env.TYPESAFE_API_KEY?.trim()) {
      this.error = "TYPESAFE_API_KEY is required; progress monitor is OFF";
      this.publish();
      return this.error;
    }
    const sourceId = this.options.sourceId();
    if (sourceId !== this.state.sourceId) this.resetState(sourceId);
    this.beginControl({
      kind: "enable",
      wantEnabled: true,
      sourceId,
      preserveControls: false,
      telemetry: this.captureTelemetry(sourceId),
      target: this.contextTarget(this.state),
    });
  }

  /** Effective OFF is immediate; desired ON belongs only to ControlWork. */
  turnOff() {
    if (this.restoreRejection) {
      this.disableRuntime();
      this.publish();
      return;
    }
    const control = this.controlWork;
    if (control) {
      control.wantEnabled = false;
      this.error = undefined;
      this.publish();
      return;
    }
    if (!this.enabled) return;
    this.disableRuntime();
    this.clearRuntimeContext();
    this.save();
    this.publish();
  }

  stop() {
    this.disableRuntime();
    this.clearRuntimeContext();
    this.finishControl(this.controlWork);
    this.controlWork = undefined;
    this.publish();
  }

  /** Model selection cannot revive old semantic state during a control handoff. */
  modelSelected() {
    if (this.controlWork || !this.enabled) return;
    const pass = this.beginCanonicalPass();
    this.rememberVisibilityFrontier(pass);
    const authority = this.reconcileAuthority(pass);
    if (authority === "amended") this.resetForCanonicalAmendment();
    else if (authority === "incomplete") this.scheduleCanonicalWake();
    else {
      this.reconcileHealthCards(pass);
      this.clearRetry();
      this.settleActiveAuthority(this.activeObservation);
      this.epoch++;
      this.extractionController?.abort();
      this.cancelHealth();
      this.invalidateCorrections();
      this.gateway.pause();
      this.healthGateway.pause();
      this.activityGateway.pause();
      this.detailGateway.pause();
      const retainReportAuthority = this.subtaskFlightIsReport;
      if (retainReportAuthority)
        this.subtaskGatewayResetAfterReportDrain = true;
      else {
        this.subtaskRuntime?.invalidate();
        this.subtaskGateway.pause();
      }
      this.subtaskGateDispatch = undefined;
      this.subtaskDiagnosticAuthority = undefined;
      this.subtaskOwners = [];
      this.subtaskWakeKey = undefined;
      this.resetCoverageAdapter();
      this.correctionGateway.pause();
      this.dropVisibilityFlight();
      this.visibilityGateway.pause();
      this.clearActivity(false);
      this.gateway.enable(this.identity());
      this.healthGateway.enable(this.identity());
      this.wakeHealthFromCurrent("control", true, pass);
      this.activityGateway.enable(this.identity());
      this.detailGateway.enable(this.identity());
      if (!retainReportAuthority)
        this.subtaskGateway.enable(this.subtaskIdentity());
      this.correctionGateway.enable(this.identity());
      this.visibilityGateway.enable(this.visibilityIdentity());
      this.waitingForWake = false;
      this.requeue(pass);
      if (!this.queued.length) this.wakeSubtasks(pass, true);
      this.drain();
    }
    this.publish();
  }

  /** Canonical branch is read only on host observation, never projections. */
  observe(reader: () => readonly unknown[]) {
    this.reader = reader;
    // Keep a host-observed canonical frontier for the one-argument test seam;
    // it is never inferred from arbitrary historical assistant prose.
    const pass = this.beginCanonicalPass();
    this.rememberVisibilityFrontier(pass);
    if (this.controlWork || !this.enabled) return;
    const authority = this.reconcileAuthority(pass);
    if (authority === "amended") this.resetForCanonicalAmendment();
    else if (authority === "incomplete") this.scheduleCanonicalWake();
    else {
      const healthChanged = this.reconcileHealthCards(pass);
      const staleHealthWork = [...this.healthJobs.values()].some(
        (job) =>
          job.state !== "terminal" &&
          !this.healthWorkCurrent(job.successor ?? job.work, pass),
      );
      // Amendments can affect pending health work without touching an older card.
      if (healthChanged || staleHealthWork)
        this.wakeHealthFromCurrent("canonical", false, pass);
      this.requeue(pass);
      if (this.queued.length) {
        this.idleDoneInvalidated = true;
        this.cancelHealth();
        this.invalidateSubtaskWork(this.subtaskFlightIsReport);
      } else this.wakeSubtasks(pass);
      if (healthChanged) this.publish();
      this.drain();
    }
  }

  checkpoint(): unknown {
    return encodeSubtaskCheckpoint(this.state, this.subtaskMetadata());
  }

  private restoreSourceMatches(data: unknown, sourceId: string) {
    if (!data || typeof data !== "object") return false;
    const state = (data as { state?: unknown }).state;
    return (
      !!state &&
      typeof state === "object" &&
      (state as { sourceId?: unknown }).sourceId === sourceId
    );
  }

  private restoreTarget(data: unknown): ContextTarget | undefined {
    if (!data || typeof data !== "object") return;
    const state = (data as { state?: unknown }).state;
    if (!state || typeof state !== "object") return;
    const pending = (state as { pending?: unknown }).pending;
    if (pending && typeof pending === "object") {
      const observation = (pending as { observation?: unknown }).observation;
      const entryId =
        observation && typeof observation === "object"
          ? (observation as { entryId?: unknown }).entryId
          : undefined;
      if (typeof entryId === "string" && entryId)
        return { id: entryId, includeTarget: false };
    }
    const cursor = (state as { cursor?: unknown }).cursor;
    const id =
      cursor && typeof cursor === "object"
        ? (cursor as { id?: unknown }).id
        : undefined;
    return typeof id === "string" && id
      ? { id, includeTarget: true }
      : undefined;
  }

  private contextTarget(state: HybridState): ContextTarget | undefined {
    const pending = state.pending?.observation;
    if (pending) return { id: pending.entryId, includeTarget: false };
    const cursor = state.cursor;
    return cursor ? { id: cursor.id, includeTarget: true } : undefined;
  }

  /** Accepted pending work is valid only against its exact complete gate context. */
  private pendingContextAmended(state: HybridState = this.state) {
    const pending = state.pending;
    return (
      !!pending &&
      !this.sameContext(pending.journal.gate.context, this.settledContext)
    );
  }

  private deferred(): Deferred {
    let resolve = () => {};
    const promise = new Promise<void>((ok) => {
      resolve = ok;
    });
    return { promise, resolve };
  }

  private captureTelemetry(sourceId: string): Telemetry {
    return {
      sourceId,
      usage: {
        jev: copyUsage(this.usage.jev),
        extraction: copyUsage(this.usage.extraction),
      },
      ...(this.lastJevCallAt ? { lastJevCallAt: this.lastJevCallAt } : {}),
      ...(this.lastExtractionCallAt
        ? { lastExtractionCallAt: this.lastExtractionCallAt }
        : {}),
    };
  }

  private beginControl(input: Omit<ControlWork, "epoch" | "done">) {
    const sameSource = input.sourceId === this.state.sourceId;
    const liveSubtasks = sameSource
      ? this.authoritativeSubtaskCheckpoint()
      : undefined;
    const omissions = this.durableSubtaskOmissions();
    const liveSubtaskOmissions = sameSource
      ? omissions && structuredClone(omissions)
      : undefined;
    this.disableRuntime();
    // Old work retains its local owner until its own finally block unwinds, but
    // target restore validation must not include old-branch references.
    this.activeObservation = undefined;
    this.clearRuntimeContext();
    const work: ControlWork = {
      ...input,
      ...(liveSubtasks === undefined ? {} : { liveSubtasks }),
      ...(liveSubtaskOmissions === undefined ? {} : { liveSubtaskOmissions }),
      epoch: this.epoch,
      ...(input.kind === "restore" ? { done: this.deferred() } : {}),
    };
    this.controlWork = work;
    this.advanceControl(work);
    return work.done?.promise;
  }

  private disableRuntime() {
    this.pendingSubtaskCurrentRevoke?.();
    this.pendingSubtaskCurrentRevoke = undefined;
    this.pendingSubtaskCurrent = null;
    this.capturedSubtaskCurrentRevoke?.();
    this.capturedSubtaskCurrentRevoke = undefined;
    this.capturedSubtaskCurrent = null;
    this.enabled = false;
    this.subtaskGatewayResetAfterReportDrain = false;
    this.waitingForWake = false;
    this.clearRetry();
    this.settleActiveAuthority(this.activeObservation);
    this.epoch++;
    this.extractionController?.abort();
    this.cancelHealth();
    this.invalidateCorrections();
    this.healthJobs.clear();
    this.healthBackoffWake = undefined;
    this.gateway.pause();
    this.healthGateway.pause();
    this.activityGateway.pause();
    this.detailGateway.pause();
    this.subtaskRuntime?.invalidate();
    this.subtaskGateway.pause();
    this.subtaskGateDispatch = undefined;
    this.subtaskDiagnosticAuthority = undefined;
    this.subtaskOwners = [];
    this.subtaskWakeKey = undefined;
    this.correctionGateway.pause();
    this.resetVisibility();
    this.resetCoverageAdapter();
    this.clearActivity(false);
    this.evidence.clearPending();
  }

  private finishControl(work: ControlWork | undefined) {
    work?.done?.resolve();
  }

  private mergeTelemetry(
    metadata: SubtaskMonitorCheckpointMetadata | undefined,
    work: ControlWork,
    pass: CanonicalPass,
  ) {
    if (!(work.preserveControls && work.sourceId === work.telemetry.sourceId)) {
      this.applyMetadata(metadata, pass);
      return;
    }
    this.applyMetadata(metadata, pass);
    this.usage.jev.calls = Math.max(
      this.usage.jev.calls,
      work.telemetry.usage.jev.calls,
    );
    this.usage.jev.inputTokens = Math.max(
      this.usage.jev.inputTokens,
      work.telemetry.usage.jev.inputTokens,
    );
    this.usage.jev.outputTokens = Math.max(
      this.usage.jev.outputTokens,
      work.telemetry.usage.jev.outputTokens,
    );
    this.usage.extraction.calls = Math.max(
      this.usage.extraction.calls,
      work.telemetry.usage.extraction.calls,
    );
    this.usage.extraction.inputTokens = Math.max(
      this.usage.extraction.inputTokens,
      work.telemetry.usage.extraction.inputTokens,
    );
    this.usage.extraction.outputTokens = Math.max(
      this.usage.extraction.outputTokens,
      work.telemetry.usage.extraction.outputTokens,
    );
    this.lastJevCallAt =
      Math.max(this.lastJevCallAt ?? 0, work.telemetry.lastJevCallAt ?? 0) ||
      undefined;
    this.lastExtractionCallAt =
      Math.max(
        this.lastExtractionCallAt ?? 0,
        work.telemetry.lastExtractionCallAt ?? 0,
      ) || undefined;
  }

  private scanContext(
    pass: CanonicalPass,
    scan: ContextScan | undefined,
    target: ContextTarget,
  ) {
    const result = pass.precedingResult(
      target.id,
      target.includeTarget,
      scan?.frontier,
      scan?.partial,
    );
    if (result.complete)
      return { complete: true as const, context: result.context };
    return {
      complete: false as const,
      scan: {
        target,
        frontier: result.frontier,
        partial: result.context,
      } satisfies ContextScan,
    };
  }

  private advanceControl(work: ControlWork) {
    if (this.controlWork !== work || work.epoch !== this.epoch) return;
    const pass = this.beginCanonicalPass();
    if (work.target) {
      const scanned = this.scanContext(pass, work.scan, work.target);
      if (!scanned.complete) {
        work.scan = scanned.scan;
        this.scheduleCanonicalWake();
        this.publish();
        return;
      }
      this.settledContext = scanned.context;
      work.scan = undefined;
    } else this.settledContext = [];

    if (work.kind === "restore") {
      const restored = restoreSubtaskCheckpoint(
        work.data,
        work.sourceId,
        (entryId) => this.resolveObservation(pass, entryId),
        (entryId) =>
          work.target?.id === entryId
            ? this.settledContext
            : this.rehydratePreceding(pass, entryId),
        (record, candidate) =>
          this.subtaskRestoreCurrent(record, candidate, pass),
        (report, candidate) =>
          this.subtaskRestoreReportCurrent(report, candidate, pass),
      );
      const emptySubtasks = this.emptySubtaskCheckpoint();
      const liveSubtasks = work.liveSubtasks ?? emptySubtasks;
      const incomingSubtasks = work.subtaskMetadata?.subtasks ?? emptySubtasks;
      const targetStore = restored?.monitor?.subtasks?.state;
      const subtaskOmissions = this.restoredSubtaskOmissions(work);
      const preservesSubtaskHistory =
        this.hasSubtaskCheckpointData(liveSubtasks) ||
        this.hasSubtaskCheckpointData(incomingSubtasks) ||
        (targetStore !== undefined &&
          this.hasSubtaskCheckpointData({
            state: targetStore,
            journal: emptySubtasks.journal,
          })) ||
        subtaskOmissions !== undefined;
      if (restored && preservesSubtaskHistory) {
        const canonicalReset =
          this.directCanonicalAmendment(pass, restored.state) ||
          this.pendingContextAmended(restored.state);
        const state = canonicalReset
          ? emptyState(work.sourceId)
          : restored.state;
        const component = this.mergedRestoredSubtaskHistory(
          liveSubtasks,
          incomingSubtasks,
          canonicalReset
            ? emptySubtasks.state
            : (targetStore ?? emptySubtasks.state),
          state,
          pass,
        );
        const metadata = this.restoredSubtaskMetadata(
          canonicalReset
            ? this.resetSubtaskMetadata(work.subtaskMetadata)
            : restored.monitor,
          component ?? emptySubtasks,
          work.wantEnabled,
          work,
          state,
          pass,
          subtaskOmissions,
        );
        const savedHistory = component
          ? this.commitRestoredSubtaskHistory(state, metadata, component)
          : undefined;
        if (!savedHistory) {
          this.refuseRestoredSubtaskHistory(work);
          return;
        }
        if (!this.restoredWorkIsCurrent(work)) return;
        this.adoptRestoredSubtaskHistory(savedHistory);
        this.subtaskOmissions = subtaskOmissions;
        if (canonicalReset) {
          this.mergeTelemetry(metadata, work, pass);
          this.resetState(work.sourceId, false, component);
        } else {
          this.state = copyState(state);
          this.replaceSubtaskRuntime(component);
          this.hydrateSubtaskProjection(pass, component);
          this.mergeTelemetry(metadata, work, pass);
          this.captureSubtaskDiagnosticAuthoritySafely(component, () =>
            this.subtaskCurrent(this.state, pass, true),
          );
          this.latchHistoricalCatchup = true;
        }
        // A reentrant OFF may have changed desired control after this save.
        work.persisted = metadata.enabled === work.wantEnabled;
      } else if (restored) {
        this.subtaskOmissions = subtaskOmissions;
        this.state = copyState(restored.state);
        this.replaceSubtaskRuntime(restored.monitor?.subtasks);
        this.hydrateSubtaskProjection(pass);
        this.mergeTelemetry(restored.monitor, work, pass);
        this.captureSubtaskDiagnosticAuthoritySafely(
          restored.monitor?.subtasks ?? this.emptySubtaskCheckpoint(),
          () => this.subtaskCurrent(this.state, pass, true),
        );
        this.latchHistoricalCatchup = true;
        if (this.directCanonicalAmendment(pass) || this.pendingContextAmended())
          this.resetState(work.sourceId, false);
      } else if (
        this.restoreSourceMatches(work.data, work.sourceId) &&
        preservesSubtaskHistory
      ) {
        const state = emptyState(work.sourceId);
        const component = this.mergedRestoredSubtaskHistory(
          liveSubtasks,
          incomingSubtasks,
          emptySubtasks.state,
          state,
          pass,
        );
        const metadata = this.restoredSubtaskMetadata(
          this.resetSubtaskMetadata(work.subtaskMetadata),
          component ?? emptySubtasks,
          work.wantEnabled,
          work,
          state,
          pass,
          subtaskOmissions,
        );
        const savedHistory = component
          ? this.commitRestoredSubtaskHistory(state, metadata, component)
          : undefined;
        if (!savedHistory) {
          this.refuseRestoredSubtaskHistory(work);
          return;
        }
        if (!this.restoredWorkIsCurrent(work)) return;
        this.adoptRestoredSubtaskHistory(savedHistory);
        this.subtaskOmissions = subtaskOmissions;
        this.mergeTelemetry(metadata, work, pass);
        this.resetState(work.sourceId, false, component);
        this.latchHistoricalCatchup = true;
        // Only exact desired control may suppress final OFF persistence.
        work.persisted = metadata.enabled === work.wantEnabled;
      } else if (this.restoreSourceMatches(work.data, work.sourceId)) {
        this.mergeTelemetry(work.metadata, work, pass);
        this.resetState(work.sourceId, false);
        this.latchHistoricalCatchup = true;
      } else {
        if (work.data !== undefined) this.note("saved-state-rejected");
        this.resetState(
          work.sourceId,
          work.sourceId !== work.telemetry.sourceId,
        );
      }
    } else if (
      this.directCanonicalAmendment(pass) ||
      this.pendingContextAmended()
    ) {
      // Enable is already effectively OFF. Rebuild semantics without
      // canceling desired control or writing old branch state.
      this.resetState(work.sourceId, false);
      this.latchHistoricalCatchup = true;
      work.target = undefined;
      work.scan = undefined;
    }

    if (
      work.kind === "enable" &&
      !this.adoptSavedSubtaskHistoryForEnable(work, pass)
    )
      return;

    // Optional health references never trigger semantic replay/reset.
    this.reconcileHealthCards(pass);
    this.controlWork = undefined;
    if (!work.wantEnabled) {
      if (work.persisted) {
        // Transaction already saved exact disabled candidate.
      } else if (this.falseProjectionFits()) this.save();
      else this.note("capacity-exhausted");
      this.finishControl(work);
      this.publish();
      return;
    }
    if (!process.env.TYPESAFE_API_KEY?.trim()) {
      this.error = "TYPESAFE_API_KEY is required; progress monitor is OFF";
      this.finishControl(work);
      this.publish();
      return;
    }
    if (!work.persisted && !this.falseProjectionFits()) {
      this.note("capacity-exhausted");
      this.finishControl(work);
      this.publish();
      return;
    }
    this.enabled = true;
    this.error = undefined;
    this.waitingForWake = false;
    this.epoch++;
    this.gateway.enable(this.identity());
    this.healthGateway.enable(this.identity());
    this.wakeHealthFromCurrent("control", true, pass);
    this.activityGateway.enable(this.identity());
    this.detailGateway.enable(this.identity());
    this.subtaskGateway.enable(this.subtaskIdentity());
    this.correctionGateway.enable(this.identity());
    this.visibilityGateway.enable(this.visibilityIdentity());
    this.rememberVisibilityFrontier(pass);
    this.requeue(pass, true);
    if (this.queued.length) this.idleDoneInvalidated = true;
    else this.wakeSubtasks(pass, true);
    this.save();
    this.refreshBeads();
    this.publish();
    this.drain();
    this.finishControl(work);
  }

  async restore(
    cwd: string,
    data: unknown,
    preserveControls = false,
    reader?: () => readonly unknown[],
  ) {
    const storage = subtaskCheckpointStorageStatus(data);
    const prior = this.controlWork;
    const restored =
      storage === "supported"
        ? subtaskMonitorCheckpointMetadata(data)
        : undefined;
    const desired = preserveControls
      ? (prior?.wantEnabled ?? this.enabled)
      : storage === "supported"
        ? (restored?.enabled ?? true)
        : true;
    this.finishControl(prior);
    this.controlWork = undefined;
    this.cwd = cwd;
    if (reader) this.reader = reader;
    this.queued = [];
    this.blockedPending = undefined;
    this.catchingUp = false;
    this.catchupTarget = undefined;
    this.beads.clear();
    this.beadsGeneration++;
    this.evidence.reset();
    this.diagnostics.clear();
    const sourceId = this.options.sourceId();
    if (storage === "unsupported" || storage === "corrupt") {
      this.rejectStoredCheckpoint(sourceId, storage);
      return;
    }
    this.restoreRejection = undefined;
    this.error = undefined;
    const promise = this.beginControl({
      kind: "restore",
      wantEnabled: desired,
      sourceId,
      metadata: storage === "supported" ? restored : undefined,
      subtaskMetadata: storage === "supported" ? restored : undefined,
      data,
      preserveControls,
      telemetry: this.captureTelemetry(this.state.sourceId),
      target: storage === "supported" ? this.restoreTarget(data) : undefined,
    });
    await promise;
  }

  /** Detached plain projection; it does not read history, persist, or schedule. */
  presentationSnapshot(): PresentationSnapshot {
    const active = this.state.tasks.filter((task) => task.included);
    const done = active.filter((task) => task.status === "done").length;
    const kind = !active.length
      ? "empty"
      : this.state.capacity === "limit" ||
          this.state.scopeUnresolved ||
          this.state.pending?.block.present
        ? "previous"
        : "current";
    return {
      enabled: this.enabled,
      progress: {
        done,
        total: active.length,
        kind,
        ...(this.catchingUp ? { catchup: "Catching up history" as const } : {}),
      },
      ...(this.card
        ? {
            card: presentationCard(this.card, this.beads.get(this.card.taskId)),
          }
        : {}),
      activity: this.activity,
      service: this.service(),
      usage: {
        jev: copyUsage(this.usage.jev),
        extraction: copyUsage(this.usage.extraction),
      },
      ...(this.lastJevCallAt ? { lastJevCallAt: this.lastJevCallAt } : {}),
      ...(this.lastExtractionCallAt
        ? { lastExtractionCallAt: this.lastExtractionCallAt }
        : {}),
    };
  }

  /** Detached all-task board data; no history, persistence or provider capability. */
  boardSnapshot(): BoardSnapshot {
    return projectBoard({
      state: copyState(this.state),
      healthCards: new Map(
        [...this.healthCards].map(([taskId, card]) => [
          taskId,
          copyHealthCard(card),
        ]),
      ),
      taskDetails: new Map(
        [...this.detailValues].flatMap(([taskId, details]) => {
          const record = this.taskDetails.get(taskId);
          return record
            ? [
                [
                  taskId,
                  {
                    revision: record.revision,
                    label: record.label,
                    details: structuredClone(details),
                  } satisfies BoardDetailRecord,
                ] as const,
              ]
            : [];
        }),
      ),
      service: this.service(),
      unsettled:
        !!this.controlWork ||
        this.processing ||
        !!this.activeObservation ||
        !!this.queued.length ||
        !!this.state.pending ||
        this.state.scopeUnresolved,
      currentHealthTaskIds: new Set(this.currentHealthProofs.keys()),
      pendingHealthTaskIds: this.pendingHealthTaskIds(),
      lastDisplayedTaskId: this.idleDoneInvalidated
        ? undefined
        : this.lastDisplayedTaskId,
      activityFocusTaskId: this.currentActivityFocusTaskId(),
      activitySupersedesSemantic: this.activitySupersedesSemantic,
    });
  }

  /**
   * Detached semantic-settlement authority for advisory reconciliation. Optional
   * health, detail, activity, and Beads enrichment never affect readiness.
   */
  advisorySettlementSnapshot(): AdvisorySettlementSnapshot {
    const uncertainActivities = this.visibilityUncertainActivities();
    const subtasks = this.reconciliationSubtasks();
    return {
      enabled: this.enabled,
      reason: this.advisorySettlementReason(),
      tasks: this.state.tasks.flatMap((task) =>
        task.included
          ? [
              {
                id: task.id,
                label: task.label,
                status: task.status,
                included: true,
                revision: task.revision,
              },
            ]
          : [],
      ),
      ...(uncertainActivities.length ? { uncertainActivities } : {}),
      ...(subtasks.length ? { subtasks } : {}),
    };
  }

  /**
   * Detached canonical continuation evidence. This read never reuses the
   * correction window or schedules work; only the pure helper materializes it.
   */
  continuationAuthority(
    binding: ContinuationAuthorityBinding,
  ): ContinuationAuthorityProjection {
    let branch: readonly unknown[] = [];
    try {
      branch = this.reader ? this.reader() : [];
    } catch {
      // An unreadable active branch cannot establish a current receipt root.
    }
    return projectContinuationAuthority({
      ...binding,
      branch,
      tasks: this.state.tasks,
      events: this.state.events,
      ready: this.advisorySettlementReason() === "ready",
      ...(this.state.cursor ? { cursor: { ...this.state.cursor } } : {}),
    });
  }

  /**
   * Detached correction authority. It copies current included rows and bounded
   * canonical text already resident in memory; it never reopens branch history.
   */
  correctionSnapshot(): CorrectionSnapshot {
    const authority = this.correctionAuthority();
    const tasks: CorrectionTask[] = this.state.tasks.flatMap((task) => {
      if (!task.included) return [];
      const red = this.currentCorrectionFact(task);
      return [
        {
          id: task.id,
          label: task.label,
          revision: task.revision,
          included: true,
          status: task.status,
          ...(red ? { red } : {}),
        },
      ];
    });
    return {
      enabled: this.enabled,
      ready: this.advisorySettlementReason() === "ready",
      identity: createHash("sha256")
        .update(
          JSON.stringify({
            sourceId: this.state.sourceId,
            epoch: this.epoch,
            correctionEpoch: this.correctionEpoch,
            tasks: this.state.tasks
              .filter((task) => task.included)
              .map((task) => ({
                id: task.id,
                revision: task.revision,
                status: task.status,
                source: task.source,
                red: this.currentCorrectionFact(task),
              })),
            authority,
          }),
        )
        .digest("hex"),
      tasks,
      authority,
    };
  }

  observeCorrectionAttempt(
    attempt: CorrectionAttempt,
    source: CorrectionAttemptSource,
  ): Promise<void> {
    const generation = this.correctionActivityGeneration;
    this.correctionActive++;
    return this.correctionController.observe(attempt, source).finally(() => {
      if (generation !== this.correctionActivityGeneration) return;
      this.correctionActive = Math.max(0, this.correctionActive - 1);
      this.drainVisibility();
    });
  }

  /**
   * Read-only transport fence for a classifier result accepted in a prior turn.
   * It intentionally recomputes copied state rather than retaining a task pointer.
   */
  correctionIsCurrent(binding: CorrectionBinding): boolean {
    if (
      !binding ||
      typeof binding.attemptId !== "string" ||
      !binding.attemptId ||
      typeof binding.sourceRun !== "number" ||
      !Number.isSafeInteger(binding.sourceRun) ||
      binding.sourceRun <= 0 ||
      typeof binding.fingerprint !== "string" ||
      !binding.fingerprint
    )
      return false;
    const snapshot = this.correctionSnapshot();
    return (
      snapshot.enabled &&
      snapshot.ready &&
      snapshot.identity === binding.fingerprint
    );
  }

  /** External input/lifecycle boundaries revoke ephemeral action authority. */
  invalidateCorrections(): void {
    this.correctionEpoch++;
    this.correctionActivityGeneration++;
    this.correctionActive = 0;
    this.correctionFacts.clear();
    this.correctionController.dispose();
    this.correctionGateway.invalidate();
    this.correctionController = this.newCorrectionController();
  }

  /** Detached allowlisted diagnostics; intentionally excludes task/source/provider text. */
  debugSnapshot(): DebugSnapshot {
    return {
      enabled: this.enabled,
      processing:
        this.processing || this.healthFlight
          ? "processing"
          : this.waitingForWake
            ? "waiting"
            : "idle",
      service: this.service(),
      diagnostics: [...this.diagnostics].map(([code, count]) => ({
        code,
        label: diagnosticLabels[code] ?? "Progress monitor notice",
        count,
      })),
    };
  }

  private correctionAuthority(): CorrectionAuthority {
    const conversation = this.settledContext.map((observation) => ({
      role: observation.role,
      text: observation.text,
    }));
    const authority: CorrectionAuthority = {
      coverage: "complete",
      conversation,
    };
    return Buffer.byteLength(JSON.stringify(authority), "utf8") <= 4 * 1024
      ? authority
      : { coverage: "unknown", conversation: [] };
  }

  private currentCorrectionFact(
    task: HybridTask,
  ): CorrectionRedFact | undefined {
    const fact = this.correctionFacts.get(task.id);
    const job = this.healthJobs.get(task.id);
    const card = this.healthCards.get(task.id);
    if (
      !fact ||
      fact.epoch !== this.epoch ||
      fact.revision !== task.revision ||
      !sameSource(fact.taskSource, task.source) ||
      !job ||
      job.identity !== fact.healthIdentity ||
      job.successor ||
      !card ||
      card.taskId !== task.id ||
      card.revision !== task.revision ||
      !sameSource(card.provenance.taskSource, task.source) ||
      card.provenance.snapshotHash !== fact.snapshotHash
    )
      return;
    return {
      choice: fact.choice,
      confidence: fact.confidence,
      probability: fact.probability,
      revision: fact.revision,
    };
  }

  private newCorrectionController() {
    return new CorrectionController({
      snapshot: () => this.correctionSnapshot(),
      evaluate: (request) => this.evaluateCorrection(request),
      emit: (emission) => {
        if (!this.enabled) return;
        try {
          this.options.onCorrection?.({ ...emission });
        } catch {
          // Delivery is optional; controller result remains a safe abstention.
        }
      },
    });
  }

  private async evaluateCorrection(request: EvaluationRequest) {
    const epoch = this.epoch;
    const correctionEpoch = this.correctionEpoch;
    if (!this.enabled) return;
    // A prepared correction is mandatory advisory work. Abort optional stage 1/2
    // before its own dispatch; do not wait for visibility cancellation to settle.
    this.dropVisibilityFlight();
    try {
      const result = await this.correctionGateway.evaluate(
        request,
        this.identity(),
        true,
      );
      if (
        !result ||
        !this.enabled ||
        epoch !== this.epoch ||
        correctionEpoch !== this.correctionEpoch
      )
        return;
      this.usage.jev.inputTokens = saturatingAdd(
        this.usage.jev.inputTokens,
        result.usage.input_tokens,
      );
      this.usage.jev.outputTokens = saturatingAdd(
        this.usage.jev.outputTokens,
        result.usage.output_tokens,
      );
      this.save();
      this.publish();
      return result;
    } catch {
      return;
    }
  }

  private acceptCorrectionFact(
    task: HybridTask,
    work: HealthWork,
    flight: HealthFlight,
    snapshotIdentity: string,
    answer: ValidatedResult["answers"][string] | undefined,
  ) {
    if (!this.healthFlightCurrent(flight, work)) return;
    this.correctionFacts.delete(task.id);
    const probability =
      answer?.type === "choice"
        ? answer.probabilities[answer.choice]
        : undefined;
    if (
      answer?.type !== "choice" ||
      answer.choice !== "not-needed" ||
      answer.confidence < 0.5 ||
      probability === undefined ||
      probability < 0.8
    )
      return;
    if (
      !this.correctionFacts.has(task.id) &&
      this.correctionFacts.size >= MAX_CORRECTION_FACTS
    )
      return;
    this.correctionFacts.set(task.id, {
      choice: answer.choice,
      confidence: answer.confidence,
      probability,
      revision: task.revision,
      epoch: this.epoch,
      taskSource: { ...task.source },
      healthIdentity: this.healthWorkIdentity(work),
      snapshotHash: sha256(snapshotIdentity),
    });
  }

  private advisorySettlementReason(): AdvisorySettlementReason {
    if (!this.enabled) return "disabled";
    if (this.controlWork || this.pendingScan || this.canonicalWakeTimer)
      return "canonical-scan";
    if (this.activeObservation || this.processing) return "active-observation";
    if (this.state.pending) return "pending-journal";
    if (this.retryTimer || this.retryObservation) return "retry-timer";
    if (this.queued.length) return "queued-observation";
    if (this.waitingForWake) return "model-wait";
    if (this.state.scopeUnresolved) return "unresolved";
    if (this.state.capacity === "limit") return "capacity";
    if (this.blockedPending) return "blocked";
    return "ready";
  }

  private identity() {
    return `${this.state.sourceId}:${this.epoch}`;
  }

  /** Only canonical boundary factory reads host history. */
  private beginCanonicalPass() {
    return new CanonicalPass(this.reader ? this.reader() : []);
  }

  /** Clear runtime page/context state without canceling an in-progress control. */
  private clearRuntimeContext() {
    if (this.canonicalWakeTimer) clearTimeout(this.canonicalWakeTimer);
    this.canonicalWakeTimer = undefined;
    this.page = [];
    this.pageBytes = 0;
    this.pageFrontier = undefined;
    this.settledContext = [];
    this.pendingScan = undefined;
    this.settleActiveAuthority(this.activeObservation);
  }

  /** Semantic authority resets on amendment; billing lifetime resets only by source. */
  private resetState(
    sourceId: string,
    resetTelemetry = true,
    retainedSubtasks?: SubtaskRuntimeCheckpoint,
  ) {
    const sourceChanged = sourceId !== this.state.sourceId;
    const subtasks = resetTelemetry
      ? undefined
      : (retainedSubtasks ?? this.retiredSubtaskCheckpoint());
    this.invalidateCorrections();
    this.replaceSubtaskRuntime(subtasks);
    this.state = emptyState(sourceId);
    this.resetCoverageAdapter();
    this.card = undefined;
    this.healthCards.clear();
    this.taskDetails.clear();
    this.detailValues.clear();
    this.parkedDetails.clear();
    this.detailFlight = undefined;
    this.detailGateway.invalidate();
    this.currentHealthProofs.clear();
    this.lastDisplayedTaskId = undefined;
    this.idleDoneInvalidated = false;
    this.clearRuntimeContext();
    this.queued = [];
    this.healthJobs.clear();
    this.clearActivity(false);
    this.blockedPending = undefined;
    this.activeObservation = undefined;
    this.catchingUp = false;
    this.catchupTarget = undefined;
    this.latchHistoricalCatchup = false;
    this.evidence.reset();
    this.beads.clear();
    this.beadsGeneration++;
    if (sourceChanged) {
      this.subtaskOmissions = undefined;
      this.savingRestoredSubtaskHistory = undefined;
      this.restoredSubtaskHistoryFloor = undefined;
    }
    if (!resetTelemetry) return;
    this.lastJevCallAt = undefined;
    this.lastExtractionCallAt = undefined;
    this.usage.jev.calls = 0;
    this.usage.jev.inputTokens = 0;
    this.usage.jev.outputTokens = 0;
    this.usage.extraction.calls = 0;
    this.usage.extraction.inputTokens = 0;
    this.usage.extraction.outputTokens = 0;
  }

  /** Reject only persisted shape; canonical amendments remain normal restore reconciliation. */
  private rejectStoredCheckpoint(
    sourceId: string,
    kind: "unsupported" | "corrupt",
  ) {
    this.disableRuntime();
    this.resetState(sourceId);
    this.restoreRejection = kind;
    this.error = rejectedStorageMessage(kind);
    this.waitingForWake = false;
    this.publish();
  }

  private prospectiveIdleDoneTaskIdFor(state: HybridState) {
    const included = state.tasks.filter((task) => task.included);
    if (!included.length || !included.every((task) => task.status === "done"))
      return;
    const currentFocus = this.openFocus(state)?.id;
    const taskId = this.lastDisplayedTaskId ?? currentFocus;
    return included.some((task) => task.id === taskId) ? taskId : undefined;
  }

  private idleDoneTaskIdFor(
    state: HybridState,
    prospectiveIdleDoneTaskId?: string,
  ) {
    const taskId =
      prospectiveIdleDoneTaskId ??
      (!this.idleDoneInvalidated ? this.lastDisplayedTaskId : undefined);
    return state.tasks.some(
      (task) => task.id === taskId && task.included && task.status === "done",
    )
      ? taskId
      : undefined;
  }

  private stagedRestoredSubtaskHistory() {
    for (const candidate of [
      this.savingRestoredSubtaskHistory,
      this.restoredSubtaskHistoryFloor,
    ])
      if (
        candidate &&
        // A resumed outer callback must not mask newer completed history.
        candidate.serial >= this.latestRestoredSubtaskHistorySerial &&
        candidate.sourceId === this.state.sourceId &&
        candidate.sourceId === this.options.sourceId()
      )
        return candidate;
  }

  /** Reentrant OFF/restore writes retain only same-source saved candidates. */
  private durableSubtaskOmissions() {
    const restored = this.stagedRestoredSubtaskHistory();
    const prior = restored?.subtaskOmissions
      ? mergeSubtaskOmissions(this.subtaskOmissions, restored.subtaskOmissions)
          .summary
      : this.subtaskOmissions;
    const saving = this.savingSubtaskOmissionSummary;
    return saving &&
      saving.sourceId === this.state.sourceId &&
      saving.sourceId === this.options.sourceId()
      ? mergeSubtaskOmissions(prior, saving.summary).summary
      : prior;
  }

  /** Strict-v11 monitor projection includes only live generic sidecar state. */
  private subtaskMetadata(
    enabled = this.enabled,
    healthCards: ReadonlyMap<string, HealthCard> = this.healthCards,
    state: HybridState = this.state,
    prospectiveIdleDoneTaskId?: string,
    taskDetails: ReadonlyMap<string, TaskDetailRecord> = this.taskDetails,
    runtimeCheckpoint:
      | Readonly<SubtaskRuntimeCheckpoint>
      | undefined = this.authoritativeSubtaskCheckpoint(),
    subtaskOmissions: Readonly<SubtaskOmissionSummary> | undefined = this
      .subtaskOmissions,
  ) {
    const idleDoneTaskId = this.idleDoneTaskIdFor(
      state,
      prospectiveIdleDoneTaskId,
    );
    const component = runtimeCheckpoint
      ? {
          state: structuredClone(runtimeCheckpoint.state),
          journal: structuredClone(runtimeCheckpoint.journal),
        }
      : undefined;
    const hasSubtasks =
      !!component &&
      (component.state.groups.length > 0 ||
        component.state.nextGroupId !== 1 ||
        component.state.nextChildId !== 1 ||
        component.journal.dispatches > 0 ||
        component.journal.records.length > 0 ||
        component.journal.reports.length > 0);
    return {
      enabled,
      usage: {
        jev: validUsage(this.usage.jev),
        extraction: validUsage(this.usage.extraction),
      },
      ...(this.lastJevCallAt ? { lastJevCallAt: this.lastJevCallAt } : {}),
      ...(this.lastExtractionCallAt
        ? { lastExtractionCallAt: this.lastExtractionCallAt }
        : {}),
      ...(idleDoneTaskId ? { idleDoneTaskId } : {}),
      ...(healthCards.size
        ? { healthCards: [...healthCards.values()].map(copyHealthCard) }
        : {}),
      ...(this.options.richDetailsEnabled && taskDetails.size
        ? { taskDetails: [...taskDetails.values()].map(copyDetailRecord) }
        : {}),
      ...(hasSubtasks ? { subtasks: component } : {}),
      ...(subtaskOmissions === undefined
        ? {}
        : { subtaskOmissions: structuredClone(subtaskOmissions) }),
    };
  }

  /** Every new durable semantic state must also support durable OFF control. */
  private falseProjectionFits(state = this.state) {
    try {
      encodeSubtaskCheckpoint(
        state,
        this.subtaskMetadata(
          false,
          this.healthCards,
          state,
          undefined,
          this.taskDetails,
          this.authoritativeSubtaskCheckpoint(),
          this.durableSubtaskOmissions(),
        ),
      );
      return true;
    } catch {
      return false;
    }
  }

  private emptySubtaskCheckpoint(): SubtaskRuntimeCheckpoint {
    return {
      state: new SubtaskStore().checkpoint(),
      journal: {
        version: 1,
        dispatches: 0,
        usage: {
          jev: { calls: 0, inputTokens: 0, outputTokens: 0 },
          extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
        },
        records: [],
        reports: [],
      },
    };
  }

  private hasSubtaskCheckpointData(
    checkpoint: Readonly<SubtaskRuntimeCheckpoint>,
  ) {
    return (
      checkpoint.state.groups.length > 0 ||
      checkpoint.state.nextGroupId !== 1 ||
      checkpoint.state.nextChildId !== 1 ||
      checkpoint.journal.dispatches > 0 ||
      checkpoint.journal.records.length > 0 ||
      checkpoint.journal.reports.length > 0
    );
  }

  /** Pending or saved same-source history is the floor until control adoption. */
  private authoritativeSubtaskCheckpoint(): SubtaskRuntimeCheckpoint {
    return structuredClone(
      this.stagedRestoredSubtaskHistory()?.component ??
        this.pendingSubtaskCheckpoint ??
        this.subtaskRuntime?.checkpoint() ??
        this.emptySubtaskCheckpoint(),
    );
  }

  /** Retire semantic authority while retaining validated lifetime history. */
  private retiredSubtaskCheckpoint(
    checkpoint = this.authoritativeSubtaskCheckpoint(),
  ): SubtaskRuntimeCheckpoint {
    const journal = restoreSubtaskJournal(
      checkpoint.journal,
      () => false,
      () => false,
    );
    if (!journal)
      throw new Error("Validated subtask history could not be retired");
    return {
      state: { ...structuredClone(checkpoint.state), groups: [] },
      journal,
    };
  }

  /** Install only after prior runtime flight drains; no coordinator overlap. */
  private installSubtaskRuntime(
    initial: SubtaskRuntimeCheckpoint,
    preserveProjection = false,
    capturedCurrent: SubtaskRuntimeCurrent | null | undefined = undefined,
    capturedCurrentRevoke?: () => void,
  ) {
    this.pendingSubtaskCheckpoint = undefined;
    this.pendingSubtaskCurrent = undefined;
    this.pendingSubtaskCurrentRevoke = undefined;
    this.capturedSubtaskCurrentRevoke?.();
    this.capturedSubtaskCurrent = capturedCurrent;
    this.capturedSubtaskCurrentRevoke = capturedCurrentRevoke;
    if (!preserveProjection) this.subtaskProjection = undefined;
    this.subtaskRuntime = new SubtaskRuntime({
      initial: structuredClone(initial),
      current: () => {
        const captured = this.capturedSubtaskCurrent;
        if (captured === null) return;
        return captured === undefined
          ? this.subtaskCurrent(this.state)
          : captured;
      },
      reportCurrent: () => {
        const captured = this.capturedSubtaskCurrent;
        if (captured === null) return;
        return captured === undefined
          ? this.subtaskReportCurrent(this.state)
          : captured;
      },
      gate: (batch, signal, onDispatch, onPhysicalFlight) =>
        this.evaluateSubtaskGate(batch, signal, onDispatch, onPhysicalFlight),
      propose: (request, signal, onDispatch, onPhysicalFlight) => {
        const propose = this.options.proposeSubtasks;
        return propose
          ? propose(
              request,
              signal,
              (at) => onDispatch(at) === true,
              onPhysicalFlight,
            )
          : Promise.resolve(undefined);
      },
      report: (batch, signal, onDispatch, onPhysicalFlight) =>
        this.evaluateSubtaskReport(batch, signal, onDispatch, onPhysicalFlight),
      canCommit: (candidate, reserve) =>
        this.canCommitSubtaskReport(candidate, reserve),
      onReportCapacityRefusal: ({ group, parent, source, sourceId }) => {
        this.recordSubtaskReportOmission(
          group,
          parent,
          source,
          sourceId,
          "capacity",
        );
      },
      now: () => Date.now(),
      commit: (candidate) => this.commitSubtaskCandidate(candidate),
      onPublish: (snapshot) => {
        if (!this.pendingSubtaskCheckpoint)
          this.subtaskProjection = structuredClone(snapshot);
        this.publish();
      },
    });
  }

  /** Fence old transport first; replacement waits for its runtime reservation. */
  private replaceSubtaskRuntime(checkpoint?: SubtaskRuntimeCheckpoint) {
    const next = structuredClone(checkpoint ?? this.emptySubtaskCheckpoint());
    this.subtaskRuntime?.resetAccess();
    this.subtaskRuntime?.invalidate();
    this.subtaskGatewayResetAfterReportDrain = false;
    this.subtaskGateway.invalidate();
    this.subtaskGateDispatch = undefined;
    this.subtaskOwners = [];
    this.subtaskReportOwners = [];
    this.subtaskProjection = undefined;
    this.subtaskReportCandidates.clear();
    this.subtaskOversizedReportParents.clear();
    this.subtaskReportBlocked.clear();
    this.subtaskReportFrontiers.clear();
    this.subtaskActiveReportParents.clear();
    this.subtaskDiagnosticAuthority = undefined;
    this.subtaskScheduleGeneration += 1;
    this.subtaskWakeKey = undefined;
    this.capturedSubtaskCurrentRevoke?.();
    this.capturedSubtaskCurrentRevoke = undefined;
    this.capturedSubtaskCurrent = null;
    this.pendingSubtaskCurrentRevoke?.();
    this.pendingSubtaskCurrentRevoke = undefined;
    this.pendingSubtaskCurrent = null;
    if (this.subtaskFlight) {
      this.pendingSubtaskCheckpoint = next;
      return;
    }
    this.installSubtaskRuntime(next);
  }

  private subtaskIdentity() {
    return `${this.state.sourceId}:${this.epoch}:subtasks`;
  }

  /** Complete bounded canonical context, read only after mandatory settlement. */
  private subtaskCurrent(
    state: HybridState,
    pass = this.beginCanonicalPass(),
    restoring = false,
    requireSelectedModel = false,
    allowOversizedLatest = false,
  ): SubtaskRuntimeCurrent | undefined {
    if (
      !restoring &&
      (!this.enabled ||
        this.processing ||
        this.queued.length > 0 ||
        !!this.state.pending ||
        (!allowOversizedLatest && this.state.scopeUnresolved))
    )
      return;
    let selectedModel: string | undefined;
    try {
      selectedModel = this.options.selectedModel?.();
    } catch {
      // Reports use canonical Jev authority only; proposal capability is optional.
    }
    if (typeof selectedModel !== "string" || !selectedModel)
      selectedModel = undefined;
    if (requireSelectedModel && !selectedModel) return;
    const cursor = state.cursor;
    if (!cursor) return;
    const latest = pass.observation(cursor.id);
    if (
      !latest ||
      latest.hash !== cursor.hash ||
      latest.role !== cursor.role ||
      (!allowOversizedLatest &&
        Buffer.byteLength(latest.text, "utf8") > 12 * 1024)
    )
      return;

    let evidence: SubtaskEvidence | undefined;
    if (!restoring) {
      try {
        // Capability must come from a fresh confirmation of this exact active
        // canonical branch, never listener payloads or stored adapter state.
        this.coverageAdapter.confirm(pass.entries, this.coverageAdapterEpoch);
        const confirmed = this.coverageAdapter.metadata();
        if (!confirmed) this.subtaskEvidence = undefined;
        else if (
          !this.subtaskEvidence ||
          !isCurrentSubtaskEvidence(this.subtaskEvidence)
        )
          this.subtaskEvidence = confirmed;
        evidence = this.subtaskEvidence;
      } catch {
        this.subtaskEvidence = undefined;
        // No-file generic work remains eligible if optional adapter fails closed.
      }
    }

    const earlier: Observation[] = [];
    const omissions: string[] = [];
    const latestIndex = pass.indexOf(latest.id);
    let index = latestIndex - 1;
    let inspected = 0;
    while (
      index >= 0 &&
      earlier.length < 16 &&
      inspected < MAX_SUBTASK_CONTEXT_CANDIDATES
    ) {
      const header = pass.headers[index--];
      inspected += 1;
      if (!header) continue;
      const observation = pass.observation(header.id);
      if (!observation) continue;
      const candidate = [observation, ...earlier];
      if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > 12 * 1024) {
        omissions.push(
          "Older canonical observations omitted because full bounded context exceeded 12 KiB",
        );
        break;
      }
      earlier.unshift({ ...observation });
    }
    if (index >= 0)
      omissions.push(
        earlier.length >= 16
          ? "Older canonical observations omitted after 16 retained observations"
          : "Older canonical observations omitted after bounded candidate discovery",
      );
    return {
      sourceId: state.sourceId,
      enabled: restoring ? true : this.enabled,
      parents: copyState(state).tasks,
      latest: { ...latest },
      earlier,
      omissions,
      selectedModel,
      ...(evidence === undefined ? {} : { evidence }),
      resolve: (entryId) => {
        const observation = pass.observation(entryId);
        return observation ? { ...observation } : undefined;
      },
    };
  }

  /** Saved report authority may resolve its original bounded source after C grows. */
  private subtaskReportCurrent(
    state: HybridState,
    pass = this.beginCanonicalPass(),
    restoring = false,
  ) {
    const generic = this.subtaskCurrent(state, pass, restoring);
    if (generic) return generic;
    const cursor = state.cursor;
    const latest = cursor ? pass.observation(cursor.id) : undefined;
    if (
      !latest ||
      (!state.scopeUnresolved &&
        Buffer.byteLength(latest.text, "utf8") <= 12 * 1024)
    )
      return;
    return this.subtaskCurrent(state, pass, restoring, false, true);
  }

  /** Only an oversized latest report preserves report transport through generic invalidation. */
  private preserveOversizedReportFlight(pass: CanonicalPass) {
    const latest = pass.headers.at(-1);
    const observation = latest ? pass.observation(latest.id) : undefined;
    return (
      !!observation && Buffer.byteLength(observation.text, "utf8") > 12 * 1024
    );
  }

  /** Restore callback uses only validated detached candidate state/group. */
  private subtaskRestoreCurrent(
    record: SubtaskPhaseRecord,
    candidate: SubtaskRestoreContext,
    pass: CanonicalPass,
  ) {
    const current = this.subtaskCurrent(candidate.state, pass, true);
    return (
      !!current && subtaskRuntimeRecordIsCurrent(record, current, candidate)
    );
  }

  /** Report restore uses detached envelope authority, never prior live state. */
  private subtaskRestoreReportCurrent(
    report: SubtaskReportJob,
    candidate: SubtaskRestoreContext,
    pass: CanonicalPass,
  ) {
    const current = this.subtaskReportCurrent(candidate.state, pass, true);
    return (
      !!current && subtaskRuntimeReportIsCurrent(report, current, candidate)
    );
  }

  /** Apply current target authority only after pure cumulative history merge. */
  private normalizeRestoredSubtaskHistory(
    component: Readonly<SubtaskRuntimeCheckpoint>,
    state: HybridState,
    pass: CanonicalPass,
  ): SubtaskRuntimeCheckpoint | undefined {
    const current = this.subtaskCurrent(state, pass, true);
    const reportCurrent = this.subtaskReportCurrent(state, pass, true);
    const store = reportCurrent
      ? this.restoreSubtaskStore(component, reportCurrent)
      : undefined;
    const groups = new Map(
      (store?.snapshot().groups ?? []).map((group) => [
        group.parentTaskId,
        group,
      ]),
    );
    const journal = restoreSubtaskJournal(
      component.journal,
      (record) => {
        if (!current) return false;
        const group = groups.get(record.parentTaskId);
        return this.subtaskRestoreCurrent(
          record,
          { state, ...(group === undefined ? {} : { group }) },
          pass,
        );
      },
      (report) => {
        if (!reportCurrent) return false;
        const group = groups.get(report.parentTaskId);
        return this.subtaskRestoreReportCurrent(
          report,
          { state, ...(group === undefined ? {} : { group }) },
          pass,
        );
      },
    );
    return journal
      ? { state: structuredClone(component.state), journal }
      : undefined;
  }

  /** Merge original incoming proof against canonical target without live groups. */
  private mergedRestoredSubtaskHistory(
    live: Readonly<SubtaskRuntimeCheckpoint>,
    incoming: Readonly<SubtaskRuntimeCheckpoint>,
    targetStore: Readonly<SubtaskRuntimeCheckpoint["state"]>,
    state: HybridState,
    pass: CanonicalPass,
  ): SubtaskRuntimeCheckpoint | undefined {
    const merged = mergeSubtaskRestoreHistory({
      live,
      incoming,
      targetStore,
    });
    return merged.kind === "merged"
      ? this.normalizeRestoredSubtaskHistory(merged.component, state, pass)
      : undefined;
  }

  /** Same-source restore retains live diagnostics before durable target history. */
  private restoredSubtaskOmissions(work: ControlWork) {
    return mergeSubtaskOmissions(
      work.sourceId === work.telemetry.sourceId
        ? work.liveSubtaskOmissions
        : undefined,
      work.subtaskMetadata?.subtaskOmissions,
    ).summary;
  }

  /** A reentrant control/source change invalidates an older saved candidate. */
  private restoredWorkIsCurrent(work: ControlWork) {
    return (
      this.controlWork === work && this.options.sourceId() === work.sourceId
    );
  }

  /** Build detached target metadata before persistence or live metadata adoption. */
  private restoredSubtaskMetadata(
    metadata: SubtaskMonitorCheckpointMetadata | undefined,
    component: Readonly<SubtaskRuntimeCheckpoint>,
    enabled: boolean,
    work: ControlWork,
    state: HybridState,
    pass: CanonicalPass,
    subtaskOmissions: Readonly<SubtaskOmissionSummary> | undefined,
  ): SubtaskMonitorCheckpointMetadata {
    const base: SubtaskMonitorCheckpointMetadata = metadata
      ? structuredClone(metadata)
      : {
          enabled,
          usage: {
            jev: { calls: 0, inputTokens: 0, outputTokens: 0 },
            extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
          },
        };
    const preserveTelemetry =
      work.preserveControls && work.sourceId === work.telemetry.sourceId;
    const usage = preserveTelemetry
      ? {
          jev: {
            calls: Math.max(
              base.usage.jev.calls,
              work.telemetry.usage.jev.calls,
            ),
            inputTokens: Math.max(
              base.usage.jev.inputTokens,
              work.telemetry.usage.jev.inputTokens,
            ),
            outputTokens: Math.max(
              base.usage.jev.outputTokens,
              work.telemetry.usage.jev.outputTokens,
            ),
          },
          extraction: {
            calls: Math.max(
              base.usage.extraction.calls,
              work.telemetry.usage.extraction.calls,
            ),
            inputTokens: Math.max(
              base.usage.extraction.inputTokens,
              work.telemetry.usage.extraction.inputTokens,
            ),
            outputTokens: Math.max(
              base.usage.extraction.outputTokens,
              work.telemetry.usage.extraction.outputTokens,
            ),
          },
        }
      : base.usage;
    const lastJevCallAt = preserveTelemetry
      ? Math.max(base.lastJevCallAt ?? 0, work.telemetry.lastJevCallAt ?? 0) ||
        undefined
      : base.lastJevCallAt;
    const lastExtractionCallAt = preserveTelemetry
      ? Math.max(
          base.lastExtractionCallAt ?? 0,
          work.telemetry.lastExtractionCallAt ?? 0,
        ) || undefined
      : base.lastExtractionCallAt;
    const healthCards = (base.healthCards ?? [])
      .filter((card) => this.healthCardMatchesCanonical(card, pass, state))
      .map(copyHealthCard);
    const taskDetails = this.options.richDetailsEnabled
      ? ((base.taskDetails ?? []) as TaskDetailRecord[])
          .filter((detail) =>
            this.detailRecordMatchesCanonical(detail, pass, state),
          )
          .map(copyDetailRecord)
      : [];
    const idleDoneTaskId = base.idleDoneTaskId;
    const retainsIdleDone = state.tasks.some(
      (task) =>
        task.id === idleDoneTaskId && task.included && task.status === "done",
    );
    const hasSubtasks = this.hasSubtaskCheckpointData(component);
    const {
      healthCards: _healthCards,
      taskDetails: _taskDetails,
      idleDoneTaskId: _idleDoneTaskId,
      subtaskOmissions: _subtaskOmissions,
      ...normalized
    } = base;
    return {
      ...normalized,
      enabled,
      usage,
      ...(lastJevCallAt === undefined ? {} : { lastJevCallAt }),
      ...(lastExtractionCallAt === undefined ? {} : { lastExtractionCallAt }),
      ...(healthCards.length ? { healthCards } : {}),
      ...(taskDetails.length ? { taskDetails } : {}),
      ...(retainsIdleDone && idleDoneTaskId ? { idleDoneTaskId } : {}),
      ...(hasSubtasks ? { subtasks: structuredClone(component) } : {}),
      ...(subtaskOmissions === undefined
        ? {}
        : { subtaskOmissions: structuredClone(subtaskOmissions) }),
    };
  }

  /** Canonical reset keeps only nonsemantic strict-v11 fields plus history. */
  private resetSubtaskMetadata(
    metadata: SubtaskMonitorCheckpointMetadata | undefined,
  ): SubtaskMonitorCheckpointMetadata | undefined {
    if (!metadata) return;
    return {
      enabled: metadata.enabled,
      usage: structuredClone(metadata.usage),
      ...(metadata.subtaskOmissions === undefined
        ? {}
        : { subtaskOmissions: structuredClone(metadata.subtaskOmissions) }),
    };
  }

  /** Preflight and stage full history so nested same-source controls retain it. */
  private commitRestoredSubtaskHistory(
    state: HybridState,
    metadata: SubtaskMonitorCheckpointMetadata,
    component: Readonly<SubtaskRuntimeCheckpoint>,
  ): StagedRestoredSubtaskHistory | undefined {
    if (!canCommitSubtaskCheckpoint(state, metadata)) return;
    const staged: StagedRestoredSubtaskHistory = {
      sourceId: state.sourceId,
      serial: ++this.nextRestoredSubtaskHistorySerial,
      component: structuredClone(component),
      ...(metadata.subtaskOmissions === undefined
        ? {}
        : { subtaskOmissions: structuredClone(metadata.subtaskOmissions) }),
    };
    const prior = this.savingRestoredSubtaskHistory;
    this.savingRestoredSubtaskHistory = staged;
    let saved: ReturnType<typeof commitSubtaskCheckpoint>;
    try {
      saved = commitSubtaskCheckpoint(state, metadata, (checkpoint) => {
        this.persist(checkpoint);
        return true;
      });
    } finally {
      if (this.savingRestoredSubtaskHistory === staged)
        this.savingRestoredSubtaskHistory = prior;
    }
    if (!saved) return;
    this.rememberSavedSubtaskHistory(staged);
    return staged;
  }

  /** Retain only newer, same-source history after its synchronous save succeeds. */
  private rememberSavedSubtaskHistory(staged: StagedRestoredSubtaskHistory) {
    if (staged.serial <= this.latestRestoredSubtaskHistorySerial) return;
    this.latestRestoredSubtaskHistorySerial = staged.serial;
    if (
      staged.sourceId === this.state.sourceId &&
      staged.sourceId === this.options.sourceId()
    ) {
      this.restoredSubtaskHistoryFloor = staged;
      this.subtaskOmissions = mergeSubtaskOmissions(
        this.subtaskOmissions,
        staged.subtaskOmissions,
      ).summary;
    }
  }

  /** A current control installs its staged history; stale work leaves no queue. */
  private adoptRestoredSubtaskHistory(staged: StagedRestoredSubtaskHistory) {
    const floor = this.restoredSubtaskHistoryFloor;
    if (floor?.sourceId === staged.sourceId && floor.serial === staged.serial)
      this.restoredSubtaskHistoryFloor = undefined;
  }

  /** Plain ON consumes saved history before its runtime may charge new work. */
  private adoptSavedSubtaskHistoryForEnable(
    work: ControlWork,
    pass: CanonicalPass,
  ) {
    const floor = this.stagedRestoredSubtaskHistory();
    if (
      !floor ||
      floor.serial < this.latestRestoredSubtaskHistorySerial ||
      floor.sourceId !== work.sourceId ||
      floor.sourceId !== this.state.sourceId ||
      floor.sourceId !== this.options.sourceId()
    )
      return true;
    const live = work.liveSubtasks;
    const current = structuredClone(
      this.pendingSubtaskCheckpoint ??
        this.subtaskRuntime?.checkpoint() ??
        this.emptySubtaskCheckpoint(),
    );
    const component =
      live &&
      this.mergedRestoredSubtaskHistory(
        live,
        current,
        current.state,
        this.state,
        pass,
      );
    if (!component) {
      this.refuseRestoredSubtaskHistory(work);
      return false;
    }
    const omissions = this.durableSubtaskOmissions();
    const metadata = this.subtaskMetadata(
      work.wantEnabled,
      this.healthCards,
      this.state,
      undefined,
      this.taskDetails,
      component,
      omissions,
    );
    const saved = this.commitRestoredSubtaskHistory(
      this.state,
      metadata,
      component,
    );
    if (!saved) {
      this.refuseRestoredSubtaskHistory(work);
      return false;
    }
    if (!this.restoredWorkIsCurrent(work)) return false;
    this.replaceSubtaskRuntime(component);
    this.hydrateSubtaskProjection(pass, component);
    this.captureSubtaskDiagnosticAuthoritySafely(component, () =>
      this.subtaskCurrent(this.state, pass, true),
    );
    this.adoptRestoredSubtaskHistory(saved);
    this.subtaskOmissions = omissions;
    this.latchHistoricalCatchup = true;
    work.persisted = metadata.enabled === work.wantEnabled;
    return true;
  }

  /** Refusal remains locally OFF with prior state/history and no fallback write. */
  private refuseRestoredSubtaskHistory(work: ControlWork) {
    this.note("saved-state-rejected");
    this.controlWork = undefined;
    this.finishControl(work);
    this.publish();
  }

  /** Report preflight shares real v11 component and ON/OFF envelope limits. */
  private canCommitSubtaskReport(
    candidate: SubtaskRuntimeCheckpoint,
    reserve: { storeBytes: number; journalBytes: number },
  ): true | "capacity" | false {
    try {
      return canCommitSubtaskCheckpoint(
        this.state,
        this.subtaskMetadata(
          this.enabled,
          this.healthCards,
          this.state,
          undefined,
          this.taskDetails,
          candidate,
        ),
        reserve,
      )
        ? true
        : "capacity";
    } catch {
      return false;
    }
  }

  /** Runtime candidate overlays strict-v11 metadata without swapping live state. */
  private commitSubtaskCandidate(candidate: SubtaskRuntimeCheckpoint): boolean {
    const metadata = this.subtaskMetadata(
      this.enabled,
      this.healthCards,
      this.state,
      undefined,
      this.taskDetails,
      candidate,
      this.durableSubtaskOmissions(),
    );
    const staged: StagedRestoredSubtaskHistory = {
      sourceId: this.state.sourceId,
      serial: ++this.nextRestoredSubtaskHistorySerial,
      component: structuredClone(candidate),
      ...(metadata.subtaskOmissions === undefined
        ? {}
        : { subtaskOmissions: structuredClone(metadata.subtaskOmissions) }),
    };
    const prior = this.savingRestoredSubtaskHistory;
    const runtime = this.subtaskRuntime;
    this.savingRestoredSubtaskHistory = staged;
    let saved: ReturnType<typeof commitSubtaskCheckpoint>;
    try {
      saved = commitSubtaskCheckpoint(this.state, metadata, (checkpoint) => {
        this.persist(checkpoint);
        return true;
      });
    } finally {
      if (this.savingRestoredSubtaskHistory === staged)
        this.savingRestoredSubtaskHistory = prior;
    }
    if (saved === undefined) return false;
    if (
      !this.enabled ||
      this.controlWork !== undefined ||
      this.subtaskRuntime !== runtime
    )
      this.rememberSavedSubtaskHistory(staged);
    const current = this.capturedSubtaskCurrent;
    if (current === null) return true;
    this.captureSubtaskDiagnosticAuthoritySafely(candidate, () =>
      current === undefined
        ? this.subtaskCurrent(this.state, this.beginCanonicalPass())
        : current,
    );
    return true;
  }

  private async evaluateSubtaskGate(
    batch: SubtaskGateBatch,
    signal: AbortSignal,
    onDispatch: (at: number) => boolean,
    onPhysicalFlight: SubtaskPhysicalFlightObserver,
  ): Promise<ValidatedResult | undefined> {
    if (!this.enabled || signal.aborted || this.subtaskGateway.isPaused) return;
    const dispatch = onDispatch;
    this.subtaskGateDispatch = dispatch;
    this.subtaskPhysicalFlight = onPhysicalFlight;
    const abort = () => this.subtaskGateway.invalidate();
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await this.subtaskGateway.evaluate(
        batch.request,
        this.subtaskIdentity(),
        true,
      );
    } finally {
      signal.removeEventListener("abort", abort);
      if (this.subtaskGateDispatch === dispatch)
        this.subtaskGateDispatch = undefined;
      if (this.subtaskPhysicalFlight === onPhysicalFlight)
        this.subtaskPhysicalFlight = undefined;
    }
  }

  private async evaluateSubtaskReport(
    batch: SubtaskReportBatch,
    signal: AbortSignal,
    onDispatch: (at: number) => boolean,
    onPhysicalFlight: SubtaskPhysicalFlightObserver,
  ) {
    if (!this.enabled || signal.aborted || this.subtaskGateway.isPaused)
      return { kind: "unavailable" } as const;
    const dispatch = onDispatch;
    this.subtaskGateDispatch = dispatch;
    this.subtaskPhysicalFlight = onPhysicalFlight;
    const abort = () => this.subtaskGateway.invalidate();
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await this.subtaskGateway.evaluateWithOutcome(
        batch.request,
        this.subtaskIdentity(),
        true,
      );
    } catch {
      return { kind: "failed" } as const;
    } finally {
      signal.removeEventListener("abort", abort);
      if (this.subtaskGateDispatch === dispatch)
        this.subtaskGateDispatch = undefined;
      if (this.subtaskPhysicalFlight === onPhysicalFlight)
        this.subtaskPhysicalFlight = undefined;
    }
  }

  private reportSource(observation: Observation): SourceRef {
    return {
      entryId: observation.id,
      messageHash: observation.hash,
      role: observation.role,
      start: 0,
      end: observation.text.length,
      quoteHash: sha256(observation.text),
    };
  }

  private reportJobForParent(
    runtime: SubtaskRuntime,
    parentTaskId: string,
  ): SubtaskReportJob | undefined {
    return runtime
      .checkpoint()
      .journal.reports.find(
        (report) =>
          report.parentTaskId === parentTaskId &&
          report.state !== "complete" &&
          report.state !== "superseded",
      );
  }

  private reportDecidedIds(job: SubtaskReportJob | undefined): Set<string> {
    const decided = new Set<string>();
    for (const attempt of job?.attempts ?? [])
      if (attempt.outcome === "decided")
        for (const assessment of attempt.assessments ?? [])
          decided.add(assessment.childId);
    return decided;
  }

  private enqueueSubtaskReport(parentTaskId: string, source?: SourceRef) {
    const index = this.subtaskReportOwners.findIndex(
      (owner) => owner.parentTaskId === parentTaskId,
    );
    if (index >= 0) {
      const owner = this.subtaskReportOwners[index];
      if (!owner) return;
      // Saved authority always wins over an unassessed newer candidate.
      if (!owner.source || !source) owner.source = undefined;
      else owner.source = { ...source };
      return;
    }
    if (this.subtaskReportOwners.length >= 20) return;
    this.subtaskReportOwners.push({
      parentTaskId,
      ...(source === undefined ? {} : { source: { ...source } }),
    });
  }

  /** Validate one post-admission report opportunity before request construction. */
  private latestSubtaskReportCandidate(
    group: SubtaskSnapshot["groups"][number],
    current: SubtaskRuntimeCurrent,
    pass: CanonicalPass,
  ): SubtaskReportOpportunity | undefined {
    const admission = pass.indexOf(group.source.entryId);
    const cursor = this.state.cursor ? pass.indexOf(this.state.cursor.id) : -1;
    if (admission < 0 || cursor <= admission) return;
    const report = current.latest;
    if (
      report.id !== this.state.cursor?.id ||
      report.hash !== this.state.cursor.hash ||
      report.role !== this.state.cursor.role
    )
      return;
    const source = this.reportSource(report);
    const parent = current.parents.find(
      (candidate) =>
        candidate.id === group.parentTaskId &&
        candidate.revision === group.parentRevision &&
        candidate.included,
    );
    if (!parent) return;
    // Canonical cursor, admitted group, and current parent already prove this
    // body-sized opportunity. Do not capture or construct an oversized request.
    if (Buffer.byteLength(report.text, "utf8") > 12 * 1024)
      return { kind: "oversized", parent, source };
    const options = { parent, group, report, resolve: current.resolve };
    const size = subtaskReportRequestSize(options);
    if (size === "oversized") return { kind: "oversized", parent, source };
    if (size !== "within-limit") return;
    const identity = subtaskReportBatches(options)[0]?.jobIdentity;
    return identity ? { kind: "eligible", source, identity } : undefined;
  }

  /** Persist an omission candidate before making it visible to later wakes. */
  private commitSubtaskOmissionSummary(summary: SubtaskOmissionSummary) {
    const component = this.authoritativeSubtaskCheckpoint();
    const metadata = this.subtaskMetadata(
      this.enabled,
      this.healthCards,
      this.state,
      undefined,
      this.taskDetails,
      component,
      summary,
    );
    if (!canCommitSubtaskCheckpoint(this.state, metadata)) return "capacity";
    const sourceId = this.state.sourceId;
    const epoch = this.epoch;
    const saving = { sourceId, summary: structuredClone(summary) };
    const priorSaving = this.savingSubtaskOmissionSummary;
    this.savingSubtaskOmissionSummary = saving;
    let saved: ReturnType<typeof commitSubtaskCheckpoint>;
    try {
      saved = commitSubtaskCheckpoint(this.state, metadata, (checkpoint) => {
        this.persist(checkpoint);
        return true;
      });
    } finally {
      if (this.savingSubtaskOmissionSummary === saving)
        this.savingSubtaskOmissionSummary = priorSaving;
    }
    if (!saved) return "vetoed";
    const sameSource =
      this.state.sourceId === sourceId && this.options.sourceId() === sourceId;
    if (!sameSource || this.epoch !== epoch) {
      // Durable same-source receipts outlive reentrant control changes, but
      // stale queue publication remains fenced at the caller.
      if (sameSource)
        this.subtaskOmissions = mergeSubtaskOmissions(
          this.subtaskOmissions,
          summary,
        ).summary;
      return "stale";
    }
    this.subtaskOmissions = mergeSubtaskOmissions(
      this.subtaskOmissions,
      summary,
    ).summary;
    return "committed";
  }

  /** Persist a content-free report omission before changing report queue ownership. */
  private recordSubtaskReportOmission(
    group: SubtaskSnapshot["groups"][number],
    parent: HybridTask,
    source: SourceRef,
    sourceId: string,
    reason: "report-oversized" | "coalesced" | "capacity",
  ): SubtaskReportOmissionReceipt {
    if (
      sourceId !== this.state.sourceId ||
      sourceId !== this.options.sourceId()
    )
      return "stale";
    const identity = subtaskReportOmissionIdentity({
      sourceId,
      parent,
      group,
      reportSource: source,
    });
    if (!identity) return "not-recorded";
    const appended = appendSubtaskOmission(this.subtaskOmissions, {
      identity,
      reason,
    });
    if (!appended.changed) return "recorded";
    const result = this.commitSubtaskOmissionSummary(appended.summary);
    if (result === "committed") return "recorded";
    if (result === "stale") return "stale";
    if (result === "vetoed") return "not-recorded";

    const saturated = saturateSubtaskOmissions(this.subtaskOmissions);
    if (!saturated.changed) return "not-recorded";
    const saturation = this.commitSubtaskOmissionSummary(saturated.summary);
    if (saturation === "committed") return "recorded";
    return saturation === "stale" ? "stale" : "not-recorded";
  }

  /** Prove an unadmitted older B before C may replace it in the report queue. */
  private coalescedSubtaskReportIdentity(
    group: SubtaskSnapshot["groups"][number],
    current: SubtaskRuntimeCurrent,
    pass: CanonicalPass,
    candidate: { source: SourceRef; identity: string },
    known: readonly SubtaskReportJob[],
  ) {
    if (known.some((report) => report.identity === candidate.identity)) return;
    const admission = pass.indexOf(group.source.entryId);
    const cursor = this.state.cursor ? pass.indexOf(this.state.cursor.id) : -1;
    const reportIndex = pass.indexOf(candidate.source.entryId);
    if (admission < 0 || reportIndex <= admission || cursor <= reportIndex)
      return;
    const parent = current.parents.find(
      (item) =>
        item.id === group.parentTaskId &&
        item.revision === group.parentRevision &&
        item.included,
    );
    if (!parent) return;
    try {
      const report = current.resolve(candidate.source.entryId);
      if (
        !report ||
        report.id !== candidate.source.entryId ||
        report.hash !== candidate.source.messageHash ||
        report.role !== candidate.source.role ||
        candidate.source.start < 0 ||
        candidate.source.end <= candidate.source.start ||
        candidate.source.end > report.text.length ||
        sha256(report.text) !== report.hash ||
        sha256(
          report.text.slice(candidate.source.start, candidate.source.end),
        ) !== candidate.source.quoteHash
      )
        return;
    } catch {
      return;
    }
    return subtaskReportOmissionIdentity({
      sourceId: current.sourceId,
      parent,
      group,
      reportSource: candidate.source,
    });
  }

  /** Replace B only after its durable coalescing receipt commits. */
  private replaceSubtaskReportCandidate(
    group: SubtaskSnapshot["groups"][number],
    current: SubtaskRuntimeCurrent,
    pass: CanonicalPass,
    known: readonly SubtaskReportJob[],
    candidate: { source: SourceRef; identity: string },
  ) {
    const parentTaskId = group.parentTaskId;
    const prior = this.subtaskReportCandidates.get(parentTaskId);
    if (prior && !sameSource(prior.source, candidate.source)) {
      const identity = this.coalescedSubtaskReportIdentity(
        group,
        current,
        pass,
        prior,
        known,
      );
      if (identity) {
        const parent = current.parents.find(
          (item) =>
            item.id === group.parentTaskId &&
            item.revision === group.parentRevision &&
            item.included,
        );
        if (!parent) return "retained" as const;
        const receipt = this.recordSubtaskReportOmission(
          group,
          parent,
          prior.source,
          current.sourceId,
          "coalesced",
        );
        if (receipt === "stale") return "stale" as const;
        if (receipt !== "recorded") return "retained" as const;
      }
    }
    this.subtaskReportCandidates.set(parentTaskId, candidate);
    const blocked = this.subtaskReportBlocked.get(parentTaskId);
    if (blocked && !sameSource(blocked, candidate.source))
      this.subtaskReportBlocked.delete(parentTaskId);
    return "replaced" as const;
  }

  /** Fixed-size wake identity serializes inert own data, never host hooks or bodies. */
  private subtaskWakeKeyFor(current: SubtaskRuntimeCurrent) {
    const value = ownDataJson({
      sourceId: current.sourceId,
      latest: {
        id: current.latest.id,
        role: current.latest.role,
        hash: current.latest.hash,
      },
      earlier: current.earlier.map((observation) => ({
        id: observation.id,
        role: observation.role,
        hash: observation.hash,
      })),
      omissions: current.omissions,
      parents: current.parents,
      selectedModel: current.selectedModel,
      ...(current.evidence === undefined ? {} : { evidence: current.evidence }),
    });
    return sha256(value?.json ?? "subtask-wake:v1:invalid-own-data");
  }

  private restoredSubtaskStore(
    runtime: SubtaskRuntime,
    current: SubtaskRuntimeCurrent,
  ) {
    return this.restoreSubtaskStore(runtime.checkpoint(), current);
  }

  /** Rebuild detached group authority from a checkpoint at a named boundary. */
  private restoreSubtaskStore(
    checkpoint: Readonly<SubtaskRuntimeCheckpoint>,
    current: SubtaskRuntimeCurrent,
  ) {
    return SubtaskStore.restore(checkpoint.state, {
      parents: current.parents,
      sourceCurrent: (source) => {
        const observation = current.resolve(source.entryId);
        return !!(
          observation &&
          observation.id === source.entryId &&
          observation.hash === source.messageHash &&
          observation.role === source.role &&
          source.start >= 0 &&
          source.end > source.start &&
          source.end <= observation.text.length &&
          sha256(observation.text) === observation.hash &&
          sha256(observation.text.slice(source.start, source.end)) ===
            source.quoteHash
        );
      },
    });
  }

  /** Diagnostic capture is observational; it cannot veto a saved transaction. */
  private captureSubtaskDiagnosticAuthoritySafely(
    checkpoint: Readonly<SubtaskRuntimeCheckpoint> | undefined,
    current: () => SubtaskRuntimeCurrent | undefined,
  ) {
    try {
      const value = current();
      if (value) this.captureSubtaskDiagnosticAuthority(value, checkpoint);
      else this.subtaskDiagnosticAuthority = undefined;
    } catch {
      this.subtaskDiagnosticAuthority = undefined;
    }
  }

  /** Capture only current durable owner IDs; never retain canonical readers. */
  private captureSubtaskDiagnosticAuthority(
    current: SubtaskRuntimeCurrent,
    checkpoint:
      | Readonly<SubtaskRuntimeCheckpoint>
      | undefined = this.subtaskRuntime?.checkpoint(),
  ) {
    if (!checkpoint) {
      this.subtaskDiagnosticAuthority = undefined;
      return;
    }
    const store = this.restoreSubtaskStore(checkpoint, current);
    if (!store) {
      this.subtaskDiagnosticAuthority = undefined;
      return;
    }
    const groups = store.snapshot().groups;
    const parked = new Set<string>();
    const permanent = new Set<string>();
    const state = { tasks: [...current.parents] };
    let established = true;
    const add = (parentTaskId: string, ownerState: "parked" | "permanent") =>
      (ownerState === "parked" ? parked : permanent).add(parentTaskId);

    for (const record of checkpoint.journal.records) {
      if (record.state !== "parked" && record.state !== "permanent") continue;
      if (typeof current.selectedModel !== "string") {
        established = false;
        break;
      }
      const group = groups.find(
        (candidate) =>
          candidate.parentTaskId === record.parentTaskId &&
          candidate.parentRevision === record.parentRevision &&
          candidate.listRevision === record.listRevision,
      );
      if (
        subtaskRuntimeRecordIsCurrent(record, current, {
          state,
          ...(group === undefined ? {} : { group }),
        })
      )
        add(record.parentTaskId, record.state);
    }
    if (established)
      for (const report of checkpoint.journal.reports) {
        if (report.state !== "parked" && report.state !== "permanent") continue;
        const group = groups.find(
          (candidate) => candidate.id === report.groupId,
        );
        if (
          subtaskRuntimeReportIsCurrent(report, current, {
            state,
            ...(group === undefined ? {} : { group }),
          })
        )
          add(report.parentTaskId, report.state);
      }
    const owners = new Set([...parked, ...permanent]);
    this.subtaskDiagnosticAuthority =
      established && owners.size <= 20 ? { parked, permanent } : undefined;
  }

  private hydrateSubtaskProjection(
    pass: CanonicalPass,
    checkpoint = this.authoritativeSubtaskCheckpoint(),
  ) {
    const current = this.subtaskCurrent(this.state, pass, true);
    const store = current
      ? this.restoreSubtaskStore(checkpoint, current)
      : undefined;
    this.subtaskProjection = store ? store.snapshot() : undefined;
  }

  private wakeSubtaskReports(
    pass: CanonicalPass,
    current: SubtaskRuntimeCurrent,
  ) {
    const runtime = this.subtaskRuntime;
    if (!runtime || !this.enabled || this.processing || this.queued.length)
      return;
    const checkpoint = runtime.checkpoint();
    const store = this.restoredSubtaskStore(runtime, current);
    if (!store) return;
    const snapshot = store.snapshot();
    this.subtaskProjection = structuredClone(snapshot);
    const known = checkpoint.journal.reports;
    const parents = new Map(
      this.state.tasks
        .filter((parent) => parent.included)
        .map((parent) => [parent.id, parent]),
    );
    const groups = snapshot.groups
      .filter((group) => {
        const parent = parents.get(group.parentTaskId);
        return !!parent && parent.revision === group.parentRevision;
      })
      .slice(0, 20);
    this.subtaskOversizedReportParents.clear();
    const live = new Set(groups.map((group) => group.parentTaskId));
    for (const parentTaskId of this.subtaskReportCandidates.keys())
      if (!live.has(parentTaskId))
        this.subtaskReportCandidates.delete(parentTaskId);

    for (const group of groups) {
      const parentTaskId = group.parentTaskId;
      const opportunity = this.latestSubtaskReportCandidate(
        group,
        current,
        pass,
      );
      const candidate =
        opportunity?.kind === "eligible" ? opportunity : undefined;
      const oversized =
        opportunity?.kind === "oversized" ? opportunity : undefined;
      if (oversized) {
        const receipt = this.recordSubtaskReportOmission(
          group,
          oversized.parent,
          oversized.source,
          current.sourceId,
          "report-oversized",
        );
        if (receipt === "stale") return;
        if (receipt === "recorded") {
          this.subtaskOversizedReportParents.add(parentTaskId);
          if (this.subtaskFlightReportParentId === parentTaskId)
            this.subtaskFlightReportMayBeSuperseded = false;
        }
      }
      const alreadyRecorded = candidate
        ? known.some((report) => report.identity === candidate.identity)
        : false;
      if (candidate && !alreadyRecorded) {
        if (
          this.replaceSubtaskReportCandidate(
            group,
            current,
            pass,
            known,
            candidate,
          ) === "stale"
        )
          return;
      } else if (!candidate && !oversized)
        this.subtaskReportCandidates.delete(parentTaskId);

      const owner = this.reportJobForParent(runtime, parentTaskId);
      if (!owner) {
        const next = this.subtaskReportCandidates.get(parentTaskId);
        const blocked = this.subtaskReportBlocked.get(parentTaskId);
        if (next && (!blocked || !sameSource(blocked, next.source)))
          this.enqueueSubtaskReport(parentTaskId, next.source);
        continue;
      }
      if (owner.state === "ready") {
        const blocked = this.subtaskReportBlocked.get(parentTaskId);
        if (!blocked || !sameSource(blocked, owner.source))
          this.enqueueSubtaskReport(parentTaskId);
        continue;
      }
      if (owner.state === "parked") {
        const blocked = this.subtaskReportBlocked.get(parentTaskId);
        if (
          (!blocked || !sameSource(blocked, owner.source)) &&
          owner.parkedUntil !== undefined &&
          Date.now() >= owner.parkedUntil
        )
          this.enqueueSubtaskReport(parentTaskId);
        continue;
      }
      if (owner.state === "permanent" || owner.state === "dispatched") {
        const next = this.subtaskReportCandidates.get(parentTaskId);
        if (next) this.enqueueSubtaskReport(parentTaskId, next.source);
      }
    }
  }

  /**
   * Physical drains may finish after host session replacement. Consume only
   * candidates captured by a prior named canonical wake; never reread host.
   */
  private wakeCapturedSubtaskReportCandidates(runtime: SubtaskRuntime) {
    const known = runtime.checkpoint().journal.reports;
    for (const [parentTaskId, candidate] of this.subtaskReportCandidates) {
      if (known.some((report) => report.identity === candidate.identity)) {
        this.subtaskReportCandidates.delete(parentTaskId);
        continue;
      }
      const blocked = this.subtaskReportBlocked.get(parentTaskId);
      if (blocked && sameSource(blocked, candidate.source)) continue;
      const owner = this.reportJobForParent(runtime, parentTaskId);
      if (!owner || owner.state === "permanent" || owner.state === "dispatched")
        this.enqueueSubtaskReport(parentTaskId, candidate.source);
    }
  }

  /** Named canonical authority decides whether a report may retain its parent. */
  private refreshActiveSubtaskReportParents(current: SubtaskRuntimeCurrent) {
    const runtime = this.subtaskRuntime;
    const store = runtime
      ? this.restoredSubtaskStore(runtime, current)
      : undefined;
    const groups = store?.snapshot().groups ?? [];
    const parents = new Set<string>();
    for (const owner of this.subtaskReportOwners) {
      const parent = current.parents.find(
        (candidate) =>
          candidate.id === owner.parentTaskId && candidate.included,
      );
      const candidate = this.subtaskReportCandidates.get(owner.parentTaskId);
      if (
        parent &&
        owner.source &&
        candidate &&
        sameSource(owner.source, candidate.source) &&
        groups.some(
          (group) =>
            group.parentTaskId === parent.id &&
            group.parentRevision === parent.revision,
        )
      )
        parents.add(owner.parentTaskId);
    }
    for (const parentTaskId of this.subtaskOversizedReportParents)
      if (
        groups.some((group) => group.parentTaskId === parentTaskId) &&
        current.parents.some(
          (parent) => parent.id === parentTaskId && parent.included,
        )
      )
        parents.add(parentTaskId);
    for (const report of runtime?.checkpoint().journal.reports ?? []) {
      if (
        report.state !== "ready" &&
        report.state !== "parked" &&
        report.state !== "dispatched"
      )
        continue;
      const group = groups.find((candidate) => candidate.id === report.groupId);
      if (
        subtaskRuntimeReportIsCurrent(report, current, {
          state: { tasks: [...current.parents] },
          ...(group === undefined ? {} : { group }),
        })
      )
        parents.add(report.parentTaskId);
    }
    this.subtaskActiveReportParents = parents;
  }

  /** Physical drains use only ownership captured by a named canonical wake. */
  private activeSubtaskReportParentIds() {
    return this.subtaskActiveReportParents;
  }

  private settleCapturedSubtaskReportParents(runtime: SubtaskRuntime) {
    const queued = new Set(
      this.subtaskReportOwners.map((owner) => owner.parentTaskId),
    );
    for (const parentTaskId of this.subtaskActiveReportParents) {
      if (queued.has(parentTaskId)) continue;
      const report = this.reportJobForParent(runtime, parentTaskId);
      if (
        !report ||
        (report.state !== "ready" &&
          report.state !== "parked" &&
          report.state !== "dispatched")
      )
        this.subtaskActiveReportParents.delete(parentTaskId);
    }
  }

  /** Detach bounded target dependencies; no post-drain callback reaches host input. */
  private capturedPendingSubtaskCurrent(
    current: SubtaskRuntimeCurrent,
    checkpoint: Readonly<SubtaskRuntimeCheckpoint>,
    genericParentIds: ReadonlySet<string>,
    pass: CanonicalPass,
  ): SubtaskRuntimeCurrent | undefined {
    const entryIds = new Set([
      current.latest.id,
      ...current.earlier.map((observation) => observation.id),
    ]);
    const collect = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) collect(item);
        return;
      }
      const source = value as { entryId?: unknown };
      if (typeof source.entryId === "string") entryIds.add(source.entryId);
      for (const item of Object.values(value)) collect(item);
    };
    collect(checkpoint.state);
    collect(
      checkpoint.journal.records.filter(
        (record) => record.state !== "superseded",
      ),
    );
    collect(
      checkpoint.journal.reports.filter(
        (report) => report.state !== "superseded",
      ),
    );
    const reportParentIds = new Set([
      ...checkpoint.state.groups.map((group) => group.parentTaskId),
      ...checkpoint.journal.reports
        .filter((report) => report.state !== "superseded")
        .map((report) => report.parentTaskId),
    ]);
    for (const parent of current.parents)
      if (genericParentIds.has(parent.id) || reportParentIds.has(parent.id))
        collect(parent.source);

    const retained: Array<[string, Observation]> = [];
    let bytes = 2; // JSON array brackets.
    for (const entryId of entryIds) {
      const observation = pass.observation(entryId);
      if (!observation) return;
      const id = Object.getOwnPropertyDescriptor(observation, "id")?.value;
      const role = Object.getOwnPropertyDescriptor(observation, "role")?.value;
      const text = Object.getOwnPropertyDescriptor(observation, "text")?.value;
      const hash = Object.getOwnPropertyDescriptor(observation, "hash")?.value;
      if (
        typeof id !== "string" ||
        (role !== "user" && role !== "assistant" && role !== "intercom") ||
        typeof text !== "string" ||
        typeof hash !== "string"
      )
        return;
      // Reject a raw oversized body before serializing or cloning it.
      if (Buffer.byteLength(text, "utf8") > MAX_PENDING_SUBTASK_CAPTURE_BYTES)
        return;
      const inert = Object.create(null) as Record<string, string>;
      inert.id = id;
      inert.role = role;
      inert.text = text;
      inert.hash = hash;
      const encoded = Buffer.byteLength(JSON.stringify(inert), "utf8");
      const next = bytes + encoded + (retained.length ? 1 : 0);
      if (next > MAX_PENDING_SUBTASK_CAPTURE_BYTES) return;
      bytes = next;
      retained.push([
        entryId,
        { id, role: role as ObservationRole, text, hash },
      ]);
    }

    const observations = new Map(
      retained.map(([entryId, observation]) => [
        entryId,
        structuredClone(observation),
      ]),
    );
    let revoked = false;
    this.pendingSubtaskCurrentRevoke = () => {
      revoked = true;
      observations.clear();
    };
    return {
      sourceId: current.sourceId,
      enabled: current.enabled,
      parents: structuredClone(current.parents),
      latest: structuredClone(current.latest),
      earlier: structuredClone(current.earlier),
      omissions: [...current.omissions],
      ...(current.selectedModel === undefined
        ? {}
        : { selectedModel: current.selectedModel }),
      // Evidence capability is identity-attested; cloning destroys its proof.
      ...(current.evidence === undefined ? {} : { evidence: current.evidence }),
      resolve: (entryId) => {
        const observation = revoked ? undefined : observations.get(entryId);
        return observation ? structuredClone(observation) : undefined;
      },
    };
  }

  /** Revoke unavailable pending authority so later equal wakes can rebuild it. */
  private blockPendingSubtaskWake() {
    this.pendingSubtaskCurrentRevoke?.();
    this.pendingSubtaskCurrentRevoke = undefined;
    this.pendingSubtaskCurrent = null;
    this.subtaskOwners = [];
    this.subtaskReportOwners = [];
    this.subtaskReportCandidates.clear();
    this.subtaskOversizedReportParents.clear();
    this.subtaskReportBlocked.clear();
    this.subtaskReportFrontiers.clear();
    this.subtaskActiveReportParents.clear();
    this.subtaskDiagnosticAuthority = undefined;
    this.subtaskWakeKey = undefined;
  }

  /** Capture pending target work while canonical authority is still available. */
  private wakePendingSubtasks(pass: CanonicalPass, force: boolean) {
    const checkpoint = this.pendingSubtaskCheckpoint;
    if (!checkpoint) {
      this.blockPendingSubtaskWake();
      return;
    }
    const reportParentIds = new Set(
      checkpoint.state.groups.map((group) => group.parentTaskId),
    );
    const hasReports = reportParentIds.size > 0;
    if (!hasReports && !this.options.proposeSubtasks) {
      this.blockPendingSubtaskWake();
      return;
    }
    const current = this.subtaskCurrent(this.state, pass, false, !hasReports);
    const reportCurrent = hasReports
      ? (current ?? this.subtaskReportCurrent(this.state, pass))
      : undefined;
    const authority = current ?? reportCurrent;
    if (!authority) {
      this.blockPendingSubtaskWake();
      return;
    }
    const store = this.restoreSubtaskStore(checkpoint, authority);
    if (!store) {
      this.blockPendingSubtaskWake();
      return;
    }
    const snapshot = store.snapshot();
    this.subtaskProjection = structuredClone(snapshot);
    const parents = new Map(
      this.state.tasks
        .filter((parent) => parent.included)
        .map((parent) => [parent.id, parent]),
    );
    const groups = snapshot.groups
      .filter((group) => {
        const parent = parents.get(group.parentTaskId);
        return !!parent && parent.revision === group.parentRevision;
      })
      .slice(0, 20);
    const live = new Set(groups.map((group) => group.parentTaskId));
    for (const parentTaskId of this.subtaskReportCandidates.keys())
      if (!live.has(parentTaskId))
        this.subtaskReportCandidates.delete(parentTaskId);
    const active = new Set<string>();
    for (const group of groups) {
      const parentTaskId = group.parentTaskId;
      const opportunity = this.latestSubtaskReportCandidate(
        group,
        authority,
        pass,
      );
      const candidate =
        opportunity?.kind === "eligible" ? opportunity : undefined;
      const oversized =
        opportunity?.kind === "oversized" ? opportunity : undefined;
      if (oversized) {
        const receipt = this.recordSubtaskReportOmission(
          group,
          oversized.parent,
          oversized.source,
          authority.sourceId,
          "report-oversized",
        );
        if (receipt === "stale") return;
        if (receipt === "recorded") active.add(parentTaskId);
      }
      const owner = checkpoint.journal.reports.find(
        (report) =>
          report.parentTaskId === parentTaskId &&
          report.state !== "complete" &&
          report.state !== "superseded",
      );
      const ownerCurrent =
        !!owner &&
        subtaskRuntimeReportIsCurrent(owner, authority, {
          state: { tasks: [...authority.parents] },
          group,
        });
      const alreadyRecorded = candidate
        ? checkpoint.journal.reports.some(
            (report) => report.identity === candidate.identity,
          )
        : false;
      if (candidate && !alreadyRecorded) {
        if (
          this.replaceSubtaskReportCandidate(
            group,
            authority,
            pass,
            checkpoint.journal.reports,
            candidate,
          ) === "stale"
        )
          return;
      } else if (!candidate && !oversized)
        this.subtaskReportCandidates.delete(parentTaskId);
      if (!owner || !ownerCurrent) {
        if (candidate && !alreadyRecorded) active.add(parentTaskId);
        continue;
      }
      // Ownership survives blocking and parked retry deadlines. Runnability only
      // controls report queue admission below.
      if (
        owner.state === "ready" ||
        owner.state === "parked" ||
        owner.state === "dispatched"
      )
        active.add(parentTaskId);
      if (owner.state === "ready") {
        const blocked = this.subtaskReportBlocked.get(parentTaskId);
        if (!blocked || !sameSource(blocked, owner.source)) {
          this.enqueueSubtaskReport(parentTaskId);
          active.add(parentTaskId);
        }
      } else if (owner.state === "parked") {
        const blocked = this.subtaskReportBlocked.get(parentTaskId);
        if (
          (!blocked || !sameSource(blocked, owner.source)) &&
          owner.parkedUntil !== undefined &&
          Date.now() >= owner.parkedUntil
        ) {
          this.enqueueSubtaskReport(parentTaskId);
          active.add(parentTaskId);
        }
      } else if (owner.state === "permanent" || owner.state === "dispatched") {
        if (candidate && !alreadyRecorded) active.add(parentTaskId);
      }
    }
    const owners = new Set(active);
    const genericParentIds = new Set(
      current?.selectedModel && this.options.proposeSubtasks
        ? current.parents.flatMap((parent) => {
            if (!parent.included) return [];
            if (!owners.has(parent.id) && owners.size >= 20) return [];
            owners.add(parent.id);
            return [parent.id];
          })
        : [],
    );
    this.pendingSubtaskCurrentRevoke?.();
    this.pendingSubtaskCurrentRevoke = undefined;
    const captureCurrent =
      Buffer.byteLength(authority.latest.text, "utf8") <= 12 * 1024
        ? authority
        : undefined;
    if (!captureCurrent) {
      // Receipt is durable, but C's body cannot become detached execution input.
      this.pendingSubtaskCurrent = null;
      this.subtaskOwners = [];
      this.subtaskReportOwners = [];
      this.subtaskActiveReportParents = active;
      this.captureSubtaskDiagnosticAuthoritySafely(checkpoint, () => authority);
      this.subtaskWakeKey = this.subtaskWakeKeyFor(authority);
      return;
    }
    const captured = this.capturedPendingSubtaskCurrent(
      captureCurrent,
      checkpoint,
      genericParentIds,
      pass,
    );
    if (!captured) {
      this.blockPendingSubtaskWake();
      return;
    }
    this.pendingSubtaskCurrent = captured;
    this.subtaskActiveReportParents = active;
    this.captureSubtaskDiagnosticAuthoritySafely(
      checkpoint,
      () => captureCurrent,
    );
    const key = this.subtaskWakeKeyFor(captureCurrent);
    if (!force && key === this.subtaskWakeKey) return;
    this.subtaskWakeKey = key;
    this.subtaskOwners = [...genericParentIds];
  }

  /** Named cursor/model/restore wakes only. No timer or self-requeue exists. */
  private wakeSubtasks(pass: CanonicalPass, force = false) {
    if (this.pendingSubtaskCheckpoint) {
      this.wakePendingSubtasks(pass, force);
      return;
    }
    this.capturedSubtaskCurrentRevoke?.();
    this.capturedSubtaskCurrentRevoke = undefined;
    this.capturedSubtaskCurrent = undefined;
    const reportParentIds = new Set(
      this.subtaskRuntime
        ?.checkpoint()
        .state.groups.map((group) => group.parentTaskId) ?? [],
    );
    const hasReports = reportParentIds.size > 0;
    if (!hasReports && !this.options.proposeSubtasks) {
      this.subtaskOwners = [];
      this.subtaskReportOwners = [];
      this.subtaskDiagnosticAuthority = undefined;
      return;
    }
    const current = this.subtaskCurrent(this.state, pass, false, !hasReports);
    const reportCurrent = hasReports
      ? (current ?? this.subtaskReportCurrent(this.state, pass))
      : undefined;
    const authority = current ?? reportCurrent;
    if (!authority) {
      this.subtaskOwners = [];
      this.subtaskReportOwners = [];
      this.subtaskOversizedReportParents.clear();
      this.subtaskDiagnosticAuthority = undefined;
      return;
    }
    if (reportCurrent) this.wakeSubtaskReports(pass, reportCurrent);
    this.refreshActiveSubtaskReportParents(authority);
    this.captureSubtaskDiagnosticAuthoritySafely(
      this.subtaskRuntime?.checkpoint(),
      () => authority,
    );
    const key = this.subtaskWakeKeyFor(authority);
    if (!force && key === this.subtaskWakeKey) return;
    this.subtaskWakeKey = key;
    const activeReportParents = this.activeSubtaskReportParentIds();
    const owners = new Set(activeReportParents);
    this.subtaskOwners =
      current?.selectedModel && this.options.proposeSubtasks
        ? current.parents.flatMap((parent) => {
            if (!parent.included) return [];
            if (!owners.has(parent.id) && owners.size >= 20) return [];
            owners.add(parent.id);
            return [parent.id];
          })
        : [];
  }

  /** Cancel stale generic work without aborting valid saved-report transport. */
  private invalidateSubtaskWork(preserveReportFlight = false) {
    if (preserveReportFlight) {
      this.subtaskFlightReportMayBeSuperseded = this.subtaskFlightIsReport;
      this.subtaskOwners = [];
      return;
    }
    this.pendingSubtaskCurrentRevoke?.();
    this.pendingSubtaskCurrentRevoke = undefined;
    this.pendingSubtaskCurrent = null;
    this.capturedSubtaskCurrentRevoke?.();
    this.capturedSubtaskCurrentRevoke = undefined;
    this.capturedSubtaskCurrent = null;
    this.subtaskRuntime?.invalidate();
    this.subtaskGatewayResetAfterReportDrain = false;
    this.subtaskGateway.invalidate();
    this.subtaskGateDispatch = undefined;
    this.subtaskDiagnosticAuthority = undefined;
    this.subtaskOwners = [];
    this.subtaskReportOwners = [];
    this.subtaskOversizedReportParents.clear();
    this.subtaskScheduleGeneration += 1;
    this.subtaskWakeKey = undefined;
  }

  private hasSubtaskWork() {
    return this.subtaskReportOwners.length > 0 || this.subtaskOwners.length > 0;
  }

  private advanceSubtaskReport(
    runtime: SubtaskRuntime,
    parentTaskId: string,
    before: SubtaskReportJob | undefined,
    scheduleGeneration: number,
  ) {
    if (
      this.subtaskRuntime !== runtime ||
      this.subtaskScheduleGeneration !== scheduleGeneration
    )
      return;
    const after = this.reportJobForParent(runtime, parentTaskId);
    if (after?.state !== "ready") return;
    const previous =
      before?.identity === after.identity
        ? this.reportDecidedIds(before)
        : new Set<string>();
    const decided = this.reportDecidedIds(after);
    if (
      !decided.size ||
      decided.size >= after.childIds.length ||
      previous.size >= decided.size ||
      [...previous].some((childId) => !decided.has(childId))
    )
      return;
    const frontier = this.subtaskReportFrontiers.get(after.identity);
    if (
      frontier &&
      (frontier.advances >= 64 ||
        frontier.decided.size >= decided.size ||
        [...frontier.decided].some((childId) => !decided.has(childId)))
    )
      return;
    this.subtaskReportFrontiers.set(after.identity, {
      decided,
      advances: (frontier?.advances ?? 0) + 1,
    });
    this.enqueueSubtaskReport(parentTaskId);
  }

  private drainSubtasks() {
    if (
      !this.enabled ||
      this.processing ||
      this.queued.length ||
      this.state.pending ||
      this.subtaskFlight ||
      !this.subtaskRuntime
    )
      return false;
    const report = this.subtaskReportOwners.shift();
    const generic = report
      ? undefined
      : this.subtaskOwners.findIndex(
          (parentTaskId) =>
            !this.activeSubtaskReportParentIds().has(parentTaskId),
        );
    let parentTaskId = report?.parentTaskId;
    if (!parentTaskId && generic !== undefined && generic >= 0)
      parentTaskId = this.subtaskOwners.splice(generic, 1)[0];
    if (!parentTaskId) return false;
    const runtime = this.subtaskRuntime;
    const before = report
      ? structuredClone(this.reportJobForParent(runtime, parentTaskId))
      : undefined;
    const beforeJournal = report
      ? JSON.stringify(runtime.checkpoint().journal)
      : undefined;
    const scheduleGeneration = this.subtaskScheduleGeneration;
    // Runtime dispatch persistence may synchronously reenter Monitor before
    // runReport()/run() returns its promise. Reserve ownership first so model
    // selection, replacement, and nested drains see the real flight kind.
    const reservation = Promise.resolve();
    this.subtaskFlight = reservation;
    this.subtaskFlightIsReport = !!report;
    this.subtaskFlightReportParentId = report?.parentTaskId;
    this.subtaskFlightReportMayBeSuperseded = false;
    const flight = report
      ? runtime.runReport(parentTaskId, report.source)
      : runtime.run(parentTaskId);
    this.subtaskFlight = flight;
    void flight.finally(() => {
      if (this.subtaskFlight !== flight) return;
      const supersedeReport =
        !!report && this.subtaskFlightReportMayBeSuperseded;
      if (supersedeReport) runtime.invalidate();
      this.subtaskFlight = undefined;
      this.subtaskFlightIsReport = false;
      this.subtaskFlightReportParentId = undefined;
      this.subtaskFlightReportMayBeSuperseded = false;
      if (report && !supersedeReport) {
        if (beforeJournal === JSON.stringify(runtime.checkpoint().journal)) {
          const source = report.source ?? before?.source;
          if (source) this.subtaskReportBlocked.set(parentTaskId, source);
        } else this.subtaskReportBlocked.delete(parentTaskId);
        this.advanceSubtaskReport(
          runtime,
          parentTaskId,
          before,
          scheduleGeneration,
        );
      }
      if (this.subtaskGatewayResetAfterReportDrain) {
        this.subtaskGatewayResetAfterReportDrain = false;
        if (this.enabled) this.subtaskGateway.enable(this.subtaskIdentity());
      }
      if (this.pendingSubtaskCheckpoint) {
        const next = this.pendingSubtaskCheckpoint;
        const current = this.pendingSubtaskCurrent;
        const revoke = this.pendingSubtaskCurrentRevoke;
        this.pendingSubtaskCheckpoint = undefined;
        this.pendingSubtaskCurrent = undefined;
        this.pendingSubtaskCurrentRevoke = undefined;
        this.installSubtaskRuntime(next, true, current, revoke);
        if (this.enabled) this.subtaskGateway.enable(this.subtaskIdentity());
      }
      if (this.enabled && this.subtaskRuntime) {
        this.wakeCapturedSubtaskReportCandidates(this.subtaskRuntime);
        this.settleCapturedSubtaskReportParents(this.subtaskRuntime);
      }
      this.publish();
      this.drain();
      if (
        this.capturedSubtaskCurrent !== null &&
        !this.subtaskFlight &&
        !this.hasSubtaskWork()
      ) {
        this.capturedSubtaskCurrentRevoke?.();
        this.capturedSubtaskCurrentRevoke = undefined;
        this.capturedSubtaskCurrent = undefined;
      }
    });
    return true;
  }

  /** One bounded wake, rescheduled only by a named advancing frontier. */
  private scheduleCanonicalWake() {
    if (this.canonicalWakeTimer) return;
    const epoch = this.epoch;
    this.canonicalWakeTimer = setTimeout(() => {
      this.canonicalWakeTimer = undefined;
      if (epoch !== this.epoch) return;
      const control = this.controlWork;
      if (control) {
        this.advanceControl(control);
        return;
      }
      const active = this.activeObservation;
      if (active?.scan) {
        this.advanceActiveAuthority(active);
        return;
      }
      if (!this.enabled) return;
      if (this.pendingScan) {
        const pass = this.beginCanonicalPass();
        const authority = this.reconcileAuthority(pass);
        if (authority === "amended") this.resetForCanonicalAmendment();
        else if (authority === "incomplete") this.scheduleCanonicalWake();
        else {
          this.reconcileHealthCards(pass);
          this.requeue(pass);
          this.publish();
          this.drain();
        }
        return;
      }
      if (this.processing || this.page.length) return;
      if (!this.pageFrontier || this.pageFrontier.terminal) return;
      const pass = this.beginCanonicalPass();
      const authority = this.reconcileAuthority(pass);
      if (authority === "amended") this.resetForCanonicalAmendment();
      else if (authority === "current") {
        this.reconcileHealthCards(pass);
        this.requeue(pass);
        this.publish();
        this.drain();
      }
    }, 0);
  }

  private applyMetadata(
    metadata: SubtaskMonitorCheckpointMetadata | undefined,
    pass?: CanonicalPass,
  ) {
    const cards = metadata?.healthCards ?? [];
    this.healthCards = new Map(
      cards
        .filter((card) => this.healthCardMatchesCanonical(card, pass))
        .map((card) => [card.taskId, copyHealthCard(card)]),
    );
    // Stored card digests prove safe retention, not live freshness after reload.
    this.currentHealthProofs.clear();
    const details = this.options.richDetailsEnabled
      ? ((metadata?.taskDetails ?? []) as TaskDetailRecord[])
      : [];
    this.taskDetails = new Map(
      details
        .filter((detail) => this.detailRecordMatchesCanonical(detail, pass))
        .map((detail) => [detail.taskId, copyDetailRecord(detail)]),
    );
    this.parkedDetails.clear();
    this.rebuildDetailValues(pass);
    this.lastDisplayedTaskId = metadata?.idleDoneTaskId;
    this.idleDoneInvalidated = !this.lastDisplayedTaskId;
    this.syncPresentationCard();
    this.lastJevCallAt = metadata?.lastJevCallAt;
    this.lastExtractionCallAt = metadata?.lastExtractionCallAt;
    const usage = metadata?.usage;
    this.usage.jev.calls = usage?.jev.calls ?? 0;
    this.usage.jev.inputTokens = usage?.jev.inputTokens ?? 0;
    this.usage.jev.outputTokens = usage?.jev.outputTokens ?? 0;
    this.usage.extraction.calls = usage?.extraction.calls ?? 0;
    this.usage.extraction.inputTokens = usage?.extraction.inputTokens ?? 0;
    this.usage.extraction.outputTokens = usage?.extraction.outputTokens ?? 0;
  }

  /** Reset passive adapter capabilities on control, model, or branch lifecycle changes. */
  private resetCoverageAdapter() {
    this.coverageAdapterEpoch++;
    this.coverageAdapter.reset(this.coverageAdapterEpoch);
    this.subtaskEvidence = undefined;
    this.subtaskRuntime?.resetAccess();
  }

  private healthCardMatchesCanonical(
    card: HealthCard,
    pass?: CanonicalPass,
    state: HybridState = this.state,
  ) {
    const task = state.tasks.find(
      (item) =>
        item.id === card.taskId &&
        item.revision === card.revision &&
        item.label === card.label &&
        sameSource(item.source, card.provenance.taskSource),
    );
    if (!task || !pass) return !!task;
    const observation = pass.observation(card.provenance.observation.entryId);
    if (
      !observation ||
      observation.hash !== card.provenance.observation.messageHash ||
      observation.role !== card.provenance.observation.role
    )
      return false;
    const coverage = pass.healthReportContext(observation.id);
    return !!coverage && sameHealthCoverage(card.provenance.coverage, coverage);
  }

  private cachedObservation(entryId: string) {
    return [...this.page, ...this.settledContext].find(
      (observation) => observation.id === entryId,
    );
  }

  private detailRecordMatchesCanonical(
    record: TaskDetailRecord,
    pass?: CanonicalPass,
    state: HybridState = this.state,
  ) {
    const task = state.tasks.find((item) => item.id === record.taskId);
    if (!task || !detailRecordMatchesTask(record, task)) return false;
    const resolve = (entryId: string) =>
      pass
        ? this.resolveObservation(pass, entryId)
        : this.cachedObservation(entryId);
    if (
      !record.candidates.every(
        (candidate) => !!taskDetailRequest(record, [candidate.key], resolve),
      )
    )
      return false;
    return record.receipts.every((receipt) => {
      const request = taskDetailRequest(record, receipt.candidateKeys, resolve);
      return !!request && receipt.requestHash === requestHash(request);
    });
  }

  private rebuildDetailValues(pass?: CanonicalPass) {
    if (!this.options.richDetailsEnabled) {
      this.detailValues.clear();
      return;
    }
    // A getter must never reopen canonical history. Keep a previously validated
    // detached value across ordinary commits; a supplied CanonicalPass is the
    // only authority that may replace or drop it.
    const retained = new Map(
      [...this.detailValues].filter(([taskId]) => {
        const record = this.taskDetails.get(taskId);
        const task = this.state.tasks.find((item) => item.id === taskId);
        return !!record && !!task && detailRecordMatchesTask(record, task);
      }),
    );
    if (!pass) {
      this.detailValues = retained;
      return;
    }
    const values = new Map<string, MaterializedTaskDetails>();
    for (const record of this.taskDetails.values()) {
      const detail = materializeTaskDetails(record, (entryId) =>
        this.resolveObservation(pass, entryId),
      );
      if (detail) values.set(record.taskId, detail);
    }
    this.detailValues = values;
  }

  private detailsForState(state: HybridState) {
    return new Map(
      [...this.taskDetails.values()]
        .filter((record) => {
          const task = state.tasks.find((item) => item.id === record.taskId);
          return !!task && detailRecordMatchesTask(record, task);
        })
        .map((record) => [record.taskId, copyDetailRecord(record)]),
    );
  }

  /** Candidate semantic commits must not publish facts for replaced task sources. */
  private healthCardsForState(state: HybridState) {
    return new Map(
      [...this.healthCards.values()]
        .filter((card) => {
          const task = state.tasks.find(
            (item) =>
              item.id === card.taskId &&
              item.revision === card.revision &&
              item.label === card.label &&
              sameSource(item.source, card.provenance.taskSource),
          );
          return !!task;
        })
        .map((card) => [card.taskId, copyHealthCard(card)]),
    );
  }

  /** Drop only optional facts whose exact source/report refs changed or vanished. */
  private reconcileTaskDetails(pass: CanonicalPass) {
    const accepted = [...this.taskDetails.values()].filter((record) =>
      this.detailRecordMatchesCanonical(record, pass),
    );
    const changed = accepted.length !== this.taskDetails.size;
    if (changed)
      this.taskDetails = new Map(
        accepted.map((record) => [record.taskId, copyDetailRecord(record)]),
      );
    // Revalidate/materialize at a canonical mutation boundary even when every
    // durable record remains accepted. Ordinary later commits retain this copy.
    this.rebuildDetailValues(pass);
    return changed;
  }

  private reconcileHealthCards(pass: CanonicalPass) {
    const accepted = [...this.healthCards.values()].filter((card) =>
      this.healthCardMatchesCanonical(card, pass),
    );
    if (accepted.length === this.healthCards.size) return false;
    this.healthCards = new Map(
      accepted.map((card) => [card.taskId, copyHealthCard(card)]),
    );
    this.reconcileCurrentHealthProofs();
    this.syncPresentationCard();
    return true;
  }

  private presentationCardFor(
    card: HealthCard,
    retained: boolean,
    replacementPending = false,
  ): RetainedCard {
    return {
      taskId: card.taskId,
      revision: card.revision,
      label: card.label,
      retained,
      replacementPending,
      assessedAt: card.assessedAt,
      health: { ...card.health },
    };
  }

  /** Board-equivalent selection derives from semantic state, never health arrival order. */
  private presentationTaskId(state: HybridState) {
    const focus = this.openFocus(state);
    if (focus) return focus.id;
    const tasks = tasksNewestFirst(state);
    const allDone =
      tasks.length > 0 &&
      tasks
        .filter((task) => task.included)
        .every((task) => task.status === "done");
    if (!this.idleDoneInvalidated && allDone && this.lastDisplayedTaskId) {
      const retained = tasks.find(
        (task) =>
          task.id === this.lastDisplayedTaskId &&
          task.included &&
          task.status === "done",
      );
      if (retained) return retained.id;
    }
    const open = tasks.filter(
      (task) => task.included && task.status !== "done",
    );
    return (
      open.find((task) => task.id === this.lastDisplayedTaskId)?.id ??
      open.at(-1)?.id
    );
  }

  private currentHealthProofMatches(card: HealthCard) {
    const identity = this.currentHealthProofs.get(card.taskId);
    return !!identity && sha256(identity) === card.provenance.snapshotHash;
  }

  /** Drop only task-local live proof whose retained card no longer validates. */
  private reconcileCurrentHealthProofs(
    state: HybridState = this.state,
    healthCards: ReadonlyMap<string, HealthCard> = this.healthCards,
  ) {
    for (const [taskId, identity] of this.currentHealthProofs) {
      const task = state.tasks.find((item) => item.id === taskId);
      const card = healthCards.get(taskId);
      if (
        !task ||
        !card ||
        !this.healthCardMatchesTask(card, task) ||
        sha256(identity) !== card.provenance.snapshotHash
      )
        this.currentHealthProofs.delete(taskId);
    }
  }

  /** Runtime widget card follows semantic/board selection, not assessment completion. */
  private syncPresentationCard(
    state: HybridState = this.state,
    healthCards: ReadonlyMap<string, HealthCard> = this.healthCards,
  ) {
    const selectedTaskId = this.presentationTaskId(state);
    const selected = selectedTaskId
      ? healthCards.get(selectedTaskId)
      : undefined;
    const retained = this.card ? healthCards.get(this.card.taskId) : undefined;
    const retainedTask = retained
      ? state.tasks.find((task) => task.id === retained.taskId)
      : undefined;
    const card =
      selected ??
      (retainedTask && this.healthCardMatchesTask(retained, retainedTask)
        ? retained
        : undefined);
    if (!card) {
      this.card = undefined;
      return;
    }
    const focus = this.openFocus(state);
    const isCurrent =
      !!focus &&
      card.taskId === focus.id &&
      this.currentHealthProofMatches(card);
    this.card = this.presentationCardFor(
      card,
      !isCurrent,
      !!selectedTaskId && this.hasPendingHealthForTask(selectedTaskId),
    );
  }

  private save() {
    // Legacy ON-only exact-edge state is readable but must never write a stale
    // enabled control record after OFF or any local persistence boundary.
    if (!this.falseProjectionFits()) {
      this.note("capacity-exhausted");
      return;
    }
    try {
      this.persist(
        encodeSubtaskCheckpoint(
          this.state,
          this.subtaskMetadata(
            this.enabled,
            this.healthCards,
            this.state,
            undefined,
            this.taskDetails,
            this.authoritativeSubtaskCheckpoint(),
            this.durableSubtaskOmissions(),
          ),
        ),
      );
    } catch {
      this.note("saved-state-rejected");
    }
  }

  /** Changed/persist callbacks are display/storage boundaries, never controller authority. */
  private publish() {
    try {
      this.changed();
    } catch {
      // A renderer failure must not interrupt semantic work.
    }
  }

  private note(code: keyof typeof diagnosticLabels) {
    this.diagnostics.set(
      code,
      Math.min(999, (this.diagnostics.get(code) ?? 0) + 1),
    );
  }

  /** Async Beads reads enrich copied display data only, never hybrid state. */
  private refreshBeads() {
    const cwd = this.cwd;
    if (!cwd || !this.enabled) return;
    const generation = ++this.beadsGeneration;
    if (this.beadsInFlight) {
      this.beadsRefreshQueued = true;
      return;
    }
    const epoch = this.epoch;
    const sourceId = this.state.sourceId;
    this.beadsInFlight = true;
    void readBeadsExport(cwd)
      .then((source) => {
        if (
          generation !== this.beadsGeneration ||
          !this.enabled ||
          epoch !== this.epoch ||
          sourceId !== this.state.sourceId
        )
          return;
        const next = new Map<string, BeadsPresentation>();
        if (source.complete) {
          for (const task of this.state.tasks) {
            const beads = beadsPresentation(
              task.label,
              task.status === "done",
              source,
            );
            if (beads) next.set(task.id, beads);
          }
        } else this.note("beads-unavailable");
        const changed = !sameBeads(this.beads, next);
        if (changed) this.beads = next;
        if (!source.complete || changed) this.publish();
      })
      .catch(() => {
        if (
          generation !== this.beadsGeneration ||
          !this.enabled ||
          epoch !== this.epoch ||
          sourceId !== this.state.sourceId
        )
          return;
        this.beads.clear();
        this.note("beads-unavailable");
        this.publish();
      })
      .finally(() => {
        this.beadsInFlight = false;
        if (this.beadsRefreshQueued) {
          this.beadsRefreshQueued = false;
          this.refreshBeads();
        }
      });
  }

  private cancelHealth() {
    this.currentHealthProofs.clear();
    const flight = this.healthFlight;
    if (!flight) {
      this.syncPresentationCard();
      return;
    }
    const job = this.healthJobs.get(flight.taskId);
    if (
      job?.state === "in-flight" &&
      job.identity === this.healthWorkIdentity(flight.work)
    ) {
      if (job.successor) {
        const successor = job.successor;
        this.healthJobs.delete(flight.taskId);
        this.healthJobs.set(flight.taskId, {
          work: successor,
          identity: this.healthWorkIdentity(successor),
          state: "ready",
        });
      } else {
        job.state = "ready";
        // A preempted attempt still yields its position to unattempted peers.
        this.healthJobs.delete(flight.taskId);
        this.healthJobs.set(flight.taskId, job);
      }
    }
    this.healthFlight = undefined;
    this.healthGateway.invalidate();
    this.syncPresentationCard();
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryObservation = undefined;
  }

  /** One gateway-truth wake for durable or not-yet-accepted semantic work. */
  private scheduleRetry(observation: Observation) {
    if (!this.enabled || this.retryTimer) return;
    const delay = this.gateway.retryDelayMs;
    if (delay === undefined) return;
    this.retryObservation = { ...observation };
    const epoch = this.epoch;
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = undefined;
        if (!this.enabled || epoch !== this.epoch) return;
        const pass = this.beginCanonicalPass();
        const authority = this.reconcileAuthority(pass);
        if (authority === "amended") this.resetForCanonicalAmendment();
        else if (authority === "incomplete") this.scheduleCanonicalWake();
        else this.requeue(pass);
        this.publish();
        this.drain();
      },
      Math.max(0, delay),
    );
    this.publish();
  }

  private service() {
    if (this.restoreRejection)
      return {
        code: `saved-state-${this.restoreRejection}`,
        label: "Saved progress state needs a fresh session",
      };
    if (!this.enabled) return { code: "monitor-off", label: "Monitoring off" };
    if (this.state.capacity === "limit")
      return {
        code: "capacity-exhausted",
        label: "Progress state capacity reached",
      };
    if (this.waitingForWake)
      return { code: "model-unavailable", label: "Selected model unavailable" };
    if (this.error)
      return {
        code: "service-unavailable",
        label: "Progress service unavailable",
      };
    if (this.gateway.status === "Pending")
      return { code: "analysis-active", label: "Assessing progress" };
    if (this.gateway.status.startsWith("Pending:"))
      return {
        code: "retry-waiting",
        label: "Waiting to retry progress analysis",
      };
    if (!/^(?:Ready|Current)$/.test(this.gateway.status))
      return { code: "jev-unavailable", label: "Jev service unavailable" };
    if (
      ["Extracting tasks", "Assessing progress", "Analyzing progress"].includes(
        this.activity,
      )
    )
      return { code: "analysis-active", label: this.activity };
    return { code: "ready", label: "Ready" };
  }

  private forceOff() {
    this.disableRuntime();
    this.clearRuntimeContext();
    this.error = "Progress service unavailable";
    this.save();
    this.publish();
  }

  /** Mandatory semantic sources only; optional health validates independently. */
  private canonicalReferences(state: HybridState = this.state) {
    const references: {
      entryId: string;
      messageHash: string;
      role?: Observation["role"];
    }[] = [
      ...state.tasks.flatMap((task) => [
        task.source,
        ...(task.latestAssessment ? [task.latestAssessment.source] : []),
      ]),
      ...state.events.map((event) => event.source),
      ...(state.scopeAssessment ? [state.scopeAssessment.source] : []),
      ...(state.pending ? [state.pending.observation] : []),
      ...(state.cursor
        ? [
            {
              entryId: state.cursor.id,
              messageHash: state.cursor.hash,
              role: state.cursor.role,
            },
          ]
        : []),
      ...this.settledContext.map((observation) => ({
        entryId: observation.id,
        messageHash: observation.hash,
        role: observation.role,
      })),
      ...this.page.map((observation) => ({
        entryId: observation.id,
        messageHash: observation.hash,
        role: observation.role,
      })),
      ...this.queued.map((observation) => ({
        entryId: observation.id,
        messageHash: observation.hash,
        role: observation.role,
      })),
      ...(this.retryObservation
        ? [
            {
              entryId: this.retryObservation.id,
              messageHash: this.retryObservation.hash,
              role: this.retryObservation.role,
            },
          ]
        : []),
      ...(this.activeObservation
        ? [
            {
              entryId: this.activeObservation.observation.id,
              messageHash: this.activeObservation.observation.hash,
              role: this.activeObservation.observation.role,
            },
            ...this.activeObservation.requestContext.map((observation) => ({
              entryId: observation.id,
              messageHash: observation.hash,
              role: observation.role,
            })),
            ...(this.activeObservation.scan?.partial ?? []).map(
              (observation) => ({
                entryId: observation.id,
                messageHash: observation.hash,
                role: observation.role,
              }),
            ),
          ]
        : []),
      ...(this.pendingScan?.partial ?? []).map((observation) => ({
        entryId: observation.id,
        messageHash: observation.hash,
        role: observation.role,
      })),
      ...(this.catchupTarget
        ? [
            {
              entryId: this.catchupTarget.id,
              messageHash: this.catchupTarget.hash,
            },
          ]
        : []),
      ...(this.blockedPending
        ? [
            {
              entryId: this.blockedPending.id,
              messageHash: this.blockedPending.hash,
            },
          ]
        : []),
    ];
    const pending = state.pending;
    if (pending) {
      const { gate, patch, completions } = pending.journal;
      references.push(
        ...gate.context,
        gate.assessment.source,
        ...(gate.priorScopeAssessment.present
          ? [gate.priorScopeAssessment.value.source]
          : []),
        ...completions.flatMap((completion) => [
          ...completion.assessments.map((assessment) => assessment.source),
          ...completion.undo.tasks.flatMap((undo) =>
            undo.latestAssessment.present
              ? [undo.latestAssessment.value.source]
              : [],
          ),
        ]),
      );
      if (patch)
        references.push(
          ...patch.outcome.add.map((operation) => operation.source),
          ...patch.outcome.revise.map((operation) => operation.source),
          ...patch.outcome.archive.map((operation) => operation.source),
          ...patch.outcome.restore.map((operation) => operation.source),
          ...patch.undo.revise.map((operation) => operation.source),
          ...patch.undo.restore.map((operation) => operation.source),
        );
    }
    return references;
  }

  private sameContext(
    expected: readonly { entryId: string; messageHash: string; role: string }[],
    actual: readonly Observation[],
  ) {
    return (
      expected.length === actual.length &&
      expected.every(
        (reference, index) =>
          reference.entryId === actual[index]?.id &&
          reference.messageHash === actual[index]?.hash &&
          reference.role === actual[index]?.role,
      )
    );
  }

  /** Exhaustive direct ref validation. Exploratory context is handled separately. */
  private directCanonicalAmendment(
    pass: CanonicalPass,
    state: HybridState = this.state,
  ) {
    const byId = new Map<string, ReturnType<typeof this.canonicalReferences>>();
    for (const reference of this.canonicalReferences(state)) {
      const expected = byId.get(reference.entryId) ?? [];
      expected.push(reference);
      byId.set(reference.entryId, expected);
    }
    let amended = false;
    for (const [entryId, expected] of byId) {
      const current = pass.observation(entryId);
      if (
        !current ||
        expected.some(
          (reference) =>
            current.hash !== reference.messageHash ||
            (reference.role !== undefined && current.role !== reference.role),
        )
      )
        amended = true;
    }
    return amended;
  }

  private createBarrier(active: ActiveWork) {
    if (!active.barrier) active.barrier = this.deferred();
    return active.barrier;
  }

  /** Resolve owner work before its epoch or ownership can disappear. */
  private settleActiveAuthority(active: ActiveWork | undefined) {
    if (!active) return;
    active.scan = undefined;
    const barrier = active.barrier;
    active.barrier = undefined;
    barrier?.resolve();
  }

  /** Current/amended/incomplete keeps partial scan out of transaction state. */
  private reconcileAuthority(
    pass: CanonicalPass,
  ): "current" | "amended" | "incomplete" {
    if (this.directCanonicalAmendment(pass)) return "amended";
    const active = this.activeObservation;
    if (active) {
      const target: ContextTarget = {
        id: active.observation.id,
        includeTarget: false,
      };
      const scanned = this.scanContext(pass, active.scan, target);
      if (!scanned.complete) {
        active.scan = scanned.scan;
        this.createBarrier(active);
        return "incomplete";
      }
      const changed = !this.sameContext(
        active.requestContext.map((observation) => ({
          entryId: observation.id,
          messageHash: observation.hash,
          role: observation.role,
        })),
        scanned.context,
      );
      this.settleActiveAuthority(active);
      return changed ? "amended" : "current";
    }
    const pending = this.state.pending;
    if (!pending) return "current";
    const target: ContextTarget = {
      id: pending.observation.entryId,
      includeTarget: false,
    };
    const scanned = this.scanContext(pass, this.pendingScan, target);
    if (!scanned.complete) {
      this.pendingScan = scanned.scan;
      return "incomplete";
    }
    this.pendingScan = undefined;
    return this.sameContext(pending.journal.gate.context, scanned.context)
      ? "current"
      : "amended";
  }

  private advanceActiveAuthority(active: ActiveWork) {
    if (this.activeObservation !== active || active.epoch !== this.epoch)
      return;
    const pass = this.beginCanonicalPass();
    const authority = this.reconcileAuthority(pass);
    if (authority === "amended") this.resetForCanonicalAmendment();
    else if (authority === "incomplete") this.scheduleCanonicalWake();
    else this.reconcileHealthCards(pass);
    this.publish();
  }

  /** Drop stale derived evidence before replaying a canonically amended branch. */
  private resetForCanonicalAmendment() {
    const sourceId = this.state.sourceId;
    const wasEnabled = this.enabled;
    this.disableRuntime();
    this.resetState(sourceId, false);
    this.latchHistoricalCatchup = true;
    this.activity = "Idle";
    if (wasEnabled) {
      this.enabled = true;
      this.gateway.enable(this.identity());
      this.healthGateway.enable(this.identity());
      this.activityGateway.enable(this.identity());
      this.detailGateway.enable(this.identity());
      this.correctionGateway.enable(this.identity());
      this.visibilityGateway.enable(this.visibilityIdentity());
      // Rebuild from current canonical branch after discarding stale semantics.
      this.requeue(this.beginCanonicalPass(), true);
      this.drain();
    }
    this.save();
    this.publish();
  }

  /** Read one bounded chronological page. Page-full waits for cursor progress. */
  private loadPage(
    pass: CanonicalPass,
    after?: { id: string; hash: string },
    historical = false,
  ) {
    const sameAnchor = this.pageFrontier?.anchorId === after?.id;
    if (!sameAnchor) {
      this.page = [];
      this.pageBytes = 0;
      this.pageFrontier = undefined;
    }
    const result = pass.page(
      after,
      this.pageFrontier,
      this.page,
      this.pageBytes,
    );
    if (!result.afterValid) return false;
    if (result.invalidated) {
      this.page = [];
      this.pageBytes = 0;
    }
    this.page.push(...result.page);
    this.pageBytes += result.page.reduce(
      (total, observation) => total + Buffer.byteLength(observation.text),
      0,
    );
    this.pageFrontier = result.frontier;
    const history =
      historical || this.latchHistoricalCatchup || this.catchingUp;
    if (history && result.progress === "terminal" && !this.catchupTarget) {
      const target = this.page.at(-1);
      if (target) this.catchupTarget = { id: target.id, hash: target.hash };
    }
    this.latchHistoricalCatchup = false;
    this.catchingUp =
      !!this.catchupTarget ||
      (history &&
        (result.progress === "scan-needed" ||
          (result.progress === "page-full" && this.page.length > 0)));
    if (
      result.progress === "scan-needed" &&
      !this.page.length &&
      !this.processing
    )
      this.scheduleCanonicalWake();
    return true;
  }

  /** Restore callbacks require complete context; control work drains it first. */
  private rehydratePreceding(
    pass: CanonicalPass,
    entryId: string | undefined,
    includeTarget = false,
  ) {
    if (!entryId) return [];
    const result = pass.precedingResult(entryId, includeTarget);
    if (!result.complete)
      throw new Error("Canonical preceding context requires continuation");
    return result.context;
  }

  private resolveObservation(pass: CanonicalPass, entryId: string) {
    return pass.observation(entryId);
  }

  private requeue(pass: CanonicalPass, historical = false) {
    if (this.controlWork || this.waitingForWake) return;
    if (this.blockedPending && !this.state.pending) {
      this.queued = [];
      return;
    }
    if (this.retryObservation) {
      const current = this.resolveObservation(pass, this.retryObservation.id);
      if (
        !current ||
        current.hash !== this.retryObservation.hash ||
        current.role !== this.retryObservation.role
      ) {
        this.resetForCanonicalAmendment();
        this.loadPage(pass, undefined, true);
        this.queued = [...this.page];
      } else this.queued = [current];
      return;
    }
    const pending = this.state.pending?.observation;
    if (pending) {
      if (
        this.blockedPending?.id === pending.entryId &&
        this.blockedPending.hash === pending.messageHash
      ) {
        this.queued = [];
        return;
      }
      const current = this.resolveObservation(pass, pending.entryId);
      if (
        !current ||
        current.hash !== pending.messageHash ||
        current.role !== pending.role
      ) {
        this.resetForCanonicalAmendment();
        this.loadPage(pass, undefined, true);
        this.queued = [...this.page];
      } else this.queued = [current];
      return;
    }
    const cursor = this.state.cursor;
    if (!this.loadPage(pass, cursor, historical)) {
      this.resetForCanonicalAmendment();
      this.loadPage(pass, undefined, true);
    }
    this.queued = [...this.page];
  }

  private newActivityBatch(calls: readonly ActivityCall[]): ActivityBatch {
    return {
      token: ++this.nextActivityToken,
      epoch: this.epoch,
      calls: calls.map((call) => ({
        callId: call.callId,
        member: { ...call.member },
      })),
    };
  }

  /** Activity is optional and ephemeral: clear it without touching semantic state. */
  private clearActivity(cancel = true) {
    this.nextActivityToken++;
    this.activityDeclaration = undefined;
    this.activityQueued = undefined;
    this.activityFocus = undefined;
    this.activitySupersedesSemantic = false;
    if (cancel) this.activityGateway.invalidate();
    this.activityFlight = undefined;
  }

  /** Exact saturated usage/timestamp proof for one optional dispatch; no eviction/limit marker. */
  private admitActivity() {
    if (this.state.capacity === "limit") return false;
    try {
      return (
        this.capacityEnvelope("health", this.state, undefined, 0, 1).maximum <=
        MAX_CHECKPOINT_BYTES
      );
    } catch {
      return false;
    }
  }

  /** Canonical tracking must finish before optional activity can spend a request. */
  private hasCanonicalWork() {
    return (
      !!this.controlWork ||
      this.processing ||
      !!this.activeObservation ||
      this.queued.length > 0 ||
      this.waitingForWake ||
      !!this.retryTimer
    );
  }

  /** Exact runtime identity avoids stale INPROG after close/revision/source edits. */
  private currentActivityFocusTaskId() {
    const focus = this.activityFocus;
    const task = focus
      ? this.state.tasks.find(
          (candidate) =>
            candidate.id === focus.id &&
            candidate.label === focus.label &&
            candidate.revision === focus.revision &&
            candidate.included &&
            candidate.status !== "done",
        )
      : undefined;
    return task?.id;
  }

  private activityCandidates() {
    return this.state.tasks
      .filter((task) => task.included && task.status !== "done")
      .map((task) => ({
        id: task.id,
        label: task.label,
        revision: task.revision,
      }));
  }

  private activityBatchCurrent(batch: ActivityBatch) {
    return (
      this.enabled &&
      batch.epoch === this.epoch &&
      batch.token === this.nextActivityToken
    );
  }

  private scheduleActivity(batch: ActivityBatch) {
    if (!this.activityBatchCurrent(batch)) return;
    if (this.activityFlight) {
      this.activityQueued = batch;
      return;
    }
    // Canonical admission/completion owns this epoch. Optional activity is
    // obsolete here rather than paid, queued, or retried behind semantic work.
    if (this.hasCanonicalWork()) {
      if (this.activityBatchCurrent(batch)) {
        this.activityFocus = undefined;
        this.activitySupersedesSemantic = false;
        this.publish();
      }
      return;
    }
    if (!this.admitActivity()) {
      if (this.activityBatchCurrent(batch)) {
        this.activityFocus = undefined;
        this.activitySupersedesSemantic = false;
        this.publish();
      }
      return;
    }
    this.activityFlight = batch;
    void this.processActivity(batch);
  }

  private async processActivity(batch: ActivityBatch) {
    try {
      const candidates = this.activityCandidates();
      if (!this.activityBatchCurrent(batch) || !candidates.length) return;
      batch.candidates = candidates.map((candidate) => ({ ...candidate }));
      const request = activityFocusRequest(
        batch.calls.map((call) => call.member),
        batch.candidates,
      );
      const result = await this.activityGateway.evaluate(
        request,
        this.identity(),
        true,
      );
      if (result) {
        // Accepted responses retain usage even when their display generation went stale.
        this.usage.jev.inputTokens = saturatingAdd(
          this.usage.jev.inputTokens,
          result.usage.input_tokens,
        );
        this.usage.jev.outputTokens = saturatingAdd(
          this.usage.jev.outputTokens,
          result.usage.output_tokens,
        );
        this.save();
      }
      if (!this.activityBatchCurrent(batch)) return;
      const answer = result?.answers.activityFocus;
      const probability =
        answer?.type === "choice"
          ? (answer.probabilities[answer.choice] ?? 0)
          : 0;
      const accepted =
        answer?.type === "choice" &&
        answer.confidence >= 0.5 &&
        probability >= 0.8;
      const selected =
        accepted && !["none", "concurrent", "uncertain"].includes(answer.choice)
          ? batch.candidates?.find((task) => task.id === answer.choice)
          : undefined;
      const current = selected
        ? this.state.tasks.find(
            (task) =>
              task.id === selected.id &&
              task.label === selected.label &&
              task.revision === selected.revision &&
              task.included &&
              task.status !== "done",
          )
        : undefined;
      this.activityFocus = current
        ? { id: current.id, label: current.label, revision: current.revision }
        : undefined;
      // An accepted abstention or threshold abstention still supersedes stale INPROG.
      this.activitySupersedesSemantic = true;
      this.publish();
    } catch {
      if (this.activityBatchCurrent(batch)) {
        this.activityFocus = undefined;
        this.activitySupersedesSemantic = false;
        this.note("jev-unavailable");
        this.publish();
      }
    } finally {
      if (this.activityFlight === batch) this.activityFlight = undefined;
      const queued = this.activityQueued;
      this.activityQueued = undefined;
      if (queued) this.scheduleActivity(queued);
    }
  }

  private visibilityIdentity() {
    return `${this.identity()}:visibility:${this.visibility.snapshot().generation}`;
  }

  /** Optional visibility may run only after all semantic/advisory admission is quiet. */
  private visibilityReady() {
    return (
      this.enabled &&
      !this.controlWork &&
      !this.processing &&
      !this.queued.length &&
      !this.waitingForWake &&
      !this.retryTimer &&
      !this.state.pending &&
      !this.pendingScan &&
      !this.canonicalWakeTimer &&
      this.correctionActive === 0 &&
      this.correctionGateway.status !== "Pending"
    );
  }

  private visibilityTasks(): VisibilityTask[] | undefined {
    const tasks = this.state.tasks
      .filter((task) => task.included)
      .map((task) => ({
        id: task.id,
        label: task.label,
        revision: task.revision,
        sourceDigest: visibilityTaskSourceDigest(task),
      }));
    return tasks.length > 0 && tasks.length <= 20 ? tasks : undefined;
  }

  /**
   * Copy exact current generic child status as reported facts only. This cannot
   * affect settlement, parent health, corrections, or task authority.
   */
  private reconciliationSubtasks(): ReconciliationSubtaskSummary[] {
    const parents = new Map(
      this.state.tasks.flatMap((task) =>
        task.included && task.status !== "done"
          ? [[task.id, task] as const]
          : [],
      ),
    );
    const access = this.subtaskAccessSnapshot();
    const summaries: ReconciliationSubtaskSummary[] = [];
    const parentIds = new Set<string>();
    const groupIds = new Set<string>();
    let trackedChildren = 0;

    for (const group of this.subtaskSnapshot().groups) {
      const parent = parents.get(group.parentTaskId);
      if (
        !parent ||
        parent.revision !== group.parentRevision ||
        parentIds.has(group.parentTaskId) ||
        groupIds.has(group.id) ||
        group.children.length > 64 ||
        summaries.length >= 20 ||
        trackedChildren + group.children.length > 200
      )
        continue;

      let reportedCompleted = 0;
      let reportedBlocked = 0;
      let pending = 0;
      for (const child of group.children) {
        if (child.status === "reported-completed") reportedCompleted += 1;
        else if (child.status === "reported-blocked") reportedBlocked += 1;
        else if (child.status === "pending") pending += 1;
        else {
          pending = -1;
          break;
        }
      }
      if (pending < 0) continue;

      const knownTotal = group.knownTotal;
      if (
        (knownTotal !== undefined &&
          (!Number.isSafeInteger(knownTotal) || knownTotal < 0)) ||
        (group.complete
          ? knownTotal !== undefined && knownTotal !== group.children.length
          : knownTotal !== undefined && knownTotal < group.children.length)
      )
        continue;

      const open = group.children.filter(
        (child) => child.status !== "reported-completed",
      );
      const observedAccess = this.reconciliationObservedAccess(group, access);
      summaries.push({
        parentTaskId: group.parentTaskId,
        parentRevision: group.parentRevision,
        groupId: group.id,
        listRevision: group.listRevision,
        complete: group.complete,
        ...(knownTotal === undefined ? {} : { knownTotal }),
        reportedCompleted,
        reportedBlocked,
        pending,
        ...(observedAccess === undefined ? {} : { observedAccess }),
        gaps: open.slice(0, 3).map((child) => child.label),
        omittedChildren: open.length - Math.min(open.length, 3),
      });
      parentIds.add(group.parentTaskId);
      groupIds.add(group.id);
      trackedChildren += group.children.length;
    }
    return summaries;
  }

  /** Count only exact current C04 observed links; unavailable is never zero. */
  private reconciliationObservedAccess(
    group: SubtaskSnapshot["groups"][number],
    access: SubtaskAccessSnapshot,
  ): number | undefined {
    const matches = access.groups.filter(
      (candidate) =>
        candidate.groupId === group.id &&
        candidate.parentTaskId === group.parentTaskId &&
        candidate.parentRevision === group.parentRevision &&
        candidate.listRevision === group.listRevision,
    );
    const candidate = matches.length === 1 ? matches[0] : undefined;
    if (
      !candidate ||
      candidate.children.length !== group.children.length ||
      !candidate.children.every(
        (child, index) =>
          child.childId === group.children[index]?.id &&
          (child.status === "observed" ||
            child.status === "no-observation" ||
            child.status === "unavailable"),
      )
    )
      return;
    const observed = candidate.children.filter(
      (child) => child.status === "observed",
    ).length;
    return observed > 0 ? observed : undefined;
  }

  /**
   * Copy only still-open exact MAYBE task receipts into the established
   * reconciliation snapshot. Generic semantic replies never clear them: no
   * semantic reducer is an ownership validator for a reported activity.
   */
  private visibilityUncertainActivities(): ReconciliationUncertainActivity[] {
    const current = new Map(
      (this.visibilityTasks() ?? []).map((task) => [task.id, task]),
    );
    const open = new Set(
      this.state.tasks
        .filter((task) => task.included && task.status !== "done")
        .map((task) => task.id),
    );
    return this.visibility
      .maybeAssociations()
      .flatMap((activity) => {
        const task = current.get(activity.task.id);
        if (
          !task ||
          !open.has(task.id) ||
          task.label !== activity.task.label ||
          task.revision !== activity.task.revision ||
          task.sourceDigest !== activity.task.sourceDigest
        )
          return [];
        return [
          {
            id: activity.id,
            quote: activity.quote,
            taskId: task.id,
            taskLabel: task.label,
            revision: task.revision,
            confidence: activity.assessment.confidence,
            probability: activity.assessment.probability,
          },
        ];
      })
      .slice(0, 8);
  }

  private visibilityPhase(
    toolName: string,
    args: unknown,
  ): VisibilityToolPhase {
    if (["read", "grep", "find", "search"].includes(toolName))
      return "Inspecting code";
    if (["edit", "write"].includes(toolName)) return "Editing code";
    if (toolName !== "bash") return "Using a tool";
    const command = record(args)?.command;
    if (typeof command !== "string") return "Using a tool";
    const first = command.trim().split(/\s+/, 1)[0] ?? "";
    if (
      ["bun", "npm", "pnpm", "yarn", "vitest", "jest", "pytest"].includes(
        first,
      ) &&
      /(?:^|\s)(?:test|vitest|jest|pytest)(?:\s|$)/.test(command)
    )
      return "Running test command";
    if (
      ["make", "bun", "npm", "pnpm", "yarn"].includes(first) &&
      /(?:^|\s)(?:build|compile)(?:\s|$)/.test(command)
    )
      return "Running build command";
    return "Using a tool";
  }

  private visibilityFrontier(
    branch?: readonly unknown[],
  ): VisibilityCanonicalFrontier | undefined {
    if (branch) return this.frontierFor(new CanonicalPass(branch));
    return this.visibilityCanonicalFrontier
      ? { ...this.visibilityCanonicalFrontier }
      : undefined;
  }

  private frontierFor(pass: CanonicalPass): VisibilityCanonicalFrontier {
    const headers = pass.headers.map((header) => [header.id, header.role]);
    const last = pass.headers.at(-1);
    return {
      length: headers.length,
      digest: sha256(JSON.stringify(headers)),
      ...(last ? { lastId: last.id, lastRole: last.role } : {}),
    };
  }

  /** Cache only a canonical frontier for one-argument test/host fallback. */
  private rememberVisibilityFrontier(pass: CanonicalPass): void {
    this.visibilityCanonicalFrontier = this.frontierFor(pass);
  }

  private visibilityCanonicalAfter(
    pass: CanonicalPass,
    frontier: VisibilityCanonicalFrontier,
  ) {
    if (pass.headers.length <= frontier.length) return;
    const prefix = pass.headers
      .slice(0, frontier.length)
      .map((header) => [header.id, header.role]);
    if (sha256(JSON.stringify(prefix)) !== frontier.digest) return;
    const header = pass.headers
      .slice(frontier.length)
      .reverse()
      .find((candidate) => candidate.role === "assistant");
    return header ? pass.observation(header.id) : undefined;
  }

  /** Retain confirmed history while removing stale provisional current/Stage 1. */
  private supersedeVisibilityMessage() {
    const prior = this.visibilityLatestToken;
    this.visibility.supersede();
    this.visibilityLatestToken = undefined;
    this.visibilityStage1 = undefined;
    if (this.visibilityFlight?.stage === 1) this.dropVisibilityFlight();
    if (prior && !this.visibilitySources.get(prior)?.confirmed)
      this.visibilitySources.delete(prior);
  }

  private terminalVisibilityStage2(token: string) {
    const source = this.visibilitySources.get(token);
    if (source) source.stage2 = "terminal";
    this.visibilityStage2 = this.visibilityStage2.filter((id) => id !== token);
  }

  private dropVisibilitySource(token: string) {
    const source = this.visibilitySources.get(token);
    if (source) source.stage2 = "terminal";
    if (this.visibilityFlight?.token === token) this.dropVisibilityFlight();
    this.visibilitySources.delete(token);
    if (this.visibilityLatestToken === token)
      this.visibilityLatestToken = undefined;
    if (this.visibilityStage1 === token) this.visibilityStage1 = undefined;
    this.visibilityStage2 = this.visibilityStage2.filter((id) => id !== token);
    this.visibility.markIncomplete();
  }

  private resetVisibility() {
    this.visibilityGateway.pause();
    this.visibility.reset();
    this.visibilitySources.clear();
    this.visibilityCanonicalFrontier = undefined;
    this.visibilityLatestToken = undefined;
    this.visibilityStage1 = undefined;
    this.visibilityStage2 = [];
    this.visibilityFlight = undefined;
  }

  /** Cancel optional work without retries when a newer mandatory boundary wins. */
  private dropVisibilityFlight() {
    const flight = this.visibilityFlight;
    if (!flight) return;
    if (flight.stage === 2) this.terminalVisibilityStage2(flight.token);
    this.visibilityGateway.invalidate();
    this.visibility.markIncomplete();
    this.visibilityFlight = undefined;
  }

  private enqueueVisibilityStage2(token: string) {
    const source = this.visibilitySources.get(token);
    if (source?.stage2 !== "unseen") return;
    if (this.visibilityStage2.length >= 4) {
      const dropped = this.visibilityStage2.shift();
      if (dropped) this.dropVisibilitySource(dropped);
      this.visibility.markIncomplete();
    }
    source.stage2 = "queued";
    this.visibilityStage2.push(token);
  }

  private visibilityFlightCurrent(flight: VisibilityFlight) {
    return (
      this.visibilityFlight === flight &&
      flight.epoch === this.epoch &&
      flight.generation === this.visibility.snapshot().generation &&
      this.enabled
    );
  }

  private drainVisibility() {
    if (!this.visibilityReady() || this.visibilityFlight) return;
    const stage1 = this.visibilityStage1;
    if (stage1) {
      this.visibilityStage1 = undefined;
      const source = this.visibilitySources.get(stage1);
      const request = source && buildLabelSelectionRequest(source.bundle);
      if (
        !source ||
        !request ||
        this.visibility.snapshot().budgetRemaining < 1
      ) {
        this.visibility.markIncomplete();
        this.publish();
        return;
      }
      const flight: VisibilityFlight = {
        token: stage1,
        stage: 1,
        epoch: this.epoch,
        generation: this.visibility.snapshot().generation,
      };
      this.visibilityFlight = flight;
      void this.runVisibilityStage1(flight, request);
      return;
    }
    const stage2 = this.visibilityStage2.shift();
    if (!stage2) return;
    const source = this.visibilitySources.get(stage2);
    if (source?.stage2 !== "queued") {
      this.terminalVisibilityStage2(stage2);
      this.visibility.markIncomplete();
      this.publish();
      return;
    }
    const tasks = this.visibilityTasks();
    const request =
      source.confirmed && source.selections && tasks
        ? buildLabelBindingRequest(
            source.bundle,
            source.selections,
            tasks,
            source.bundle.messageHash,
          )
        : undefined;
    if (!tasks || !request || this.visibility.snapshot().budgetRemaining < 1) {
      this.terminalVisibilityStage2(stage2);
      this.visibility.markIncomplete();
      this.publish();
      return;
    }
    source.stage2 = "in-flight";
    const flight: VisibilityFlight = {
      token: stage2,
      stage: 2,
      epoch: this.epoch,
      generation: this.visibility.snapshot().generation,
    };
    this.visibilityFlight = flight;
    void this.runVisibilityStage2(flight, request, tasks);
  }

  private async runVisibilityStage1(
    flight: VisibilityFlight,
    request: EvaluationRequest,
  ) {
    try {
      const result = await this.visibilityGateway.evaluate(
        request,
        this.visibilityIdentity(),
      );
      if (!this.visibilityFlightCurrent(flight)) return;
      if (!result) {
        this.visibility.markIncomplete();
        return;
      }
      this.visibility.recordUsage(result.usage);
      const source = this.visibilitySources.get(flight.token);
      if (!source) {
        this.visibility.markIncomplete();
        return;
      }
      const selections = readLabelSelections(source.bundle, result);
      source.selections = selections;
      this.visibility.acceptSelections(flight.token, selections);
      if (source.confirmed) this.enqueueVisibilityStage2(flight.token);
    } finally {
      if (this.visibilityFlight === flight) this.visibilityFlight = undefined;
      this.publish();
      this.drainVisibility();
    }
  }

  private async runVisibilityStage2(
    flight: VisibilityFlight,
    request: EvaluationRequest,
    tasks: readonly VisibilityTask[],
  ) {
    try {
      const result = await this.visibilityGateway.evaluate(
        request,
        this.visibilityIdentity(),
      );
      if (!this.visibilityFlightCurrent(flight)) return;
      if (!result) {
        this.visibility.markIncomplete();
        return;
      }
      this.visibility.recordUsage(result.usage);
      const source = this.visibilitySources.get(flight.token);
      if (!source?.selections) {
        this.visibility.markIncomplete();
        return;
      }
      const currentTasks = this.visibilityTasks();
      this.visibility.acceptBindings(
        flight.token,
        readLabelBindings(source.selections, tasks, result),
        currentTasks ?? [],
      );
    } finally {
      this.terminalVisibilityStage2(flight.token);
      if (this.visibilityFlight === flight) this.visibilityFlight = undefined;
      this.publish();
      this.drainVisibility();
    }
  }

  private drain() {
    if (
      !this.enabled ||
      this.processing ||
      this.waitingForWake ||
      this.retryTimer
    )
      return;
    const observation = this.queued[0];
    if (observation) {
      const epoch = this.epoch;
      // Canonical work preempts optional activity before durable semantic admission.
      this.dropVisibilityFlight();
      this.clearActivity();
      // Any newly processed canonical work invalidates retained idle completion.
      this.idleDoneInvalidated = true;
      this.processing = true;
      const active: ActiveWork = {
        observation: { ...observation },
        epoch,
        requestContext: this.settledContext.map((item) => ({ ...item })),
      };
      this.activeObservation = active;
      this.setActivity("Analyzing progress");
      void this.processOne(active);
      return;
    }
    this.drainVisibility();
    // Ready health is older than optional details. Parked/paused health is not.
    const health = this.nextReadyHealthJob();
    if (health && !this.healthFlight) {
      health.state = "in-flight";
      health.lastAttemptWake = this.healthWake;
      const healthWork = health.work;
      const flight: HealthFlight = {
        epoch: healthWork.epoch,
        token: ++this.nextHealthToken,
        taskId: healthWork.taskId,
        work: healthWork,
      };
      this.healthFlight = flight;
      void this.processHealth(healthWork, flight);
      return;
    }
    if (this.healthFlight) return;
    const detail = this.nextDetailWork();
    if (
      detail &&
      this.hasSubtaskWork() &&
      this.subtaskOptionalTurn === "detail" &&
      this.startDetails(detail)
    ) {
      this.subtaskOptionalTurn = "subtask";
      return;
    }
    if (this.drainSubtasks()) {
      this.subtaskOptionalTurn = "detail";
      return;
    }
    if (detail) this.startDetails(detail);
  }

  private startDetails(detail: TaskDetailRecord) {
    if (this.detailFlight) return false;
    const flight = {
      epoch: this.epoch,
      token: ++this.nextDetailToken,
      taskId: detail.taskId,
    };
    this.detailFlight = flight;
    void this.processDetails(detail, flight);
    return true;
  }

  private rememberPreceding(
    requestContext: readonly Observation[],
    observation: Observation,
  ) {
    const context: Observation[] = [];
    let bytes = 0;
    for (const candidate of [...requestContext, observation]
      .slice(-2)
      .reverse()) {
      const size = Buffer.byteLength(JSON.stringify(candidate));
      if (bytes + size > 4 * 1024) break;
      context.unshift(candidate);
      bytes += size;
    }
    this.settledContext = context;
  }

  private async processOne(active: ActiveWork) {
    const { observation, epoch, requestContext } = active;
    const priorTasks = this.state.tasks.map((task) => structuredClone(task));
    try {
      const produced = await processObservation(
        this.state,
        observation,
        {
          admit: (plan) => this.admit(plan),
          evaluate: (request) => this.evaluateJev(request, epoch, active),
          extract: (input) => this.extract(input, epoch, active),
          save: (state, options) => this.commit(state, options),
        },
        requestContext,
      );
      const next = this.retainUnchangedTaskAssessments(produced, priorTasks);
      if (!this.enabled || epoch !== this.epoch) return;
      this.commit(next);
      if (next.capacity === "limit") {
        this.blockedPending = { id: observation.id, hash: observation.hash };
        this.note("capacity-exhausted");
        return;
      }
      if (
        next.cursor?.id === observation.id &&
        next.cursor.hash === observation.hash
      ) {
        this.blockedPending = undefined;
        if (
          this.retryObservation?.id === observation.id &&
          this.retryObservation.hash === observation.hash
        )
          this.retryObservation = undefined;
        // Cursor progression, including overflow, owns bounded context parity.
        this.rememberPreceding(requestContext, observation);
        // Generic subtasks are woken in `finally`, after `processing` clears.
        // They share no parent-task extraction or tool prerequisite.
        // Historical coverage remains inert during generic live cutover.
        // A named committed cursor wake permits parked optional jobs.
        this.parkedDetails.clear();
        this.rebuildDetailValues();
        if (
          this.catchupTarget?.id === observation.id &&
          this.catchupTarget.hash === observation.hash
        ) {
          this.catchupTarget = undefined;
          this.catchingUp = false;
        }
        if (next.scopeFailure === "overflow") this.note("unresolved-overflow");
        else {
          if (next.scopeFailure === "invalid")
            this.note("invalid-scope-result");
          this.scheduleHealth(observation, priorTasks);
        }
        return;
      }
      if (next.pending?.block.present) {
        this.blockedPending = { id: observation.id, hash: observation.hash };
        this.note(
          next.pending.block.value === "input-overflow"
            ? "unresolved-overflow"
            : next.pending.block.value === "invalid-patch"
              ? "invalid-scope-result"
              : "capacity-exhausted",
        );
        return;
      }
      if (
        next.completionError ||
        next.scopeFailure === "capacity" ||
        next.scopeFailure === "overflow"
      ) {
        this.blockedPending = { id: observation.id, hash: observation.hash };
        this.note(
          next.scopeFailure === "capacity" || next.completionError
            ? "capacity-exhausted"
            : "unresolved-overflow",
        );
      }
    } catch (error) {
      if (!this.enabled || epoch !== this.epoch) return;
      if (error instanceof DurabilityCapacityError) {
        this.blockedPending = { id: observation.id, hash: observation.hash };
        this.note("capacity-exhausted");
      } else if (error instanceof RetryableJevError)
        this.scheduleRetry(observation);
      else if (error instanceof RetryableProviderError) {
        this.waitingForWake = true;
        this.note("model-unavailable");
      } else this.note("invalid-scope-result");
    } finally {
      this.processing = false;
      if (this.activeObservation === active) {
        this.settleActiveAuthority(active);
        this.activeObservation = undefined;
      }
      if (epoch === this.epoch && !this.controlWork) {
        this.activity = "Idle";
        const pass = this.beginCanonicalPass();
        const authority = this.reconcileAuthority(pass);
        if (authority === "amended") this.resetForCanonicalAmendment();
        else if (authority === "incomplete") this.scheduleCanonicalWake();
        else {
          this.reconcileHealthCards(pass);
          this.reconcileTaskDetails(pass);
          this.requeue(pass);
          if (this.queued.length)
            this.invalidateSubtaskWork(
              this.subtaskFlightIsReport &&
                this.preserveOversizedReportFlight(pass),
            );
          else this.wakeSubtasks(pass, true);
        }
        this.publish();
      }
      this.drain();
    }
  }

  /** A no-op mandatory assessment cannot mutate parent task presentation. */
  private retainUnchangedTaskAssessments(
    next: HybridState,
    previousTasks: readonly HybridTask[],
  ): HybridState {
    const previous = new Map(previousTasks.map((task) => [task.id, task]));
    return {
      ...next,
      tasks: next.tasks.map((task) => {
        const prior = previous.get(task.id);
        if (
          !prior ||
          prior.label !== task.label ||
          prior.kind !== task.kind ||
          prior.basis !== task.basis ||
          prior.status !== task.status ||
          prior.included !== task.included ||
          prior.revision !== task.revision ||
          !sameSource(prior.source, task.source)
        )
          return task;
        const retained = { ...task };
        if (prior.latestAssessment)
          retained.latestAssessment = structuredClone(prior.latestAssessment);
        else delete retained.latestAssessment;
        return retained;
      }),
    };
  }

  private nextDetailWork() {
    if (
      !this.options.richDetailsEnabled ||
      !this.enabled ||
      this.processing ||
      this.queued.length ||
      this.state.pending ||
      !this.state.cursor
    )
      return;
    return [...this.taskDetails.values()].find(
      (record) =>
        !this.parkedDetails.has(record.taskId) &&
        uncoveredDetailKeys(record).length > 0 &&
        !!this.state.tasks.find((task) =>
          detailRecordMatchesTask(record, task),
        ),
    );
  }

  private maximumDetailRecord(record: TaskDetailRecord): TaskDetailRecord {
    const uncovered = uncoveredDetailKeys(record);
    if (!uncovered.length) return copyDetailRecord(record);
    // Every remaining key can require its own request/receipt. Model the
    // longest legal normalized assessment, not a short accepted yes/1 shape.
    const maximumAssessment = (key: (typeof uncovered)[number]) => {
      const candidate = record.candidates.find((item) => item.key === key);
      if (!candidate) throw new Error("Missing detail candidate");
      const source = candidate.source;
      return {
        rawChoice: "uncertain",
        // JSON keeps decimal notation at this magnitude, making this a longer
        // legal unit scalar than ordinary 0.1/1 response values.
        confidence: 0.0000012345678901234567,
        probability: 0.0000012345678901234567,
        reason: "threshold-abstention" as const,
        source: {
          entryId: source.entryId,
          messageHash: source.messageHash,
          role: source.role,
        },
      };
    };
    return {
      ...copyDetailRecord(record),
      receipts: [
        ...record.receipts,
        ...uncovered.map((key) => ({
          requestHash: "f".repeat(64),
          candidateKeys: [key],
          assessments: [maximumAssessment(key)],
          validatedAt: Number.MAX_SAFE_INTEGER,
        })),
      ],
    };
  }

  /** Optional detail admission never changes semantic capacity or wait state. */
  private admitDetails(record: TaskDetailRecord) {
    if (!this.options.richDetailsEnabled || this.state.capacity === "limit")
      return false;
    const candidate = new Map(this.taskDetails);
    candidate.set(record.taskId, this.maximumDetailRecord(record));
    try {
      const metadata = this.capacityMetadata(
        undefined,
        this.healthCards,
        this.state,
        undefined,
        candidate,
      );
      if (subtaskCheckpointBytes(this.state, metadata) <= MAX_CHECKPOINT_BYTES)
        return true;
    } catch {
      // Optional records need a full exact storage proof before dispatch.
    }
    this.note("detail-capacity-skipped");
    this.publish();
    return false;
  }

  private async processDetails(
    record: TaskDetailRecord,
    flight: { epoch: number; token: number; taskId: string },
  ) {
    try {
      const pass = this.beginCanonicalPass();
      const authority = this.reconcileAuthority(pass);
      if (authority === "amended") {
        this.resetForCanonicalAmendment();
        return;
      }
      if (authority === "incomplete") {
        this.parkedDetails.add(record.taskId);
        this.scheduleCanonicalWake();
        return;
      }
      this.reconcileTaskDetails(pass);
      const current = this.taskDetails.get(record.taskId);
      const task = this.state.tasks.find((item) => item.id === record.taskId);
      if (
        !current ||
        !task ||
        !detailRecordMatchesTask(current, task) ||
        this.detailFlight !== flight ||
        !this.enabled ||
        flight.epoch !== this.epoch
      )
        return;
      const remaining = uncoveredDetailKeys(current);
      let keys = remaining;
      let request: EvaluationRequest | undefined;
      // A valid task may need several bounded receipts. Preserve candidate order
      // and select the largest nonempty prefix that fits without truncating text.
      while (keys.length && !request) {
        request = taskDetailRequest(current, keys, (entryId) =>
          this.resolveObservation(pass, entryId),
        );
        if (!request) keys = keys.slice(0, -1);
      }
      if (
        !request ||
        !isDetailRequest(request) ||
        detailQuestionKeys(request).length !== keys.length ||
        !this.admitDetails(current)
      ) {
        this.parkedDetails.add(current.taskId);
        return;
      }
      const result = await this.detailGateway.evaluate(
        request,
        this.identity(),
        true,
      );
      if (
        !result ||
        this.detailFlight !== flight ||
        !this.enabled ||
        flight.epoch !== this.epoch
      ) {
        this.parkedDetails.add(current.taskId);
        return;
      }
      const receipt = detailReceipt(current, request, result, Date.now());
      if (!receipt) {
        this.parkedDetails.add(current.taskId);
        return;
      }
      const updated: TaskDetailRecord = {
        ...copyDetailRecord(current),
        receipts: [...current.receipts, receipt],
      };
      const previousDetails = this.taskDetails;
      const previousValues = this.detailValues;
      const previousInputTokens = this.usage.jev.inputTokens;
      const previousOutputTokens = this.usage.jev.outputTokens;
      this.taskDetails = new Map(previousDetails);
      this.taskDetails.set(updated.taskId, updated);
      this.rebuildDetailValues(pass);
      this.usage.jev.inputTokens = saturatingAdd(
        previousInputTokens,
        result.usage.input_tokens,
      );
      this.usage.jev.outputTokens = saturatingAdd(
        previousOutputTokens,
        result.usage.output_tokens,
      );
      try {
        // This optional transaction has no semantic state change. Persist the
        // receipt and accepted tokens as one checkpoint or retain neither.
        encodeSubtaskCheckpoint(
          this.state,
          this.subtaskMetadata(false, this.healthCards, this.state),
        );
        const checkpoint = encodeSubtaskCheckpoint(
          this.state,
          this.subtaskMetadata(this.enabled, this.healthCards, this.state),
        );
        this.persist(checkpoint);
        this.parkedDetails.delete(updated.taskId);
        this.refreshBeads();
        this.publish();
      } catch {
        this.taskDetails = previousDetails;
        this.detailValues = previousValues;
        this.usage.jev.inputTokens = previousInputTokens;
        this.usage.jev.outputTokens = previousOutputTokens;
        this.parkedDetails.add(updated.taskId);
        this.note("saved-state-rejected");
        this.publish();
      }
    } catch {
      // Optional details never influence semantic retry/wait/capacity state.
      this.parkedDetails.add(record.taskId);
    } finally {
      if (this.detailFlight === flight) this.detailFlight = undefined;
      this.drain();
    }
  }

  private healthEvidenceGeneration() {
    return sha256(
      JSON.stringify([this.evidence.snapshot(), this.evidence.codeRevision()]),
    );
  }

  private healthCardMatchesTask(
    card: HealthCard | undefined,
    task: HybridTask,
  ) {
    return (
      !!card &&
      card.taskId === task.id &&
      card.revision === task.revision &&
      card.label === task.label &&
      sameSource(card.provenance.taskSource, task.source)
    );
  }

  /** Exact task identity is independent of semantic/display focus. */
  private healthTaskForWork(work: HealthWork) {
    if (work.epoch !== this.epoch) return;
    const task = this.state.tasks.find(
      (item) =>
        item.id === work.taskId &&
        item.revision === work.revision &&
        item.included &&
        sameSource(item.source, work.taskSource),
    );
    if (!task) return;
    // A valid terminal card is final until lifecycle/source/card loss changes it.
    if (
      task.status === "done" &&
      !work.terminal &&
      this.healthCardMatchesTask(this.healthCards.get(task.id), task)
    )
      return;
    return task;
  }

  private healthWorkCurrent(work: HealthWork, pass: CanonicalPass) {
    const task = this.healthTaskForWork(work);
    if (!task || work.evidenceGeneration !== this.healthEvidenceGeneration())
      return;
    const target = pass.observation(work.observation.id);
    const coverage = target ? pass.healthReportContext(target.id) : undefined;
    if (
      !target ||
      target.hash !== work.observation.hash ||
      target.role !== work.observation.role ||
      !coverage ||
      !sameHealthCoverage(coverageFor(work.reports), coverage)
    )
      return;
    return task;
  }

  private healthTasksForCommit(priorTasks: readonly HybridTask[]) {
    return this.state.tasks.filter((task) => {
      if (!task.included) return false;
      if (task.status !== "done") return true;
      const prior = priorTasks.find((item) => item.id === task.id);
      return (
        !this.healthCardMatchesTask(this.healthCards.get(task.id), task) ||
        (!!prior && prior.included && prior.status !== "done")
      );
    });
  }

  private healthWorkIdentity(work: HealthWork) {
    return sha256(
      JSON.stringify([
        work.epoch,
        work.taskId,
        work.revision,
        work.taskSource,
        observationRef(work.observation),
        work.reports.coverageDigest,
        work.terminal,
        work.evidenceGeneration,
      ]),
    );
  }

  private hasPendingHealthForTask(taskId: string) {
    const job = this.healthJobs.get(taskId);
    return !!job && job.state !== "terminal";
  }

  private pendingHealthTaskIds() {
    return new Set(
      [...this.healthJobs.values()]
        .filter((job) => job.state !== "terminal")
        .map((job) => job.work.taskId),
    );
  }

  /** Parked jobs and real gateway-wide backoff yield to optional details. */
  private nextReadyHealthJob() {
    if (
      this.healthGateway.isPaused ||
      this.healthGateway.retryPending ||
      this.healthBackoffWake === this.healthWake
    )
      return;
    return [...this.healthJobs.values()].find(
      (job) => job.state === "ready" && job.lastAttemptWake !== this.healthWake,
    );
  }

  /** A wake is explicit input, never a health retry timer or polling tick. */
  private wakeHealth(
    _kind: "canonical" | "evidence" | "control",
    reviveTerminal = false,
  ) {
    this.healthWake++;
    const now = Date.now();
    if (this.healthBackoffWake !== undefined) {
      // A pre-deadline event does not consume required post-deadline wake.
      this.healthBackoffWake = this.healthGateway.retryPending
        ? this.healthWake
        : undefined;
    }
    for (const job of this.healthJobs.values()) {
      if (job.state === "parked" && now >= (job.parkedUntil ?? Infinity)) {
        job.state = "ready";
        job.parkedUntil = undefined;
      } else if (
        reviveTerminal &&
        job.state === "terminal" &&
        this.healthTaskForWork(job.work) &&
        !this.healthCardMatchesTask(
          this.healthCards.get(job.work.taskId),
          this.healthTaskForWork(job.work) as HybridTask,
        )
      ) {
        job.state = "ready";
      }
    }
  }

  /** Exact terminal evidence comes from the accepted completion event, never cursor drift. */
  private completionObservationFor(task: HybridTask, pass: CanonicalPass) {
    const event = [...this.state.events]
      .reverse()
      .find(
        (candidate) =>
          candidate.kind === "complete" &&
          candidate.taskId === task.id &&
          candidate.revision === task.revision,
      );
    if (!event) return;
    const observation = pass.observation(event.source.entryId);
    return observation &&
      sameObservation(observationRef(observation), event.source)
      ? observation
      : undefined;
  }

  /** Rebuild only recoverable task-local health on named evidence/control wakes. */
  private wakeHealthFromCurrent(
    kind: "canonical" | "evidence" | "control",
    reviveTerminal = false,
    pass = this.beginCanonicalPass(),
  ) {
    if (!this.enabled) return;
    this.wakeHealth(kind, reviveTerminal);
    this.pruneHealthJobs();
    if (!this.state.tasks.some((task) => task.included)) return;
    const cursor = this.state.cursor;
    const observation =
      cursor && pass.observation(cursor.id)?.hash === cursor.hash
        ? pass.observation(cursor.id)
        : undefined;
    const reports = observation
      ? pass.healthReportContext(observation.id)
      : undefined;
    const evidenceGeneration = this.healthEvidenceGeneration();
    const runtimeEvidence = this.evidence.snapshot();
    const runtimeRevision = this.evidence.codeRevision();
    // [tag:health_runtime_evidence_recovery] Explicit recovery retries changed
    // live evidence, but an empty post-reload store cannot invalidate receipts.
    const runtimeEvidenceHash =
      kind === "control" && (runtimeEvidence.length > 0 || runtimeRevision > 0)
        ? sha256(JSON.stringify(runtimeEvidence))
        : undefined;
    if (
      observation &&
      reports &&
      reports.target.messageHash === observation.hash &&
      reports.target.role === observation.role
    ) {
      for (const task of this.state.tasks) {
        if (!task.included || task.status === "done") continue;
        const card = this.healthCards.get(task.id);
        const job = this.healthJobs.get(task.id);
        const staleCursorCard =
          !!card &&
          !sameObservation(
            card.provenance.observation,
            observationRef(observation),
          );
        if (
          kind === "evidence" ||
          !this.healthCardMatchesTask(card, task) ||
          staleCursorCard ||
          (!!card &&
            runtimeEvidenceHash !== undefined &&
            (card.provenance.evidenceHash !== runtimeEvidenceHash ||
              card.provenance.codeRevision !== runtimeRevision)) ||
          (!!job && job.state !== "terminal")
        )
          this.enqueueHealth(
            this.healthWork(
              task,
              observation,
              reports,
              false,
              evidenceGeneration,
            ),
          );
      }
    }
    // A terminal card is fresh only when its coverage validates against exact
    // completion evidence. Lost queues, stale coverage and absent cards repair
    // from that event rather than a later unrelated cursor.
    for (const task of this.state.tasks) {
      if (!task.included || task.status !== "done") continue;
      const terminal = this.completionObservationFor(task, pass);
      if (!terminal) continue;
      const card = this.healthCards.get(task.id);
      if (
        this.healthCardMatchesTask(card, task) &&
        card &&
        sameObservation(card.provenance.observation, observationRef(terminal))
      )
        continue;
      const terminalReports = pass.healthReportContext(terminal.id);
      if (
        terminalReports &&
        terminalReports.target.messageHash === terminal.hash &&
        terminalReports.target.role === terminal.role
      )
        this.enqueueHealth(
          this.healthWork(
            task,
            terminal,
            terminalReports,
            true,
            evidenceGeneration,
          ),
        );
    }
    this.syncPresentationCard();
  }

  private healthWork(
    task: HybridTask,
    observation: Observation,
    reports: CanonicalHealthReportContext,
    terminal: boolean,
    evidenceGeneration: string,
  ): HealthWork {
    return {
      observation: { ...observation },
      reports: {
        ...reports,
        target: { ...reports.target },
        reports: reports.reports.map((report) => ({ ...report })),
        references: reports.references.map((reference) => ({ ...reference })),
        omissions: [...reports.omissions],
      },
      taskId: task.id,
      revision: task.revision,
      taskSource: { ...task.source },
      terminal,
      epoch: this.epoch,
      evidenceGeneration,
    };
  }

  private pruneHealthJobs() {
    for (const [taskId, job] of this.healthJobs) {
      const task = this.state.tasks.find(
        (item) =>
          item.id === taskId &&
          item.revision === job.work.revision &&
          item.included &&
          sameSource(item.source, job.work.taskSource),
      );
      if (!task || job.work.epoch !== this.epoch)
        this.healthJobs.delete(taskId);
    }
  }

  /** A new task input revokes only that task's live/advisory proof immediately. */
  private admitHealthReplacement(taskId: string) {
    this.currentHealthProofs.delete(taskId);
    this.correctionFacts.delete(taskId);
  }

  /** Queued work keeps its position; a successor to a flight is placed after peers. */
  private enqueueHealth(work: HealthWork) {
    const identity = this.healthWorkIdentity(work);
    const existing = this.healthJobs.get(work.taskId);
    if (existing) {
      if (existing.state === "in-flight") {
        if (existing.identity !== identity) {
          this.admitHealthReplacement(work.taskId);
          existing.successor = work;
        }
        return;
      }
      if (existing.identity === identity) return;
      this.admitHealthReplacement(work.taskId);
      const remainsParked =
        existing.state === "parked" &&
        Number.isFinite(existing.parkedUntil) &&
        Date.now() < (existing.parkedUntil ?? Infinity);
      existing.work = work;
      existing.identity = identity;
      if (remainsParked) return;
      existing.state = "ready";
      existing.parkedUntil = undefined;
      existing.lastAttemptWake = undefined;
      return;
    }
    if (this.healthJobs.size >= 20) return;
    this.admitHealthReplacement(work.taskId);
    this.healthJobs.set(work.taskId, { work, identity, state: "ready" });
  }

  private healthFlightCurrent(flight: HealthFlight, work: HealthWork) {
    const job = this.healthJobs.get(work.taskId);
    return (
      this.healthFlight === flight &&
      job?.state === "in-flight" &&
      job.identity === this.healthWorkIdentity(work) &&
      !job.successor
    );
  }

  /** Every committed observation refreshes open tasks without requiring focus. */
  private scheduleHealth(
    observation: Observation,
    priorTasks: readonly HybridTask[] = [],
  ) {
    // Even an all-done commit is a named wake for parked terminal repair.
    this.wakeHealth("canonical");
    this.pruneHealthJobs();
    const tasks = this.healthTasksForCommit(priorTasks);
    if (!tasks.length) return;
    const pass = this.beginCanonicalPass();
    const reports = pass.healthReportContext(observation.id);
    if (
      !reports ||
      reports.target.messageHash !== observation.hash ||
      reports.target.role !== observation.role
    )
      return;
    const evidenceGeneration = this.healthEvidenceGeneration();
    for (const task of tasks) {
      // A missing terminal card keeps its completion context across preemption.
      const target =
        task.status === "done"
          ? this.completionObservationFor(task, pass)
          : observation;
      if (!target) continue;
      const context =
        target.id === observation.id
          ? reports
          : pass.healthReportContext(target.id);
      if (!context) continue;
      this.enqueueHealth(
        this.healthWork(
          task,
          target,
          context,
          task.status === "done",
          evidenceGeneration,
        ),
      );
    }
    this.syncPresentationCard();
  }

  private settleHealth(flight: HealthFlight, attempt: HealthAttempt) {
    if (this.healthFlight !== flight) return;
    this.healthFlight = undefined;
    const job = this.healthJobs.get(flight.taskId);
    if (
      job?.state !== "in-flight" ||
      job.identity !== this.healthWorkIdentity(flight.work)
    )
      return;
    if (job.successor) {
      const successor = job.successor;
      // A flight's successor is new work, so fair peers run before it.
      this.healthJobs.delete(flight.taskId);
      this.healthJobs.set(flight.taskId, {
        work: successor,
        identity: this.healthWorkIdentity(successor),
        state: "ready",
      });
      return;
    }
    job.state = attempt.kind === "parked" ? "parked" : "terminal";
    job.parkedUntil = attempt.kind === "parked" ? attempt.until : undefined;
    // Completed/failed identities remain deduped, but new input must not let
    // them jump ahead of peers that have not received their first attempt.
    this.healthJobs.delete(flight.taskId);
    this.healthJobs.set(flight.taskId, job);
  }

  private async processHealth(work: HealthWork, flight: HealthFlight) {
    let attempt: HealthAttempt = { kind: "terminal" };
    try {
      const pass = this.beginCanonicalPass();
      const authority = this.reconcileAuthority(pass);
      if (authority === "amended") {
        this.resetForCanonicalAmendment();
        return;
      }
      if (authority === "incomplete") {
        attempt = { kind: "parked", until: Infinity };
        this.scheduleCanonicalWake();
        return;
      }
      this.reconcileHealthCards(pass);
      attempt = await this.assessHealth(flight.epoch, work, flight, pass);
    } catch (error) {
      if (this.healthFlight !== flight) return;
      if (error instanceof RetryableJevError) this.note("jev-unavailable");
      else if (error instanceof RetryableProviderError)
        this.note("model-unavailable");
      else this.note("invalid-scope-result");
    } finally {
      if (this.healthFlight === flight) {
        this.settleHealth(flight, attempt);
        this.syncPresentationCard();
        this.activity = "Idle";
        this.publish();
      }
      this.drain();
    }
  }

  /**
   * Strict v11 capacity projection retained at this named seam for admission
   * callers. It contains only strict-v11 optional payloads.
   */
  private capacityMetadata(
    _card = this.card,
    healthCards: ReadonlyMap<string, HealthCard> = this.healthCards,
    state: HybridState = this.state,
    prospectiveIdleDoneTaskId?: string,
    taskDetails: ReadonlyMap<string, TaskDetailRecord> = this.taskDetails,
  ) {
    return this.subtaskCapacityMetadata(
      healthCards,
      state,
      prospectiveIdleDoneTaskId,
      taskDetails,
    );
  }

  /** Saturating v11 metadata bounds every dispatch and usage persistence boundary. */
  private subtaskCapacityMetadata(
    healthCards: ReadonlyMap<string, HealthCard> = this.healthCards,
    state: HybridState = this.state,
    prospectiveIdleDoneTaskId?: string,
    taskDetails: ReadonlyMap<string, TaskDetailRecord> = this.taskDetails,
  ) {
    const maximum = Number.MAX_SAFE_INTEGER;
    const maximumHealthCards = new Map(
      [...healthCards.values()].map((card) => [
        card.taskId,
        copyHealthCard(card),
      ]),
    );
    const maximumTaskDetails = new Map(
      this.options.richDetailsEnabled
        ? [...taskDetails.values()].map((record) => [
            record.taskId,
            this.maximumDetailRecord(record),
          ])
        : [],
    );
    // Start from the live v11 sidecar projection so capacity checks never omit
    // accepted generic subtask state while sizing an unrelated transaction.
    return {
      ...this.subtaskMetadata(
        false,
        maximumHealthCards,
        state,
        prospectiveIdleDoneTaskId,
        maximumTaskDetails,
      ),
      usage: {
        jev: {
          calls: maximum,
          inputTokens: maximum,
          outputTokens: maximum,
        },
        extraction: {
          calls: maximum,
          inputTokens: maximum,
          outputTokens: maximum,
        },
      },
      lastJevCallAt: maximum,
      lastExtractionCallAt: maximum,
    };
  }

  private openFocus(state: HybridState) {
    return state.tasks.find(
      (task) =>
        task.id === state.focusTaskId &&
        task.included &&
        task.status !== "done",
    );
  }

  /** One card projection keeps persistence, display and admission truthful. */
  private retainedCardFor(state: HybridState) {
    const card = this.card;
    if (!card) return;
    const focus = this.openFocus(state);
    if (
      !card.retained &&
      focus?.id === card.taskId &&
      focus.revision === card.revision &&
      focus.label === card.label
    )
      return copyCard(card);
    return {
      ...copyCard(card),
      retained: true,
      replacementPending: !!focus,
    };
  }

  /** All named persisted phase boundaries use strict encoded checkpoint bytes. */
  private capacityEnvelope(
    phase: AdmissionPlan["phase"] | "health",
    candidate: HybridState,
    _card = this.retainedCardFor(candidate),
    schemaBytes = 0,
    requests = 1,
    healthCards: ReadonlyMap<string, HealthCard> = this.healthCards,
    prospectiveIdleDoneTaskId?: string,
    dispatchHealthCards: ReadonlyMap<string, HealthCard> = this.healthCards,
    taskDetails: ReadonlyMap<string, TaskDetailRecord> = this.taskDetails,
    dispatchTaskDetails: ReadonlyMap<string, TaskDetailRecord> = this
      .taskDetails,
  ): CapacityEnvelope {
    const selector =
      prospectiveIdleDoneTaskId ?? this.prospectiveIdleDoneTaskIdFor(candidate);
    // Dispatch persists existing facts and selector until the result commits.
    // Core-only admission explicitly substitutes its pre-dispatch eviction map.
    const current = this.subtaskMetadata(
      this.enabled,
      this.healthCards,
      this.state,
      undefined,
      this.taskDetails,
    );
    const dispatch = this.capacityMetadata(
      undefined,
      dispatchHealthCards,
      this.state,
      undefined,
      dispatchTaskDetails,
    );
    const accepted = this.capacityMetadata(
      undefined,
      healthCards,
      candidate,
      selector,
      taskDetails,
    );
    const currentLimit = { ...this.state, capacity: "limit" as const };
    const candidateLimit = { ...candidate, capacity: "limit" as const };
    const boundaries = {
      current: subtaskCheckpointBytes(this.state, current),
      [`${phase}-current`]: subtaskCheckpointBytes(this.state, dispatch),
      [`${phase}-timestamp`]: subtaskCheckpointBytes(this.state, dispatch),
      [`${phase}-usage`]: subtaskCheckpointBytes(this.state, dispatch),
      ...Object.fromEntries(
        Array.from({ length: requests }, (_, index) => [
          `${phase}-request-${index + 1}-timestamp`,
          subtaskCheckpointBytes(this.state, dispatch),
        ]),
      ),
      [`${phase}-accepted`]: subtaskCheckpointBytes(candidate, accepted),
      [`${phase}-limit-marker`]: Math.max(
        subtaskCheckpointBytes(currentLimit, dispatch),
        subtaskCheckpointBytes(candidateLimit, accepted),
      ),
    };
    return {
      boundaries,
      maximum: Math.max(
        ...Object.entries(boundaries).map(([name, value]) =>
          name.endsWith("accepted") ? value + schemaBytes : value,
        ),
      ),
    };
  }

  /** Drop optional facts before mandatory admission; preserve semantic capacity. */
  private evictOptionalHealth() {
    const hadOptional =
      this.healthCards.size > 0 ||
      this.taskDetails.size > 0 ||
      !!this.card ||
      this.currentHealthProofs.size > 0 ||
      this.healthJobs.size > 0 ||
      !!this.healthFlight;
    this.healthCards.clear();
    this.taskDetails.clear();
    this.detailValues.clear();
    this.parkedDetails.clear();
    if (this.detailFlight) {
      this.detailFlight = undefined;
      this.detailGateway.invalidate();
    }
    this.currentHealthProofs.clear();
    this.card = undefined;
    this.healthJobs.clear();
    if (this.healthFlight) {
      this.healthFlight = undefined;
      this.healthGateway.invalidate();
    }
    if (!hadOptional) return;
    // Optional eviction is independently durable before any paid core dispatch.
    this.save();
    this.publish();
  }

  /** Required by core before any paid phase or dispatch timestamp. */
  private admit(plan: AdmissionPlan) {
    if (this.state.capacity === "limit") return false;
    try {
      const full = this.capacityEnvelope(
        plan.phase,
        plan.candidate,
        this.retainedCardFor(plan.candidate),
        plan.schemaBytes,
      );
      if (full.maximum <= MAX_CHECKPOINT_BYTES) return true;
    } catch {
      // Optional metadata can itself be stale/unencodable; try core-only next.
    }
    try {
      // Optional health must never turn an otherwise durable core transition
      // into a semantic capacity block.
      const coreOnly = this.capacityEnvelope(
        plan.phase,
        plan.candidate,
        undefined,
        plan.schemaBytes,
        1,
        new Map(),
        undefined,
        new Map(),
        new Map(),
        new Map(),
      );
      if (coreOnly.maximum <= MAX_CHECKPOINT_BYTES) {
        this.evictOptionalHealth();
        return true;
      }
    } catch {
      // Core-only candidate lacks a valid durable proof.
    }
    this.rejectCapacity();
    return false;
  }

  private maximumHealthCard(
    task: HybridTask,
    observation: Observation,
    coverage = this.beginCanonicalPass().healthReportContext(observation.id),
  ): HealthCard {
    if (!coverage) throw new Error("Missing canonical health coverage");
    const maximum = Number.MAX_SAFE_INTEGER;
    return {
      taskId: task.id,
      revision: task.revision,
      label: task.label,
      assessedAt: maximum,
      health: {
        requirements: "mostly clear",
        acceptance: "not-found-in-context",
        newRedTest: "Not needed",
        redEvidence: "Contradictory",
        implementation: "appears complete",
      },
      provenance: {
        taskSource: { ...task.source },
        // Triggering IDs are host-controlled and have no structural length cap.
        observation: observationRef(observation),
        // Preserve the exact selector footprint; requests/labels below model
        // longest legal receipt values without dropping bounded coverage bytes.
        coverage: coverageFor(coverage),
        snapshotHash: "f".repeat(64),
        requestHashes: Array.from({ length: 20 }, () => "f".repeat(64)),
        evidenceHash: "f".repeat(64),
        codeRevision: maximum,
      },
    };
  }

  /** Whole optional batch admission precedes its first Jev request. */
  private admitHealth(
    task: HybridTask,
    observation: Observation,
    requests: number,
    coverage = this.beginCanonicalPass().healthReportContext(observation.id),
  ) {
    if (this.state.capacity === "limit" || requests <= 0 || !coverage)
      return false;
    const prospective = this.maximumHealthCard(task, observation, coverage);
    const candidateCards = new Map(this.healthCards);
    candidateCards.set(task.id, prospective);
    const prospectiveIdleDoneTaskId =
      task.status === "done" &&
      this.state.tasks.length > 0 &&
      this.state.tasks
        .filter((item) => item.included)
        .every((item) => item.status === "done")
        ? task.id
        : undefined;
    try {
      if (
        this.capacityEnvelope(
          "health",
          this.state,
          this.presentationCardFor(prospective, false),
          0,
          requests,
          candidateCards,
          prospectiveIdleDoneTaskId,
        ).maximum <= MAX_CHECKPOINT_BYTES
      )
        return true;
    } catch {
      // Invalid or unencodable optional projection has no admission proof.
    }
    // Optional health never changes semantic capacity or persists a marker.
    this.note("health-capacity-skipped");
    this.publish();
    return false;
  }

  /** Fixed-width marker preserves prior accepted journal/card at byte edge. */
  private rejectCapacity() {
    const previousCard = this.card ? copyCard(this.card) : undefined;
    const rejected: HybridState = { ...this.state, capacity: "limit" };
    if (this.card) this.card = { ...copyCard(this.card), retained: true };
    try {
      // A fixed local block must preserve the same durable OFF guarantee.
      encodeSubtaskCheckpoint(rejected, this.subtaskMetadata(false));
      const checkpoint = encodeSubtaskCheckpoint(
        rejected,
        this.subtaskMetadata(),
      );
      this.state = copyState(rejected);
      this.persist(checkpoint);
    } catch {
      this.card = previousCard;
      this.note("saved-state-rejected");
    }
    this.note("capacity-exhausted");
    this.publish();
  }

  private commit(state: HybridState, options?: AcceptedSaveOptions) {
    const previous = {
      card: this.card ? copyCard(this.card) : undefined,
      healthCards: this.healthCards,
      taskDetails: this.taskDetails,
      detailValues: this.detailValues,
      currentHealthProofs: new Map(this.currentHealthProofs),
      lastDisplayedTaskId: this.lastDisplayedTaskId,
      idleDoneInvalidated: this.idleDoneInvalidated,
    };
    const candidateCards = this.healthCardsForState(state);
    let candidateDetails = this.detailsForState(state);
    if (this.options.richDetailsEnabled) {
      for (const offer of options?.detailOffers ?? []) {
        const task = state.tasks.find((item) => item.id === offer.taskId);
        if (
          task &&
          !offer.receipts.length &&
          detailRecordMatchesTask(offer, task)
        )
          candidateDetails.set(offer.taskId, copyDetailRecord(offer));
      }
    }
    const admittedCompletion = state.events
      .slice(this.state.events.length)
      .some((event) => event.kind === "complete");
    const focused = this.openFocus(state);
    if (focused && !state.scopeUnresolved && !state.pending) {
      this.lastDisplayedTaskId = focused.id;
      this.idleDoneInvalidated = false;
    } else if (
      admittedCompletion &&
      this.lastDisplayedTaskId &&
      state.tasks
        .filter((task) => task.included)
        .every((task) => task.status === "done")
    )
      this.idleDoneInvalidated = false;
    this.healthCards = candidateCards;
    this.taskDetails = candidateDetails;
    this.reconcileCurrentHealthProofs(state, candidateCards);
    // Source replacement and every derived surface update before first commit
    // publication. No intermediate snapshot can mix new tasks with old health.
    this.syncPresentationCard(state, candidateCards);
    let checkpoint: unknown;
    try {
      // No new semantic state may fit only while ON: OFF control is durable.
      encodeSubtaskCheckpoint(
        state,
        this.subtaskMetadata(
          false,
          candidateCards,
          state,
          undefined,
          candidateDetails,
        ),
      );
      checkpoint = encodeSubtaskCheckpoint(
        state,
        this.subtaskMetadata(
          this.enabled,
          candidateCards,
          state,
          undefined,
          candidateDetails,
        ),
      );
    } catch {
      // Offers are optional. Persist the accepted semantic patch without them.
      if (options?.detailOffers?.length) {
        candidateDetails = this.detailsForState(state);
        this.taskDetails = candidateDetails;
        try {
          encodeSubtaskCheckpoint(
            state,
            this.subtaskMetadata(
              false,
              candidateCards,
              state,
              undefined,
              candidateDetails,
            ),
          );
          checkpoint = encodeSubtaskCheckpoint(
            state,
            this.subtaskMetadata(
              this.enabled,
              candidateCards,
              state,
              undefined,
              candidateDetails,
            ),
          );
          this.note("detail-capacity-skipped");
        } catch {
          this.card = previous.card;
          this.healthCards = previous.healthCards;
          this.taskDetails = previous.taskDetails;
          this.detailValues = previous.detailValues;
          this.currentHealthProofs = previous.currentHealthProofs;
          this.lastDisplayedTaskId = previous.lastDisplayedTaskId;
          this.idleDoneInvalidated = previous.idleDoneInvalidated;
          this.rejectCapacity();
          throw new DurabilityCapacityError();
        }
      } else {
        this.card = previous.card;
        this.healthCards = previous.healthCards;
        this.taskDetails = previous.taskDetails;
        this.detailValues = previous.detailValues;
        this.currentHealthProofs = previous.currentHealthProofs;
        this.lastDisplayedTaskId = previous.lastDisplayedTaskId;
        this.idleDoneInvalidated = previous.idleDoneInvalidated;
        this.rejectCapacity();
        throw new DurabilityCapacityError();
      }
    }
    this.state = copyState(state);
    this.visibility.reconcileCurrentTasks(this.visibilityTasks() ?? []);
    this.rebuildDetailValues();
    try {
      this.persist(checkpoint);
    } catch {
      this.note("saved-state-rejected");
    }
    this.refreshBeads();
    this.publish();
  }

  /** Count every transport dispatch, including failed/retried same-ms attempts. */
  private recordJevDispatch(at: number) {
    this.lastJevCallAt = at;
    this.usage.jev.calls = saturatingAdd(this.usage.jev.calls, 1);
    this.save();
    this.publish();
  }

  /** Extraction reports dispatch itself; local failures without callback count zero. */
  private recordExtractionDispatch(at: number, epoch: number) {
    if (!this.enabled || epoch !== this.epoch) return;
    this.lastExtractionCallAt = at;
    this.usage.extraction.calls = saturatingAdd(this.usage.extraction.calls, 1);
    this.save();
    this.publish();
  }

  private assertActiveAuthority(epoch: number, owner?: ActiveWork) {
    if (
      !this.enabled ||
      epoch !== this.epoch ||
      (owner && (this.activeObservation !== owner || owner.epoch !== epoch))
    )
      throw new RetryableProviderError();
  }

  private activeAuthorityBarrier(epoch: number, owner?: ActiveWork) {
    this.assertActiveAuthority(epoch, owner);
    return owner?.barrier;
  }

  private async awaitActiveAuthority(epoch: number, owner?: ActiveWork) {
    let barrier = this.activeAuthorityBarrier(epoch, owner);
    while (barrier) {
      await barrier.promise;
      barrier = this.activeAuthorityBarrier(epoch, owner);
    }
  }

  private async evaluateJev(
    request: EvaluationRequest,
    epoch: number,
    owner?: ActiveWork,
    gateway: JevGateway = this.gateway,
  ) {
    this.assertActiveAuthority(epoch, owner);
    this.activity = "Assessing progress";
    this.publish();
    const result = await gateway.evaluate(request, this.identity(), true);
    while (true) {
      await this.awaitActiveAuthority(epoch, owner);
      if (!this.activeAuthorityBarrier(epoch, owner)) break;
    }
    if (!result) {
      if (gateway.retryPending) throw new RetryableJevError();
      throw new RetryableProviderError();
    }
    // Recheck immediately before synchronous usage/result admission. The loop
    // above covers barriers installed while its awaits yielded.
    if (this.activeAuthorityBarrier(epoch, owner))
      throw new RetryableProviderError();
    this.usage.jev.inputTokens = saturatingAdd(
      this.usage.jev.inputTokens,
      result.usage.input_tokens,
    );
    this.usage.jev.outputTokens = saturatingAdd(
      this.usage.jev.outputTokens,
      result.usage.output_tokens,
    );
    this.save();
    this.publish();
    return result;
  }

  /** Optional health classifies an undefined gateway result before queue policy. */
  private async evaluateHealth(
    request: EvaluationRequest,
    epoch: number,
  ): Promise<{ result: ValidatedResult } | HealthAttempt> {
    this.assertActiveAuthority(epoch);
    this.activity = "Assessing progress";
    this.publish();
    const result = await this.healthGateway.evaluate(
      request,
      this.identity(),
      true,
    );
    this.assertActiveAuthority(epoch);
    if (!result) {
      if (
        this.healthGateway.lastOutcome === "retryable" ||
        this.healthGateway.lastOutcome === "backoff"
      ) {
        this.healthBackoffWake = this.healthWake;
        return {
          kind: "parked",
          until: Date.now() + Math.max(0, this.healthGateway.retryDelayMs ?? 0),
        };
      }
      if (this.healthGateway.lastOutcome === "invalid") {
        // Invalid local/validated data is terminal for this exact health input.
        // Release only optional-health backoff so later task identities flow.
        this.healthGateway.dismissInvalidOutcome();
        return { kind: "terminal" };
      }
      return this.healthGateway.lastOutcome === "permanent" ||
        this.healthGateway.lastOutcome === "paused"
        ? { kind: "paused" }
        : { kind: "terminal" };
    }
    this.usage.jev.inputTokens = saturatingAdd(
      this.usage.jev.inputTokens,
      result.usage.input_tokens,
    );
    this.usage.jev.outputTokens = saturatingAdd(
      this.usage.jev.outputTokens,
      result.usage.output_tokens,
    );
    this.save();
    this.publish();
    return { result };
  }

  private async extract(
    input: ExtractionInput,
    epoch: number,
    owner?: ActiveWork,
  ) {
    this.assertActiveAuthority(epoch, owner);
    const controller = new AbortController();
    this.extractionController = controller;
    this.activity = "Extracting tasks";
    this.publish();
    try {
      const result = await this.options.extract(
        input,
        controller.signal,
        (at) => this.recordExtractionDispatch(at, epoch),
      );
      while (true) {
        await this.awaitActiveAuthority(epoch, owner);
        if (!this.activeAuthorityBarrier(epoch, owner)) break;
      }
      if (controller.signal.aborted) throw new RetryableProviderError();
      // Keep barrier/owner validation adjacent to synchronous extraction usage.
      if (this.activeAuthorityBarrier(epoch, owner))
        throw new RetryableProviderError();
      if (
        !safeUsageValue(result.usage.inputTokens) ||
        !safeUsageValue(result.usage.outputTokens)
      )
        throw new RetryableProviderError();
      this.usage.extraction.inputTokens = saturatingAdd(
        this.usage.extraction.inputTokens,
        result.usage.inputTokens,
      );
      this.usage.extraction.outputTokens = saturatingAdd(
        this.usage.extraction.outputTokens,
        result.usage.outputTokens,
      );
      this.save();
      this.publish();
      return result.text;
    } catch (error) {
      if (error instanceof RetryableProviderError) throw error;
      throw new RetryableProviderError();
    } finally {
      if (this.extractionController === controller)
        this.extractionController = undefined;
    }
  }

  private projectedHealth(
    task: HybridTask,
    work: HealthWork,
    pass: CanonicalPass,
  ): HealthSnapshot | undefined {
    const source = this.resolveObservation(pass, task.source.entryId);
    if (!source || source.hash !== task.source.messageHash) return;
    const requirements = source.text
      .slice(task.source.start, task.source.end)
      .trim();
    if (!requirements) return;
    const ledger: Ledger = {
      sourceId: this.state.sourceId,
      kind: "conversation",
      sourceRevision: source.hash,
      scopeRevision: `hybrid:${task.revision}`,
      tasks: [
        {
          id: task.id,
          text: task.label,
          workKind: task.kind,
          status: task.status === "done" ? "done" : "in-progress",
          criteria: [task.label],
          included: task.included,
          revision: task.source.messageHash,
          ref: {
            sourceId: `conversation:${task.source.entryId}`,
            entryId: task.source.entryId,
            start: task.source.start,
            end: task.source.end,
            provenance: task.source.role,
          },
        },
      ],
      currentTaskId: task.id,
      stale: false,
      reportOrder: 0,
      reports: [],
      nextTaskId: 1,
      explicitSelection: true,
    };
    return healthSnapshot(
      ledger,
      this.epoch,
      [
        `Canonical task requirements:\n${boundedHealthText(
          requirements,
          MAX_HEALTH_REQUIREMENTS_BYTES,
        )}`,
        `Canonical report coverage: ${
          work.reports.complete
            ? "complete"
            : `incomplete; ${work.reports.omissions.join("; ")}`
        }`,
        ...work.reports.reports.map(
          (report) =>
            `Canonical ${report.role} report ${JSON.stringify(report.id)}:\n${report.text}`,
        ),
      ],
      this.evidence.snapshot(),
      this.evidence.codeRevision(),
    );
  }

  /** Accepted results dedupe by exact task-local input, never widget selection. */
  private hasAcceptedHealthSnapshot(
    task: HybridTask,
    work: HealthWork,
    snapshot: HealthSnapshot,
  ) {
    const card = this.healthCards.get(task.id);
    return (
      !!card &&
      this.healthCardMatchesTask(card, task) &&
      card.provenance.observation.entryId === work.observation.id &&
      card.provenance.observation.messageHash === work.observation.hash &&
      card.provenance.observation.role === work.observation.role &&
      card.provenance.snapshotHash === sha256(snapshot.identity) &&
      card.provenance.evidenceHash ===
        sha256(JSON.stringify(this.evidence.snapshot())) &&
      card.provenance.codeRevision === this.evidence.codeRevision()
    );
  }

  private async assessHealth(
    epoch: number,
    work: HealthWork,
    flight: HealthFlight,
    pass: CanonicalPass,
  ): Promise<HealthAttempt> {
    const task = this.healthWorkCurrent(work, pass);
    if (!task) return { kind: "terminal" };
    const snapshot = this.projectedHealth(task, work, pass);
    if (!snapshot || this.hasAcceptedHealthSnapshot(task, work, snapshot))
      return { kind: "terminal" };
    // Capacity denial is terminal for this exact task/input until a named
    // canonical/evidence/control wake changes its identity or capacity proof.
    if (
      !this.admitHealth(
        task,
        work.observation,
        snapshot.requests.length,
        work.reports,
      )
    )
      return { kind: "terminal" };
    let combined: ValidatedResult | undefined;
    for (const request of snapshot.requests) {
      const currentPass = this.beginCanonicalPass();
      const currentTask = this.healthWorkCurrent(work, currentPass);
      const current = currentTask
        ? this.projectedHealth(currentTask, work, currentPass)
        : undefined;
      if (!current || current.identity !== snapshot.identity)
        return { kind: "terminal" };
      const evaluated = await this.evaluateHealth(request, epoch);
      if ("kind" in evaluated) return evaluated;
      if (this.healthFlight !== flight) throw new RetryableProviderError();
      const result = evaluated.result;
      combined = {
        model: result.model,
        answers: { ...(combined?.answers ?? {}), ...result.answers },
        usage: {
          input_tokens: saturatingAdd(
            combined?.usage.input_tokens ?? 0,
            result.usage.input_tokens,
          ),
          output_tokens: saturatingAdd(
            combined?.usage.output_tokens ?? 0,
            result.usage.output_tokens,
          ),
        },
      };
    }
    if (
      !combined ||
      !this.enabled ||
      epoch !== this.epoch ||
      this.healthFlight !== flight
    )
      return { kind: "terminal" };
    // Exact epoch/task/source/target/context/evidence checks gate all fields.
    const currentPass = this.beginCanonicalPass();
    const authority = this.reconcileAuthority(currentPass);
    if (authority === "amended") {
      this.resetForCanonicalAmendment();
      return { kind: "terminal" };
    }
    if (authority === "incomplete") {
      this.scheduleCanonicalWake();
      return { kind: "parked", until: Infinity };
    }
    const currentTask = this.healthWorkCurrent(work, currentPass);
    const current = currentTask
      ? this.projectedHealth(currentTask, work, currentPass)
      : undefined;
    if (!current || current.identity !== snapshot.identity)
      return { kind: "terminal" };
    if (!this.healthFlightCurrent(flight, work)) return { kind: "terminal" };
    const acceptance = combined.answers.acceptance;
    const applicability = combined.answers.redApplicability;
    const reported = combined.answers.redReport;
    const health: HealthFields = {
      requirements: healthRequirements(combined.answers.clarity),
      acceptance: acceptance?.type === "choice" ? acceptance.choice : "unknown",
      newRedTest:
        applicability?.type === "choice" && applicability.choice === "needed"
          ? "Needed"
          : applicability?.type === "choice" &&
              applicability.choice === "not-needed"
            ? "Not needed"
            : "Unknown",
      redEvidence:
        !work.reports.complete &&
        reported?.type === "choice" &&
        reported.choice === "not-found"
          ? "Unknown"
          : redEvidenceLabel({
              applicability:
                applicability?.type === "choice" &&
                (applicability.choice === "needed" ||
                  applicability.choice === "not-needed" ||
                  applicability.choice === "unknown")
                  ? applicability.choice
                  : undefined,
              reported:
                reported?.type === "choice" &&
                reported.choice === "reported-red",
              contradiction:
                reported?.type === "choice" &&
                reported.choice === "contradicted",
            }),
      implementation: (() => {
        const implementation = implementationFromResult(
          [task.label],
          combined,
          this.evidence.snapshot(),
          this.evidence.codeRevision(),
          snapshot.implementationEvidenceComplete,
        );
        return implementation === "not-needed" ? "Not needed" : implementation;
      })(),
    };
    const assessedAt = Date.now();
    const card: HealthCard = {
      taskId: task.id,
      revision: task.revision,
      label: task.label,
      assessedAt,
      health,
      provenance: {
        taskSource: { ...task.source },
        observation: observationRef(work.observation),
        coverage: coverageFor(work.reports),
        // snapshot.identity contains task/context JSON. Persist only its digest.
        snapshotHash: sha256(snapshot.identity),
        requestHashes: snapshot.requests.map((request) =>
          sha256(JSON.stringify(request)),
        ),
        evidenceHash: sha256(JSON.stringify(this.evidence.snapshot())),
        codeRevision: this.evidence.codeRevision(),
      },
    };
    const candidateCards = new Map(this.healthCards);
    candidateCards.set(task.id, card);
    // Health receipt order never owns selection, including all-done refreshes.
    try {
      encodeSubtaskCheckpoint(
        this.state,
        this.subtaskMetadata(false, candidateCards, this.state),
      );
      encodeSubtaskCheckpoint(
        this.state,
        this.subtaskMetadata(this.enabled, candidateCards, this.state),
      );
    } catch {
      this.note("health-capacity-skipped");
      this.publish();
      return { kind: "terminal" };
    }
    if (!this.healthFlightCurrent(flight, work)) return { kind: "terminal" };
    this.healthCards = candidateCards;
    this.currentHealthProofs.set(task.id, snapshot.identity);
    // Advisory authority follows the same exact task-local receipt.
    this.acceptCorrectionFact(
      task,
      work,
      flight,
      snapshot.identity,
      applicability,
    );
    this.syncPresentationCard();
    this.save();
    this.publish();
    return { kind: "terminal" };
  }
}
