import { taskLabelIsValid } from "../core/hybrid-state";

const RECONCILIATION_DELAY_MS = 60_000;
const MAX_ROWS = 20;
const MAX_TASK_ID_BYTES = 21;
const MAX_CONTENT_BYTES = 24_576;
const MAX_JSON_STRING_BODY_BYTES = 32_768;

const heading = "The progress board still lists these tasks as unfinished:";
const question =
  "What is the actual status of each task? Please report what is complete, still pending, or blocked, and why. This is a status question, not evidence that any task is complete.";

export type SettlementOrigin =
  | "independent"
  | "advisory-only"
  | "mixed-external"
  | "external"
  | "uncertain-advisory";

interface ReconciliationRow {
  id: string;
  label: string;
  status: string;
  included: boolean;
  revision: number;
}

/** Copied Monitor facts only; controller has no Monitor or host capability. */
export interface ReconciliationSnapshot {
  enabled: boolean;
  reason: string;
  tasks: readonly ReconciliationRow[];
}

interface ReconciliationRequest {
  runId: number;
  content: string;
}

type Timer = ReturnType<typeof setTimeout>;

interface ReconciliationClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): Timer;
  clearTimeout(timer: Timer): void;
}

export interface ReconciliationControllerOptions {
  snapshot(): ReconciliationSnapshot;
  emit(request: ReconciliationRequest): void;
  clock: ReconciliationClock;
}

interface Intent {
  runId: number;
  deadline: number;
  timer?: Timer;
}

const validRunId = (value: number) => Number.isSafeInteger(value) && value >= 0;
const supportedOrigin = (origin: SettlementOrigin) =>
  origin === "independent" ||
  origin === "mixed-external" ||
  origin === "external";

const taskIdIsValid = (value: string) => {
  if (
    !/^task:[1-9]\d*$/.test(value) ||
    Buffer.byteLength(value) > MAX_TASK_ID_BYTES
  )
    return false;
  const valueNumber = Number(value.slice("task:".length));
  return Number.isSafeInteger(valueNumber) && valueNumber >= 1;
};

/** Return all unfinished rows or nothing; never shorten an advisory board. */
const formatMessage = (
  tasks: readonly ReconciliationRow[],
): string | undefined => {
  const unfinished = tasks.filter(
    (task) => task.included && task.status !== "done",
  );
  if (
    unfinished.length === 0 ||
    unfinished.length > MAX_ROWS ||
    !unfinished.every(
      (task) => taskIdIsValid(task.id) && taskLabelIsValid(task.label),
    )
  )
    return undefined;

  const content = `${heading}\n${unfinished
    .map((task) => `${task.id} — ${task.label}`)
    .join("\n")}\n\n${question}`;
  const jsonString = JSON.stringify(content);
  if (
    Buffer.byteLength(content) > MAX_CONTENT_BYTES ||
    Buffer.byteLength(jsonString) - 2 > MAX_JSON_STRING_BODY_BYTES
  )
    return undefined;
  return content;
};

/**
 * One in-memory reconciliation opportunity per current independent run.
 * Snapshot changes are considered only through lifecycle-driven refresh calls.
 */
export class ReconciliationController {
  private currentRunId: number | undefined;
  private settledRunId: number | undefined;
  private intent: Intent | undefined;
  private disposed = false;

  constructor(private readonly options: ReconciliationControllerOptions) {}

  runStarted(runId: number): void {
    if (this.disposed || !validRunId(runId) || this.currentRunId === runId)
      return;
    this.clearIntent();
    this.currentRunId = runId;
    this.settledRunId = undefined;
  }

  settled(runId: number, origin: SettlementOrigin): void {
    if (
      this.disposed ||
      !validRunId(runId) ||
      this.currentRunId !== runId ||
      this.settledRunId === runId
    )
      return;

    this.settledRunId = runId;
    if (!supportedOrigin(origin)) return;

    const deadline = this.options.clock.now() + RECONCILIATION_DELAY_MS;
    this.intent = { runId, deadline };
    this.arm(this.intent);
  }

  refresh(): void {
    const intent = this.intent;
    if (this.disposed || !intent) return;

    const snapshot = this.options.snapshot();
    if (!snapshot.enabled) {
      this.cancel();
      return;
    }
    if (this.options.clock.now() >= intent.deadline)
      this.emitIfEligible(intent, snapshot);
  }

  /** Drop a delayed advisory without invalidating the active run lifecycle. */
  clearPendingIntent(): void {
    this.clearIntent();
  }

  cancel(): void {
    this.clearPendingIntent();
    this.currentRunId = undefined;
    this.settledRunId = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
  }

  private arm(intent: Intent): void {
    const delay = intent.deadline - this.options.clock.now();
    if (delay <= 0) {
      this.emitIfEligible(intent);
      return;
    }

    let timer: Timer;
    timer = this.options.clock.setTimeout(() => {
      if (this.intent !== intent || intent.timer !== timer) return;
      intent.timer = undefined;
      this.emitIfEligible(intent);
    }, delay);
    intent.timer = timer;
  }

  private emitIfEligible(
    intent: Intent,
    currentSnapshot?: ReconciliationSnapshot,
  ): void {
    if (this.disposed || this.intent !== intent) return;

    if (intent.timer !== undefined) {
      this.options.clock.clearTimeout(intent.timer);
      intent.timer = undefined;
    }

    const snapshot = currentSnapshot ?? this.options.snapshot();
    if (!snapshot.enabled) {
      this.cancel();
      return;
    }
    if (snapshot.reason !== "ready") return;

    const content = formatMessage(snapshot.tasks);
    if (!content) {
      this.intent = undefined;
      return;
    }

    // Clear before callback: synchronous refresh/settlement cannot send twice.
    this.intent = undefined;
    this.options.emit({ runId: intent.runId, content });
  }

  private clearIntent(): void {
    if (this.intent?.timer !== undefined)
      this.options.clock.clearTimeout(this.intent.timer);
    this.intent = undefined;
  }
}
