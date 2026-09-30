import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectedModelContinuation } from "../src/advisory/continuation-selected-model";
import { continuationDraftFixture } from "./fixtures/continuation-draft";

afterEach(() => vi.useRealTimers());
function fixture() {
  const { request, text } = continuationDraftFixture();
  const response = {
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { input: 7, output: 9 },
  };
  const complete = vi.fn(async () => response);
  const context = {
    model: { id: "selected", provider: "fixture" },
    modelRegistry: { complete },
  };
  const run = selectedModelContinuation(
    () =>
      context as unknown as Pick<ExtensionContext, "model" | "modelRegistry">,
  );
  const dispatch = vi.fn(() => true);
  const controller = new AbortController();
  return {
    request,
    text,
    response,
    complete,
    context,
    run,
    dispatch,
    controller,
  };
}
describe("host-selected continuation adapter", () => {
  it("uses purpose-specific instructions, copied bounded input and host-owned auth", async () => {
    const h = fixture();
    const result = await h.run(h.request, h.controller.signal, h.dispatch);
    expect(result).toMatchObject({
      text: h.text,
      model: "selected",
      provider: "fixture",
      requestHash: h.request.requestHash,
      usage: { inputTokens: 7, outputTokens: 9 },
    });
    expect(h.complete).toHaveBeenCalledTimes(1);
    const args = h.complete.mock.calls[0] as unknown as [
      unknown,
      {
        systemPrompt: string;
        tools: unknown[];
        messages: Array<{ content: Array<{ text: string }> }>;
      },
      Record<string, unknown>,
    ];
    expect(args[1].systemPrompt).toMatch(/continuation/i);
    expect(args[1].systemPrompt).toContain(
      "Follow the code-owned instructions and schema",
    );
    expect(args[1].systemPrompt).not.toContain(
      "observations and schema as evidence",
    );
    expect(args[1].systemPrompt).not.toContain("task lifecycle changes");
    expect(args[1].tools).toEqual([]);
    expect(args[1].messages).toHaveLength(1);
    expect(JSON.parse(args[1].messages[0].content[0].text)).toEqual(
      h.request.input,
    );
    expect(args[2]).toMatchObject({
      maxTokens: 512,
      maxRetries: 0,
      timeoutMs: 60000,
      signal: expect.any(AbortSignal),
    });
    expect(args[2]).not.toHaveProperty("apiKey");
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });
  it.each(["aborted", "model", "provider", "proof", "copied-request", "veto"])(
    "suppresses registry admission for %s",
    async (mode) => {
      const h = fixture();
      if (mode === "aborted") h.controller.abort();
      if (mode === "model") h.context.model.id = "other";
      if (mode === "provider") h.context.model.provider = "other";
      if (mode === "veto") h.dispatch.mockReturnValue(false);
      const request =
        mode === "proof"
          ? { ...h.request, requestHash: "0".repeat(64) }
          : mode === "copied-request"
            ? structuredClone(h.request)
            : h.request;
      await expect(
        h.run(request, h.controller.signal, h.dispatch),
      ).rejects.toThrow();
      expect(h.complete).not.toHaveBeenCalled();
      if (mode !== "veto") expect(h.dispatch).not.toHaveBeenCalled();
    },
  );
  it.each(["length", "error", "aborted", "toolUse"])(
    "rejects nonterminal or failed response %s without retry",
    async (reason) => {
      const h = fixture();
      h.response.stopReason = reason;
      await expect(
        h.run(h.request, h.controller.signal, h.dispatch),
      ).rejects.toThrow();
      expect(h.complete).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["oversized", "tool", "bad-usage", "provider-error"])(
    "contains %s failures without retry or raw diagnostic leakage",
    async (mode) => {
      const h = fixture();
      if (mode === "oversized") h.response.content[0].text = "😀".repeat(1025);
      if (mode === "tool") h.response.content[0].type = "toolCall";
      if (mode === "bad-usage") h.response.usage.input = -1;
      if (mode === "provider-error")
        h.complete.mockRejectedValue(new Error("PRIVATE_PROVIDER_CREDENTIAL"));
      const error = await h
        .run(h.request, h.controller.signal, h.dispatch)
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("PRIVATE_PROVIDER_CREDENTIAL");
      expect(h.complete).toHaveBeenCalledTimes(1);
    },
  );
  it("rechecks cancellation after the admission hook before invoking registry", async () => {
    const h = fixture();
    h.dispatch.mockImplementation(() => {
      h.controller.abort();
      return true;
    });
    await expect(
      h.run(h.request, h.controller.signal, h.dispatch),
    ).rejects.toThrow();
    expect(h.complete).not.toHaveBeenCalled();
  });
  it("rejects missing selected model before admission", async () => {
    const h = fixture();
    Reflect.deleteProperty(h.context, "model");
    await expect(
      h.run(h.request, h.controller.signal, h.dispatch),
    ).rejects.toThrow();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
  });
  it("accepts the exact4096-byte text boundary", async () => {
    const h = fixture();
    h.response.content[0].text =
      h.text + " ".repeat(4096 - Buffer.byteLength(h.text));
    expect(
      Buffer.byteLength((await h.run(h.request, h.controller.signal)).text),
    ).toBe(4096);
  });
  it("aborts at60000ms even when provider ignores cancellation", async () => {
    vi.useFakeTimers();
    const h = fixture();
    h.complete.mockImplementation(() => new Promise(() => {}));
    const outcome = h
      .run(h.request, h.controller.signal, h.dispatch)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60000);
    expect(await outcome).toBeInstanceOf(Error);
    const args = h.complete.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { signal: AbortSignal },
    ];
    expect(args[2].signal.aborted).toBe(true);
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("discards a drafted result after model drift but keeps its charged usage", async () => {
    const h = fixture();
    h.complete.mockImplementation(async () => {
      h.context.model = { id: "other", provider: "fixture" };
      return h.response;
    });
    expect(await h.run(h.request, h.controller.signal, h.dispatch)).toEqual({
      text: "",
      model: "selected",
      provider: "fixture",
      requestHash: h.request.requestHash,
      usage: { inputTokens: 7, outputTokens: 9 },
    });
  });
  it("contains already-started cancellation without retry", async () => {
    const h = fixture();
    h.complete.mockImplementation(() => new Promise(() => {}));
    const outcome = h
      .run(h.request, h.controller.signal, h.dispatch)
      .catch((error: unknown) => error);
    h.controller.abort();
    expect(await outcome).toBeInstanceOf(Error);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });
});
