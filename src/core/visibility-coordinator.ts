import type { ReconciliationUncertainActivity } from "../advisory/reconciliation";
import {
  buildLabelBindingRequest,
  buildLabelSelectionRequest,
  type LabelCandidateBundle,
  type LabelSelections,
  readLabelBindings,
  readLabelSelections,
  type VisibilityTask,
} from "../analysis/activity-label";
import type { EvaluationRequest, JevGateway } from "../analysis/gateway";
import { record } from "../shared/guards";
import { sha256 } from "../shared/hash";
import { CanonicalPass } from "../sources/messages";
import { visibilityTaskSourceDigest } from "./board-projection";
import {
  type ExecutionVisibilitySnapshot,
  ExecutionVisibilityStore,
  type VisibilityToolPhase,
} from "./execution-visibility";
import type { HybridTask } from "./hybrid-state";

/** Live Monitor authority; every value is re-read at each use. */
export interface VisibilityHost {
  enabled: () => boolean;
  epoch: () => number;
  identity: () => string;
  /** Optional visibility may run only after all semantic/advisory admission is quiet. */
  ready: () => boolean;
  tasks: () => readonly HybridTask[];
  gateway: JevGateway;
  publish: () => void;
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

/** Exact assistant-visible prose only; tool blocks and other roles are ineligible. */
const assistantVisibleText = (message: unknown) => {
  const value = record(message) ? message : undefined;
  if (value?.role !== "assistant") return;
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return;
  const text: string[] = [];
  for (const part of value.content) {
    const item = record(part) ? part : undefined;
    if (item?.type === "text" && typeof item.text === "string")
      text.push(item.text);
  }
  return text.join("");
};

const visibilityPhase = (
  toolName: string,
  args: unknown,
): VisibilityToolPhase => {
  if (["read", "grep", "find", "search"].includes(toolName))
    return "Inspecting code";
  if (["edit", "write"].includes(toolName)) return "Editing code";
  if (toolName !== "bash") return "Using a tool";
  const command = record(args) ? args.command : undefined;
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
};

const frontierFor = (pass: CanonicalPass): VisibilityCanonicalFrontier => {
  const headers = pass.headers.map((header) => [header.id, header.role]);
  const last = pass.headers.at(-1);
  return {
    length: headers.length,
    digest: sha256(JSON.stringify(headers)),
    ...(last ? { lastId: last.id, lastRole: last.role } : {}),
  };
};

const canonicalAfter = (
  pass: CanonicalPass,
  frontier: VisibilityCanonicalFrontier,
) => {
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
};

/**
 * Runtime-only execution visibility: live capture, canonical confirmation and
 * two-stage optional labeling. Never semantic, settlement or checkpoint data.
 */
export class ExecutionVisibilityCoordinator {
  private readonly store = new ExecutionVisibilityStore();
  private sources = new Map<string, VisibilitySource>();
  /** Last branch frontier observed before a one-argument live capture. */
  private canonicalFrontier?: VisibilityCanonicalFrontier;
  private latestToken?: string;
  private stage1?: string;
  private stage2: string[] = [];
  private flight?: VisibilityFlight;

  constructor(private readonly host: VisibilityHost) {}

  identity() {
    return `${this.host.identity()}:visibility:${this.store.snapshot().generation}`;
  }

  /** Detached runtime-only visibility projection; never semantic/checkpoint data. */
  snapshot(): ExecutionVisibilitySnapshot {
    return this.store.snapshot();
  }

  /** Gateway dispatch callback; spend is isolated from semantic telemetry. */
  recordDispatch() {
    this.store.recordDispatch();
    this.host.publish();
  }

  /** Gateway permanent failure never changes semantic/advisory availability. */
  markUnavailable() {
    this.store.markIncomplete();
    this.host.publish();
  }

  /** Start a live run without restoring or changing runtime history. */
  runStarted() {
    if (!this.host.enabled()) return;
    this.store.startRun();
    this.host.publish();
  }

  /** Settlement clears current display; a confirmed history flight may still finish. */
  runSettled() {
    if (!this.host.enabled()) return;
    this.store.settle();
    if (this.flight?.stage === 1) this.dropFlight();
    this.stage1 = undefined;
    this.host.publish();
  }

  /**
   * Capture listener-relative live assistant text. The optional active branch is
   * a preappend canonical frontier, never evidence selected by text alone.
   */
  observeMessage(message: unknown, branch?: readonly unknown[]) {
    if (!this.host.enabled()) return;
    const value = record(message) ? message : undefined;
    if (value?.role !== "assistant") return;
    // Every assistant ingress clears older provisional current and its pending
    // Stage 1 before this message can abstain, overflow, or be rejected.
    this.supersedeMessage();
    if (value.stopReason === "error" || value.stopReason === "aborted") {
      this.store.markIncomplete();
      this.host.publish();
      return;
    }
    const frontier = this.frontier(branch);
    const text = assistantVisibleText(message);
    if (!frontier || text === undefined) {
      this.store.markIncomplete();
      this.host.publish();
      return;
    }
    const bundle = this.store.capture(text);
    if (!bundle) {
      this.host.publish();
      return;
    }
    this.sources.set(bundle.liveToken, {
      bundle,
      frontier,
      confirmed: false,
      stage2: "unseen",
    });
    this.latestToken = bundle.liveToken;
    this.stage1 = bundle.liveToken;
    while (this.sources.size > 8) {
      const token = this.sources.keys().next().value as string | undefined;
      if (!token) break;
      this.dropSource(token);
    }
    this.drain();
    this.host.publish();
  }

  /** Match only a new canonical assistant entry after this source's frontier. */
  confirmBranch(branch: readonly unknown[]) {
    if (!this.host.enabled() || !this.latestToken) return;
    const token = this.latestToken;
    const source = this.sources.get(token);
    if (!source) return;
    const pass = new CanonicalPass(branch);
    const canonical = canonicalAfter(pass, source.frontier);
    if (!this.store.confirm(token, canonical?.text ?? "")) {
      this.dropSource(token);
    } else {
      source.confirmed = true;
      if (source.selections) this.enqueueStage2(token);
    }
    this.drain();
    this.host.publish();
  }

  /** Finite local tool phase only; no path, argument, output, or tool name escapes. */
  toolStart(callId: string, toolName: string, args: unknown) {
    if (!this.host.enabled()) return;
    this.store.toolStart(callId, visibilityPhase(toolName, args));
    this.host.publish();
  }

  /** A terminal tool event only clears its matching local phase. */
  toolEnd(callId: string) {
    if (!this.host.enabled()) return;
    this.store.toolEnd(callId);
    this.host.publish();
  }

  /** Cache only a canonical frontier for one-argument test/host fallback. */
  rememberFrontier(pass: CanonicalPass) {
    this.canonicalFrontier = frontierFor(pass);
  }

  /** Accepted semantic tasks prune stale runtime associations. */
  reconcileCurrentTasks() {
    this.store.reconcileCurrentTasks(this.tasks() ?? []);
  }

  /**
   * Copy only still-open exact MAYBE task receipts into the established
   * reconciliation snapshot. Generic semantic replies never clear them: no
   * semantic reducer is an ownership validator for a reported activity.
   */
  uncertainActivities(): ReconciliationUncertainActivity[] {
    const current = new Map(
      (this.tasks() ?? []).map((task) => [task.id, task]),
    );
    const open = new Set(
      this.host
        .tasks()
        .filter((task) => task.included && task.status !== "done")
        .map((task) => task.id),
    );
    return this.store
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

  reset() {
    this.host.gateway.pause();
    this.store.reset();
    this.sources.clear();
    this.canonicalFrontier = undefined;
    this.latestToken = undefined;
    this.stage1 = undefined;
    this.stage2 = [];
    this.flight = undefined;
  }

  /** Cancel optional work without retries when a newer mandatory boundary wins. */
  dropFlight() {
    const flight = this.flight;
    if (!flight) return;
    if (flight.stage === 2) this.terminalStage2(flight.token);
    this.host.gateway.invalidate();
    this.store.markIncomplete();
    this.flight = undefined;
  }

  drain() {
    if (!this.host.ready() || this.flight) return;
    const stage1 = this.stage1;
    if (stage1) {
      this.stage1 = undefined;
      const source = this.sources.get(stage1);
      const request = source && buildLabelSelectionRequest(source.bundle);
      if (!source || !request || this.store.snapshot().budgetRemaining < 1) {
        this.store.markIncomplete();
        this.host.publish();
        return;
      }
      const flight: VisibilityFlight = {
        token: stage1,
        stage: 1,
        epoch: this.host.epoch(),
        generation: this.store.snapshot().generation,
      };
      this.flight = flight;
      void this.runStage1(flight, request);
      return;
    }
    const stage2 = this.stage2.shift();
    if (!stage2) return;
    const source = this.sources.get(stage2);
    if (source?.stage2 !== "queued") {
      this.terminalStage2(stage2);
      this.store.markIncomplete();
      this.host.publish();
      return;
    }
    const tasks = this.tasks();
    const request =
      source.confirmed && source.selections && tasks
        ? buildLabelBindingRequest(
            source.bundle,
            source.selections,
            tasks,
            source.bundle.messageHash,
          )
        : undefined;
    if (!tasks || !request || this.store.snapshot().budgetRemaining < 1) {
      this.terminalStage2(stage2);
      this.store.markIncomplete();
      this.host.publish();
      return;
    }
    source.stage2 = "in-flight";
    const flight: VisibilityFlight = {
      token: stage2,
      stage: 2,
      epoch: this.host.epoch(),
      generation: this.store.snapshot().generation,
    };
    this.flight = flight;
    void this.runStage2(flight, request, tasks);
  }

  private tasks(): VisibilityTask[] | undefined {
    const tasks = this.host
      .tasks()
      .filter((task) => task.included)
      .map((task) => ({
        id: task.id,
        label: task.label,
        revision: task.revision,
        sourceDigest: visibilityTaskSourceDigest(task),
      }));
    return tasks.length > 0 && tasks.length <= 20 ? tasks : undefined;
  }

  private frontier(
    branch?: readonly unknown[],
  ): VisibilityCanonicalFrontier | undefined {
    if (branch) return frontierFor(new CanonicalPass(branch));
    return this.canonicalFrontier ? { ...this.canonicalFrontier } : undefined;
  }

  /** Retain confirmed history while removing stale provisional current/Stage 1. */
  private supersedeMessage() {
    const prior = this.latestToken;
    this.store.supersede();
    this.latestToken = undefined;
    this.stage1 = undefined;
    if (this.flight?.stage === 1) this.dropFlight();
    if (prior && !this.sources.get(prior)?.confirmed)
      this.sources.delete(prior);
  }

  private terminalStage2(token: string) {
    const source = this.sources.get(token);
    if (source) source.stage2 = "terminal";
    this.stage2 = this.stage2.filter((id) => id !== token);
  }

  private dropSource(token: string) {
    const source = this.sources.get(token);
    if (source) source.stage2 = "terminal";
    if (this.flight?.token === token) this.dropFlight();
    this.sources.delete(token);
    if (this.latestToken === token) this.latestToken = undefined;
    if (this.stage1 === token) this.stage1 = undefined;
    this.stage2 = this.stage2.filter((id) => id !== token);
    this.store.markIncomplete();
  }

  private enqueueStage2(token: string) {
    const source = this.sources.get(token);
    if (source?.stage2 !== "unseen") return;
    if (this.stage2.length >= 4) {
      const dropped = this.stage2.shift();
      if (dropped) this.dropSource(dropped);
      this.store.markIncomplete();
    }
    source.stage2 = "queued";
    this.stage2.push(token);
  }

  private flightCurrent(flight: VisibilityFlight) {
    return (
      this.flight === flight &&
      flight.epoch === this.host.epoch() &&
      flight.generation === this.store.snapshot().generation &&
      this.host.enabled()
    );
  }

  private async runStage1(
    flight: VisibilityFlight,
    request: EvaluationRequest,
  ) {
    try {
      const result = await this.host.gateway.evaluate(request, this.identity());
      if (!this.flightCurrent(flight)) return;
      if (!result) {
        this.store.markIncomplete();
        return;
      }
      this.store.recordUsage(result.usage);
      const source = this.sources.get(flight.token);
      if (!source) {
        this.store.markIncomplete();
        return;
      }
      const selections = readLabelSelections(source.bundle, result);
      source.selections = selections;
      this.store.acceptSelections(flight.token, selections);
      if (source.confirmed) this.enqueueStage2(flight.token);
    } finally {
      if (this.flight === flight) this.flight = undefined;
      this.host.publish();
      // Publish may re-enter; drain re-reads readiness and the live flight.
      this.drain();
    }
  }

  private async runStage2(
    flight: VisibilityFlight,
    request: EvaluationRequest,
    tasks: readonly VisibilityTask[],
  ) {
    try {
      const result = await this.host.gateway.evaluate(request, this.identity());
      if (!this.flightCurrent(flight)) return;
      if (!result) {
        this.store.markIncomplete();
        return;
      }
      this.store.recordUsage(result.usage);
      const source = this.sources.get(flight.token);
      if (!source?.selections) {
        this.store.markIncomplete();
        return;
      }
      const currentTasks = this.tasks();
      this.store.acceptBindings(
        flight.token,
        readLabelBindings(source.selections, tasks, result),
        currentTasks ?? [],
      );
    } finally {
      this.terminalStage2(flight.token);
      if (this.flight === flight) this.flight = undefined;
      this.host.publish();
      // Publish may re-enter; drain re-reads readiness and the live flight.
      this.drain();
    }
  }
}
