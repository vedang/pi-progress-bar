export type ReportState =
  | "done"
  | "reopened"
  | "not-started"
  | "in-progress"
  | "cancelled"
  | "unknown"
  | "conflict";
interface SourceRef {
  sourceId: string;
  entryId?: string;
  start: number;
  end: number;
  provenance: "file-marker" | "user" | "assistant" | "interactive-user";
}
export interface SourceTask {
  text: string;
  status: ReportState;
  anchor?: string;
  criteria: string[];
  ref: SourceRef;
}
export interface SourceSnapshot {
  sourceId: string;
  kind: "checklist" | "conversation";
  revision: string;
  complete: boolean;
  tasks: SourceTask[];
}
export interface Task extends SourceTask {
  id: string;
  included: boolean;
  beads?: {
    id: string;
    title: string;
    exportStatus?: string;
    issueType?: string;
    conflict: boolean;
  };
}
export interface Ledger {
  sourceId: string;
  kind: SourceSnapshot["kind"];
  sourceRevision: string;
  scopeRevision: string;
  tasks: Task[];
  currentTaskId?: string;
  stale: boolean;
  reportOrder: number;
  reports: ReportBatch[];
  nextTaskId: number;
  explicitSelection: boolean;
}
export interface ReportBatch {
  sourceId: string;
  scopeRevision: string;
  order: number;
  entryId: string;
  states: Record<string, ReportState>;
}
