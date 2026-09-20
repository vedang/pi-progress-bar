import { createHash } from "node:crypto";
import type { TaskDetailRecord as DetailRecord } from "../../src/analysis/task-details";

export type { TaskDetailRecord as DetailRecord } from "../../src/analysis/task-details";

import type { MonitorCheckpointMetadata } from "../../src/core/hybrid-checkpoint";
import type { HybridTask, Observation } from "../../src/core/hybrid-state";
export const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Missing required fixture");
  return value;
};
export const detailAddExtraction = () => ({
  add: [
    {
      label: "Implement parser",
      kind: "action",
      basis: "explicit",
      quote: "Implement parser",
      details: {
        title: { quote: "Implement parser" },
        description: { quote: "add regression" },
        acceptanceCriteria: [{ quote: "validate it" }],
      },
    },
  ],
  revise: [],
  archive: [],
  restore: [],
  unresolved: false,
});
export function detailRecord(
  task: HybridTask,
  message: Observation,
): DetailRecord {
  const quote = "add regression";
  const start = message.text.indexOf(quote);
  if (start < 0) throw new Error("Missing quote fixture");
  return {
    taskId: task.id,
    revision: task.revision,
    label: task.label,
    taskSource: structuredClone(task.source),
    candidates: [
      {
        key: "description",
        source: {
          entryId: message.id,
          messageHash: message.hash,
          role: message.role,
          start,
          end: start + quote.length,
          quoteHash: createHash("sha256").update(quote).digest("hex"),
        },
      },
    ],
    receipts: [],
  };
}
export function detailMetadata(
  records: DetailRecord[],
): MonitorCheckpointMetadata & { taskDetails: DetailRecord[] } {
  return {
    enabled: false,
    usage: {
      jev: { calls: 0, inputTokens: 0, outputTokens: 0 },
      extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
    },
    taskDetails: structuredClone(records),
  };
}
export { isDetailRequest } from "../../src/analysis/task-details";
export function savedDetails(checkpoint: unknown): DetailRecord[] {
  return (
    (checkpoint as { monitor?: { taskDetails?: DetailRecord[] } }).monitor
      ?.taskDetails ?? []
  );
}
