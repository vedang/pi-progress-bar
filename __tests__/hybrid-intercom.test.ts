import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanonicalPass, canonicalMessages } from "../src/sources/messages";
import { monitorHarness } from "./fixtures/hybrid-monitor";

const text =
  "**From orgtok** (/work/orgtok.v2)\n\nImplement parser, add regression, and validate it.";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const incoming = (id = "goal", content: unknown = text) => ({
  type: "custom_message",
  id,
  parentId: null,
  customType: "intercom_message",
  content,
  display: true,
  details: {
    from: { id: "sender", name: "orgtok", cwd: "/work/orgtok.v2" },
    message: { id: "delivery-1", expectsReply: true },
  },
});
const running: ReturnType<typeof monitorHarness>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline-key");
});
afterEach(() => {
  for (const h of running.splice(0)) h.monitor.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
function fixture() {
  const h = monitorHarness([]);
  running.push(h);
  h.replace([incoming()]);
  return h;
}

describe("intercom canonical task intake", () => {
  it("admits host custom_message records with distinct intercom provenance", () => {
    expect(canonicalMessages([incoming()])).toEqual([
      { id: "goal", role: "intercom", text, hash: digest(text) },
    ]);
  });
  it("admits text blocks, replies and cancellation prose without local semantic veto", () => {
    const entries = [
      incoming("reply", [{ type: "text", text: "Requested patch completed." }]),
      incoming("cancel", "Cancel the delegated parser task."),
    ];
    expect(
      canonicalMessages(entries).map(({ id, role }) => ({ id, role })),
    ).toEqual([
      { id: "reply", role: "intercom" },
      { id: "cancel", role: "intercom" },
    ]);
  });
  it("keeps arbitrary custom messages, audit receipts, tools and malformed records excluded", () => {
    expect(
      canonicalMessages([
        { ...incoming(), customType: "pi-progress-bar" },
        { ...incoming(), customType: "other_extension" },
        {
          type: "custom",
          id: "audit",
          customType: "intercom_received",
          data: { text },
        },
        {
          type: "message",
          id: "tool",
          message: { role: "toolResult", content: text },
        },
        { ...incoming(), id: "" },
        { ...incoming(), content: [] },
      ]),
    ).toEqual([]);
  });
  it("uses intercom records in paging and bounded preceding context", () => {
    const pass = new CanonicalPass([
      incoming(),
      {
        type: "message",
        id: "answer",
        message: { role: "assistant", content: "Working on parser now." },
      },
    ]);
    expect(pass.page().page.map((o) => o.id)).toEqual(["goal", "answer"]);
    const preceding = pass.precedingResult("answer");
    expect(preceding.complete).toBe(true);
    expect(preceding.context[0]).toMatchObject({
      id: "goal",
      role: "intercom",
    });
    expect(pass.observation("goal")?.hash).toBe(digest(text));
  });
  it("discovers delegated tasks without a typed user prompt and restores without rebilling", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    expect(h.monitor.state.tasks).toHaveLength(3);
    expect(
      h.monitor.state.tasks.every(
        (task) => String(task.source.role) === "intercom",
      ),
    ).toBe(true);
    expect(h.requests.find((r) => "gate" in r.questions)?.state).toMatchObject({
      latest: { id: "goal", role: "intercom", text },
    });
    const checkpoint = h.monitor.checkpoint();
    const calls = h.fetch.mock.calls.length;
    const models = h.extract.mock.calls.length;
    h.observe();
    h.observe();
    await vi.advanceTimersByTimeAsync(100);
    await h.monitor.restore("/nonexistent-hybrid-test", checkpoint);
    await h.settle("goal");
    expect(h.fetch).toHaveBeenCalledTimes(calls);
    expect(h.extract).toHaveBeenCalledTimes(models);
    expect(h.monitor.state.cursor).toMatchObject({
      id: "goal",
      role: "intercom",
    });
  });
  it("invalidates accepted source when intercom payload is amended", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    const calls = h.fetch.mock.calls.length;
    h.replace([
      incoming("goal", "Implement the revised parser contract instead."),
    ]);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.fetch.mock.calls.length).toBeGreaterThan(calls);
    expect(h.monitor.state.cursor?.hash).toBe(
      digest("Implement the revised parser contract instead."),
    );
  });
});
