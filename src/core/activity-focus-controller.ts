import {
  type ActivityCall,
  type ActivityList,
  activityFocusRequest,
  captureDeclaredTools,
  captureStartedTool,
  reconcileStartedTools,
} from "../analysis/activity-focus";
import type { JevGateway } from "../analysis/gateway";
import type { HybridTask } from "./hybrid-state";

/** Live Monitor authority; every value is re-read at each use. */
export interface ActivityFocusHost {
  enabled: () => boolean;
  cwd: () => string | undefined;
  epoch: () => number;
  identity: () => string;
  tasks: () => readonly HybridTask[];
  /** Canonical tracking must finish before optional activity can spend a request. */
  hasCanonicalWork: () => boolean;
  /** Exact saturated usage/timestamp proof for one optional dispatch. */
  admit: () => boolean;
  gateway: JevGateway;
  recordUsage: (usage: { input_tokens: number; output_tokens: number }) => void;
  note: (code: "jev-unavailable") => void;
  publish: () => void;
  save: () => void;
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

/** Optional display-only tool activity focus; never semantic authority. */
export class ActivityFocusController {
  private declaration?: ActivityDeclaration;
  private flight?: ActivityBatch;
  private queued?: ActivityBatch;
  private token = 0;
  /** Runtime-only activity can supersede semantic display, never semantic authority. */
  private focus?: ActivityFocus;
  private supersedes = false;

  constructor(private readonly host: ActivityFocusHost) {}

  get supersedesSemantic() {
    return this.supersedes;
  }

  /** Provisional declared calls dispatch immediately; final reconciliation is turn-bound. */
  observeDeclaration(message: unknown) {
    const cwd = this.host.cwd();
    if (!this.host.enabled() || !cwd) return;
    const provisional = captureDeclaredTools(message, cwd);
    if (!provisional) return;
    const batch = this.newBatch(provisional.calls);
    this.declaration = { batch, provisional, starts: new Map() };
    this.focus = undefined;
    this.supersedes = true;
    this.host.publish();
    if (provisional.kind === "ready") this.schedule(batch);
  }

  /** Actual starts remain runtime-only matching material; never evidence or provider data. */
  observeStart(callId: string, toolName: string, args: unknown) {
    const declaration = this.declaration;
    const cwd = this.host.cwd();
    if (!this.host.enabled() || !cwd || !declaration) return;
    const call = captureStartedTool(callId, toolName, args, cwd);
    declaration.starts.set(callId, call);
  }

  /** Reconcile only once all host tool starts for this turn are known. */
  observeTurnEnd(message: unknown) {
    const declaration = this.declaration;
    const cwd = this.host.cwd();
    if (!this.host.enabled() || !cwd || !declaration) return;
    this.declaration = undefined;
    const result = reconcileStartedTools(
      declaration.provisional,
      declaration.starts,
      message,
      cwd,
    );
    if (result.kind === "unchanged") return;
    // Later evidence supersedes provisional response before an optional correction.
    this.token++;
    this.focus = undefined;
    if (result.kind !== "changed" || !result.calls?.length) {
      // Empty observed starts restore semantic/fallback display. Every malformed
      // boundary remains newer-but-uncertain work and must hide stale INPROG/DONE.
      this.supersedes = result.kind !== "empty";
      this.host.publish();
      return;
    }
    const batch = this.newBatch(result.calls);
    this.supersedes = true;
    this.host.publish();
    this.schedule(batch);
  }

  /** Activity is optional and ephemeral: clear it without touching semantic state. */
  clear(cancel = true) {
    this.token++;
    this.declaration = undefined;
    this.queued = undefined;
    this.focus = undefined;
    this.supersedes = false;
    if (cancel) this.host.gateway.invalidate();
    this.flight = undefined;
  }

  /** Exact runtime identity avoids stale INPROG after close/revision/source edits. */
  focusTaskId() {
    const focus = this.focus;
    const task = focus
      ? this.host
          .tasks()
          .find(
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

  private newBatch(calls: readonly ActivityCall[]): ActivityBatch {
    return {
      token: ++this.token,
      epoch: this.host.epoch(),
      calls: calls.map((call) => ({
        callId: call.callId,
        member: { ...call.member },
      })),
    };
  }

  private candidates() {
    return this.host
      .tasks()
      .filter((task) => task.included && task.status !== "done")
      .map((task) => ({
        id: task.id,
        label: task.label,
        revision: task.revision,
      }));
  }

  private current(batch: ActivityBatch) {
    return (
      this.host.enabled() &&
      batch.epoch === this.host.epoch() &&
      batch.token === this.token
    );
  }

  private schedule(batch: ActivityBatch) {
    if (!this.current(batch)) return;
    if (this.flight) {
      this.queued = batch;
      return;
    }
    // Canonical admission/completion owns this epoch. Optional activity is
    // obsolete here rather than paid, queued, or retried behind semantic work.
    if (this.host.hasCanonicalWork()) {
      if (this.current(batch)) {
        this.focus = undefined;
        this.supersedes = false;
        this.host.publish();
      }
      return;
    }
    if (!this.host.admit()) {
      if (this.current(batch)) {
        this.focus = undefined;
        this.supersedes = false;
        this.host.publish();
      }
      return;
    }
    this.flight = batch;
    void this.process(batch);
  }

  private async process(batch: ActivityBatch) {
    try {
      const candidates = this.candidates();
      if (!this.current(batch) || !candidates.length) return;
      batch.candidates = candidates.map((candidate) => ({ ...candidate }));
      const request = activityFocusRequest(
        batch.calls.map((call) => call.member),
        batch.candidates,
      );
      const result = await this.host.gateway.evaluate(
        request,
        this.host.identity(),
        true,
      );
      if (result) {
        // Accepted responses retain usage even when their display generation went stale.
        this.host.recordUsage(result.usage);
        this.host.save();
      }
      if (!this.current(batch)) return;
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
        ? this.host
            .tasks()
            .find(
              (task) =>
                task.id === selected.id &&
                task.label === selected.label &&
                task.revision === selected.revision &&
                task.included &&
                task.status !== "done",
            )
        : undefined;
      this.focus = current
        ? { id: current.id, label: current.label, revision: current.revision }
        : undefined;
      // An accepted abstention or threshold abstention still supersedes stale INPROG.
      this.supersedes = true;
      this.host.publish();
    } catch {
      if (this.current(batch)) {
        this.focus = undefined;
        this.supersedes = false;
        this.host.note("jev-unavailable");
        this.host.publish();
      }
    } finally {
      if (this.flight === batch) this.flight = undefined;
      const queued = this.queued;
      this.queued = undefined;
      if (queued) this.schedule(queued);
    }
  }
}
