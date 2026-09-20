import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { ScopePatch } from "../src/analysis/extractor";
import * as extractor from "../src/analysis/extractor";
import type { Observation, SourceRef } from "../src/core/hybrid-state";
import { observation } from "./fixtures/hybrid";

type Key = "title" | "description" | `acceptance:${number}`;
interface Draft {
  operation: "add" | "revise" | "restore";
  index: number;
  fields: { key: Key; quote: string }[];
}
interface Parsed {
  patch: ScopePatch;
  detailDrafts: Draft[];
}
function parse(details: unknown): Parsed {
  const fn = Reflect.get(extractor, "parseExtraction");
  expect(fn, "Missing optional-isolated extraction parser").toBeTypeOf(
    "function",
  );
  return Reflect.apply(fn, undefined, [JSON.stringify(raw(details))]);
}
function ground(
  drafts: Draft[],
  latest: Observation,
): {
  operation: string;
  index: number;
  candidates: { key: Key; source: SourceRef }[];
}[] {
  const fn = Reflect.get(extractor, "groundDetailDrafts");
  expect(fn, "Missing independently grounded details").toBeTypeOf("function");
  return Reflect.apply(fn, undefined, [drafts, latest]);
}
function raw(details: unknown) {
  return {
    add: [
      {
        label: "Implement parser",
        kind: "action",
        basis: "explicit",
        quote: "Implement parser",
        details,
      },
    ],
    revise: [],
    archive: [],
    restore: [],
    unresolved: false,
  };
}
const clean = () => {
  const value = raw(undefined);
  return JSON.parse(JSON.stringify(value)) as ScopePatch;
};
it.each([
  null,
  false,
  3,
  "text",
  [],
  { unexpected: "x" },
  { title: { quote: 5 } },
])("malformed optional %j never rejects mandatory structure", (details) => {
  expect(extractor.parsePatch(JSON.stringify(raw(details)))).toEqual(clean());
  expect(parse(details).patch).toEqual(clean());
  expect(parse(details).detailDrafts).toEqual([]);
});
it("missing details stays optional; unrelated structural extras still fail closed", () => {
  expect(extractor.parsePatch(JSON.stringify(clean()))).toEqual(clean());
  const value = raw({ title: { quote: "Implement parser" } });
  const operation = value.add[0];
  if (!operation) throw new Error("Missing add fixture");
  Object.assign(operation, { injected: true });
  expect(() => extractor.parsePatch(JSON.stringify(value))).toThrow();
});
it("independently preserves description and valid criteria despite malformed title/items", () => {
  expect(
    parse({
      title: { quote: 3 },
      description: { quote: "Handle escaped delimiters" },
      acceptanceCriteria: [
        { quote: "Parser accepts escaped commas" },
        null,
        { quote: "No crash on empty input" },
      ],
    }).detailDrafts,
  ).toEqual([
    {
      operation: "add",
      index: 0,
      fields: [
        { key: "description", quote: "Handle escaped delimiters" },
        { key: "acceptance:0", quote: "Parser accepts escaped commas" },
        { key: "acceptance:2", quote: "No crash on empty input" },
      ],
    },
  ]);
});
it.each(["title", "description"] as const)(
  "uses scalar not UTF16 limits for %s without truncation",
  (field) => {
    const cap = field === "title" ? 120 : 800;
    const exact = "😀".repeat(cap);
    expect(
      parse({ [field]: { quote: exact } }).detailDrafts[0]?.fields,
    ).toEqual([{ key: field, quote: exact }]);
    expect(parse({ [field]: { quote: `${exact}x` } }).detailDrafts).toEqual([]);
  },
);
it("criteria caps: six independently bounded exact quotes, never silently truncate an oversized array", () => {
  const six = Array.from({ length: 6 }, () => ({ quote: "😀".repeat(240) }));
  expect(
    parse({ acceptanceCriteria: six }).detailDrafts[0]?.fields,
  ).toHaveLength(6);
  expect(
    parse({ acceptanceCriteria: [...six, { quote: "extra" }] }).detailDrafts,
  ).toEqual([]);
  expect(
    parse({ acceptanceCriteria: [{ quote: "😀".repeat(241) }] }).detailDrafts,
  ).toEqual([]);
});
it.each([
  "",
  "  ",
  "bad\nline",
  "bad\u001btext",
  "bad\u202etext",
  "bad\u200btext",
])(
  "unsafe/empty detail %j disappears without poisoning another field",
  (quote) => {
    expect(
      parse({ title: { quote }, description: { quote: "Valid description" } })
        .detailDrafts[0]?.fields,
    ).toEqual([{ key: "description", quote: "Valid description" }]);
  },
);
it("exact unique grounding persists only source spans and hashes, never quote text", () => {
  const latest = observation(
    "detail-source",
    "Implement parser. Handle escaped delimiters. Parser accepts escaped commas.",
  );
  const drafts = parse({
    title: { quote: "Implement parser" },
    description: { quote: "Handle escaped delimiters" },
    acceptanceCriteria: [{ quote: "Parser accepts escaped commas" }],
  }).detailDrafts;
  const grounded = ground(drafts, latest);
  expect(grounded).toHaveLength(1);
  expect(grounded[0]?.candidates).toHaveLength(3);
  const bound = grounded[0];
  const draft = drafts[0];
  if (!bound || !draft) throw new Error("Missing grounded draft");
  for (const candidate of bound.candidates) {
    const field = draft.fields.find((field) => field.key === candidate.key);
    if (!field) throw new Error("Missing candidate field");
    const quote = field.quote;
    expect(candidate.source).toEqual({
      entryId: latest.id,
      messageHash: latest.hash,
      role: latest.role,
      start: latest.text.indexOf(quote),
      end: latest.text.indexOf(quote) + quote.length,
      quoteHash: createHash("sha256").update(quote).digest("hex"),
    });
    expect(JSON.stringify(candidate)).not.toContain(quote);
  }
});
it("missing and nonunique optional quotes are omitted independently", () => {
  const drafts = parse({
    title: { quote: "Repeat" },
    description: { quote: "Unique" },
    acceptanceCriteria: [{ quote: "Invented" }],
  }).detailDrafts;
  expect(
    ground(
      drafts,
      observation("source", "Repeat Unique Repeat"),
    )[0]?.candidates.map((item) => item.key),
  ).toEqual(["description"]);
  expect(ground(drafts, observation("other", "unrelated"))).toEqual([]);
});
it("revise/restore drafts retain operation-index identity; archive never accepts details", () => {
  const fn = Reflect.get(extractor, "parseExtraction");
  expect(fn).toBeTypeOf("function");
  const op = {
    id: "task:1",
    label: "Implement parser",
    requirementsChanged: false,
    quote: "Implement parser",
    details: { title: { quote: "Implement parser" } },
  };
  const value = {
    ...clean(),
    add: [],
    revise: [op],
    restore: [{ ...op, id: "task:2" }],
  };
  const parsed: Parsed = Reflect.apply(fn, undefined, [JSON.stringify(value)]);
  expect(
    parsed.detailDrafts.map(({ operation, index }) => ({ operation, index })),
  ).toEqual([
    { operation: "revise", index: 0 },
    { operation: "restore", index: 0 },
  ]);
  expect(() =>
    extractor.parsePatch(
      JSON.stringify({
        ...clean(),
        archive: [{ id: "task:1", quote: "Implement parser", details: {} }],
      }),
    ),
  ).toThrow();
});
