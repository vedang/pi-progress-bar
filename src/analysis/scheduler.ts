import type { EvaluationRequest, JevGateway, ValidatedResult } from "./gateway";

interface Job {
  request: EvaluationRequest;
  consentIdentity: string;
  admit: (result: ValidatedResult) => void;
}
/** Coalesce notifications, not report data. FIFO purposes share one gateway.
 * Future report consumers must own their ordered queues and enqueue the head.
 * tick() is non-blocking; no network promise escapes into host hooks.
 */
export class AnalysisScheduler {
  private pending = new Map<string, Job>();
  private running = false;
  private generation = 0;
  constructor(
    readonly gateway: JevGateway,
    private readonly changed: () => void,
  ) {}
  clear() {
    this.generation++;
    this.pending.clear();
    this.gateway.invalidate();
  }
  enqueue(purpose: string, job: Job) {
    this.pending.set(purpose, job);
  }
  tick() {
    if (this.running) return;
    const entry = this.pending.entries().next().value;
    if (!entry) return;
    const [purpose, job] = entry;
    this.pending.delete(purpose);
    const generation = this.generation;
    this.running = true;
    void this.gateway
      .evaluate(job.request, job.consentIdentity)
      .then((result) => {
        if (generation !== this.generation) return;
        if (result) job.admit(result);
        else if (
          this.gateway.status.startsWith("Pending: dispatch") &&
          !this.pending.has(purpose)
        )
          this.pending.set(purpose, job);
      })
      .finally(() => {
        this.running = false;
        this.changed();
      });
    this.changed();
  }
}
