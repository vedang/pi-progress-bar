import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { CoverageStore } from "../src/core/coverage";
import {
  type CoverageReportDispatchCheckpoint,
  encodeCheckpoint,
} from "../src/core/hybrid-checkpoint";
import { coverageInventory, coverageSource } from "./fixtures/coverage";
import { initial } from "./fixtures/hybrid";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
it("fits all21 assessment receipts for20 legal parents and40children", async () => {
  const state = await initial();
  state.tasks = Array.from({ length: 20 }, (_, i) => ({
    ...state.tasks[0],
    id: `task:${i + 1}`,
  }));
  state.nextTaskId = 21;
  state.events = state.tasks.map((task, index) => ({
    id: `event:${index + 1}`,
    kind: "create",
    taskId: task.id,
    revision: task.revision,
    source: {
      entryId: task.source.entryId,
      messageHash: task.source.messageHash,
      role: task.source.role,
    },
  }));
  // Validate the parent fixture independently before exercising coverage limits.
  expect(() => encodeCheckpoint(state)).not.toThrow();
  const store = new CoverageStore();
  for (const [i, parent] of state.tasks.entries()) {
    expect(
      store.admit({
        parent,
        intent: parent.source,
        inventory: coverageInventory(
          Array.from({ length: i === 19 ? 21 : 1 }, (_, j) => `Sheet ${j + 1}`),
        ),
      }).accepted,
    ).toBe(true);
  }
  const receipts: CoverageReportDispatchCheckpoint[] = [];
  for (const group of store.snapshot().groups) {
    for (let offset = 0; offset < group.children.length; offset += 20) {
      const childIds = group.children
        .slice(offset, offset + 20)
        .map((child) => child.id);
      receipts.push({
        jobIdentity: hash(group.parentTaskId),
        requestHash: hash(`${group.id}:${offset}`),
        groupId: group.id,
        inventoryRevision: group.inventoryRevision,
        source: coverageSource("report"),
        childIds,
        assessments: childIds.map((childId) => ({
          childId,
          choice: "unchanged",
          confidence: 1,
          probability: 1,
        })),
        dispatch: receipts.length + 1,
        at: 1000,
        usage: { inputTokens: 1, outputTokens: 1 },
        outcome: "accepted",
      });
    }
  }
  const usage = {
    jev: { calls: 21, inputTokens: 21, outputTokens: 21 },
    extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
  };
  const coverage = {
    state: store.checkpoint(),
    dispatches: 21,
    usage,
    reportReceipts: receipts,
  };
  expect(receipts).toHaveLength(21);
  expect(Buffer.byteLength(JSON.stringify(coverage))).toBeLessThan(64 * 1024);
  expect(() =>
    encodeCheckpoint(state, {
      enabled: true,
      usage,
      coverage: { ...coverage, reportReceipts: receipts.slice(0, 20) },
    }),
  ).not.toThrow();
  expect(() =>
    encodeCheckpoint(state, { enabled: true, usage, coverage }),
  ).not.toThrow();
});
