import { createHash } from "node:crypto";
import {
  type EvaluationRequest,
  JevGateway,
  type ValidatedResult,
} from "../analysis/gateway";
import {
  type HealthResult,
  type HealthSnapshot,
  healthSnapshot,
} from "../analysis/health";
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
import { type EvidenceLink, EvidenceStore } from "../sources/evidence";
import {
  applyScopeRelations,
  type ScopeChunk,
  scopeAnswers,
  scopeChunks,
} from "../sources/scope";
import { reconcileLedger } from "./ledger";
import type { Ledger, ReportState, SourceRef, SourceTask, Task } from "./types";

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
  sourceRevision?: string;
  scopeRevision?: string;
  mappings: { hash: string; id: string }[];
  tasks: {
    id: string;
    status: Task["status"];
    included: boolean;
    anchor?: string;
    revision?: string;
    ref: Task["ref"];
    criterionRefs?: SourceRef[];
  }[];
  currentTaskId?: string;
  nextTaskId: number;
  usage: { calls: number; inputTokens: number; outputTokens: number };
}

const DEFAULT_INTERVAL_SECONDS = 15;
const validInterval = (seconds: number) =>
  Number.isSafeInteger(seconds) && seconds >= 5 && seconds <= 86_400;

interface ScopeWork {
  proposalId: string;
  starting: Ledger;
  candidates: SourceTask[];
  chunks: ScopeChunk[];
  index: number;
  relations: Record<number, ReturnType<typeof scopeAnswers>[number]>;
  states: Record<number, ReportState | undefined>;
  scopes: Set<"continue" | "new-goal" | "ambiguous">;
  currents: Set<string>;
}
interface HealthWork {
  snapshot: HealthSnapshot;
  index: number;
  result?: ValidatedResult;
}

/** Automatic, passive current-branch controller. */
export class Monitor {
  ledger?: Ledger;
  source?: ConversationSource;
  interval = DEFAULT_INTERVAL_SECONDS;
  enabled = false;
  activity = "Idle";
  error?: string;
  epoch = 0;
  health?: HealthResult;
  usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  conversation = new Conversation();
  readonly evidence = new EvidenceStore();
  readonly gateway: JevGateway;
  readonly analysis: AnalysisScheduler;
  private timer?: ReturnType<typeof setInterval>;
  private branch?: () => readonly unknown[];
  private runtimeIdentity?: string;
  private evidenceIdentity?: string;
  private scheduling = false;
  private scopedCandidates = new Set<string>();
  private scopeWork?: ScopeWork;
  private healthWork?: HealthWork;
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

  evidenceLink(): EvidenceLink | undefined {
    const task = this.ledger?.tasks.find(
      (item) =>
        item.id === this.ledger?.currentTaskId &&
        item.included &&
        item.status !== "cancelled",
    );
    if (!this.ledger || !task) return;
    return {
      sourceId: this.ledger.sourceId,
      taskId: task.id,
      taskRevision: task.revision ?? this.ledger.sourceRevision,
      scopeRevision: this.ledger.scopeRevision,
    };
  }

  snapshot() {
    const recent = this.conversation.trajectory.messages
      .slice(-8)
      .map((item) => `${item.role}: ${item.text.slice(0, 2000)}`);
    const link = this.evidenceLink();
    return healthSnapshot(
      this.ledger,
      this.epoch,
      this.source
        ? [...this.conversation.context(this.source), ...recent]
        : recent,
      link ? this.evidence.snapshot(link) : [],
      this.evidence.codeRevision(),
    );
  }

  observeToolStart(
    callId: string,
    toolName: string,
    args: unknown,
    entryId?: string,
  ) {
    if (!this.enabled) return;
    this.evidence.start(
      callId,
      toolName,
      args,
      Date.now(),
      entryId,
      this.evidenceLink(),
    );
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

  enqueueAnalysis(
    purpose: string,
    request: EvaluationRequest,
    admit: (result: ValidatedResult) => void,
  ) {
    if (!this.enabled || !this.runtimeIdentity) return;
    this.analysis.enqueue(purpose, {
      request,
      consentIdentity: this.runtimeIdentity,
      admit: (result) => {
        this.usage.calls++;
        this.usage.inputTokens += result.usage.input_tokens;
        this.usage.outputTokens += result.usage.output_tokens;
        admit(result);
      },
    });
  }

  private adoptProposal() {
    if (this.ledger || !this.conversation.proposals.length) return;
    const proposal = this.conversation.proposals.find(
      (item) => !item.ambiguous,
    );
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
    this.scopedCandidates.add(
      `${proposal.candidate.id}:${proposal.candidate.hash}`,
    );
    this.evidenceIdentity = undefined;
    this.save();
  }

  private scheduleScope() {
    if (this.scopeWork && this.ledger !== this.scopeWork.starting)
      this.scopeWork = undefined;
    if (!this.scopeWork && this.ledger) {
      const proposal = this.conversation.proposals.find(
        (item) =>
          !item.ambiguous &&
          !this.scopedCandidates.has(
            `${item.candidate.id}:${item.candidate.hash}`,
          ),
      );
      if (proposal) {
        try {
          this.scopeWork = {
            proposalId: `${proposal.candidate.id}:${proposal.candidate.hash}`,
            starting: this.ledger,
            candidates: proposal.snapshot.tasks,
            chunks: scopeChunks(this.ledger, proposal.snapshot.tasks),
            index: 0,
            relations: {},
            states: {},
            scopes: new Set(),
            currents: new Set(),
          };
        } catch {
          // Essential scope context cannot be clipped into a transaction.
          this.scopedCandidates.add(
            `${proposal.candidate.id}:${proposal.candidate.hash}`,
          );
          return;
        }
      }
    }
    const work = this.scopeWork;
    const chunk = work?.chunks[work.index];
    if (!work || !chunk) return;
    const index = work.index;
    this.enqueueAnalysis("scope", chunk.request, (result) => {
      if (
        !this.enabled ||
        this.scopeWork !== work ||
        this.ledger !== work.starting ||
        work.index !== index
      )
        return;
      const partial = scopeAnswers(
        work.candidates.filter((_candidate, candidateIndex) =>
          chunk.indexes.includes(candidateIndex),
        ),
        result,
        chunk.indexes,
      );
      for (const candidateIndex of chunk.indexes) {
        work.relations[candidateIndex] = partial[candidateIndex];
        work.states[candidateIndex] = partial.states?.[candidateIndex];
      }
      work.scopes.add(partial.scope);
      if (partial.current !== "unknown") work.currents.add(partial.current);
      work.index++;
      if (work.index < work.chunks.length) {
        this.scheduleScope();
        return;
      }
      const scope =
        work.scopes.size === 1
          ? ([...work.scopes][0] ?? "ambiguous")
          : "ambiguous";
      const current =
        work.currents.size === 1
          ? ([...work.currents][0] ?? "unknown")
          : "unknown";
      this.ledger = applyScopeRelations(work.starting, work.candidates, {
        ...work.relations,
        current,
        scope,
        states: work.states,
      });
      if (this.beadsExport)
        this.ledger.tasks = enrichBeadsTasks(
          this.ledger.tasks,
          this.beadsExport,
        );
      this.scopedCandidates.add(work.proposalId);
      this.scopeWork = undefined;
      this.save();
    });
  }

  private scheduleHealth(snapshot: HealthSnapshot | undefined) {
    if (!snapshot) return;
    if (this.health?.snapshot.identity === snapshot.identity) return;
    if (
      !this.healthWork ||
      this.healthWork.snapshot.taskIdentity !== snapshot.taskIdentity
    )
      this.healthWork = { snapshot, index: 0 };
    const work = this.healthWork;
    const request = work.snapshot.requests[work.index];
    if (!request) return;
    const index = work.index;
    this.enqueueAnalysis("health", request, (result) => {
      if (
        !this.enabled ||
        this.healthWork !== work ||
        work.index !== index ||
        this.snapshot()?.taskIdentity !== work.snapshot.taskIdentity
      )
        return;
      const previous = work.result;
      work.result = {
        model: result.model,
        answers: { ...(previous?.answers ?? {}), ...result.answers },
        usage: {
          input_tokens:
            (previous?.usage.input_tokens ?? 0) + result.usage.input_tokens,
          output_tokens:
            (previous?.usage.output_tokens ?? 0) + result.usage.output_tokens,
        },
      };
      work.index++;
      if (work.index < work.snapshot.requests.length) {
        this.scheduleHealth(work.snapshot);
        return;
      }
      this.health = {
        snapshot: work.snapshot,
        result: work.result,
        evaluatedAt: Date.now(),
      };
      this.healthWork = undefined;
    });
  }

  scheduleAnalysis(startCycle = true) {
    if (!this.enabled || this.scheduling) return;
    this.scheduling = true;
    try {
      if (this.branch) this.conversation.update(this.branch());
      this.adoptProposal();
      this.scheduleScope();
      const snapshot = this.snapshot();
      if (snapshot?.identity !== this.evidenceIdentity) {
        const incompatible =
          !this.healthWork ||
          !snapshot ||
          this.healthWork.snapshot.taskIdentity !== snapshot.taskIdentity;
        if (incompatible) {
          this.analysis.discard("health");
          this.health = undefined;
          this.healthWork = undefined;
        }
        this.evidenceIdentity = snapshot?.identity;
      }
      this.scheduleHealth(snapshot);
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
    this.evidence.clearPending();
    this.runtimeIdentity = undefined;
    this.evidenceIdentity = undefined;
    this.health = undefined;
    this.healthWork = undefined;
    this.scopeWork = undefined;
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
      sourceRevision: this.ledger?.sourceRevision,
      scopeRevision: this.ledger?.scopeRevision,
      conversation:
        this.source && this.ledger
          ? this.conversation.checkpoint(this.ledger)
          : undefined,
      mappings:
        this.ledger?.tasks.map((task) => ({
          hash: taskKey(task),
          id: task.id,
        })) ?? [],
      tasks:
        this.ledger?.tasks.map((task) => ({
          id: task.id,
          status: task.status,
          included: task.included,
          ...(task.anchor ? { anchor: task.anchor } : {}),
          ...(task.revision ? { revision: task.revision } : {}),
          ...(task.criterionRefs
            ? {
                criterionRefs: task.criterionRefs.map((ref) => ({ ...ref })),
              }
            : {}),
          ref: { ...task.ref },
        })) ?? [],
      currentTaskId: this.ledger?.currentTaskId,
      nextTaskId: this.ledger?.nextTaskId ?? 1,
      usage: { ...this.usage },
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
    this.evidence.reset();
    this.beadsExport = undefined;
    this.ledger = undefined;
    this.source = undefined;
    this.error = undefined;
    this.activity = "Idle";
    let savedEnabled = true;
    this.interval = DEFAULT_INTERVAL_SECONDS;
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
            !Array.isArray(cp.tasks) ||
            cp.tasks.length > 200 ||
            !Number.isSafeInteger(cp.nextTaskId) ||
            (cp.nextTaskId ?? 0) < 1 ||
            !cp.usage ||
            ![
              cp.usage.calls,
              cp.usage.inputTokens,
              cp.usage.outputTokens,
            ].every((value) => Number.isSafeInteger(value) && value >= 0)
          )
            throw new Error("Invalid automatic checkpoint");
          savedEnabled = cp.enabled;
          this.interval = cp.interval as number;
          this.usage = { ...cp.usage };
          if (cp.source) {
            const snapshot = this.conversation.rehydrate(cp.source);
            const ledger = reconcileLedger(undefined, snapshot);
            if (
              cp.sourceRevision !== snapshot.revision ||
              typeof cp.scopeRevision !== "string" ||
              !/^[A-Za-z0-9_-]{1,128}:\d+$/.test(cp.scopeRevision)
            )
              throw new Error("Invalid saved source or scope revision");
            ledger.sourceRevision = cp.sourceRevision;
            ledger.scopeRevision = cp.scopeRevision;
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
            const baseById = new Map(
              ledger.tasks.map((task) => [task.id, task]),
            );
            const restoredIds = new Set<string>();
            const restoreRef = (ref: SourceRef) => {
              if (
                !ref.entryId ||
                ref.sourceId !== `conversation:${ref.entryId}` ||
                !Number.isSafeInteger(ref.start) ||
                !Number.isSafeInteger(ref.end) ||
                ref.start < 0 ||
                ref.end <= ref.start ||
                !["user", "assistant"].includes(ref.provenance)
              )
                throw new Error("Invalid saved task reference");
              return ref;
            };
            const restoredTasks = cp.tasks.flatMap((saved) => {
              if (
                typeof saved.id !== "string" ||
                !saved.id ||
                saved.id.length > 256 ||
                restoredIds.has(saved.id) ||
                typeof saved.included !== "boolean" ||
                ![
                  "done",
                  "reopened",
                  "not-started",
                  "in-progress",
                  "cancelled",
                  "unknown",
                  "conflict",
                ].includes(saved.status)
              )
                throw new Error("Invalid saved task");
              restoredIds.add(saved.id);
              const ref = restoreRef(saved.ref);
              const revision =
                typeof saved.revision === "string" && saved.revision
                  ? saved.revision
                  : undefined;
              const message = this.conversation.observationById(
                ref.entryId ?? "",
              );
              if (
                !message ||
                !revision ||
                revision !== message.hash ||
                ref.end > message.text.length
              )
                throw new Error("Saved task original or revision unavailable");
              const criterionRefs = saved.criterionRefs?.map((criterion) => {
                const checked = restoreRef(criterion);
                const criterionMessage = this.conversation.observationById(
                  checked.entryId ?? "",
                );
                if (
                  !criterionMessage ||
                  criterionMessage.hash !== revision ||
                  checked.end > criterionMessage.text.length
                )
                  throw new Error("Saved criterion original unavailable");
                return { ...checked };
              });
              const base = baseById.get(saved.id);
              return [
                {
                  ...(base ?? {
                    criteria: [],
                    ref: { ...ref },
                    text: message.text.slice(ref.start, ref.end),
                  }),
                  id: saved.id,
                  text: message.text.slice(ref.start, ref.end),
                  status: saved.status,
                  included: saved.included,
                  ...(saved.anchor ? { anchor: saved.anchor } : {}),
                  ...(revision ? { revision } : {}),
                  ...(criterionRefs
                    ? {
                        criterionRefs,
                        criteria: criterionRefs.map((criterion) =>
                          message.text.slice(criterion.start, criterion.end),
                        ),
                      }
                    : {}),
                  ref: { ...ref },
                },
              ];
            });
            if (restoredTasks.length) ledger.tasks = restoredTasks;
            ledger.nextTaskId = next;
            if (
              ledger.tasks.some(
                (task) =>
                  task.id === cp.currentTaskId &&
                  task.included &&
                  task.status !== "cancelled",
              )
            )
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
