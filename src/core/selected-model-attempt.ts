import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { record } from "../shared/guards";

type HostContext = Pick<ExtensionContext, "model" | "modelRegistry">;
type HostModel = NonNullable<ExtensionContext["model"]>;

type BoundContext = {
  model: HostModel;
  registry: ExtensionContext["modelRegistry"];
  provider: string;
  id: string;
};

interface SelectedModelAttemptResult {
  text: string;
  model: string;
  provider: string;
  requestHash: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** Per-purpose limits, prompt and request proof for one bounded attempt. */
export interface SelectedModelAttemptSpec<
  Request extends { requestHash: string },
> {
  unavailableMessage: string;
  systemPrompt: string;
  maxOutputBytes: number;
  maxTokens: number;
  deadlineMs: number;
  isRequest: (request: unknown) => request is Request;
  /** `provider/id` the request was built for; any other selection is refused. */
  selectedModel: (request: Request) => string;
  /** Exact wire text proven against `requestHash`; undefined refuses dispatch. */
  inputText: (request: Request) => string | undefined;
}

export type SelectedModelAttempt = (
  request: unknown,
  signal: AbortSignal,
  onDispatch?: (at: number) => boolean | undefined,
  onPhysicalFlight?: (drain: Promise<void>) => void,
) => Promise<SelectedModelAttemptResult>;

const textBlock = (value: unknown): value is { text: string } =>
  record(value) && value.type === "text" && typeof value.text === "string";

const thinkingBlock = (value: unknown): boolean =>
  record(value) &&
  value.type === "thinking" &&
  typeof value.thinking === "string";

/**
 * One bounded host-selected model attempt. Pi owns authentication; this owns
 * only request proof, current selected-model fences, and sanitized
 * transport/output boundaries. It never falls back, retries or exposes envelopes.
 */
export function selectedModelAttempt<Request extends { requestHash: string }>(
  spec: SelectedModelAttemptSpec<Request>,
  currentContext: () => HostContext,
): SelectedModelAttempt {
  const unavailable = () => new Error(spec.unavailableMessage);

  const usageNumber = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw unavailable();
    return value;
  };

  const bindContext = (request: Request): BoundContext => {
    const context = currentContext();
    const model = context?.model;
    const registry = context?.modelRegistry;
    if (
      !model ||
      !registry ||
      typeof registry.complete !== "function" ||
      typeof model.provider !== "string" ||
      !model.provider ||
      typeof model.id !== "string" ||
      !model.id ||
      `${model.provider}/${model.id}` !== spec.selectedModel(request)
    )
      throw unavailable();
    return { model, registry, provider: model.provider, id: model.id };
  };

  const responseText = (response: unknown): string => {
    if (
      !record(response) ||
      response.stopReason !== "stop" ||
      !Array.isArray(response.content)
    )
      throw unavailable();
    const parts: string[] = [];
    let bytes = 0;
    let providerTextBytes = 0;
    for (const part of response.content) {
      if (textBlock(part)) {
        const separatorBytes = parts.length ? 1 : 0;
        const partBytes = Buffer.byteLength(part.text, "utf8");
        if (bytes + separatorBytes + partBytes > spec.maxOutputBytes)
          throw unavailable();
        bytes += separatorBytes + partBytes;
        providerTextBytes += partBytes;
        parts.push(part.text);
        continue;
      }
      if (!thinkingBlock(part)) throw unavailable();
    }
    if (!providerTextBytes) throw unavailable();
    return parts.join("\n");
  };

  const responseUsage = (response: unknown) => {
    if (!record(response) || !record(response.usage)) throw unavailable();
    const usage = response.usage;
    return {
      inputTokens: usageNumber(usage.inputTokens ?? usage.input),
      outputTokens: usageNumber(usage.outputTokens ?? usage.output),
    };
  };

  return async (request, signal, onDispatch, onPhysicalFlight) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbort = () => {};
    try {
      if (signal.aborted || !spec.isRequest(request)) throw unavailable();
      const text = spec.inputText(request);
      if (text === undefined) throw unavailable();
      bindContext(request);

      const admitted = onDispatch?.(Date.now());
      if (admitted === false || signal.aborted) throw unavailable();
      const beforeDispatch = bindContext(request);

      const controller = new AbortController();
      let rejectAbort: (reason: Error) => void = () => {};
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = reject;
      });
      const abort = () => {
        controller.abort();
        rejectAbort(unavailable());
      };
      signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) {
        controller.abort();
        throw unavailable();
      }

      let rejectDeadline: (reason: Error) => void = () => {};
      const deadline = new Promise<never>((_, reject) => {
        rejectDeadline = reject;
      });
      timer = setTimeout(() => {
        controller.abort();
        rejectDeadline(unavailable());
      }, spec.deadlineMs);
      let physical: Promise<unknown>;
      try {
        physical = Promise.resolve(
          beforeDispatch.registry.complete(
            beforeDispatch.model,
            {
              systemPrompt: spec.systemPrompt,
              messages: [
                {
                  role: "user" as const,
                  content: [{ type: "text" as const, text }],
                  timestamp: Date.now(),
                },
              ],
              tools: [],
            },
            {
              signal: controller.signal,
              maxTokens: spec.maxTokens,
              maxRetries: 0,
              timeoutMs: spec.deadlineMs,
            },
          ),
        );
      } catch (error) {
        physical = Promise.reject(error);
      }
      // Logical abort/deadline may settle first, but this observer retains
      // physical ownership until the host transport itself settles.
      try {
        onPhysicalFlight?.(
          physical.then(
            () => undefined,
            () => undefined,
          ),
        );
      } catch {
        // Lifetime observation never controls a host transport attempt.
      }
      const response = await Promise.race([physical, deadline, aborted]);
      if (signal.aborted || controller.signal.aborted) throw unavailable();
      const output = responseText(response);
      const usage = responseUsage(response);
      // Selected-model drift fences the result, not the provider charge:
      // report the dispatched model's usage with text no consumer can parse.
      let current = true;
      try {
        bindContext(request);
      } catch {
        current = false;
      }
      return {
        text: current ? output : "",
        model: beforeDispatch.id,
        provider: beforeDispatch.provider,
        requestHash: request.requestHash,
        usage,
      };
    } catch {
      throw unavailable();
    } finally {
      if (timer) clearTimeout(timer);
      removeAbort();
    }
  };
}
