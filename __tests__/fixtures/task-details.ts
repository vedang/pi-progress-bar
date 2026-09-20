import { createHash } from "node:crypto";
import type { EvaluationRequest } from "../../src/analysis/gateway";
import type { MonitorCheckpointMetadata } from "../../src/core/hybrid-checkpoint";
import type {
  Assessment,
  HybridTask,
  Observation,
  SourceRef,
} from "../../src/core/hybrid-state";

// Main-owned frozen contract; replace with production imports after source handoff.
export interface DetailRecord {
  taskId: string;
  revision: number;
  label: string;
  taskSource: SourceRef;
  candidates: { key: string; source: SourceRef }[];
  receipts: {
    requestHash: string;
    candidateKeys: string[];
    assessments: Assessment[];
    validatedAt: number;
  }[];
}
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
export const isDetailRequest = (request: EvaluationRequest) =>
  Object.keys(request.questions).some((key) => key.startsWith("detail:"));
export function savedDetails(checkpoint: unknown): DetailRecord[] {
  return (
    (checkpoint as { monitor?: { taskDetails?: DetailRecord[] } }).monitor
      ?.taskDetails ?? []
  );
}
