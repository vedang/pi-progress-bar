import { sameSource } from "../shared/guards";
import {
  acceptedSubtaskRecordMatchesGroup,
  type SubtaskJournalCheckpoint,
  type SubtaskPhaseRecord,
  type SubtaskReportAttempt,
  type SubtaskReportJob,
  subtaskJournalIsValid,
  supersedeSubtaskRecord,
  supersedeSubtaskReportJob,
} from "./subtask-journal";
import type { SubtaskRuntimeCheckpoint } from "./subtask-runtime";
import { type SubtaskCheckpoint, subtaskCheckpointIsValid } from "./subtasks";

const MAX_COMPONENT_BYTES = 64 * 1024;
const MAX_HISTORY_OWNERS = 200;
const MAX_RECEIPTS = 200;

type RefusalReason =
  | "invalid-history"
  | "accounting-conflict"
  | "proof-conflict"
  | "owner-conflict"
  | "capacity";

type RestoreHistoryResult =
  | { kind: "merged"; component: SubtaskRuntimeCheckpoint }
  | { kind: "refused"; reason: RefusalReason };

type HistoryOwner =
  | { kind: "record"; value: SubtaskPhaseRecord }
  | { kind: "report"; value: SubtaskReportJob };

type RuntimeData = {
  state: SubtaskCheckpoint;
  journal: SubtaskJournalCheckpoint;
};

type WalletOwner = "live" | "incoming";

const refused = (reason: RefusalReason): RestoreHistoryResult => ({
  kind: "refused",
  reason,
});

/** Reject accessors and inherited/extra fields before any value is read. */
const plainOwnData = (value: unknown): value is Record<string, unknown> => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => "value" in descriptor && descriptor.enumerable,
  );
};

const exactOwnKeys = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> =>
  plainOwnData(value) &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key)) &&
  Reflect.ownKeys(value).every(
    (key) => typeof key === "string" && keys.includes(key),
  );

const ownValue = (value: Record<string, unknown>, key: string) =>
  Object.getOwnPropertyDescriptor(value, key)?.value;

const validRuntimeData = (value: unknown): value is RuntimeData =>
  exactOwnKeys(value, ["state", "journal"]) &&
  subtaskCheckpointIsValid(ownValue(value, "state")) &&
  subtaskJournalIsValid(ownValue(value, "journal"));

const detachedRuntimeData = (value: unknown): RuntimeData | undefined => {
  if (!validRuntimeData(value)) return;
  const copy = structuredClone(value);
  return validRuntimeData(copy) ? copy : undefined;
};

const detachedCheckpoint = (value: unknown): SubtaskCheckpoint | undefined => {
  if (!subtaskCheckpointIsValid(value)) return;
  const copy = structuredClone(value);
  return subtaskCheckpointIsValid(copy) ? copy : undefined;
};

const sameRecordBindings = (
  left: SubtaskPhaseRecord,
  right: SubtaskPhaseRecord,
) =>
  left.identity === right.identity &&
  left.parentTaskId === right.parentTaskId &&
  left.parentRevision === right.parentRevision &&
  left.parentSourceDigest === right.parentSourceDigest &&
  left.listRevision === right.listRevision &&
  sameSource(left.source, right.source) &&
  left.contextHash === right.contextHash &&
  left.triggerHash === right.triggerHash &&
  left.gateModel === right.gateModel &&
  left.selectedModel === right.selectedModel;

const sameUsage = (
  left: { inputTokens: number; outputTokens: number },
  right: { inputTokens: number; outputTokens: number },
) =>
  left.inputTokens === right.inputTokens &&
  left.outputTokens === right.outputTokens;

const sameGateReceipt = (
  left: NonNullable<SubtaskPhaseRecord["gate"]>,
  right: NonNullable<SubtaskPhaseRecord["gate"]>,
) =>
  left.requestHash === right.requestHash &&
  left.dispatch === right.dispatch &&
  left.at === right.at &&
  left.outcome === right.outcome &&
  left.choice === right.choice &&
  left.confidence === right.confidence &&
  left.probability === right.probability &&
  sameUsage(left.usage, right.usage);

const sameProposalReceipt = (
  left: NonNullable<SubtaskPhaseRecord["proposal"]>,
  right: NonNullable<SubtaskPhaseRecord["proposal"]>,
) =>
  left.requestHash === right.requestHash &&
  left.dispatch === right.dispatch &&
  left.at === right.at &&
  left.outcome === right.outcome &&
  left.listRevision === right.listRevision &&
  sameUsage(left.usage, right.usage);

const gateExtends = (
  prior: NonNullable<SubtaskPhaseRecord["gate"]>,
  next: NonNullable<SubtaskPhaseRecord["gate"]>,
) =>
  sameGateReceipt(prior, next) ||
  (prior.requestHash === next.requestHash &&
    prior.dispatch === next.dispatch &&
    prior.at === next.at &&
    prior.outcome === "dispatched" &&
    next.outcome !== "dispatched");

const proposalExtends = (
  prior: NonNullable<SubtaskPhaseRecord["proposal"]>,
  next: NonNullable<SubtaskPhaseRecord["proposal"]>,
) =>
  sameProposalReceipt(prior, next) ||
  (prior.requestHash === next.requestHash &&
    prior.dispatch === next.dispatch &&
    prior.at === next.at &&
    prior.outcome === "dispatched" &&
    next.outcome !== "dispatched");

/** `next` contains every immutable receipt fact already present in `prior`. */
const recordProofExtends = (
  prior: SubtaskPhaseRecord,
  next: SubtaskPhaseRecord,
) => {
  if (!sameRecordBindings(prior, next)) return false;
  if (prior.gate !== undefined) {
    if (next.gate === undefined || !gateExtends(prior.gate, next.gate))
      return false;
  }
  if (prior.proposal !== undefined) {
    if (
      next.proposal === undefined ||
      !proposalExtends(prior.proposal, next.proposal)
    )
      return false;
  }
  return true;
};

const sameStrings = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const sameReportBindings = (left: SubtaskReportJob, right: SubtaskReportJob) =>
  left.identity === right.identity &&
  left.parentTaskId === right.parentTaskId &&
  left.parentRevision === right.parentRevision &&
  left.parentSourceDigest === right.parentSourceDigest &&
  left.groupId === right.groupId &&
  left.listRevision === right.listRevision &&
  sameSource(left.source, right.source) &&
  left.model === right.model &&
  sameStrings(left.childIds, right.childIds);

const sameAssessment = (
  left: NonNullable<SubtaskReportAttempt["assessments"]>[number],
  right: NonNullable<SubtaskReportAttempt["assessments"]>[number],
) =>
  left.childId === right.childId &&
  left.choice === right.choice &&
  left.scope === right.scope &&
  left.confidence === right.confidence &&
  left.probability === right.probability &&
  left.accepted === right.accepted;

const sameAttempt = (left: SubtaskReportAttempt, right: SubtaskReportAttempt) =>
  left.identity === right.identity &&
  left.requestHash === right.requestHash &&
  sameStrings(left.childIds, right.childIds) &&
  left.dispatch === right.dispatch &&
  left.at === right.at &&
  left.outcome === right.outcome &&
  sameUsage(left.usage, right.usage) &&
  (left.assessments === undefined || right.assessments === undefined
    ? left.assessments === right.assessments
    : left.assessments.length === right.assessments.length &&
      left.assessments.every((item, index) => {
        const candidate = right.assessments?.[index];
        return candidate !== undefined && sameAssessment(item, candidate);
      }));

const attemptExtends = (
  prior: SubtaskReportAttempt,
  next: SubtaskReportAttempt,
) =>
  sameAttempt(prior, next) ||
  (prior.identity === next.identity &&
    prior.requestHash === next.requestHash &&
    sameStrings(prior.childIds, next.childIds) &&
    prior.dispatch === next.dispatch &&
    prior.at === next.at &&
    prior.outcome === "dispatched" &&
    next.outcome !== "dispatched");

const reportProofExtends = (
  prior: SubtaskReportJob,
  next: SubtaskReportJob,
) => {
  if (
    !sameReportBindings(prior, next) ||
    next.attempts.length < prior.attempts.length
  )
    return false;
  return prior.attempts.every((attempt, index) => {
    const candidate = next.attempts[index];
    return candidate !== undefined && attemptExtends(attempt, candidate);
  });
};

const terminal = (state: SubtaskPhaseRecord["state"]) =>
  state === "complete" || state === "permanent" || state === "superseded";

const recordProofIsEqual = (
  left: SubtaskPhaseRecord,
  right: SubtaskPhaseRecord,
) => recordProofExtends(left, right) && recordProofExtends(right, left);

const reportProofIsEqual = (left: SubtaskReportJob, right: SubtaskReportJob) =>
  reportProofExtends(left, right) && reportProofExtends(right, left);

const retainSoleRecord = (
  record: SubtaskPhaseRecord,
  owner: WalletOwner,
  winner: WalletOwner,
) =>
  terminal(record.state) || owner === winner
    ? structuredClone(record)
    : (supersedeSubtaskRecord(record) ?? "proof-conflict");

const coherentRecord = (
  live: SubtaskPhaseRecord | undefined,
  incoming: SubtaskPhaseRecord | undefined,
  winner: WalletOwner,
): SubtaskPhaseRecord | RefusalReason | undefined => {
  if (!live)
    return incoming
      ? retainSoleRecord(incoming, "incoming", winner)
      : undefined;
  if (!incoming) return retainSoleRecord(live, "live", winner);
  if (!sameRecordBindings(live, incoming)) return "proof-conflict";

  const incomingExtendsLive = recordProofExtends(live, incoming);
  const liveExtendsIncoming = recordProofExtends(incoming, live);
  if (!incomingExtendsLive && !liveExtendsIncoming) return "proof-conflict";

  const proof =
    incomingExtendsLive && !liveExtendsIncoming
      ? incoming
      : liveExtendsIncoming && !incomingExtendsLive
        ? live
        : live;
  const terminalOwner = terminal(live.state)
    ? live
    : terminal(incoming.state)
      ? incoming
      : undefined;
  if (terminalOwner) {
    if (proof === terminalOwner || recordProofIsEqual(proof, terminalOwner))
      return structuredClone(terminalOwner);
    return supersedeSubtaskRecord(proof) ?? "proof-conflict";
  }

  const owner = winner === "live" ? live : incoming;
  if (proof === owner || recordProofIsEqual(proof, owner))
    return structuredClone(owner);
  return supersedeSubtaskRecord(proof) ?? "proof-conflict";
};

const retainSoleReport = (
  report: SubtaskReportJob,
  owner: WalletOwner,
  winner: WalletOwner,
) =>
  terminal(report.state) || owner === winner
    ? structuredClone(report)
    : (supersedeSubtaskReportJob(report) ?? "proof-conflict");

const coherentReport = (
  live: SubtaskReportJob | undefined,
  incoming: SubtaskReportJob | undefined,
  winner: WalletOwner,
): SubtaskReportJob | RefusalReason | undefined => {
  if (!live)
    return incoming
      ? retainSoleReport(incoming, "incoming", winner)
      : undefined;
  if (!incoming) return retainSoleReport(live, "live", winner);
  if (!sameReportBindings(live, incoming)) return "proof-conflict";

  const incomingExtendsLive = reportProofExtends(live, incoming);
  const liveExtendsIncoming = reportProofExtends(incoming, live);
  if (!incomingExtendsLive && !liveExtendsIncoming) return "proof-conflict";

  const proof =
    incomingExtendsLive && !liveExtendsIncoming
      ? incoming
      : liveExtendsIncoming && !incomingExtendsLive
        ? live
        : live;
  const terminalOwner = terminal(live.state)
    ? live
    : terminal(incoming.state)
      ? incoming
      : undefined;
  if (terminalOwner) {
    if (proof === terminalOwner || reportProofIsEqual(proof, terminalOwner))
      return structuredClone(terminalOwner);
    return supersedeSubtaskReportJob(proof) ?? "proof-conflict";
  }

  const owner = winner === "live" ? live : incoming;
  if (proof === owner || reportProofIsEqual(proof, owner))
    return structuredClone(owner);
  return supersedeSubtaskReportJob(proof) ?? "proof-conflict";
};

const journalOwners = (journal: SubtaskJournalCheckpoint): HistoryOwner[] => [
  ...journal.records.map((value) => ({ kind: "record" as const, value })),
  ...journal.reports.map((value) => ({ kind: "report" as const, value })),
];

const originalAcceptedHistoryIsCoherent = (component: RuntimeData) =>
  component.journal.records.every(
    (record) =>
      record.state === "superseded" ||
      record.proposal?.outcome !== "accepted" ||
      acceptedSubtaskRecordMatchesGroup(record, component.state.groups),
  );

const compareWallets = (
  live: SubtaskJournalCheckpoint,
  incoming: SubtaskJournalCheckpoint,
): WalletOwner | "equal" | undefined => {
  const left = [
    live.dispatches,
    live.usage.jev.calls,
    live.usage.jev.inputTokens,
    live.usage.jev.outputTokens,
    live.usage.extraction.calls,
    live.usage.extraction.inputTokens,
    live.usage.extraction.outputTokens,
  ];
  const right = [
    incoming.dispatches,
    incoming.usage.jev.calls,
    incoming.usage.jev.inputTokens,
    incoming.usage.jev.outputTokens,
    incoming.usage.extraction.calls,
    incoming.usage.extraction.inputTokens,
    incoming.usage.extraction.outputTokens,
  ];
  const liveDominates = left.every(
    (value, index) => value >= (right[index] ?? -1),
  );
  const incomingDominates = right.every(
    (value, index) => value >= (left[index] ?? -1),
  );
  if (liveDominates && incomingDominates) return "equal";
  if (liveDominates) return "live";
  if (incomingDominates) return "incoming";
  return;
};

const receiptAccounting = (journal: SubtaskJournalCheckpoint) => {
  const ordinals = new Set<number>();
  let jevCalls = 0;
  let jevInputTokens = 0;
  let jevOutputTokens = 0;
  let extractionCalls = 0;
  let extractionInputTokens = 0;
  let extractionOutputTokens = 0;
  let receiptCount = 0;

  const recordReceipt = (
    bucket: "jev" | "extraction",
    receipt: {
      dispatch: number;
      usage: { inputTokens: number; outputTokens: number };
    },
  ) => {
    receiptCount += 1;
    if (ordinals.has(receipt.dispatch)) return false;
    ordinals.add(receipt.dispatch);
    if (bucket === "jev") {
      jevCalls += 1;
      jevInputTokens += receipt.usage.inputTokens;
      jevOutputTokens += receipt.usage.outputTokens;
    } else {
      extractionCalls += 1;
      extractionInputTokens += receipt.usage.inputTokens;
      extractionOutputTokens += receipt.usage.outputTokens;
    }
    return true;
  };

  for (const record of journal.records) {
    if (record.gate && !recordReceipt("jev", record.gate)) return;
    if (record.proposal && !recordReceipt("extraction", record.proposal))
      return;
  }
  for (const report of journal.reports)
    for (const attempt of report.attempts)
      if (!recordReceipt("jev", attempt)) return;

  return {
    receiptCount,
    ordinals,
    jevCalls,
    jevInputTokens,
    jevOutputTokens,
    extractionCalls,
    extractionInputTokens,
    extractionOutputTokens,
  };
};

const walletCoversReceipts = (
  journal: SubtaskJournalCheckpoint,
  accounting: NonNullable<ReturnType<typeof receiptAccounting>>,
) =>
  [...accounting.ordinals].every((ordinal) => ordinal <= journal.dispatches) &&
  accounting.jevCalls <= journal.usage.jev.calls &&
  accounting.jevInputTokens <= journal.usage.jev.inputTokens &&
  accounting.jevOutputTokens <= journal.usage.jev.outputTokens &&
  accounting.extractionCalls <= journal.usage.extraction.calls &&
  accounting.extractionInputTokens <= journal.usage.extraction.inputTokens &&
  accounting.extractionOutputTokens <= journal.usage.extraction.outputTokens;

const unfinishedOwnersAreUnique = (journal: SubtaskJournalCheckpoint) => {
  const unfinished = journalOwners(journal).filter(
    ({ value }) => !terminal(value.state),
  );
  return (
    unfinished.length <= 20 &&
    new Set(unfinished.map(({ value }) => value.parentTaskId)).size ===
      unfinished.length
  );
};

const inertProjection = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const projection = value.map(inertProjection);
    Object.defineProperty(projection, "toJSON", {
      value: undefined,
      enumerable: false,
    });
    return projection;
  }
  if (value && typeof value === "object") {
    const projection = Object.create(null) as Record<string, unknown>;
    for (const [key, child] of Object.entries(value))
      projection[key] = inertProjection(child);
    return projection;
  }
  return value;
};

const encodedBytes = (value: object) =>
  Buffer.byteLength(JSON.stringify(inertProjection(value)), "utf8");

/**
 * Merge same-source cumulative generic history without adopting foreign target
 * groups. This boundary has no scheduling, persistence, clock, or reader work.
 */
export function mergeSubtaskRestoreHistory(input: {
  live: Readonly<SubtaskRuntimeCheckpoint>;
  incoming: Readonly<SubtaskRuntimeCheckpoint>;
  targetStore: Readonly<SubtaskCheckpoint>;
}): RestoreHistoryResult {
  try {
    if (!exactOwnKeys(input, ["live", "incoming", "targetStore"]))
      return refused("invalid-history");
    const live = detachedRuntimeData(ownValue(input, "live"));
    const incoming = detachedRuntimeData(ownValue(input, "incoming"));
    const targetStore = detachedCheckpoint(ownValue(input, "targetStore"));
    if (!live || !incoming || !targetStore) return refused("invalid-history");
    if (
      !originalAcceptedHistoryIsCoherent(live) ||
      !originalAcceptedHistoryIsCoherent(incoming)
    )
      return refused("invalid-history");

    const wallet = compareWallets(live.journal, incoming.journal);
    if (!wallet) return refused("accounting-conflict");
    const winner: WalletOwner = wallet === "equal" ? "live" : wallet;
    const selectedWallet = winner === "live" ? live.journal : incoming.journal;

    const liveOwners = new Map(
      journalOwners(live.journal).map((owner) => [owner.value.identity, owner]),
    );
    const incomingOwners = new Map(
      journalOwners(incoming.journal).map((owner) => [
        owner.value.identity,
        owner,
      ]),
    );
    const identities = new Set([
      ...liveOwners.keys(),
      ...incomingOwners.keys(),
    ]);
    const records: SubtaskPhaseRecord[] = [];
    const reports: SubtaskReportJob[] = [];

    for (const identity of identities) {
      const left = liveOwners.get(identity);
      const right = incomingOwners.get(identity);
      if (left && right && left.kind !== right.kind)
        return refused("proof-conflict");
      if ((left?.kind ?? right?.kind) === "record") {
        const result = coherentRecord(
          left?.kind === "record" ? left.value : undefined,
          right?.kind === "record" ? right.value : undefined,
          winner,
        );
        if (typeof result === "string") return refused(result);
        if (result) records.push(result);
      } else {
        const result = coherentReport(
          left?.kind === "report" ? left.value : undefined,
          right?.kind === "report" ? right.value : undefined,
          winner,
        );
        if (typeof result === "string") return refused(result);
        if (result) reports.push(result);
      }
    }

    if (records.length + reports.length > MAX_HISTORY_OWNERS)
      return refused("capacity");

    const journal: SubtaskJournalCheckpoint = {
      version: 1,
      dispatches: selectedWallet.dispatches,
      usage: structuredClone(selectedWallet.usage),
      records,
      reports,
    };
    const receipts = receiptAccounting(journal);
    if (!receipts) return refused("proof-conflict");
    if (receipts.receiptCount > MAX_RECEIPTS) return refused("capacity");
    if (!walletCoversReceipts(journal, receipts))
      return refused("accounting-conflict");

    for (let index = 0; index < journal.records.length; index += 1) {
      const record = journal.records[index];
      if (!record) return refused("proof-conflict");
      if (
        record.state !== "superseded" &&
        record.proposal?.outcome === "accepted" &&
        !acceptedSubtaskRecordMatchesGroup(record, targetStore.groups)
      ) {
        const superseded = supersedeSubtaskRecord(record);
        if (!superseded) return refused("proof-conflict");
        journal.records[index] = superseded;
      }
    }

    if (!unfinishedOwnersAreUnique(journal)) return refused("owner-conflict");
    if (encodedBytes(journal) > MAX_COMPONENT_BYTES) return refused("capacity");
    if (!subtaskJournalIsValid(journal)) return refused("proof-conflict");

    const state: SubtaskCheckpoint = {
      ...targetStore,
      nextGroupId: Math.max(
        live.state.nextGroupId,
        incoming.state.nextGroupId,
        targetStore.nextGroupId,
      ),
      nextChildId: Math.max(
        live.state.nextChildId,
        incoming.state.nextChildId,
        targetStore.nextChildId,
      ),
      groups: structuredClone(targetStore.groups),
    };
    if (!subtaskCheckpointIsValid(state))
      return encodedBytes(state) > MAX_COMPONENT_BYTES
        ? refused("capacity")
        : refused("invalid-history");
    if (encodedBytes({ state, journal }) > MAX_COMPONENT_BYTES)
      return refused("capacity");

    return { kind: "merged", component: { state, journal } };
  } catch {
    return refused("invalid-history");
  }
}
