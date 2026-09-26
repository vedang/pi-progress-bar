import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  captureContinuationPolicy,
  validateContinuationPolicy,
} from "../src/advisory/continuation-policy";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const prompt =
  "Follow current user instructions. Continue assigned work unless paused. Never bypass approval.";
const unknown = { coverage: "unknown" };

describe("continuation effective-policy proof", () => {
  it("copies the entire rendered policy, not a partial structured-options projection", () => {
    expect(captureContinuationPolicy(prompt)).toEqual({
      coverage: "complete",
      promptHash: hash(prompt),
      text: prompt,
    });
    expect(captureContinuationPolicy({ customPrompt: prompt })).toEqual(
      unknown,
    );
  });

  it("validates an original snapshot against the effective provider-context prompt", () => {
    const snapshot = captureContinuationPolicy(prompt);
    expect(validateContinuationPolicy(snapshot, prompt)).toEqual(snapshot);
    expect(
      validateContinuationPolicy(
        snapshot,
        "Late override: provide status only.",
      ),
    ).toEqual(unknown);
  });

  it("does not revive an invalidated proof when settlement later resets the prompt", () => {
    const captured = captureContinuationPolicy(prompt);
    const invalidated = validateContinuationPolicy(
      captured,
      "Forced late prompt",
    );
    expect(invalidated).toEqual(unknown);
    expect(validateContinuationPolicy(invalidated, prompt)).toEqual(unknown);
  });

  it.each([undefined, null, "", "  ", { text: prompt }])(
    "abstains for unavailable rendered policy (%s)",
    (value) => {
      expect(captureContinuationPolicy(value)).toEqual(unknown);
      expect(
        validateContinuationPolicy(captureContinuationPolicy(prompt), value),
      ).toEqual(unknown);
    },
  );

  it("accepts exactly8KiB serialized proof and rejects the next UTF8 byte", () => {
    const overhead = Buffer.byteLength(
      JSON.stringify({ coverage: "complete", promptHash: hash(""), text: "" }),
      "utf8",
    );
    const at = "x".repeat(8 * 1024 - overhead);
    const proof = captureContinuationPolicy(at);
    expect(proof.coverage).toBe("complete");
    expect(Buffer.byteLength(JSON.stringify(proof), "utf8")).toBe(8 * 1024);
    expect(captureContinuationPolicy(`${at}x`)).toEqual(unknown);
    // UTF8 bytes, not UTF16 length; this string is shorter but exceeds the cap.
    expect(captureContinuationPolicy("😀".repeat(2048))).toEqual(unknown);
  });

  it("returns a detached proof and rejects tampered text/hash or unsupported fields", () => {
    const captured = captureContinuationPolicy(prompt);
    const validated = validateContinuationPolicy(captured, prompt);
    expect(validated).not.toBe(captured);
    if (captured.coverage !== "complete" || validated.coverage !== "complete")
      throw new Error("Expected complete policy proof");
    expect(
      validateContinuationPolicy(
        { ...captured, text: "Changed policy" },
        prompt,
      ),
    ).toEqual(unknown);
    expect(
      validateContinuationPolicy(
        { ...captured, promptHash: hash("other") },
        prompt,
      ),
    ).toEqual(unknown);
    const extra = { ...captured, rawOptions: "PRIVATE_SENTINEL" };
    expect(validateContinuationPolicy(extra, prompt)).toEqual(unknown);
    validated.text = "Changed returned copy";
    expect(captured.text).toBe(prompt);
  });
});
