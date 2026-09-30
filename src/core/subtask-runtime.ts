import { createHash } from "node:crypto";
import type { ValidatedResult } from "../analysis/gateway";
import { ownDataJson } from "../analysis/own-data-json";
import {
  applySubtaskGate,
  buildSubtaskGate,
  type SubtaskGateBatch,
  type SubtaskGateOptions,
} from "../analysis/subtask-gate";
import {
  applySubtaskProposal,
  buildSubtaskProposal,
  type SubtaskProposalRequest,
} from "../analysis/subtask-proposal";
import {
  type SubtaskReportBatch,
  type SubtaskReportOptions,
  subtaskReportBatches,
  subtaskReportDecisions,
} from "../analysis/subtask-report";
import { deepFreeze, sameSource } from "../shared/guards";
import type { SubtaskEvidence } from "../sources/coverage";
import type {
  HybridState,
  HybridTask,
  Observation,
  SourceRef,
} from "./hybrid-state";
import { SubtaskAccess, type SubtaskAccessSnapshot } from "./subtask-access";
import {
  acceptedSubtaskRecordMatchesGroup,
  nextSubtaskPhase,
  pruneIncoherentAcceptedSubtaskRecords,
  restoreSubtaskJournal,
  type SubtaskJournalCheckpoint,
  type SubtaskPhaseRecord,
  type SubtaskReportAttempt,
  type SubtaskReportJob,
  subtaskJournalIsValid,
  supersedeSubtaskRecord,
  supersedeSubtaskReportJob,
} from "./subtask-journal";
import {
  type SubtaskCheckpoint,
  type SubtaskSnapshot,
  SubtaskStore,
  subtaskCheckpointIsValid,
} from "./subtasks";

export interface SubtaskRuntimeCheckpoint {
  state: SubtaskCheckpoint;
  journal: SubtaskJournalCheckpoint;
}

export interface SubtaskRuntimeCurrent {
  sourceId: string;
  enabled: boolean;
  parents: readonly HybridTask[];
  latest: Observation;
  earlier: readonly Observation[];
  omissions: readonly string[];
  selectedModel?: string;
  resolve: (entryId: string) => Observation | undefined;
  evidence?: SubtaskEvidence;
}

export interface SubtaskProposalTransportResult {
  text: string;
  model: string;
  provider: string;
  requestHash: string;
  usage: { inputTokens: number; outputTokens: number };
}

export type SubtaskPhysicalFlightObserver = (drain: Promise<void>) => void;

type SubtaskReportTransportResult =
  | { kind: "result"; result: ValidatedResult }
  | { kind: "retryable"; retryAfterMs: number }
  | { kind: "deferred"; retryAfterMs: number }
  | { kind: "unavailable" }
  | { kind: "failed" };

type SubtaskReportTransport = (
  batch: SubtaskReportBatch,
  signal: AbortSignal,
  onDispatch: (at: number) => boolean,
  onPhysicalFlight: SubtaskPhysicalFlightObserver,
) => Promise<SubtaskReportTransportResult>;

interface SubtaskReportCommitReserve {
  storeBytes: number;
  journalBytes: number;
}

interface SubtaskReportCapacityRefusal {
  sourceId: string;
  parent: HybridTask;
  group: SubtaskSnapshot["groups"][number];
  source: SourceRef;
}

type SubtaskReportCommitAdmission = boolean | "capacity";

export interface SubtaskRuntimeOptions {
  initial: SubtaskRuntimeCheckpoint;
  current: () => SubtaskRuntimeCurrent | undefined;
  /** Saved report authority may remain valid when newest generic input is oversized. */
  reportCurrent?: () => SubtaskRuntimeCurrent | undefined;
  gate: (
    batch: SubtaskGateBatch,
    signal: AbortSignal,
    onDispatch: (at: number) => boolean,
    onPhysicalFlight: SubtaskPhysicalFlightObserver,
  ) => Promise<ValidatedResult | undefined>;
  propose: (
    request: SubtaskProposalRequest,
    signal: AbortSignal,
    onDispatch: (at: number) => boolean,
    onPhysicalFlight: SubtaskPhysicalFlightObserver,
  ) => Promise<SubtaskProposalTransportResult | undefined>;
  /** Report dispatch remains unavailable until both optional capabilities exist. */
  report?: SubtaskReportTransport;
  canCommit?: (
    candidate: SubtaskRuntimeCheckpoint,
    reserve: SubtaskReportCommitReserve,
  ) => SubtaskReportCommitAdmission;
  /** Measured report refusal only; it never reports stale or transport failures. */
  onReportCapacityRefusal?: (refusal: SubtaskReportCapacityRefusal) => void;
  now?: () => number;
  commit: (candidate: SubtaskRuntimeCheckpoint) => boolean;
  onPublish: (snapshot: Readonly<SubtaskSnapshot>) => void;
}

interface CurrentReport {
  current: SubtaskRuntimeCurrent;
  parent: HybridTask;
  group: SubtaskSnapshot["groups"][number];
  report: Observation;
  options: SubtaskReportOptions;
}

type ReportDecisionsWithReceipt = ReturnType<typeof subtaskReportDecisions> & {
  receipt: NonNullable<ReturnType<typeof subtaskReportDecisions>["receipt"]>;
};

interface CurrentParent {
  current: SubtaskRuntimeCurrent;
  parent: HybridTask;
  group?: SubtaskSnapshot["groups"][number];
  options: SubtaskGateOptions;
}

type ReportBatchSelection =
  | { kind: "batch"; batch: SubtaskReportBatch }
  | { kind: "capacity" }
  | { kind: "unavailable" };

type ReportCommitAdmission = "accepted" | "capacity" | "unavailable";

interface Flight {
  controller: AbortController;
  epoch: number;
  promise: Promise<void>;
}

interface Ticket {
  dispatch: number;
  at: number;
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
}

type UsageBucket = "jev" | "extraction";

const emptyJournal = (): SubtaskJournalCheckpoint => ({
  version: 1,
  dispatches: 0,
  usage: {
    jev: { calls: 0, inputTokens: 0, outputTokens: 0 },
    extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
  },
  records: [],
  reports: [],
});

const detached = <Value>(value: Value): Value => structuredClone(value);

/** Preserve durable report history when decomposition records are replaced. */
const copyReportAttempts = (
  attempts: readonly SubtaskReportAttempt[],
): SubtaskReportAttempt[] =>
  structuredClone(attempts) as SubtaskReportAttempt[];

const withoutGroup = (options: SubtaskGateOptions): SubtaskGateOptions => {
  const { group: _group, ...bare } = options;
  return bare;
};

const recordMatchesBatch = (
  record: SubtaskPhaseRecord,
  batch: SubtaskGateBatch,
) =>
  record.identity === batch.identity &&
  record.parentTaskId === batch.parentTaskId &&
  record.parentRevision === batch.parentRevision &&
  record.parentSourceDigest === batch.parentSourceDigest &&
  record.listRevision === batch.listRevision &&
  sameSource(record.source, batch.source) &&
  record.contextHash === batch.contextHash &&
  record.triggerHash === batch.triggerHash &&
  record.gateModel === batch.gateModel &&
  record.selectedModel === batch.selectedModel;

const recordSuppressesAccepted = (
  record: SubtaskPhaseRecord,
  bare: SubtaskGateBatch,
  group: SubtaskSnapshot["groups"][number] | undefined,
) =>
  record.phase === "proposal-decided" &&
  (record.state === "complete" || record.state === "superseded") &&
  record.proposal?.outcome === "accepted" &&
  group !== undefined &&
  group.parentTaskId === bare.parentTaskId &&
  group.parentRevision === bare.parentRevision &&
  group.listRevision === record.proposal.listRevision &&
  record.parentTaskId === bare.parentTaskId &&
  record.parentRevision === bare.parentRevision &&
  record.parentSourceDigest === bare.parentSourceDigest &&
  record.triggerHash === bare.triggerHash &&
  record.selectedModel === bare.selectedModel &&
  sameSource(record.source, bare.source);

/**
 * Shared restore currentness bridge. The candidate is caller-owned detached
 * data; this function deliberately never consults a live Monitor/store.
 */
export function subtaskRuntimeReportIsCurrent(
  report: SubtaskReportJob,
  current: SubtaskRuntimeCurrent,
  candidate: {
    state: Pick<HybridState, "tasks">;
    group?: SubtaskSnapshot["groups"][number];
  },
): boolean {
  try {
    const parent = candidate.state.tasks.find(
      (task) => task.id === report.parentTaskId,
    );
    const group = candidate.group;
    if (
      !parent?.included ||
      parent.revision !== report.parentRevision ||
      !group ||
      group.id !== report.groupId ||
      group.parentTaskId !== parent.id ||
      group.parentRevision !== parent.revision ||
      group.listRevision !== report.listRevision
    )
      return false;
    const observation = current.resolve(report.source.entryId);
    if (!observation) return false;
    const batches = subtaskReportBatches({
      parent,
      group,
      report: observation,
      resolve: current.resolve,
    });
    const batch = batches[0];
    return (
      !!batch &&
      batches.every((item) => item.jobIdentity === batch.jobIdentity) &&
      report.identity === batch.jobIdentity &&
      report.parentTaskId === batch.parentTaskId &&
      report.parentRevision === batch.parentRevision &&
      report.parentSourceDigest === batch.parentSourceDigest &&
      report.groupId === batch.groupId &&
      report.listRevision === batch.listRevision &&
      report.model === batch.request.model &&
      sameSource(report.source, batch.source) &&
      report.childIds.length === group.children.length &&
      report.childIds.every(
        (childId, index) => childId === group.children[index]?.id,
      )
    );
  } catch {
    return false;
  }
}

export function subtaskRuntimeRecordIsCurrent(
  record: SubtaskPhaseRecord,
  current: SubtaskRuntimeCurrent,
  candidate: {
    state: Pick<HybridState, "tasks">;
    group?: SubtaskSnapshot["groups"][number];
  },
): boolean {
  const parent = candidate.state.tasks.find(
    (task) => task.id === record.parentTaskId,
  );
  if (!parent?.included || typeof current.selectedModel !== "string")
    return false;
  const group = candidate.group;
  if (
    group &&
    (group.parentTaskId !== parent.id ||
      group.parentRevision !== parent.revision)
  )
    return false;
  const options: SubtaskGateOptions = {
    parent,
    ...(group === undefined ? {} : { group }),
    latest: current.latest,
    earlier: current.earlier,
    omissions: current.omissions,
    selectedModel: current.selectedModel,
    resolve: current.resolve,
    ...(current.evidence === undefined ? {} : { evidence: current.evidence }),
  };
  if (record.proposal?.outcome === "accepted") {
    const bare = buildSubtaskGate(withoutGroup(options));
    return !!bare && recordSuppressesAccepted(record, bare, group);
  }
  const batch = buildSubtaskGate(options);
  return !!batch && recordMatchesBatch(record, batch);
}

const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const safeNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const finiteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const plainRecord = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => "value" in descriptor && descriptor.enumerable,
  );

const fieldValue = (record: Record<string, unknown>, key: string) =>
  Object.getOwnPropertyDescriptor(record, key)?.value;

const usageOf = (value: unknown): Usage | undefined => {
  if (!plainRecord(value)) return;
  const usage = fieldValue(value, "usage");
  if (!plainRecord(usage)) return;
  const inputTokens = fieldValue(usage, "inputTokens");
  const outputTokens = fieldValue(usage, "outputTokens");
  return safeNonNegative(inputTokens) && safeNonNegative(outputTokens)
    ? { inputTokens, outputTokens }
    : undefined;
};

const gateUsageOf = (value: unknown): Usage | undefined => {
  if (!plainRecord(value)) return;
  const usage = fieldValue(value, "usage");
  if (!plainRecord(usage)) return;
  const inputTokens = fieldValue(usage, "input_tokens");
  const outputTokens = fieldValue(usage, "output_tokens");
  return safeNonNegative(inputTokens) && safeNonNegative(outputTokens)
    ? { inputTokens, outputTokens }
    : undefined;
};

const validRuntimeCheckpoint = (
  value: unknown,
): value is SubtaskRuntimeCheckpoint =>
  plainRecord(value) &&
  Reflect.ownKeys(value).length === 2 &&
  Object.hasOwn(value, "state") &&
  Object.hasOwn(value, "journal") &&
  subtaskCheckpointIsValid(fieldValue(value, "state")) &&
  subtaskJournalIsValid(fieldValue(value, "journal"));

/**
 * Disconnected C05 coordinator. It owns only generic sidecar store/journal
 * state; Monitor remains owner of mandatory state and full-envelope storage.
 */
export class SubtaskRuntime {
  private initial?: SubtaskRuntimeCheckpoint;
  private store = new SubtaskStore();
  /** Runtime-only C04 associations stay attached to this stable store owner. */
  private access = new SubtaskAccess(this.store);
  private journal = emptyJournal();
  private initialized = false;
  private initializationBlocked = false;
  private sourceId?: string;
  private sourceFenced = false;
  private epoch = 0;
  private flight?: Flight;

  constructor(private readonly options: SubtaskRuntimeOptions) {
    // Isolate and structurally validate restored caller data now, but defer
    // source-current restoration until a run supplies authoritative parents.
    try {
      const initial = detached<unknown>(options.initial);
      if (!validRuntimeCheckpoint(initial)) {
        this.initializationBlocked = true;
        return;
      }
      this.initial = initial;
    } catch {
      this.initializationBlocked = true;
    }
  }

  /** Run no more than one physical optional transport flight at a time. */
  run(parentTaskId: string): Promise<void> {
    if (this.flight) return this.flight.promise;

    const controller = new AbortController();
    const flight: Flight = {
      controller,
      epoch: this.epoch,
      promise: Promise.resolve(),
    };
    // Reserve before consulting any caller callback. Reentrant save callbacks
    // therefore observe this same flight instead of opening another one.
    this.flight = flight;
    flight.promise = this.runFlight(parentTaskId, flight).finally(() => {
      if (this.flight === flight) this.flight = undefined;
    });
    return flight.promise;
  }

  /** Run one selected durable report chunk. Source omission resumes saved owner. */
  runReport(parentTaskId: string, source?: SourceRef): Promise<void> {
    if (this.flight) return this.flight.promise;

    const controller = new AbortController();
    const flight: Flight = {
      controller,
      epoch: this.epoch,
      promise: Promise.resolve(),
    };
    this.flight = flight;
    flight.promise = this.runReportFlight(parentTaskId, source, flight).finally(
      () => {
        if (this.flight === flight) this.flight = undefined;
      },
    );
    return flight.promise;
  }

  /** Fence current work without releasing its physical reservation early. */
  invalidate(): void {
    this.epoch += 1;
    this.flight?.controller.abort();
  }

  /** Detached read-only durable component for later full-v11 integration. */
  checkpoint(): Readonly<SubtaskRuntimeCheckpoint> {
    // Before first current-authority restoration, expose only a structurally
    // validated detached component, never empty replacement state or raw input.
    if (!this.initialized && this.initial)
      return deepFreeze({
        state: detached(this.initial.state),
        journal: detached(this.initial.journal),
      });
    return deepFreeze({
      state: this.store.checkpoint(),
      journal: detached(this.journal),
    });
  }

  /** Detached read-only generic list view; callers receive no store authority. */
  snapshot(): Readonly<SubtaskSnapshot> {
    return deepFreeze(this.store.snapshot());
  }

  /** Read-only C04 access projection; evidence can neither admit nor report work. */
  accessSnapshot(originalAccessEvidence: unknown): SubtaskAccessSnapshot {
    return this.access.snapshot(originalAccessEvidence);
  }

  /** Clear runtime-only associations without touching durable groups or journal. */
  resetAccess(): void {
    this.access.reset();
  }

  private async runFlight(parentTaskId: string, flight: Flight): Promise<void> {
    const current = this.readCurrent();
    if (!current || !this.initialize(current, flight)) return;
    if (!current.enabled || !this.flightIsCurrent(flight)) return;

    const prepared = this.currentParent(parentTaskId, flight, current.sourceId);
    if (!prepared) return;

    // Accepted admission changes the list binding. Its independent trigger,
    // not old full-group reconstruction, is terminal suppression authority.
    const bare = buildSubtaskGate(this.withoutGroup(prepared));
    if (bare) {
      const confirmed = this.currentParent(
        parentTaskId,
        flight,
        current.sourceId,
      );
      const confirmedBare =
        confirmed && buildSubtaskGate(this.withoutGroup(confirmed));
      if (!confirmedBare || confirmedBare.identity !== bare.identity) return;
      if (this.acceptedSuppressed(parentTaskId, bare, confirmed.group)) return;
    }

    const batch = buildSubtaskGate(prepared.options);
    if (!batch) return;
    const existing = this.journal.records.find((record) =>
      this.recordMatchesBatch(record, batch),
    );
    const phase = existing
      ? nextSubtaskPhase(this.journal, batch.identity)
      : "gate";

    if (phase === "proposal" && existing)
      return this.runProposal(prepared, batch, existing, flight);
    if (phase !== "gate") return;

    return this.runGate(prepared, batch, flight);
  }

  private async runGate(
    prepared: CurrentParent,
    batch: SubtaskGateBatch,
    flight: Flight,
  ): Promise<void> {
    let ticket: Ticket | undefined;
    let dispatched = false;
    let result: ValidatedResult | undefined;
    const physicalDrains: Promise<void>[] = [];

    try {
      result = await this.options.gate(
        batch,
        flight.controller.signal,
        (at) => {
          if (dispatched || !finiteNonNegative(at)) return false;
          const current = this.exactBatch(
            batch,
            prepared.parent.id,
            flight,
            prepared.current.sourceId,
          );
          if (!current || !this.gateMayDispatch(batch)) return false;

          const nextTicket: Ticket = {
            dispatch: this.journal.dispatches + 1,
            at,
          };
          const record = this.gateDispatched(batch, nextTicket);
          const journal = this.chargedJournal(
            "jev",
            record,
            batch.parentTaskId,
          );
          if (!journal || !this.commitCandidate(this.store, journal))
            return false;

          // This proof is durable even when the synchronous save callback
          // fences transport. Keep it locally to prevent a hidden retry.
          this.journal = journal;
          if (
            !this.exactBatch(
              batch,
              prepared.parent.id,
              flight,
              prepared.current.sourceId,
            )
          )
            return false;
          ticket = nextTicket;
          dispatched = true;
          return true;
        },
        (drain) => this.retainPhysicalDrain(physicalDrains, drain),
      );
    } catch {
      // The dispatched receipt remains durable; drain still owns flight release.
    }
    await this.awaitPhysicalDrains(physicalDrains);

    if (!dispatched || !ticket) return;
    const usage = gateUsageOf(result);
    const current = this.exactBatch(
      batch,
      prepared.parent.id,
      flight,
      prepared.current.sourceId,
    );
    if (!current || !result) {
      this.saveGateFailure(
        batch,
        ticket,
        usage,
        flight,
        prepared.current.sourceId,
      );
      return;
    }

    const decision = applySubtaskGate(batch, result, current.options, ticket);
    if (
      !decision ||
      !this.exactBatch(
        batch,
        prepared.parent.id,
        flight,
        prepared.current.sourceId,
      )
    ) {
      this.saveGateFailure(
        batch,
        ticket,
        usage,
        flight,
        prepared.current.sourceId,
      );
      return;
    }

    const journal = this.finalJournal("jev", decision, usage);
    if (!journal || !this.commitCandidate(this.store, journal)) {
      this.saveGateFailure(
        batch,
        ticket,
        usage,
        flight,
        prepared.current.sourceId,
      );
      return;
    }
    if (
      !this.exactBatch(
        batch,
        prepared.parent.id,
        flight,
        prepared.current.sourceId,
      )
    )
      return;
    this.journal = journal;

    if (decision.state === "ready") {
      const next = this.exactBatch(
        batch,
        prepared.parent.id,
        flight,
        prepared.current.sourceId,
      );
      if (next) await this.runProposal(next, batch, decision, flight);
    }
  }

  private async runProposal(
    prepared: CurrentParent,
    batch: SubtaskGateBatch,
    gateRecord: SubtaskPhaseRecord,
    flight: Flight,
  ): Promise<void> {
    const request = buildSubtaskProposal(batch, this.journal, prepared.options);
    if (
      !request ||
      !this.exactBatch(
        batch,
        prepared.parent.id,
        flight,
        prepared.current.sourceId,
      )
    )
      return;

    let ticket: Ticket | undefined;
    let dispatched = false;
    let result: SubtaskProposalTransportResult | undefined;
    const physicalDrains: Promise<void>[] = [];
    try {
      result = await this.options.propose(
        request,
        flight.controller.signal,
        (at) => {
          if (dispatched || !finiteNonNegative(at)) return false;
          const current = this.exactBatch(
            batch,
            prepared.parent.id,
            flight,
            prepared.current.sourceId,
          );
          if (!current || !this.proposalMayDispatch(batch, gateRecord))
            return false;

          const nextTicket: Ticket = {
            dispatch: this.journal.dispatches + 1,
            at,
          };
          const record = this.proposalDispatched(
            gateRecord,
            request,
            nextTicket,
          );
          const journal = this.chargedJournal(
            "extraction",
            record,
            batch.parentTaskId,
          );
          if (!journal || !this.commitCandidate(this.store, journal))
            return false;

          // Charged proof survives a post-save fence; only transport admission
          // is revoked by the renewed identity check.
          this.journal = journal;
          if (
            !this.exactBatch(
              batch,
              prepared.parent.id,
              flight,
              prepared.current.sourceId,
            )
          )
            return false;
          ticket = nextTicket;
          dispatched = true;
          return true;
        },
        (drain) => this.retainPhysicalDrain(physicalDrains, drain),
      );
    } catch {
      // The dispatched receipt remains durable; drain still owns flight release.
    }
    await this.awaitPhysicalDrains(physicalDrains);

    if (!dispatched || !ticket) return;
    const usage = usageOf(result);
    const current = this.exactBatch(
      batch,
      prepared.parent.id,
      flight,
      prepared.current.sourceId,
    );
    if (!current || !this.validProposalResult(result, request, batch)) {
      this.saveProposalFailure(
        gateRecord,
        request,
        ticket,
        usage,
        flight,
        prepared.current.sourceId,
      );
      return;
    }

    const applied = applySubtaskProposal(request, result.text, current.options);
    if (
      !applied ||
      !this.exactBatch(
        batch,
        prepared.parent.id,
        flight,
        prepared.current.sourceId,
      )
    ) {
      this.saveProposalFailure(
        gateRecord,
        request,
        ticket,
        usage,
        flight,
        prepared.current.sourceId,
      );
      return;
    }

    if (applied.status === "noop") {
      const record = this.proposalFinal(gateRecord, request, ticket, "noop");
      const journal = this.finalJournal("extraction", record, usage);
      if (!journal || !this.commitCandidate(this.store, journal)) {
        this.saveProposalFailure(
          gateRecord,
          request,
          ticket,
          usage,
          flight,
          prepared.current.sourceId,
        );
        return;
      }
      if (
        !this.exactBatch(
          batch,
          prepared.parent.id,
          flight,
          prepared.current.sourceId,
        )
      )
        return;
      this.journal = journal;
      return;
    }

    const candidate = this.cloneStore(current.current);
    if (!candidate?.admit(applied.admission).accepted) {
      this.saveProposalFailure(
        gateRecord,
        request,
        ticket,
        usage,
        flight,
        prepared.current.sourceId,
      );
      return;
    }
    const admitted = candidate.resolveAdmission(applied.admission);
    if (!admitted) {
      this.saveProposalFailure(
        gateRecord,
        request,
        ticket,
        usage,
        flight,
        prepared.current.sourceId,
      );
      return;
    }

    const record = this.proposalFinal(
      gateRecord,
      request,
      ticket,
      "accepted",
      admitted.listRevision,
    );
    const journal = this.finalJournal("extraction", record, usage);
    if (!journal || !this.commitCandidate(candidate, journal)) {
      this.saveProposalFailure(
        gateRecord,
        request,
        ticket,
        usage,
        flight,
        prepared.current.sourceId,
      );
      return;
    }
    if (
      !this.exactBatch(
        batch,
        prepared.parent.id,
        flight,
        prepared.current.sourceId,
      )
    )
      return;

    // Save succeeded and currentness survived its callback. Adopt through the
    // stable authoritative store so existing runtime-only links for other
    // groups remain resolvable; never expose a candidate before this point.
    if (!this.store.admit(applied.admission).accepted) return;
    this.journal = journal;
    // `applied` is the original accepted result carrying the private C04 plan.
    // Binding is optional and cannot change durable admission or journal state.
    this.access.bind(applied);
    try {
      this.options.onPublish(this.snapshot());
    } catch {
      // Observers never alter an already durable admission.
    }
  }

  private async runReportFlight(
    parentTaskId: string,
    source: SourceRef | undefined,
    flight: Flight,
  ): Promise<void> {
    const current = this.readReportCurrent();
    if (!current || !this.initialize(current, flight)) return;
    if (
      !current.enabled ||
      !this.flightIsCurrent(flight) ||
      !this.options.report ||
      !this.options.canCommit
    )
      return;

    let ownerSource = source;
    if (!ownerSource) {
      const saved = this.journal.reports.find(
        (report) =>
          report.parentTaskId === parentTaskId &&
          (report.state === "ready" || report.state === "parked"),
      );
      if (!saved) return;
      ownerSource = detached(saved.source);
    }
    const prepared = this.currentReport(
      parentTaskId,
      ownerSource,
      flight,
      current.sourceId,
    );
    if (!prepared) return;

    const full = subtaskReportBatches(prepared.options);
    if (!full.length) return;
    const identity = full[0]?.jobIdentity;
    if (!identity || full.some((batch) => batch.jobIdentity !== identity))
      return;
    const sameIdentity = this.journal.reports.find(
      (report) => report.identity === identity,
    );
    // Superseded ownership is terminal. A later explicit source must bind a
    // distinct current report identity rather than revive old authority.
    if (
      sameIdentity?.state === "superseded" ||
      sameIdentity?.state === "complete"
    )
      return;
    if (
      sameIdentity?.state === "permanent" ||
      sameIdentity?.state === "dispatched" ||
      (sameIdentity?.state === "parked" &&
        !this.reportIsDue(sameIdentity.parkedUntil))
    )
      return;

    const remaining = this.reportRemaining(prepared, sameIdentity);
    if (!remaining.length) return;
    if (this.journal.dispatches >= 1024) {
      if (!sameIdentity)
        this.reportCapacityRefused(
          parentTaskId,
          full[0],
          flight,
          prepared.current.sourceId,
        );
      return;
    }
    const selection = this.selectReportBatch(prepared, remaining, identity);
    if (selection.kind !== "batch") {
      if (selection.kind === "capacity" && !sameIdentity)
        this.reportCapacityRefused(
          parentTaskId,
          full[0],
          flight,
          prepared.current.sourceId,
        );
      return;
    }
    const batch = selection.batch;
    const owner = sameIdentity ?? this.reportJob(batch, prepared);
    if (!owner) return;
    if (
      !this.exactReport(
        batch,
        prepared.parent.id,
        flight,
        prepared.current.sourceId,
      )
    )
      return;
    await this.runReportBatch(prepared, owner, batch, flight);
  }

  private async runReportBatch(
    prepared: CurrentReport,
    owner: SubtaskReportJob,
    batch: SubtaskReportBatch,
    flight: Flight,
  ): Promise<void> {
    if (!this.options.report || !this.options.canCommit) return;
    let ticket: Ticket | undefined;
    let dispatched = false;
    let outcome: SubtaskReportTransportResult | undefined;
    let retryUntil: number | undefined;
    const physicalDrains: Promise<void>[] = [];

    try {
      outcome = await this.options.report(
        batch,
        flight.controller.signal,
        (at) => {
          if (dispatched || !finiteNonNegative(at)) return false;
          const current = this.exactReport(
            batch,
            prepared.parent.id,
            flight,
            prepared.current.sourceId,
          );
          if (!current || !this.reportMayDispatch(owner, batch)) return false;
          const nextTicket = { dispatch: this.journal.dispatches + 1, at };
          const report = this.reportDispatched(owner, batch, nextTicket);
          const journal = this.chargedReportJournal(report);
          if (!journal) return false;
          const admission = this.reportCanCommit(journal, batch);
          if (admission !== "accepted") {
            if (
              admission === "capacity" &&
              !this.journal.reports.some(
                (job) => job.identity === owner.identity,
              )
            )
              this.reportCapacityRefused(
                prepared.parent.id,
                batch,
                flight,
                prepared.current.sourceId,
              );
            return false;
          }
          if (
            !this.exactReport(
              batch,
              prepared.parent.id,
              flight,
              prepared.current.sourceId,
            )
          )
            return false;
          if (!this.commitCandidate(this.store, journal)) return false;
          // Keep charge locally before transport can leave callback.
          this.journal = journal;
          if (
            !this.exactReport(
              batch,
              prepared.parent.id,
              flight,
              prepared.current.sourceId,
            )
          )
            return false;
          ticket = nextTicket;
          dispatched = true;
          return true;
        },
        (drain) => this.retainPhysicalDrain(physicalDrains, drain),
      );
      if (!dispatched && outcome?.kind === "deferred")
        retryUntil = this.reportDeadline(outcome.retryAfterMs);
      if (dispatched && outcome?.kind === "retryable")
        retryUntil = this.reportDeadline(outcome.retryAfterMs);
    } catch {
      // A transport throw before ticket costs nothing; after ticket it is final.
    }
    await this.awaitPhysicalDrains(physicalDrains);

    if (!ticket) {
      if (retryUntil === undefined) return;
      const parked = this.reportParked(owner, retryUntil);
      const journal = this.parkedReportJournal(parked);
      if (
        journal &&
        this.exactReport(
          batch,
          prepared.parent.id,
          flight,
          prepared.current.sourceId,
        ) &&
        this.commitCandidate(this.store, journal)
      )
        this.journal = journal;
      return;
    }

    if (outcome?.kind === "result") {
      const current = this.exactReport(
        batch,
        prepared.parent.id,
        flight,
        prepared.current.sourceId,
      );
      const decisions = current
        ? subtaskReportDecisions(batch, outcome.result, current.options)
        : undefined;
      const receipt = decisions?.receipt;
      if (decisions && receipt && current) {
        const completeDecisions: ReportDecisionsWithReceipt = {
          ...decisions,
          receipt,
        };
        const candidate = this.cloneStore(current.current);
        if (candidate) {
          const accepted = completeDecisions.reports.every(
            (report) => candidate.report(report).accepted,
          );
          const report = accepted
            ? this.reportDecided(owner.identity, ticket, completeDecisions)
            : undefined;
          const journal = report
            ? this.finalReportJournal(report, completeDecisions.receipt.usage)
            : undefined;
          if (
            journal &&
            this.commitCandidate(candidate, journal) &&
            this.exactReport(
              batch,
              prepared.parent.id,
              flight,
              prepared.current.sourceId,
            )
          ) {
            for (const decision of completeDecisions.reports)
              if (!this.store.report(decision).accepted) return;
            this.journal = journal;
            try {
              this.options.onPublish(this.snapshot());
            } catch {
              // Publication cannot undo durable report status.
            }
            return;
          }
        }
      }
    } else if (outcome?.kind === "retryable" && retryUntil !== undefined) {
      const parked = this.reportRetry(owner.identity, ticket, retryUntil);
      const journal = parked && this.replaceReport(parked);
      if (
        journal &&
        this.maySaveLateUsage(flight, prepared.current.sourceId, true) &&
        this.commitCandidate(this.store, journal) &&
        this.maySaveLateUsage(flight, prepared.current.sourceId, true)
      ) {
        this.journal = journal;
        return;
      }
    }
    this.saveReportFailure(
      owner.identity,
      ticket,
      flight,
      prepared.current.sourceId,
      outcome?.kind === "result" ? gateUsageOf(outcome.result) : undefined,
    );
  }

  private currentReport(
    parentTaskId: string,
    source: SourceRef,
    flight: Flight,
    expectedSourceId: string,
  ): CurrentReport | undefined {
    if (!this.flightIsCurrent(flight) || this.sourceFenced) return;
    const current = this.readReportCurrent();
    if (
      !current ||
      current.sourceId !== expectedSourceId ||
      current.sourceId !== this.sourceId
    ) {
      this.sourceFenced = true;
      this.epoch += 1;
      flight.controller.abort();
      return;
    }
    if (
      !current.enabled ||
      !this.reconcile(current) ||
      !this.sourceIsCurrent(current, source)
    )
      return;
    const parent = current.parents.find(
      (candidate) => candidate.id === parentTaskId,
    );
    if (!parent?.included) return;
    const group = this.store
      .snapshot()
      .groups.find(
        (candidate) =>
          candidate.parentTaskId === parent.id &&
          candidate.parentRevision === parent.revision,
      );
    if (!group) return;
    let report: Observation | undefined;
    try {
      report = current.resolve(source.entryId);
    } catch {
      return;
    }
    if (!report) return;
    return {
      current,
      parent,
      group,
      report,
      options: { parent, group, report, resolve: current.resolve },
    };
  }

  private exactReport(
    batch: SubtaskReportBatch,
    parentTaskId: string,
    flight: Flight,
    sourceId: string,
  ): CurrentReport | undefined {
    const current = this.currentReport(
      parentTaskId,
      batch.source,
      flight,
      sourceId,
    );
    if (!current) return;
    const rebuilt = subtaskReportBatches(current.options, {
      childIds: batch.childIds,
      maxQuestions: batch.childIds.length,
    });
    return rebuilt.length === 1 &&
      rebuilt[0]?.identity === batch.identity &&
      rebuilt[0].jobIdentity === batch.jobIdentity
      ? current
      : undefined;
  }

  private reportRemaining(
    prepared: CurrentReport,
    job: SubtaskReportJob | undefined,
  ): string[] {
    const roster = prepared.group.children.map((child) => child.id);
    if (!job) return roster;
    const source = this.reportJobSource(prepared);
    if (
      !source ||
      job.parentTaskId !== prepared.parent.id ||
      job.parentRevision !== prepared.parent.revision ||
      job.groupId !== prepared.group.id ||
      job.listRevision !== prepared.group.listRevision ||
      !sameSource(job.source, source) ||
      job.childIds.length !== roster.length ||
      job.childIds.some((childId, index) => childId !== roster[index])
    )
      return [];
    const decided = new Set<string>();
    for (const attempt of job.attempts)
      if (attempt.outcome === "decided")
        for (const assessment of attempt.assessments ?? [])
          decided.add(assessment.childId);
    return roster.filter((childId) => !decided.has(childId));
  }

  private selectReportBatch(
    prepared: CurrentReport,
    remaining: readonly string[],
    identity: string,
  ): ReportBatchSelection {
    const limit = Math.min(20, remaining.length);
    let measuredCapacity = false;
    let unavailable = false;
    for (let size = limit; size >= 1; size -= 1) {
      const batches = subtaskReportBatches(prepared.options, {
        childIds: remaining.slice(0, size),
        maxQuestions: size,
      });
      // Wire-size splitting is normal prefix selection, not unavailable authority.
      if (batches.length > 1) continue;
      const batch = batches.length === 1 ? batches[0] : undefined;
      if (!batch || batch.jobIdentity !== identity) {
        unavailable = true;
        continue;
      }
      const owner = this.journal.reports.find(
        (report) => report.identity === identity,
      );
      const report = owner ?? this.reportJob(batch, prepared);
      if (!report) {
        unavailable = true;
        continue;
      }
      const ticket = {
        dispatch: this.journal.dispatches + 1,
        at: this.reportNow(),
      };
      const journal = this.chargedReportJournal(
        this.reportDispatched(report, batch, ticket),
      );
      if (!journal) {
        unavailable = true;
        continue;
      }
      const admission = this.reportCanCommit(journal, batch);
      if (admission === "accepted") return { kind: "batch", batch };
      if (admission === "capacity") measuredCapacity = true;
      else unavailable = true;
    }
    return measuredCapacity && !unavailable
      ? { kind: "capacity" }
      : { kind: "unavailable" };
  }

  /** Revalidate exact report authority before passing measured capacity to Monitor. */
  private reportCapacityRefused(
    parentTaskId: string,
    batch: SubtaskReportBatch,
    flight: Flight,
    sourceId: string,
  ) {
    const current = this.exactReport(batch, parentTaskId, flight, sourceId);
    if (!current) return;
    try {
      this.options.onReportCapacityRefusal?.({
        sourceId: current.current.sourceId,
        parent: detached(current.parent),
        group: detached(current.group),
        source: detached(batch.source),
      });
    } catch {
      // Capacity reporting cannot alter dispatch, journal, or runtime authority.
    }
  }

  private reportJob(
    batch: SubtaskReportBatch,
    prepared: CurrentReport,
  ): SubtaskReportJob | undefined {
    const source = this.reportJobSource(prepared);
    if (!source) return;
    return {
      identity: batch.jobIdentity,
      parentTaskId: batch.parentTaskId,
      parentRevision: batch.parentRevision,
      parentSourceDigest: batch.parentSourceDigest,
      groupId: batch.groupId,
      listRevision: batch.listRevision,
      source,
      model: batch.request.model,
      childIds: prepared.group.children.map((child) => child.id),
      state: "ready",
      attempts: [],
    };
  }

  private reportJobSource(prepared: CurrentReport): SourceRef | undefined {
    const first = subtaskReportBatches(prepared.options, {
      childIds: prepared.group.children.slice(0, 1).map((child) => child.id),
      maxQuestions: 1,
    })[0];
    return first ? detached(first.source) : undefined;
  }

  private reportMayDispatch(
    owner: SubtaskReportJob,
    batch: SubtaskReportBatch,
  ): boolean {
    if (this.journal.dispatches >= 1024) return false;
    const current = this.journal.reports.find(
      (report) => report.identity === owner.identity,
    );
    return (
      current === undefined ||
      (current.state === "ready" &&
        current.attempts.every(
          (attempt) => attempt.identity !== batch.identity,
        )) ||
      (current.state === "parked" &&
        this.reportIsDue(current.parkedUntil) &&
        (current.attempts.length === 0 ||
          current.attempts.at(-1)?.outcome === "retryable"))
    );
  }

  private reportIsDue(until: number | undefined): boolean {
    return until !== undefined && this.reportNow() >= until;
  }

  private reportNow(): number {
    try {
      const value = this.options.now?.() ?? Date.now();
      return finiteNonNegative(value) ? value : Number.NaN;
    } catch {
      return Number.NaN;
    }
  }

  private reportDeadline(retryAfterMs: unknown): number | undefined {
    const now = this.reportNow();
    if (
      !finiteNonNegative(retryAfterMs) ||
      retryAfterMs <= 0 ||
      !finiteNonNegative(now)
    )
      return;
    const deadline = now + Math.ceil(retryAfterMs);
    return Number.isSafeInteger(deadline) ? deadline : undefined;
  }

  private reportCanCommit(
    journal: SubtaskJournalCheckpoint,
    batch?: SubtaskReportBatch,
  ): ReportCommitAdmission {
    if (!this.options.canCommit) return "unavailable";
    const candidate = this.candidateCheckpoint(this.store, journal);
    if (!candidate) return "unavailable";
    const serializedSource = batch && ownDataJson(batch.source);
    if (batch && !serializedSource) return "unavailable";
    // Preserve prior 3-byte-per-code-unit worst-case reserve without invoking
    // ambient `toJSON`; source refs are part of every final store receipt.
    const sourceBytes = serializedSource
      ? serializedSource.json.length * 3
      : 1024;
    const children = batch?.childIds.length ?? 1;
    const reserve = {
      storeBytes: (sourceBytes + 512) * children + 2048,
      journalBytes: (sourceBytes + 256) * children + 2048,
    };
    try {
      const admitted = this.options.canCommit(candidate, reserve);
      return admitted === true
        ? "accepted"
        : admitted === "capacity"
          ? "capacity"
          : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  private initialize(current: SubtaskRuntimeCurrent, flight: Flight): boolean {
    if (this.sourceFenced || this.initializationBlocked) return false;
    if (this.initialized) {
      if (this.sourceId === current.sourceId) return true;
      this.sourceFenced = true;
      this.epoch += 1;
      flight.controller.abort();
      return false;
    }
    if (
      !this.initial ||
      !subtaskCheckpointIsValid(this.initial.state) ||
      !subtaskJournalIsValid(this.initial.journal)
    ) {
      this.initializationBlocked = true;
      return false;
    }

    const rawJournal = pruneIncoherentAcceptedSubtaskRecords(
      this.initial.journal,
      this.initial.state.groups,
    );
    if (!rawJournal) {
      this.initializationBlocked = true;
      return false;
    }
    const store = SubtaskStore.restore(this.initial.state, {
      parents: current.parents,
      sourceCurrent: (source) => this.sourceIsCurrent(current, source),
    });
    if (!store) return false;
    const journal = restoreSubtaskJournal(
      rawJournal,
      (record) => this.restoredRecordIsCurrent(record, current, store),
      (report) => this.restoredReportIsCurrent(report, current, store),
    );
    if (!journal) {
      this.initializationBlocked = true;
      return false;
    }

    this.store = store;
    // Reload obtains no original proposal capability, so it starts unlinked.
    this.access = new SubtaskAccess(store);
    this.journal = journal;
    this.sourceId = current.sourceId;
    this.initialized = true;
    return this.flightIsCurrent(flight);
  }

  private readCurrent(): SubtaskRuntimeCurrent | undefined {
    return this.readCurrentFrom(this.options.current);
  }

  private readReportCurrent(): SubtaskRuntimeCurrent | undefined {
    return this.readCurrentFrom(
      this.options.reportCurrent ?? this.options.current,
    );
  }

  private readCurrentFrom(
    read: () => SubtaskRuntimeCurrent | undefined,
  ): SubtaskRuntimeCurrent | undefined {
    try {
      const current = read();
      if (
        !current ||
        typeof current.sourceId !== "string" ||
        !current.sourceId ||
        typeof current.enabled !== "boolean" ||
        !Array.isArray(current.parents) ||
        !Array.isArray(current.earlier) ||
        !Array.isArray(current.omissions) ||
        typeof current.resolve !== "function" ||
        !current.latest
      )
        return;
      if (
        current.selectedModel !== undefined &&
        typeof current.selectedModel !== "string"
      )
        return;
      return current;
    } catch {
      return;
    }
  }

  private currentParent(
    parentTaskId: string,
    flight: Flight,
    expectedSourceId: string,
  ): CurrentParent | undefined {
    if (!this.flightIsCurrent(flight) || this.sourceFenced) return;
    const current = this.readCurrent();
    if (!current) return;
    if (
      current.sourceId !== expectedSourceId ||
      current.sourceId !== this.sourceId
    ) {
      this.sourceFenced = true;
      this.epoch += 1;
      flight.controller.abort();
      return;
    }
    if (!current.enabled || !this.reconcile(current)) return;
    return this.parentFrom(parentTaskId, current, this.store);
  }

  private parentFrom(
    parentTaskId: string,
    current: SubtaskRuntimeCurrent,
    store: SubtaskStore,
  ): CurrentParent | undefined {
    if (!this.parentsAreAuthoritative(current)) return;
    store.reconcile(current.parents);
    const parent = current.parents.find(
      (candidate) => candidate.id === parentTaskId,
    );
    if (!parent?.included || typeof current.selectedModel !== "string") return;
    const group = store
      .snapshot()
      .groups.find(
        (candidate) =>
          candidate.parentTaskId === parent.id &&
          candidate.parentRevision === parent.revision,
      );
    const options: SubtaskGateOptions = {
      parent,
      ...(group === undefined ? {} : { group }),
      latest: current.latest,
      earlier: current.earlier,
      omissions: current.omissions,
      selectedModel: current.selectedModel,
      resolve: current.resolve,
      ...(current.evidence === undefined ? {} : { evidence: current.evidence }),
    };
    return {
      current,
      parent,
      ...(group === undefined ? {} : { group }),
      options,
    };
  }

  private reconcile(current: SubtaskRuntimeCurrent): boolean {
    if (!this.parentsAreAuthoritative(current)) return false;
    this.store.reconcile(current.parents);
    return true;
  }

  private parentsAreAuthoritative(current: SubtaskRuntimeCurrent): boolean {
    try {
      return (
        SubtaskStore.restore(new SubtaskStore().checkpoint(), {
          parents: current.parents,
          sourceCurrent: () => true,
        }) !== undefined
      );
    } catch {
      return false;
    }
  }

  private withoutGroup(prepared: CurrentParent): SubtaskGateOptions {
    return withoutGroup(prepared.options);
  }

  private exactBatch(
    batch: SubtaskGateBatch,
    parentTaskId: string,
    flight: Flight,
    sourceId: string,
  ): CurrentParent | undefined {
    const current = this.currentParent(parentTaskId, flight, sourceId);
    if (!current) return;
    const rebuilt = buildSubtaskGate(current.options);
    return rebuilt && rebuilt.identity === batch.identity ? current : undefined;
  }

  private restoredRecordIsCurrent(
    record: SubtaskPhaseRecord,
    current: SubtaskRuntimeCurrent,
    store: SubtaskStore,
  ): boolean {
    const group = store
      .snapshot()
      .groups.find(
        (candidate) =>
          candidate.parentTaskId === record.parentTaskId &&
          candidate.parentRevision === record.parentRevision,
      );
    return subtaskRuntimeRecordIsCurrent(record, current, {
      state: { tasks: [...current.parents] },
      ...(group === undefined ? {} : { group }),
    });
  }

  private restoredReportIsCurrent(
    report: SubtaskReportJob,
    current: SubtaskRuntimeCurrent,
    store: SubtaskStore,
  ): boolean {
    const group = store
      .snapshot()
      .groups.find(
        (candidate) =>
          candidate.id === report.groupId &&
          candidate.parentTaskId === report.parentTaskId &&
          candidate.parentRevision === report.parentRevision,
      );
    return subtaskRuntimeReportIsCurrent(report, current, {
      state: { tasks: [...current.parents] },
      ...(group === undefined ? {} : { group }),
    });
  }

  private acceptedSuppressed(
    parentTaskId: string,
    bare: SubtaskGateBatch,
    group: SubtaskSnapshot["groups"][number] | undefined,
  ): boolean {
    return this.journal.records.some(
      (record) =>
        record.parentTaskId === parentTaskId &&
        this.recordSuppressesAccepted(record, bare, group),
    );
  }

  private recordSuppressesAccepted(
    record: SubtaskPhaseRecord,
    bare: SubtaskGateBatch,
    group: SubtaskSnapshot["groups"][number] | undefined,
  ): boolean {
    return recordSuppressesAccepted(record, bare, group);
  }

  private recordMatchesBatch(
    record: SubtaskPhaseRecord,
    batch: SubtaskGateBatch,
  ): boolean {
    return recordMatchesBatch(record, batch);
  }

  private gateMayDispatch(batch: SubtaskGateBatch): boolean {
    if (this.journal.dispatches >= 1024) return false;
    const record = this.journal.records.find(
      (candidate) => candidate.identity === batch.identity,
    );
    return (
      record === undefined ||
      (record.phase === "gate-ready" &&
        record.state === "ready" &&
        record.gate === undefined &&
        record.proposal === undefined)
    );
  }

  private proposalMayDispatch(
    batch: SubtaskGateBatch,
    gateRecord: SubtaskPhaseRecord,
  ): boolean {
    if (this.journal.dispatches >= 1024) return false;
    const record = this.journal.records.find(
      (candidate) => candidate.identity === batch.identity,
    );
    return (
      record !== undefined &&
      record.phase === "gate-decided" &&
      record.state === "ready" &&
      record.proposal === undefined &&
      record.gate?.outcome === "decided" &&
      record.gate.requestHash === gateRecord.gate?.requestHash
    );
  }

  private gateDispatched(
    batch: SubtaskGateBatch,
    ticket: Ticket,
  ): SubtaskPhaseRecord {
    return {
      identity: batch.identity,
      parentTaskId: batch.parentTaskId,
      parentRevision: batch.parentRevision,
      parentSourceDigest: batch.parentSourceDigest,
      listRevision: batch.listRevision,
      source: detached(batch.source),
      contextHash: batch.contextHash,
      triggerHash: batch.triggerHash,
      gateModel: batch.gateModel,
      selectedModel: batch.selectedModel,
      phase: "gate-ready",
      state: "dispatched",
      gate: {
        requestHash: batch.requestHash,
        dispatch: ticket.dispatch,
        at: ticket.at,
        outcome: "dispatched",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    };
  }

  private proposalDispatched(
    gateRecord: SubtaskPhaseRecord,
    request: SubtaskProposalRequest,
    ticket: Ticket,
  ): SubtaskPhaseRecord {
    return {
      ...detached(gateRecord),
      phase: "gate-decided",
      state: "dispatched",
      proposal: {
        requestHash: request.requestHash,
        dispatch: ticket.dispatch,
        at: ticket.at,
        outcome: "dispatched",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    };
  }

  private proposalFinal(
    gateRecord: SubtaskPhaseRecord,
    request: SubtaskProposalRequest,
    ticket: Ticket,
    outcome: "accepted" | "noop",
    listRevision?: number,
  ): SubtaskPhaseRecord {
    return {
      ...detached(gateRecord),
      phase: "proposal-decided",
      state: "complete",
      proposal: {
        requestHash: request.requestHash,
        dispatch: ticket.dispatch,
        at: ticket.at,
        outcome,
        ...(outcome === "accepted" ? { listRevision } : {}),
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    } as SubtaskPhaseRecord;
  }

  private gateFailure(
    batch: SubtaskGateBatch,
    ticket: Ticket,
  ): SubtaskPhaseRecord {
    return {
      ...this.gateDispatched(batch, ticket),
      state: "permanent",
      gate: {
        requestHash: batch.requestHash,
        dispatch: ticket.dispatch,
        at: ticket.at,
        outcome: "failed",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    };
  }

  private proposalFailure(
    gateRecord: SubtaskPhaseRecord,
    request: SubtaskProposalRequest,
    ticket: Ticket,
  ): SubtaskPhaseRecord {
    return {
      ...detached(gateRecord),
      phase: "gate-decided",
      state: "permanent",
      proposal: {
        requestHash: request.requestHash,
        dispatch: ticket.dispatch,
        at: ticket.at,
        outcome: "failed",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    };
  }

  private reportDispatched(
    owner: SubtaskReportJob,
    batch: SubtaskReportBatch,
    ticket: Ticket,
  ): SubtaskReportJob {
    const { parkedUntil: _parkedUntil, ...bare } = detached(owner);
    return {
      ...bare,
      source: detached(batch.source),
      state: "dispatched",
      attempts: [
        ...copyReportAttempts(owner.attempts),
        {
          identity: batch.identity,
          requestHash: batch.requestHash,
          childIds: [...batch.childIds],
          dispatch: ticket.dispatch,
          at: ticket.at,
          outcome: "dispatched",
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      ],
    };
  }

  private reportParked(
    owner: SubtaskReportJob,
    parkedUntil: number,
  ): SubtaskReportJob {
    return {
      ...detached(owner),
      state: "parked",
      parkedUntil,
      attempts: copyReportAttempts(owner.attempts),
    };
  }

  private reportRetry(
    identity: string,
    ticket: Ticket,
    parkedUntil: number,
  ): SubtaskReportJob | undefined {
    const current = this.journal.reports.find(
      (report) => report.identity === identity,
    );
    const latest = current?.attempts.at(-1);
    if (
      current?.state !== "dispatched" ||
      latest?.dispatch !== ticket.dispatch ||
      latest.at !== ticket.at ||
      latest.outcome !== "dispatched"
    )
      return;
    const attempts = copyReportAttempts(current.attempts);
    const last = attempts.at(-1);
    if (!last) return;
    last.outcome = "retryable";
    return { ...detached(current), state: "parked", parkedUntil, attempts };
  }

  private reportDecided(
    identity: string,
    ticket: Ticket,
    decisions: ReportDecisionsWithReceipt,
  ): SubtaskReportJob | undefined {
    const current = this.journal.reports.find(
      (report) => report.identity === identity,
    );
    const latest = current?.attempts.at(-1);
    if (
      current?.state !== "dispatched" ||
      latest?.dispatch !== ticket.dispatch ||
      latest.at !== ticket.at ||
      latest.outcome !== "dispatched"
    )
      return;
    const attempts = copyReportAttempts(current.attempts);
    const last = attempts.at(-1);
    if (!last) return;
    last.outcome = "decided";
    last.usage = { ...decisions.receipt.usage };
    last.assessments = structuredClone(decisions.receipt.assessments);
    const assessed = new Set<string>();
    for (const attempt of attempts)
      if (attempt.outcome === "decided")
        for (const assessment of attempt.assessments ?? [])
          assessed.add(assessment.childId);
    return {
      ...detached(current),
      state: current.childIds.every((childId) => assessed.has(childId))
        ? "complete"
        : "ready",
      attempts,
    };
  }

  private reportFailure(
    identity: string,
    ticket: Ticket,
    usage: Usage | undefined,
  ): SubtaskReportJob | undefined {
    const current = this.journal.reports.find(
      (report) => report.identity === identity,
    );
    const latest = current?.attempts.at(-1);
    if (
      !current ||
      latest?.dispatch !== ticket.dispatch ||
      latest.at !== ticket.at ||
      latest.outcome !== "dispatched"
    )
      return;
    const attempts = copyReportAttempts(current.attempts);
    const last = attempts.at(-1);
    if (!last) return;
    last.outcome = "failed";
    last.usage = usage ? { ...usage } : { inputTokens: 0, outputTokens: 0 };
    return { ...detached(current), state: "permanent", attempts };
  }

  private chargedReportJournal(
    report: SubtaskReportJob,
  ): SubtaskJournalCheckpoint | undefined {
    if (this.journal.dispatches >= 1024) return;
    const journal = this.replaceReport(report);
    if (
      !this.retireRecords(
        journal,
        (record) =>
          record.parentTaskId === report.parentTaskId &&
          record.state !== "complete" &&
          record.state !== "superseded",
      ) ||
      !this.retireReports(
        journal,
        (current) =>
          current.identity !== report.identity &&
          current.parentTaskId === report.parentTaskId &&
          current.state !== "complete" &&
          current.state !== "superseded",
      )
    )
      return;
    journal.dispatches += 1;
    journal.usage.jev.calls += 1;
    return subtaskJournalIsValid(journal) ? journal : undefined;
  }

  private parkedReportJournal(
    report: SubtaskReportJob,
  ): SubtaskJournalCheckpoint | undefined {
    const journal = this.replaceReport(report);
    if (
      !this.retireRecords(
        journal,
        (record) =>
          record.parentTaskId === report.parentTaskId &&
          record.state !== "complete" &&
          record.state !== "superseded",
      ) ||
      !this.retireReports(
        journal,
        (current) =>
          current.identity !== report.identity &&
          current.parentTaskId === report.parentTaskId &&
          current.state !== "complete" &&
          current.state !== "superseded",
      )
    )
      return;
    return subtaskJournalIsValid(journal) ? journal : undefined;
  }

  private finalReportJournal(
    report: SubtaskReportJob,
    usage: Usage,
  ): SubtaskJournalCheckpoint | undefined {
    const journal = this.replaceReport(report);
    journal.usage.jev.inputTokens += usage.inputTokens;
    journal.usage.jev.outputTokens += usage.outputTokens;
    if (
      !Number.isSafeInteger(journal.usage.jev.inputTokens) ||
      !Number.isSafeInteger(journal.usage.jev.outputTokens)
    )
      return;
    return subtaskJournalIsValid(journal) ? journal : undefined;
  }

  private saveReportFailure(
    identity: string,
    ticket: Ticket,
    flight: Flight,
    sourceId: string,
    usage?: Usage,
  ): void {
    if (!this.maySaveLateUsage(flight, sourceId, true)) return;
    const report = this.reportFailure(identity, ticket, usage);
    const journal =
      report &&
      this.finalReportJournal(
        report,
        usage ?? {
          inputTokens: 0,
          outputTokens: 0,
        },
      );
    if (
      journal &&
      this.commitCandidate(this.store, journal) &&
      this.maySaveLateUsage(flight, sourceId, true)
    )
      this.journal = journal;
  }

  private chargedJournal(
    bucket: UsageBucket,
    record: SubtaskPhaseRecord,
    retireParentTaskId?: string,
  ): SubtaskJournalCheckpoint | undefined {
    if (this.journal.dispatches >= 1024) return;
    const journal = this.replaceRecord(record);
    if (
      retireParentTaskId &&
      (!this.retireRecords(
        journal,
        (current) =>
          current.identity !== record.identity &&
          current.parentTaskId === retireParentTaskId &&
          current.state !== "complete" &&
          current.state !== "superseded",
      ) ||
        !this.retireReports(
          journal,
          (current) =>
            current.parentTaskId === retireParentTaskId &&
            current.state !== "complete" &&
            current.state !== "superseded",
        ))
    )
      return;
    journal.dispatches += 1;
    journal.usage[bucket].calls += 1;
    return subtaskJournalIsValid(journal) ? journal : undefined;
  }

  private finalJournal(
    bucket: UsageBucket,
    record: SubtaskPhaseRecord,
    usage: Usage | undefined,
  ): SubtaskJournalCheckpoint | undefined {
    if (!usage) return;
    const journal = this.replaceRecord(record);
    journal.usage[bucket].inputTokens += usage.inputTokens;
    journal.usage[bucket].outputTokens += usage.outputTokens;
    if (!Number.isSafeInteger(journal.usage[bucket].inputTokens)) return;
    if (!Number.isSafeInteger(journal.usage[bucket].outputTokens)) return;
    const stored = journal.records.find(
      (candidate) => candidate.identity === record.identity,
    );
    const receipt = bucket === "jev" ? stored?.gate : stored?.proposal;
    if (!receipt) return;
    receipt.usage = { ...usage };
    return subtaskJournalIsValid(journal) ? journal : undefined;
  }

  private replaceRecord(record: SubtaskPhaseRecord): SubtaskJournalCheckpoint {
    const journal = detached(this.journal);
    journal.reports = journal.reports.map((report) => ({
      ...report,
      source: { ...report.source },
      childIds: [...report.childIds],
      attempts: copyReportAttempts(report.attempts),
    }));
    const index = journal.records.findIndex(
      (candidate) => candidate.identity === record.identity,
    );
    if (index < 0) journal.records.push(detached(record));
    else journal.records[index] = detached(record);
    return journal;
  }

  private replaceReport(report: SubtaskReportJob): SubtaskJournalCheckpoint {
    const journal = detached(this.journal);
    journal.records = journal.records.map((record) => detached(record));
    journal.reports = journal.reports.map((current) => ({
      ...current,
      source: { ...current.source },
      childIds: [...current.childIds],
      attempts: copyReportAttempts(current.attempts),
    }));
    const index = journal.reports.findIndex(
      (current) => current.identity === report.identity,
    );
    if (index < 0) journal.reports.push(detached(report));
    else journal.reports[index] = detached(report);
    return journal;
  }

  /** Stage all history retirement before replacing a commit candidate journal. */
  private retireRecords(
    journal: SubtaskJournalCheckpoint,
    shouldRetire: (record: SubtaskPhaseRecord) => boolean,
  ): boolean {
    const records: SubtaskPhaseRecord[] = [];
    for (const current of journal.records) {
      if (!shouldRetire(current)) {
        records.push(current);
        continue;
      }
      const superseded = supersedeSubtaskRecord(current);
      if (!superseded) return false;
      records.push(superseded);
    }
    journal.records = records;
    return true;
  }

  private retireReports(
    journal: SubtaskJournalCheckpoint,
    shouldRetire: (report: SubtaskReportJob) => boolean,
  ): boolean {
    const reports: SubtaskReportJob[] = [];
    for (const current of journal.reports) {
      if (!shouldRetire(current)) {
        reports.push(current);
        continue;
      }
      const superseded = supersedeSubtaskReportJob(current);
      if (!superseded) return false;
      reports.push(superseded);
    }
    journal.reports = reports;
    return true;
  }

  /** Observed drains carry no provider data and never reject into scheduling. */
  private retainPhysicalDrain(drains: Promise<void>[], drain: Promise<void>) {
    try {
      drains.push(Promise.resolve(drain).catch(() => undefined));
    } catch {
      // Ignore a transport observer contract violation.
    }
  }

  private async awaitPhysicalDrains(drains: readonly Promise<void>[]) {
    await Promise.all(drains);
  }

  private candidateCheckpoint(
    store: SubtaskStore,
    journal: SubtaskJournalCheckpoint,
  ): Readonly<SubtaskRuntimeCheckpoint> | undefined {
    let state: SubtaskCheckpoint;
    try {
      state = store.checkpoint();
      if (
        !this.retireRecords(
          journal,
          (record) =>
            record.state !== "superseded" &&
            record.proposal?.outcome === "accepted" &&
            !acceptedSubtaskRecordMatchesGroup(record, state.groups),
        )
      )
        return;
    } catch {
      return;
    }
    if (!subtaskJournalIsValid(journal)) return;
    return deepFreeze({ state, journal: detached(journal) });
  }

  private commitCandidate(
    store: SubtaskStore,
    journal: SubtaskJournalCheckpoint,
  ): boolean {
    const candidate = this.candidateCheckpoint(store, journal);
    if (!candidate) return false;
    try {
      return this.options.commit(candidate) === true;
    } catch {
      return false;
    }
  }

  private saveGateFailure(
    batch: SubtaskGateBatch,
    ticket: Ticket,
    usage: Usage | undefined,
    flight: Flight,
    sourceId: string,
  ): void {
    if (!this.maySaveLateUsage(flight, sourceId)) return;
    const journal = this.finalJournal(
      "jev",
      this.gateFailure(batch, ticket),
      usage,
    );
    if (
      journal &&
      this.commitCandidate(this.store, journal) &&
      this.maySaveLateUsage(flight, sourceId)
    )
      this.journal = journal;
  }

  private saveProposalFailure(
    gateRecord: SubtaskPhaseRecord,
    request: SubtaskProposalRequest,
    ticket: Ticket,
    usage: Usage | undefined,
    flight: Flight,
    sourceId: string,
  ): void {
    if (!this.maySaveLateUsage(flight, sourceId)) return;
    const journal = this.finalJournal(
      "extraction",
      this.proposalFailure(gateRecord, request, ticket),
      usage,
    );
    if (
      journal &&
      this.commitCandidate(this.store, journal) &&
      this.maySaveLateUsage(flight, sourceId)
    )
      this.journal = journal;
  }

  private maySaveLateUsage(
    flight: Flight,
    sourceId: string,
    report = false,
  ): boolean {
    if (!this.flightIsCurrent(flight) || this.sourceFenced) return false;
    const current = report ? this.readReportCurrent() : this.readCurrent();
    if (!current || current.sourceId !== sourceId) return false;
    return true;
  }

  private validProposalResult(
    value: unknown,
    request: SubtaskProposalRequest,
    batch: SubtaskGateBatch,
  ): value is SubtaskProposalTransportResult {
    if (!plainRecord(value) || !usageOf(value)) return false;
    const provider = fieldValue(value, "provider");
    const model = fieldValue(value, "model");
    return (
      typeof fieldValue(value, "text") === "string" &&
      typeof provider === "string" &&
      typeof model === "string" &&
      fieldValue(value, "requestHash") === request.requestHash &&
      `${provider}/${model}` === batch.selectedModel
    );
  }

  private cloneStore(current: SubtaskRuntimeCurrent): SubtaskStore | undefined {
    try {
      // Current store was already validated internally. Preserve immutable old
      // provenance while rebuilding only current parent authority for admission.
      return SubtaskStore.restore(this.store.checkpoint(), {
        parents: current.parents,
        sourceCurrent: () => true,
      });
    } catch {
      return;
    }
  }

  private sourceIsCurrent(
    current: SubtaskRuntimeCurrent,
    source: SourceRef,
  ): boolean {
    try {
      const observation = current.resolve(source.entryId);
      return (
        !!observation &&
        observation.id === source.entryId &&
        observation.hash === source.messageHash &&
        observation.role === source.role &&
        typeof observation.text === "string" &&
        Number.isSafeInteger(source.start) &&
        Number.isSafeInteger(source.end) &&
        source.start >= 0 &&
        source.end > source.start &&
        source.end <= observation.text.length &&
        hash(observation.text) === observation.hash &&
        hash(observation.text.slice(source.start, source.end)) ===
          source.quoteHash
      );
    } catch {
      return false;
    }
  }

  private flightIsCurrent(flight: Flight): boolean {
    return (
      this.flight === flight &&
      this.epoch === flight.epoch &&
      !flight.controller.signal.aborted
    );
  }
}
