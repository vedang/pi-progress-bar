import { describe, expect, it } from "vitest";
import {
  applySubtaskGate,
  buildSubtaskGate,
} from "../src/analysis/subtask-gate";
import {
  applySubtaskProposal,
  buildSubtaskProposal,
  isValidatedSubtaskProposalRequest,
} from "../src/analysis/subtask-proposal";
import {
  CoverageAdapter,
  isCurrentSubtaskEvidence,
} from "../src/sources/coverage";
import { subtaskProposalFixture } from "./fixtures/subtask-proposal";
import { subtaskHash } from "./fixtures/subtasks";

const xml = (name = "One") =>
  `<workbook><sheets><sheet name="${name}"/></sheets><definedNames><definedName name="private">PRIVATE_CELL_TEXT</definedName></definedNames></workbook>`;
const entry = (id: string, text: string, extra = {}) => ({
  type: "message",
  id: `result-${id}`,
  message: {
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    ...extra,
  },
});
function fixture() {
  const adapter = new CoverageAdapter();
  const entries: ReturnType<typeof entry>[] = [];
  function manifest(
    id = "manifest",
    path = "docs/one.xlsx",
    name = "One",
    extra = {},
  ) {
    adapter.start(
      {
        toolCallId: id,
        toolName: "bash",
        args: { command: `unzip -p ${path} xl/workbook.xml` },
      },
      1,
    );
    adapter.end({ toolCallId: id, toolName: "bash" }, 1);
    entries.push(entry(id, xml(name), extra));
    adapter.confirm(entries, 1);
  }
  return { adapter, entries, manifest };
}

describe("optional passive subtask evidence", () => {
  it("provides no metadata prerequisite for ordinary conversation-only gates", () => {
    const f = fixture();
    expect(f.adapter.metadata()).toBeUndefined();
    const h = subtaskProposalFixture();
    expect(buildSubtaskGate(h.options)).toBeDefined();
    expect(buildSubtaskProposal(h.batch, h.journal, h.options)).toBeDefined();
  });
  it("exposes only canonically confirmed names/scalars and hashed tool receipt", () => {
    const f = fixture();
    f.manifest();
    const evidence = f.adapter.metadata();
    expect(evidence).toMatchObject({
      resources: [
        {
          resourceKey: subtaskHash("docs/one.xlsx"),
          revision: 1,
          complete: true,
          items: [{ label: "One" }],
          source: {
            entryId: "result-manifest",
            messageHash: subtaskHash(xml()),
            callHash: subtaskHash("manifest"),
          },
        },
      ],
      omissions: 0,
    });
    expect(isCurrentSubtaskEvidence(evidence)).toBe(true);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence?.resources)).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE_CELL_TEXT");
    expect(JSON.stringify(evidence)).not.toContain("docs/one.xlsx");
    expect(JSON.stringify(evidence)).not.toContain('"callId"');
    expect(JSON.stringify(evidence)).not.toContain("toolCallId");
    expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(
      65536,
    );
  });
  it("does not expose preappend or failed results", () => {
    const f = fixture();
    f.adapter.start(
      {
        toolCallId: "pending",
        toolName: "bash",
        args: { command: "unzip -p docs/one.xlsx xl/workbook.xml" },
      },
      1,
    );
    f.adapter.end({ toolCallId: "pending", toolName: "bash" }, 1);
    f.adapter.confirm([], 1);
    expect(f.adapter.metadata()).toBeUndefined();
    f.entries.push(entry("pending", xml(), { isError: true }));
    f.adapter.confirm(f.entries, 1);
    expect(f.adapter.metadata()).toBeUndefined();
  });
  it("preserves separate resources with same item labels without assigning children", () => {
    const f = fixture();
    f.manifest();
    f.manifest("second", "docs/two.xlsx");
    const evidence = f.adapter.metadata();
    expect(evidence?.resources).toHaveLength(2);
    expect(
      new Set(evidence?.resources.map((resource) => resource.resourceKey)).size,
    ).toBe(2);
    expect(
      evidence?.resources.map((resource) => resource.items[0].label),
    ).toEqual(["One", "One"]);
    expect(JSON.stringify(evidence)).not.toContain("childId");
    expect(JSON.stringify(evidence)).not.toContain("parentTaskId");
  });
  it("rejects cloned/forged metadata and fences canonical amendment or reset", () => {
    const f = fixture();
    f.manifest();
    const evidence = f.adapter.metadata();
    expect(isCurrentSubtaskEvidence(structuredClone(evidence))).toBe(false);
    f.adapter.confirm(f.entries, 1);
    expect(isCurrentSubtaskEvidence(evidence)).toBe(true);
    f.entries[0].message.content[0].text = xml("Changed");
    f.adapter.confirm(f.entries, 1);
    expect(isCurrentSubtaskEvidence(evidence)).toBe(false);
    expect(f.adapter.metadata()).toBeUndefined();
    const fresh = fixture();
    fresh.manifest();
    const prior = fresh.adapter.metadata();
    fresh.adapter.reset(2);
    expect(isCurrentSubtaskEvidence(prior)).toBe(false);
  });
  it("does not revive an old attestation after reset and identical re-confirmation", () => {
    const f = fixture();
    f.manifest();
    const evidence = f.adapter.metadata();
    f.adapter.reset(1);
    f.entries.length = 0;
    f.manifest();
    expect(isCurrentSubtaskEvidence(evidence)).toBe(false);
    expect(isCurrentSubtaskEvidence(f.adapter.metadata())).toBe(true);
  });
  it("rejects metadata invalidated inside canonical resolver callbacks", () => {
    const f = fixture();
    f.manifest();
    const h = subtaskProposalFixture();
    const options = {
      ...h.options,
      evidence: f.adapter.metadata(),
      resolve: (id: string) => {
        f.adapter.reset(2);
        return h.options.resolve(id);
      },
    };
    expect(buildSubtaskGate(options)).toBeUndefined();
  });
  it("hashes optional metadata into gate and proposal only after a fresh exact yes", () => {
    const f = fixture();
    f.manifest();
    const evidence = f.adapter.metadata();
    if (!evidence) throw new Error("Expected evidence");
    const h = subtaskProposalFixture();
    const options = { ...h.options, evidence };
    const batch = buildSubtaskGate(options);
    if (!batch) throw new Error("Expected metadata-enriched gate");
    expect(batch.identity).not.toBe(h.batch.identity);
    expect(batch.contextHash).not.toBe(h.batch.contextHash);
    expect(batch.request).toMatchObject({ state: { evidence } });
    expect(buildSubtaskProposal(batch, h.journal, options)).toBeUndefined();
    expect(
      applySubtaskGate(h.batch, h.result, options, { dispatch: 1, at: 123 }),
    ).toBeUndefined();
    const receipt = applySubtaskGate(batch, h.result, options, {
      dispatch: 1,
      at: 123,
    });
    if (!receipt) throw new Error("Expected current gate receipt");
    const journal = { ...h.journal, records: [receipt] };
    const request = buildSubtaskProposal(batch, journal, options);
    if (!request) throw new Error("Expected authorized enriched proposal");
    expect(request.input).toMatchObject({ evidence });
    expect(request.requestHash).not.toBe(
      buildSubtaskProposal(h.batch, h.journal, h.options)?.requestHash,
    );
    expect(h.store.snapshot().groups).toEqual([]);
    expect(h.parent.status).toBe("not-started");
    f.adapter.reset(2);
    expect(isValidatedSubtaskProposalRequest(request)).toBe(false);
    expect(
      applySubtaskProposal(request, '{"proposals":[]}', options),
    ).toBeUndefined();
    expect(buildSubtaskGate(options)).toBeUndefined();
    expect(buildSubtaskProposal(batch, journal, options)).toBeUndefined();
  });
  it("does not accept serialized metadata as current adapter attestation", () => {
    const f = fixture();
    f.manifest();
    const h = subtaskProposalFixture();
    expect(
      buildSubtaskGate({
        ...h.options,
        evidence: structuredClone(f.adapter.metadata()),
      }),
    ).toBeUndefined();
  });
});
