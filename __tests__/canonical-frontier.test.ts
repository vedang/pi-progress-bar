import { expect, it } from "vitest";
import {
  type CanonicalFrontier,
  CanonicalPass,
  type CanonicalPreceding,
} from "../src/sources/messages";
import { observation } from "./fixtures/hybrid";
import { branchEntry } from "./fixtures/hybrid-monitor";

it("append after a terminal negative frontier inspects new headers, not old blanks", () => {
  const anchor = observation("anchor", "Settled work.");
  let reads = 0;
  const entries = [
    branchEntry(anchor.id, anchor.text),
    ...Array.from({ length: 1000 }, (_, i) => ({
      type: "message",
      id: `blank-${i}`,
      message: {
        role: "assistant",
        get content() {
          reads++;
          return " ";
        },
      },
    })),
  ];
  let frontier: CanonicalFrontier | undefined;
  for (let step = 0; step < 30; step++) {
    const result = new CanonicalPass(entries).page(anchor, frontier);
    frontier = result.frontier;
    if (!result.hasMore) break;
  }
  expect(frontier?.terminal).toBe(true);
  const before = reads;
  const next = new CanonicalPass([
    ...entries,
    branchEntry("new-visible", "New work."),
  ]).page(anchor, frontier);
  expect(next.page.map((item) => item.id)).toEqual(["new-visible"]);
  expect(reads).toBe(before);
});

it("structural invalidation discards partial preceding context and reconstructs exact order", () => {
  const blanks = (prefix: string) =>
    Array.from({ length: 70 }, (_, i) =>
      branchEntry(`${prefix}-${i}`, " ", "assistant"),
    );
  const entries = [
    branchEntry("old", "Old context."),
    ...blanks("a"),
    branchEntry("recent", "Recent context."),
    ...blanks("b"),
    branchEntry("target", "Current work."),
  ];
  let result: CanonicalPreceding = { context: [], complete: false };
  for (let step = 0; step < 5 && !result.context.length; step++)
    result = new CanonicalPass(entries).precedingResult(
      "target",
      false,
      result.frontier,
      result.context,
    );
  expect(result.complete).toBe(false);
  expect(result.context.map((item) => item.id)).toEqual(["recent"]);
  const changed = [
    ...entries.slice(0, -1),
    branchEntry("inserted", "Inserted nearer context."),
    entries.at(-1),
  ];
  for (let step = 0; step < 10; step++) {
    result = new CanonicalPass(changed).precedingResult(
      "target",
      false,
      result.frontier,
      result.context,
    );
    if (result.complete) break;
  }
  expect(result.complete).toBe(true);
  expect(result.context.map((item) => item.id)).toEqual(["recent", "inserted"]);
});
