import { createHash } from "node:crypto";

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
import {
  canonicalHeaders,
  canonicalObservation,
  MAX_CANONICAL_PAGE_BYTES,
  MAX_CANONICAL_PAGE_MESSAGES,
} from "../sources/messages";
import {
  DurabilityCapacityError,
  processObservation,
  RetryableProviderError,
} from "./hybrid";
import {
  encodeCheckpoint,
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

const CHECKPOINT_BYTES = 512 * 1024;
const TRANSACTION_JOURNAL_RESERVE_BYTES = 16 * 1024;

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
const validUsage = (usage: ProviderUsage) => ({
  calls: usage.calls,
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
});
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
const payloadHash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex");

/**
 * Read own descriptors only. Plain host payload edits change this fingerprint;
 * accessor-backed payloads receive bounded canonical round-robin validation.
 */
const authorityFingerprint = (entry: Record<string, unknown>) => {
  const message = Object.getOwnPropertyDescriptor(entry, "message")?.value;
  if (!message || typeof message !== "object") return "no-message";
  const content = Object.getOwnPropertyDescriptor(message, "content");
  if (!content) return "no-content";
  if (content.get || content.set) return `accessor:${String(content.get)}`;
  if (typeof content.value === "string")
    return `text:${payloadHash(content.value)}`;
  if (!Array.isArray(content.value)) return `other:${typeof content.value}`;
  const blocks = content.value.map((block) => {
    if (!block || typeof block !== "object") return "other";
    const item = block as Record<string, unknown>;
    const type = Object.getOwnPropertyDescriptor(item, "type")?.value;
    const text = Object.getOwnPropertyDescriptor(item, "text");
    return [
      type,
      text?.get || text?.set ? "accessor" : payloadHash(text?.value),
    ];
  });
  return `blocks:${payloadHash(blocks)}`;
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
  private precedingContext: Observation[] = [];
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
  /** Bounded derived authority facts; never store canonical text. */
  private authorityIndex = new Map<
    string,
    { hash: string; role: Observation["role"]; fingerprint: string }
  >();
  private authoritySampleCursor = 0;
  private epoch = 0;
  private extractionController?: AbortController;
  private healthObservation?: Observation;
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
    if (this.hasCanonicalAmendment(true)) this.resetForCanonicalAmendment();
    this.enabled = true;
    this.error = undefined;
    this.waitingForWake = false;
    this.clearRetry();
    this.epoch++;
    this.gateway.enable(this.identity());
    this.save();
    this.requeue();
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
    this.publish();
  }

  /** Model select is an explicit eligible wake for a paused selected-model phase. */
  modelSelected() {
    if (!this.enabled) return;
    this.clearRetry();
    this.epoch++;
    this.extractionController?.abort();
    this.cancelHealth();
    this.gateway.pause();
    this.gateway.enable(this.identity());
    this.waitingForWake = false;
    this.requeue();
    this.publish();
    this.drain();
  }

  /** Canonical branch is read only on host observation, never from projections. */
  observe(reader: () => readonly unknown[]) {
    this.reader = reader;
    if (!this.enabled) return;
    if (this.hasCanonicalAmendment()) this.resetForCanonicalAmendment();
    this.requeue();
    if (this.queued.length) this.cancelHealth();
    this.drain();
  }

  checkpoint(): unknown {
    return encodeCheckpoint(this.state, this.metadata());
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
    this.page = [];
    this.precedingContext = [];
    this.queued = [];
    this.healthObservation = undefined;
    this.blockedPending = undefined;
    this.activeObservation = undefined;
    this.catchingUp = false;
    this.catchupTarget = undefined;
    this.authorityIndex.clear();
    this.authoritySampleCursor = 0;
    this.beads.clear();
    this.beadsGeneration++;
    this.evidence.reset();
    this.diagnostics.clear();
    if (reader) this.reader = reader;
    const sourceId = this.options.sourceId();
    const restored = restoreCheckpoint(data, sourceId, (entryId) =>
      this.resolveObservation(entryId),
    );
    const metadata = monitorCheckpointMetadata(data);
    if (restored) {
      this.state = copyState(restored);
      this.precedingContext = this.rehydratePreceding(
        restored.pending?.observation.entryId ?? restored.cursor?.id,
        !restored.pending,
      );
      this.applyMetadata(metadata);
    } else {
      if (data !== undefined) this.note("saved-state-rejected");
      this.resetState(sourceId);
    }
    const resume = preserveControls ? wasEnabled : (metadata?.enabled ?? true);
    this.enabled = false;
    if (resume) this.turnOn(cwd);
    else this.publish();
  }

  /** Detached plain projection; it does not read history, persist, or schedule. */
  presentationSnapshot(): PresentationSnapshot {
    const active = this.state.tasks.filter((task) => task.included);
    const done = active.filter((task) => task.status === "done").length;
    const kind = !active.length
      ? "empty"
      : this.state.scopeUnresolved
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

  private resetState(sourceId: string) {
    this.state = emptyState(sourceId);
    this.card = undefined;
    this.cardHealthIdentity = undefined;
    this.page = [];
    this.precedingContext = [];
    this.queued = [];
    this.healthObservation = undefined;
    this.blockedPending = undefined;
    this.activeObservation = undefined;
    this.catchingUp = false;
    this.catchupTarget = undefined;
    this.authorityIndex.clear();
    this.authoritySampleCursor = 0;
    this.beads.clear();
    this.beadsGeneration++;
    this.lastJevCallAt = undefined;
    this.lastExtractionCallAt = undefined;
    this.usage.jev.calls = 0;
    this.usage.jev.inputTokens = 0;
    this.usage.jev.outputTokens = 0;
    this.usage.extraction.calls = 0;
    this.usage.extraction.inputTokens = 0;
    this.usage.extraction.outputTokens = 0;
  }

  private metadata(): MonitorCheckpointMetadata {
    return {
      enabled: this.enabled,
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
        this.requeue();
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

  /** Validate only bounded state authority, never the unbounded history payload. */
  private hasCanonicalAmendment(force = false) {
    if (!this.reader) return false;
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
      ...(this.state.pending?.proofs
        ? [
            ...(this.state.pending.proofs.gate?.context ?? []),
            ...(this.state.pending.proofs.patch?.context ?? []),
            ...this.state.pending.proofs.completions.flatMap(
              (proof) => proof.context,
            ),
          ]
        : []),
      ...(this.state.cursor
        ? [
            {
              entryId: this.state.cursor.id,
              messageHash: this.state.cursor.hash,
            },
          ]
        : []),
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
    ];
    if (!references.length) return false;
    const headers = new Map(
      canonicalHeaders(this.reader()).map((header) => [header.id, header]),
    );
    const byId = new Map<string, typeof references>();
    for (const reference of references) {
      const group = byId.get(reference.entryId) ?? [];
      group.push(reference);
      byId.set(reference.entryId, group);
    }
    const sampleStart = this.authoritySampleCursor % byId.size;
    let referenceIndex = 0;
    for (const [entryId, expected] of byId) {
      const sampleOffset =
        (referenceIndex++ - sampleStart + byId.size) % byId.size;
      const header = headers.get(entryId);
      if (!header) return true;
      const fingerprint = authorityFingerprint(header.entry);
      const cached = this.authorityIndex.get(entryId);
      const needsMaterialization =
        force ||
        !cached ||
        cached.fingerprint !== fingerprint ||
        expected.some(
          (reference) =>
            cached.hash !== reference.messageHash ||
            (reference.role !== undefined && cached.role !== reference.role),
        ) ||
        (fingerprint.includes("accessor") && sampleOffset < 4);
      if (!needsMaterialization) continue;
      const current = canonicalObservation(header);
      if (
        !current ||
        expected.some(
          (reference) =>
            current.hash !== reference.messageHash ||
            (reference.role !== undefined && current.role !== reference.role),
        )
      )
        return true;
      this.authorityIndex.set(entryId, {
        hash: current.hash,
        role: current.role,
        fingerprint,
      });
    }
    this.authoritySampleCursor = (sampleStart + 4) % byId.size;
    return false;
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
    this.resetState(sourceId);
    this.activity = "Idle";
    if (this.enabled) this.gateway.enable(this.identity());
    this.save();
    this.publish();
  }

  /** Read one bounded chronological page; header scans never access payload text. */
  private loadPage(after?: { id: string; hash: string }) {
    const entries = this.reader?.() ?? [];
    const headers = canonicalHeaders(entries);
    let afterIndex = -1;
    if (after) {
      const index = headers.findIndex((header) => header.id === after.id);
      const header = index < 0 ? undefined : headers[index];
      const cached = header ? this.authorityIndex.get(header.id) : undefined;
      const current =
        header &&
        cached?.hash === after.hash &&
        cached.fingerprint === authorityFingerprint(header.entry)
          ? undefined
          : header
            ? canonicalObservation(header)
            : undefined;
      if (header && current && current.hash === after.hash)
        this.authorityIndex.set(header.id, {
          hash: current.hash,
          role: current.role,
          fingerprint: authorityFingerprint(header.entry),
        });
      if (
        !header ||
        (current && current.hash !== after.hash) ||
        (!current && (!cached || cached.hash !== after.hash))
      ) {
        this.resetForCanonicalAmendment();
      } else afterIndex = index;
    }
    if (
      !after &&
      !this.state.cursor &&
      !this.catchupTarget &&
      headers.length > 1
    ) {
      for (let index = headers.length - 1; index >= 0; index--) {
        const latest = canonicalObservation(headers[index]);
        if (latest) {
          this.catchupTarget = { id: latest.id, hash: latest.hash };
          break;
        }
      }
    }
    const page: Observation[] = [];
    let bytes = 0;
    let hasMore = false;
    for (let index = afterIndex + 1; index < headers.length; index++) {
      const header = headers[index];
      if (!header) continue;
      const observation = canonicalObservation(header);
      if (!observation) continue;
      const size = Buffer.byteLength(observation.text);
      if (
        page.length &&
        (page.length >= MAX_CANONICAL_PAGE_MESSAGES ||
          bytes + size > MAX_CANONICAL_PAGE_BYTES)
      ) {
        hasMore = true;
        break;
      }
      page.push(observation);
      bytes += size;
    }
    this.page = page;
    this.catchingUp = !!this.catchupTarget || hasMore;
  }

  /** Restore at most two immediately preceding eligible observations. */
  private rehydratePreceding(
    entryId: string | undefined,
    includeTarget = false,
  ) {
    if (!entryId || !this.reader) return [];
    const headers = canonicalHeaders(this.reader());
    const index = headers.findIndex((header) => header.id === entryId);
    if (index < 0) return [];
    const context: Observation[] = [];
    let bytes = 0;
    for (
      let cursor = includeTarget ? index : index - 1;
      cursor >= 0 && context.length < 2;
      cursor--
    ) {
      const header = headers[cursor];
      if (!header) continue;
      const observation = canonicalObservation(header);
      if (!observation) continue;
      const size = Buffer.byteLength(JSON.stringify(observation));
      if (bytes + size > 4 * 1024) break;
      context.unshift(observation);
      bytes += size;
    }
    return context;
  }

  /** Resolve one current canonical ref without retaining or materializing history. */
  private resolveObservation(entryId: string): Observation | undefined {
    const header = canonicalHeaders(this.reader?.() ?? []).find(
      (item) => item.id === entryId,
    );
    const observation = header ? canonicalObservation(header) : undefined;
    if (header && observation)
      this.authorityIndex.set(entryId, {
        hash: observation.hash,
        role: observation.role,
        fingerprint: authorityFingerprint(header.entry),
      });
    return observation;
  }

  private requeue() {
    if (this.waitingForWake) return;
    if (this.blockedPending && !this.state.pending) {
      this.queued = [];
      return;
    }
    if (this.retryObservation) {
      this.queued = [this.retryObservation];
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
      const current = this.resolveObservation(pending.entryId);
      if (
        !current ||
        current.hash !== pending.messageHash ||
        current.role !== pending.role
      ) {
        this.resetForCanonicalAmendment();
        this.loadPage();
        this.queued = [...this.page];
        return;
      }
      this.queued = [current];
      return;
    }
    const cursor = this.state.cursor;
    const current = cursor
      ? this.page.find(
          (item) => item.id === cursor.id && item.hash === cursor.hash,
        )
      : undefined;
    if (current) {
      const index = this.page.indexOf(current);
      if (index < this.page.length - 1) {
        this.queued = this.page.slice(index + 1);
        return;
      }
    }
    this.loadPage(cursor);
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
    const healthObservation = this.healthObservation;
    if (!healthObservation || this.healthFlight) return;
    this.healthObservation = undefined;
    const flight = { epoch: this.epoch, token: ++this.nextHealthToken };
    this.healthFlight = flight;
    void this.processHealth(healthObservation, flight);
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
      // Reserve bounded journal room before any provider dispatch.
      if (!this.hasTransactionHeadroom()) {
        this.rejectCapacity();
        this.blockedPending = { id: observation.id, hash: observation.hash };
        return;
      }
      const next = await processObservation(
        this.state,
        observation,
        {
          evaluate: (request) => this.evaluateJev(request, epoch),
          extract: (input) => this.extract(input, epoch),
          save: (state) => this.commit(state),
        },
        this.preceding(observation),
      );
      if (!this.enabled || epoch !== this.epoch) return;
      this.commit(next);
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
          this.scheduleHealth(observation);
        }
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
        this.requeue();
        this.publish();
      }
      this.drain();
    }
  }

  /** New semantic observations replace stale optional health work. */
  private scheduleHealth(observation: Observation) {
    this.healthObservation = { ...observation };
  }

  private async processHealth(
    observation: Observation,
    flight: { epoch: number; token: number },
  ) {
    try {
      await this.assessHealth(flight.epoch, observation, flight);
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

  private hasTransactionHeadroom() {
    try {
      return (
        Buffer.byteLength(
          JSON.stringify(encodeCheckpoint(this.state, this.metadata())),
        ) <=
        CHECKPOINT_BYTES - TRANSACTION_JOURNAL_RESERVE_BYTES
      );
    } catch {
      return false;
    }
  }

  /** Preserve current durable transaction while exposing capacity as unresolved. */
  private rejectCapacity() {
    const rejected: HybridState = {
      ...this.state,
      scopeUnresolved: true,
      scopeFailure: "capacity",
      scopeError: "Hybrid checkpoint exceeds durable capacity",
    };
    try {
      const checkpoint = encodeCheckpoint(rejected, this.metadata());
      this.state = copyState(rejected);
      this.persist(checkpoint);
    } catch {
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
      // Preflight full state plus monitor metadata before replacing durable state.
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
    const card = this.card;
    if (!card) return;
    const task = next.tasks.find((item) => item.id === card.taskId);
    if (card.retained) {
      if (card.replacementPending && task?.status === "done")
        this.card = { ...copyCard(card), replacementPending: false };
      return;
    }
    const completed = task?.status === "done";
    if (
      !task ||
      completed ||
      next.focusTaskId !== card.taskId ||
      task.revision !== card.revision ||
      task.label !== card.label
    )
      this.card = {
        ...copyCard(card),
        retained: true,
        replacementPending: !completed,
      };
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
    this.usage.jev.calls++;
    this.usage.jev.inputTokens += result.usage.input_tokens;
    this.usage.jev.outputTokens += result.usage.output_tokens;
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
      this.usage.extraction.calls++;
      this.usage.extraction.inputTokens += result.usage.inputTokens;
      this.usage.extraction.outputTokens += result.usage.outputTokens;
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
  ): HealthSnapshot | undefined {
    const ledger: Ledger = {
      sourceId: this.state.sourceId,
      kind: "conversation",
      sourceRevision: task.source.messageHash,
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
    return healthSnapshot(ledger, this.epoch, [
      `Latest canonical ${observation.role} report:\n${observation.text}`,
    ]);
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

  private async assessHealth(
    epoch: number,
    observation: Observation,
    flight: { epoch: number; token: number },
  ) {
    const task = this.state.tasks.find(
      (item) =>
        item.id === this.state.focusTaskId &&
        item.included &&
        item.status !== "done",
    );
    if (!task) return;
    const snapshot = this.projectedHealth(task, observation);
    if (!snapshot || this.cardIsCurrent(task, snapshot.identity)) return;
    let combined: ValidatedResult | undefined;
    for (const request of snapshot.requests) {
      const result = await this.evaluateJev(request, epoch);
      if (this.healthFlight !== flight) throw new RetryableProviderError();
      combined = {
        model: result.model,
        answers: { ...(combined?.answers ?? {}), ...result.answers },
        usage: {
          input_tokens:
            (combined?.usage.input_tokens ?? 0) + result.usage.input_tokens,
          output_tokens:
            (combined?.usage.output_tokens ?? 0) + result.usage.output_tokens,
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
    const acceptance = combined.answers.acceptance;
    const applicability = combined.answers.redApplicability;
    const reported = combined.answers.redReport;
    this.card = {
      taskId: task.id,
      revision: task.revision,
      label: task.label,
      retained: false,
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
        implementation: implementationFromResult(
          [task.label],
          combined,
          [],
          0,
          snapshot.implementationEvidenceComplete,
        ),
      },
    };
    this.cardHealthIdentity = snapshot.identity;
    this.save();
    this.publish();
  }
}
