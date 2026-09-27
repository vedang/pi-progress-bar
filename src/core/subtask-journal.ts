import type { SourceRef } from "./hybrid-state";

const JOURNAL_VERSION = 1;
const MAX_DISPATCHES = 1024;
const MAX_RECORDS = 200;
const MAX_RECEIPTS = 200;
const MAX_UNFINISHED_OWNERS = 20;
const MAX_JOURNAL_BYTES = 64 * 1024;
const MAX_TEXT_SCALARS = 512;
const MAX_NUMERIC_ID_CODE_UNITS = 32;

const digest = /^[a-f0-9]{64}$/;
const taskId = /^task:[1-9]\d*$/;
const groupId = /^subtask-group:[1-9]\d*$/;
const childId = /^subtask-child:[1-9]\d*$/;
const controlCharacter = /[\p{Cc}\p{Cf}]/u;
const whitespaceCharacter = /^\s$/u;

type SubtaskPhase = "gate-ready" | "gate-decided" | "proposal-decided";
type SubtaskPhaseState =
  | "ready"
  | "dispatched"
  | "parked"
  | "permanent"
  | "complete"
  | "superseded";
type SubtaskGateChoice = "yes" | "no" | "uncertain";
type SubtaskGateOutcome = "dispatched" | "decided" | "failed";
type SubtaskProposalOutcome = "dispatched" | "accepted" | "noop" | "failed";

interface SubtaskUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

interface SubtaskReceiptUsage {
  inputTokens: number;
  outputTokens: number;
}

interface SubtaskGateReceipt {
  requestHash: string;
  dispatch: number;
  at: number;
  outcome: SubtaskGateOutcome;
  choice?: SubtaskGateChoice;
  confidence?: number;
  probability?: number;
  usage: SubtaskReceiptUsage;
}

interface SubtaskProposalReceipt {
  requestHash: string;
  dispatch: number;
  at: number;
  outcome: SubtaskProposalOutcome;
  listRevision?: number;
  usage: SubtaskReceiptUsage;
}

export interface SubtaskPhaseRecord {
  identity: string;
  parentTaskId: string;
  parentRevision: number;
  parentSourceDigest: string;
  listRevision: number;
  source: SourceRef;
  contextHash: string;
  triggerHash: string;
  gateModel: string;
  selectedModel: string;
  phase: SubtaskPhase;
  state: SubtaskPhaseState;
  parkedUntil?: number;
  gate?: SubtaskGateReceipt;
  proposal?: SubtaskProposalReceipt;
}

type SubtaskReportState =
  | "ready"
  | "dispatched"
  | "parked"
  | "permanent"
  | "complete"
  | "superseded";
type SubtaskReportOutcome = "dispatched" | "decided" | "retryable" | "failed";
type SubtaskReportChoice =
  | "completed"
  | "retracted"
  | "blocked"
  | "unchanged"
  | "uncertain";
type SubtaskReportScope = "item" | "set" | "none";

/** Content-free normalized outcome from one C06 child assessment. */
interface SubtaskReportAssessment {
  childId: string;
  choice: SubtaskReportChoice;
  scope: SubtaskReportScope;
  confidence: number;
  probability: number;
  accepted: boolean;
}

/** One charged Jev report chunk; payload and report text never persist here. */
export interface SubtaskReportAttempt {
  identity: string;
  requestHash: string;
  childIds: string[];
  dispatch: number;
  at: number;
  outcome: SubtaskReportOutcome;
  usage: SubtaskReceiptUsage;
  assessments?: SubtaskReportAssessment[];
}

/** Durable report owner. `childIds` is the full ordered target roster. */
export interface SubtaskReportJob {
  identity: string;
  parentTaskId: string;
  parentRevision: number;
  parentSourceDigest: string;
  groupId: string;
  listRevision: number;
  source: SourceRef;
  model: string;
  childIds: string[];
  state: SubtaskReportState;
  parkedUntil?: number;
  attempts: SubtaskReportAttempt[];
}

export interface SubtaskJournalCheckpoint {
  version: typeof JOURNAL_VERSION;
  dispatches: number;
  usage: {
    jev: SubtaskUsage;
    extraction: SubtaskUsage;
  };
  records: SubtaskPhaseRecord[];
  reports: SubtaskReportJob[];
}

const plainDataRecord = (value: unknown): value is Record<string, unknown> => {
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

const hasExactKeys = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> => {
  if (!plainDataRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  return (
    keys.length >= required.length &&
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => typeof key === "string" && allowed.has(key))
  );
};

const densePlainArray = (
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): value is unknown[] => {
  if (!Array.isArray(value)) return false;
  // Read length before indexed descriptors so oversized input cannot invoke a
  // getter while being rejected for capacity.
  if (value.length < minimumLength || value.length > maximumLength)
    return false;
  if (Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length"))
    return false;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      return false;
  }
  return true;
};

const numericIdIsValid = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" &&
  value.length <= MAX_NUMERIC_ID_CODE_UNITS &&
  pattern.test(value);

const validHash = (value: unknown): value is string =>
  typeof value === "string" && value.length === 64 && digest.test(value);

const positiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1;

const nonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const finiteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const validText = (
  value: unknown,
  limit = MAX_TEXT_SCALARS,
): value is string => {
  if (typeof value !== "string" || !value.length) return false;
  let scalars = 0;
  let nonblank = false;
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) return false;
    const character = String.fromCodePoint(codePoint);
    if (controlCharacter.test(character)) return false;
    scalars += 1;
    if (scalars > limit) return false;
    if (!whitespaceCharacter.test(character)) nonblank = true;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return nonblank;
};

const validSourceRef = (value: unknown): value is SourceRef =>
  hasExactKeys(value, [
    "entryId",
    "messageHash",
    "role",
    "start",
    "end",
    "quoteHash",
  ]) &&
  validText(value.entryId) &&
  validHash(value.messageHash) &&
  (value.role === "user" ||
    value.role === "assistant" ||
    value.role === "intercom") &&
  nonNegativeInteger(value.start) &&
  positiveInteger(value.end) &&
  value.end > value.start &&
  validHash(value.quoteHash);

const validChildId = (value: unknown): value is string =>
  numericIdIsValid(value, childId);

const validUsage = (value: unknown): value is SubtaskUsage =>
  hasExactKeys(value, ["calls", "inputTokens", "outputTokens"]) &&
  nonNegativeInteger(value.calls) &&
  nonNegativeInteger(value.inputTokens) &&
  nonNegativeInteger(value.outputTokens);

const validReceiptUsage = (value: unknown): value is SubtaskReceiptUsage =>
  hasExactKeys(value, ["inputTokens", "outputTokens"]) &&
  nonNegativeInteger(value.inputTokens) &&
  nonNegativeInteger(value.outputTokens);

const validGateReceipt = (value: unknown): value is SubtaskGateReceipt => {
  if (!plainDataRecord(value)) return false;
  const outcome = value.outcome;
  const decided = outcome === "decided";
  if (
    !hasExactKeys(
      value,
      decided
        ? [
            "requestHash",
            "dispatch",
            "at",
            "outcome",
            "choice",
            "confidence",
            "probability",
            "usage",
          ]
        : ["requestHash", "dispatch", "at", "outcome", "usage"],
    ) ||
    !validHash(value.requestHash) ||
    !positiveInteger(value.dispatch) ||
    !finiteNonNegative(value.at) ||
    !validReceiptUsage(value.usage)
  )
    return false;
  if (!decided) return outcome === "dispatched" || outcome === "failed";
  return (
    (value.choice === "yes" ||
      value.choice === "no" ||
      value.choice === "uncertain") &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    typeof value.probability === "number" &&
    Number.isFinite(value.probability) &&
    value.probability >= 0 &&
    value.probability <= 1
  );
};

const validProposalReceipt = (
  value: unknown,
): value is SubtaskProposalReceipt => {
  if (!plainDataRecord(value)) return false;
  const accepted = value.outcome === "accepted";
  if (
    !hasExactKeys(
      value,
      accepted
        ? ["requestHash", "dispatch", "at", "outcome", "listRevision", "usage"]
        : ["requestHash", "dispatch", "at", "outcome", "usage"],
    ) ||
    !validHash(value.requestHash) ||
    !positiveInteger(value.dispatch) ||
    !finiteNonNegative(value.at) ||
    !validReceiptUsage(value.usage)
  )
    return false;
  if (accepted) return nonNegativeInteger(value.listRevision);
  return (
    value.outcome === "dispatched" ||
    value.outcome === "noop" ||
    value.outcome === "failed"
  );
};

const unit = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;

const validReportAssessment = (
  value: unknown,
): value is SubtaskReportAssessment => {
  if (
    !hasExactKeys(value, [
      "childId",
      "choice",
      "scope",
      "confidence",
      "probability",
      "accepted",
    ]) ||
    !validChildId(value.childId) ||
    (value.choice !== "completed" &&
      value.choice !== "retracted" &&
      value.choice !== "blocked" &&
      value.choice !== "unchanged" &&
      value.choice !== "uncertain") ||
    (value.scope !== "item" &&
      value.scope !== "set" &&
      value.scope !== "none") ||
    !unit(value.confidence) ||
    !unit(value.probability) ||
    typeof value.accepted !== "boolean"
  )
    return false;
  const transition =
    value.choice === "completed" ||
    value.choice === "retracted" ||
    value.choice === "blocked";
  if ((value.scope === "none") !== !transition) return false;
  return (
    !value.accepted ||
    (transition && value.confidence >= 0.5 && value.probability >= 0.8)
  );
};

const sameChildIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  left.every((childId, i) => childId === right[i]);

const validReportAttempt = (value: unknown): value is SubtaskReportAttempt => {
  if (!plainDataRecord(value)) return false;
  const decided = value.outcome === "decided";
  if (
    !hasExactKeys(
      value,
      decided
        ? [
            "identity",
            "requestHash",
            "childIds",
            "dispatch",
            "at",
            "outcome",
            "usage",
            "assessments",
          ]
        : [
            "identity",
            "requestHash",
            "childIds",
            "dispatch",
            "at",
            "outcome",
            "usage",
          ],
    ) ||
    !validHash(value.identity) ||
    !validHash(value.requestHash) ||
    !densePlainArray(value.childIds, 1, 20) ||
    !value.childIds.every(validChildId) ||
    new Set(value.childIds).size !== value.childIds.length ||
    !positiveInteger(value.dispatch) ||
    !finiteNonNegative(value.at) ||
    !validReceiptUsage(value.usage)
  )
    return false;
  if (!decided)
    return (
      value.outcome === "dispatched" ||
      value.outcome === "retryable" ||
      value.outcome === "failed"
    );
  const childIds = value.childIds as string[];
  const assessments = value.assessments as unknown[];
  return (
    densePlainArray(assessments, childIds.length, 20) &&
    assessments.every(validReportAssessment) &&
    assessments.every(
      (assessment, index) => assessment.childId === childIds[index],
    )
  );
};

const validReportJob = (value: unknown): value is SubtaskReportJob => {
  if (
    !hasExactKeys(
      value,
      [
        "identity",
        "parentTaskId",
        "parentRevision",
        "parentSourceDigest",
        "groupId",
        "listRevision",
        "source",
        "model",
        "childIds",
        "state",
        "attempts",
      ],
      ["parkedUntil"],
    ) ||
    !validHash(value.identity) ||
    !numericIdIsValid(value.parentTaskId, taskId) ||
    !positiveInteger(value.parentRevision) ||
    !validHash(value.parentSourceDigest) ||
    !numericIdIsValid(value.groupId, groupId) ||
    !positiveInteger(value.listRevision) ||
    !validSourceRef(value.source) ||
    value.model !== "jev-1.13.0" ||
    !densePlainArray(value.childIds, 1, 64) ||
    !value.childIds.every(validChildId) ||
    new Set(value.childIds).size !== value.childIds.length ||
    (value.state !== "ready" &&
      value.state !== "dispatched" &&
      value.state !== "parked" &&
      value.state !== "permanent" &&
      value.state !== "complete" &&
      value.state !== "superseded") ||
    !densePlainArray(value.attempts, 0, MAX_RECEIPTS) ||
    !value.attempts.every(validReportAttempt)
  )
    return false;

  const hasParkedUntil = Object.hasOwn(value, "parkedUntil");
  if (
    (value.state === "parked" &&
      (!hasParkedUntil || !nonNegativeInteger(value.parkedUntil))) ||
    (value.state !== "parked" && hasParkedUntil)
  )
    return false;

  const rosterIndex = new Map(value.childIds.map((childId, i) => [childId, i]));
  const covered = new Set<string>();
  let priorDispatch = 0;
  for (let index = 0; index < value.attempts.length; index++) {
    const attempt = value.attempts[index];
    if (attempt.dispatch <= priorDispatch) return false;
    priorDispatch = attempt.dispatch;
    let previousIndex = -1;
    for (const childId of attempt.childIds) {
      const position = rosterIndex.get(childId);
      if (position === undefined || position <= previousIndex) return false;
      previousIndex = position;
    }
    const overlaps = value.attempts
      .slice(0, index)
      .filter((prior) =>
        prior.childIds.some((childId) => attempt.childIds.includes(childId)),
      );
    if (
      overlaps.length &&
      !overlaps.every(
        (prior) =>
          prior.outcome === "retryable" &&
          prior.requestHash === attempt.requestHash &&
          prior.identity === attempt.identity &&
          sameChildIds(prior.childIds, attempt.childIds),
      )
    )
      return false;
    if (attempt.outcome === "decided") {
      if (attempt.childIds.some((childId) => covered.has(childId)))
        return false;
      for (const childId of attempt.childIds) covered.add(childId);
    }
  }

  const complete = covered.size === value.childIds.length;
  const latest = value.attempts.at(-1);
  if (value.state === "superseded") return true;
  switch (value.state) {
    case "ready":
      return (
        !complete && (latest === undefined || latest.outcome === "decided")
      );
    case "parked":
      return (
        !complete &&
        (latest === undefined ||
          latest.outcome === "decided" ||
          latest.outcome === "retryable")
      );
    case "dispatched":
      return !complete && latest?.outcome === "dispatched";
    case "permanent":
      return (
        !complete &&
        (latest?.outcome === "dispatched" || latest?.outcome === "failed")
      );
    case "complete":
      return complete && latest?.outcome === "decided";
  }
};

const acceptedYes = (gate: SubtaskGateReceipt) =>
  gate.outcome === "decided" &&
  gate.choice === "yes" &&
  gate.confidence !== undefined &&
  gate.confidence >= 0.5 &&
  gate.probability !== undefined &&
  gate.probability >= 0.8;

const validAttemptState = (
  state: SubtaskPhaseState,
  outcome: "dispatched" | "failed",
) =>
  outcome === "dispatched"
    ? state === "dispatched" || state === "permanent"
    : state === "parked" || state === "permanent";

const validRecord = (value: unknown): value is SubtaskPhaseRecord => {
  if (
    !hasExactKeys(
      value,
      [
        "identity",
        "parentTaskId",
        "parentRevision",
        "parentSourceDigest",
        "listRevision",
        "source",
        "contextHash",
        "triggerHash",
        "gateModel",
        "selectedModel",
        "phase",
        "state",
      ],
      ["parkedUntil", "gate", "proposal"],
    ) ||
    !validHash(value.identity) ||
    !numericIdIsValid(value.parentTaskId, taskId) ||
    !positiveInteger(value.parentRevision) ||
    !validHash(value.parentSourceDigest) ||
    !nonNegativeInteger(value.listRevision) ||
    !validSourceRef(value.source) ||
    !validHash(value.contextHash) ||
    !validHash(value.triggerHash) ||
    value.gateModel !== "jev-1.13.0" ||
    !validText(value.selectedModel) ||
    (value.phase !== "gate-ready" &&
      value.phase !== "gate-decided" &&
      value.phase !== "proposal-decided") ||
    (value.state !== "ready" &&
      value.state !== "dispatched" &&
      value.state !== "parked" &&
      value.state !== "permanent" &&
      value.state !== "complete" &&
      value.state !== "superseded")
  )
    return false;

  const hasParkedUntil = Object.hasOwn(value, "parkedUntil");
  if (
    (value.state === "parked" &&
      (!hasParkedUntil || !finiteNonNegative(value.parkedUntil))) ||
    (value.state !== "parked" && hasParkedUntil)
  )
    return false;

  const hasGate = Object.hasOwn(value, "gate");
  const hasProposal = Object.hasOwn(value, "proposal");
  if (
    (hasGate && !validGateReceipt(value.gate)) ||
    (hasProposal && !validProposalReceipt(value.proposal))
  )
    return false;

  const record = value as unknown as SubtaskPhaseRecord;
  const superseded = record.state === "superseded";
  switch (record.phase) {
    case "gate-ready": {
      if (hasProposal) return false;
      if (!hasGate) return superseded || record.state === "ready";
      const gate = record.gate;
      if (!gate || gate.outcome === "decided") return false;
      return superseded || validAttemptState(record.state, gate.outcome);
    }
    case "gate-decided": {
      const gate = record.gate;
      if (!hasGate || !gate || gate.outcome !== "decided") return false;
      if (!hasProposal)
        return (
          superseded ||
          (acceptedYes(gate)
            ? record.state === "ready"
            : record.state === "complete")
        );
      const proposal = record.proposal;
      if (!acceptedYes(gate) || !proposal || proposal.dispatch <= gate.dispatch)
        return false;
      if (proposal.outcome !== "dispatched" && proposal.outcome !== "failed")
        return false;
      return superseded || validAttemptState(record.state, proposal.outcome);
    }
    case "proposal-decided": {
      const gate = record.gate;
      const proposal = record.proposal;
      if (
        !hasGate ||
        !gate ||
        !acceptedYes(gate) ||
        !hasProposal ||
        !proposal ||
        proposal.dispatch <= gate.dispatch ||
        (!superseded && record.state !== "complete") ||
        (proposal.outcome !== "accepted" && proposal.outcome !== "noop")
      )
        return false;
      return (
        proposal.outcome !== "accepted" ||
        proposal.listRevision === record.listRevision ||
        proposal.listRevision === record.listRevision + 1
      );
    }
  }
};

const validJournalShape = (
  value: unknown,
): value is SubtaskJournalCheckpoint => {
  if (
    !hasExactKeys(value, [
      "version",
      "dispatches",
      "usage",
      "records",
      "reports",
    ]) ||
    value.version !== JOURNAL_VERSION ||
    !nonNegativeInteger(value.dispatches) ||
    value.dispatches > MAX_DISPATCHES ||
    !hasExactKeys(value.usage, ["jev", "extraction"]) ||
    !validUsage(value.usage.jev) ||
    !validUsage(value.usage.extraction) ||
    value.usage.jev.calls + value.usage.extraction.calls !== value.dispatches ||
    !densePlainArray(value.records, 0, MAX_RECORDS) ||
    !value.records.every(validRecord) ||
    !densePlainArray(value.reports, 0, MAX_RECORDS) ||
    !value.reports.every(validReportJob) ||
    value.records.length + value.reports.length > MAX_RECORDS
  )
    return false;

  const records = value.records;
  const reports = value.reports;
  const identities = [
    ...records.map((record) => record.identity),
    ...reports.map((report) => report.identity),
  ];
  if (new Set(identities).size !== identities.length) return false;

  const unfinished = [
    ...records.filter(
      (record) => record.state !== "complete" && record.state !== "superseded",
    ),
    ...reports.filter(
      (report) => report.state !== "complete" && report.state !== "superseded",
    ),
  ];
  if (
    unfinished.length > MAX_UNFINISHED_OWNERS ||
    new Set(unfinished.map((record) => record.parentTaskId)).size !==
      unfinished.length
  )
    return false;

  const receipts = [
    ...records.flatMap((record) => [
      ...(record.gate === undefined ? [] : [["jev", record.gate] as const]),
      ...(record.proposal === undefined
        ? []
        : [["extraction", record.proposal] as const]),
    ]),
    ...reports.flatMap((report) =>
      report.attempts.map((attempt) => ["jev", attempt] as const),
    ),
  ];
  if (receipts.length > MAX_RECEIPTS) return false;

  const ordinals = new Set<number>();
  let gateInputTokens = 0;
  let gateOutputTokens = 0;
  let proposalInputTokens = 0;
  let proposalOutputTokens = 0;
  let gateReceipts = 0;
  let proposalReceipts = 0;
  for (const [bucket, receipt] of receipts) {
    if (receipt.dispatch > value.dispatches || ordinals.has(receipt.dispatch))
      return false;
    ordinals.add(receipt.dispatch);
    if (bucket === "jev") {
      gateReceipts += 1;
      gateInputTokens += receipt.usage.inputTokens;
      gateOutputTokens += receipt.usage.outputTokens;
    } else {
      proposalReceipts += 1;
      proposalInputTokens += receipt.usage.inputTokens;
      proposalOutputTokens += receipt.usage.outputTokens;
    }
  }
  if (
    !Number.isSafeInteger(gateInputTokens) ||
    !Number.isSafeInteger(gateOutputTokens) ||
    !Number.isSafeInteger(proposalInputTokens) ||
    !Number.isSafeInteger(proposalOutputTokens)
  )
    return false;

  return (
    gateReceipts <= value.usage.jev.calls &&
    proposalReceipts <= value.usage.extraction.calls &&
    gateInputTokens <= value.usage.jev.inputTokens &&
    gateOutputTokens <= value.usage.jev.outputTokens &&
    proposalInputTokens <= value.usage.extraction.inputTokens &&
    proposalOutputTokens <= value.usage.extraction.outputTokens
  );
};

/** Build JSON data without consulting caller or prototype serialization hooks. */
const inertSerializationProjection = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const projection: unknown[] = [];
    for (let index = 0; index < value.length; index += 1)
      projection.push(inertSerializationProjection(value[index]));
    Object.defineProperty(projection, "toJSON", {
      value: undefined,
      enumerable: false,
    });
    return projection;
  }
  if (value && typeof value === "object") {
    const projection = Object.create(null) as Record<string, unknown>;
    for (const [key, child] of Object.entries(value))
      projection[key] = inertSerializationProjection(child);
    return projection;
  }
  return value;
};

const inertJson = (value: object) =>
  JSON.stringify(inertSerializationProjection(value)) as string;

export const subtaskJournalIsValid = (
  value: unknown,
): value is SubtaskJournalCheckpoint => {
  try {
    return (
      validJournalShape(value) &&
      Buffer.byteLength(inertJson(value), "utf8") <= MAX_JOURNAL_BYTES
    );
  } catch {
    return false;
  }
};

const cloneSource = (source: SourceRef): SourceRef => ({
  entryId: source.entryId,
  messageHash: source.messageHash,
  role: source.role,
  start: source.start,
  end: source.end,
  quoteHash: source.quoteHash,
});

const cloneReceiptUsage = (
  usage: SubtaskReceiptUsage,
): SubtaskReceiptUsage => ({
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
});

const cloneGate = (gate: SubtaskGateReceipt): SubtaskGateReceipt => ({
  requestHash: gate.requestHash,
  dispatch: gate.dispatch,
  at: gate.at,
  outcome: gate.outcome,
  ...(gate.outcome === "decided"
    ? {
        choice: gate.choice,
        confidence: gate.confidence,
        probability: gate.probability,
      }
    : {}),
  usage: cloneReceiptUsage(gate.usage),
});

const cloneProposal = (
  proposal: SubtaskProposalReceipt,
): SubtaskProposalReceipt => ({
  requestHash: proposal.requestHash,
  dispatch: proposal.dispatch,
  at: proposal.at,
  outcome: proposal.outcome,
  ...(proposal.outcome === "accepted"
    ? { listRevision: proposal.listRevision }
    : {}),
  usage: cloneReceiptUsage(proposal.usage),
});

const cloneReportAssessment = (
  assessment: SubtaskReportAssessment,
): SubtaskReportAssessment => ({
  childId: assessment.childId,
  choice: assessment.choice,
  scope: assessment.scope,
  confidence: assessment.confidence,
  probability: assessment.probability,
  accepted: assessment.accepted,
});

const cloneReportAttempt = (
  attempt: SubtaskReportAttempt,
): SubtaskReportAttempt => ({
  identity: attempt.identity,
  requestHash: attempt.requestHash,
  childIds: [...attempt.childIds],
  dispatch: attempt.dispatch,
  at: attempt.at,
  outcome: attempt.outcome,
  usage: cloneReceiptUsage(attempt.usage),
  ...(attempt.assessments === undefined
    ? {}
    : { assessments: attempt.assessments.map(cloneReportAssessment) }),
});

const cloneReportJob = (report: SubtaskReportJob): SubtaskReportJob => ({
  identity: report.identity,
  parentTaskId: report.parentTaskId,
  parentRevision: report.parentRevision,
  parentSourceDigest: report.parentSourceDigest,
  groupId: report.groupId,
  listRevision: report.listRevision,
  source: cloneSource(report.source),
  model: report.model,
  childIds: [...report.childIds],
  state: report.state,
  ...(report.parkedUntil === undefined
    ? {}
    : { parkedUntil: report.parkedUntil }),
  attempts: report.attempts.map(cloneReportAttempt),
});

const cloneRecord = (record: SubtaskPhaseRecord): SubtaskPhaseRecord => ({
  identity: record.identity,
  parentTaskId: record.parentTaskId,
  parentRevision: record.parentRevision,
  parentSourceDigest: record.parentSourceDigest,
  listRevision: record.listRevision,
  source: cloneSource(record.source),
  contextHash: record.contextHash,
  triggerHash: record.triggerHash,
  gateModel: record.gateModel,
  selectedModel: record.selectedModel,
  phase: record.phase,
  state: record.state,
  ...(record.parkedUntil === undefined
    ? {}
    : { parkedUntil: record.parkedUntil }),
  ...(record.gate === undefined ? {} : { gate: cloneGate(record.gate) }),
  ...(record.proposal === undefined
    ? {}
    : { proposal: cloneProposal(record.proposal) }),
});

const cloneUsage = (usage: SubtaskUsage): SubtaskUsage => ({
  calls: usage.calls,
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
});

const cloneJournal = (
  journal: SubtaskJournalCheckpoint,
): SubtaskJournalCheckpoint => ({
  version: journal.version,
  dispatches: journal.dispatches,
  usage: {
    jev: cloneUsage(journal.usage.jev),
    extraction: cloneUsage(journal.usage.extraction),
  },
  records: journal.records.map(cloneRecord),
  reports: journal.reports.map(cloneReportJob),
});

/** Retire only scheduling authority; receipts and identity remain history. */
export const supersedeSubtaskRecord = (
  record: SubtaskPhaseRecord,
): SubtaskPhaseRecord | undefined => {
  try {
    const superseded = cloneRecord(record);
    superseded.state = "superseded";
    delete superseded.parkedUntil;
    return validRecord(superseded) ? superseded : undefined;
  } catch {
    return;
  }
};

/** Retire report scheduling authority while retaining charged history. */
const supersedeSubtaskReportJob = (
  report: SubtaskReportJob,
): SubtaskReportJob | undefined => {
  try {
    const superseded = cloneReportJob(report);
    superseded.state = "superseded";
    delete superseded.parkedUntil;
    return validReportJob(superseded) ? superseded : undefined;
  } catch {
    return;
  }
};

export interface SubtaskAcceptedGroupFrontier {
  parentTaskId: string;
  parentRevision: number;
  listRevision: number;
}

export const acceptedSubtaskRecordMatchesGroup = (
  record: SubtaskPhaseRecord,
  groups: readonly SubtaskAcceptedGroupFrontier[],
) =>
  record.proposal?.outcome === "accepted" &&
  groups.some(
    (group) =>
      group.parentTaskId === record.parentTaskId &&
      group.parentRevision === record.parentRevision &&
      group.listRevision === record.proposal?.listRevision,
  );

/**
 * Reject only raw, nonsuperseded accepted authority whose serialized resulting
 * group never existed. Canonical pruning later may still retire coherent proof.
 */
export const pruneIncoherentAcceptedSubtaskRecords = (
  journal: SubtaskJournalCheckpoint,
  groups: readonly SubtaskAcceptedGroupFrontier[],
): SubtaskJournalCheckpoint | undefined => {
  try {
    if (!subtaskJournalIsValid(journal)) return;
    const pruned = cloneJournal(journal);
    pruned.records = pruned.records.filter((record) => {
      if (
        record.state === "superseded" ||
        record.proposal?.outcome !== "accepted"
      )
        return true;
      return acceptedSubtaskRecordMatchesGroup(record, groups);
    });
    return subtaskJournalIsValid(pruned) ? pruned : undefined;
  } catch {
    return;
  }
};

/**
 * Drop stale authority without refunding the lifetime wallet. A crash after a
 * charged dispatch is terminal until a later explicit recovery policy exists.
 */
export const restoreSubtaskJournal = (
  data: unknown,
  isCurrent: (record: SubtaskPhaseRecord) => boolean,
  isCurrentReport?: (report: SubtaskReportJob) => boolean,
): SubtaskJournalCheckpoint | undefined => {
  if (!subtaskJournalIsValid(data) || typeof isCurrent !== "function") return;

  // Clone before either callback. Callbacks receive clones and cannot mutate
  // caller-owned history or the candidate that will be returned.
  const journal = cloneJournal(data);
  const records: SubtaskPhaseRecord[] = [];
  for (const record of journal.records) {
    if (record.state === "superseded") {
      records.push(cloneRecord(record));
      continue;
    }
    let restored: SubtaskPhaseRecord | undefined;
    try {
      restored =
        isCurrent(cloneRecord(record)) === true
          ? cloneRecord(record)
          : supersedeSubtaskRecord(record);
    } catch {
      restored = supersedeSubtaskRecord(record);
    }
    if (!restored) return;
    if (restored.state === "dispatched") restored.state = "permanent";
    records.push(restored);
  }

  const reports: SubtaskReportJob[] = [];
  for (const report of journal.reports) {
    if (report.state === "superseded") {
      reports.push(cloneReportJob(report));
      continue;
    }
    let restored: SubtaskReportJob | undefined;
    try {
      restored =
        isCurrentReport?.(cloneReportJob(report)) === true
          ? cloneReportJob(report)
          : supersedeSubtaskReportJob(report);
    } catch {
      restored = supersedeSubtaskReportJob(report);
    }
    if (!restored) return;
    if (restored.state === "dispatched") restored.state = "permanent";
    reports.push(restored);
  }

  const restored: SubtaskJournalCheckpoint = {
    version: JOURNAL_VERSION,
    dispatches: journal.dispatches,
    usage: {
      jev: cloneUsage(journal.usage.jev),
      extraction: cloneUsage(journal.usage.extraction),
    },
    records,
    reports,
  };
  return subtaskJournalIsValid(restored) ? restored : undefined;
};

/** Pure eligibility selector. It schedules nothing and never changes journal data. */
export const nextSubtaskPhase = (
  journal: SubtaskJournalCheckpoint,
  identity: string,
): "gate" | "proposal" | undefined => {
  if (!subtaskJournalIsValid(journal) || journal.dispatches >= MAX_DISPATCHES)
    return;
  const record = journal.records.find((item) => item.identity === identity);
  if (!record || record.state === "superseded") return;
  if (
    record.phase === "gate-ready" &&
    record.state === "ready" &&
    record.gate === undefined &&
    record.proposal === undefined
  )
    return "gate";
  if (
    record.phase === "gate-decided" &&
    record.state === "ready" &&
    record.gate !== undefined &&
    acceptedYes(record.gate) &&
    record.proposal === undefined
  )
    return "proposal";
  return;
};
