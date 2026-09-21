import { randomUUID } from "node:crypto";

const ADVISORY_CUSTOM_TYPE = "pi-progress-advisory" as const;
const RECONCILIATION_KIND = "reconciliation" as const;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2_000, 8_000] as const;
const FINAL_EVIDENCE_GRACE_MS = 8_000;
const MAX_CONTENT_UTF8_BYTES = 24 * 1024;
const MAX_CONTENT_JSON_BODY_BYTES = 32 * 1024;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type SettlementOrigin =
  | "advisory-only"
  | "mixed-external"
  | "external"
  | "uncertain-advisory"
  | "independent";

export type ReconciliationDeliveryRequest = Readonly<{
  kind: "reconciliation";
  opportunityId: string;
  content: string;
  sessionEpoch: number;
  branchEpoch: number;
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
    kind: typeof RECONCILIATION_KIND;
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
  ownRun?: number;
  settledRun?: number;
  external: boolean;
  canonical: boolean;
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
      external: false,
      canonical: false,
    };
    this.chain = chain;
    this.invoke(chain);
    return chain.attemptedIds.length > 0 ? "started" : "suppressed";
  }

  onInput(): void {
    this.cancel("external-input");
  }

  onAgentStart(): void {
    if (this.disposed) return;
    const run = ++this.latestRun;
    const chain = this.chain;
    if (!chain) return;
    if (chain.candidateOwnRun) {
      chain.candidateOwnRun = false;
      chain.ownRun = run;
      return;
    }
    if (chain.ownRun !== run) this.cancel("new-external-run");
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
    if (!chain || chain.ownRun !== run) return "independent";

    if (this.branchMatchesBaseline(chain, branch)) this.scan(chain, branch);
    else this.cancel("branch-changed");

    chain.settledRun = run;
    const origin: SettlementOrigin = chain.external
      ? chain.canonical
        ? "mixed-external"
        : "external"
      : chain.canonical
        ? "advisory-only"
        : "uncertain-advisory";

    if (origin !== "uncertain-advisory") this.clearChain(chain);
    return origin;
  }

  onMasterOff(): void {
    this.cancel("master-off");
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
    chain.candidateOwnRun = true;
    const message: AdvisoryMessage = {
      customType: ADVISORY_CUSTOM_TYPE,
      content: chain.request.content,
      display: true,
      details: {
        kind: RECONCILIATION_KIND,
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
    if (
      !state.enabled ||
      (state.mode !== "tui" && state.mode !== "rpc") ||
      state.sessionEpoch !== chain.request.sessionEpoch ||
      state.branchEpoch !== chain.request.branchEpoch ||
      state.opportunityId !== chain.request.opportunityId ||
      !state.relevant ||
      state.pendingMessages ||
      (!state.idle && !ownRunActive)
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
      state.idle &&
      !state.pendingMessages
    );
  }

  private validRequest(value: ReconciliationDeliveryRequest): boolean {
    if (
      !value ||
      value.kind !== RECONCILIATION_KIND ||
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

  private scan(chain: Chain, branch: readonly unknown[]): void {
    const suffix = branch.slice(chain.baselineLength);
    if (suffix.some(isExternalEntry)) {
      chain.external = true;
      this.clearTimer(chain);
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
      candidate.details.kind === RECONCILIATION_KIND &&
      candidate.details.opportunityId === chain.request.opportunityId &&
      typeof candidate.details.sendId === "string" &&
      chain.attemptedIds.includes(candidate.details.sendId)
    );
  }

  private confirm(chain: Chain): void {
    if (this.chain !== chain) return;
    chain.phase = "confirmed";
    this.clearTimer(chain);
  }

  private cancel(_reason: string): void {
    const chain = this.chain;
    if (!chain) return;
    this.clearTimer(chain);
    chain.phase = "cancelled";
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
