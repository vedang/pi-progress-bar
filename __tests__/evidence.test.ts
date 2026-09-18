import { describe, expect, it } from "vitest";
import { EvidenceStore, redEvidenceLabel } from "../src/sources/evidence";

describe("passive red-test evidence", () => {
  it("requires a bound supported assertion failure for Observed red", () => {
    const store = new EvidenceStore();
    store.start("call-1", "bash", { command: "bun test parser" }, 10);
    store.finish(
      "call-1",
      "bash",
      {
        content: [
          {
            type: "text",
            text: "FAIL parser.test.ts\nAssertionError: expected 2 to be 1",
          },
        ],
        details: { exitCode: 1 },
        isError: true,
      },
      11,
    );
    expect(store.redObservation()).toMatchObject({
      kind: "observed-red",
      callId: "call-1",
    });
    expect(
      redEvidenceLabel({ reported: true, observed: store.redObservation() }),
    ).toBe("Observed red");
  });

  it.each([
    ["runner crash", "bun test", "process terminated: signal 9"],
    ["nonzero only", "bun test", "exit code 1"],
    [
      "not a runner",
      "cat parser.test.ts",
      "AssertionError: expected 2 to be 1",
    ],
  ])("does not promote %s", (_name, command, output) => {
    const store = new EvidenceStore();
    store.start("call-1", "bash", { command }, 1);
    store.finish(
      "call-1",
      "bash",
      { content: [{ type: "text", text: output }], isError: true },
      2,
    );
    expect(store.redObservation()).toBeUndefined();
  });

  it("rejects mismatched/spoofed call IDs and keeps Reported red distinct", () => {
    const store = new EvidenceStore();
    store.start("real", "bash", { command: "bun test" }, 1);
    store.finish(
      "spoof",
      "bash",
      {
        content: [{ type: "text", text: "FAIL\nAssertionError" }],
        isError: true,
      },
      2,
    );
    expect(store.redObservation()).toBeUndefined();
    expect(redEvidenceLabel({ reported: true })).toBe("Reported red");
    expect(redEvidenceLabel({ reported: false })).toBe("Unknown");
  });

  it("keeps Not needed independent from evidence", () => {
    expect(
      redEvidenceLabel({ applicability: "not-needed", reported: false }),
    ).toBe("Not needed");
    expect(
      redEvidenceLabel({ applicability: "not-needed", reported: true }),
    ).toBe("Reported red");
  });
});
