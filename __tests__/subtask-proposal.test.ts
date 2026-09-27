import { describe, expect, it, vi } from "vitest";
import {
  applySubtaskProposal,
  buildSubtaskProposal,
  isValidatedSubtaskProposalRequest,
} from "../src/analysis/subtask-proposal";
import { subtaskProposalFixture } from "./fixtures/subtask-proposal";
import { subtaskHash } from "./fixtures/subtasks";

function fixture(existing = false, reported = false) {
  const h = subtaskProposalFixture(existing, reported);
  const request = buildSubtaskProposal(h.batch, h.journal, h.options);
  if (!request) throw new Error("Expected authorized proposal request");
  const index = request.input.context.findIndex(
    (item) => item.id === h.latest.id,
  );
  if (index < 0) throw new Error("Latest context missing");
  const evidence = [
    { contextIndex: index, start: 0, end: h.latest.text.length },
  ];
  const proposal = {
    parentIndex: 0,
    children: [
      { kind: "add", label: "Evaluate deployment tradeoffs", evidence },
    ],
    removals: [],
    complete: false,
  };
  return { ...h, request, evidence, proposal };
}
const raw = (proposal: unknown) => JSON.stringify({ proposals: [proposal] });

describe("yes-authorized generic subtask proposals", () => {
  it("builds a detached bounded request from restored durable yes without files or tools", () => {
    const h = fixture();
    expect(isValidatedSubtaskProposalRequest(h.request)).toBe(true);
    expect(isValidatedSubtaskProposalRequest(structuredClone(h.request))).toBe(
      false,
    );
    expect(Object.isFrozen(h.request.input.context)).toBe(true);
    expect(h.request.input.parents).toHaveLength(1);
    expect(h.request.input.context).toContainEqual(h.parentSource);
    expect(h.request.input.context).toContainEqual(h.latest);
    expect(h.request.input.schema).toMatchObject({
      type: "object",
      required: ["proposals"],
      additionalProperties: false,
    });
    expect(
      Buffer.byteLength(JSON.stringify(h.request.input)),
    ).toBeLessThanOrEqual(24576);
    expect(h.request.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      buildSubtaskProposal(h.batch, structuredClone(h.journal), h.options)
        ?.requestHash,
    ).toBe(h.request.requestHash);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it("maps paraphrased obligations to exact canonical provenance without changing parent or store", () => {
    const h = fixture();
    const parent = structuredClone(h.parent);
    const applied = applySubtaskProposal(h.request, raw(h.proposal), h.options);
    expect(applied).toMatchObject({
      status: "accepted",
      admission: {
        parent,
        expectedListRevision: 0,
        complete: false,
        removals: [],
        proof: {
          contextHash: h.batch.contextHash,
          gateRequestHash: h.batch.requestHash,
          proposalRequestHash: h.request.requestHash,
        },
        children: [
          {
            kind: "add",
            label: "Evaluate deployment tradeoffs",
            source: {
              entryId: h.latest.id,
              messageHash: h.latest.hash,
              role: "user",
              start: 0,
              end: h.latest.text.length,
              quoteHash: h.latest.hash,
            },
          },
        ],
      },
    });
    expect(h.latest.text).not.toContain(h.proposal.children[0].label);
    expect(h.store.snapshot().groups).toEqual([]);
    expect(h.parent).toEqual(parent);
    if (applied?.status !== "accepted") throw new Error("Expected admission");
    expect(h.store.admit(applied.admission)).toEqual({ accepted: true });
    const before = h.store.snapshot();
    expect(before.groups[0].children[0].status).toBe("pending");
    expect(h.store.admit(applied.admission)).toEqual({ accepted: true });
    expect(h.store.snapshot()).toEqual(before);
  });
  it.each([
    "no",
    "uncertain",
    "low",
    "missing",
    "dispatched",
    "budget",
    "foreign",
  ])("builds no proposal for %s permission", (mode) => {
    const h = subtaskProposalFixture();
    const record = h.journal.records[0];
    if (!record.gate) throw new Error("Expected gate");
    if (mode === "no" || mode === "uncertain") {
      record.gate.choice = mode;
      record.state = "complete";
    }
    if (mode === "low") {
      record.gate.confidence = 0.49;
      record.state = "complete";
    }
    if (mode === "missing") h.journal.records = [];
    if (mode === "dispatched") record.state = "dispatched";
    if (mode === "budget") {
      h.journal.dispatches = 1024;
      h.journal.usage.jev.calls = 1024;
    }
    if (mode === "foreign") h.options.parent.id = "task:2";
    expect(buildSubtaskProposal(h.batch, h.journal, h.options)).toBeUndefined();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it("treats empty proposals as no-op, never withdrawal", () => {
    const h = fixture(true);
    const before = h.store.snapshot();
    expect(
      applySubtaskProposal(h.request, '{"proposals":[]}', h.options),
    ).toEqual({ status: "noop" });
    expect(h.store.snapshot()).toEqual(before);
  });
  it("rejects changed report state until a current gate receipt authorizes the updated snapshot", () => {
    const h = fixture(true);
    const group = h.options.group;
    if (!group) throw new Error("Expected group");
    expect(
      h.store.report({
        groupId: group.id,
        listRevision: group.listRevision,
        childIds: [group.children[0].id],
        source: h.parent.source,
        status: "reported-completed",
      }),
    ).toEqual({ accepted: true });
    h.options.group = h.store.snapshot().groups[0];
    // Updated reported status is part of a new gate context; a current receipt is required.
    expect(
      applySubtaskProposal(h.request, raw(h.proposal), h.options),
    ).toBeUndefined();
  });
  it.each(["reword", "replace"])(
    "maps %s using supplied child indices with full-list accounting",
    (kind) => {
      const h = fixture(true, true);
      const group = h.options.group;
      if (!group) throw new Error("Expected group");
      const proposal = {
        ...h.proposal,
        children: [
          { kind: "retain", childIndex: 1 },
          {
            kind,
            childIndex: 0,
            label: "Compare operating expenses",
            evidence: h.evidence,
          },
        ],
      };
      const result = applySubtaskProposal(h.request, raw(proposal), h.options);
      if (result?.status !== "accepted")
        throw new Error("Expected mapped edit");
      expect(h.store.admit(result.admission)).toEqual({ accepted: true });
      const children = h.store.snapshot().groups[0].children;
      expect(children[0].id).toBe(group.children[1].id);
      if (kind === "reword") {
        expect(children[1].id).toBe(group.children[0].id);
        expect(children[1].status).toBe("reported-completed");
      } else {
        expect(children[1].id).not.toBe(group.children[0].id);
        expect(children[1].status).toBe("pending");
      }
    },
  );
  it("maps explicit grounded removal, never silently removes omitted existing children", () => {
    const h = fixture(true);
    const retained = {
      ...h.proposal,
      children: [{ kind: "retain", childIndex: 0 }],
    };
    expect(
      applySubtaskProposal(h.request, raw(retained), h.options),
    ).toBeUndefined();
    const result = applySubtaskProposal(
      h.request,
      raw({
        ...retained,
        removals: [
          { childIndex: 1, reason: "withdrawn", evidence: h.evidence },
        ],
      }),
      h.options,
    );
    if (result?.status !== "accepted")
      throw new Error("Expected explicit removal mapping");
    expect(h.store.admit(result.admission)).toEqual({ accepted: true });
    expect(h.store.snapshot().groups[0].retired[0].retirement.reason).toBe(
      "withdrawn",
    );
    // Mechanical provenance only, not a semantic claim that fixture text warrants removal.
  });
  it.each(["parent", "model", "source", "omissions"])(
    "rejects stale %s and forged requests",
    (mode) => {
      const h = fixture();
      expect(
        applySubtaskProposal(
          structuredClone(h.request),
          raw(h.proposal),
          h.options,
        ),
      ).toBeUndefined();
      if (mode === "parent") h.options.parent.revision++;
      if (mode === "model") h.options.selectedModel = "fixture/other";
      if (mode === "source") {
        h.latest.text += " Pause.";
        h.latest.hash = subtaskHash(h.latest.text);
      }
      if (mode === "omissions")
        h.options.omissions = ["Additional omitted context"];
      expect(
        applySubtaskProposal(h.request, raw(h.proposal), h.options),
      ).toBeUndefined();
    },
  );
  it.each([
    "parent-index",
    "child-id",
    "status",
    "foreign-range",
    "range-end",
    "empty-range",
    "long-label",
    "control-label",
    "duplicate-child",
    "incomplete-list",
    "known-total",
  ])("rejects %s atomically", (mode) => {
    const h = fixture();
    let proposal: unknown = h.proposal;
    if (mode === "parent-index") proposal = { ...h.proposal, parentIndex: 1 };
    if (mode === "child-id")
      proposal = {
        ...h.proposal,
        children: [
          {
            kind: "add",
            id: "subtask-child:42",
            label: "Invented",
            evidence: h.evidence,
          },
        ],
      };
    if (mode === "status")
      proposal = {
        ...h.proposal,
        children: [{ ...h.proposal.children[0], status: "reported-completed" }],
      };
    if (mode === "foreign-range")
      proposal = {
        ...h.proposal,
        children: [
          {
            ...h.proposal.children[0],
            evidence: [{ contextIndex: 999, start: 0, end: 1 }],
          },
        ],
      };
    if (mode === "range-end") h.evidence[0].end++;
    if (mode === "empty-range") h.evidence[0].end = 0;
    if (mode === "long-label") h.proposal.children[0].label = "😀".repeat(241);
    if (mode === "control-label") h.proposal.children[0].label = "Do\u200bit";
    if (mode === "duplicate-child")
      proposal = {
        ...h.proposal,
        children: [
          { kind: "retain", childIndex: 0 },
          { kind: "retain", childIndex: 0 },
        ],
      };
    if (mode === "incomplete-list")
      proposal = {
        ...h.proposal,
        children: [{ kind: "retain", childIndex: 0 }],
      };
    if (mode === "known-total")
      proposal = { ...h.proposal, complete: true, knownTotal: 2 };
    expect(
      applySubtaskProposal(h.request, raw(proposal), h.options),
    ).toBeUndefined();
    expect(h.store.snapshot().groups).toEqual([]);
  });
  it.each([
    '{"proposals":[],"proposals":[]}',
    '{"proposals":[],"extra":1}',
    '```json\n{"proposals":[]}\n```',
    '{"proposals":[]} trailing',
    " ".repeat(32769),
  ])("rejects duplicate keys/extras/non-JSON/oversize output %#", (text) => {
    const h = fixture();
    expect(applySubtaskProposal(h.request, text, h.options)).toBeUndefined();
  });
});
