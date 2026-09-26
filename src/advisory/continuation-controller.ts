import {
  applyContinuationGate,
  buildContinuationGate,
  type ContinuationGateBatch,
} from "../analysis/continuation-gate";
import type { ValidatedResult } from "../analysis/gateway";
import type { ContinuationAuthorityProjection } from "./continuation-authority";
import {
  type AppliedContinuationDraft,
  applyContinuationDraft,
  buildContinuationDraft,
  type ContinuationDraftRequest,
} from "./continuation-draft";
import type { ReconciliationSettlement } from "./delivery";

const MAX_GATE_DISPATCHES = 32;
const MAX_DRAFT_DISPATCHES = 32;
const MAX_DISPATCHES = 64;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ContinuationPhase =
  | "idle"
  | "await-reply"
  | "await-frontier"
  | "classifying"
  | "drafting"
  | "delivery"
  | "consumed";

export type ContinuationRoot = Readonly<{
  opportunityId: string;
  sessionEpoch: number;
  branchEpoch: number;
  originalRunId: number;
}>;

export type ContinuationUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type ContinuationSnapshot = {
  phase: ContinuationPhase;
  gateDispatches: number;
  draftDispatches: number;
  exhausted: boolean;
  usage: ContinuationUsage;
};

type ContinuationDraftProviderResult = Readonly<{
  text: string;
  model: string;
  provider: string;
  requestHash: string;
  usage: ContinuationUsage;
}>;

export type ContinuationControllerOptions = Readonly<{
  authority: () => ContinuationAuthorityProjection;
  canStart: () => boolean;
  gate: (
    batch: ContinuationGateBatch,
    signal: AbortSignal,
    admit: () => boolean,
  ) => Promise<ValidatedResult | undefined>;
  draft: (
    request: ContinuationDraftRequest,
    signal: AbortSignal,
    admit: () => boolean,
  ) => Promise<ContinuationDraftProviderResult | undefined>;
  emit: (draft: AppliedContinuationDraft) => boolean;
}>;

type AvailableProjection = Extract<
  ContinuationAuthorityProjection,
  { available: true }
>;
type ProviderKind = "gate" | "draft";
type RecordValue = Record<string, unknown>;

const record = (value: unknown): value is RecordValue =>
  !!value && typeof value === "object" && !Array.isArray(value);

const exactKeys = (value: RecordValue, keys: readonly string[]) => {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
};

const safeInteger = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;

const nonblank = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim();

const sameRoot = (
  left: ContinuationRoot | undefined,
  right: ContinuationRoot | undefined,
) =>
  !!left &&
  !!right &&
  left.opportunityId === right.opportunityId &&
  left.sessionEpoch === right.sessionEpoch &&
  left.branchEpoch === right.branchEpoch &&
  left.originalRunId === right.originalRunId;

const rootOrder = (left: ContinuationRoot, right: ContinuationRoot) => {
  for (const key of ["sessionEpoch", "branchEpoch", "originalRunId"] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return 0;
};

const sameReceipt = (
  left: ReconciliationSettlement | undefined,
  right: ReconciliationSettlement | undefined,
) => {
  if (
    !left ||
    !right ||
    left.kind !== right.kind ||
    left.opportunityId !== right.opportunityId ||
    left.sendId !== right.sendId ||
    left.sessionEpoch !== right.sessionEpoch ||
    left.branchEpoch !== right.branchEpoch ||
    left.replyRunId !== right.replyRunId ||
    left.question.entryId !== right.question.entryId ||
    left.question.contentHash !== right.question.contentHash ||
    left.replies.length !== right.replies.length
  )
    return false;
  return left.replies.every((reply, index) => {
    const other = right.replies[index];
    return (
      !!other &&
      reply.entryId === other.entryId &&
      reply.messageHash === other.messageHash &&
      reply.role === other.role
    );
  });
};

const json = (value: unknown): string | undefined => {
  try {
    return JSON.stringify(value);
  } catch {
    return;
  }
};

const sameJson = (left: unknown, right: unknown) => {
  const leftJson = json(left);
  return leftJson !== undefined && leftJson === json(right);
};

const validUsage = (value: unknown): value is ContinuationUsage =>
  record(value) &&
  exactKeys(value, ["inputTokens", "outputTokens"]) &&
  safeInteger(value.inputTokens) &&
  safeInteger(value.outputTokens);

const validRoot = (value: unknown): value is ContinuationRoot =>
  record(value) &&
  exactKeys(value, [
    "opportunityId",
    "sessionEpoch",
    "branchEpoch",
    "originalRunId",
  ]) &&
  typeof value.opportunityId === "string" &&
  UUID_V4.test(value.opportunityId) &&
  safeInteger(value.sessionEpoch) &&
  safeInteger(value.branchEpoch) &&
  safeInteger(value.originalRunId);

const copyRoot = (root: ContinuationRoot): ContinuationRoot =>
  Object.freeze({
    opportunityId: root.opportunityId,
    sessionEpoch: root.sessionEpoch,
    branchEpoch: root.branchEpoch,
    originalRunId: root.originalRunId,
  });

const copyReceipt = (value: unknown): ReconciliationSettlement | undefined => {
  if (
    !record(value) ||
    !exactKeys(value, [
      "kind",
      "opportunityId",
      "sendId",
      "sessionEpoch",
      "branchEpoch",
      "replyRunId",
      "question",
      "replies",
    ]) ||
    value.kind !== "reconciliation" ||
    !nonblank(value.opportunityId) ||
    !nonblank(value.sendId) ||
    !safeInteger(value.sessionEpoch) ||
    !safeInteger(value.branchEpoch) ||
    !safeInteger(value.replyRunId, 1) ||
    !record(value.question) ||
    !exactKeys(value.question, ["entryId", "contentHash"]) ||
    !nonblank(value.question.entryId) ||
    typeof value.question.contentHash !== "string" ||
    !SHA256.test(value.question.contentHash) ||
    !Array.isArray(value.replies) ||
    !value.replies.length
  )
    return;

  const replyIds = new Set<string>();
  const replies =
    [] as ReconciliationSettlement["replies"] extends readonly (infer Reply)[]
      ? Reply[]
      : never[];
  for (const reply of value.replies) {
    if (
      !record(reply) ||
      !exactKeys(reply, ["entryId", "messageHash", "role"]) ||
      !nonblank(reply.entryId) ||
      typeof reply.messageHash !== "string" ||
      !SHA256.test(reply.messageHash) ||
      reply.role !== "assistant" ||
      replyIds.has(reply.entryId)
    )
      return;
    replyIds.add(reply.entryId);
    replies.push(
      Object.freeze({
        entryId: reply.entryId,
        messageHash: reply.messageHash,
        role: "assistant" as const,
      }),
    );
  }

  return Object.freeze({
    kind: "reconciliation" as const,
    opportunityId: value.opportunityId,
    sendId: value.sendId,
    sessionEpoch: value.sessionEpoch,
    branchEpoch: value.branchEpoch,
    replyRunId: value.replyRunId,
    question: Object.freeze({
      entryId: value.question.entryId,
      contentHash: value.question.contentHash,
    }),
    replies: Object.freeze(replies),
  });
};

const validDraftResult = (
  value: unknown,
  request: ContinuationDraftRequest,
): value is ContinuationDraftProviderResult =>
  record(value) &&
  exactKeys(value, ["text", "model", "provider", "requestHash", "usage"]) &&
  typeof value.text === "string" &&
  nonblank(value.model) &&
  nonblank(value.provider) &&
  value.requestHash === request.requestHash &&
  `${value.provider}/${value.model}` === request.input.authority.model &&
  validUsage(value.usage);

const immutableDraft = (
  value: AppliedContinuationDraft,
): AppliedContinuationDraft =>
  Object.freeze({
    draft: Object.freeze({
      targetIndex: value.draft.targetIndex,
      action: value.draft.action,
      evidence: Object.freeze(
        value.draft.evidence.map((range) =>
          Object.freeze({
            contextIndex: range.contextIndex,
            start: range.start,
            end: range.end,
          }),
        ),
      ),
    }),
    message: value.message,
    requestHash: value.requestHash,
  }) as AppliedContinuationDraft;

/**
 * Disconnected one-shot N04 coordinator. N02/N03 remain validation owners;
 * this class owns only root fencing, admissions, lifetime counters and emission.
 */
export class ContinuationController {
  private phase: ContinuationPhase = "idle";
  private root?: ContinuationRoot;
  private receipt?: ReconciliationSettlement;
  private highWater?: ContinuationRoot;
  private abortController?: AbortController;
  private flight?: Promise<void>;
  private generation = 0;
  private gateDispatches = 0;
  private draftDispatches = 0;
  private usage: ContinuationUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(private readonly options: ContinuationControllerOptions) {}

  arm(root: ContinuationRoot): boolean {
    if (
      !validRoot(root) ||
      this.flight ||
      (this.phase !== "idle" && this.phase !== "consumed") ||
      (this.highWater && rootOrder(root, this.highWater) <= 0)
    )
      return false;

    const copy = copyRoot(root);
    this.highWater = copy;
    this.root = copy;
    this.receipt = undefined;
    this.abortController = new AbortController();
    this.generation++;
    this.phase = "await-reply";
    return true;
  }

  settle(receipt: ReconciliationSettlement): boolean {
    const copy = copyReceipt(receipt);
    if (
      this.phase !== "await-reply" ||
      !this.root ||
      !copy ||
      copy.opportunityId !== this.root.opportunityId ||
      copy.sessionEpoch !== this.root.sessionEpoch ||
      copy.branchEpoch !== this.root.branchEpoch
    )
      return false;

    this.receipt = copy;
    this.phase = "await-frontier";
    return true;
  }

  async wake(): Promise<void> {
    if (this.flight || this.phase !== "await-frontier") return;
    const root = this.root;
    const receipt = this.receipt;
    const generation = this.generation;
    if (!root || !receipt) {
      this.consumeIfActive(generation, root);
      return;
    }

    const observed = this.authority();
    const current = this.currentFrom(observed, generation, root, receipt);
    if (!current) {
      if (this.isFrontier(observed, generation, root, receipt)) return;
      this.consumeIfActive(generation, root);
      return;
    }
    if (!this.canSchedule()) return;

    const beforePhase = this.authority();
    const phaseAuthority = this.currentFrom(
      beforePhase,
      generation,
      root,
      receipt,
    );
    if (!phaseAuthority) {
      if (this.isFrontier(beforePhase, generation, root, receipt)) return;
      this.consumeIfActive(generation, root);
      return;
    }
    if (!this.hasCapacity("gate")) {
      this.consumeIfActive(generation, root);
      return;
    }

    const batch = buildContinuationGate(phaseAuthority);
    if (!batch) {
      this.consumeIfActive(generation, root);
      return;
    }

    this.phase = "classifying";
    let settleFlight: () => void = () => {};
    const flight = new Promise<void>((resolve) => {
      settleFlight = resolve;
    });
    this.flight = flight;
    void this.classify(generation, root, receipt, batch)
      .catch(() => this.consumeIfActive(generation, root))
      .finally(settleFlight);
    await flight;
    if (this.flight === flight) this.flight = undefined;
  }

  invalidate(): void {
    this.abortController?.abort();
    this.generation++;
    this.root = undefined;
    this.receipt = undefined;
    this.abortController = undefined;
    this.phase = "consumed";
  }

  snapshot(): ContinuationSnapshot {
    return {
      phase: this.phase,
      gateDispatches: this.gateDispatches,
      draftDispatches: this.draftDispatches,
      exhausted:
        this.gateDispatches >= MAX_GATE_DISPATCHES ||
        this.draftDispatches >= MAX_DRAFT_DISPATCHES ||
        this.gateDispatches + this.draftDispatches >= MAX_DISPATCHES,
      usage: { ...this.usage },
    };
  }

  private async classify(
    generation: number,
    root: ContinuationRoot,
    receipt: ReconciliationSettlement,
    batch: ContinuationGateBatch,
  ): Promise<void> {
    const signal = this.abortController?.signal;
    if (!signal || !this.active(generation, root, receipt, "classifying")) {
      this.consumeIfActive(generation, root);
      return;
    }

    const admission = this.admission(
      "gate",
      generation,
      root,
      receipt,
      signal,
      () =>
        this.current(generation, root, receipt, (current) =>
          sameJson(batch.request.state, current),
        ),
    );
    let result: ValidatedResult | undefined;
    try {
      result = await this.options.gate(batch, signal, admission.admit);
    } catch {
      this.consumeIfActive(generation, root);
      return;
    }

    if (!admission.didAdmit()) {
      this.consumeIfActive(generation, root);
      return;
    }

    const current = this.current(generation, root, receipt);
    if (!current) {
      this.consumeIfActive(generation, root);
      return;
    }
    const gated = applyContinuationGate(batch, result, current);
    if (
      !gated ||
      !this.addUsage(gated.usage.input_tokens, gated.usage.output_tokens)
    ) {
      this.consumeIfActive(generation, root);
      return;
    }

    const request = buildContinuationDraft(batch, result, current);
    if (!request) {
      this.consumeIfActive(generation, root);
      return;
    }

    const beforeDraft = this.current(generation, root, receipt);
    if (
      !beforeDraft ||
      !sameJson(request.input.authority, beforeDraft) ||
      !this.canSchedule() ||
      !this.hasCapacity("draft")
    ) {
      this.consumeIfActive(generation, root);
      return;
    }

    this.phase = "drafting";
    await this.draft(generation, root, receipt, request);
  }

  private async draft(
    generation: number,
    root: ContinuationRoot,
    receipt: ReconciliationSettlement,
    request: ContinuationDraftRequest,
  ): Promise<void> {
    const signal = this.abortController?.signal;
    if (!signal || !this.active(generation, root, receipt, "drafting")) {
      this.consumeIfActive(generation, root);
      return;
    }

    const admission = this.admission(
      "draft",
      generation,
      root,
      receipt,
      signal,
      () =>
        this.current(generation, root, receipt, (current) =>
          sameJson(request.input.authority, current),
        ),
    );
    let result: ContinuationDraftProviderResult | undefined;
    try {
      result = await this.options.draft(request, signal, admission.admit);
    } catch {
      this.consumeIfActive(generation, root);
      return;
    }

    if (!admission.didAdmit()) {
      this.consumeIfActive(generation, root);
      return;
    }
    const current = this.current(generation, root, receipt);
    if (!current || !validDraftResult(result, request)) {
      this.consumeIfActive(generation, root);
      return;
    }
    if (!this.addUsage(result.usage.inputTokens, result.usage.outputTokens)) {
      this.consumeIfActive(generation, root);
      return;
    }

    const applied = applyContinuationDraft(request, result.text, current);
    if (!applied) {
      this.consumeIfActive(generation, root);
      return;
    }

    const beforeEmission = this.current(generation, root, receipt);
    if (
      !beforeEmission ||
      !sameJson(request.input.authority, beforeEmission) ||
      !this.canSchedule()
    ) {
      this.consumeIfActive(generation, root);
      return;
    }

    this.phase = "delivery";
    try {
      if (this.options.emit(immutableDraft(applied)) !== true) {
        this.consumeIfActive(generation, root);
        return;
      }
    } catch {
      this.consumeIfActive(generation, root);
      return;
    }
    this.consumeIfActive(generation, root);
  }

  private admission(
    kind: ProviderKind,
    generation: number,
    root: ContinuationRoot,
    receipt: ReconciliationSettlement,
    signal: AbortSignal,
    fresh: () => AvailableProjection | undefined,
  ): { admit: () => boolean; didAdmit: () => boolean } {
    let used = false;
    let admitted = false;
    return {
      admit: () => {
        if (used) return false;
        used = true;
        if (
          signal.aborted ||
          !this.active(
            generation,
            root,
            receipt,
            kind === "gate" ? "classifying" : "drafting",
          ) ||
          !this.hasCapacity(kind) ||
          !this.canSchedule() ||
          !fresh()
        )
          return false;
        if (kind === "gate") this.gateDispatches++;
        else this.draftDispatches++;
        admitted = true;
        return true;
      },
      didAdmit: () => admitted,
    };
  }

  private active(
    generation: number,
    root: ContinuationRoot,
    receipt: ReconciliationSettlement,
    phase: ContinuationPhase,
  ) {
    return (
      this.generation === generation &&
      this.phase === phase &&
      sameRoot(this.root, root) &&
      sameReceipt(this.receipt, receipt)
    );
  }

  private authority(): ContinuationAuthorityProjection | undefined {
    try {
      return this.options.authority();
    } catch {
      return;
    }
  }

  private current(
    generation: number,
    root: ContinuationRoot,
    receipt: ReconciliationSettlement,
    accept?: (projection: AvailableProjection) => boolean,
  ): AvailableProjection | undefined {
    return this.currentFrom(
      this.authority(),
      generation,
      root,
      receipt,
      accept,
    );
  }

  private currentFrom(
    projection: ContinuationAuthorityProjection | undefined,
    generation: number,
    root: ContinuationRoot,
    receipt: ReconciliationSettlement,
    accept?: (projection: AvailableProjection) => boolean,
  ): AvailableProjection | undefined {
    if (
      projection?.available !== true ||
      !sameRoot(this.root, root) ||
      this.generation !== generation ||
      !sameReceipt(this.receipt, receipt) ||
      projection.receipt.opportunityId !== root.opportunityId ||
      projection.sessionEpoch !== root.sessionEpoch ||
      projection.branchEpoch !== root.branchEpoch ||
      projection.originalRunId !== root.originalRunId ||
      !sameReceipt(projection.receipt, receipt) ||
      (accept && !accept(projection))
    )
      return;
    return projection;
  }

  private isFrontier(
    projection: ContinuationAuthorityProjection | undefined,
    generation: number,
    root: ContinuationRoot,
    receipt: ReconciliationSettlement,
  ): boolean {
    return (
      this.generation === generation &&
      sameRoot(this.root, root) &&
      sameReceipt(this.receipt, receipt) &&
      projection?.available === false &&
      projection.reason === "frontier"
    );
  }

  private canSchedule(): boolean {
    try {
      return this.options.canStart() === true;
    } catch {
      return false;
    }
  }

  private hasCapacity(kind: ProviderKind): boolean {
    return (
      this.gateDispatches + this.draftDispatches < MAX_DISPATCHES &&
      (kind === "gate"
        ? this.gateDispatches < MAX_GATE_DISPATCHES
        : this.draftDispatches < MAX_DRAFT_DISPATCHES)
    );
  }

  private addUsage(inputTokens: number, outputTokens: number): boolean {
    if (
      !safeInteger(inputTokens) ||
      !safeInteger(outputTokens) ||
      this.usage.inputTokens + inputTokens > Number.MAX_SAFE_INTEGER ||
      this.usage.outputTokens + outputTokens > Number.MAX_SAFE_INTEGER
    )
      return false;
    this.usage = {
      inputTokens: this.usage.inputTokens + inputTokens,
      outputTokens: this.usage.outputTokens + outputTokens,
    };
    return true;
  }

  private consumeIfActive(
    generation: number,
    root: ContinuationRoot | undefined,
  ) {
    if (this.generation !== generation || !sameRoot(this.root, root)) return;
    this.root = undefined;
    this.receipt = undefined;
    this.abortController = undefined;
    this.phase = "consumed";
  }
}
