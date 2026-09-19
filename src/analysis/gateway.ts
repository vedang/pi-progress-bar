import { createHash } from "node:crypto";

export const MODEL = "jev-1.13.0";
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const MAX_REQUEST_BYTES = 24 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_QUESTIONS = 20;
const DEADLINE_MS = 10_000;
const MIN_BACKOFF_MS = 10_000;
const COOLDOWN_MS = 5 * 60_000;
const MAX_BURST_FAILURES = 3;
type Question =
  | {
      type: "choice";
      instructions: string;
      criteria: Record<string, string | null>;
    }
  | { type: "score"; instructions: string; criteria: string[] };
export interface EvaluationRequest {
  model: string;
  state: unknown;
  questions: Record<string, Question>;
}
type Answer =
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      type: "score";
      score: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: number;
    };
export interface ValidatedResult {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
}
interface Options {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  getApiKey: () => string | undefined;
  now?: () => number;
  /** Called at transport admission, including eventual failures. */
  onDispatch?: (at: number) => void;
  onPermanentError?: (message: string) => void;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const unit = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;
const keysEqual = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

/**
 * Jev may serialize a distribution to cents. Permit only error explainable by
 * that quantization, capped well below a materially unnormalized response.
 */
const distributionTolerance = (probabilities: number[]) => {
  const cents = probabilities.every(
    (probability) =>
      Math.abs(probability * 100 - Math.round(probability * 100)) < 1e-8,
  );
  return cents ? Math.min(0.02, probabilities.length * 0.005 + 1e-9) : 0.001;
};
function validate(value: unknown, request: EvaluationRequest): ValidatedResult {
  if (
    !record(value) ||
    value.model !== MODEL ||
    !record(value.answers) ||
    !keysEqual(value.answers, Object.keys(request.questions)) ||
    !record(value.usage)
  )
    throw new Error("Invalid response");
  for (const field of ["input_tokens", "output_tokens"]) {
    const n = value.usage[field];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
      throw new Error("Invalid usage");
  }
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = value.answers[id];
    if (
      !record(answer) ||
      answer.type !== question.type ||
      !unit(answer.confidence) ||
      !record(answer.probabilities)
    )
      throw new Error("Invalid answer");
    const keys = Object.keys(question.criteria);
    const probabilities = answer.probabilities;
    const values = Object.values(probabilities) as number[];
    if (
      !keysEqual(probabilities, keys) ||
      !values.every(unit) ||
      Math.abs(values.reduce((sum, probability) => sum + probability, 0) - 1) >
        distributionTolerance(values)
    )
      throw new Error("Invalid distribution");
    if (question.type === "choice") {
      if (
        typeof answer.choice !== "string" ||
        !keys.includes(answer.choice) ||
        (probabilities[answer.choice] as number) < Math.max(...values)
      )
        throw new Error("Invalid choice");
    } else {
      if (
        typeof answer.score !== "number" ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > keys.length - 1 ||
        !record(answer.legend) ||
        !keysEqual(answer.legend, keys)
      )
        throw new Error("Invalid score");
      const legend = answer.legend;
      if (!question.criteria.every((label, i) => legend[String(i)] === label))
        throw new Error("Invalid legend");
    }
  }
  return value as unknown as ValidatedResult;
}
async function readBounded(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new Error("Oversized response");
  }
  if (!response.body) throw new Error("Empty response");
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      if (signal.aborted) throw new Error("Cancelled");
      const part = await reader.read();
      if (signal.aborted) throw new Error("Cancelled");
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Oversized response");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}
/** One transport authority; identities scope consent, input hashes suppress retries. */
export class JevGateway {
  status = "Disabled: consent required";
  /** Actual HTTP dispatch for this enabled runtime; never a tick/cache/result time. */
  private lastDispatchAt?: number;
  get lastCallAt() {
    return this.lastDispatchAt;
  }
  /** Read-only retry boundary for the scheduler's single one-shot wakeup. */
  get retryDelayMs(): number | undefined {
    const deadline = Math.max(this.nextAttempt, this.retryAfter);
    return Number.isFinite(deadline)
      ? Math.max(0, deadline - this.now())
      : undefined;
  }
  get retryPending() {
    const delay = this.retryDelayMs;
    return !this.paused && delay !== undefined && delay > 0;
  }
  private identity?: string;
  private paused = true;
  private generation = 0;
  private failures = 0;
  /** Direct gateway callers suppress only a bounded recent identity set. */
  private seen = new Map<string, true>();
  private nextAttempt = -Infinity;
  private retryAfter = -Infinity;
  private flight?: { controller: AbortController; cancel: () => void };
  private readonly now: () => number;
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
  }
  enable(identity: string) {
    this.pause();
    this.identity = identity;
    this.lastDispatchAt = undefined;
    this.paused = false;
    this.failures = 0;
    this.nextAttempt = -Infinity;
    this.retryAfter = -Infinity;
    this.seen.clear();
    this.status = "Ready";
  }
  invalidate() {
    this.generation++;
    const flight = this.flight;
    this.flight = undefined;
    flight?.controller.abort();
    flight?.cancel();
  }
  pause() {
    this.invalidate();
    this.paused = true;
    this.status = "Paused";
  }
  resume() {
    if (!this.identity) return;
    this.paused = false;
    this.status = "Ready";
  }
  async evaluate(
    request: EvaluationRequest,
    identity: string,
    allowDuplicate = false,
  ): Promise<ValidatedResult | undefined> {
    if (this.paused || identity !== this.identity) return;
    if (this.flight) return;
    let body: string;
    try {
      body = JSON.stringify(request);
      const questions = Object.values(request.questions);
      if (
        request.model !== MODEL ||
        Buffer.byteLength(body) > MAX_REQUEST_BYTES ||
        questions.length < 1 ||
        questions.length > MAX_QUESTIONS ||
        questions.some(
          (q) =>
            !q.instructions ||
            !q.criteria ||
            (q.type !== "choice" && q.type !== "score") ||
            (q.type === "score" &&
              (!Array.isArray(q.criteria) ||
                q.criteria.length < 2 ||
                !q.criteria.every((x) => typeof x === "string"))) ||
            (q.type === "choice" &&
              (!record(q.criteria) ||
                Object.keys(q.criteria).length < 2 ||
                !Object.values(q.criteria).every(
                  (x) => x === null || typeof x === "string",
                ))),
        )
      )
        throw new Error("Invalid request");
    } catch {
      this.status = "Unknown: invalid or oversized evidence/questions";
      return;
    }
    const hash = createHash("sha256")
      .update(identity)
      .update(body)
      .digest("hex");
    if (!allowDuplicate && this.seen.has(hash)) return;
    let key: string | undefined;
    try {
      key = this.options.getApiKey()?.trim();
    } catch {
      this.status = "Offline: API key unavailable";
      return;
    }
    if (!key) {
      this.status = "Offline: missing TYPESAFE_API_KEY";
      return;
    }
    if (this.now() < Math.max(this.nextAttempt, this.retryAfter)) {
      this.status = "Pending: retry backoff / cooldown / Retry-After";
      return;
    }
    const generation = this.generation;
    const controller = new AbortController();
    let cancel!: () => void;
    const cancelled = new Promise<undefined>((resolve) => {
      cancel = () => resolve(undefined);
    });
    const flight = { controller, cancel };
    this.flight = flight;
    this.status = "Pending";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Timeout"));
      }, DEADLINE_MS);
    });
    try {
      const work = async () => {
        // This is transport truth: update immediately before fetch, so failed
        // HTTP responses, throws and timeouts remain visible as real attempts.
        this.lastDispatchAt = this.now();
        try {
          this.options.onDispatch?.(this.lastDispatchAt);
        } catch {
          // Display observers never control transport admission.
        }
        const response = await this.options.fetch(ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body,
          signal: controller.signal,
        });
        if (generation !== this.generation || controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          return;
        }
        if (!response.ok) {
          if (
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 408 &&
            response.status !== 429
          ) {
            this.status =
              response.status === 401 || response.status === 403
                ? "OFF: TYPESAFE_API_KEY was rejected"
                : `OFF: permanent Jev request/model error (${response.status})`;
            this.paused = true;
            this.options.onPermanentError?.(this.status);
            void response.body?.cancel().catch(() => {});
            return;
          }
          const retry = response.headers.get("retry-after");
          if (retry) {
            const seconds = /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : NaN;
            const until = Number.isFinite(seconds)
              ? this.now() + seconds * 1000
              : Date.parse(retry);
            if (Number.isFinite(until))
              this.retryAfter = Math.max(this.retryAfter, until);
          }
          void response.body?.cancel().catch(() => {});
          throw new Error("Service error");
        }
        return validate(
          await readBounded(response, controller.signal),
          request,
        );
      };
      const result = await Promise.race([work(), timeout, cancelled]);
      if (generation !== this.generation) return;
      if (result) {
        this.seen.set(hash, true);
        if (this.seen.size > 200) {
          const first = this.seen.keys().next().value;
          if (first) this.seen.delete(first);
        }
        this.failures = 0;
        this.nextAttempt = -Infinity;
        this.retryAfter = -Infinity;
        this.status = "Current";
      }
      return result;
    } catch {
      if (generation === this.generation) {
        this.failures++;
        if (this.retryAfter > this.now()) {
          this.nextAttempt = -Infinity;
          this.status = "Pending: Retry-After";
        } else if (this.failures >= MAX_BURST_FAILURES) {
          this.failures = 0;
          this.nextAttempt = this.now() + COOLDOWN_MS;
          this.status = "Offline: retry cooldown (5 minutes)";
        } else {
          this.nextAttempt =
            this.now() + MIN_BACKOFF_MS * 2 ** (this.failures - 1);
          this.status =
            "Offline / invalid response / timeout; retry backed off";
        }
      }
      return;
    } finally {
      if (timer) clearTimeout(timer);
      if (this.flight === flight) this.flight = undefined;
    }
  }
}
