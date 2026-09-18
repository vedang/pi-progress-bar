import { createHash } from "node:crypto";
import {
  type EvaluationRequest,
  JevGateway,
  type ValidatedResult,
} from "../analysis/gateway";
import { type HealthResult, healthSnapshot } from "../analysis/health";
import { AnalysisScheduler } from "../analysis/scheduler";
import {
  type BeadsExport,
  enrichBeadsTasks,
  readBeadsExport,
} from "../sources/beads";
import {
  Conversation,
  type ConversationCheckpoint,
  type ConversationSource,
} from "../sources/conversation";
import {
  applyScopeRelations,
  scopeAnswers,
  scopeRequest,
} from "../sources/scope";
import { reconcileLedger } from "./ledger";
import type { Ledger, Task } from "./types";

const taskKey = (task: Task) =>
  createHash("sha256")
    .update(task.anchor ? `anchor:${task.anchor}` : `text:${task.text}`)
    .digest("hex");

export interface Checkpoint {
  version: 2;
  enabled: boolean;
  interval: number;
  source?: ConversationSource;
  conversation?: ConversationCheckpoint;
  mappings: { hash: string; id: string }[];
  currentTaskId?: string;
  nextTaskId: number;
}

const validInterval = (seconds: number) =>
  Number.isSafeInteger(seconds) && seconds >= 5 && seconds <= 86_400;

/** Automatic, passive current-branch controller. */
export class Monitor {
  ledger?: Ledger;
  source?: ConversationSource;
  interval = 60;
  enabled = false;
  activity = "Idle";
  error?: string;
  epoch = 0;
  health?: HealthResult;
  conversation = new Conversation();
  readonly gateway: JevGateway;
  readonly analysis: AnalysisScheduler;
  private timer?: ReturnType<typeof setInterval>;
  private branch?: () => readonly unknown[];
  private runtimeIdentity?: string;
  private evidenceIdentity?: string;
  private scheduling = false;
  private scopedCandidates = new Set<string>();
  private beadsExport?: BeadsExport;

  constructor(
    private readonly changed: () => void,
    private readonly persist: (checkpoint: Checkpoint) => void,
  ) {
    this.gateway = new JevGateway({
      fetch: (url, init) => globalThis.fetch(url, init),
      getApiKey: () => process.env.TYPESAFE_API_KEY,
      onPermanentError: (message) => this.forceOff(message),
    });
    this.analysis = new AnalysisScheduler(this.gateway, () => {
      this.changed();
      if (this.enabled) queueMicrotask(() => this.scheduleAnalysis(false));
    });
  }

  observe(branch: () => readonly unknown[]) {
    this.branch = branch;
    if (this.enabled) this.conversation.update(branch());
  }

  snapshot() {
    return healthSnapshot(
      this.ledger,
      this.epoch,
      this.source ? this.conversation.context(this.source) : undefined,
    );
  }

  enqueueAnalysis(
    purpose: string,
    request: EvaluationRequest,
    admit: (result: ValidatedResult) => void,
  ) {
    if (!this.enabled || !this.runtimeIdentity) return;
    this.analysis.enqueue(purpose, {
      request,
      consentIdentity: this.runtimeIdentity,
      admit,
    });
  }

  private adoptProposal() {
    if (this.ledger || !this.conversation.proposals.length) return;
    const proposal = [...this.conversation.proposals]
      .reverse()
      .find((item) => !item.ambiguous);
    if (!proposal) return;
    const source = this.conversation.source(proposal);
    const ledger = reconcileLedger(
      undefined,
      this.conversation.rehydrate(source),
    );
    if (this.beadsExport)
      ledger.tasks = enrichBeadsTasks(ledger.tasks, this.beadsExport);
    this.source = source;
    this.ledger = ledger;
    this.conversation.select(source);
    this.scopedCandidates.add(proposal.candidate.id);
    this.evidenceIdentity = undefined;
    this.save();
  }

  scheduleAnalysis(startCycle = true) {
    if (!this.enabled || this.scheduling) return;
    this.scheduling = true;
    try {
      if (this.branch) this.conversation.update(this.branch());
      this.adoptProposal();
      const scopeProposal = this.ledger
        ? this.conversation.proposals.find(
            (item) => !this.scopedCandidates.has(item.candidate.id),
          )
        : undefined;
      if (scopeProposal && this.ledger) {
        const startingLedger = this.ledger;
        const candidates = scopeProposal.snapshot.tasks;
        const request = scopeRequest(startingLedger, candidates);
        this.enqueueAnalysis("scope", request, (result) => {
          if (!this.enabled || this.ledger !== startingLedger) return;
          this.ledger = applyScopeRelations(
            startingLedger,
            candidates,
            scopeAnswers(candidates, result),
          );
          if (this.beadsExport)
            this.ledger.tasks = enrichBeadsTasks(
              this.ledger.tasks,
              this.beadsExport,
            );
          this.scopedCandidates.add(scopeProposal.candidate.id);
          this.save();
        });
      }
      const snapshot = this.snapshot();
      if (snapshot?.identity !== this.evidenceIdentity) {
        this.analysis.discard("health");
        this.health = undefined;
        this.evidenceIdentity = snapshot?.identity;
      }
      if (snapshot)
        this.enqueueAnalysis("health", snapshot.request, (result) => {
          if (this.enabled && this.snapshot()?.identity === snapshot.identity)
            this.health = { snapshot, result, evaluatedAt: Date.now() };
        });
      const epoch = this.epoch;
      this.conversation.scheduleDiscovery(
        this.enqueueAnalysis.bind(this),
        () => this.enabled && epoch === this.epoch,
      );
      if (this.ledger && this.source)
        this.conversation.scheduleReports(
          this.ledger,
          this.source,
          epoch,
          this.enqueueAnalysis.bind(this),
          () =>
            this.enabled && epoch === this.epoch ? this.ledger : undefined,
          (ledger) => {
            this.ledger = ledger;
            this.save();
          },
        );
      if (startCycle) this.analysis.startCycle(3);
      else this.analysis.tick();
      this.changed();
    } finally {
      this.scheduling = false;
    }
  }

  private clearRuntime() {
    this.analysis.clear();
    this.gateway.pause();
    this.runtimeIdentity = undefined;
    this.evidenceIdentity = undefined;
    this.health = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private forceOff(message: string) {
    this.error = message;
    if (this.enabled) {
      this.enabled = false;
      this.epoch++;
      this.clearRuntime();
      this.save();
    }
    this.changed();
  }

  turnOff() {
    if (!this.enabled) return;
    this.enabled = false;
    this.error = undefined;
    this.epoch++;
    this.clearRuntime();
    this.save();
    this.changed();
  }

  turnOn(cwd: string): string | undefined {
    if (this.enabled) return;
    const apiKey = process.env.TYPESAFE_API_KEY?.trim();
    if (!apiKey) {
      this.enabled = false;
      this.error = "TYPESAFE_API_KEY is required; progress monitor is OFF";
      this.changed();
      return this.error;
    }
    this.enabled = true;
    this.error = undefined;
    this.epoch++;
    this.runtimeIdentity = `runtime:${this.epoch}`;
    this.gateway.enable(this.runtimeIdentity);
    if (this.branch) this.conversation.update(this.branch());
    void this.refreshBeads(cwd);
    this.start(cwd);
    this.save();
    this.scheduleAnalysis();
    return;
  }

  stop() {
    this.enabled = false;
    this.epoch++;
    this.clearRuntime();
  }

  private async refreshBeads(cwd: string) {
    const epoch = this.epoch;
    const source = await readBeadsExport(cwd);
    if (!this.enabled || epoch !== this.epoch) return;
    this.beadsExport = source;
    if (this.ledger) {
      this.ledger = {
        ...this.ledger,
        tasks: enrichBeadsTasks(this.ledger.tasks, source),
      };
      this.save();
      this.changed();
    }
  }

  private start(cwd: string) {
    if (!this.enabled) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.branch) this.conversation.update(this.branch());
      void this.refreshBeads(cwd);
      this.scheduleAnalysis();
    }, this.interval * 1000);
    void cwd;
  }

  setInterval(seconds: number, cwd: string) {
    if (!validInterval(seconds))
      throw new Error("Interval must be an integer from 5 to 86400 seconds");
    this.interval = seconds;
    if (this.enabled) this.start(cwd);
    this.save();
    this.changed();
  }

  checkpoint(): Checkpoint {
    return {
      version: 2,
      enabled: this.enabled,
      interval: this.interval,
      source: this.source,
      conversation:
        this.source && this.ledger
          ? this.conversation.checkpoint(this.ledger)
          : undefined,
      mappings:
        this.ledger?.tasks.map((task) => ({
          hash: taskKey(task),
          id: task.id,
        })) ?? [],
      currentTaskId: this.ledger?.currentTaskId,
      nextTaskId: this.ledger?.nextTaskId ?? 1,
    };
  }

  save() {
    this.persist(this.checkpoint());
  }

  async restore(cwd: string, data: unknown, preserveControls = false) {
    const wasEnabled = this.enabled;
    const previousInterval = this.interval;
    this.clearRuntime();
    this.epoch++;
    this.conversation = new Conversation();
    this.scopedCandidates.clear();
    this.ledger = undefined;
    this.source = undefined;
    this.error = undefined;
    this.activity = "Idle";
    let savedEnabled = true;
    this.interval = 60;
    if (this.branch) this.conversation.update(this.branch());
    try {
      if (data && typeof data === "object") {
        const cp = data as Partial<Checkpoint>;
        // Old manual checkpoints are intentionally ignored, not migrated.
        if (cp.version === 2) {
          if (
            typeof cp.enabled !== "boolean" ||
            !validInterval(cp.interval ?? Number.NaN) ||
            !Array.isArray(cp.mappings) ||
            cp.mappings.length > 200 ||
            !Number.isSafeInteger(cp.nextTaskId) ||
            (cp.nextTaskId ?? 0) < 1
          )
            throw new Error("Invalid automatic checkpoint");
          savedEnabled = cp.enabled;
          this.interval = cp.interval as number;
          if (cp.source) {
            const snapshot = this.conversation.rehydrate(cp.source);
            const ledger = reconcileLedger(undefined, snapshot);
            const maps = new Map(cp.mappings.map((item) => [item.hash, item]));
            const ids = new Set<string>();
            let next = cp.nextTaskId as number;
            ledger.tasks = ledger.tasks.map((task) => {
              const mapped = maps.get(taskKey(task));
              let id = mapped?.id;
              if (typeof id !== "string" || !id || ids.has(id)) {
                do id = `${ledger.sourceId}:task:${next++}`;
                while (ids.has(id));
              }
              ids.add(id);
              return { ...task, id, included: true };
            });
            ledger.nextTaskId = next;
            if (ledger.tasks.some((task) => task.id === cp.currentTaskId))
              ledger.currentTaskId = cp.currentTaskId;
            this.conversation.restore(ledger, cp.conversation);
            this.source = cp.source;
            this.ledger = ledger;
          }
        }
      }
    } catch {
      this.ledger = undefined;
      this.source = undefined;
      this.conversation = new Conversation();
      if (this.branch) this.conversation.update(this.branch());
      this.error =
        "Saved automatic state was invalid; rebuilding from active history";
    }
    if (preserveControls) {
      savedEnabled = wasEnabled;
      this.interval = previousInterval;
    }
    this.enabled = false;
    if (savedEnabled) this.turnOn(cwd);
    else this.changed();
  }
}
