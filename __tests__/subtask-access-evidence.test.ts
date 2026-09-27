import { describe, expect, it } from "vitest";
import {
  isCurrentSubtaskAccessEvidence,
  isCurrentSubtaskEvidence,
} from "../src/sources/coverage";
import { subtaskAccessFixture } from "./fixtures/subtask-access";
import { subtaskHash } from "./fixtures/subtasks";

describe("bounded canonical subtask access attestations", () => {
  it("exports frozen hashed facts without paths, bodies or raw call IDs", () => {
    const f = subtaskAccessFixture();
    f.run(
      "read-first",
      "read",
      { path: "extracted/r0-0.txt" },
      "PRIVATE_CELL_TEXT",
    );
    const proof = f.adapter.accessEvidence();
    expect(isCurrentSubtaskAccessEvidence(proof)).toBe(true);
    expect(isCurrentSubtaskAccessEvidence(structuredClone(proof))).toBe(false);
    expect(Object.isFrozen(proof.confirmed)).toBe(true);
    expect(proof.confirmed).toHaveLength(1);
    expect(proof.confirmed[0].source).toEqual({
      entryId: "result-read-first",
      messageHash: subtaskHash("PRIVATE_CELL_TEXT"),
      callHash: subtaskHash("read-first"),
    });
    expect(proof.mapped).toHaveLength(2);
    expect(JSON.stringify(proof)).not.toContain("PRIVATE_CELL_TEXT");
    expect(JSON.stringify(proof)).not.toContain("extracted/");
    expect(JSON.stringify(proof)).not.toContain('"callId"');
    expect(Buffer.byteLength(JSON.stringify(proof))).toBeLessThanOrEqual(65536);
  });
  it("tracks concurrent pending batches and exact end without granting preappend access", () => {
    const f = subtaskAccessFixture();
    const semantic = f.adapter.metadata();
    const old = f.adapter.accessEvidence();
    f.adapter.start(
      {
        toolCallId: "one",
        toolName: "read",
        args: { path: "extracted/r0-0.txt" },
      },
      1,
    );
    f.adapter.start(
      {
        toolCallId: "two",
        toolName: "read",
        args: { path: "extracted/r1-0.txt" },
      },
      1,
    );
    expect(isCurrentSubtaskAccessEvidence(old)).toBe(false);
    expect(
      f.adapter
        .accessEvidence()
        .active.map((call) => call.callHash)
        .sort(),
    ).toEqual([subtaskHash("one"), subtaskHash("two")].sort());
    f.adapter.end({ toolCallId: "one", toolName: "bash" }, 1);
    expect(f.adapter.accessEvidence().active).toHaveLength(2);
    f.adapter.end({ toolCallId: "one", toolName: "read" }, 1);
    f.adapter.confirm(f.entries, 1);
    expect(
      f.adapter.accessEvidence().active.map((call) => call.callHash),
    ).toEqual([subtaskHash("two")]);
    expect(f.adapter.accessEvidence().confirmed).toEqual([]);
    expect(isCurrentSubtaskEvidence(semantic)).toBe(true);
  });
  it.each([
    { isError: true },
    { excludeFromContext: true },
    { details: { truncation: { truncated: true } } },
  ])("never retains failed/excluded/truncated access %#", (extra) => {
    const f = subtaskAccessFixture();
    f.run("untrusted", "read", { path: "extracted/r0-0.txt" }, "body", extra);
    expect(f.adapter.accessEvidence().confirmed).toEqual([]);
  });
  it("revalidates retained bodies even when canonical entry IDs and order stay unchanged", () => {
    const f = subtaskAccessFixture();
    f.run("read-first", "read", { path: "extracted/r0-0.txt" }, "body");
    const old = f.adapter.accessEvidence();
    const entry = f.entries.find((item) => item.id === "result-read-first");
    if (!entry) throw new Error("Expected read result");
    entry.message.content[0].text = "amended body";
    f.adapter.confirm(f.entries, 1);
    expect(isCurrentSubtaskAccessEvidence(old)).toBe(false);
    expect(f.adapter.accessEvidence().confirmed).toEqual([]);
  });
  it("revokes confirmations when their extraction mapping is amended", () => {
    const f = subtaskAccessFixture();
    f.run("read-first", "read", { path: "extracted/r0-0.txt" }, "body");
    const old = f.adapter.accessEvidence();
    const listing = f.entries.find((item) => item.id === "result-list-0");
    if (!listing) throw new Error("Expected extraction mapping");
    listing.message.content[0].text =
      "One rows 2 nonempty rows 1 file extracted/different.txt";
    f.adapter.confirm(f.entries, 1);
    expect(isCurrentSubtaskAccessEvidence(old)).toBe(false);
    expect(
      f.adapter
        .accessEvidence()
        .confirmed.some(
          (receipt) =>
            receipt.resourceKey === subtaskHash("docs/resource-0.xlsx"),
        ),
    ).toBe(false);
  });
  it("replaces wholly dominated receipts across more than16 repeated reads", () => {
    const f = subtaskAccessFixture();
    const semantic = f.adapter.metadata();
    for (let i = 0; i < 24; i++)
      f.run(`read-${i}`, "read", { path: "extracted/r0-0.txt" }, "body");
    const proof = f.adapter.accessEvidence();
    expect(proof.confirmed).toHaveLength(1);
    expect(proof.confirmed[0].source.callHash).toBe(subtaskHash("read-23"));
    expect(proof.omissions).toBe(0);
    expect(isCurrentSubtaskEvidence(semantic)).toBe(true);
  });
  it("does not discard uncovered facts on partial-overlap reads", () => {
    const f = subtaskAccessFixture([["One", "Two"]]);
    f.run(
      "both",
      "bash",
      { command: "cat extracted/r0-0.txt extracted/r0-1.txt" },
      "both bodies",
    );
    f.run("one", "read", { path: "extracted/r0-0.txt" }, "one body");
    const proof = f.adapter.accessEvidence();
    expect(proof.confirmed).toHaveLength(2);
    const keys = new Set(
      proof.confirmed.flatMap((receipt) => receipt.itemKeys),
    );
    expect(keys.size).toBe(2);
  });
  it("rejects whole17th receipt with explicit omission, without evicting prior facts", () => {
    const f = subtaskAccessFixture([
      Array.from({ length: 17 }, (_, i) => `Item${i}`),
    ]);
    const semantic = f.adapter.metadata();
    for (let i = 0; i < 16; i++)
      f.run(`read-${i}`, "read", { path: `extracted/r0-${i}.txt` }, "body");
    const before = f.adapter.accessEvidence();
    expect(before.confirmed).toHaveLength(16);
    f.run("read-16", "read", { path: "extracted/r0-16.txt" }, "body");
    const after = f.adapter.accessEvidence();
    expect(after.confirmed).toEqual(before.confirmed);
    expect(after.omissions).toBeGreaterThan(before.omissions);
    expect(isCurrentSubtaskEvidence(semantic)).toBe(true);
  });
  it("permanently revokes old proofs after reset", () => {
    const f = subtaskAccessFixture();
    const old = f.adapter.accessEvidence();
    f.adapter.reset(1);
    expect(isCurrentSubtaskAccessEvidence(old)).toBe(false);
    expect(f.adapter.accessEvidence().confirmed).toEqual([]);
    expect(f.adapter.accessEvidence().mapped).toEqual([]);
  });
});
