import type { EvaluationRequest, ValidatedResult } from "../analysis/gateway";
import { applyReportBatch } from "../core/ledger";
import type { Ledger, ReportState, SourceSnapshot } from "../core/types";
import {
  candidateRequest,
  classificationRequest,
  classifications,
  fits,
  type Proposal,
  proposal,
} from "./candidates";
import { reportChunks, reportStates } from "./reports";
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
}
export interface ConversationCheckpoint {
  cursor?: Reference;
  order: number;
  asOf?: number;
  gap?: string;
  proofs: { taskId: string; status: ReportState; report: Reference }[];
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
  evidence: Evidence[];
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
  private discoveryKey = "";
  private selectionRequests: EvaluationRequest[] = [];
  private selectionIndex = 0;
  private selected: Candidate[] = [];
  private classified = new Set<string>();
  private classification?: {
    candidate: Candidate;
    chunks: Span[][];
    index: number;
    classes: Record<string, string>;
  };
  private pending?: PendingReport;
  private narrowedEntryId?: string;

  narrow(entryId: string) {
    if (!this.trajectory.messages.some((message) => message.id === entryId))
      throw new Error(
        "Entry unavailable in bounded active-branch history; original visible user/assistant text required",
      );
    this.narrowedEntryId = entryId;
    this.updateCandidates();
  }
  update(entries: readonly unknown[]) {
    this.trajectory = collectTrajectory(entries);
    this.updateCandidates();
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
    if (this.trajectory.messages.length > 12)
      this.omissions.push(
        "Candidate shortlist limited to 12 recent plan-bearing entries; not a complete-plan claim. Narrow explicitly with /progress source conversation#entryId",
      );
    const key = this.candidates.map((c) => c.hash + c.id).join(":");
    if (key === this.discoveryKey) return;
    this.discoveryKey = key;
    this.selectionIndex = 0;
    this.selectionRequests = [];
    this.selected = [];
    this.classified.clear();
    this.classification = undefined;
    this.proposals = [];
    this.discoveryEvidence = [];
    this.discoveryStatus = "Pending: conversation source suggestions";
    let group: Candidate[] = [];
    for (const candidate of this.candidates) {
      if (!fits(candidateRequest([...group, candidate]))) {
        if (group.length) this.selectionRequests.push(candidateRequest(group));
        group = [];
        if (!fits(candidateRequest([candidate]))) {
          this.omissions.push(
            `Candidate ${candidate.entryId} exceeds 24 KiB; unavailable for semantic selection`,
          );
          continue;
        }
      }
      group.push(candidate);
    }
    if (group.length) this.selectionRequests.push(candidateRequest(group));
  }
  preview(ledger?: Ledger) {
    let report = this.pending?.requests[this.pending.index];
    if (!report && ledger?.kind === "conversation" && this.cursor) {
      const index = this.trajectory.messages.findIndex(
        (m) => m.id === this.cursor?.id && m.hash === this.cursor.hash,
      );
      const observation =
        index >= 0 ? this.trajectory.messages[index + 1] : undefined;
      if (observation)
        try {
          report = reportChunks(ledger, observation)[0];
        } catch {
          /* Essential overflow is disclosed, never clipped. */
        }
    }
    return {
      discovery: this.selectionRequests[0],
      report,
      coverage: this.omissions,
      boundary:
        "Future visible user/assistant text on this active branch, and selected task/criteria. Interactive tool answers excluded.",
    };
  }
  scheduleDiscovery(enqueue: Enqueue, valid: () => boolean) {
    const key = this.discoveryKey;
    const current = () => valid() && key === this.discoveryKey;
    const request = this.selectionRequests[this.selectionIndex];
    if (request) {
      const index = this.selectionIndex;
      enqueue("discovery", request, (result) => {
        if (!current() || index !== this.selectionIndex) return;
        this.discoveryEvidence = [
          ...this.discoveryEvidence,
          { request, result, at: Date.now() },
        ].slice(-12);
        const answer = result.answers.source;
        const candidate =
          answer?.type === "choice"
            ? this.candidates.find((c) => c.id === answer.choice)
            : undefined;
        if (candidate) this.selected.push(candidate);
        this.selectionIndex++;
        this.discoveryStatus = "Pending: classify supplied task spans";
      });
      return;
    }
    if (!this.classification) {
      const candidate = this.selected.find((c) => !this.classified.has(c.id));
      if (!candidate) {
        this.discoveryStatus = this.proposals.length
          ? "Suggestions ready; explicit Apply required"
          : "Unknown: no actionable plan suggested";
        return;
      }
      const chunks: Span[][] = [];
      let spans: Span[] = [];
      for (const span of candidate.spans) {
        if (!fits(classificationRequest(candidate, [...spans, span]))) {
          if (spans.length) chunks.push(spans);
          spans = [];
          if (!fits(classificationRequest(candidate, [span]))) {
            this.classified.add(candidate.id);
            this.discoveryStatus =
              "Unknown: essential classification context exceeds 24 KiB";
            return;
          }
        }
        spans.push(span);
      }
      if (spans.length) chunks.push(spans);
      this.classification = { candidate, chunks, index: 0, classes: {} };
    }
    const batch = this.classification;
    const spans = batch.chunks[batch.index];
    if (!spans) return;
    const classification = classificationRequest(batch.candidate, spans);
    const index = batch.index;
    enqueue("discovery", classification, (result) => {
      if (!current() || this.classification !== batch || index !== batch.index)
        return;
      Object.assign(batch.classes, classifications(classification, result));
      this.discoveryEvidence = [
        ...this.discoveryEvidence,
        { request: classification, result, at: Date.now() },
      ].slice(-12);
      batch.index++;
      if (batch.index === batch.chunks.length) {
        this.classified.add(batch.candidate.id);
        try {
          this.proposals.push(proposal(batch.candidate, batch.classes));
        } catch (error) {
          this.discoveryStatus = String(error);
        }
        this.classification = undefined;
      }
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
        criteria: task.criteria.map((text) => {
          const span = candidate.spans.find((s) => s.text === text);
          if (!span) throw new Error("Missing criterion reference");
          return [span.start, span.end];
        }),
      })),
      context: candidate.spans
        .filter((s) => item.context.includes(s.text))
        .map((s) => [s.start, s.end]),
    };
  }
  rehydrate(source: ConversationSource): SourceSnapshot {
    const message = this.trajectory.messages.find(
      (m) => m.id === source.entryId && m.hash === source.hash,
    );
    if (
      !message ||
      !Array.isArray(source.spans) ||
      !source.spans.length ||
      source.spans.length > 200 ||
      !Array.isArray(source.context) ||
      source.context.length > 512
    )
      throw new Error("Original selected conversation source unavailable");
    const text = (start: number, end: number) => {
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end <= start ||
        end > message.text.length
      )
        throw new Error("Invalid conversation span");
      return message.text.slice(start, end);
    };
    for (const [start, end] of source.context) text(start, end);
    const sourceId = `conversation:${source.entryId}`;
    return {
      sourceId,
      kind: "conversation",
      revision: source.hash,
      complete: true,
      tasks: source.spans.map((span) => {
        if (
          typeof span.id !== "string" ||
          span.id.length > 256 ||
          !Array.isArray(span.criteria) ||
          span.criteria.length > 512
        )
          throw new Error("Invalid span reference");
        return {
          text: text(span.start, span.end),
          anchor: span.id,
          criteria: span.criteria.map(([start, end]) => text(start, end)),
          status: "not-started",
          ref: {
            sourceId,
            entryId: source.entryId,
            start: span.start,
            end: span.end,
            provenance: message.role,
          },
        };
      }),
    };
  }
  context(source: ConversationSource) {
    const message = this.trajectory.messages.find(
      (m) => m.id === source.entryId && m.hash === source.hash,
    );
    return message
      ? source.context.map(([start, end]) => message.text.slice(start, end))
      : [];
  }
  select(source: ConversationSource) {
    this.cursor = { id: source.entryId, hash: source.hash };
    this.pending = undefined;
    this.proofs.clear();
    this.reportEvidence = [];
    this.asOf = undefined;
    this.gap = undefined;
    this.reportStatus =
      "Pending: reports after selected plan; not observed completion";
  }
  checkpoint(ledger: Ledger): ConversationCheckpoint {
    return {
      cursor: this.cursor,
      order: ledger.reportOrder,
      asOf: this.asOf,
      gap: this.gap,
      proofs: [...this.proofs.values()],
    };
  }
  restore(ledger: Ledger, checkpoint?: ConversationCheckpoint) {
    if (!checkpoint) throw new Error("Missing report cursor");
    if (
      !Array.isArray(checkpoint.proofs) ||
      checkpoint.proofs.length > 200 ||
      !Number.isSafeInteger(checkpoint.order) ||
      checkpoint.order < 0
    )
      throw new Error("Invalid report metadata");
    const valid = (ref: Reference) =>
      ref &&
      this.trajectory.messages.some(
        (m) => m.id === ref.id && m.hash === ref.hash,
      );
    if (!checkpoint.cursor || !valid(checkpoint.cursor))
      throw new Error("Report cursor original unavailable");
    this.cursor = checkpoint.cursor;
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
    const cursorIndex = this.trajectory.messages.findIndex(
      (m) => m.id === this.cursor?.id,
    );
    for (const proof of checkpoint.proofs) {
      const task = ledger.tasks.find(
        (t) => t.id === proof.taskId && t.included,
      );
      if (
        !task ||
        !statuses.has(proof.status) ||
        !valid(proof.report) ||
        this.proofs.has(proof.taskId) ||
        this.trajectory.messages.findIndex((m) => m.id === proof.report.id) >
          cursorIndex
      )
        throw new Error("Invalid original report proof");
      task.status = proof.status;
      this.proofs.set(task.id, proof);
    }
    ledger.reportOrder = checkpoint.order;
    ledger.stale = !!this.gap;
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
  ) {
    const identity = JSON.stringify([
      epoch,
      ledger.sourceId,
      ledger.sourceRevision,
      ledger.scopeRevision,
    ]);
    const valid = () => {
      const live = current();
      return (
        live &&
        JSON.stringify([
          epoch,
          live.sourceId,
          live.sourceRevision,
          live.scopeRevision,
        ]) === identity
      );
    };
    const fail = (why: string) => {
      this.gap = why;
      this.reportStatus = `Unknown / stale: ${why}`;
      if (!ledger.stale) apply({ ...ledger, stale: true });
    };
    if (this.gap) {
      fail(this.gap);
      return;
    }
    if (!this.trajectory.complete) {
      fail("Incomplete report history; recover originals and reselect source");
      return;
    }
    if (
      !this.trajectory.messages.some(
        (m) => m.id === source.entryId && m.hash === source.hash,
      )
    ) {
      fail("Selected plan changed or original missing");
      return;
    }
    const cursor = this.cursor;
    const index = this.trajectory.messages.findIndex(
      (m) => m.id === cursor?.id && m.hash === cursor.hash,
    );
    if (index < 0) {
      fail("Ordered report cursor missing or changed");
      return;
    }
    const report = this.trajectory.messages[index + 1];
    if (!report) {
      this.reportStatus = `Conversation-reported • ${this.asOf ? `as-of ${new Date(this.asOf).toISOString()}` : "no interpreted reports"}`;
      return;
    }
    if (
      !this.pending ||
      this.pending.identity !== identity ||
      this.pending.report.id !== report.id
    ) {
      try {
        this.pending = {
          identity,
          report,
          requests: reportChunks(ledger, report),
          index: 0,
          states: {},
          evidence: [],
        };
      } catch (error) {
        fail(String(error));
        return;
      }
    }
    const batch = this.pending;
    const request = batch.requests[batch.index];
    if (!request) {
      fail("Empty report scope");
      return;
    }
    this.reportStatus = `Pending: ${this.trajectory.messages.length - index - 1} ordered reports; chunk ${batch.index + 1}/${batch.requests.length}${this.asOf ? ` • as-of ${new Date(this.asOf).toISOString()}` : ""}`;
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
        !this.trajectory.complete ||
        !this.trajectory.messages.some(
          (m) => m.id === report.id && m.hash === report.hash,
        )
      )
        return;
      Object.assign(batch.states, reportStates(live, request, result));
      batch.evidence.push({ request, result, at: Date.now() });
      batch.index++;
      if (batch.index < batch.requests.length) return;
      const order = live.reportOrder + 1;
      const next = Object.keys(batch.states).length
        ? applyReportBatch(live, {
            sourceId: live.sourceId,
            scopeRevision: live.scopeRevision,
            order,
            entryId: report.id,
            states: batch.states,
          })
        : { ...live, reportOrder: order };
      // Latest status proof per task survives bounded inspector-history eviction.
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
      this.asOf = Date.now();
      this.pending = undefined;
      this.reportStatus = `Conversation-reported • as-of ${new Date(this.asOf).toISOString()}`;
      apply(next);
    });
  }
}
