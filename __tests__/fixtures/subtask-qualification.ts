import { createHash } from "node:crypto";
import type { HybridTask, Observation } from "../../src/core/hybrid-state";
import type { SubtaskRuntimeCheckpoint } from "../../src/core/subtask-runtime";
import { SubtaskStore } from "../../src/core/subtasks";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export interface SubtaskQualificationCase {
  id: string;
  label: string;
  request: string;
  need: "yes" | "no" | "abstain";
  kind?: "action" | "response";
  children?: string[];
  latest?: { role: Observation["role"]; text: string };
  earlier?: { role: Observation["role"]; text: string }[];
  omissions?: string[];
  requiredConcepts: string[];
  forbiddenScope?: string[];
  reports: {
    text: string;
    completedConcepts: string[];
    blockedConcepts?: string[];
    uncertainConcepts?: string[];
  }[];
}

/** Synthetic accepted parent/list, not proof of prior provider calls or host persistence. */
export function subtaskQualificationFixture(
  item: SubtaskQualificationCase,
  selectedModel: string,
) {
  const parentSource: Observation = {
    id: "request",
    role: "user",
    text: item.request,
    hash: hash(item.request),
  };
  let latest: Observation = item.latest
    ? { id: "latest", ...item.latest, hash: hash(item.latest.text) }
    : parentSource;
  const earlier: Observation[] = (item.earlier ?? []).map((o, i) => ({
    id: `earlier:${i}`,
    ...o,
    hash: hash(o.text),
  }));
  const observations = new Map(
    [parentSource, ...earlier, latest].map((o) => [o.id, o]),
  );
  const parent: HybridTask = {
    id: "task:1",
    label: item.label,
    kind: item.kind ?? "response",
    basis: "explicit",
    included: true,
    status: "not-started",
    revision: 1,
    source: {
      entryId: parentSource.id,
      messageHash: parentSource.hash,
      role: "user",
      start: 0,
      end: item.request.length,
      quoteHash: parentSource.hash,
    },
  };
  const store = new SubtaskStore();
  if (item.children) {
    const admission = store.admit({
      parent,
      expectedListRevision: 0,
      source: parent.source,
      proof: {
        contextHash: hash("qualification-existing-context"),
        gateRequestHash: hash("qualification-existing-gate"),
        proposalRequestHash: hash("qualification-existing-proposal"),
      },
      children: item.children.map((label) => ({
        kind: "add" as const,
        label,
        source: parent.source,
      })),
      removals: [],
      complete: true,
    });
    if (!admission.accepted)
      throw new Error("Invalid synthetic qualification group");
  }
  const initial: SubtaskRuntimeCheckpoint = {
    state: store.checkpoint(),
    journal: {
      version: 1,
      dispatches: 0,
      records: [],
      reports: [],
      usage: {
        jev: { calls: 0, inputTokens: 0, outputTokens: 0 },
        extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
      },
    },
  };
  const group = store.snapshot().groups[0];
  const current = () => ({
    sourceId: item.id,
    enabled: true,
    parents: [parent],
    latest,
    earlier: [...observations.values()].filter((o) => o.id !== latest.id),
    omissions: item.omissions ?? [],
    selectedModel,
    resolve: (id: string) => observations.get(id),
  });
  const observe = (text: string, index: number) => {
    latest = {
      id: `report:${index}`,
      role: "assistant",
      text,
      hash: hash(text),
    };
    observations.set(latest.id, latest);
    return {
      entryId: latest.id,
      messageHash: latest.hash,
      role: latest.role,
      start: 0,
      end: text.length,
      quoteHash: latest.hash,
    };
  };
  return { parent, current, observe, initial, group };
}
