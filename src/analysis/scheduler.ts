import { createHash } from "node:crypto";
import type { EvaluationRequest, JevGateway, ValidatedResult } from "./gateway";

interface Job {
  request: EvaluationRequest;
  consentIdentity: string;
  /** `cached` means prior identical runtime request already paid and validated. */
  admit: (result: ValidatedResult, cached?: boolean) => void;
}

const identityOf = (job: Job) =>
  createHash("sha256")
    .update(job.consentIdentity)
    .update(JSON.stringify(job.request))
    .digest("hex");

/**
 * Coalesced one-flight Jev dispatcher. Monitor owns semantic work selection;
 * this class only retains exact pending requests and yields between dispatches.
 */
export class AnalysisScheduler {
  private pending = new Map<string, Job>();
  /** Bounded exact validated-result reuse across semantic purposes. */
  private completed = new Map<string, ValidatedResult>();
  private running = false;
  private runningPurpose?: string;
  private runningIdentity?: string;
  private generation = 0;
  private purposeGeneration = new Map<string, number>();
  private scheduled = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private state:
    | "idle"
    | "scheduled"
    | "running"
    | "waiting-retry"
    | "stopped" = "idle";

  constructor(
    readonly gateway: JevGateway,
    private readonly changed: () => void,
  ) {}

  /** Observable controller state for truthful monitor diagnostics. */
  get controllerState() {
    return this.state;
  }

  clear() {
    this.generation++;
    this.pending.clear();
    this.completed.clear();
    this.clearRetry();
    this.scheduled = false;
    this.running = false;
    this.runningPurpose = undefined;
    this.runningIdentity = undefined;
    this.state = "stopped";
    this.gateway.invalidate();
  }

  discard(purpose: string) {
    this.purposeGeneration.set(
      purpose,
      (this.purposeGeneration.get(purpose) ?? 0) + 1,
    );
    this.pending.delete(purpose);
    if (this.runningPurpose === purpose) {
      this.running = false;
      this.runningPurpose = undefined;
      this.runningIdentity = undefined;
      this.gateway.invalidate();
    }
    if (!this.pending.size) this.clearRetry();
  }

  enqueue(purpose: string, job: Job) {
    const identity = identityOf(job);
    if (this.runningPurpose === purpose && this.runningIdentity === identity)
      return;
    const completed = this.completed.get(identity);
    if (completed) {
      const generation = this.generation;
      const purposeGeneration = this.purposeGeneration.get(purpose) ?? 0;
      queueMicrotask(() => {
        if (
          generation === this.generation &&
          purposeGeneration === (this.purposeGeneration.get(purpose) ?? 0)
        )
          job.admit(completed, true);
      });
      return;
    }
    const existing = this.pending.get(purpose);
    if (existing && identityOf(existing) === identity) return;
    this.pending.set(purpose, job);
    this.requestDrain();
  }

  /** Non-blocking host-safe coalesced wakeup. */
  requestDrain() {
    if (this.running || this.scheduled || !this.pending.size) return;
    if (this.gateway.retryPending) {
      this.armRetry();
      return;
    }
    this.scheduled = true;
    this.state = "scheduled";
    queueMicrotask(() => {
      this.scheduled = false;
      this.drain();
    });
  }

  /** Immediate test/manual seam. Host hooks use requestDrain(). */
  tick() {
    this.drain();
  }

  private drain() {
    if (this.running || !this.pending.size) {
      if (!this.running && !this.retryTimer) this.state = "idle";
      return;
    }
    if (this.gateway.retryPending) {
      this.armRetry();
      return;
    }
    const entry = this.pending.entries().next().value;
    if (!entry) {
      this.state = "idle";
      return;
    }
    const [purpose, job] = entry;
    const identity = identityOf(job);
    this.pending.delete(purpose);
    const generation = this.generation;
    const purposeGeneration = this.purposeGeneration.get(purpose) ?? 0;
    this.running = true;
    this.runningPurpose = purpose;
    this.runningIdentity = identity;
    this.state = "running";
    const settled = () => {
      if (
        generation !== this.generation ||
        purposeGeneration !== (this.purposeGeneration.get(purpose) ?? 0)
      )
        return;
      this.running = false;
      this.runningPurpose = undefined;
      this.runningIdentity = undefined;
      this.changed();
      if (this.gateway.retryPending) this.armRetry();
      // Gateway settlement is an event boundary. Start exact pending work now
      // so bounded fresh-class dispatch is not delayed until another host wake.
      else if (this.pending.size) this.drain();
      else this.state = "idle";
    };
    void this.gateway
      .evaluate(job.request, job.consentIdentity)
      .then((result) => {
        if (
          generation !== this.generation ||
          purposeGeneration !== (this.purposeGeneration.get(purpose) ?? 0)
        )
          return;
        try {
          if (result) {
            this.completed.set(identity, result);
            if (this.completed.size > 200) {
              const first = this.completed.keys().next().value;
              if (first) this.completed.delete(first);
            }
            job.admit(result);
          } else if (this.gateway.retryPending && !this.pending.has(purpose))
            this.pending.set(purpose, job);
        } finally {
          settled();
        }
      }, settled);
    this.changed();
  }

  private armRetry() {
    if (!this.pending.size) {
      this.clearRetry();
      this.state = "idle";
      return;
    }
    const delay = this.gateway.retryDelayMs;
    if (delay === undefined) return;
    if (delay <= 0) {
      this.requestDrain();
      return;
    }
    if (this.retryTimer) return;
    this.state = "waiting-retry";
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.requestDrain();
    }, delay);
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}
