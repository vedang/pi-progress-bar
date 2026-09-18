import type { EvaluationRequest, ValidatedResult } from "../analysis/gateway";
import { applyReportBatch } from "../core/ledger";
import type { Ledger, ReportState, SourceSnapshot } from "../core/types";
import {
  type CandidateContext,
  candidateRequest,
  classificationRequest,
  classifications,
  fits,
  type Proposal,
  proposal,
} from "./candidates";
import {
  hasUncertainReportState,
  reportChunks,
  reportCurrent,
  reportStates,
} from "./reports";
import {
  type Candidate,
  collectTrajectory,
  findCandidates,
  hashText,
  type Observation,
  type Span,
  type Trajectory,
} from "./trajectory";

export interface ConversationSource {
  kind: "conversation";
  entryId: string;
  hash: string;
  spans: {
    id: string;
    start: number;
    end: number;
    criteria: [number, number][];
  }[];
  context: [number, number][];
}
interface Reference {
  id: string;
  hash: string;
  /** Present only for a committed subwindow of an oversized original. */
  offset?: number;
}
interface PartialReportCheckpoint {
  sourceId: string;
  sourceRevision: string;
  scopeRevision: string;
  report: Reference;
  /** Number of accepted chunks; no ledger mutation occurs until all complete. */
  index: number;
  /** SHA-256 digests of exact rebuilt accepted requests, never request text. */
  requestHashes: string[];
  states: { taskId: string; status: ReportState }[];
  /** Accepted non-unknown current choices, bound to their chunk index. */
  currents: { index: number; taskId: string }[];
  /** Detects accidental/unrecomputed local checkpoint corruption; not authentication. */
  digest: string;
}
export interface ConversationCheckpoint {
  cursor?: Reference;
  /** Last candidate boundary whose semantic phase settled; never scan-ahead. */
  discoveryCursor?: Reference;
  order: number;
  asOf?: number;
  gap?: string;
  initialReportPending?: boolean;
  proofs: { taskId: string; status: ReportState; report: Reference }[];
  partialReport?: PartialReportCheckpoint;
}
type Enqueue = (
  purpose: string,
  request: EvaluationRequest,
  admit: (result: ValidatedResult) => void,
) => void;
interface Evidence {
  request: EvaluationRequest;
  result: ValidatedResult;
  at: number;
}
interface PendingReport {
  identity: string;
  report: Observation;
  requests: EvaluationRequest[];
  index: number;
  states: Record<string, ReportState>;
  /** Chunk-local choices prove membership on durable replay. */
  currents: Map<number, string>;
  evidence: Evidence[];
}

const reportWorkIdentity = (ledger: Ledger) =>
  JSON.stringify([
    ledger.sourceId,
    ledger.sourceRevision,
    ledger.scopeRevision,
  ]);
const requestHash = (request: EvaluationRequest) =>
  hashText(JSON.stringify(request));
const reportJournalDigest = (
  partial: Omit<PartialReportCheckpoint, "digest">,
) =>
  hashText(
    JSON.stringify({
      sourceId: partial.sourceId,
      sourceRevision: partial.sourceRevision,
      scopeRevision: partial.scopeRevision,
      report: { id: partial.report.id, hash: partial.report.hash },
      index: partial.index,
      requestHashes: [...partial.requestHashes],
      states: [...partial.states].sort((left, right) =>
        left.taskId.localeCompare(right.taskId),
      ),
      currents: [...partial.currents].sort(
        (left, right) => left.index - right.index,
      ),
    }),
  );
const reportStatesSet = new Set<ReportState>([
  "done",
  "reopened",
  "not-started",
  "in-progress",
  "cancelled",
  "unknown",
  "conflict",
]);
interface DiscoveryWork {
  candidate: Candidate;
  context: CandidateContext;
  phase: "selection" | "classification";
  chunks?: Span[][];
  index?: number;
  classes?: Record<string, string>;
}

/** Owns bounded evidence/cursors. Scheduler owns only disposable wake-up notifications. */
export class Conversation {
  trajectory: Trajectory = collectTrajectory([]);
  candidates: Candidate[] = [];
  proposals: Proposal[] = [];
  omissions: string[] = [];
  discoveryStatus = "Pending: enable analysis to discover conversation plans";
  reportStatus = "Unknown: no selected conversation source";
  discoveryEvidence: Evidence[] = [];
  reportEvidence: Evidence[] = [];
  cursor?: Reference;
  asOf?: number;
  gap?: string;
  proofs = new Map<string, ConversationCheckpoint["proofs"][number]>();
  private discoveryGeneration = 0;
  private discoveryCursor?: Reference;
  /** Persisted independently from raw pagination so queued scope never disappears. */
  private semanticDiscoveryCursor?: Reference;
  private seenCandidates = new Set<string>();
  private settledCandidates = new Set<string>();
  private branchEntries: readonly unknown[] = [];
  private observations?: Observation[];
  private reportTrajectory?: Trajectory;
  private sourceObservation?: Observation;
  private cursorObservation?: Observation;
  private candidatesPending: Candidate[] = [];
  private discovery?: DiscoveryWork;
  private pending?: PendingReport;
  private narrowedEntryId?: string;
  private initialReportPending = false;
  private diagnosticCounts = new Map<string, number>();

  /** Reason codes are bounded, aggregate-only diagnostics; no source text escapes. */
  note(code: string) {
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
    return [...this.diagnosticCounts.entries()].map(([code, count]) => ({
      code,
      count,
    }));
  }
  hasPendingDiscovery() {
    return !!this.discovery || this.candidatesPending.length > 0;
  }
  isCatchingUp() {
    return !!this.trajectory.hasMore;
  }
  hasPendingReports() {
    return (
      !!this.pending || this.reportStatus.startsWith("Pending: ordered report")
    );
  }

  narrow(entryId: string) {
    if (!this.trajectory.messages.some((message) => message.id === entryId))
      throw new Error(
        "Entry unavailable in bounded active-branch history; original visible user/assistant text required",
      );
    this.narrowedEntryId = entryId;
    this.updateCandidates();
  }
  update(entries: readonly unknown[]) {
    if (this.branchEntries !== entries) this.observations = undefined;
    this.branchEntries = entries;
    this.trajectory = collectTrajectory(entries, {
      chronological: true,
      ...(this.discoveryCursor ? { after: this.discoveryCursor } : {}),
    });
    this.updateCandidates();
    this.updateReportTrajectory();
  }
  private candidateKey(candidate: Pick<Candidate, "id" | "hash">) {
    return `${candidate.id}:${candidate.hash}`;
  }
  /** Only ordinary-sized originals can safely anchor an incremental checkpoint. */
  private referenceForCandidate(candidate: Candidate): Reference | undefined {
    const observation = this.trajectory.messages.find(
      (item) =>
        item.id === candidate.entryId &&
        item.hash === candidate.hash &&
        item.offset === undefined,
    );
    return observation && Buffer.byteLength(observation.text) <= 16 * 1024
      ? { id: candidate.entryId, hash: candidate.hash }
      : undefined;
  }
  private unresolvedProposalThrough(candidate: Candidate) {
    const candidateOrder = this.orderOf(candidate.entryId, candidate.hash);
    return this.proposals.some((item) => {
      if (this.settledCandidates.has(this.candidateKey(item.candidate)))
        return false;
      const proposalOrder = this.orderOf(
        item.candidate.entryId,
        item.candidate.hash,
      );
      return proposalOrder < 0 || proposalOrder <= candidateOrder;
    });
  }
  private advanceSemanticCursor() {
    let latest: Candidate | undefined;
    for (const [index, candidate] of this.candidates.entries()) {
      if (!this.settledCandidates.has(this.candidateKey(candidate))) break;
      if (this.unresolvedProposalThrough(candidate)) break;
      const next = this.candidates[index + 1];
      if (next?.entryId !== candidate.entryId || next.hash !== candidate.hash)
        latest = candidate;
    }
    const reference = latest && this.referenceForCandidate(latest);
    if (
      reference &&
      (!this.semanticDiscoveryCursor ||
        this.orderOf(reference.id, reference.hash) >=
          this.orderOf(
            this.semanticDiscoveryCursor.id,
            this.semanticDiscoveryCursor.hash,
          ))
    )
      this.semanticDiscoveryCursor = reference;
  }
  private settleCandidate(candidate: Pick<Candidate, "id" | "hash">) {
    this.settledCandidates.add(this.candidateKey(candidate));
    this.advanceSemanticCursor();
  }
  /** Scope admission is a durable semantic phase, separate from report cursor. */
  commitScope(candidate: Pick<Candidate, "id" | "hash">) {
    this.settleCandidate(candidate);
  }
  private updateCandidates() {
    this.candidates = findCandidates(
      this.narrowedEntryId
        ? {
            ...this.trajectory,
            messages: this.trajectory.messages.filter(
              (m) => m.id === this.narrowedEntryId,
            ),
          }
        : this.trajectory,
    );
    this.omissions = [...this.trajectory.omissions];
    const additions = this.candidates.filter((candidate) => {
      const key = this.candidateKey(candidate);
      if (this.seenCandidates.has(key)) return false;
      this.seenCandidates.add(key);
      return true;
    });
    if (!additions.length) return;
    this.candidatesPending.push(...additions);
    this.discoveryStatus = "Pending: chronological source evaluation";
  }
  private original(reference: Reference): Observation | undefined {
    const cached = [this.sourceObservation, this.cursorObservation].find(
      (item) => item?.id === reference.id && item.hash === reference.hash,
    );
    if (cached) return cached;
    return collectTrajectory(this.branchEntries, {
      chronological: true,
      unbounded: true,
    }).messages.find(
      (message) =>
        message.id === reference.id && message.hash === reference.hash,
    );
  }
  observation(reference: {
    id: string;
    hash: string;
  }): Observation | undefined {
    return this.original(reference);
  }
  observationById(id: string): Observation | undefined {
    return collectTrajectory(this.branchEntries, {
      chronological: true,
      unbounded: true,
    }).messages.find((message) => message.id === id);
  }
  /** Resolve against whole live branch: paging never revokes a durable ref. */
  candidate(reference: Pick<Candidate, "id" | "hash" | "entryId">) {
    return findCandidates({
      messages: this.allObservations(),
      complete: true,
      omissions: [],
    }).find(
      (candidate) =>
        candidate.id === reference.id &&
        candidate.hash === reference.hash &&
        candidate.entryId === reference.entryId,
    );
  }
  hasCandidate(reference: Pick<Candidate, "id" | "hash" | "entryId">) {
    return !!this.candidate(reference);
  }
  private allObservations() {
    if (!this.observations)
      this.observations = collectTrajectory(this.branchEntries, {
        chronological: true,
        unbounded: true,
      }).messages;
    return this.observations;
  }
  private orderOf(entryId: string, hash?: string) {
    return this.allObservations().findIndex(
      (message) => message.id === entryId && (!hash || message.hash === hash),
    );
  }
  /** True only for unresolved candidate work at/before this report observation. */
  blocksReportsThrough(observation: Observation) {
    const reportOrder = this.orderOf(observation.id, observation.hash);
    if (reportOrder < 0) return true;
    return [
      ...(this.discovery ? [this.discovery.candidate] : []),
      ...this.candidatesPending,
    ].some((candidate) => {
      const candidateOrder = this.orderOf(candidate.entryId, candidate.hash);
      return candidateOrder < 0 || candidateOrder <= reportOrder;
    });
  }
  entryIsAtOrBefore(entryId: string, hash: string, observation: Observation) {
    const entryOrder = this.orderOf(entryId, hash);
    const observationOrder = this.orderOf(observation.id, observation.hash);
    return (
      entryOrder < 0 || observationOrder < 0 || entryOrder <= observationOrder
    );
  }
  private applicableUserContext(candidate: Candidate): CandidateContext {
    const observations = this.allObservations();
    const index = observations.findIndex(
      (message) =>
        message.id === candidate.entryId && message.hash === candidate.hash,
    );
    if (index < 0) return { precedingUserMessages: [] };
    const context: { id: string; text: string }[] = [];
    let bytes = 0;
    for (let cursor = index - 1; cursor >= 0 && context.length < 2; cursor--) {
      const observation = observations[cursor];
      if (observation?.role !== "user") continue;
      const next = Buffer.byteLength(observation.text);
      if (bytes + next > 4096) continue;
      context.push({ id: observation.id, text: observation.text });
      bytes += next;
    }
    return { precedingUserMessages: context.reverse() };
  }
  /** Scope work may commit only for report head; future goals cannot rewrite past reports. */
  scopeMayAdmit(entryId: string, hash: string) {
    if (!this.cursor) return false;
    const timeline = this.reportTrajectory ?? this.trajectory;
    const index = timeline.messages.findIndex(
      (message) =>
        message.id === this.cursor?.id && message.hash === this.cursor?.hash,
    );
    const next = this.initialReportPending
      ? this.sourceObservation
      : timeline.messages[index + 1];
    return !!next && next.id === entryId && next.hash === hash;
  }
  /**
   * A later clear scope can supersede an earlier unresolved observation. Its
   * report is deliberately not applied to either denominator; cursor moves
   * only over that explicitly rejected prefix so replacement starts cleanly.
   */
  skipUnresolvedReportsBefore(entryId: string, hash: string) {
    if (!this.cursor) return;
    const timeline = this.reportTrajectory ?? this.trajectory;
    const cursorIndex = timeline.messages.findIndex(
      (message) =>
        message.id === this.cursor?.id && message.hash === this.cursor?.hash,
    );
    const targetIndex = timeline.messages.findIndex(
      (message) => message.id === entryId && message.hash === hash,
    );
    if (cursorIndex < 0 || targetIndex <= cursorIndex + 1) return;
    const skipped = timeline.messages[targetIndex - 1];
    if (!skipped) return;
    this.cursor = { id: skipped.id, hash: skipped.hash };
    this.cursorObservation = skipped;
    this.initialReportPending = false;
    this.pending = undefined;
    this.note("superseded-unresolved-scope");
    this.reportStatus = "Unknown: earlier unresolved scope superseded";
  }
  private updateReportTrajectory() {
    const anchor = this.initialReportPending
      ? this.sourceObservation
      : this.cursor
        ? this.original(this.cursor)
        : undefined;
    if (!anchor) {
      this.reportTrajectory = undefined;
      return;
    }
    const next = collectTrajectory(this.branchEntries, {
      chronological: true,
      after: { id: anchor.id, hash: anchor.hash },
      wholeEntries: true,
    });
    this.cursorObservation = anchor;
    this.reportTrajectory = {
      ...next,
      messages: [anchor, ...next.messages],
    };
  }
  preview(ledger?: Ledger) {
    let report = this.pending?.requests[this.pending.index];
    if (!report && ledger?.kind === "conversation" && this.cursor) {
      const timeline = this.reportTrajectory ?? this.trajectory;
      const source = this.sourceObservation;
      const index = this.initialReportPending
        ? -1
        : timeline.messages.findIndex(
            (m) => m.id === this.cursor?.id && m.hash === this.cursor.hash,
          );
      const observation =
        index === -1 && this.initialReportPending
          ? source
          : timeline.messages[index + 1];
      if (observation)
        try {
          report = reportChunks(ledger, observation)[0];
        } catch {
          /* Essential overflow is disclosed, never clipped. */
        }
    }
    return {
      discovery:
        this.discovery?.phase === "selection"
          ? candidateRequest([this.discovery.candidate], this.discovery.context)
          : undefined,
      report,
      coverage: this.omissions,
      boundary:
        "Future visible user/assistant text on this active branch, and selected task/criteria. Interactive tool answers excluded.",
    };
  }
  scheduleDiscovery(enqueue: Enqueue, valid: () => boolean) {
    const generation = this.discoveryGeneration;
    // One candidate completes selection and classification before later entries.
    const current = () => valid() && generation === this.discoveryGeneration;
    if (!this.discovery) {
      const candidate = this.candidatesPending.shift();
      if (candidate)
        this.discovery = {
          candidate,
          context: this.applicableUserContext(candidate),
          phase: "selection",
        };
    }
    const work = this.discovery;
    if (!work) {
      if (this.trajectory.hasMore) {
        const last = this.trajectory.messages.at(-1);
        if (last) {
          this.discoveryCursor = {
            id: last.id,
            hash: last.hash,
            ...(last.offset === undefined ? {} : { offset: last.offset }),
          };
          this.discoveryGeneration++;
          this.discoveryStatus =
            "Pending: advancing chronological conversation catch-up";
          return;
        }
      }
      this.discoveryStatus = this.proposals.length
        ? "Scope observations admitted; no new source evidence"
        : "Unknown: no actionable plan suggested";
      return;
    }
    if (work.phase === "selection") {
      const request = candidateRequest([work.candidate], work.context);
      if (!fits(request)) {
        this.note("candidate-context-overflow");
        this.discovery = undefined;
        this.settleCandidate(work.candidate);
        this.discoveryStatus =
          "Unknown: source evidence exceeds analysis bounds";
        return;
      }
      this.discoveryStatus = "Pending: select chronological source evidence";
      enqueue("discovery", request, (result) => {
        if (!current() || this.discovery !== work) return;
        this.discoveryEvidence = [
          ...this.discoveryEvidence,
          { request, result, at: Date.now() },
        ].slice(-12);
        const answer = result.answers.source;
        const probability =
          answer?.type === "choice"
            ? (answer.probabilities[answer.choice] ?? 0)
            : 0;
        if (
          answer?.type !== "choice" ||
          answer.choice !== work.candidate.id ||
          answer.confidence < 0.5 ||
          probability < 0.8
        ) {
          this.note("candidate-rejected");
          this.discovery = undefined;
          this.settleCandidate(work.candidate);
          this.discoveryStatus =
            "Pending: evaluate next chronological evidence";
          return;
        }
        const chunks: Span[][] = [];
        let spans: Span[] = [];
        for (const span of work.candidate.spans) {
          if (
            !fits(
              classificationRequest(
                work.candidate,
                [...spans, span],
                work.context,
              ),
            )
          ) {
            if (spans.length) chunks.push(spans);
            spans = [];
            if (
              !fits(classificationRequest(work.candidate, [span], work.context))
            ) {
              this.note("classification-overflow");
              this.discovery = undefined;
              this.settleCandidate(work.candidate);
              this.discoveryStatus =
                "Unknown: essential task classification exceeds analysis bounds";
              return;
            }
          }
          spans.push(span);
        }
        if (spans.length) chunks.push(spans);
        if (!chunks.length) {
          this.note("candidate-rejected");
          this.discovery = undefined;
          this.settleCandidate(work.candidate);
          return;
        }
        work.phase = "classification";
        work.chunks = chunks;
        work.index = 0;
        work.classes = {};
        this.discoveryStatus = "Pending: classify selected task spans";
      });
      return;
    }
    const chunks = work.chunks;
    const index = work.index;
    const spans = chunks?.[index ?? -1];
    if (!chunks || index === undefined || !spans) {
      this.note("controller-rejection");
      this.discovery = undefined;
      this.settleCandidate(work.candidate);
      this.discoveryStatus = "Unknown: discovery transaction rejected";
      return;
    }
    const request = classificationRequest(work.candidate, spans, work.context);
    enqueue("discovery", request, (result) => {
      if (
        !current() ||
        this.discovery !== work ||
        work.phase !== "classification" ||
        work.index !== index
      )
        return;
      try {
        if (!work.classes) throw new Error("Missing classification state");
        Object.assign(work.classes, classifications(request, result));
      } catch {
        this.note("controller-rejection");
        this.discovery = undefined;
        this.settleCandidate(work.candidate);
        this.discoveryStatus = "Unknown: task classification rejected";
        return;
      }
      this.discoveryEvidence = [
        ...this.discoveryEvidence,
        { request, result, at: Date.now() },
      ].slice(-12);
      work.index++;
      if (work.index < chunks.length) return;
      try {
        if (!work.classes) throw new Error("Missing classification state");
        this.proposals.push(proposal(work.candidate, work.classes));
        this.discoveryStatus = "Pending: reconcile selected scope observation";
      } catch {
        this.note("candidate-rejected");
        this.settleCandidate(work.candidate);
        this.discoveryStatus = "Pending: evaluate next chronological evidence";
      }
      this.discovery = undefined;
    });
  }
  source(item: Proposal): ConversationSource {
    const candidate = item.candidate;
    return {
      kind: "conversation",
      entryId: candidate.entryId,
      hash: candidate.hash,
      spans: item.snapshot.tasks.map((task) => ({
        id: task.anchor ?? "",
        start: task.ref.start,
        end: task.ref.end,
        criteria: (task.criterionRefs ?? []).map((ref) => [ref.start, ref.end]),
      })),
      context: candidate.spans
        .filter((s) => item.context.includes(s.text))
        .map((s) => [s.start, s.end]),
    };
  }
  /** Parse checkpoint source into exact reference-only shape and bind it live. */
  canonicalSource(
    source: ConversationSource,
    expected?: Pick<Candidate, "id" | "hash" | "entryId">,
  ): ConversationSource {
    if (
      source?.kind !== "conversation" ||
      typeof source.entryId !== "string" ||
      !source.entryId ||
      source.entryId.length > 200 ||
      typeof source.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(source.hash) ||
      !Array.isArray(source.spans) ||
      !source.spans.length ||
      source.spans.length > 200 ||
      !Array.isArray(source.context) ||
      source.context.length > 512
    )
      throw new Error("Invalid conversation source checkpoint");
    const message = this.original({ id: source.entryId, hash: source.hash });
    const candidate = expected
      ? this.candidate(expected)
      : findCandidates({
          messages: this.allObservations(),
          complete: true,
          omissions: [],
        }).find(
          (item) =>
            item.entryId === source.entryId &&
            item.hash === source.hash &&
            source.spans.some(
              (span) =>
                span?.id === item.spans[0]?.id ||
                item.spans.some((live) => live.id === span?.id),
            ),
        );
    if (!message || !candidate)
      throw new Error("Original selected conversation source unavailable");
    if (candidate.entryId !== source.entryId || candidate.hash !== source.hash)
      throw new Error("Conversation source candidate changed");
    const liveSpans = new Map(candidate.spans.map((span) => [span.id, span]));
    const canonicalRange = (value: unknown) => {
      if (!Array.isArray(value) || value.length !== 2)
        throw new Error("Invalid conversation range");
      const [start, end] = value;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end <= start ||
        end > message.text.length
      )
        throw new Error("Invalid conversation range");
      const live = [...liveSpans.values()].find(
        (span) => span.start === start && span.end === end,
      );
      if (!live) throw new Error("Conversation range no longer matches source");
      return [start, end] as [number, number];
    };
    const spans = source.spans.map((span) => {
      if (
        !span ||
        typeof span.id !== "string" ||
        !span.id ||
        span.id.length > 256 ||
        !Number.isSafeInteger(span.start) ||
        !Number.isSafeInteger(span.end) ||
        !Array.isArray(span.criteria) ||
        span.criteria.length > 512
      )
        throw new Error("Invalid span reference");
      const live = liveSpans.get(span.id);
      if (!live || live.start !== span.start || live.end !== span.end)
        throw new Error("Conversation span no longer matches source");
      const seenCriteria = new Set<string>();
      const criteria = span.criteria.map((criterion) => {
        const [start, end] = canonicalRange(criterion);
        const key = `${start}:${end}`;
        if (seenCriteria.has(key))
          throw new Error("Duplicate criterion reference");
        seenCriteria.add(key);
        return [start, end] as [number, number];
      });
      return { id: live.id, start: live.start, end: live.end, criteria };
    });
    const anchors = new Set<string>();
    for (const span of spans) {
      if (anchors.has(span.id)) throw new Error("Duplicate task anchor");
      anchors.add(span.id);
    }
    const context = source.context.map((range) => canonicalRange(range));
    return {
      kind: "conversation",
      entryId: candidate.entryId,
      hash: candidate.hash,
      spans,
      context,
    };
  }
  rehydrate(source: ConversationSource): SourceSnapshot {
    const canonical = this.canonicalSource(source);
    const message = this.original({
      id: canonical.entryId,
      hash: canonical.hash,
    });
    if (!message)
      throw new Error("Original selected conversation source unavailable");
    const sourceId = `conversation:${canonical.entryId}`;
    return {
      sourceId,
      kind: "conversation",
      revision: canonical.hash,
      complete: true,
      tasks: canonical.spans.map((span) => ({
        text: message.text.slice(span.start, span.end),
        anchor: span.id,
        criteria: span.criteria.map(([start, end]) =>
          message.text.slice(start, end),
        ),
        criterionRefs: span.criteria.map(([start, end]) => ({
          sourceId,
          entryId: canonical.entryId,
          start,
          end,
          provenance: message.role,
        })),
        revision: canonical.hash,
        status: "not-started",
        ref: {
          sourceId,
          entryId: canonical.entryId,
          start: span.start,
          end: span.end,
          provenance: message.role,
        },
      })),
    };
  }
  context(source: ConversationSource) {
    const canonical = this.canonicalSource(source);
    const message = this.original({
      id: canonical.entryId,
      hash: canonical.hash,
    });
    return message
      ? canonical.context.map(([start, end]) => message.text.slice(start, end))
      : [];
  }
  /** Initial adoption interprets source before advancing report state. */
  select(
    source: ConversationSource,
    includeSourceReport = true,
    hidePendingCursor = false,
  ) {
    const reference = { id: source.entryId, hash: source.hash };
    this.sourceObservation = this.original(reference);
    this.cursor =
      includeSourceReport && hidePendingCursor ? undefined : reference;
    this.cursorObservation = this.sourceObservation;
    this.pending = undefined;
    this.proofs.clear();
    this.reportEvidence = [];
    this.asOf = undefined;
    this.gap = undefined;
    this.initialReportPending = includeSourceReport;
    this.updateReportTrajectory();
    this.reportStatus =
      "Pending: selected plan observation and later reports in order";
  }
  /** Scope revisions/archive invalidate old completion proof ownership. */
  retainProofs(ledger: Ledger, invalidated: Iterable<string> = []) {
    const invalid = new Set(invalidated);
    for (const [taskId, proof] of this.proofs) {
      const task = ledger.tasks.find((item) => item.id === taskId);
      if (
        invalid.has(taskId) ||
        !task?.included ||
        task.status !== proof.status
      )
        this.proofs.delete(taskId);
    }
  }
  checkpoint(ledger: Ledger): ConversationCheckpoint {
    const partial = this.pending;
    const partialReport =
      partial && partial.index > 0
        ? (() => {
            const journal = {
              sourceId: ledger.sourceId,
              sourceRevision: ledger.sourceRevision,
              scopeRevision: ledger.scopeRevision,
              report: { id: partial.report.id, hash: partial.report.hash },
              index: partial.index,
              requestHashes: partial.requests
                .slice(0, partial.index)
                .map(requestHash),
              states: Object.entries(partial.states)
                .map(([taskId, status]) => ({ taskId, status }))
                .sort((left, right) => left.taskId.localeCompare(right.taskId)),
              currents: [...partial.currents.entries()]
                .map(([index, taskId]) => ({ index, taskId }))
                .sort((left, right) => left.index - right.index),
            };
            return { ...journal, digest: reportJournalDigest(journal) };
          })()
        : undefined;
    return {
      cursor: this.cursor,
      discoveryCursor: this.semanticDiscoveryCursor ?? this.cursor,
      order: ledger.reportOrder,
      asOf: this.asOf,
      gap: this.gap,
      ...(this.initialReportPending ? { initialReportPending: true } : {}),
      proofs: [...this.proofs.values()],
      ...(partialReport ? { partialReport } : {}),
    };
  }
  /** Prevent duplicate discovery while a checked partial scope transaction resumes. */
  resumeScopeCandidate(candidate: Pick<Candidate, "id" | "hash">) {
    this.seenCandidates.add(`${candidate.id}:${candidate.hash}`);
  }
  private restorePartialReport(
    ledger: Ledger,
    partial: PartialReportCheckpoint | undefined,
  ) {
    if (!partial) return;
    if (
      partial.sourceId !== ledger.sourceId ||
      partial.sourceRevision !== ledger.sourceRevision ||
      partial.scopeRevision !== ledger.scopeRevision ||
      !Number.isSafeInteger(partial.index) ||
      partial.index < 1 ||
      partial.index > 200 ||
      !Array.isArray(partial.requestHashes) ||
      partial.requestHashes.length !== partial.index ||
      !Array.isArray(partial.states) ||
      partial.states.length > 200 ||
      !Array.isArray(partial.currents) ||
      partial.currents.length > partial.index ||
      typeof partial.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(partial.digest)
    )
      throw new Error("Invalid partial report checkpoint");
    const timeline = this.reportTrajectory ?? this.trajectory;
    const cursorIndex = timeline.messages.findIndex(
      (message) =>
        message.id === this.cursor?.id && message.hash === this.cursor?.hash,
    );
    const expected = this.initialReportPending
      ? this.sourceObservation
      : timeline.messages[cursorIndex + 1];
    if (
      !expected ||
      partial.report.id !== expected.id ||
      partial.report.hash !== expected.hash
    )
      throw new Error("Partial report original unavailable");
    const requests = reportChunks(ledger, expected);
    if (
      partial.index >= requests.length ||
      partial.requestHashes.some(
        (hash, index) =>
          !/^[a-f0-9]{64}$/.test(hash) ||
          hash !== requestHash(requests[index] as EvaluationRequest),
      )
    )
      throw new Error("Partial report request changed");
    const states: Record<string, ReportState> = {};
    for (const state of partial.states) {
      const request = requests
        .slice(0, partial.index)
        .find((item) => Object.hasOwn(item.questions, state.taskId));
      const question = request?.questions[state.taskId];
      const choice = state.status === "conflict" ? "ambiguous" : state.status;
      if (
        !state ||
        typeof state.taskId !== "string" ||
        !state.taskId ||
        Object.hasOwn(states, state.taskId) ||
        !reportStatesSet.has(state.status) ||
        !question ||
        !Object.hasOwn(question.criteria, choice)
      )
        throw new Error("Invalid partial report decision");
      states[state.taskId] = state.status;
    }
    const currents = new Map<number, string>();
    for (const current of partial.currents) {
      const question = requests[current.index]?.questions.__current;
      if (
        !current ||
        !Number.isSafeInteger(current.index) ||
        current.index < 0 ||
        current.index >= partial.index ||
        typeof current.taskId !== "string" ||
        !current.taskId ||
        currents.has(current.index) ||
        !question ||
        !Object.hasOwn(question.criteria, current.taskId)
      )
        throw new Error("Invalid partial report current choice");
      currents.set(current.index, current.taskId);
    }
    const journal = {
      sourceId: partial.sourceId,
      sourceRevision: partial.sourceRevision,
      scopeRevision: partial.scopeRevision,
      report: { id: partial.report.id, hash: partial.report.hash },
      index: partial.index,
      requestHashes: [...partial.requestHashes],
      states: Object.entries(states)
        .map(([taskId, status]) => ({ taskId, status }))
        .sort((left, right) => left.taskId.localeCompare(right.taskId)),
      currents: [...currents.entries()]
        .map(([index, taskId]) => ({ index, taskId }))
        .sort((left, right) => left.index - right.index),
    };
    if (partial.digest !== reportJournalDigest(journal))
      throw new Error("Partial report journal digest changed");
    this.pending = {
      identity: reportWorkIdentity(ledger),
      report: expected,
      requests,
      index: partial.index,
      states,
      currents,
      evidence: [],
    };
    this.reportStatus = `Pending: ordered report ${partial.index + 1}/${requests.length}`;
  }
  restore(
    ledger: Ledger,
    checkpoint?: ConversationCheckpoint,
    source?: ConversationSource,
  ) {
    if (!checkpoint) throw new Error("Missing report cursor");
    if (
      !Array.isArray(checkpoint.proofs) ||
      checkpoint.proofs.length > 200 ||
      !Number.isSafeInteger(checkpoint.order) ||
      checkpoint.order < 0 ||
      (checkpoint.initialReportPending !== undefined &&
        typeof checkpoint.initialReportPending !== "boolean")
    )
      throw new Error("Invalid report metadata");
    const all = this.allObservations();
    const valid = (ref: Reference) =>
      !!ref && all.some((m) => m.id === ref.id && m.hash === ref.hash);
    if (
      (!checkpoint.cursor && !checkpoint.initialReportPending) ||
      (checkpoint.cursor && !valid(checkpoint.cursor))
    )
      throw new Error("Report cursor original unavailable");
    if (checkpoint.initialReportPending) {
      const reference = source && { id: source.entryId, hash: source.hash };
      if (!reference || !valid(reference))
        throw new Error("Initial report source original unavailable");
      this.sourceObservation = this.original(reference);
      if (!this.sourceObservation)
        throw new Error("Initial report source original unavailable");
    }
    if (checkpoint.discoveryCursor && !valid(checkpoint.discoveryCursor))
      throw new Error("Discovery cursor original unavailable");
    this.cursor = checkpoint.cursor;
    this.cursorObservation = this.cursor
      ? this.original(this.cursor)
      : undefined;
    // Checkpoint owns semantic admission only, never raw scan-ahead state or
    // disposable queued work. Restore restarts at that settled boundary.
    this.semanticDiscoveryCursor =
      checkpoint.discoveryCursor ?? checkpoint.cursor;
    this.discoveryCursor = this.semanticDiscoveryCursor;
    this.candidatesPending = [];
    this.discovery = undefined;
    this.proposals = [];
    this.seenCandidates.clear();
    this.settledCandidates.clear();
    this.initialReportPending = checkpoint.initialReportPending === true;
    this.asOf =
      typeof checkpoint.asOf === "number" && Number.isFinite(checkpoint.asOf)
        ? checkpoint.asOf
        : undefined;
    this.gap = checkpoint.gap
      ? "Saved report-history coverage gap; reselect source"
      : undefined;
    const statuses = new Set([
      "done",
      "reopened",
      "not-started",
      "in-progress",
      "cancelled",
      "unknown",
      "conflict",
    ]);
    const cursorIndex = all.findIndex((m) => m.id === this.cursor?.id);
    for (const proof of checkpoint.proofs) {
      const task = ledger.tasks.find(
        (t) => t.id === proof.taskId && t.included,
      );
      if (
        !task ||
        !statuses.has(proof.status) ||
        !valid(proof.report) ||
        this.proofs.has(proof.taskId) ||
        all.findIndex((m) => m.id === proof.report.id) > cursorIndex
      )
        throw new Error("Invalid original report proof");
      task.status = proof.status;
      this.proofs.set(task.id, proof);
    }
    ledger.reportOrder = checkpoint.order;
    ledger.stale = !!this.gap;
    this.updateReportTrajectory();
    try {
      this.restorePartialReport(ledger, checkpoint.partialReport);
    } catch {
      this.pending = undefined;
      this.note("discarded-partial-report");
    }
    if (!this.pending)
      this.reportStatus =
        "As-of restored report cursor; analysis requires new consent";
  }
  scheduleReports(
    ledger: Ledger,
    source: ConversationSource,
    epoch: number,
    enqueue: Enqueue,
    current: () => Ledger | undefined,
    apply: (ledger: Ledger) => void,
    blocked?: (observation: Observation) => boolean,
    checkpoint?: () => void,
  ) {
    const identity = reportWorkIdentity(ledger);
    const valid = () => {
      const live = current();
      return !!live && epoch >= 0 && reportWorkIdentity(live) === identity;
    };
    const fail = (code: string) => {
      this.note(code);
      this.gap = code;
      this.reportStatus = "Unknown / stale: report history cannot be ordered";
      if (!ledger.stale) apply({ ...ledger, stale: true });
    };
    if (this.gap) {
      fail("report-history-gap");
      return;
    }
    const timeline = this.reportTrajectory ?? this.trajectory;
    if (!timeline.complete) {
      fail("report-history-gap");
      return;
    }
    const sourceObservation = this.original({
      id: source.entryId,
      hash: source.hash,
    });
    if (!sourceObservation) {
      fail("report-history-gap");
      return;
    }
    const cursor = this.cursor;
    const index = timeline.messages.findIndex(
      (m) => m.id === cursor?.id && m.hash === cursor?.hash,
    );
    if (!this.initialReportPending && index < 0) {
      fail("report-history-gap");
      return;
    }
    const report = this.initialReportPending
      ? sourceObservation
      : timeline.messages[index + 1];
    if (!report) {
      this.reportStatus = `Conversation-reported • ${this.asOf ? `as-of ${new Date(this.asOf).toISOString()}` : "no interpreted reports"}`;
      return;
    }
    if (blocked?.(report)) {
      this.reportStatus = "Pending: earlier scope observation must settle";
      return;
    }
    if (
      !this.pending ||
      this.pending.identity !== identity ||
      this.pending.report.id !== report.id ||
      this.pending.report.hash !== report.hash
    ) {
      try {
        this.pending = {
          identity,
          report,
          requests: reportChunks(ledger, report),
          index: 0,
          states: {},
          currents: new Map(),
          evidence: [],
        };
      } catch {
        fail("report-overflow");
        return;
      }
    }
    const batch = this.pending;
    const request = batch.requests[batch.index];
    if (!request) {
      fail("controller-rejection");
      return;
    }
    this.reportStatus = `Pending: ordered report ${batch.index + 1}/${batch.requests.length}`;
    const chunk = batch.index;
    enqueue("reports", request, (result) => {
      const live = current();
      if (
        !valid() ||
        !live ||
        this.pending !== batch ||
        batch.index !== chunk ||
        this.cursor?.id !== cursor?.id ||
        this.cursor?.hash !== cursor?.hash ||
        !timeline.complete ||
        !timeline.messages.some(
          (m) => m.id === report.id && m.hash === report.hash,
        )
      ) {
        this.note("stale-report-result");
        return;
      }
      try {
        Object.assign(batch.states, reportStates(live, request, result));
        if (hasUncertainReportState(request, result))
          this.note("uncertain-report-state");
        const current = reportCurrent(live, request, result);
        if (current) batch.currents.set(chunk, current);
      } catch {
        fail("controller-rejection");
        return;
      }
      batch.evidence.push({ request, result, at: Date.now() });
      batch.index++;
      if (batch.index < batch.requests.length) {
        checkpoint?.();
        return;
      }
      const order = live.reportOrder + 1;
      let next = Object.keys(batch.states).length
        ? applyReportBatch(live, {
            sourceId: live.sourceId,
            scopeRevision: live.scopeRevision,
            order,
            entryId: report.id,
            states: batch.states,
          })
        : { ...live, reportOrder: order };
      const currentChoices = new Set(batch.currents.values());
      const requestedCurrent =
        currentChoices.size === 1 ? [...currentChoices][0] : "unknown";
      next = {
        ...next,
        currentTaskId: next.tasks.some(
          (task) =>
            task.id === requestedCurrent &&
            task.included &&
            task.status !== "cancelled",
        )
          ? requestedCurrent
          : undefined,
      };
      for (const [taskId, status] of Object.entries(batch.states))
        this.proofs.set(taskId, {
          taskId,
          status,
          report: { id: report.id, hash: report.hash },
        });
      next.reports = next.reports.slice(-32);
      this.reportEvidence = [...this.reportEvidence, ...batch.evidence].slice(
        -20,
      );
      this.cursor = { id: report.id, hash: hashText(report.text) };
      this.cursorObservation = report;
      this.initialReportPending = false;
      this.asOf = Date.now();
      this.pending = undefined;
      this.reportStatus = `Conversation-reported • as-of ${new Date(this.asOf).toISOString()}`;
      apply(next);
    });
  }
}
