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
import { implementationFromResult } from "../analysis/implementation";
import { AnalysisScheduler } from "../analysis/scheduler";
import {
  type BeadsExport,
  enrichBeadsTasks,
  hasGroundedBeadsRecords,
  readBeadsExport,
} from "../sources/beads";
import type { Proposal } from "../sources/candidates";
import {
  Conversation,
  type ConversationCheckpoint,
  type ConversationSource,
} from "../sources/conversation";
import {
  type EvidenceLink,
  EvidenceStore,
  redEvidenceLabel,
} from "../sources/evidence";
import {
  applyScopeRelations,
  type ScopeChunk,
  scopeAnswers,
  scopeChunks,
  scopeTransactionIsAdmissible,
} from "../sources/scope";
import type { Candidate } from "../sources/trajectory";
import { reconcileLedger } from "./ledger";
import type { Ledger, ReportState, SourceRef, SourceTask, Task } from "./types";

const taskKey = (task: Task) =>
  createHash("sha256")
    .update(
      task.anchor
        ? `anchor:${task.anchor}:${task.workKind ?? "action"}`
        : `text:${task.text}:${task.workKind ?? "action"}`,
    )
    .digest("hex");

interface PartialScopeCheckpoint {
  proposalId: string;
  candidate: { id: string; entryId: string; hash: string };
  source: ConversationSource;
  supersedesUnresolved: boolean;
  /** SHA-256 digest of semantic ledger basis; never serialize scope text. */
  identity: string;
  index: number;
  requestHashes: string[];
  relations: { index: number; relation: string }[];
  states: { index: number; status: ReportState }[];
  scopes: string[];
  currents: { index: number; choice: string }[];
  /** Detects accidental/unrecomputed local checkpoint corruption; not authentication. */
  digest: string;
}
interface UnresolvedScopeCheckpoint {
  candidates: { id: string; entryId: string; hash: string }[];
  /** More refs existed than durable cap; retain unknown UI state conservatively. */
  overflow?: boolean;
}
const MAX_UNRESOLVED_SCOPE_REFS = 200;
export interface PresentationAssessment {
  requirements: string;
  acceptance: string;
  newRedTest: string;
  redEvidence: string;
  implementation: string;
}
export interface PresentationTaskCard {
  /** Display-only copy; never changes ledger current/evidence authority. */
  task: Pick<Task, "id" | "text" | "criteria" | "revision" | "ref" | "beads">;
  /** True only for Jev-selected semantic current work. */
  current: boolean;
  /** Known-task fallback when semantic current remains unknown. */
  selected: boolean;
  /** Values are a same-task/revision prior assessment. */
  retained: boolean;
  /** A different current task exists but has no complete replacement assessment. */
  replacementPending: boolean;
  /** Immutable display labels captured with this task/revision assessment. */
  assessment?: PresentationAssessment;
  assessedAt?: number;
}
interface RetainedTaskCard {
  task: PresentationTaskCard["task"];
  assessment: PresentationAssessment;
  assessedAt: number;
}
export interface Checkpoint {
  /** v4 removes polling controls; older checkpoint shapes rebuild safely. */
  version: 4;
  enabled: boolean;
  source?: ConversationSource;
  conversation?: ConversationCheckpoint;
  sourceRevision?: string;
  scopeRevision?: string;
  partialScope?: PartialScopeCheckpoint;
  unresolvedScope?: UnresolvedScopeCheckpoint;
  mappings: { hash: string; id: string }[];
  tasks: {
    id: string;
    status: Task["status"];
    workKind: Task["workKind"];
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

interface ScopeWork {
  proposalId: string;
  entryId: string;
  entryHash: string;
  candidate: Pick<Candidate, "id" | "hash">;
  source: ConversationSource;
  supersedesUnresolved: boolean;
  /** Scope request basis; result applies only if its semantic identity survives. */
  starting: Ledger;
  identity: string;
  epoch: number;
  candidates: SourceTask[];
  chunks: ScopeChunk[];
  index: number;
  relations: Record<number, ReturnType<typeof scopeAnswers>[number]>;
  states: Record<number, ReportState | undefined>;
  scopes: Set<"continue" | "new-goal" | "ambiguous">;
  currents: Map<number, string>;
}
interface HealthWork {
  snapshot: HealthSnapshot;
  index: number;
  result?: ValidatedResult;
}
interface FreshScopeWork {
  proposal: Proposal;
  source: ConversationSource;
  base: Ledger;
  chunk: ScopeChunk;
  epoch: number;
}

/** Excludes display-only Beads enrichment; includes every scope authority field. */
const sameBeadsEnrichment = (left: Task[], right: Task[]) =>
  left.length === right.length &&
  left.every(
    (task, index) =>
      task.id === right[index]?.id &&
      task.included === right[index]?.included &&
      JSON.stringify(task.beads) === JSON.stringify(right[index]?.beads),
  );

const scopeIdentity = (ledger: Ledger) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        sourceId: ledger.sourceId,
        sourceRevision: ledger.sourceRevision,
        scopeRevision: ledger.scopeRevision,
        currentTaskId: ledger.currentTaskId,
        nextTaskId: ledger.nextTaskId,
        stale: ledger.stale,
        tasks: ledger.tasks.map((task) => ({
          id: task.id,
          text: task.text,
          workKind: task.workKind ?? "action",
          status: task.status,
          criteria: task.criteria,
          included: task.included,
          anchor: task.anchor,
          revision: task.revision,
          ref: task.ref,
          criterionRefs: task.criterionRefs,
        })),
      }),
    )
    .digest("hex");
const requestHash = (request: EvaluationRequest) =>
  createHash("sha256").update(JSON.stringify(request)).digest("hex");
const scopeJournalDigest = (partial: Omit<PartialScopeCheckpoint, "digest">) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        proposalId: partial.proposalId,
        candidate: {
          id: partial.candidate.id,
          entryId: partial.candidate.entryId,
          hash: partial.candidate.hash,
        },
        source: partial.source,
        supersedesUnresolved: partial.supersedesUnresolved,
        identity: partial.identity,
        index: partial.index,
        requestHashes: [...partial.requestHashes],
        relations: [...partial.relations].sort(
          (left, right) => left.index - right.index,
        ),
        states: [...partial.states].sort(
          (left, right) => left.index - right.index,
        ),
        scopes: [...partial.scopes].sort(),
        currents: [...partial.currents].sort(
          (left, right) => left.index - right.index,
        ),
      }),
    )
    .digest("hex");
const statusValues = new Set<ReportState>([
  "done",
  "reopened",
  "not-started",
  "in-progress",
  "cancelled",
  "unknown",
  "conflict",
]);

/** Automatic, passive current-branch controller. */
export class Monitor {
  ledger?: Ledger;
  source?: ConversationSource;
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
  private branch?: () => readonly unknown[];
  private runtimeIdentity?: string;
  private cwd?: string;
  private beadsRefresh?: Promise<void>;
  private evidenceIdentity?: string;
  private scheduling = false;
  private analysisRequested = false;
  private scopedCandidates = new Set<string>();
  private blockedScopeCandidates = new Set<string>();
  /** Original-only refs let unresolved UI truth survive reload without text. */
  private blockedScopeSources = new Map<
    string,
    { id: string; entryId: string; hash: string }
  >();
  private scopeWork?: ScopeWork;
  private freshScopeWork?: FreshScopeWork;
  /** Once an earlier fresh proposal needs chronology, later burst entries do too. */
  private freshCutoverBlocked = false;
  private healthWork?: HealthWork;
  private beadsExport?: BeadsExport;
  private diagnosticCounts = new Map<string, number>();
  private scopeUnresolved = false;
  private scopeUnresolvedOverflow = false;
  /** Reloaded unchanged evidence stays unknown; never rebill history for health. */
  private healthDeferred = false;
  /** Memory-only display continuity. It is deliberately absent from checkpoints. */
  private retainedTaskCard?: RetainedTaskCard;

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
    });
  }

  /** Bounded aggregate diagnostics only; raw branch text never reaches UI/checkpoints. */
  private note(code: string) {
    if (!/^[a-z][a-z-]{0,63}$/.test(code)) return;
    this.diagnosticCounts.set(
      code,
      Math.min(999, (this.diagnosticCounts.get(code) ?? 0) + 1),
    );
    while (this.diagnosticCounts.size > 12) {
      const first = this.diagnosticCounts.keys().next().value;
      if (!first) return;
      this.diagnosticCounts.delete(first);
    }
  }

  diagnostics() {
    const counts = new Map(
      this.conversation.diagnostics().map(({ code, count }) => [code, count]),
    );
    for (const [code, count] of this.diagnosticCounts)
      counts.set(code, Math.min(999, (counts.get(code) ?? 0) + count));
    return [...counts.entries()].map(([code, count]) => ({ code, count }));
  }

  progressState() {
    if (!this.enabled) return "Monitoring off";
    if (
      this.error ||
      /(?:error|retry|cooldown|unavailable)/i.test(this.gateway.status)
    )
      return "Analysis unavailable";
    if (this.conversation.isCatchingUp()) return "Catching up history";
    if (
      this.scopeUnresolved ||
      this.scopeUnresolvedOverflow ||
      this.blockedScopeCandidates.size
    )
      return "Scope unresolved";
    if (this.scopeWork || this.conversation.hasPendingDiscovery())
      return "Updating scope";
    if (this.conversation.hasPendingReports()) return "Updating reports";
    if (!this.ledger) return "No actionable tasks yet";
    if (this.ledger.stale) return "History stale";
    if (!this.ledger.currentTaskId) return "Current task unknown";
    return "No new evidence";
  }

  scopeIsUnresolved() {
    return (
      this.scopeUnresolved ||
      this.scopeUnresolvedOverflow ||
      this.blockedScopeCandidates.size > 0
    );
  }

  diagnosticSummary() {
    const diagnostics = this.diagnostics();
    return diagnostics.length
      ? diagnostics.map(({ code, count }) => `${code}:${count}`).join(" • ")
      : "none";
  }

  /** Observe only canonical active-branch entries from supported host hooks. */
  observe(branch: () => readonly unknown[]) {
    this.branch = branch;
    if (!this.enabled) return;
    this.conversation.update(branch(), true);
    if (
      this.retainedTaskCard &&
      !this.retainedCardIsLive(this.retainedTaskCard)
    )
      this.retainedTaskCard = undefined;
    if (this.cwd) void this.refreshBeads(this.cwd);
    this.requestAnalysis();
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

  private copyPresentationTask(task: Task): PresentationTaskCard["task"] {
    return {
      id: task.id,
      text: task.text,
      criteria: [...task.criteria],
      ...(task.revision ? { revision: task.revision } : {}),
      ref: { ...task.ref },
      ...(task.beads ? { beads: { ...task.beads } } : {}),
    };
  }

  private retainedCardIsLive(card: RetainedTaskCard) {
    const { task } = card;
    if (!task.revision || !task.ref.entryId) return false;
    const source = this.conversation.observation({
      id: task.ref.entryId,
      hash: task.revision,
    });
    if (!source) return !this.conversation.hasVisibleObservations();
    return (
      source.text.slice(task.ref.start, task.ref.end) === task.text &&
      task.ref.sourceId === `conversation:${task.ref.entryId}`
    );
  }

  private cardHealthFor(task: Task) {
    const health = this.health;
    const revision = task.revision ?? this.ledger?.sourceRevision;
    return health &&
      health.snapshot.taskId === task.id &&
      health.snapshot.taskRevision === revision
      ? health
      : undefined;
  }

  private presentationAssessment(
    task: Task,
    health: HealthResult,
    link: EvidenceLink,
  ): PresentationAssessment {
    const clarity = health.result.answers.clarity;
    const requirements =
      clarity?.type === "score" &&
      Number.isFinite(clarity.score) &&
      clarity.score >= 0 &&
      clarity.score <= 3
        ? clarity.score < 1
          ? "unclear"
          : clarity.score < 2
            ? "partly clear"
            : clarity.score < 3
              ? "mostly clear"
              : "clear"
        : "unknown";
    const acceptance = health.result.answers.acceptance;
    const applicability = health.result.answers.redApplicability;
    const newRedTest =
      applicability?.type === "choice" && applicability.choice === "not-needed"
        ? "Not needed"
        : applicability?.type === "choice" && applicability.choice === "needed"
          ? "Needed"
          : "Unknown";
    const redReport = health.result.answers.redReport;
    return {
      requirements,
      acceptance: acceptance?.type === "choice" ? acceptance.choice : "unknown",
      newRedTest,
      redEvidence: redEvidenceLabel({
        applicability:
          applicability?.type === "choice" &&
          ["needed", "not-needed", "unknown"].includes(applicability.choice)
            ? (applicability.choice as "needed" | "not-needed" | "unknown")
            : undefined,
        reported:
          redReport?.type === "choice" && redReport.choice === "reported-red",
        contradiction:
          redReport?.type === "choice" && redReport.choice === "contradicted",
        observed: this.evidence.redObservation(link),
      }),
      implementation: implementationFromResult(
        task.criteria,
        health.result,
        this.evidence.snapshot(link),
        this.evidence.codeRevision(),
        health.snapshot.implementationEvidenceComplete,
      ),
    };
  }

  private copyRetainedTask(task: RetainedTaskCard["task"]) {
    return {
      ...task,
      criteria: [...task.criteria],
      ref: { ...task.ref },
      ...(task.beads ? { beads: { ...task.beads } } : {}),
    };
  }

  private retainTaskCard(task: Task, health: HealthResult, link: EvidenceLink) {
    this.retainedTaskCard = {
      task: this.copyPresentationTask(task),
      assessment: this.presentationAssessment(task, health, link),
      assessedAt: health.evaluatedAt,
    };
  }

  /**
   * Presentation only. A retained/selected card never establishes semantic
   * current work or evidence ownership; callers must use evidenceLink() for
   * analysis authority.
   */
  taskCard(): PresentationTaskCard | undefined {
    const ledger = this.ledger;
    if (!ledger) return;
    const current = ledger.tasks.find(
      (task) =>
        task.id === ledger.currentTaskId &&
        task.included &&
        task.status !== "cancelled",
    );
    const existing = this.retainedTaskCard;
    const retained =
      existing && this.retainedCardIsLive(existing) ? existing : undefined;
    if (existing && !retained) this.retainedTaskCard = undefined;
    if (current) {
      const health = this.cardHealthFor(current);
      const link = health && this.evidenceLink();
      const currentRevision = current.revision ?? ledger.sourceRevision;
      if (
        health &&
        link &&
        (!retained ||
          retained.task.id !== current.id ||
          retained.task.revision !== currentRevision ||
          retained.assessedAt !== health.evaluatedAt)
      )
        this.retainTaskCard(current, health, link);
      const latest = this.retainedTaskCard;
      if (latest && this.retainedCardIsLive(latest)) {
        const sameTask =
          latest.task.id === current.id &&
          latest.task.revision === currentRevision;
        if (sameTask)
          return {
            task: this.copyPresentationTask(current),
            current: true,
            selected: false,
            retained: !health,
            replacementPending: false,
            assessment: { ...latest.assessment },
            assessedAt: latest.assessedAt,
          };
        return {
          task: this.copyRetainedTask(latest.task),
          current: false,
          selected: false,
          retained: true,
          replacementPending: true,
          assessment: { ...latest.assessment },
          assessedAt: latest.assessedAt,
        };
      }
      return {
        task: this.copyPresentationTask(current),
        current: true,
        selected: false,
        retained: false,
        replacementPending: false,
      };
    }
    if (retained)
      return {
        task: this.copyRetainedTask(retained.task),
        current: false,
        selected: false,
        retained: true,
        replacementPending: false,
        assessment: { ...retained.assessment },
        assessedAt: retained.assessedAt,
      };
    const selected =
      ledger.tasks.find(
        (task) => task.included && task.status !== "cancelled",
      ) ?? ledger.tasks.find((task) => task.included);
    return selected
      ? {
          task: this.copyPresentationTask(selected),
          current: false,
          selected: true,
          retained: false,
          replacementPending: false,
        }
      : undefined;
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
    this.healthDeferred = false;
    const value =
      result && typeof result === "object"
        ? { ...(result as object), isError }
        : { isError };
    this.evidence.finish(callId, toolName, value, Date.now());
    this.requestAnalysis();
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
      admit: (result, cached) => {
        if (!cached) {
          this.usage.calls++;
          this.usage.inputTokens += result.usage.input_tokens;
          this.usage.outputTokens += result.usage.output_tokens;
        }
        try {
          admit(result);
        } finally {
          this.conversation.releaseObservationCache();
          this.requestAnalysis();
        }
      },
    });
  }

  private adoptProposal() {
    if (this.ledger || !this.conversation.proposals.length) return;
    let supersedesUnresolved = false;
    let proposal: (typeof this.conversation.proposals)[number] | undefined;
    for (const candidate of this.conversation.proposals) {
      const id = this.proposalId(candidate);
      if (this.scopedCandidates.has(id)) continue;
      if (candidate.ambiguous) {
        this.blockScope(id, "ambiguous-discovery", candidate.candidate);
        supersedesUnresolved = true;
        continue;
      }
      proposal = candidate;
      break;
    }
    if (!proposal) return;
    if (!this.conversation.canInitializeFrom(proposal.candidate)) return;
    if (supersedesUnresolved) {
      // Earlier ambiguity remains rejected evidence. A later clear source is
      // a fresh denominator, not an inferred resolution of that ambiguity.
      for (const candidate of this.conversation.proposals) {
        const id = this.proposalId(candidate);
        if (candidate === proposal) break;
        if (this.blockedScopeCandidates.delete(id)) {
          this.blockedScopeSources.delete(id);
          this.scopedCandidates.add(id);
          this.conversation.note("superseded-unresolved-source");
        }
      }
    }
    const source = this.conversation.source(proposal);
    const ledger = reconcileLedger(
      undefined,
      this.conversation.rehydrate(source),
    );
    if (this.beadsExport)
      ledger.tasks = enrichBeadsTasks(ledger.tasks, this.beadsExport);
    this.source = source;
    this.ledger = ledger;
    this.scopeUnresolved = false;
    this.conversation.commitScope(proposal.candidate);
    this.conversation.select(source, true, true);
    this.scopedCandidates.add(
      `${proposal.candidate.id}:${proposal.candidate.hash}`,
    );
    this.evidenceIdentity = undefined;
    this.save();
    if (this.cwd) void this.refreshBeads(this.cwd);
  }

  /** Fresh early admission is a single exact all-new/new-goal transaction. */
  private scheduleFreshScope() {
    if (this.freshScopeWork) return;
    const proposal = this.conversation.freshProposals[0];
    if (!proposal) return;
    const defer = (code: string) => {
      this.note(code);
      this.conversation.deferFreshProposal(proposal);
      this.freshCutoverBlocked = true;
      // No-ledger proposals still return to existing chronological adoption.
      // They cannot cut over, but validated source/task semantics may initialize
      // scope once their normal ordered path reaches them.
    };
    if (proposal.ambiguous || this.freshMustRemainOrdered(proposal)) {
      defer(proposal.ambiguous ? "ambiguous-discovery" : "fresh-ordered");
      return;
    }
    this.freshCutoverBlocked = false;
    try {
      const source = this.conversation.source(proposal);
      const base = this.ledger
        ? this.ledger
        : reconcileLedger(undefined, { ...proposal.snapshot, tasks: [] });
      const chunks = scopeChunks(base, proposal.snapshot.tasks);
      if (chunks.length !== 1) {
        defer("fresh-scope-multichunk");
        return;
      }
      const chunk = chunks[0];
      if (!chunk) throw new Error("Missing fresh scope chunk");
      const work: FreshScopeWork = {
        proposal,
        source,
        base,
        chunk,
        epoch: this.epoch,
      };
      this.freshScopeWork = work;
      this.enqueueAnalysis("fresh-scope", chunk.request, (result) => {
        if (
          !this.enabled ||
          this.epoch !== work.epoch ||
          this.freshScopeWork !== work
        )
          return;
        this.freshScopeWork = undefined;
        const answers = scopeAnswers(
          work.proposal.snapshot.tasks,
          result,
          work.chunk.indexes,
        );
        const allNew = work.proposal.snapshot.tasks.every(
          (_candidate, index) => answers[index] === "new",
        );
        if (
          answers.scope !== "new-goal" ||
          !allNew ||
          !scopeTransactionIsAdmissible(
            work.base,
            work.proposal.snapshot.tasks,
            answers,
          )
        ) {
          defer("fresh-scope-veto");
          return;
        }
        const applied = applyScopeRelations(
          work.base,
          work.proposal.snapshot.tasks,
          answers,
        );
        // `applyScopeRelations` preserves its base owner for chronological
        // revisions. A replacement owns a new canonical source and cannot
        // retain old source/report identity across checkpoint restore.
        const sourceLedger = reconcileLedger(undefined, work.proposal.snapshot);
        const next: Ledger = {
          ...applied,
          sourceId: sourceLedger.sourceId,
          kind: sourceLedger.kind,
          sourceRevision: sourceLedger.sourceRevision,
          scopeRevision: sourceLedger.scopeRevision,
          reports: [],
          reportOrder: 0,
        };
        this.commitFreshCutover(work.proposal, work.source, next);
      });
    } catch {
      defer("fresh-scope-overflow");
    }
  }

  /** Earlier unsafe fresh work must settle before a later turn can cut over. */
  private freshMustRemainOrdered(proposal: Proposal) {
    if (!this.freshCutoverBlocked) return false;
    const target = this.conversation.observation({
      id: proposal.candidate.entryId,
      hash: proposal.candidate.hash,
    });
    if (!target || this.scopeUnresolved) return true;
    const work = this.scopeWork;
    if (
      work &&
      this.conversation.entryIsAtOrBefore(work.entryId, work.entryHash, target)
    )
      return true;
    const ordered = this.nextRunnableScopeProposal()?.proposal;
    return (
      !!ordered &&
      this.conversation.entryIsAtOrBefore(
        ordered.candidate.entryId,
        ordered.candidate.hash,
        target,
      )
    );
  }

  /** Replacement boundary invalidates older disposable authority, not display snapshots. */
  private commitFreshCutover(
    proposal: Proposal,
    source: ConversationSource,
    ledger: Ledger,
  ) {
    this.analysis.discard("discovery");
    this.analysis.discard("scope");
    this.analysis.discard("reports");
    this.analysis.discard("health");
    this.scopeWork = undefined;
    this.healthWork = undefined;
    this.health = undefined;
    this.healthDeferred = false;
    this.ledger = this.beadsExport
      ? { ...ledger, tasks: enrichBeadsTasks(ledger.tasks, this.beadsExport) }
      : ledger;
    this.source = source;
    const boundary = this.conversation.observation({
      id: proposal.candidate.entryId,
      hash: proposal.candidate.hash,
    });
    this.conversation.commitFreshBoundary(proposal.candidate);
    this.conversation.select(source, true, true);
    const laterProposalIds = new Set(
      this.conversation.proposals.map((item) => this.proposalId(item)),
    );
    this.scopedCandidates = new Set(
      [...this.scopedCandidates].filter((id) => laterProposalIds.has(id)),
    );
    this.scopedCandidates.add(this.proposalId(proposal));
    const laterBlocked = new Map(
      [...this.blockedScopeSources].filter(
        ([, blocked]) =>
          !!boundary &&
          !this.conversation.entryIsAtOrBefore(
            blocked.entryId,
            blocked.hash,
            boundary,
          ),
      ),
    );
    this.blockedScopeSources = laterBlocked;
    this.blockedScopeCandidates = new Set(laterBlocked.keys());
    this.scopeUnresolved = this.blockedScopeCandidates.size > 0;
    this.scopeUnresolvedOverflow = false;
    this.evidenceIdentity = undefined;
    this.save();
    if (this.cwd) void this.refreshBeads(this.cwd);
  }

  private scopeWorkIsCurrent(work: ScopeWork) {
    return (
      this.epoch === work.epoch &&
      !!this.ledger &&
      scopeIdentity(this.ledger) === work.identity
    );
  }

  private proposalId(item: { candidate: { id: string; hash: string } }) {
    return `${item.candidate.id}:${item.candidate.hash}`;
  }

  /** Earliest uncommitted proposal owns the next scope transaction. */
  private nextScopeProposal() {
    return this.conversation.proposals.find(
      (item) => !this.scopedCandidates.has(this.proposalId(item)),
    );
  }

  /** A later clear scope may supersede rejected ambiguity, never past reports. */
  private nextRunnableScopeProposal() {
    let supersedesUnresolved = false;
    for (const proposal of this.conversation.proposals) {
      const id = this.proposalId(proposal);
      if (this.scopedCandidates.has(id)) continue;
      if (this.blockedScopeCandidates.has(id)) {
        supersedesUnresolved = true;
        continue;
      }
      const observation = this.conversation.observation({
        id: proposal.candidate.entryId,
        hash: proposal.candidate.hash,
      });
      const supersedesRestoredScope =
        !!observation &&
        [...this.blockedScopeSources.values()].some((blocked) =>
          this.conversation.entryIsAtOrBefore(
            blocked.entryId,
            blocked.hash,
            observation,
          ),
        );
      return {
        proposal,
        supersedesUnresolved: supersedesUnresolved || supersedesRestoredScope,
      };
    }
  }

  /** A later scope transaction never changes the denominator for an earlier report. */
  private scopeBlocksReport(
    report: Parameters<Conversation["blocksReportsThrough"]>[0],
  ) {
    const work = this.scopeWork;
    if (
      work &&
      this.conversation.entryIsAtOrBefore(work.entryId, work.entryHash, report)
    )
      return true;
    const freshWork = this.freshScopeWork;
    if (
      freshWork &&
      this.conversation.entryIsAtOrBefore(
        freshWork.proposal.candidate.entryId,
        freshWork.proposal.candidate.hash,
        report,
      )
    )
      return true;
    if (
      this.conversation.freshProposals.some((proposal) =>
        this.conversation.entryIsAtOrBefore(
          proposal.candidate.entryId,
          proposal.candidate.hash,
          report,
        ),
      )
    )
      return true;
    if (
      this.scopeUnresolvedOverflow ||
      [...this.blockedScopeSources.values()].some((blocked) =>
        this.conversation.entryIsAtOrBefore(
          blocked.entryId,
          blocked.hash,
          report,
        ),
      )
    )
      return true;
    const proposal = this.nextScopeProposal();
    return (
      !!proposal &&
      this.conversation.entryIsAtOrBefore(
        proposal.candidate.entryId,
        proposal.candidate.hash,
        report,
      )
    );
  }

  private blockScope(
    id: string,
    code: string,
    source?: { id: string; entryId: string; hash: string },
  ) {
    const firstBlocked = !this.blockedScopeCandidates.has(id);
    if (firstBlocked) this.note(code);
    this.blockedScopeCandidates.add(id);
    if (source) {
      if (
        !this.blockedScopeSources.has(id) &&
        this.blockedScopeSources.size >= MAX_UNRESOLVED_SCOPE_REFS
      ) {
        this.scopeUnresolvedOverflow = true;
        this.note("unresolved-scope-cap");
      } else this.blockedScopeSources.set(id, { ...source });
    }
    this.scopeUnresolved = true;
    const clearedCurrent = !!this.ledger?.currentTaskId;
    if (clearedCurrent && this.ledger)
      this.ledger = { ...this.ledger, currentTaskId: undefined };
    // First blocked transition is durable even when current task was unknown.
    if (firstBlocked || clearedCurrent) this.save();
  }

  private scheduleScope() {
    if (this.scopeWork && !this.scopeWorkIsCurrent(this.scopeWork)) {
      this.note("stale-scope-result");
      this.scopeWork = undefined;
    }
    if (!this.scopeWork && this.ledger) {
      const runnable = this.nextRunnableScopeProposal();
      if (!runnable) return;
      const { proposal, supersedesUnresolved } = runnable;
      const id = this.proposalId(proposal);
      // Initial adoption is already a scope commit. Later observations wait
      // until every preceding report cursor transaction has settled. A clear
      // later proposal can supersede a previously rejected ambiguous source.
      if (
        this.source &&
        !this.conversation.scopeMayAdmit(
          proposal.candidate.entryId,
          proposal.candidate.hash,
        ) &&
        !supersedesUnresolved
      )
        return;
      if (proposal.ambiguous) {
        this.blockScope(id, "ambiguous-discovery", proposal.candidate);
        return;
      }
      try {
        this.scopeWork = {
          proposalId: id,
          entryId: proposal.candidate.entryId,
          entryHash: proposal.candidate.hash,
          candidate: {
            id: proposal.candidate.id,
            hash: proposal.candidate.hash,
          },
          source: this.conversation.source(proposal),
          supersedesUnresolved,
          starting: this.ledger,
          identity: scopeIdentity(this.ledger),
          epoch: this.epoch,
          candidates: proposal.snapshot.tasks,
          chunks: scopeChunks(this.ledger, proposal.snapshot.tasks),
          index: 0,
          relations: {},
          states: {},
          scopes: new Set(),
          currents: new Map(),
        };
      } catch {
        // Essential scope context cannot be clipped into a transaction. Keep
        // its cursor blocked rather than interpreting it against old scope.
        this.blockScope(id, "scope-overflow", proposal.candidate);
        return;
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
        !this.scopeWorkIsCurrent(work) ||
        work.index !== index
      ) {
        this.note("stale-scope-result");
        return;
      }
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
      if (partial.current !== "unknown")
        work.currents.set(index, partial.current);
      work.index++;
      if (work.index < work.chunks.length) {
        // Persist only derived choices plus request digests; ledger remains
        // untouched until every chunk makes one admissible transaction.
        this.save();
        this.scheduleScope();
        return;
      }
      const scope =
        work.scopes.size === 1
          ? ([...work.scopes][0] ?? "ambiguous")
          : "ambiguous";
      const currentChoices = new Set(work.currents.values());
      const current =
        currentChoices.size === 1
          ? ([...currentChoices][0] ?? "unknown")
          : "unknown";
      const live = this.ledger;
      if (!live || !this.scopeWorkIsCurrent(work)) {
        this.note("stale-scope-result");
        return;
      }
      this.scopeWork = undefined;
      const answers = {
        ...work.relations,
        current,
        scope,
        states: work.states,
      };
      if (!scopeTransactionIsAdmissible(live, work.candidates, answers)) {
        this.blockScope(
          work.proposalId,
          scope === "ambiguous"
            ? "ambiguous-scope"
            : "ambiguous-scope-relation",
          {
            id: work.candidate.id,
            entryId: work.entryId,
            hash: work.entryHash,
          },
        );
        return;
      }
      const next = applyScopeRelations(live, work.candidates, answers);
      const invalidated = next.tasks.flatMap((task) => {
        const prior = live.tasks.find((item) => item.id === task.id);
        return prior &&
          (prior.revision !== task.revision || prior.included !== task.included)
          ? [task.id]
          : [];
      });
      this.ledger = this.beadsExport
        ? { ...next, tasks: enrichBeadsTasks(next.tasks, this.beadsExport) }
        : next;
      this.conversation.retainProofs(this.ledger, invalidated);
      if (work.supersedesUnresolved) {
        this.conversation.skipUnresolvedReportsBefore(
          work.entryId,
          work.entryHash,
        );
        const target = this.conversation.observation({
          id: work.entryId,
          hash: work.entryHash,
        });
        if (target)
          for (const [id, blocked] of this.blockedScopeSources) {
            if (
              this.conversation.entryIsAtOrBefore(
                blocked.entryId,
                blocked.hash,
                target,
              )
            ) {
              this.blockedScopeCandidates.delete(id);
              this.blockedScopeSources.delete(id);
              this.scopedCandidates.add(id);
              this.conversation.commitScope(blocked);
            }
          }
      }
      if (!this.blockedScopeCandidates.size)
        this.scopeUnresolvedOverflow = false;
      this.scopeUnresolved =
        this.blockedScopeCandidates.size > 0 || this.scopeUnresolvedOverflow;
      this.scopedCandidates.add(work.proposalId);
      this.conversation.commitScope(work.candidate);
      this.save();
      if (this.cwd) void this.refreshBeads(this.cwd);
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
      // Capture at admission, not at the first (potentially much later) render.
      const link = this.evidenceLink();
      const task = this.ledger?.tasks.find((item) => item.id === link?.taskId);
      if (task && link) this.retainTaskCard(task, this.health, link);
      this.healthWork = undefined;
    });
  }

  /** Coalesce host observations; never await transport from an event handler. */
  requestAnalysis() {
    if (!this.enabled || this.analysisRequested) return;
    this.analysisRequested = true;
    queueMicrotask(() => {
      this.analysisRequested = false;
      this.scheduleAnalysis();
    });
  }

  /** Select bounded semantic work. Scheduler yields each actual dispatch. */
  scheduleAnalysis() {
    if (!this.enabled || this.scheduling) return;
    this.scheduling = true;
    try {
      if (this.branch) this.conversation.update(this.branch());
      const epoch = this.epoch;
      // Discovery stays chronological. Scope/report work only observes a
      // proposal after its selection/classification transaction has committed.
      const advancedDiscoveryPage = this.conversation.scheduleDiscovery(
        this.enqueueAnalysis.bind(this),
        () => this.enabled && epoch === this.epoch,
      );
      this.adoptProposal();
      this.scheduleFreshScope();
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
      if (this.healthDeferred && this.conversation.hasPendingDiscovery())
        this.healthDeferred = false;
      if (!this.healthDeferred) this.scheduleHealth(snapshot);
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
          (report) =>
            this.conversation.blocksReportsThrough(report) ||
            this.scopeBlocksReport(report),
          () => this.save(),
        );
      this.analysis.requestDrain();
      // Page advancement is bounded durable controller progress, not polling.
      // It has no request completion to otherwise wake the next window.
      if (advancedDiscoveryPage) this.requestAnalysis();
      this.changed();
    } finally {
      this.scheduling = false;
      this.conversation.releaseObservationCache();
    }
  }

  private clearRuntime() {
    this.analysis.clear();
    // OFF/restore aborts Jev transport. Preserve phase for a later ON retry.
    this.conversation.releaseDiscoveryFlights();
    this.analysisRequested = false;
    this.gateway.pause();
    this.evidence.clearPending();
    this.runtimeIdentity = undefined;
    this.evidenceIdentity = undefined;
    this.health = undefined;
    this.healthWork = undefined;
    // Accepted scope chunks are a durable transaction. Keep them across OFF
    // and permanent service pause; ON rebinds epoch and resumes next chunk.
    this.freshScopeWork = undefined;
    this.cwd = undefined;
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
    // Restored partial scope is source-validated; bind it to new lifecycle.
    if (this.scopeWork) this.scopeWork.epoch = this.epoch;
    this.runtimeIdentity = `runtime:${this.epoch}`;
    this.cwd = cwd;
    this.gateway.enable(this.runtimeIdentity);
    if (this.branch) this.conversation.update(this.branch());
    void this.refreshBeads(cwd);
    this.save();
    this.requestAnalysis();
    return;
  }

  stop() {
    this.enabled = false;
    this.epoch++;
    this.clearRuntime();
    this.scopeWork = undefined;
  }

  /** Optional display enrichment; coalesce lifecycle/observation reads only. */
  private refreshBeads(cwd: string) {
    if (this.beadsRefresh) return this.beadsRefresh;
    const epoch = this.epoch;
    const refresh = (async () => {
      const source = await readBeadsExport(cwd);
      if (!this.enabled || epoch !== this.epoch || !source.complete) return;
      if (this.ledger && !hasGroundedBeadsRecords(this.ledger.tasks, source)) {
        this.note("incomplete-beads-export");
        return;
      }
      this.beadsExport = source;
      if (!this.ledger) return;
      const tasks = enrichBeadsTasks(this.ledger.tasks, source);
      if (sameBeadsEnrichment(this.ledger.tasks, tasks)) return;
      this.ledger = { ...this.ledger, tasks };
      this.save();
      this.changed();
    })();
    this.beadsRefresh = refresh;
    void refresh.then(
      () => {
        if (this.beadsRefresh === refresh) this.beadsRefresh = undefined;
      },
      () => {
        if (this.beadsRefresh === refresh) this.beadsRefresh = undefined;
      },
    );
    return refresh;
  }

  private partialScopeCheckpoint(): PartialScopeCheckpoint | undefined {
    const work = this.scopeWork;
    if (!work || work.index < 1) return;
    const journal = {
      proposalId: work.proposalId,
      candidate: {
        id: work.candidate.id,
        entryId: work.entryId,
        hash: work.entryHash,
      },
      source: this.conversation.canonicalSource(work.source, {
        id: work.candidate.id,
        entryId: work.entryId,
        hash: work.entryHash,
      }),
      supersedesUnresolved: work.supersedesUnresolved,
      identity: work.identity,
      index: work.index,
      requestHashes: work.chunks
        .slice(0, work.index)
        .map((chunk) => requestHash(chunk.request)),
      relations: Object.entries(work.relations)
        .map(([index, relation]) => ({
          index: Number(index),
          relation: String(relation),
        }))
        .sort((left, right) => left.index - right.index),
      states: Object.entries(work.states)
        .flatMap(([index, status]) =>
          status ? [{ index: Number(index), status }] : [],
        )
        .sort((left, right) => left.index - right.index),
      scopes: [...work.scopes].sort(),
      currents: [...work.currents.entries()]
        .map(([index, choice]) => ({ index, choice }))
        .sort((left, right) => left.index - right.index),
    };
    return { ...journal, digest: scopeJournalDigest(journal) };
  }

  /** Rebuild source spans and requests before replaying text-free scope choices. */
  private restorePartialScope(
    ledger: Ledger,
    partial: PartialScopeCheckpoint | undefined,
  ) {
    if (!partial) return;
    if (
      typeof partial.proposalId !== "string" ||
      partial.proposalId.length > 512 ||
      !partial.candidate ||
      typeof partial.candidate.id !== "string" ||
      !partial.candidate.id ||
      partial.candidate.id.length > 256 ||
      typeof partial.candidate.entryId !== "string" ||
      !partial.candidate.entryId ||
      partial.candidate.entryId.length > 200 ||
      typeof partial.candidate.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(partial.candidate.hash) ||
      partial.proposalId !==
        `${partial.candidate.id}:${partial.candidate.hash}` ||
      !this.conversation.hasCandidate(partial.candidate) ||
      typeof partial.supersedesUnresolved !== "boolean" ||
      typeof partial.identity !== "string" ||
      !/^[a-f0-9]{64}$/.test(partial.identity) ||
      partial.identity !== scopeIdentity(ledger) ||
      !Number.isSafeInteger(partial.index) ||
      partial.index < 1 ||
      partial.index > 200 ||
      !Array.isArray(partial.requestHashes) ||
      partial.requestHashes.length !== partial.index ||
      !Array.isArray(partial.relations) ||
      partial.relations.length > 200 ||
      !Array.isArray(partial.states) ||
      partial.states.length > 200 ||
      !Array.isArray(partial.scopes) ||
      !partial.scopes.length ||
      partial.scopes.length > partial.index ||
      !Array.isArray(partial.currents) ||
      partial.currents.length > partial.index ||
      typeof partial.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(partial.digest)
    )
      throw new Error("Invalid partial scope checkpoint");
    const source = this.conversation.canonicalSource(
      partial.source,
      partial.candidate,
    );
    const snapshot = this.conversation.rehydrate(source);
    if (
      source.entryId !== partial.candidate.entryId ||
      source.hash !== partial.candidate.hash ||
      snapshot.revision !== partial.candidate.hash ||
      snapshot.tasks.length > 200
    )
      throw new Error("Partial scope source changed");
    const chunks = scopeChunks(ledger, snapshot.tasks);
    if (
      partial.index >= chunks.length ||
      partial.requestHashes.some(
        (hash, index) =>
          !/^[a-f0-9]{64}$/.test(hash) ||
          hash !== requestHash(chunks[index]?.request as EvaluationRequest),
      )
    )
      throw new Error("Partial scope request changed");
    const relations: ScopeWork["relations"] = {};
    for (const decision of partial.relations) {
      const chunk = chunks
        .slice(0, partial.index)
        .find((item) => item.indexes.includes(decision.index));
      const question = chunk?.request.questions[String(decision.index)];
      if (
        !decision ||
        !Number.isSafeInteger(decision.index) ||
        decision.index < 0 ||
        typeof decision.relation !== "string" ||
        !decision.relation ||
        Object.hasOwn(relations, decision.index) ||
        !question ||
        !Object.hasOwn(question.criteria, decision.relation)
      )
        throw new Error("Invalid partial scope relation");
      relations[decision.index] =
        decision.relation as ScopeWork["relations"][number];
    }
    const acceptedRelationIndexes = chunks
      .slice(0, partial.index)
      .flatMap((chunk) => chunk.indexes);
    if (
      Object.keys(relations).length !== acceptedRelationIndexes.length ||
      acceptedRelationIndexes.some((index) => !Object.hasOwn(relations, index))
    )
      throw new Error("Incomplete partial scope relations");
    const states: ScopeWork["states"] = {};
    for (const decision of partial.states) {
      const chunk = chunks
        .slice(0, partial.index)
        .find((item) => item.indexes.includes(decision.index));
      const question = chunk?.request.questions[`status:${decision.index}`];
      const choice =
        decision.status === "conflict" ? "ambiguous" : decision.status;
      if (
        !decision ||
        !Number.isSafeInteger(decision.index) ||
        decision.index < 0 ||
        Object.hasOwn(states, decision.index) ||
        !statusValues.has(decision.status) ||
        !question ||
        !Object.hasOwn(question.criteria, choice)
      )
        throw new Error("Invalid partial scope status");
      states[decision.index] = decision.status;
    }
    const scopes = new Set<"continue" | "new-goal" | "ambiguous">();
    for (const scope of partial.scopes) {
      if (scope !== "continue" && scope !== "new-goal" && scope !== "ambiguous")
        throw new Error("Invalid partial scope boundary");
      scopes.add(scope);
    }
    const currents = new Map<number, string>();
    for (const decision of partial.currents) {
      const question = chunks[decision.index]?.request.questions.current;
      if (
        !decision ||
        !Number.isSafeInteger(decision.index) ||
        decision.index < 0 ||
        decision.index >= partial.index ||
        typeof decision.choice !== "string" ||
        !decision.choice ||
        currents.has(decision.index) ||
        !question ||
        !Object.hasOwn(question.criteria, decision.choice)
      )
        throw new Error("Invalid partial scope current choice");
      currents.set(decision.index, decision.choice);
    }
    const journal = {
      proposalId: partial.proposalId,
      candidate: {
        id: partial.candidate.id,
        entryId: partial.candidate.entryId,
        hash: partial.candidate.hash,
      },
      source,
      supersedesUnresolved: partial.supersedesUnresolved,
      identity: partial.identity,
      index: partial.index,
      requestHashes: [...partial.requestHashes],
      relations: Object.entries(relations)
        .map(([index, relation]) => ({
          index: Number(index),
          relation: String(relation),
        }))
        .sort((left, right) => left.index - right.index),
      states: Object.entries(states)
        .flatMap(([index, status]) =>
          status ? [{ index: Number(index), status }] : [],
        )
        .sort((left, right) => left.index - right.index),
      scopes: [...scopes].sort(),
      currents: [...currents.entries()]
        .map(([index, choice]) => ({ index, choice }))
        .sort((left, right) => left.index - right.index),
    };
    if (partial.digest !== scopeJournalDigest(journal))
      throw new Error("Partial scope journal digest changed");
    this.scopeWork = {
      proposalId: partial.proposalId,
      entryId: partial.candidate.entryId,
      entryHash: partial.candidate.hash,
      candidate: { id: partial.candidate.id, hash: partial.candidate.hash },
      source,
      supersedesUnresolved: partial.supersedesUnresolved,
      starting: ledger,
      identity: partial.identity,
      epoch: this.epoch,
      candidates: snapshot.tasks,
      chunks,
      index: partial.index,
      relations,
      states,
      scopes,
      currents,
    };
    this.conversation.resumeScopeCandidate(partial.candidate);
  }

  private restoreUnresolvedScope(
    unresolved: UnresolvedScopeCheckpoint | undefined,
  ) {
    if (!unresolved) return;
    if (
      !Array.isArray(unresolved.candidates) ||
      (!unresolved.candidates.length && unresolved.overflow !== true) ||
      unresolved.candidates.length > MAX_UNRESOLVED_SCOPE_REFS ||
      (unresolved.overflow !== undefined &&
        typeof unresolved.overflow !== "boolean")
    )
      throw new Error("Invalid unresolved scope checkpoint");
    const restored = new Map<
      string,
      { id: string; entryId: string; hash: string }
    >();
    for (const candidate of unresolved.candidates) {
      if (
        !candidate ||
        typeof candidate.id !== "string" ||
        !candidate.id ||
        candidate.id.length > 256 ||
        typeof candidate.entryId !== "string" ||
        !candidate.entryId ||
        candidate.entryId.length > 200 ||
        typeof candidate.hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(candidate.hash) ||
        !this.conversation.hasCandidate(candidate) ||
        !this.conversation.observation({
          id: candidate.entryId,
          hash: candidate.hash,
        })
      )
        throw new Error("Unresolved scope original unavailable");
      const key = `${candidate.id}:${candidate.hash}`;
      if (restored.has(key)) throw new Error("Duplicate unresolved scope");
      restored.set(key, {
        id: candidate.id,
        entryId: candidate.entryId,
        hash: candidate.hash,
      });
    }
    this.blockedScopeCandidates = new Set(restored.keys());
    this.blockedScopeSources = restored;
    this.scopeUnresolvedOverflow = unresolved.overflow === true;
    this.scopeUnresolved = restored.size > 0 || this.scopeUnresolvedOverflow;
  }

  checkpoint(): Checkpoint {
    const partialScope = this.partialScopeCheckpoint();
    return {
      version: 4,
      enabled: this.enabled,
      source: this.source
        ? this.conversation.canonicalSource(this.source)
        : undefined,
      sourceRevision: this.ledger?.sourceRevision,
      scopeRevision: this.ledger?.scopeRevision,
      ...(partialScope ? { partialScope } : {}),
      ...(this.blockedScopeSources.size || this.scopeUnresolvedOverflow
        ? {
            unresolvedScope: {
              candidates: [...this.blockedScopeSources.values()].map(
                (item) => ({
                  id: item.id,
                  entryId: item.entryId,
                  hash: item.hash,
                }),
              ),
              ...(this.scopeUnresolvedOverflow ? { overflow: true } : {}),
            },
          }
        : {}),
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
          workKind: task.workKind ?? "action",
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
    this.clearRuntime();
    this.epoch++;
    this.conversation = new Conversation();
    this.scopeWork = undefined;
    this.scopedCandidates.clear();
    this.blockedScopeCandidates.clear();
    this.blockedScopeSources.clear();
    this.scopeUnresolved = false;
    this.scopeUnresolvedOverflow = false;
    this.freshScopeWork = undefined;
    this.freshCutoverBlocked = false;
    this.healthDeferred = false;
    this.retainedTaskCard = undefined;
    this.diagnosticCounts.clear();
    this.evidence.reset();
    this.beadsExport = undefined;
    this.ledger = undefined;
    this.source = undefined;
    this.error = undefined;
    this.activity = "Idle";
    let savedEnabled = true;
    if (this.branch) this.conversation.update(this.branch());
    try {
      if (data && typeof data === "object") {
        const cp = data as Partial<Checkpoint>;
        // Obsolete v3 and malformed v4 checkpoints rebuild; no migration.
        if (cp.version === 4) {
          if (
            Object.hasOwn(cp, "interval") ||
            typeof cp.enabled !== "boolean" ||
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
          this.usage = { ...cp.usage };
          if (cp.source) {
            const source = this.conversation.canonicalSource(cp.source);
            const snapshot = this.conversation.rehydrate(source);
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
                (saved.workKind !== "action" &&
                  saved.workKind !== "response") ||
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
                  ...(base && base.workKind !== saved.workKind
                    ? (() => {
                        throw new Error("Saved task work kind changed");
                      })()
                    : {}),
                  id: saved.id,
                  text: message.text.slice(ref.start, ref.end),
                  workKind: saved.workKind,
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
            const emptyReportHistory =
              !cp.conversation ||
              (!cp.conversation.cursor &&
                cp.conversation.initialReportPending !== true &&
                cp.conversation.order === 0 &&
                Array.isArray(cp.conversation.proofs) &&
                cp.conversation.proofs.length === 0 &&
                !cp.conversation.partialReport);
            if (emptyReportHistory) this.conversation.select(source, false);
            else this.conversation.restore(ledger, cp.conversation, source);
            this.source = source;
            this.ledger = ledger;
            try {
              this.restoreUnresolvedScope(cp.unresolvedScope);
            } catch {
              this.note("discarded-unresolved-scope");
            }
            try {
              this.restorePartialScope(ledger, cp.partialScope);
            } catch {
              this.scopeWork = undefined;
              this.note("discarded-partial-scope");
            }
            this.healthDeferred = true;
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
    if (preserveControls) savedEnabled = wasEnabled;
    this.enabled = false;
    if (savedEnabled) this.turnOn(cwd);
    else this.changed();
  }
}
