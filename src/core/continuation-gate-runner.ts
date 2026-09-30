import type { ContinuationGateBatch } from "../analysis/continuation-gate";
import type { JevGateway, ValidatedResult } from "../analysis/gateway";

/** Live Monitor authority; every value is re-read at each use. */
export interface ContinuationGateHost {
  /** Mandatory canonical work and ready health always yield before continuation. */
  canStart: () => boolean;
  identity: () => string;
  gateway: JevGateway;
}

/** Continuation's own Jev flight; it never borrows semantic capacity. */
export class ContinuationGateRunner {
  private dispatch?: (at: number) => boolean;
  /** Raw continuation transport drain remains controller-owned across invalidation. */
  private physicalFlight?: (drain: Promise<void>) => void;

  constructor(private readonly host: ContinuationGateHost) {}

  /** Gateway fetch-boundary admission; absent flight never dispatches. */
  beforeDispatch(at: number) {
    return this.dispatch?.(at) === true;
  }

  observePhysicalFlight(drain: Promise<void>) {
    try {
      this.physicalFlight?.(drain);
    } catch {
      // Observation never controls continuation transport admission.
    }
  }

  /** One optional Jev admission, fenced by the controller at fetch boundary. */
  async evaluate(
    batch: ContinuationGateBatch,
    signal: AbortSignal,
    admit: () => boolean,
    onPhysicalFlight: (drain: Promise<void>) => void,
  ): Promise<ValidatedResult | undefined> {
    if (!this.host.canStart() || signal.aborted) return;
    const dispatch = (_at: number) => !signal.aborted && admit();
    this.dispatch = dispatch;
    this.physicalFlight = onPhysicalFlight;
    const abort = () => this.host.gateway.invalidate();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const result = await this.host.gateway.evaluate(
        batch.request,
        this.host.identity(),
        true,
      );
      return signal.aborted ? undefined : result;
    } finally {
      signal.removeEventListener("abort", abort);
      if (this.dispatch === dispatch) this.dispatch = undefined;
      if (this.physicalFlight === onPhysicalFlight)
        this.physicalFlight = undefined;
    }
  }

  /** Input/lifecycle invalidation aborts only continuation's own Jev flight. */
  invalidate() {
    this.host.gateway.invalidate();
    this.dispatch = undefined;
  }

  /** Revoke dispatch admission without touching the transport. */
  revoke() {
    this.dispatch = undefined;
  }
}
