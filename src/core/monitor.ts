import type { ExtractionInput } from "../analysis/extractor";
import {
  type EvaluationRequest,
  JevGateway,
  type ValidatedResult,
} from "../analysis/gateway";
import { type HealthSnapshot, healthSnapshot } from "../analysis/health";
import { implementationFromResult } from "../analysis/implementation";
import {
  type BeadsPresentation,
  beadsPresentation,
  readBeadsExport,
} from "../sources/beads";
import { EvidenceStore, redEvidenceLabel } from "../sources/evidence";
import { type CanonicalFrontier, CanonicalPass } from "../sources/messages";
import {
  type AdmissionPlan,
  DurabilityCapacityError,
  processObservation,
  RetryableProviderError,
} from "./hybrid";
import {
  checkpointBytes,
  encodeCheckpoint,
  MAX_CHECKPOINT_BYTES,
  type MonitorCheckpointMetadata,
  monitorCheckpointMetadata,
  restoreCheckpoint,
} from "./hybrid-checkpoint";
import {
  copyState,
  emptyState,
  type HybridState,
  type HybridTask,
  type Observation,
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
  health: {
    requirements: string;
    acceptance: string;
    newRedTest: string;
    redEvidence: string;
    implementation: string;
  };
}

interface PresentationCard extends RetainedCard {
  beads?: BeadsPresentation;
}

interface HealthWork {
  observation: Observation;
  taskId: string;
  revision: number;
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

const diagnosticLabels: Record<string, string> = {
  "invalid-scope-result": "Scope result rejected",
  "jev-unavailable": "Jev service unavailable",
  "model-unavailable": "Selected model unavailable",
  "saved-state-rejected": "Saved state rejected",
  "beads-unavailable": "Beads export unavailable",
  "unresolved-overflow": "Progress input exceeds safe limit",
  "capacity-exhausted": "Progress state capacity reached",
};

class RetryableJevError extends RetryableProviderError {}

const copyUsage = (usage: ProviderUsage): ProviderUsage => ({ ...usage });
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
const presentationCard = (
  card: RetainedCard,
  beads?: BeadsPresentation,
): PresentationCard => ({
  ...copyCard(card),
  ...(beads ? { beads: { ...beads } } : {}),
});
const MAX_HEALTH_REQUIREMENTS_BYTES = 4 * 1024;
const MAX_HEALTH_REPORT_BYTES = 4 * 1024;

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
  private latestFrontier?: CanonicalFrontier;
  private precedingContext: Observation[] = [];
  private precedingFrontier?: CanonicalFrontier;
  private precedingTarget?: { id: string; includeTarget: boolean };
  private canonicalContinuationTimer?: ReturnType<typeof setTimeout>;
  private canonicalIncomplete = false;
  private restoring?: {
    data: unknown;
    sourceId: string;
    metadata: MonitorCheckpointMetadata | undefined;
    resume: boolean;
    target?: { id: string; includeTarget: boolean };
    frontier?: CanonicalFrontier;
    context: Observation[];
    epoch: number;
  };
  private queued: Observation[] = [];
  private processing = false;
  private waitingForWake = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryObservation?: Observation;
  private blockedPending?: { id: string; hash: string };
  private activeObservation?: { observation: Observation; epoch: number };
  private catchingUp = false;
  /** Initial backlog target; remains set until its observation commits. */
  private catchupTarget?: { id: string; hash: string };
  /** Set only by startup/restore history boundaries, never live appends. */
  private latchHistoricalCatchup = false;
  private epoch = 0;
  private extractionController?: AbortController;
  private healthObservation?: HealthWork;
  private healthFlight?: { epoch: number; token: number };
  private nextHealthToken = 0;
  private card?: RetainedCard;
  private cardHealthIdentity?: string;
  private beads = new Map<string, BeadsPresentation>();
  private beadsGeneration = 0;
  private beadsInFlight = false;
  private beadsRefreshQueued = false;
  private lastJevCallAt?: number;
  private lastExtractionCallAt?: number;
  private diagnostics = new Map<string, number>();

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
  }

  /** Display focus never establishes tool evidence authority. */
  evidenceLink() {
    return undefined;
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
    const value =
      result && typeof result === "object"
        ? { ...(result as object), isError }
        : { isError };
    this.evidence.finish(callId, toolName, value, Date.now());
  }

  setActivity(activity: string) {
    if (this.activity === activity) return;
    this.activity = activity;
    this.publish();
  }

  turnOn(cwd: string): string | undefined {
    if (this.enabled) return;
    return this.turnOnWithPass(cwd, this.beginCanonicalPass());
  }

  /** OFF→ON uses one canonical snapshot before gateway admission. */
  private turnOnWithPass(cwd: string, pass: CanonicalPass): string | undefined {
    this.cwd = cwd;
    if (!process.env.TYPESAFE_API_KEY?.trim()) {
      this.error = "TYPESAFE_API_KEY is required; progress monitor is OFF";
      this.enabled = false;
      this.publish();
      return this.error;
    }
    const sourceId = this.options.sourceId();
    if (sourceId !== this.state.sourceId) this.resetState(sourceId);
    // OFF history can change while no observer callback runs. Reset first.
    if (this.hasCanonicalAmendment(pass)) this.resetForCanonicalAmendment();
    if (this.canonicalIncomplete) {
      this.scheduleCanonicalContinuation();
      this.publish();
      return;
    }
    // A legacy exact-edge ON checkpoint remains readable but cannot enable.
    if (!this.falseProjectionFits()) {
      this.enabled = false;
      this.gateway.pause();
      this.note("capacity-exhausted");
      this.publish();
      return "Progress state capacity reached; monitoring remains OFF";
    }
    this.latchHistoricalCatchup = true;
    this.enabled = true;
    this.error = undefined;
    this.waitingForWake = false;
    this.clearRetry();
    this.epoch++;
    this.gateway.enable(this.identity());
    this.save();
    this.requeue(pass, true);
    this.refreshBeads();
    this.publish();
    this.drain();
  }

  turnOff() {
    if (!this.enabled) return;
    this.enabled = false;
    this.error = undefined;
    this.waitingForWake = false;
    this.clearRetry();
    this.epoch++;
    this.extractionController?.abort();
    this.cancelHealth();
    this.healthObservation = undefined;
    this.gateway.pause();
    this.evidence.clearPending();
    this.clearCanonicalContinuations();
    this.save();
    this.publish();
  }

  stop() {
    this.enabled = false;
    this.waitingForWake = false;
    this.clearRetry();
    this.epoch++;
    this.extractionController?.abort();
    this.cancelHealth();
    this.healthObservation = undefined;
    this.gateway.pause();
    this.evidence.clearPending();
    this.clearCanonicalContinuations();
    this.publish();
  }

  /** Model select is an explicit eligible wake for a paused selected-model phase. */
  modelSelected() {
    if (!this.enabled) return;
    const pass = this.beginCanonicalPass();
    if (this.hasCanonicalAmendment(pass)) this.resetForCanonicalAmendment();
    if (this.canonicalIncomplete) {
      this.scheduleCanonicalContinuation();
      this.publish();
      return;
    }
    this.clearRetry();
    this.epoch++;
    this.extractionController?.abort();
    this.cancelHealth();
    this.gateway.pause();
    this.gateway.enable(this.identity());
    this.waitingForWake = false;
    this.requeue(pass);
    this.publish();
    this.drain();
  }

  /** Canonical branch is read only on host observation, never from projections. */
  observe(reader: () => readonly unknown[]) {
    this.reader = reader;
    if (!this.enabled) return;
    const pass = this.beginCanonicalPass();
    if (this.hasCanonicalAmendment(pass)) this.resetForCanonicalAmendment();
    if (this.canonicalIncomplete) {
      this.scheduleCanonicalContinuation();
      this.publish();
      return;
    }
    this.requeue(pass);
    if (this.queued.length) this.cancelHealth();
    this.drain();
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

  private restoreTarget(data: unknown) {
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

  private continueRestore(work: NonNullable<Monitor["restoring"]>) {
    if (this.restoring !== work || work.epoch !== this.epoch) return;
    const pass = this.beginCanonicalPass();
    const context = work.target
      ? pass.precedingResult(
          work.target.id,
          work.target.includeTarget,
          work.frontier,
          work.context,
        )
      : { context: [] as Observation[], complete: true };
    if (!context.complete) {
      work.context = context.context;
      work.frontier = context.frontier;
      this.scheduleCanonicalContinuation();
      this.publish();
      return;
    }
    if (work.target) {
      this.precedingContext = context.context;
      this.precedingFrontier = context.frontier;
      this.precedingTarget = { ...work.target };
    }
    this.restoring = undefined;
    const restored = restoreCheckpoint(
      work.data,
      work.sourceId,
      (entryId) => this.resolveObservation(pass, entryId),
      (entryId) =>
        work.target?.id === entryId
          ? context.context
          : this.rehydratePreceding(pass, entryId),
    );
    if (restored) {
      this.state = copyState(restored);
      // Lifetime telemetry belongs to the saved source/session before semantic
      // reconciliation may discard stale task/card authority.
      this.applyMetadata(work.metadata);
      this.latchHistoricalCatchup = true;
      if (this.hasCanonicalAmendment(pass)) {
        this.resetState(work.sourceId, false);
        this.latchHistoricalCatchup = true;
      } else if (this.canonicalIncomplete) {
        // Replay cannot use an incomplete context as an empty authoritative one.
        this.restoring = work;
        this.scheduleCanonicalContinuation();
        this.publish();
        return;
      }
    } else if (this.restoreSourceMatches(work.data, work.sourceId)) {
      // A canonical amendment can make strict replay reject before it returns
      // state. Saved lifetime telemetry remains true even as semantic state
      // rebuilds from the amended branch.
      this.applyMetadata(work.metadata);
      this.resetState(work.sourceId, false);
      this.latchHistoricalCatchup = true;
    } else {
      if (work.data !== undefined) this.note("saved-state-rejected");
      this.resetState(work.sourceId);
    }
    this.enabled = false;
    if (work.resume) this.turnOnWithPass(this.cwd ?? "", pass);
    else this.publish();
  }

  async restore(
    cwd: string,
    data: unknown,
    preserveControls = false,
    reader?: () => readonly unknown[],
  ) {
    const wasEnabled = this.enabled;
    this.cwd = cwd;
    this.epoch++;
    this.extractionController?.abort();
    this.cancelHealth();
    this.gateway.pause();
    this.waitingForWake = false;
    this.clearRetry();
    this.clearCanonicalContinuations();
    this.queued = [];
    this.healthObservation = undefined;
    this.blockedPending = undefined;
    this.activeObservation = undefined;
    this.catchingUp = false;
    this.catchupTarget = undefined;
    this.latchHistoricalCatchup = false;
    this.beads.clear();
    this.beadsGeneration++;
    this.evidence.reset();
    this.diagnostics.clear();
    if (reader) this.reader = reader;
    const metadata = monitorCheckpointMetadata(data);
    const work = {
      data,
      sourceId: this.options.sourceId(),
      metadata,
      resume: preserveControls ? wasEnabled : (metadata?.enabled ?? true),
      target: this.restoreTarget(data),
      context: [] as Observation[],
      epoch: this.epoch,
    };
    this.restoring = work;
    this.continueRestore(work);
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

  private identity() {
    return `${this.state.sourceId}:${this.epoch}`;
  }

  /** Only canonical boundary factory reads host history. */
  private beginCanonicalPass() {
    return new CanonicalPass(this.reader ? this.reader() : []);
  }

  private clearCanonicalContinuations() {
    if (this.canonicalContinuationTimer)
      clearTimeout(this.canonicalContinuationTimer);
    this.canonicalContinuationTimer = undefined;
    this.page = [];
    this.pageBytes = 0;
    this.pageFrontier = undefined;
    this.latestFrontier = undefined;
    this.precedingContext = [];
    this.precedingFrontier = undefined;
    this.precedingTarget = undefined;
    this.canonicalIncomplete = false;
    this.restoring = undefined;
  }

  /** Semantic authority resets on amendment; billing lifetime resets only by source. */
  private resetState(sourceId: string, resetTelemetry = true) {
    this.state = emptyState(sourceId);
    this.card = undefined;
    this.cardHealthIdentity = undefined;
    this.clearCanonicalContinuations();
    this.queued = [];
    this.healthObservation = undefined;
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

  private metadata(enabled = this.enabled): MonitorCheckpointMetadata {
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
      ...(this.card ? { card: copyCard(this.card) } : {}),
    };
  }

  /** Every new durable semantic state must also support durable OFF control. */
  private falseProjectionFits(state = this.state) {
    try {
      checkpointBytes(state, this.metadata(false));
      return (
        checkpointBytes(state, this.metadata(false)) <= MAX_CHECKPOINT_BYTES
      );
    } catch {
      return false;
    }
  }

  /** A finite scan continuation, not an interval or idle polling loop. */
  private scheduleCanonicalContinuation() {
    if (
      this.canonicalContinuationTimer ||
      (this.restoring === undefined && !this.enabled)
    )
      return;
    const epoch = this.epoch;
    this.canonicalContinuationTimer = setTimeout(() => {
      this.canonicalContinuationTimer = undefined;
      if (epoch !== this.epoch) return;
      if (this.restoring) {
        this.continueRestore(this.restoring);
        return;
      }
      if (!this.enabled) return;
      const pass = this.beginCanonicalPass();
      if (this.hasCanonicalAmendment(pass)) this.resetForCanonicalAmendment();
      if (this.canonicalIncomplete) {
        this.scheduleCanonicalContinuation();
        this.publish();
        return;
      }
      this.requeue(pass);
      this.publish();
      this.drain();
    }, 0);
  }

  private applyMetadata(metadata: MonitorCheckpointMetadata | undefined) {
    this.card = metadata?.card ? copyCard(metadata.card) : undefined;
    this.cardHealthIdentity = undefined;
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
    if (!this.healthFlight) return;
    this.healthFlight = undefined;
    this.gateway.invalidate();
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
        if (this.hasCanonicalAmendment(pass)) this.resetForCanonicalAmendment();
        if (this.canonicalIncomplete) this.scheduleCanonicalContinuation();
        else this.requeue(pass);
        this.publish();
        this.drain();
      },
      Math.max(0, delay),
    );
    this.publish();
  }

  private service() {
    if (!this.enabled) return { code: "monitor-off", label: "Monitoring off" };
    if (this.waitingForWake)
      return { code: "model-unavailable", label: "Selected model unavailable" };
    if (this.error)
      return {
        code: "service-unavailable",
        label: "Progress service unavailable",
      };
    if (!/^(?:Ready|Current)$/.test(this.gateway.status))
      return { code: "jev-unavailable", label: "Jev service unavailable" };
    return { code: "ready", label: "Ready" };
  }

  private forceOff() {
    this.enabled = false;
    this.error = "Progress service unavailable";
    this.clearRetry();
    this.epoch++;
    this.extractionController?.abort();
    this.cancelHealth();
    this.healthObservation = undefined;
    this.evidence.clearPending();
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
      ...this.precedingContext.map((observation) => ({
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
          ]
        : []),
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

  /** Full relevant-source validation on one ephemeral coherent pass. */
  private hasCanonicalAmendment(pass: CanonicalPass) {
    this.canonicalIncomplete = false;
    let amended = false;
    const byId = new Map<string, ReturnType<typeof this.canonicalReferences>>();
    for (const reference of this.canonicalReferences()) {
      const expected = byId.get(reference.entryId) ?? [];
      expected.push(reference);
      byId.set(reference.entryId, expected);
    }
    // Do not short circuit: all relevant payload getters run once per boundary.
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
    const exactPreceding = (target: { id: string; includeTarget: boolean }) => {
      const sameTarget =
        this.precedingTarget?.id === target.id &&
        this.precedingTarget.includeTarget === target.includeTarget;
      const result = pass.precedingResult(
        target.id,
        target.includeTarget,
        sameTarget ? this.precedingFrontier : undefined,
        sameTarget ? this.precedingContext : [],
      );
      this.precedingContext = result.context;
      this.precedingFrontier = result.frontier;
      this.precedingTarget = target;
      if (!result.complete) {
        this.canonicalIncomplete = true;
        return;
      }
      return result.context;
    };
    const pending = this.state.pending;
    if (pending) {
      const context = exactPreceding({
        id: pending.observation.entryId,
        includeTarget: false,
      });
      if (context && !this.sameContext(pending.journal.gate.context, context))
        amended = true;
    }
    if (this.activeObservation) {
      const expected = this.precedingContext.map((observation) => ({
        entryId: observation.id,
        messageHash: observation.hash,
        role: observation.role,
      }));
      const context = exactPreceding({
        id: this.activeObservation.observation.id,
        includeTarget: false,
      });
      if (context && !this.sameContext(expected, context)) amended = true;
    }
    return amended;
  }

  /** Drop stale derived evidence before replaying a canonically amended branch. */
  private resetForCanonicalAmendment() {
    const sourceId = this.state.sourceId;
    this.epoch++;
    this.extractionController?.abort();
    this.cancelHealth();
    this.healthObservation = undefined;
    this.waitingForWake = false;
    this.clearRetry();
    this.gateway.pause();
    this.resetState(sourceId, false);
    this.latchHistoricalCatchup = true;
    this.activity = "Idle";
    if (this.enabled) this.gateway.enable(this.identity());
    this.save();
    this.publish();
  }

  /** Read one bounded chronological page from this boundary's canonical pass. */
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
    this.page.push(...result.page);
    this.pageBytes += result.page.reduce(
      (total, observation) => total + Buffer.byteLength(observation.text),
      0,
    );
    this.pageFrontier = result.frontier;
    if (
      (historical || this.latchHistoricalCatchup || this.catchingUp) &&
      !this.catchupTarget &&
      (this.page.length > 1 || result.hasMore)
    ) {
      // A final short page itself proves the target. Full pages spend the
      // exploratory quantum, so keep the catch-up latch until that final page.
      const finalVisible = !result.hasMore && this.page.at(-1);
      if (finalVisible)
        this.catchupTarget = {
          id: finalVisible.id,
          hash: finalVisible.hash,
        };
      else {
        const latest = pass.latestAfterResult(after, this.latestFrontier);
        this.latestFrontier = latest.frontier;
        if (latest.latest)
          this.catchupTarget = {
            id: latest.latest.id,
            hash: latest.latest.hash,
          };
        else if (!latest.complete) this.scheduleCanonicalContinuation();
      }
    }
    this.latchHistoricalCatchup = false;
    this.catchingUp =
      this.catchingUp ||
      !!this.catchupTarget ||
      result.hasMore ||
      (!!result.frontier && !result.frontier.terminal);
    if (result.frontier && !result.frontier.terminal)
      this.scheduleCanonicalContinuation();
    return true;
  }

  /** Restore at most two immediately preceding eligible observations. */
  private rehydratePreceding(
    pass: CanonicalPass,
    entryId: string | undefined,
    includeTarget = false,
  ) {
    return entryId ? pass.preceding(entryId, includeTarget) : [];
  }

  /** Resolve one current canonical ref from the current pass only. */
  private resolveObservation(pass: CanonicalPass, entryId: string) {
    return pass.observation(entryId);
  }

  private requeue(pass: CanonicalPass, historical = false) {
    if (this.canonicalIncomplete) {
      this.scheduleCanonicalContinuation();
      return;
    }
    if (this.waitingForWake) return;
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
        return;
      }
      this.queued = [current];
      return;
    }
    const cursor = this.state.cursor;
    if (!this.loadPage(pass, cursor, historical)) {
      this.resetForCanonicalAmendment();
      this.loadPage(pass, undefined, true);
    }
    this.queued = [...this.page];
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
      this.processing = true;
      this.activeObservation = { observation: { ...observation }, epoch };
      this.setActivity("Analyzing progress");
      void this.processOne(observation, epoch);
      return;
    }
    const healthWork = this.healthObservation;
    if (!healthWork || this.healthFlight) return;
    this.healthObservation = undefined;
    const flight = { epoch: this.epoch, token: ++this.nextHealthToken };
    this.healthFlight = flight;
    void this.processHealth(healthWork, flight);
  }

  private preceding(_observation: Observation) {
    return this.precedingContext;
  }

  private rememberPreceding(observation: Observation) {
    const context: Observation[] = [];
    let bytes = 0;
    for (const candidate of [...this.precedingContext, observation]
      .slice(-2)
      .reverse()) {
      const size = Buffer.byteLength(JSON.stringify(candidate));
      if (bytes + size > 4 * 1024) break;
      context.unshift(candidate);
      bytes += size;
    }
    this.precedingContext = context;
  }

  private async processOne(observation: Observation, epoch: number) {
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
          evaluate: (request) => this.evaluateJev(request, epoch),
          extract: (input) => this.extract(input, epoch),
          save: (state) => this.commit(state),
        },
        this.preceding(observation),
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
        this.rememberPreceding(observation);
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
      if (this.activeObservation?.epoch === epoch)
        this.activeObservation = undefined;
      if (epoch === this.epoch) {
        this.activity = "Idle";
        const pass = this.beginCanonicalPass();
        if (this.hasCanonicalAmendment(pass)) this.resetForCanonicalAmendment();
        if (this.canonicalIncomplete) this.scheduleCanonicalContinuation();
        else this.requeue(pass);
        this.publish();
      }
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
    this.healthObservation = {
      observation: { ...observation },
      taskId: target.id,
      revision: target.revision,
    };
  }

  private async processHealth(
    work: HealthWork,
    flight: { epoch: number; token: number },
  ) {
    try {
      const pass = this.beginCanonicalPass();
      if (this.hasCanonicalAmendment(pass)) {
        this.resetForCanonicalAmendment();
        return;
      }
      await this.assessHealth(flight.epoch, work, flight, pass);
    } catch (error) {
      if (this.healthFlight !== flight) return;
      if (error instanceof RetryableJevError) this.note("jev-unavailable");
      else if (error instanceof RetryableProviderError) {
        this.waitingForWake = true;
        this.note("model-unavailable");
      } else this.note("invalid-scope-result");
    } finally {
      if (this.healthFlight === flight) {
        this.healthFlight = undefined;
        this.activity = "Idle";
        this.publish();
      }
      this.drain();
    }
  }

  /** Saturating metadata bounds every dispatch and usage persistence boundary. */
  private capacityMetadata(card = this.card): MonitorCheckpointMetadata {
    const maximum = Number.MAX_SAFE_INTEGER;
    const maximumCard = card
      ? {
          ...copyCard(card),
          retained: false,
          replacementPending: false,
          assessedAt: maximum,
        }
      : undefined;
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
      ...(maximumCard ? { card: maximumCard } : {}),
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
  ): CapacityEnvelope {
    const current = this.metadata();
    const oldCard = this.retainedCardFor(this.state);
    const dispatch = this.capacityMetadata(oldCard);
    const accepted = this.capacityMetadata(
      card ?? this.retainedCardFor(candidate),
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

  /** Required by core before any paid phase or dispatch timestamp. */
  private admit(plan: AdmissionPlan) {
    if (this.state.capacity === "limit") return false;
    try {
      const envelope = this.capacityEnvelope(
        plan.phase,
        plan.candidate,
        this.retainedCardFor(plan.candidate),
        plan.schemaBytes,
      );
      if (envelope.maximum <= MAX_CHECKPOINT_BYTES) return true;
    } catch {
      // Invalid or unencodable candidate has no durable admission proof.
    }
    this.rejectCapacity();
    return false;
  }

  private maximumHealthCard(task: HybridTask): RetainedCard {
    return {
      taskId: task.id,
      revision: task.revision,
      label: task.label,
      retained: false,
      replacementPending: false,
      assessedAt: Number.MAX_SAFE_INTEGER,
      health: {
        requirements: "mostly clear",
        acceptance: "not-found-in-context",
        newRedTest: "Not needed",
        redEvidence: "Contradictory",
        implementation: "appears complete",
      },
    };
  }

  /** Whole health batch admission precedes its first Jev request. */
  private admitHealth(task: HybridTask, requests: number) {
    if (this.state.capacity === "limit") return false;
    try {
      if (
        this.capacityEnvelope(
          "health",
          this.state,
          this.maximumHealthCard(task),
          0,
          requests,
        ).maximum <= MAX_CHECKPOINT_BYTES &&
        requests > 0
      )
        return true;
    } catch {
      // Invalid or unencodable health projection has no admission proof.
    }
    this.rejectCapacity();
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

  private commit(state: HybridState) {
    const previousCard = this.card ? copyCard(this.card) : undefined;
    this.retainCardBeforeReplacement(state);
    let checkpoint: unknown;
    try {
      // No new semantic state may fit only while ON: OFF control is durable.
      encodeCheckpoint(state, this.metadata(false));
      checkpoint = encodeCheckpoint(state, this.metadata());
    } catch {
      this.card = previousCard;
      this.rejectCapacity();
      throw new DurabilityCapacityError();
    }
    this.state = copyState(state);
    try {
      this.persist(checkpoint);
    } catch {
      this.note("saved-state-rejected");
    }
    this.refreshBeads();
    this.publish();
  }

  private retainCardBeforeReplacement(next: HybridState) {
    const projected = this.retainedCardFor(next);
    if (projected) this.card = projected;
  }

  private recordJevDispatch(at: number) {
    if (this.lastJevCallAt === at) return;
    this.lastJevCallAt = at;
    this.save();
    this.publish();
  }

  private recordExtractionDispatch(at: number, epoch: number) {
    if (!this.enabled || epoch !== this.epoch) return;
    this.lastExtractionCallAt = at;
    this.save();
    this.publish();
  }

  private async evaluateJev(request: EvaluationRequest, epoch: number) {
    if (!this.enabled || epoch !== this.epoch)
      throw new RetryableProviderError();
    this.activity = "Assessing progress";
    this.publish();
    const result = await this.gateway.evaluate(request, this.identity(), true);
    if (!this.enabled || epoch !== this.epoch)
      throw new RetryableProviderError();
    if (!result) {
      if (this.gateway.retryPending) throw new RetryableJevError();
      throw new RetryableProviderError();
    }
    this.usage.jev.calls = saturatingAdd(this.usage.jev.calls, 1);
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

  private async extract(input: ExtractionInput, epoch: number) {
    if (!this.enabled || epoch !== this.epoch)
      throw new RetryableProviderError();
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
      if (!this.enabled || epoch !== this.epoch || controller.signal.aborted)
        throw new RetryableProviderError();
      if (
        !safeUsageValue(result.usage.inputTokens) ||
        !safeUsageValue(result.usage.outputTokens)
      )
        throw new RetryableProviderError();
      this.usage.extraction.calls = saturatingAdd(
        this.usage.extraction.calls,
        1,
      );
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
    flight: { epoch: number; token: number },
    pass: CanonicalPass,
  ) {
    const task = this.healthTaskForCurrentFocus(work);
    if (!task) return;
    const snapshot = this.projectedHealth(task, work.observation, pass);
    if (!snapshot || this.cardIsCurrent(task, snapshot.identity)) return;
    if (!this.admitHealth(task, snapshot.requests.length)) return;
    let combined: ValidatedResult | undefined;
    for (const request of snapshot.requests) {
      const result = await this.evaluateJev(request, epoch);
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
    if (this.hasCanonicalAmendment(currentPass)) {
      this.resetForCanonicalAmendment();
      return;
    }
    const current = currentTask
      ? this.projectedHealth(currentTask, work.observation, currentPass)
      : undefined;
    if (!current || current.identity !== snapshot.identity) return;
    const acceptance = combined.answers.acceptance;
    const applicability = combined.answers.redApplicability;
    const reported = combined.answers.redReport;
    this.card = {
      taskId: task.id,
      revision: task.revision,
      label: task.label,
      retained: task.status === "done",
      replacementPending: false,
      assessedAt: Date.now(),
      health: {
        requirements: healthRequirements(combined.answers.clarity),
        acceptance:
          acceptance?.type === "choice" ? acceptance.choice : "unknown",
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
          return implementation === "not-needed"
            ? "Not needed"
            : implementation;
        })(),
      },
    };
    this.cardHealthIdentity = snapshot.identity;
    this.save();
    this.publish();
  }
}
