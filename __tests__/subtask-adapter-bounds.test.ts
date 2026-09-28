import { describe, expect, it } from "vitest";
import { ownDataJson } from "../src/analysis/own-data-json";
import {
  type CoverageAdapter,
  type CoverageToolStart,
  isCurrentSubtaskAccessEvidence,
} from "../src/sources/coverage";
import { subtaskAccessFixture } from "./fixtures/subtask-access";

const buckets = [
  "pending",
  "manifests",
  "declarations",
  "scriptReads",
  "listings",
  "accessReceipts",
] as const;
type Bucket = (typeof buckets)[number];
type State = Record<Bucket, unknown[]> & { frontier?: unknown };
// [ref:subtask_adapter_inert_budget]
// White-box read-only measurement of the adapter's documented shared budget.
// All fixtures enter state through real public start/end/confirm operations.
function internal(adapter: CoverageAdapter) {
  return adapter as unknown as Record<Bucket, Map<string, unknown>> & {
    frontier?: unknown;
    nextStartOrder: number;
    candidate(input: CoverageToolStart, order: number): unknown;
  };
}
function state(adapter: CoverageAdapter): State {
  const current = internal(adapter);
  return {
    ...Object.fromEntries(
      buckets.map((key) => [key, [...current[key].values()]]),
    ),
    ...(current.frontier ? { frontier: current.frontier } : {}),
  } as State;
}
function bytes(value: unknown) {
  const encoded = ownDataJson(value);
  if (!encoded) throw new Error("Expected inert JSON fixture");
  return Buffer.byteLength(encoded.json, "utf8");
}
function seed() {
  const f = subtaskAccessFixture([["One", "Two"], ["Third"]]);
  for (const [i, count] of [64, 64, 32].entries()) {
    const names = Array.from({ length: count }, (_, n) =>
      String(n).padEnd(240, "x"),
    );
    f.run(
      `bulk-${i}`,
      "bash",
      { command: `unzip -p docs/bulk-${i}.xlsx xl/workbook.xml` },
      `<workbook><sheets>${names.map((name) => `<sheet name="${name}"/>`).join("")}</sheets></workbook>`,
    );
  }
  if (internal(f.adapter).manifests.size !== 5)
    throw new Error("Expected all valid seed manifests");
  return f;
}
function fillTo(adapter: CoverageAdapter, target: number) {
  for (let n = 0; bytes(state(adapter)) < target; n++) {
    if (n > 14) throw new Error("Fixture would exceed pending cap");
    const current = state(adapter);
    const gap = target - bytes(current);
    const input = (length: number): CoverageToolStart => ({
      toolCallId: `fill-${n}`,
      toolName: "write",
      args: { path: "p".repeat(length), content: "x" },
    });
    const candidate = (length: number) =>
      internal(adapter).candidate(
        input(length),
        internal(adapter).nextStartOrder,
      );
    const delta = (length: number) =>
      bytes({ ...current, pending: [...current.pending, candidate(length)] }) -
      bytes(current);
    const min = delta(1),
      max = delta(1024);
    if (gap < min) throw new Error(`Insufficient padding gap ${gap}/${min}`);
    const chosen =
      gap <= max ? gap : gap > max + min + 32 ? max : Math.floor(gap / 2);
    const length = chosen - min + 1;
    if (length < 1 || length > 1024)
      throw new Error("Invalid fixture path bound");
    const before = bytes(current);
    adapter.start(input(length), 1);
    if (bytes(state(adapter)) !== before + chosen)
      throw new Error("Valid filler was not wholly admitted");
  }
  if (bytes(state(adapter)) !== target) throw new Error("Exact padding failed");
}

function boundary(kind: "pending" | "manifest" | "receipt", overflow: number) {
  const f = seed(),
    probe = seed();
  if (kind === "receipt") {
    for (const item of [f, probe])
      item.run(
        "first-read",
        "read",
        { path: "extracted/r0-0.txt" },
        "first body",
      );
  }
  const input: CoverageToolStart =
    kind === "pending"
      ? {
          toolCallId: "target",
          toolName: "write",
          args: { path: "target.sh", content: "x" },
        }
      : kind === "manifest"
        ? {
            toolCallId: "target",
            toolName: "bash",
            args: { command: "unzip -p docs/target.xlsx xl/workbook.xml" },
          }
        : {
            toolCallId: "target",
            toolName: "read",
            args: { path: "extracted/r0-1.txt" },
          };
  const text =
    kind === "manifest"
      ? '<workbook><sheets><sheet name="Target"/></sheets></workbook>'
      : "target body";
  const bucket: Bucket =
    kind === "pending"
      ? "pending"
      : kind === "manifest"
        ? "manifests"
        : "accessReceipts";
  const key = kind === "manifest" ? "docs/target.xlsx" : "target";
  probe.adapter.start(input, 1);
  if (kind !== "pending")
    probe.run(
      "target",
      input.toolName,
      input.args as Record<string, unknown>,
      text,
    );
  const admitted = internal(probe.adapter)[bucket].get(key);
  if (!admitted) throw new Error("Expected ordinary target admission");
  if (kind !== "pending") f.adapter.start(input, 1);
  // Simulate an extra retained filler to account for comma removal/insertion.
  const before = state(f.adapter);
  const pendingTarget = internal(f.adapter).pending.get("target");
  before.pending = [...before.pending, { fixture: true }];
  const after: State = {
    ...before,
    pending: before.pending.filter((item) => item !== pendingTarget),
  };
  after[bucket] = [...after[bucket], admitted];
  if (kind !== "pending") after.frontier = internal(probe.adapter).frontier;
  const delta = bytes(after) - bytes(before);
  fillTo(f.adapter, 65536 + overflow - delta);
  const count = internal(f.adapter)[bucket].size;
  if (kind === "pending") f.adapter.start(input, 1);
  else
    f.run(
      "target",
      input.toolName,
      input.args as Record<string, unknown>,
      text,
    );
  return {
    adapter: f.adapter,
    accepted: internal(f.adapter)[bucket].size === count + 1,
  };
}

function assertMeasuredBudget(adapter: CoverageAdapter) {
  const current = state(adapter);
  expect(adapter.snapshot()).toMatchObject({
    pendingCount: current.pending.length,
    pendingBytes: current.pending.length ? bytes(current.pending) : 0,
    retainedBytes: bytes(current),
  });
}

describe("hook-free exact shared adapter budget", () => {
  it("measures mixed preconfirmation candidates, confirmed allocation, stable confirmation and reset without child admission", () => {
    const f = subtaskAccessFixture([["One", "Two"]]);
    const children = f.store.snapshot();
    const measurements = [
      { snapshot: f.adapter.snapshot(), state: state(f.adapter) },
    ];
    expect(bytes(state(f.adapter))).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) {
      const toolName = i % 2 ? "read" : "bash";
      const args =
        i % 2
          ? { path: "extracted/r0-0.txt" }
          : { command: `unzip -p docs/pending-${i}.xlsx xl/workbook.xml` };
      f.adapter.start({ toolCallId: `pending-${i}`, toolName, args }, 1);
      f.adapter.end({ toolCallId: `pending-${i}`, toolName }, 1);
    }
    expect(f.adapter.snapshot().pendingCount).toBe(16);
    expect(f.adapter.snapshot().omissions).toBeGreaterThanOrEqual(4);
    measurements.push({
      snapshot: f.adapter.snapshot(),
      state: state(f.adapter),
    });
    expect(bytes(state(f.adapter).pending)).toBeGreaterThan(2);
    expect(bytes(state(f.adapter))).toBeLessThanOrEqual(65536);
    const before = f.adapter.snapshot();
    f.adapter.confirm(f.entries, 1);
    expect(f.adapter.snapshot()).toEqual(before);
    expect(f.store.snapshot()).toEqual(children);
    f.adapter.reset(2);
    measurements.push({
      snapshot: f.adapter.snapshot(),
      state: state(f.adapter),
    });
    expect(f.adapter.snapshot()).toMatchObject({
      pendingCount: 0,
      omissions: 0,
    });
    expect(f.adapter.metadata()).toBeUndefined();
    expect(f.adapter.accessEvidence()).toMatchObject({
      mapped: [],
      active: [],
      confirmed: [],
    });
    expect(f.store.snapshot()).toEqual(children);
    for (const measurement of measurements)
      expect(measurement.snapshot).toMatchObject({
        pendingBytes: measurement.state.pending.length
          ? bytes(measurement.state.pending)
          : 0,
        retainedBytes: bytes(measurement.state),
      });
  });
  it("includes mapping-stale pending cleanup in exact listing replacement preflight", () => {
    const f = seed(),
      probe = seed();
    const args = { command: "bash export-0.sh docs/resource-0.xlsx" };
    const path = `extracted/${"x".repeat(650)}.txt`;
    const text = `One rows 3 nonempty rows 1 file ${path}\nTwo rows 2 nonempty rows 1 file extracted/r0-1.txt`;
    for (const item of [f, probe]) {
      item.adapter.start(
        {
          toolCallId: "stale-read",
          toolName: "read",
          args: { path: "extracted/r0-0.txt" },
        },
        1,
      );
      item.adapter.start(
        { toolCallId: "replacement", toolName: "bash", args },
        1,
      );
    }
    probe.run("replacement", "bash", args, text);
    const next = internal(probe.adapter).listings.get("docs/resource-0.xlsx");
    if (!next) throw new Error("Expected ordinary replacement");
    const old = internal(f.adapter).listings.get("docs/resource-0.xlsx");
    const stale = internal(f.adapter).pending.get("stale-read");
    const candidate = internal(f.adapter).pending.get("replacement");
    const before = state(f.adapter);
    before.pending = [...before.pending, { fixture: true }];
    const after = {
      ...before,
      pending: before.pending.filter(
        (item) => item !== stale && item !== candidate,
      ),
      listings: before.listings.map((item) => (item === old ? next : item)),
      frontier: internal(probe.adapter).frontier,
    };
    const delta = bytes(after) - bytes(before);
    if (delta < 0)
      throw new Error("Fixture must require reclaimed pending capacity");
    fillTo(f.adapter, 65536 - delta);
    f.run("replacement", "bash", args, text);
    expect(internal(f.adapter).listings.get("docs/resource-0.xlsx")).toEqual(
      next,
    );
    expect(f.adapter.activity()).toEqual([]);
    expect(bytes(state(f.adapter))).toBe(65536);
  });
  it.each(["pending", "manifest", "receipt"] as const)(
    "accepts exact65536-byte %s post-state",
    (kind) => {
      const result = boundary(kind, 0);
      expect(result.accepted).toBe(true);
      expect(bytes(state(result.adapter))).toBe(65536);
      assertMeasuredBudget(result.adapter);
    },
  );
  it.each(["pending", "manifest", "receipt"] as const)(
    "rejects65537-byte %s post-state atomically",
    (kind) => {
      const result = boundary(kind, 1);
      expect(result.accepted).toBe(false);
      expect(bytes(state(result.adapter))).toBeLessThanOrEqual(65536);
    },
  );
  it.each([Object.prototype, Array.prototype])(
    "never consults inherited hooks for private state or mapping invalidation %#",
    (prototype) => {
      const previous = Object.getOwnPropertyDescriptor(prototype, "toJSON");
      let reads = 0;
      let oldCurrent = true;
      try {
        Object.defineProperty(prototype, "toJSON", {
          configurable: true,
          get() {
            reads++;
            return () => "constant";
          },
        });
        const f = subtaskAccessFixture();
        const old = f.adapter.accessEvidence();
        const listing = f.entries.find((item) => item.id === "result-list-0");
        if (!listing) throw new Error("Expected listing");
        listing.message.content[0].text =
          "One rows 2 nonempty rows 1 file extracted/changed.txt";
        f.adapter.confirm(f.entries, 1);
        oldCurrent = isCurrentSubtaskAccessEvidence(old);
        // Call diagnostics while hooks are installed, but assert outside them.
        f.adapter.snapshot();
      } finally {
        if (previous) Object.defineProperty(prototype, "toJSON", previous);
        else Reflect.deleteProperty(prototype, "toJSON");
      }
      expect(reads).toBe(0);
      expect(oldCurrent).toBe(false);
    },
  );
  it.each([Object.prototype, Array.prototype])(
    "does not let inherited hooks bypass shared capacity %#",
    (prototype) => {
      const previous = Object.getOwnPropertyDescriptor(prototype, "toJSON");
      let reads = 0;
      let result: ReturnType<typeof boundary> | undefined;
      try {
        Object.defineProperty(prototype, "toJSON", {
          configurable: true,
          get() {
            reads++;
            return () => "constant";
          },
        });
        result = boundary("pending", 1);
      } finally {
        if (previous) Object.defineProperty(prototype, "toJSON", previous);
        else Reflect.deleteProperty(prototype, "toJSON");
      }
      expect(reads).toBe(0);
      expect(result?.accepted).toBe(false);
      expect(result && bytes(state(result.adapter))).toBeLessThanOrEqual(65536);
    },
  );
});
