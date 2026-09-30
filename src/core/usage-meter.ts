import { nonNegativeInteger } from "../shared/guards";
import { RetryableProviderError } from "./hybrid";

export interface ProviderUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

/** Lifetime provider spend plus last-dispatch timestamps. */
export interface UsageTelemetry {
  usage: { jev: ProviderUsage; extraction: ProviderUsage };
  lastJevCallAt?: number;
  lastExtractionCallAt?: number;
}

type JevTokens = { input_tokens: number; output_tokens: number };
type ExtractionTokens = { inputTokens: number; outputTokens: number };

const copyUsage = (usage: ProviderUsage): ProviderUsage => ({ ...usage });
const validUsage = (usage: ProviderUsage) => {
  if (
    !nonNegativeInteger(usage.calls) ||
    !nonNegativeInteger(usage.inputTokens) ||
    !nonNegativeInteger(usage.outputTokens)
  )
    throw new Error("Invalid provider usage");
  return { ...usage };
};
/** Never form an unsafe intermediate while preserving monotonic lifetime usage. */
export const saturatingAdd = (current: number, delta: number) => {
  if (!nonNegativeInteger(current) || !nonNegativeInteger(delta))
    throw new RetryableProviderError();
  return delta > Number.MAX_SAFE_INTEGER - current
    ? Number.MAX_SAFE_INTEGER
    : current + delta;
};
const maxUsage = (
  left: ProviderUsage,
  right: ProviderUsage,
): ProviderUsage => ({
  calls: Math.max(left.calls, right.calls),
  inputTokens: Math.max(left.inputTokens, right.inputTokens),
  outputTokens: Math.max(left.outputTokens, right.outputTokens),
});
const maxAt = (left?: number, right?: number) =>
  Math.max(left ?? 0, right ?? 0) || undefined;

/** Same-source monotonic merge of persisted and live lifetime telemetry. */
export const mergeUsageTelemetry = (
  base: UsageTelemetry,
  live: UsageTelemetry,
): UsageTelemetry => ({
  usage: {
    jev: maxUsage(base.usage.jev, live.usage.jev),
    extraction: maxUsage(base.usage.extraction, live.usage.extraction),
  },
  lastJevCallAt: maxAt(base.lastJevCallAt, live.lastJevCallAt),
  lastExtractionCallAt: maxAt(
    base.lastExtractionCallAt,
    live.lastExtractionCallAt,
  ),
});

/** Lifetime provider spend; resets only with its source. */
export class UsageMeter {
  readonly usage = {
    jev: { calls: 0, inputTokens: 0, outputTokens: 0 },
    extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
  };
  lastJevCallAt?: number;
  lastExtractionCallAt?: number;

  /** Count every transport dispatch, including failed/retried same-ms attempts. */
  recordJevDispatch(at: number) {
    this.lastJevCallAt = at;
    this.usage.jev.calls = saturatingAdd(this.usage.jev.calls, 1);
  }

  recordExtractionDispatch(at: number) {
    this.lastExtractionCallAt = at;
    this.usage.extraction.calls = saturatingAdd(this.usage.extraction.calls, 1);
  }

  addJev(tokens: JevTokens) {
    this.usage.jev.inputTokens = saturatingAdd(
      this.usage.jev.inputTokens,
      tokens.input_tokens,
    );
    this.usage.jev.outputTokens = saturatingAdd(
      this.usage.jev.outputTokens,
      tokens.output_tokens,
    );
  }

  addExtraction(tokens: ExtractionTokens) {
    this.usage.extraction.inputTokens = saturatingAdd(
      this.usage.extraction.inputTokens,
      tokens.inputTokens,
    );
    this.usage.extraction.outputTokens = saturatingAdd(
      this.usage.extraction.outputTokens,
      tokens.outputTokens,
    );
  }

  /** Jev token totals for an all-or-nothing optional transaction. */
  jevTokens() {
    return {
      inputTokens: this.usage.jev.inputTokens,
      outputTokens: this.usage.jev.outputTokens,
    };
  }

  restoreJevTokens(tokens: ExtractionTokens) {
    this.usage.jev.inputTokens = tokens.inputTokens;
    this.usage.jev.outputTokens = tokens.outputTokens;
  }

  /** Detached copy; zero timestamps are omitted. */
  telemetry(): UsageTelemetry {
    return {
      usage: {
        jev: copyUsage(this.usage.jev),
        extraction: copyUsage(this.usage.extraction),
      },
      ...(this.lastJevCallAt ? { lastJevCallAt: this.lastJevCallAt } : {}),
      ...(this.lastExtractionCallAt
        ? { lastExtractionCallAt: this.lastExtractionCallAt }
        : {}),
    };
  }

  /** Validated persistence fragment; invalid live usage rejects the checkpoint. */
  metadata(): UsageTelemetry {
    return {
      usage: {
        jev: validUsage(this.usage.jev),
        extraction: validUsage(this.usage.extraction),
      },
      ...(this.lastJevCallAt ? { lastJevCallAt: this.lastJevCallAt } : {}),
      ...(this.lastExtractionCallAt
        ? { lastExtractionCallAt: this.lastExtractionCallAt }
        : {}),
    };
  }

  /** Adopt persisted telemetry exactly; absent metadata is zero. */
  load(metadata: UsageTelemetry | undefined) {
    this.lastJevCallAt = metadata?.lastJevCallAt;
    this.lastExtractionCallAt = metadata?.lastExtractionCallAt;
    const usage = metadata?.usage;
    this.usage.jev.calls = usage?.jev.calls ?? 0;
    this.usage.jev.inputTokens = usage?.jev.inputTokens ?? 0;
    this.usage.jev.outputTokens = usage?.jev.outputTokens ?? 0;
    this.usage.extraction.calls = usage?.extraction.calls ?? 0;
    this.usage.extraction.inputTokens = usage?.extraction.inputTokens ?? 0;
    this.usage.extraction.outputTokens = usage?.extraction.outputTokens ?? 0;
  }

  /** Monotonic same-source merge after adopting persisted metadata. */
  merge(telemetry: UsageTelemetry) {
    const merged = mergeUsageTelemetry(this.telemetry(), telemetry);
    Object.assign(this.usage.jev, merged.usage.jev);
    Object.assign(this.usage.extraction, merged.usage.extraction);
    this.lastJevCallAt = merged.lastJevCallAt;
    this.lastExtractionCallAt = merged.lastExtractionCallAt;
  }

  reset() {
    this.load(undefined);
  }
}
