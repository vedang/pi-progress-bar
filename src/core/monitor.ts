import { createHash } from "node:crypto";
import {
  type EvaluationRequest,
  JevGateway,
  type ValidatedResult,
} from "../analysis/gateway";
import { type HealthResult, healthSnapshot } from "../analysis/health";
import { AnalysisScheduler } from "../analysis/scheduler";
import {
  Conversation,
  type ConversationCheckpoint,
  type ConversationSource,
} from "../sources/conversation";
import { readSource } from "../sources/read-source";
import { reconcileLedger } from "./ledger";
import type { Ledger, Task } from "./types";

const key = (task: Task) =>
  createHash("sha256")
    .update(task.anchor ? `anchor:${task.anchor}` : `text:${task.text}`)
    .digest("hex");
export interface Checkpoint {
  version: 1;
  interval: number;
  source?:
    | { kind?: "file"; path: string; section?: string }
    | ConversationSource;
  conversation?: ConversationCheckpoint;
  revision?: string;
  mappings: { hash: string; id: string; included: boolean }[];
  currentTaskId?: string;
  nextTaskId: number;
}
function validInterval(seconds: number) {
  return (
    Number.isFinite(seconds) && seconds >= 0.001 && seconds * 1000 <= 2147483647
  );
}

/** Local controller. Callbacks keep host UI/persistence outside ledger operations. */
export class Monitor {
  ledger?: Ledger;
  source?: Checkpoint["source"];
  interval = 15;
  activity = "Idle";
  error?: string;
  epoch = 0;
  private timer?: ReturnType<typeof setInterval>;
  private reading = false;
  health?: HealthResult;
  consent = false;
  private consentIdentity?: string;
  private evidenceIdentity?: string;
  conversation = new Conversation();
  private branch?: () => readonly unknown[];
  observe(branch: () => readonly unknown[]) {
    this.branch = branch;
    this.conversation.update(branch());
  }
  readonly gateway = new JevGateway({
    fetch: (url, init) => globalThis.fetch(url, init),
    getApiKey: () => process.env.TYPESAFE_API_KEY,
  });
  readonly analysis = new AnalysisScheduler(this.gateway, () => this.changed());
  snapshot() {
    return healthSnapshot(
      this.ledger,
      this.epoch,
      this.source?.kind === "conversation"
        ? this.conversation.context(this.source)
        : undefined,
    );
  }
  enableAnalysis() {
    this.consent = true;
    this.consentIdentity = JSON.stringify([this.epoch, this.source]);
    this.gateway.enable(this.consentIdentity);
    this.scheduleAnalysis();
  }
  pauseAnalysis() {
    this.analysis.clear();
    this.gateway.pause();
    this.changed();
  }
  resumeAnalysis() {
    if (!this.consent)
      throw new Error("Use /progress enable to review and consent first");
    this.gateway.resume();
    this.scheduleAnalysis();
  }
  /** Shared submission seam. Consumers own lossless queues and result admission. */
  enqueueAnalysis(
    purpose: string,
    request: EvaluationRequest,
    admit: (result: ValidatedResult) => void,
  ) {
    if (!this.consent || !this.consentIdentity) return;
    this.analysis.enqueue(purpose, {
      request,
      consentIdentity: this.consentIdentity,
      admit,
    });
  }
  scheduleAnalysis() {
    const snapshot = this.snapshot();
    if (snapshot?.identity !== this.evidenceIdentity) {
      this.analysis.discard("health");
      this.health = undefined;
      this.evidenceIdentity = snapshot?.identity;
    }
    if (snapshot && this.consent && this.consentIdentity) {
      this.enqueueAnalysis("health", snapshot.request, (result) => {
        if (this.snapshot()?.identity === snapshot.identity && this.consent) {
          this.health = { snapshot, result, evaluatedAt: Date.now() };
        }
      });
    }
    const epoch = this.epoch;
    const enqueue = this.enqueueAnalysis.bind(this);
    if (this.consent)
      this.conversation.scheduleDiscovery(
        enqueue,
        () => epoch === this.epoch && this.consent,
      );
    if (this.ledger && this.source?.kind === "conversation")
      this.conversation.scheduleReports(
        this.ledger,
        this.source,
        epoch,
        enqueue,
        () => (epoch === this.epoch && this.consent ? this.ledger : undefined),
        (ledger) => {
          this.ledger = ledger;
          this.save();
        },
      );
    this.analysis.tick();
    this.changed();
  }
  private resetAnalysis() {
    this.consent = false;
    this.consentIdentity = undefined;
    this.evidenceIdentity = undefined;
    this.health = undefined;
    this.analysis.clear();
    this.gateway.pause();
  }
  constructor(
    private readonly changed: () => void,
    private readonly persist: (checkpoint: Checkpoint) => void,
    private readonly read = readSource,
  ) {}
  checkpoint(): Checkpoint {
    return {
      version: 1,
      interval: this.interval,
      source: this.source,
      conversation:
        this.source?.kind === "conversation" && this.ledger
          ? this.conversation.checkpoint(this.ledger)
          : undefined,
      revision: this.ledger?.sourceRevision,
      mappings:
        this.ledger?.tasks.map((task) => ({
          hash: key(task),
          id: task.id,
          included: task.included,
        })) ?? [],
      currentTaskId: this.ledger?.currentTaskId,
      nextTaskId: this.ledger?.nextTaskId ?? 1,
    };
  }
  save() {
    this.persist(this.checkpoint());
  }
  stop() {
    this.resetAnalysis();
    this.epoch++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  start(cwd: string) {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.refresh(cwd);
    }, this.interval * 1000);
  }
  setInterval(seconds: number, cwd: string) {
    if (!validInterval(seconds))
      throw new Error("Interval must be 0.001–2147483.647 seconds");
    this.interval = seconds;
    this.start(cwd);
    this.save();
    this.changed();
  }
  apply(ledger: Ledger, source: NonNullable<Checkpoint["source"]>) {
    if (source.kind === "conversation") this.conversation.rehydrate(source);
    this.resetAnalysis();
    this.epoch++;
    this.ledger = ledger;
    this.source = source;
    if (source.kind === "conversation") this.conversation.select(source);
    this.error = undefined;
    this.save();
    this.changed();
  }
  async refresh(cwd: string) {
    if (this.branch) this.conversation.update(this.branch());
    if (this.reading) return;
    if (!this.source || this.source.kind === "conversation") {
      this.scheduleAnalysis();
      return;
    }
    const epoch = this.epoch;
    this.reading = true;
    try {
      const snapshot = await this.read(
        cwd,
        this.source.path,
        this.source.section,
      );
      if (epoch !== this.epoch) return;
      const old = this.ledger;
      this.ledger = reconcileLedger(old, snapshot);
      this.error = undefined;
      if (old?.sourceRevision !== snapshot.revision) this.save();
    } catch {
      if (epoch !== this.epoch) return;
      this.error =
        "Source unavailable or changed; last complete count is stale";
      if (this.ledger) this.ledger = { ...this.ledger, stale: true };
    } finally {
      this.reading = false;
      if (epoch === this.epoch) this.scheduleAnalysis();
    }
  }
  async restore(cwd: string, data: unknown) {
    this.stop();
    this.conversation = new Conversation();
    if (this.branch) this.conversation.update(this.branch());
    const epoch = this.epoch;
    this.ledger = undefined;
    this.source = undefined;
    this.error = undefined;
    this.interval = 15;
    this.activity = "Idle";
    this.changed();
    try {
      if (!data || typeof data !== "object") return;
      const cp = data as Checkpoint;
      if (cp.version !== 1 || !validInterval(cp.interval))
        throw new Error("Invalid checkpoint");
      this.interval = cp.interval;
      if (!cp.source) return;
      if (
        (cp.source.kind !== "conversation" &&
          (typeof cp.source.path !== "string" ||
            (cp.source.section !== undefined &&
              typeof cp.source.section !== "string"))) ||
        !Array.isArray(cp.mappings) ||
        cp.mappings.length > 200 ||
        !Number.isSafeInteger(cp.nextTaskId) ||
        cp.nextTaskId < 1
      )
        throw new Error("Invalid checkpoint");
      const ids = new Set<string>();
      const hashes = new Set<string>();
      for (const map of cp.mappings) {
        if (
          !map ||
          typeof map.hash !== "string" ||
          !/^[a-f0-9]{64}$/.test(map.hash) ||
          typeof map.id !== "string" ||
          map.id.length > 200 ||
          typeof map.included !== "boolean" ||
          ids.has(map.id) ||
          hashes.has(map.hash)
        )
          throw new Error("Invalid mapping");
        ids.add(map.id);
        hashes.add(map.hash);
      }
      const snapshot =
        cp.source.kind === "conversation"
          ? this.conversation.rehydrate(cp.source)
          : await this.read(cwd, cp.source.path, cp.source.section);
      if (epoch !== this.epoch) return;
      const ledger = reconcileLedger(undefined, snapshot);
      const maps = new Map(cp.mappings.map((map) => [map.hash, map]));
      let next = cp.nextTaskId;
      ledger.tasks = ledger.tasks.map((task) => {
        const map = maps.get(key(task));
        let id = map?.id;
        if (!id) {
          do {
            id = `${task.id.split(":task:")[0]}:task:${next++}`;
          } while (ids.has(id));
        }
        ids.add(id);
        return { ...task, id, included: map?.included ?? false };
      });
      ledger.nextTaskId = next;
      ledger.explicitSelection = true;
      if (
        ledger.tasks.some(
          (task) => task.id === cp.currentTaskId && task.included,
        )
      )
        ledger.currentTaskId = cp.currentTaskId;
      if (cp.source.kind === "conversation")
        this.conversation.restore(ledger, cp.conversation);
      this.source = cp.source;
      this.ledger = ledger;
    } catch {
      if (epoch === this.epoch)
        this.error =
          "Saved source unavailable or checkpoint invalid; select source again";
    } finally {
      if (epoch === this.epoch) {
        this.start(cwd);
        this.changed();
      }
    }
  }
}
