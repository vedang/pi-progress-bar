import { createHash } from "node:crypto";
import {
  type CorrectionAttempt,
  type CorrectionBinding,
  CorrectionController,
  type CorrectionEmission,
  type CorrectionRedFact,
  type CorrectionSnapshot,
  type CorrectionTask,
} from "../advisory/corrections";
import {
  type ActivityCall,
  type ActivityList,
  activityFocusRequest,
  captureDeclaredTools,
  captureStartedTool,
  reconcileStartedTools,
} from "../analysis/activity-focus";
import type { ExtractionInput } from "../analysis/extractor";
import {
  type EvaluationRequest,
  JevGateway,
  type ValidatedResult,
} from "../analysis/gateway";
import { type HealthSnapshot, healthSnapshot } from "../analysis/health";
import { implementationFromResult } from "../analysis/implementation";
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
import { EvidenceStore, redEvidenceLabel } from "../sources/evidence";
import { type CanonicalFrontier, CanonicalPass } from "../sources/messages";
import {
  type BoardDetailRecord,
  type BoardSnapshot,
  projectBoard,
} from "./board-projection";
import {
  type AcceptedSaveOptions,
  type AdmissionPlan,
  DurabilityCapacityError,
  processObservation,
  RetryableProviderError,
} from "./hybrid";
import {
  checkpointBytes,
  checkpointStorageStatus,
  encodeCheckpoint,
  type HealthCard,
  type HealthFields,
  MAX_CHECKPOINT_BYTES,
  type MonitorCheckpointMetadata,
  monitorCheckpointMetadata,
  restoreCheckpoint,
} from "./hybrid-checkpoint";
import { requestHash } from "./hybrid-proof";
import {
  copyState,
  emptyState,
  type HybridState,
  type HybridTask,
  type Observation,
  observationRef,
} from "./hybrid-state";
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

interface HealthWork {
  observation: Observation;
  taskId: string;
  revision: number;
}

interface CorrectionFact extends CorrectionRedFact {
  epoch: number;
  taskSource: HybridTask["source"];
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
  metadata?: MonitorCheckpointMetadata;
  preserveControls: boolean;
  telemetry: Telemetry;
  done?: Deferred;
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
const copyHealthCard = (card: HealthCard): HealthCard => ({
  ...card,
  health: { ...card.health },
  provenance: {
    ...card.provenance,
    taskSource: { ...card.provenance.taskSource },
    observation: { ...card.provenance.observation },
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
const MAX_HEALTH_REPORT_BYTES = 4 * 1024;
const MAX_CORRECTION_FACTS = 20;

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
  /** Optional corrective binding has its own one-flight transport authority. */
  private readonly correctionGateway: JevGateway;
  private correctionController!: CorrectionController;
  /** Ephemeral raw rubric facts; never display or checkpoint data. */
  private correctionFacts = new Map<string, CorrectionFact>();
  private correctionEpoch = 0;
  readonly evidence = new EvidenceStore();
  readonly usage = {
    jev: { calls: 0, inputTokens: 0, outputTokens: 0 },
    extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
  };

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
  private healthObservation?: HealthWork;
  private healthFlight?: { epoch: number; token: number; taskId: string };
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
  /** Current proof cannot survive reload because snapshot identity includes epoch. */
  private currentHealthTaskId?: string;
  private lastDisplayedTaskId?: string;
  /** New unclassified work immediately disqualifies retained idle DONE display. */
  private idleDoneInvalidated = false;
  private cardHealthIdentity?: string;
  private beads = new Map<string, BeadsPresentation>();
  private beadsGeneration = 0;
  private beadsInFlight = false;
  private beadsRefreshQueued = false;
  private lastJevCallAt?: number;
  private lastExtractionCallAt?: number;
  private diagnostics = new Map<string, number>();
  /** A rejected persisted shape remains OFF until a new restore boundary. */
  private restoreRejection?: "unsupported" | "corrupt";

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
    this.correctionGateway = new JevGateway({
      fetch: (url, init) => globalThis.fetch(url, init),
      getApiKey: () => process.env.TYPESAFE_API_KEY,
      onDispatch: (at) => this.recordJevDispatch(at),
      // Corrections are optional and never disable semantic progress tracking.
      onPermanentError: () => this.note("model-unavailable"),
    });
    this.correctionController = this.newCorrectionController();
  }

  /** Display focus never establishes tool evidence authority. */
  evidenceLink() {
    return undefined;
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
      // Passive facts can change task health truth but never semantic state.
      this.currentHealthTaskId = undefined;
      this.syncPresentationCard();
      this.publish();
    }
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
      this.correctionGateway.pause();
      this.clearActivity(false);
      this.gateway.enable(this.identity());
      this.healthGateway.enable(this.identity());
      this.activityGateway.enable(this.identity());
      this.detailGateway.enable(this.identity());
      this.correctionGateway.enable(this.identity());
      this.waitingForWake = false;
      this.requeue(pass);
      this.drain();
    }
    this.publish();
  }

  /** Canonical branch is read only on host observation, never projections. */
  observe(reader: () => readonly unknown[]) {
    this.reader = reader;
    if (this.controlWork || !this.enabled) return;
    const pass = this.beginCanonicalPass();
    const authority = this.reconcileAuthority(pass);
    if (authority === "amended") this.resetForCanonicalAmendment();
    else if (authority === "incomplete") this.scheduleCanonicalWake();
    else {
      const healthChanged = this.reconcileHealthCards(pass);
      this.requeue(pass);
      if (this.queued.length) {
        this.idleDoneInvalidated = true;
        this.cancelHealth();
      }
      if (healthChanged) this.publish();
      this.drain();
    }
  }

  checkpoint(): unknown {
    return encodeCheckpoint(this.state, this.metadata());
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
  private pendingContextAmended() {
    const pending = this.state.pending;
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
    this.disableRuntime();
    // Old work retains its local owner until its own finally block unwinds, but
    // target restore validation must not include old-branch references.
    this.activeObservation = undefined;
    this.clearRuntimeContext();
    const work: ControlWork = {
      ...input,
      epoch: this.epoch,
      ...(input.kind === "restore" ? { done: this.deferred() } : {}),
    };
    this.controlWork = work;
    this.advanceControl(work);
    return work.done?.promise;
  }

  private disableRuntime() {
    this.enabled = false;
    this.waitingForWake = false;
    this.clearRetry();
    this.settleActiveAuthority(this.activeObservation);
    this.epoch++;
    this.extractionController?.abort();
    this.cancelHealth();
    this.invalidateCorrections();
    this.healthObservation = undefined;
    this.gateway.pause();
    this.healthGateway.pause();
    this.activityGateway.pause();
    this.detailGateway.pause();
    this.correctionGateway.pause();
    this.clearActivity(false);
    this.evidence.clearPending();
  }

  private finishControl(work: ControlWork | undefined) {
    work?.done?.resolve();
  }

  private mergeTelemetry(
    metadata: MonitorCheckpointMetadata | undefined,
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
      const restored = restoreCheckpoint(
        work.data,
        work.sourceId,
        (entryId) => this.resolveObservation(pass, entryId),
        (entryId) =>
          work.target?.id === entryId
            ? this.settledContext
            : this.rehydratePreceding(pass, entryId),
      );
      if (restored) {
        this.state = copyState(restored);
        this.mergeTelemetry(work.metadata, work, pass);
        this.latchHistoricalCatchup = true;
        if (this.directCanonicalAmendment(pass) || this.pendingContextAmended())
          this.resetState(work.sourceId, false);
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

    // Optional health references never trigger semantic replay/reset.
    this.reconcileHealthCards(pass);
    this.controlWork = undefined;
    if (!work.wantEnabled) {
      if (this.falseProjectionFits()) this.save();
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
    if (!this.falseProjectionFits()) {
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
    this.activityGateway.enable(this.identity());
    this.detailGateway.enable(this.identity());
    this.correctionGateway.enable(this.identity());
    this.requeue(pass, true);
    if (this.queued.length) this.idleDoneInvalidated = true;
    this.save();
    this.refreshBeads();
    this.finishControl(work);
    this.publish();
    this.drain();
  }

  async restore(
    cwd: string,
    data: unknown,
    preserveControls = false,
    reader?: () => readonly unknown[],
  ) {
    const storage = checkpointStorageStatus(data);
    const prior = this.controlWork;
    const desired = preserveControls
      ? (prior?.wantEnabled ?? this.enabled)
      : storage === "supported"
        ? (monitorCheckpointMetadata(data)?.enabled ?? true)
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
      metadata:
        storage === "supported" ? monitorCheckpointMetadata(data) : undefined,
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
      currentHealthTaskId: this.currentHealthTaskId,
      pendingHealthTaskId:
        this.healthObservation?.taskId ?? this.healthFlight?.taskId,
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
    };
  }

  /**
   * Detached correction authority. It copies current included rows and bounded
   * canonical text already resident in memory; it never reopens branch history.
   */
  correctionSnapshot(): CorrectionSnapshot {
    const context = this.correctionContext();
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
            context,
          }),
        )
        .digest("hex"),
      tasks,
      context,
    };
  }

  observeCorrectionAttempt(attempt: CorrectionAttempt): Promise<void> {
    return this.correctionController.observe(attempt);
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

  private correctionContext() {
    const context: string[] = [];
    let bytes = 0;
    for (const observation of this.settledContext) {
      const size = Buffer.byteLength(observation.text, "utf8");
      if (bytes + size > 4 * 1024) break;
      context.push(observation.text);
      bytes += size;
    }
    return context;
  }

  private currentCorrectionFact(
    task: HybridTask,
  ): CorrectionRedFact | undefined {
    const fact = this.correctionFacts.get(task.id);
    if (
      !fact ||
      fact.epoch !== this.epoch ||
      fact.revision !== task.revision ||
      !sameSource(fact.taskSource, task.source)
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
    answer: ValidatedResult["answers"][string] | undefined,
  ) {
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
  private resetState(sourceId: string, resetTelemetry = true) {
    this.invalidateCorrections();
    this.state = emptyState(sourceId);
    this.card = undefined;
    this.healthCards.clear();
    this.taskDetails.clear();
    this.detailValues.clear();
    this.parkedDetails.clear();
    this.detailFlight = undefined;
    this.detailGateway.invalidate();
    this.currentHealthTaskId = undefined;
    this.lastDisplayedTaskId = undefined;
    this.idleDoneInvalidated = false;
    this.cardHealthIdentity = undefined;
    this.clearRuntimeContext();
    this.queued = [];
    this.healthObservation = undefined;
    this.clearActivity(false);
    this.blockedPending = undefined;
    this.activeObservation = undefined;
    this.catchingUp = false;
    this.catchupTarget = undefined;
    this.latchHistoricalCatchup = false;
    this.evidence.reset();
    this.beads.clear();
    this.beadsGeneration++;
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
    const currentFocus = this.openFocus(this.state)?.id;
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

  private metadata(
    enabled = this.enabled,
    healthCards: ReadonlyMap<string, HealthCard> = this.healthCards,
    state: HybridState = this.state,
    prospectiveIdleDoneTaskId?: string,
    taskDetails: ReadonlyMap<string, TaskDetailRecord> = this.taskDetails,
  ): MonitorCheckpointMetadata {
    const idleDoneTaskId = this.idleDoneTaskIdFor(
      state,
      prospectiveIdleDoneTaskId,
    );
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
    };
  }

  /** Every new durable semantic state must also support durable OFF control. */
  private falseProjectionFits(state = this.state) {
    try {
      checkpointBytes(state, this.metadata(false, this.healthCards, state));
      return (
        checkpointBytes(state, this.metadata(false, this.healthCards, state)) <=
        MAX_CHECKPOINT_BYTES
      );
    } catch {
      return false;
    }
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
    metadata: MonitorCheckpointMetadata | undefined,
    pass?: CanonicalPass,
  ) {
    const cards = metadata?.healthCards ?? [];
    this.healthCards = new Map(
      cards
        .filter((card) => this.healthCardMatchesCanonical(card, pass))
        .map((card) => [card.taskId, copyHealthCard(card)]),
    );
    // Stored card digests prove safe retention, not live freshness after reload.
    this.currentHealthTaskId = undefined;
    this.cardHealthIdentity = undefined;
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

  private healthCardMatchesCanonical(card: HealthCard, pass?: CanonicalPass) {
    const task = this.state.tasks.find(
      (item) =>
        item.id === card.taskId &&
        item.revision === card.revision &&
        item.label === card.label &&
        sameSource(item.source, card.provenance.taskSource),
    );
    if (!task) return false;
    const observation = pass?.observation(card.provenance.observation.entryId);
    return (
      !pass ||
      (!!observation &&
        observation.hash === card.provenance.observation.messageHash &&
        observation.role === card.provenance.observation.role)
    );
  }

  private cachedObservation(entryId: string) {
    return [...this.page, ...this.settledContext].find(
      (observation) => observation.id === entryId,
    );
  }

  private detailRecordMatchesCanonical(
    record: TaskDetailRecord,
    pass?: CanonicalPass,
  ) {
    const task = this.state.tasks.find((item) => item.id === record.taskId);
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
    this.currentHealthTaskId = undefined;
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

  /** Runtime widget card derives only from exact durable facts and live selector. */
  private syncPresentationCard(
    state: HybridState = this.state,
    healthCards: ReadonlyMap<string, HealthCard> = this.healthCards,
  ) {
    const focus = this.openFocus(state);
    const focused = focus ? healthCards.get(focus.id) : undefined;
    const latest = [...healthCards.values()].sort(
      (left, right) => right.assessedAt - left.assessedAt,
    )[0];
    const selected = focused ?? latest;
    if (!selected) {
      this.card = undefined;
      return;
    }
    const isCurrent =
      !!focus &&
      selected.taskId === focus.id &&
      this.currentHealthTaskId === selected.taskId &&
      !this.healthObservation &&
      !this.healthFlight;
    this.card = this.presentationCardFor(
      selected,
      !isCurrent,
      !!focus && !isCurrent,
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
      this.persist(this.checkpoint());
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
    this.currentHealthTaskId = undefined;
    if (!this.healthFlight) {
      this.syncPresentationCard();
      return;
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

  /** Every current state/proof/runtime source is authoritative for this pass. */
  private canonicalReferences() {
    const references: {
      entryId: string;
      messageHash: string;
      role?: Observation["role"];
    }[] = [
      ...this.state.tasks.flatMap((task) => [
        task.source,
        ...(task.latestAssessment ? [task.latestAssessment.source] : []),
      ]),
      ...this.state.events.map((event) => event.source),
      ...(this.state.scopeAssessment
        ? [this.state.scopeAssessment.source]
        : []),
      ...(this.state.pending ? [this.state.pending.observation] : []),
      ...(this.state.cursor
        ? [
            {
              entryId: this.state.cursor.id,
              messageHash: this.state.cursor.hash,
              role: this.state.cursor.role,
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
      ...(this.healthObservation
        ? [
            {
              entryId: this.healthObservation.observation.id,
              messageHash: this.healthObservation.observation.hash,
              role: this.healthObservation.observation.role,
            },
          ]
        : []),
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
    const pending = this.state.pending;
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
  private directCanonicalAmendment(pass: CanonicalPass) {
    const byId = new Map<string, ReturnType<typeof this.canonicalReferences>>();
    for (const reference of this.canonicalReferences()) {
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
    const detail = this.nextDetailWork();
    if (detail && !this.detailFlight) {
      const flight = {
        epoch: this.epoch,
        token: ++this.nextDetailToken,
        taskId: detail.taskId,
      };
      this.detailFlight = flight;
      void this.processDetails(detail, flight);
      return;
    }
    const healthWork = this.healthObservation;
    if (!healthWork || this.healthFlight) return;
    this.healthObservation = undefined;
    const flight = {
      epoch: this.epoch,
      token: ++this.nextHealthToken,
      taskId: healthWork.taskId,
    };
    this.healthFlight = flight;
    void this.processHealth(healthWork, flight);
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
    try {
      const healthTarget = this.state.tasks.find(
        (task) =>
          task.id === this.state.focusTaskId &&
          task.included &&
          task.status !== "done",
      );
      const next = await processObservation(
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
      if (!this.enabled || epoch !== this.epoch) return;
      const completedHealthTarget =
        healthTarget &&
        next.tasks.find(
          (task) =>
            task.id === healthTarget.id &&
            task.revision === healthTarget.revision &&
            task.included &&
            task.status === "done",
        );
      const focusedHealthTarget = next.tasks.find(
        (task) =>
          task.id === next.focusTaskId &&
          task.included &&
          task.status !== "done",
      );
      const hasOpenTasks = next.tasks.some(
        (task) => task.included && task.status !== "done",
      );
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
        // A named committed cursor wake permits parked optional jobs. It occurs
        // before `finally` drains, never while semantic `processing` is true.
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
          // A newly selected open focus is current. A completed prior focus is
          // health-eligible only for the all-done retained-card path.
          this.scheduleHealth(
            observation,
            focusedHealthTarget ??
              (!hasOpenTasks ? completedHealthTarget : undefined),
          );
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
        }
        this.publish();
      }
      this.drain();
    }
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
        this.card,
        this.healthCards,
        this.state,
        undefined,
        candidate,
      );
      if (checkpointBytes(this.state, metadata) <= MAX_CHECKPOINT_BYTES)
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
        encodeCheckpoint(
          this.state,
          this.metadata(false, this.healthCards, this.state),
        );
        const checkpoint = encodeCheckpoint(
          this.state,
          this.metadata(this.enabled, this.healthCards, this.state),
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

  /** New semantic observations replace stale optional health work. */
  private scheduleHealth(observation: Observation, task?: HybridTask) {
    const target =
      task ??
      this.state.tasks.find(
        (item) =>
          item.id === this.state.focusTaskId &&
          item.included &&
          item.status !== "done",
      );
    if (!target) return;
    // New report supersedes live proof before optional work begins.
    this.correctionFacts.delete(target.id);
    this.currentHealthTaskId = undefined;
    this.healthObservation = {
      observation: { ...observation },
      taskId: target.id,
      revision: target.revision,
    };
    this.syncPresentationCard();
  }

  private async processHealth(
    work: HealthWork,
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
        this.healthObservation = work;
        this.scheduleCanonicalWake();
        return;
      }
      this.reconcileHealthCards(pass);
      await this.assessHealth(flight.epoch, work, flight, pass);
    } catch (error) {
      if (this.healthFlight !== flight) return;
      if (error instanceof RetryableJevError) this.note("jev-unavailable");
      else if (error instanceof RetryableProviderError) {
        // Optional health is never allowed to hold semantic queue progress.
        this.note("model-unavailable");
      } else this.note("invalid-scope-result");
    } finally {
      if (this.healthFlight === flight) {
        this.healthFlight = undefined;
        this.syncPresentationCard();
        this.activity = "Idle";
        this.publish();
      }
      this.drain();
    }
  }

  /** Saturating metadata bounds every dispatch and usage persistence boundary. */
  private capacityMetadata(
    _card = this.card,
    healthCards: ReadonlyMap<string, HealthCard> = this.healthCards,
    state: HybridState = this.state,
    prospectiveIdleDoneTaskId?: string,
    taskDetails: ReadonlyMap<string, TaskDetailRecord> = this.taskDetails,
  ): MonitorCheckpointMetadata {
    const maximum = Number.MAX_SAFE_INTEGER;
    // Existing cards are durable facts. The supplied candidate map already
    // contains the exact prospective replacement/new card.
    const maximumHealthCards = [...healthCards.values()].map(copyHealthCard);
    const maximumTaskDetails = this.options.richDetailsEnabled
      ? [...taskDetails.values()].map((record) =>
          this.maximumDetailRecord(record),
        )
      : [];
    const idleDoneTaskId = this.idleDoneTaskIdFor(
      state,
      prospectiveIdleDoneTaskId,
    );
    return {
      enabled: false,
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
      ...(idleDoneTaskId ? { idleDoneTaskId } : {}),
      ...(maximumHealthCards.length ? { healthCards: maximumHealthCards } : {}),
      ...(maximumTaskDetails.length ? { taskDetails: maximumTaskDetails } : {}),
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
    card = this.retainedCardFor(candidate),
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
    const current = this.metadata(
      this.enabled,
      this.healthCards,
      this.state,
      undefined,
      this.taskDetails,
    );
    const oldCard = this.retainedCardFor(this.state);
    const dispatch = this.capacityMetadata(
      oldCard,
      dispatchHealthCards,
      this.state,
      undefined,
      dispatchTaskDetails,
    );
    const accepted = this.capacityMetadata(
      card ?? this.retainedCardFor(candidate),
      healthCards,
      candidate,
      selector,
      taskDetails,
    );
    const currentLimit = { ...this.state, capacity: "limit" as const };
    const candidateLimit = { ...candidate, capacity: "limit" as const };
    const boundaries = {
      current: checkpointBytes(this.state, current),
      [`${phase}-current`]: checkpointBytes(this.state, dispatch),
      [`${phase}-timestamp`]: checkpointBytes(this.state, dispatch),
      [`${phase}-usage`]: checkpointBytes(this.state, dispatch),
      ...Object.fromEntries(
        Array.from({ length: requests }, (_, index) => [
          `${phase}-request-${index + 1}-timestamp`,
          checkpointBytes(this.state, dispatch),
        ]),
      ),
      [`${phase}-accepted`]: checkpointBytes(candidate, accepted),
      [`${phase}-limit-marker`]: Math.max(
        checkpointBytes(currentLimit, dispatch),
        checkpointBytes(candidateLimit, accepted),
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
      !!this.currentHealthTaskId ||
      !!this.healthObservation ||
      !!this.healthFlight;
    this.healthCards.clear();
    this.taskDetails.clear();
    this.detailValues.clear();
    this.parkedDetails.clear();
    if (this.detailFlight) {
      this.detailFlight = undefined;
      this.detailGateway.invalidate();
    }
    this.currentHealthTaskId = undefined;
    this.cardHealthIdentity = undefined;
    this.card = undefined;
    this.healthObservation = undefined;
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
  ): HealthCard {
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
  ) {
    if (this.state.capacity === "limit" || requests <= 0) return false;
    const prospective = this.maximumHealthCard(task, observation);
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
      encodeCheckpoint(rejected, this.metadata(false));
      const checkpoint = encodeCheckpoint(rejected, this.metadata());
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
      currentHealthTaskId: this.currentHealthTaskId,
      cardHealthIdentity: this.cardHealthIdentity,
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
    if (
      !this.currentHealthTaskId ||
      !candidateCards.has(this.currentHealthTaskId)
    ) {
      this.currentHealthTaskId = undefined;
      this.cardHealthIdentity = undefined;
    }
    // Source replacement and every derived surface update before first commit
    // publication. No intermediate snapshot can mix new tasks with old health.
    this.syncPresentationCard(state, candidateCards);
    let checkpoint: unknown;
    try {
      // No new semantic state may fit only while ON: OFF control is durable.
      encodeCheckpoint(
        state,
        this.metadata(
          false,
          candidateCards,
          state,
          undefined,
          candidateDetails,
        ),
      );
      checkpoint = encodeCheckpoint(
        state,
        this.metadata(
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
          encodeCheckpoint(
            state,
            this.metadata(
              false,
              candidateCards,
              state,
              undefined,
              candidateDetails,
            ),
          );
          checkpoint = encodeCheckpoint(
            state,
            this.metadata(
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
          this.currentHealthTaskId = previous.currentHealthTaskId;
          this.cardHealthIdentity = previous.cardHealthIdentity;
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
        this.currentHealthTaskId = previous.currentHealthTaskId;
        this.cardHealthIdentity = previous.cardHealthIdentity;
        this.lastDisplayedTaskId = previous.lastDisplayedTaskId;
        this.idleDoneInvalidated = previous.idleDoneInvalidated;
        this.rejectCapacity();
        throw new DurabilityCapacityError();
      }
    }
    this.state = copyState(state);
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
    observation: Observation,
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
        `Latest canonical ${observation.role} report:\n${boundedHealthText(
          observation.text,
          MAX_HEALTH_REPORT_BYTES,
        )}`,
      ],
      this.evidence.snapshot(),
      this.evidence.codeRevision(),
    );
  }

  private cardIsCurrent(task: HybridTask, healthIdentity: string) {
    return (
      !!this.card &&
      !this.card.retained &&
      this.card.taskId === task.id &&
      this.card.revision === task.revision &&
      this.card.label === task.label &&
      this.cardHealthIdentity === healthIdentity
    );
  }

  /** Health follows exact open focus, except all-done retained assessment. */
  private healthTaskForCurrentFocus(work: HealthWork) {
    const task = this.state.tasks.find(
      (item) =>
        item.id === work.taskId &&
        item.revision === work.revision &&
        item.included,
    );
    if (!task) return;
    const hasOpenTasks = this.state.tasks.some(
      (item) => item.included && item.status !== "done",
    );
    if (task.status === "done") return hasOpenTasks ? undefined : task;
    return this.state.focusTaskId === task.id ? task : undefined;
  }

  private async assessHealth(
    epoch: number,
    work: HealthWork,
    flight: { epoch: number; token: number; taskId: string },
    pass: CanonicalPass,
  ) {
    const task = this.healthTaskForCurrentFocus(work);
    if (!task) return;
    const snapshot = this.projectedHealth(task, work.observation, pass);
    if (!snapshot || this.cardIsCurrent(task, snapshot.identity)) return;
    if (!this.admitHealth(task, work.observation, snapshot.requests.length))
      return;
    let combined: ValidatedResult | undefined;
    for (const request of snapshot.requests) {
      const result = await this.evaluateJev(
        request,
        epoch,
        undefined,
        this.healthGateway,
      );
      if (this.healthFlight !== flight) throw new RetryableProviderError();
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
      return;
    // Evidence and code revision are part of the snapshot identity. Never admit
    // a response that raced a passive-fact change.
    const currentTask = this.healthTaskForCurrentFocus(work);
    const currentPass = this.beginCanonicalPass();
    const authority = this.reconcileAuthority(currentPass);
    if (authority === "amended") {
      this.resetForCanonicalAmendment();
      return;
    }
    if (authority === "incomplete") {
      this.scheduleCanonicalWake();
      return;
    }
    const current = currentTask
      ? this.projectedHealth(currentTask, work.observation, currentPass)
      : undefined;
    if (!current || current.identity !== snapshot.identity) return;
    const acceptance = combined.answers.acceptance;
    const applicability = combined.answers.redApplicability;
    const reported = combined.answers.redReport;
    // Admit raw redApplicability only after final epoch/canonical identity checks,
    // before it is reduced to display-only HealthFields.
    this.acceptCorrectionFact(task, applicability);
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
      redEvidence: redEvidenceLabel({
        applicability:
          applicability?.type === "choice" &&
          (applicability.choice === "needed" ||
            applicability.choice === "not-needed" ||
            applicability.choice === "unknown")
            ? applicability.choice
            : undefined,
        reported:
          reported?.type === "choice" && reported.choice === "reported-red",
        contradiction:
          reported?.type === "choice" && reported.choice === "contradicted",
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
    const previousDisplay = {
      lastDisplayedTaskId: this.lastDisplayedTaskId,
      idleDoneInvalidated: this.idleDoneInvalidated,
    };
    const establishesIdleDone =
      task.status === "done" &&
      this.state.tasks.length > 0 &&
      this.state.tasks
        .filter((item) => item.included)
        .every((item) => item.status === "done");
    // The selector changes durable bytes, so install it before final proof.
    this.lastDisplayedTaskId = task.id;
    this.idleDoneInvalidated = false;
    try {
      // A post-dispatch encode failure must never poison optional map/state.
      encodeCheckpoint(
        this.state,
        this.metadata(
          this.enabled,
          candidateCards,
          this.state,
          establishesIdleDone ? task.id : undefined,
        ),
      );
    } catch {
      this.lastDisplayedTaskId = previousDisplay.lastDisplayedTaskId;
      this.idleDoneInvalidated = previousDisplay.idleDoneInvalidated;
      this.note("health-capacity-skipped");
      this.publish();
      return;
    }
    this.healthCards = candidateCards;
    this.currentHealthTaskId = task.id;
    this.cardHealthIdentity = snapshot.identity;
    this.syncPresentationCard();
    this.save();
    this.publish();
  }
}
