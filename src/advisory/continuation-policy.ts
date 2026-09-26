import { createHash } from "node:crypto";

const MAX_SERIALIZED_POLICY_BYTES = 8 * 1024;
const sha256 = /^[a-f0-9]{64}$/;

type CompleteContinuationPolicy = {
  coverage: "complete";
  promptHash: string;
  text: string;
};

type UnknownContinuationPolicy = { coverage: "unknown" };
type ContinuationPolicy =
  | CompleteContinuationPolicy
  | UnknownContinuationPolicy;

const unknownPolicy = (): UnknownContinuationPolicy => ({
  coverage: "unknown",
});

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const nonblankText = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim();

const promptHash = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

const serializedBytes = (policy: CompleteContinuationPolicy) =>
  Buffer.byteLength(JSON.stringify(policy), "utf8");

const completePolicy = (
  text: string,
): CompleteContinuationPolicy | undefined => {
  const policy: CompleteContinuationPolicy = {
    coverage: "complete",
    promptHash: promptHash(text),
    text,
  };
  return serializedBytes(policy) <= MAX_SERIALIZED_POLICY_BYTES
    ? policy
    : undefined;
};

const validCompletePolicy = (
  value: unknown,
): value is CompleteContinuationPolicy =>
  record(value) &&
  hasExactKeys(value, ["coverage", "promptHash", "text"]) &&
  value.coverage === "complete" &&
  typeof value.promptHash === "string" &&
  sha256.test(value.promptHash) &&
  nonblankText(value.text) &&
  value.promptHash === promptHash(value.text) &&
  serializedBytes({
    coverage: "complete",
    promptHash: value.promptHash,
    text: value.text,
  }) <= MAX_SERIALIZED_POLICY_BYTES;

const validUnknownPolicy = (value: unknown) =>
  record(value) &&
  hasExactKeys(value, ["coverage"]) &&
  value.coverage === "unknown";

/** Capture full rendered system policy before a provider-context override can occur. */
export const captureContinuationPolicy = (
  renderedPrompt: unknown,
): ContinuationPolicy => {
  try {
    if (!nonblankText(renderedPrompt)) return unknownPolicy();
    return completePolicy(renderedPrompt) ?? unknownPolicy();
  } catch {
    return unknownPolicy();
  }
};

/**
 * Revalidate a captured proof against the exact effective provider-context prompt.
 * Unknown is terminal: later matching text cannot restore unavailable authority.
 */
export const validateContinuationPolicy = (
  snapshot: unknown,
  effectivePrompt: unknown,
): ContinuationPolicy => {
  try {
    if (validUnknownPolicy(snapshot)) return unknownPolicy();
    if (!validCompletePolicy(snapshot) || !nonblankText(effectivePrompt))
      return unknownPolicy();
    if (snapshot.text !== effectivePrompt) return unknownPolicy();
    return {
      coverage: "complete",
      promptHash: snapshot.promptHash,
      text: snapshot.text,
    };
  } catch {
    return unknownPolicy();
  }
};
