import { createHash, randomUUID } from "node:crypto";

import type { ObservationRef } from "../core/hybrid-state";

const ADVISORY_CUSTOM_TYPE = "pi-progress-advisory" as const;
const RECONCILIATION_KIND = "reconciliation" as const;
const CORRECTION_KINDS = new Set(["test-correction", "review-correction"]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2_000, 8_000] as const;
const FINAL_EVIDENCE_GRACE_MS = 8_000;
const MAX_CONTENT_UTF8_BYTES = 24 * 1024;
const MAX_CONTENT_JSON_BODY_BYTES = 32 * 1024;
const MAX_SETTLEMENT_SUFFIX_ENTRIES = 64;
const MAX_SETTLEMENT_REPLIES = 16;
const MAX_SETTLEMENT_VISIBLE_BYTES = 12 * 1024;
const RECEIPT_HASH_PLACEHOLDER = "0".repeat(64);
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type SettlementOrigin =
  | "advisory-only"
  | "mixed-external"
  | "external"
  | "uncertain-advisory"
  | "independent";

export type AdvisoryDeliveryKind =
  | "reconciliation"
  | "test-correction"
  | "review-correction";

export type ReconciliationDeliveryRequest = Readonly<{
  kind: AdvisoryDeliveryKind;
  opportunityId: string;
  content: string;
  sessionEpoch: number;
  branchEpoch: number;
}>;

export type ReconciliationSettlement = Readonly<{
  kind: "reconciliation";
  opportunityId: string;
  sendId: string;
  sessionEpoch: number;
  branchEpoch: number;
  replyRunId: number;
  question: Readonly<{ entryId: string; contentHash: string }>;
  replies: readonly ObservationRef[];
}>;

type DeliveryState = Readonly<{
  enabled: boolean;
  mode: string;
  sessionEpoch: number;
  branchEpoch: number;
  opportunityId: string | undefined;
  relevant: boolean;
  idle: boolean;
  pendingMessages: boolean;
}>;

type Timer = ReturnType<typeof setTimeout>;

type Clock = Readonly<{
  now(): number;
  setTimeout(callback: () => void, delay: number): Timer;
  clearTimeout(timer: Timer): void;
}>;

type AdvisoryMessage = Readonly<{
  customType: typeof ADVISORY_CUSTOM_TYPE;
  content: string;
  display: true;
  details: Readonly<{
    kind: AdvisoryDeliveryKind;
    opportunityId: string;
    sendId: string;
  }>;
}>;

type DeliveryOptions = Readonly<{
  state(): DeliveryState;
  branch(): readonly unknown[];
  sendMessage(
    message: AdvisoryMessage,
    options: Readonly<{ deliverAs: "steer"; triggerTurn: true }>,
  ): void;
  uuid?(): string;
  clock?: Clock;
  onReconciliationSettled?(receipt: ReconciliationSettlement): void;
}>;

type Phase = "pending" | "confirmed" | "exhausted" | "cancelled";

interface Chain {
  request: ReconciliationDeliveryRequest;
  baselineLength: number;
  baselineAnchor: unknown;
  attemptedIds: string[];
  generation: number;
  phase: Phase;
  timer?: Timer;
  candidateOwnRun: boolean;
  /** A correction steers this already-started run; it never owns it. */
  independentRun?: number;
  ownRun?: number;
  settledRun?: number;
  external: boolean;
  canonical: boolean;
  revoked: boolean;
}

const defaultClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

const isSafeEpoch = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const validUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length === 36 &&
  Buffer.byteLength(value, "utf8") === 36 &&
  UUID_V4.test(value);

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const plainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === "string" && keys.includes(key))
  );
};

const entryAnchor = (entry: unknown) => {
  if (!plainObject(entry)) return entry;
  return typeof entry.id === "string" ? entry.id : entry;
};

const sameAnchor = (left: unknown, right: unknown) =>
  typeof left === "string" && typeof right === "string"
    ? left === right
    : left === right;

const isExternalEntry = (entry: unknown) => {
  if (!plainObject(entry)) return false;
  if (
    entry.type === "custom_message" &&
    entry.customType === "intercom_message"
  )
    return true;
  if (entry.type !== "message" || !plainObject(entry.message)) return false;
  return entry.message.role === "user";
};

/**
 * One live, non-persistent reconciliation delivery chain. It owns transport
 * correlation only; state/relevance remain index-owned copied authority.
 */
export class ReconciliationDelivery {
  private chain: Chain | undefined;
  private disposed = false;
  private nextGeneration = 0;
  private latestRun = 0;
  private lastSettledRun = 0;
  private readonly clock: Clock;
  private readonly uuid: () => string;

  constructor(private readonly options: DeliveryOptions) {
    this.clock = options.clock ?? defaultClock;
    this.uuid = options.uuid ?? randomUUID;
  }

  request(
    value: ReconciliationDeliveryRequest,
  ): "started" | "duplicate" | "suppressed" {
    if (this.disposed || !this.validRequest(value)) return "suppressed";
    const current = this.chain;
    if (current) {
      return current.request.opportunityId === value.opportunityId
        ? "duplicate"
        : "suppressed";
    }

    const branch = this.readBranch();
    if (!branch || !this.initialGuard(value)) return "suppressed";
    const chain: Chain = {
      request: { ...value },
      baselineLength: branch.length,
      baselineAnchor: entryAnchor(branch.at(-1)),
      attemptedIds: [],
      generation: ++this.nextGeneration,
      phase: "pending",
      candidateOwnRun: false,
      ...(this.isCorrection(value.kind) && this.latestRun > this.lastSettledRun
        ? { independentRun: this.latestRun }
        : {}),
      external: false,
      canonical: false,
      revoked: false,
    };
    this.chain = chain;
    this.invoke(chain);
    return chain.attemptedIds.length > 0 ? "started" : "suppressed";
  }

  onInput(): void {
    const chain = this.chain;
    if (!chain) return;
    // Input hook is authoritative even before branch canonicalization catches up.
    // Retain candidate ownership for an already-invoked custom turn; its later
    // start still belongs to this chain and settles as mixed external work.
    chain.external = true;
    this.cancel("external-input");
  }

  onAgentStart(): void {
    if (this.disposed) return;
    const run = ++this.latestRun;
    const chain = this.chain;
    if (!chain) return;
    if (
      chain.independentRun !== undefined &&
      chain.independentRun > this.lastSettledRun
    ) {
      // A correction remains attached to externally-started work even if Pi
      // reports an additional start before that work settles.
      chain.independentRun = run;
      return;
    }
    if (
      chain.candidateOwnRun ||
      (chain.ownRun !== undefined && chain.ownRun > this.lastSettledRun)
    ) {
      // Pi may restart an active turn for retry or compaction without an
      // intervening settlement. Keep this chain correlated to final run.
      chain.candidateOwnRun = false;
      chain.ownRun = run;
      return;
    }
    // A noncandidate start after prior settlement is independent work, not a
    // continuation of an old terminal or uncertain advisory chain.
    this.clearChain(chain);
  }

  onMessageEnd(message: unknown, branch: readonly unknown[]): void {
    const chain = this.chain;
    if (this.disposed || !chain) return;
    if (!this.branchMatchesBaseline(chain, branch)) {
      this.cancel("branch-changed");
      return;
    }
    if (this.matches(chain, message)) this.confirm(chain);
    this.scan(chain, branch);
  }

  onContext(branch: readonly unknown[]): void {
    const chain = this.chain;
    if (this.disposed || !chain) return;
    if (!this.branchMatchesBaseline(chain, branch)) {
      this.cancel("branch-changed");
      return;
    }
    this.scan(chain, branch);
  }

  onAgentSettled(branch: readonly unknown[]): SettlementOrigin | undefined {
    if (this.disposed || this.latestRun <= this.lastSettledRun) return;
    const run = this.latestRun;
    this.lastSettledRun = run;
    const chain = this.chain;
    if (!chain || (chain.ownRun !== run && chain.independentRun !== run))
      return "independent";

    if (this.branchMatchesBaseline(chain, branch)) this.scan(chain, branch);
    else this.cancel("branch-changed");

    chain.settledRun = run;
    const origin: SettlementOrigin =
      chain.external || chain.independentRun === run
        ? chain.canonical
          ? "mixed-external"
          : "external"
        : chain.canonical
          ? "advisory-only"
          : "uncertain-advisory";

    // An uncertain settlement may retain ordinary retry transport, but it can
    // never later become continuation receipt authority.
    if (origin === "uncertain-advisory") chain.revoked = true;
    const receipt =
      origin === "advisory-only" && this.options.onReconciliationSettled
        ? this.settlementReceipt(chain, branch, run)
        : undefined;

    // Retain only a still-live uncertain chain so its bounded retry/grace work
    // can gather canonical evidence. All terminal chains must release future
    // opportunities before a passive receipt observer can acquire transport.
    if (origin !== "uncertain-advisory" || chain.phase !== "pending")
      this.clearChain(chain);
    if (receipt) {
      try {
        this.options.onReconciliationSettled?.(receipt);
      } catch {
        // Passive observers cannot alter settlement origin or transport state.
      }
    }
    return origin;
  }

  onMasterOff(): void {
    this.cancel("master-off");
  }

  /** Source-turn ownership is index-only; never apply it to reconciliation. */
  onCorrectionRunInvalidated(): void {
    const chain = this.chain;
    if (chain && this.isCorrection(chain.request.kind))
      this.cancel("correction-source-ended");
  }

  onNavigation(): void {
    this.erase();
  }

  onSessionShutdown(): void {
    this.erase();
  }

  dispose(): void {
    if (this.disposed) return;
    this.erase();
    this.disposed = true;
  }

  private invoke(chain: Chain): void {
    if (this.chain !== chain || chain.phase !== "pending") return;
    if (!this.precheck(chain)) return;

    let sendId: string;
    try {
      sendId = this.uuid();
    } catch {
      this.cancel("invalid-request");
      return;
    }
    if (!validUuid(sendId) || chain.attemptedIds.includes(sendId)) {
      this.cancel("invalid-request");
      return;
    }

    chain.attemptedIds.push(sendId);
    chain.candidateOwnRun = chain.independentRun === undefined;
    const message: AdvisoryMessage = {
      customType: ADVISORY_CUSTOM_TYPE,
      content: chain.request.content,
      display: true,
      details: {
        kind: chain.request.kind,
        opportunityId: chain.request.opportunityId,
        sendId,
      },
    };
    try {
      this.options.sendMessage(message, {
        deliverAs: "steer",
        triggerTurn: true,
      });
    } catch {
      // Fire-and-forget transport has no acknowledgement. A throw still spends
      // this bounded attempt and follows the normal retry schedule.
    }
    if (this.chain !== chain || chain.phase !== "pending") return;
    this.arm(chain);
  }

  private arm(chain: Chain): void {
    if (this.chain !== chain || chain.timer !== undefined) return;
    const attempt = chain.attemptedIds.length;
    const delay =
      attempt < MAX_ATTEMPTS
        ? RETRY_DELAYS_MS[attempt - 1]
        : FINAL_EVIDENCE_GRACE_MS;
    if (delay === undefined) return;
    const generation = chain.generation;
    let timer: Timer;
    timer = this.clock.setTimeout(() => {
      if (
        this.chain !== chain ||
        chain.generation !== generation ||
        chain.timer !== timer
      )
        return;
      chain.timer = undefined;
      if (chain.phase !== "pending") return;
      if (chain.attemptedIds.length === MAX_ATTEMPTS) {
        chain.phase = "exhausted";
        if (chain.settledRun !== undefined) this.clearChain(chain);
        return;
      }
      this.invoke(chain);
    }, delay);
    chain.timer = timer;
  }

  private precheck(chain: Chain): boolean {
    const branch = this.readBranch();
    if (!branch || !this.branchMatchesBaseline(chain, branch)) {
      this.cancel("branch-changed");
      return false;
    }
    this.scan(chain, branch);
    if (chain.phase !== "pending") return false;

    let state: DeliveryState;
    try {
      state = this.options.state();
    } catch {
      this.cancel("invalid-request");
      return false;
    }
    const ownRunActive =
      chain.ownRun === this.latestRun && this.latestRun > this.lastSettledRun;
    const independentRunActive =
      chain.independentRun === this.latestRun &&
      this.latestRun > this.lastSettledRun;
    if (
      !state.enabled ||
      (state.mode !== "tui" && state.mode !== "rpc") ||
      state.sessionEpoch !== chain.request.sessionEpoch ||
      state.branchEpoch !== chain.request.branchEpoch ||
      state.opportunityId !== chain.request.opportunityId ||
      !state.relevant ||
      state.pendingMessages ||
      (!state.idle && !ownRunActive && !independentRunActive)
    ) {
      this.cancel("opportunity-stale");
      return false;
    }
    return true;
  }

  private initialGuard(request: ReconciliationDeliveryRequest): boolean {
    let state: DeliveryState;
    try {
      state = this.options.state();
    } catch {
      return false;
    }
    return (
      state.enabled &&
      (state.mode === "tui" || state.mode === "rpc") &&
      state.sessionEpoch === request.sessionEpoch &&
      state.branchEpoch === request.branchEpoch &&
      state.opportunityId === request.opportunityId &&
      state.relevant &&
      (state.idle || this.isCorrection(request.kind)) &&
      !state.pendingMessages
    );
  }

  private validRequest(value: ReconciliationDeliveryRequest): boolean {
    if (
      !value ||
      (value.kind !== RECONCILIATION_KIND && !this.isCorrection(value.kind)) ||
      !validUuid(value.opportunityId) ||
      typeof value.content !== "string" ||
      !isSafeEpoch(value.sessionEpoch) ||
      !isSafeEpoch(value.branchEpoch)
    )
      return false;
    return (
      Buffer.byteLength(value.content, "utf8") <= MAX_CONTENT_UTF8_BYTES &&
      Buffer.byteLength(JSON.stringify(value.content), "utf8") - 2 <=
        MAX_CONTENT_JSON_BODY_BYTES
    );
  }

  private isCorrection(kind: AdvisoryDeliveryKind) {
    return CORRECTION_KINDS.has(kind);
  }

  private readBranch(): readonly unknown[] | undefined {
    try {
      const branch = this.options.branch();
      return Array.isArray(branch) ? branch : undefined;
    } catch {
      return undefined;
    }
  }

  private branchMatchesBaseline(
    chain: Chain,
    branch: readonly unknown[],
  ): boolean {
    return (
      branch.length >= chain.baselineLength &&
      sameAnchor(
        entryAnchor(branch[chain.baselineLength - 1]),
        chain.baselineAnchor,
      )
    );
  }

  private settlementReceipt(
    chain: Chain,
    branch: readonly unknown[],
    run: number,
  ): ReconciliationSettlement | undefined {
    try {
      if (
        chain.request.kind !== RECONCILIATION_KIND ||
        chain.revoked ||
        chain.phase !== "confirmed" ||
        chain.ownRun !== run ||
        !this.receiptStateCurrent(chain)
      )
        return;

      const suffixLength = branch.length - chain.baselineLength;
      if (suffixLength <= 0 || suffixLength > MAX_SETTLEMENT_SUFFIX_ENTRIES)
        return;
      const suffix = branch.slice(chain.baselineLength);
      const idCounts = new Map<string, number>();
      let question: Record<string, unknown> | undefined;
      let questionIndex = -1;
      for (let index = 0; index < suffix.length; index++) {
        const entry = suffix[index];
        if (!plainObject(entry)) continue;
        if (typeof entry.id === "string")
          idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1);
        if (!this.matches(chain, entry)) continue;
        if (question) return;
        question = entry;
        questionIndex = index;
      }
      if (!question || questionIndex < 0) return;

      const questionId = question.id;
      const details = question.details;
      if (
        typeof questionId !== "string" ||
        !questionId ||
        !this.receiptStringFits(questionId) ||
        idCounts.get(questionId) !== 1 ||
        !plainObject(details) ||
        typeof details.sendId !== "string" ||
        !this.receiptStringFits(details.sendId)
      )
        return;

      for (const entry of suffix) {
        if (this.containsSubstantiveTool(entry)) return;
      }

      const replies: ObservationRef[] = [];
      let serializedBytes = 2; // JSON array brackets for visible observations.
      for (let index = questionIndex + 1; index < suffix.length; index++) {
        const entry = suffix[index];
        if (
          !plainObject(entry) ||
          entry.type !== "message" ||
          !plainObject(entry.message) ||
          entry.message.role !== "assistant"
        )
          continue;

        if (entry.message.stopReason !== "stop") return;
        const entryId = entry.id;
        if (
          typeof entryId !== "string" ||
          !entryId ||
          !this.receiptStringFits(entryId) ||
          idCounts.get(entryId) !== 1 ||
          replies.length >= MAX_SETTLEMENT_REPLIES
        )
          return;
        const text = this.receiptVisibleText(entry.message.content);
        if (!text?.trim()) return;
        const observationBytes = this.receiptObservationBytes(entryId, text);
        if (
          observationBytes === undefined ||
          serializedBytes + (replies.length ? 1 : 0) + observationBytes >
            MAX_SETTLEMENT_VISIBLE_BYTES
        )
          return;
        serializedBytes += (replies.length ? 1 : 0) + observationBytes;
        replies.push({
          entryId,
          messageHash: sha256(text),
          role: "assistant",
        });
      }
      if (replies.length === 0) return;

      const frozenReplies = Object.freeze(
        replies.map((reply) => Object.freeze({ ...reply })),
      );
      return Object.freeze({
        kind: RECONCILIATION_KIND,
        opportunityId: chain.request.opportunityId,
        sendId: details.sendId,
        sessionEpoch: chain.request.sessionEpoch,
        branchEpoch: chain.request.branchEpoch,
        replyRunId: run,
        question: Object.freeze({
          entryId: questionId,
          contentHash: sha256(chain.request.content),
        }),
        replies: frozenReplies,
      });
    } catch {
      // Host transcript shape is untrusted; invalid evidence only abstains.
      return;
    }
  }

  private receiptStateCurrent(chain: Chain): boolean {
    try {
      const state = this.options.state();
      return (
        state.enabled &&
        (state.mode === "tui" || state.mode === "rpc") &&
        state.sessionEpoch === chain.request.sessionEpoch &&
        state.branchEpoch === chain.request.branchEpoch &&
        state.opportunityId === chain.request.opportunityId &&
        state.relevant &&
        state.idle &&
        !state.pendingMessages
      );
    } catch {
      return false;
    }
  }

  /** Inspect block kinds only; never read tool arguments, results, or thoughts. */
  private containsSubstantiveTool(entry: unknown): boolean {
    if (
      !plainObject(entry) ||
      entry.type !== "message" ||
      !plainObject(entry.message)
    )
      return false;
    const message = entry.message;
    if (message.role === "toolResult" || message.role === "tool") return true;
    if (!Array.isArray(message.content)) return false;
    return message.content.some((block) => {
      if (!plainObject(block)) return false;
      return (
        block.type === "toolCall" ||
        block.type === "toolResult" ||
        block.type === "tool_use" ||
        block.type === "tool_result"
      );
    });
  }

  /** Existing canonical visible-text normalization, with admission before hash. */
  private receiptVisibleText(content: unknown): string | undefined {
    if (typeof content === "string")
      return Buffer.byteLength(content, "utf8") <= MAX_SETTLEMENT_VISIBLE_BYTES
        ? content
        : undefined;
    if (!Array.isArray(content)) return;

    let text = "";
    let bytes = 0;
    for (const block of content) {
      if (
        !plainObject(block) ||
        block.type !== "text" ||
        typeof block.text !== "string"
      )
        continue;
      const blockBytes = Buffer.byteLength(block.text, "utf8");
      if (bytes + blockBytes > MAX_SETTLEMENT_VISIBLE_BYTES) return;
      bytes += blockBytes;
      text += block.text;
    }
    return text;
  }

  private receiptStringFits(value: string): boolean {
    return Buffer.byteLength(value, "utf8") <= MAX_SETTLEMENT_VISIBLE_BYTES;
  }

  private receiptObservationBytes(entryId: string, text: string) {
    const serialized = JSON.stringify({
      id: entryId,
      role: "assistant",
      text,
      hash: RECEIPT_HASH_PLACEHOLDER,
    });
    return Buffer.byteLength(serialized, "utf8");
  }

  private scan(chain: Chain, branch: readonly unknown[]): void {
    const suffix = branch.slice(chain.baselineLength);
    if (suffix.some(isExternalEntry)) {
      chain.external = true;
      this.clearTimer(chain);
      // A previously uncertain run cannot receive a second settlement.
      // Late authoritative external work therefore releases its old chain now.
      if (chain.settledRun !== undefined) {
        this.clearChain(chain);
        return;
      }
    }
    if (suffix.some((entry) => this.matches(chain, entry))) {
      chain.canonical = true;
      this.confirm(chain);
    }
  }

  private matches(chain: Chain, candidate: unknown): boolean {
    if (!plainObject(candidate)) return false;
    const isCustom =
      candidate.role === "custom" || candidate.type === "custom_message";
    if (
      !isCustom ||
      candidate.customType !== ADVISORY_CUSTOM_TYPE ||
      candidate.content !== chain.request.content ||
      candidate.display !== true ||
      !plainObject(candidate.details) ||
      !exactKeys(candidate.details, ["kind", "opportunityId", "sendId"])
    )
      return false;
    return (
      candidate.details.kind === chain.request.kind &&
      candidate.details.opportunityId === chain.request.opportunityId &&
      typeof candidate.details.sendId === "string" &&
      chain.attemptedIds.includes(candidate.details.sendId)
    );
  }

  private confirm(chain: Chain): void {
    if (this.chain !== chain) return;
    chain.phase = "confirmed";
    this.clearTimer(chain);
    // Confirmation may arrive after an uncertain settlement, whose result was
    // already handed off. Release instead of waiting for an impossible repeat.
    if (chain.settledRun !== undefined) this.clearChain(chain);
  }

  private cancel(_reason: string): void {
    const chain = this.chain;
    if (!chain) return;
    this.clearTimer(chain);
    chain.revoked = true;
    chain.phase = "cancelled";
    if (chain.settledRun !== undefined) this.clearChain(chain);
  }

  private clearChain(chain: Chain): void {
    if (this.chain !== chain) return;
    this.clearTimer(chain);
    this.chain = undefined;
  }

  private erase(): void {
    const chain = this.chain;
    if (chain) this.clearTimer(chain);
    this.chain = undefined;
    this.latestRun = 0;
    this.lastSettledRun = 0;
  }

  private clearTimer(chain: Chain): void {
    if (chain.timer === undefined) return;
    this.clock.clearTimeout(chain.timer);
    chain.timer = undefined;
  }
}
