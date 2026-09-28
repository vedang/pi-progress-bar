import { expect, it, vi } from "vitest";
import {
  subtaskReportBatches,
  subtaskReportOmissionIdentity,
} from "../src/analysis/subtask-report";
import { subtaskReportFixture } from "./fixtures/subtask-report";
import { subtaskHash, subtaskSource } from "./fixtures/subtasks";

function fixture(text?: string) {
  const h = subtaskReportFixture(undefined, true, text);
  return {
    h,
    input: {
      sourceId: "session:omission",
      parent: structuredClone(h.options.parent),
      group: structuredClone(h.options.group),
      reportSource: {
        ...subtaskSource(h.options.report.id, h.options.report.text),
        role: h.options.report.role,
      },
    },
  };
}
type Input = ReturnType<typeof fixture>["input"];

it("leaves the existing durable report-job identity unchanged", () => {
  expect(
    subtaskReportBatches(subtaskReportFixture().options)[0].jobIdentity,
  ).toBe("aebe9fd57141c8dfb0ba1f5ecddd8d5a12c8abb75d241f3503bd8db4cf52b871");
});

it("hashes a deterministic domain-separated report opportunity without mutating metadata", () => {
  const { h, input } = fixture();
  const before = structuredClone(input);
  const first = subtaskReportOmissionIdentity(input);
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(subtaskReportOmissionIdentity(structuredClone(input))).toBe(first);
  expect(first).not.toBe(subtaskReportBatches(h.options)[0].jobIdentity);
  expect(input).toEqual(before);
});
it("does not need an oversized body, resolver, or successfully constructed request", () => {
  const { h, input } = fixture(`PRIVATE_OVERSIZED ${"body ".repeat(20000)}`);
  expect(Buffer.byteLength(h.options.report.text)).toBeGreaterThan(64 * 1024);
  expect(subtaskReportBatches(h.options)).toEqual([]);
  expect(JSON.stringify(input)).not.toContain("PRIVATE_OVERSIZED");
  expect(subtaskReportOmissionIdentity(input)).toMatch(/^[a-f0-9]{64}$/);
});
it("ignores mutable parent/child statuses and group diagnostic history", () => {
  const { input } = fixture();
  const identity = subtaskReportOmissionIdentity(input);
  input.parent.status = "done";
  input.group.children[0].status = "reported-completed";
  input.group.omissions = ["Existing diagnostic information"];
  expect(subtaskReportOmissionIdentity(input)).toBe(identity);
});
it.each<[string, (input: Input) => void]>([
  [
    "session",
    (x) => {
      x.sourceId = "session:different";
    },
  ],
  [
    "parent id",
    (x) => {
      x.parent.id = "task:2";
      x.group.parentTaskId = "task:2";
    },
  ],
  [
    "parent label",
    (x) => {
      x.parent.label += " amended";
    },
  ],
  [
    "parent revision",
    (x) => {
      x.parent.revision++;
      x.group.parentRevision++;
    },
  ],
  [
    "parent provenance",
    (x) => {
      x.parent.source.messageHash = subtaskHash("changed-parent");
      x.group.parentSourceDigest = subtaskHash("changed-parent-binding");
    },
  ],
  [
    "group id",
    (x) => {
      x.group.id = "subtask-group:2";
    },
  ],
  [
    "list revision",
    (x) => {
      x.group.listRevision++;
    },
  ],
  [
    "admission source",
    (x) => {
      x.group.source.entryId = "different-admission";
    },
  ],
  [
    "gate proof",
    (x) => {
      x.group.proof.gateRequestHash = subtaskHash("different-gate");
    },
  ],
  [
    "proposal proof",
    (x) => {
      x.group.proof.proposalRequestHash = subtaskHash("different-proposal");
    },
  ],
  [
    "context proof",
    (x) => {
      x.group.proof.contextHash = subtaskHash("different-context");
    },
  ],
  [
    "completeness",
    (x) => {
      x.group.complete = false;
    },
  ],
  [
    "known total",
    (x) => {
      x.group.knownTotal = 23;
    },
  ],
  [
    "ordered roster",
    (x) => {
      x.group.children.reverse();
    },
  ],
  [
    "child label",
    (x) => {
      x.group.children[0].label += " amended";
    },
  ],
  [
    "child source",
    (x) => {
      x.group.children[0].source.entryId = "different-child-source";
    },
  ],
  [
    "report entry",
    (x) => {
      x.reportSource.entryId = "different-report";
    },
  ],
  [
    "report whole hash",
    (x) => {
      x.reportSource.messageHash = subtaskHash("different-report");
    },
  ],
  [
    "report role",
    (x) => {
      x.reportSource.role = "user";
    },
  ],
  [
    "report span",
    (x) => {
      x.reportSource.end++;
    },
  ],
  [
    "report quote hash",
    (x) => {
      x.reportSource.quoteHash = subtaskHash("different-quote");
    },
  ],
])("distinguishes %s bindings", (_name, change) => {
  const { input } = fixture();
  const identity = subtaskReportOmissionIdentity(input);
  change(input);
  const changed = subtaskReportOmissionIdentity(input);
  expect(changed).toMatch(/^[a-f0-9]{64}$/);
  expect(changed).not.toBe(identity);
});
it("uses inert hashing even when an inherited serialization hook exists", () => {
  const { input } = fixture();
  const identity = subtaskReportOmissionIdentity(input);
  const hook = vi.fn(() => ({}));
  const descriptor = Object.getOwnPropertyDescriptor(
    Object.prototype,
    "toJSON",
  );
  let actual: string | undefined;
  try {
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value: hook,
    });
    actual = subtaskReportOmissionIdentity(input);
  } finally {
    if (descriptor)
      Object.defineProperty(Object.prototype, "toJSON", descriptor);
    else Reflect.deleteProperty(Object.prototype, "toJSON");
  }
  expect(hook).not.toHaveBeenCalled();
  expect(actual).toBe(identity);
});
