import { expect, it } from "vitest";
import { exactQuoteSource } from "../src/analysis/extractor";
import {
  type DetailKey,
  materializeTaskDetails,
  taskDetailRequest,
} from "../src/analysis/task-details";
import { normalizedChoiceAssessment } from "../src/core/hybrid-proof";
import { initial, initialMessage, observation } from "./fixtures/hybrid";
import { detailRecord, required } from "./fixtures/task-details";

async function fixture(
  quote = "Consider a performance benchmark",
  key: DetailKey = "description",
) {
  const state = await initial();
  const message = observation(
    "detail-context",
    `For the other database task only: ${quote}. This is not requested for the parser.`,
    "assistant",
  );
  const record = detailRecord(required(state.tasks[0]), initialMessage);
  record.candidates = [{ key, source: exactQuoteSource(quote, message) }];
  const resolve = (id: string) =>
    [initialMessage, message].find((m) => m.id === id);
  return { record, message, resolve };
}
it("judgment includes full canonical candidate context, role and bound task source rather than just an isolated quote", async () => {
  const { record, message, resolve } = await fixture();
  const request = required(taskDetailRequest(record, ["description"], resolve));
  const state = JSON.stringify(request.state);
  expect(state).toContain(message.text);
  expect(state).toContain(initialMessage.text);
  expect(state).toContain('"assistant"');
  expect(state).toContain('"user"');
  expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(
    24 * 1024,
  );
});
it("unavailable or mismatched task-source authority cannot build an optional request", async () => {
  const { record, message, resolve } = await fixture();
  expect(
    taskDetailRequest(record, ["description"], (id) =>
      id === message.id ? message : undefined,
    ),
  ).toBeUndefined();
  record.taskSource.quoteHash = "f".repeat(64);
  expect(taskDetailRequest(record, ["description"], resolve)).toBeUndefined();
});
it("canonical surrounding context participates in byte bound; overflow is omitted, never silently truncated", async () => {
  const { record } = await fixture();
  const message = observation(
    "oversized",
    `not a request ${"z".repeat(25 * 1024)} candidate`,
  );
  record.candidates = [
    { key: "description", source: exactQuoteSource("candidate", message) },
  ];
  expect(
    taskDetailRequest(record, ["description"], (id) =>
      [message, initialMessage].find((m) => m.id === id),
    ),
  ).toBeUndefined();
});
it.each([
  ["title", "😀".repeat(121)],
  ["description", "x".repeat(801)],
  ["acceptance:0", "x".repeat(241)],
  ["description", "unsafe\nline"],
  ["title", "unsafe\u202etext"],
  ["description", "   "],
] as const)(
  "restored %s candidate revalidates text bounds/safety before request AND display",
  async (key, quote) => {
    const { record, message, resolve } = await fixture(quote, key);
    const assessment = required(
      normalizedChoiceAssessment(
        "yes",
        1,
        1,
        { entryId: message.id, messageHash: message.hash, role: message.role },
        new Set(["yes", "no", "uncertain"]),
      ),
    );
    record.receipts = [
      {
        requestHash: "a".repeat(64),
        candidateKeys: [key],
        assessments: [assessment],
        validatedAt: 1,
      },
    ];
    expect(taskDetailRequest(record, [key], resolve)).toBeUndefined();
    expect(materializeTaskDetails(record, resolve)).toBeUndefined();
  },
);
