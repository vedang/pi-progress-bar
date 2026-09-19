import type { ExtractionInput } from "../analysis/extractor";
import {
  type EvaluationRequest,
  JevGateway,
  type ValidatedResult,
} from "../analysis/gateway";
import { type HealthSnapshot, healthSnapshot } from "../analysis/health";
import { implementationFromResult } from "../analysis/implementation";
import { EvidenceStore, redEvidenceLabel } from "../sources/evidence";
import { canonicalMessages } from "../sources/messages";
import { processObservation, RetryableProviderError } from "./hybrid";
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

export interface PresentationSnapshot {
  enabled: boolean;
  progress: {
    done: number;
    total: number;
    kind: "current" | "previous" | "empty";
  };
  card?: RetainedCard;
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
};

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
  private observations: Observation[] = [];
  private queued: Observation[] = [];
  private processing = false;
  private waitingForWake = false;
  private epoch = 0;
  private extractionController?: AbortController;
  private card?: RetainedCard;
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

  turnOn(_cwd: string): string | undefined {
    if (this.enabled) return;
    if (!process.env.TYPESAFE_API_KEY?.trim()) {
      this.error = "TYPESAFE_API_KEY is required; progress monitor is OFF";
      this.enabled = false;
      this.publish();
      return this.error;
    }
    const sourceId = this.options.sourceId();
    if (sourceId !== this.state.sourceId) this.resetState(sourceId);
    this.enabled = true;
    this.error = undefined;
    this.waitingForWake = false;
    this.epoch++;
    this.gateway.enable(this.identity());
    this.save();
    this.requeue();
    this.publish();
    this.drain();
  }

  turnOff() {
    if (!this.enabled) return;
    this.enabled = false;
    this.error = undefined;
    this.waitingForWake = false;
    this.epoch++;
    this.extractionController?.abort();
    this.gateway.pause();
    this.evidence.clearPending();
    this.save();
    this.publish();
  }

  stop() {
    this.enabled = false;
    this.waitingForWake = false;
    this.epoch++;
    this.extractionController?.abort();
    this.gateway.pause();
    this.evidence.clearPending();
    this.publish();
  }

  /** Model select is an explicit eligible wake for a paused selected-model phase. */
  modelSelected() {
    if (!this.enabled) return;
    this.epoch++;
    this.extractionController?.abort();
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
    this.observations = canonicalMessages(reader());
    if (!this.enabled) return;
    this.requeue();
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
    this.epoch++;
    this.extractionController?.abort();
    this.gateway.pause();
    this.waitingForWake = false;
    this.queued = [];
    this.evidence.reset();
    this.diagnostics.clear();
    if (reader) this.reader = reader;
    this.observations = this.reader ? canonicalMessages(this.reader()) : [];
    const sourceId = this.options.sourceId();
    const restored = restoreCheckpoint(data, sourceId, (entryId) =>
      this.observations.find((item) => item.id === entryId),
    );
    const metadata = monitorCheckpointMetadata(data);
    if (restored) {
      this.state = copyState(restored);
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
      progress: { done, total: active.length, kind },
      ...(this.card ? { card: copyCard(this.card) } : {}),
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
      processing: this.processing
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
    this.queued = [];
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
    this.epoch++;
    this.extractionController?.abort();
    this.evidence.clearPending();
    this.save();
    this.publish();
  }

  private requeue() {
    if (this.waitingForWake) return;
    const pending = this.state.pending?.observation;
    if (pending) {
      const current = this.observations.find(
        (item) =>
          item.id === pending.entryId &&
          item.hash === pending.messageHash &&
          item.role === pending.role,
      );
      this.queued = current ? [current] : [];
      return;
    }
    const cursor = this.state.cursor;
    const start = cursor
      ? this.observations.findIndex(
          (item) => item.id === cursor.id && item.hash === cursor.hash,
        ) + 1
      : 0;
    this.queued =
      start > 0 ? this.observations.slice(start) : [...this.observations];
  }

  private drain() {
    if (
      !this.enabled ||
      this.processing ||
      this.waitingForWake ||
      !this.queued.length
    )
      return;
    const observation = this.queued[0];
    if (!observation) return;
    const epoch = this.epoch;
    this.processing = true;
    this.setActivity("Analyzing progress");
    void this.processOne(observation, epoch);
  }

  private preceding(observation: Observation) {
    const index = this.observations.findIndex(
      (item) => item.id === observation.id && item.hash === observation.hash,
    );
    return index > 0
      ? this.observations.slice(Math.max(0, index - 2), index)
      : [];
  }

  private async processOne(observation: Observation, epoch: number) {
    try {
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
      await this.assessHealth(epoch);
    } catch (error) {
      if (error instanceof RetryableProviderError) {
        this.waitingForWake = true;
        this.note("model-unavailable");
      } else this.note("invalid-scope-result");
    } finally {
      this.processing = false;
      if (epoch === this.epoch) {
        this.activity = "Idle";
        this.requeue();
        this.publish();
      }
      this.drain();
    }
  }

  private commit(state: HybridState) {
    this.retainCardBeforeReplacement(state);
    this.state = copyState(state);
    this.save();
    this.publish();
  }

  private retainCardBeforeReplacement(next: HybridState) {
    const card = this.card;
    if (!card || card.retained) return;
    const task = next.tasks.find((item) => item.id === card.taskId);
    if (
      !task ||
      next.focusTaskId !== card.taskId ||
      task.revision !== card.revision ||
      task.label !== card.label
    )
      this.card = {
        ...copyCard(card),
        retained: true,
        replacementPending: true,
      };
  }

  private async evaluateJev(request: EvaluationRequest, epoch: number) {
    if (!this.enabled || epoch !== this.epoch)
      throw new RetryableProviderError();
    this.activity = "Assessing progress";
    this.publish();
    const result = await this.gateway.evaluate(request, this.identity(), true);
    if (!this.enabled || epoch !== this.epoch || !result)
      throw new RetryableProviderError();
    this.usage.jev.calls++;
    this.usage.jev.inputTokens += result.usage.input_tokens;
    this.usage.jev.outputTokens += result.usage.output_tokens;
    this.lastJevCallAt = this.gateway.lastCallAt;
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
    this.lastExtractionCallAt = Date.now();
    this.publish();
    try {
      const result = await this.options.extract(input, controller.signal);
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

  private projectedHealth(task: HybridTask): HealthSnapshot | undefined {
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
    return healthSnapshot(ledger, this.epoch, []);
  }

  private cardIsCurrent(task: HybridTask) {
    return (
      !!this.card &&
      !this.card.retained &&
      this.card.taskId === task.id &&
      this.card.revision === task.revision &&
      this.card.label === task.label
    );
  }

  private async assessHealth(epoch: number) {
    const task = this.state.tasks.find(
      (item) => item.id === this.state.focusTaskId && item.included,
    );
    if (!task || this.cardIsCurrent(task)) return;
    const snapshot = this.projectedHealth(task);
    if (!snapshot) return;
    let combined: ValidatedResult | undefined;
    for (const request of snapshot.requests) {
      const result = await this.evaluateJev(request, epoch);
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
    if (!combined || !this.enabled || epoch !== this.epoch) return;
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
    this.save();
    this.publish();
  }
}
