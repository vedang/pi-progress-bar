import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectedModelSubtasks } from "../src/core/subtask-selected-model";
import { subtaskSelectedFixture } from "./fixtures/subtask-proposal";

afterEach(() => vi.useRealTimers());
function fixture() {
  const { request, text } = subtaskSelectedFixture();
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
  const run = selectedModelSubtasks(
    () =>
      context as unknown as Pick<ExtensionContext, "model" | "modelRegistry">,
  );
  return {
    request,
    text,
    response,
    complete,
    context,
    run,
    dispatch: vi.fn(() => true),
    controller: new AbortController(),
  };
}
describe("host-selected generic subtask proposer", () => {
  it("rejects multiple empty text blocks instead of treating separators as provider output", async () => {
    const h = fixture();
    h.response.content = [
      { type: "text", text: "" },
      { type: "text", text: "" },
    ];
    await expect(h.run(h.request, h.controller.signal)).rejects.toThrow(
      "Subtask proposal unavailable",
    );
    expect(h.complete).toHaveBeenCalledTimes(1);
  });
  it("accepts substantive provider text surrounded by empty blocks", async () => {
    const h = fixture();
    h.response.content = [
      { type: "text", text: "" },
      { type: "text", text: h.text },
      { type: "text", text: "" },
    ];
    const result = await h.run(h.request, h.controller.signal);
    expect(JSON.parse(result.text)).toEqual(JSON.parse(h.text));
    expect(h.complete).toHaveBeenCalledTimes(1);
  });
  it("uses code-owned proposal instructions/schema, host auth, exact hashed input and no tools/retries", async () => {
    const h = fixture();
    expect(
      await h.run(h.request, h.controller.signal, h.dispatch),
    ).toMatchObject({
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
    expect(args[1].systemPrompt).toMatch(/subtask/i);
    expect(args[1].systemPrompt).toContain(
      "Follow the code-owned instructions and schema",
    );
    expect(args[1].systemPrompt).not.toContain("task lifecycle changes");
    expect(args[1].tools).toEqual([]);
    expect(args[1].messages).toHaveLength(1);
    const body = args[1].messages[0].content[0].text;
    expect(JSON.parse(body)).toEqual(h.request.input);
    expect(createHash("sha256").update(body).digest("hex")).toBe(
      h.request.requestHash,
    );
    expect(args[2]).toMatchObject({
      maxTokens: 2048,
      maxRetries: 0,
      timeoutMs: 60000,
      signal: expect.any(AbortSignal),
    });
    expect(args[2]).not.toHaveProperty("apiKey");
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it.each([Object.prototype, Array.prototype])(
    "keeps exact wire proof without invoking inherited serialization hooks on %s",
    async (prototype) => {
      const h = fixture();
      const previous = Object.getOwnPropertyDescriptor(prototype, "toJSON");
      let reads = 0;
      let result: unknown;
      try {
        Object.defineProperty(prototype, "toJSON", {
          configurable: true,
          get() {
            reads++;
            return () => ({ erased: true });
          },
        });
        result = await h.run(h.request, h.controller.signal);
      } finally {
        if (previous) Object.defineProperty(prototype, "toJSON", previous);
        else Reflect.deleteProperty(prototype, "toJSON");
      }
      expect(result).toMatchObject({ text: h.text });
      expect(reads).toBe(0);
      const args = h.complete.mock.calls[0] as unknown as [
        unknown,
        { messages: Array<{ content: Array<{ text: string }> }> },
      ];
      const body = args[1].messages[0].content[0].text;
      expect(createHash("sha256").update(body).digest("hex")).toBe(
        h.request.requestHash,
      );
    },
  );
  it.each([
    "aborted",
    "model",
    "provider",
    "proof",
    "clone",
    "veto",
    "hook-throws",
    "missing-model",
  ])("prevents registry admission for %s", async (mode) => {
    const h = fixture();
    if (mode === "aborted") h.controller.abort();
    if (mode === "model") h.context.model.id = "other";
    if (mode === "provider") h.context.model.provider = "other";
    if (mode === "missing-model") Reflect.deleteProperty(h.context, "model");
    if (mode === "veto") h.dispatch.mockReturnValue(false);
    if (mode === "hook-throws")
      h.dispatch.mockImplementation(() => {
        throw new Error("PRIVATE_HOOK_DATA");
      });
    const request =
      mode === "proof"
        ? { ...h.request, requestHash: "0".repeat(64) }
        : mode === "clone"
          ? structuredClone(h.request)
          : h.request;
    await expect(
      h.run(request, h.controller.signal, h.dispatch),
    ).rejects.toThrow("Subtask proposal unavailable");
    expect(h.complete).not.toHaveBeenCalled();
    if (mode !== "veto" && mode !== "hook-throws")
      expect(h.dispatch).not.toHaveBeenCalled();
  });
  it.each(["abort", "model", "provider"])(
    "rechecks %s after the dispatch admission callback",
    async (mode) => {
      const h = fixture();
      h.dispatch.mockImplementation(() => {
        if (mode === "abort") h.controller.abort();
        else if (mode === "model") h.context.model.id = "other";
        else h.context.model.provider = "other";
        return true;
      });
      await expect(
        h.run(h.request, h.controller.signal, h.dispatch),
      ).rejects.toThrow();
      expect(h.complete).not.toHaveBeenCalled();
    },
  );
  it.each(["length", "error", "aborted", "toolUse"])(
    "rejects non-stop response %s without retry",
    async (reason) => {
      const h = fixture();
      h.response.stopReason = reason;
      await expect(
        h.run(h.request, h.controller.signal, h.dispatch),
      ).rejects.toThrow();
      expect(h.complete).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["oversized", "tool", "bad-usage", "empty", "provider-error"])(
    "contains %s without raw diagnostic leakage or retry",
    async (mode) => {
      const h = fixture();
      if (mode === "oversized") h.response.content[0].text = "😀".repeat(8193);
      if (mode === "tool") h.response.content[0].type = "toolCall";
      if (mode === "bad-usage") h.response.usage.input = -1;
      if (mode === "empty") h.response.content = [];
      if (mode === "provider-error")
        h.complete.mockRejectedValue(new Error("PRIVATE_PROVIDER_CREDENTIAL"));
      const error = await h
        .run(h.request, h.controller.signal, h.dispatch)
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toBe("Error: Subtask proposal unavailable");
      expect(h.complete).toHaveBeenCalledTimes(1);
    },
  );
  it("accepts exactly32768 UTF8 output bytes without truncation", async () => {
    const h = fixture();
    h.response.content[0].text =
      h.text + " ".repeat(32768 - Buffer.byteLength(h.text));
    expect(
      Buffer.byteLength((await h.run(h.request, h.controller.signal)).text),
    ).toBe(32768);
  });
  it("bounds combined text blocks including inserted separators", async () => {
    const h = fixture();
    h.response.content = [
      { type: "text", text: "x".repeat(16384) },
      { type: "text", text: "y".repeat(16384) },
    ];
    await expect(h.run(h.request, h.controller.signal)).rejects.toThrow();
  });
  it("stops at60000ms when provider ignores cancellation and cleans up timers", async () => {
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
  it("discards a completed result after model drift", async () => {
    const h = fixture();
    h.complete.mockImplementation(async () => {
      h.context.model.id = "other";
      return h.response;
    });
    await expect(h.run(h.request, h.controller.signal)).rejects.toThrow();
  });
  it("contains cancellation of an ignoring provider with no retry", async () => {
    const h = fixture();
    h.complete.mockImplementation(() => new Promise(() => {}));
    const outcome = h
      .run(h.request, h.controller.signal)
      .catch((error: unknown) => error);
    h.controller.abort();
    expect(await outcome).toBeInstanceOf(Error);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });
});
