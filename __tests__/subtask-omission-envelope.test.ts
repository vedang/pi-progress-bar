import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  canCommitSubtaskCheckpoint,
  commitSubtaskCheckpoint,
  encodeSubtaskCheckpoint,
  restoreSubtaskCheckpoint,
  type SubtaskMonitorCheckpointMetadata,
  type SubtaskOmissionReason,
  type SubtaskOmissionSummary,
  type subtaskCheckpointBytes,
  subtaskCheckpointStorageStatus,
} from "../src/core/hybrid-checkpoint";
import { emptyState } from "../src/core/hybrid-state";
import { SubtaskStore } from "../src/core/subtasks";

// Public encoders remain typed; only negative fixtures cross unknown-data boundaries.
type EncoderMetadata =
  | Parameters<typeof encodeSubtaskCheckpoint>[1]
  | Parameters<typeof commitSubtaskCheckpoint>[1]
  | Parameters<typeof canCommitSubtaskCheckpoint>[1]
  | Parameters<typeof subtaskCheckpointBytes>[1];
expectTypeOf<EncoderMetadata>().toEqualTypeOf<
  SubtaskMonitorCheckpointMetadata | undefined
>();

const state = () => emptyState("session:omission-codec");
const usage = () => ({
  jev: { calls: 0, inputTokens: 0, outputTokens: 0 },
  extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
});
const entry = (index: number, reason: SubtaskOmissionReason = "coalesced") => ({
  identity: index.toString(16).padStart(64, "0"),
  reason,
});
const summary = () => ({ entries: [entry(1)], saturated: false });
const metadata = (subtaskOmissions: SubtaskOmissionSummary) => ({
  enabled: true,
  usage: usage(),
  subtaskOmissions,
});
// Deliberately invalid external data belongs only at negative-test boundaries.
const invalidMetadata = (value: unknown) =>
  metadata(value as SubtaskOmissionSummary);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

// [ref:subtask_omission_summary] Persistence is diagnostic, not report authority.
describe("strict v11 semantic omission metadata", () => {
  it("keeps absent zero state valid without introducing a new version", () => {
    const checkpoint = encodeSubtaskCheckpoint(state(), {
      enabled: true,
      usage: usage(),
    });
    expect(checkpoint.version).toBe(11);
    expect(checkpoint.monitor).not.toHaveProperty("subtaskOmissions");
    expect(subtaskCheckpointStorageStatus(checkpoint)).toBe("supported");
  });
  it.each([false, true])(
    "roundtrips detached summary without a subtask component, saturated=%s",
    (saturated) => {
      const value = {
        entries: [entry(1), entry(2, "report-oversized"), entry(3, "capacity")],
        saturated,
      };
      const checkpoint = encodeSubtaskCheckpoint(state(), metadata(value));
      expect(subtaskCheckpointStorageStatus(checkpoint)).toBe("supported");
      expect(checkpoint.monitor).not.toHaveProperty("subtasks");
      const restored = restoreSubtaskCheckpoint(
        checkpoint,
        state().sourceId,
        () => undefined,
        () => [],
      );
      expect(restored?.monitor).toMatchObject({ subtaskOmissions: value });
      value.entries[0].reason = "capacity";
      expect(checkpoint.monitor).toMatchObject({
        subtaskOmissions: {
          entries: [
            entry(1),
            entry(2, "report-oversized"),
            entry(3, "capacity"),
          ],
          saturated,
        },
      });
    },
  );
  it("retains an empty saturated summary as positive incomplete diagnostics", () => {
    const value = { entries: [], saturated: true };
    const checkpoint = encodeSubtaskCheckpoint(state(), metadata(value));
    expect(checkpoint.monitor).toMatchObject({ subtaskOmissions: value });
    expect(subtaskCheckpointStorageStatus(checkpoint)).toBe("supported");
  });
  it("accepts64 distinct entries but never65", () => {
    const value = {
      entries: Array.from({ length: 64 }, (_, i) => entry(i)),
      saturated: true,
    };
    expect(canCommitSubtaskCheckpoint(state(), metadata(value))).toBe(true);
    value.entries.push(entry(64));
    expect(canCommitSubtaskCheckpoint(state(), metadata(value))).toBe(false);
  });
  it.each([
    null,
    { entries: [], saturated: false },
    { entries: [entry(1)], saturated: 1 },
    { entries: [entry(1)] },
    { ...summary(), body: "PRIVATE_REPORT" },
    { entries: [{ ...entry(1), text: "PRIVATE_REPORT" }], saturated: false },
    { entries: [entry(1), entry(1, "capacity")], saturated: true },
    {
      entries: [{ identity: "A".repeat(64), reason: "coalesced" }],
      saturated: false,
    },
    { entries: [{ ...entry(1), reason: "adapter" }], saturated: false },
    { entries: Array(1), saturated: false },
  ])("rejects malformed or noncanonical omission summary %#", (value) => {
    const checkpoint = encodeSubtaskCheckpoint(state(), {
      enabled: true,
      usage: usage(),
    });
    const invalid = {
      ...checkpoint,
      monitor: { ...checkpoint.monitor, subtaskOmissions: value },
    };
    expect(subtaskCheckpointStorageStatus(invalid)).toBe("corrupt");
    expect(
      restoreSubtaskCheckpoint(
        invalid,
        state().sourceId,
        () => undefined,
        () => [],
      ),
    ).toBeUndefined();
    expect(canCommitSubtaskCheckpoint(state(), invalidMetadata(value))).toBe(
      false,
    );
  });
  it("never invokes getters or inherited serialization on summary input", () => {
    const getter = vi.fn(() => [entry(1)]);
    const toJSON = vi.fn(() => summary());
    const accessor = Object.defineProperty({ saturated: false }, "entries", {
      enumerable: true,
      get: getter,
    });
    for (const value of [
      accessor,
      Object.assign(Object.create({ toJSON }), summary()),
    ]) {
      expect(canCommitSubtaskCheckpoint(state(), invalidMetadata(value))).toBe(
        false,
      );
    }
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });
  it("charges actual summary wrapper bytes to the shared64KiB reserve boundary", () => {
    const subtasks = {
      state: new SubtaskStore().checkpoint(),
      journal: {
        version: 1 as const,
        dispatches: 0,
        usage: usage(),
        records: [],
        reports: [],
      },
    };
    const subtaskOmissions = summary();
    const monitor = { ...metadata(subtaskOmissions), subtasks };
    const remaining = 64 * 1024 - bytes({ ...subtasks, subtaskOmissions });
    expect(
      canCommitSubtaskCheckpoint(state(), monitor, {
        storeBytes: 0,
        journalBytes: remaining,
      }),
    ).toBe(true);
    expect(
      canCommitSubtaskCheckpoint(state(), monitor, {
        storeBytes: 0,
        journalBytes: remaining + 1,
      }),
    ).toBe(false);
    expect(
      canCommitSubtaskCheckpoint(
        state(),
        { enabled: true, usage: usage(), subtasks },
        { storeBytes: 0, journalBytes: remaining + 1 },
      ),
    ).toBe(true);
  });
  it("requires internal exact-true adoption and gives the saver detached data", () => {
    const value = summary();
    const save = vi.fn((_checkpoint: unknown) => true);
    expect(
      commitSubtaskCheckpoint(state(), metadata(value), save),
    ).toBeDefined();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      monitor: { subtaskOmissions: summary() },
    });
    value.entries[0].reason = "capacity";
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      monitor: { subtaskOmissions: summary() },
    });
    const veto = vi.fn(() => false);
    expect(
      commitSubtaskCheckpoint(state(), metadata(summary()), veto),
    ).toBeUndefined();
    expect(veto).toHaveBeenCalledTimes(1);
  });
});
