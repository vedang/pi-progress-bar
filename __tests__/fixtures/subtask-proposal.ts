import { MODEL, type ValidatedResult } from "../../src/analysis/gateway";
import {
  applySubtaskGate,
  buildSubtaskGate,
  type SubtaskGateOptions,
} from "../../src/analysis/subtask-gate";
import type { Observation } from "../../src/core/hybrid-state";
import type { SubtaskJournalCheckpoint } from "../../src/core/subtask-journal";
import { SubtaskStore } from "../../src/core/subtasks";
import { subtaskAdmission, subtaskHash, subtaskParent } from "./subtasks";

export function subtaskProposalFixture(existing = false, reported = false) {
  const parent = subtaskParent();
  const parentSource: Observation = {
    id: "request",
    role: "user",
    text: "Compare the deployment options and recommend an approach.",
    hash: parent.source.messageHash,
  };
  const latest: Observation = {
    id: "latest",
    role: "user",
    text: "Compare operating costs and delivery risks, then recommend a deployment approach.",
    hash: subtaskHash(
      "Compare operating costs and delivery risks, then recommend a deployment approach.",
    ),
  };
  const observations = [parentSource, latest];
  const store = new SubtaskStore();
  if (existing && !store.admit(subtaskAdmission()).accepted)
    throw new Error("Fixture admission failed");
  if (reported) {
    const group = store.snapshot().groups[0];
    if (
      !group ||
      !store.report({
        groupId: group.id,
        listRevision: group.listRevision,
        childIds: [group.children[0].id],
        source: parent.source,
        status: "reported-completed",
      }).accepted
    )
      throw new Error("Fixture report failed");
  }
  const options: SubtaskGateOptions = {
    parent,
    group: store.snapshot().groups[0],
    latest,
    earlier: [],
    omissions: [],
    selectedModel: "fixture/selected",
    resolve: (id) => observations.find((item) => item.id === id),
  };
  const batch = buildSubtaskGate(options);
  if (!batch) throw new Error("Fixture gate unavailable");
  const result: ValidatedResult = {
    model: MODEL,
    answers: Object.fromEntries(
      Object.keys(batch.request.questions).map((key) => [
        key,
        {
          type: "choice",
          choice: "yes",
          confidence: 1,
          probabilities: { yes: 1, no: 0, uncertain: 0 },
        },
      ]),
    ),
    usage: { input_tokens: 3, output_tokens: 5 },
  };
  const record = applySubtaskGate(batch, result, options, {
    dispatch: 1,
    at: 123,
  });
  if (!record) throw new Error("Fixture gate receipt unavailable");
  const journal: SubtaskJournalCheckpoint = {
    version: 1,
    dispatches: 1,
    usage: {
      jev: { calls: 1, inputTokens: 3, outputTokens: 5 },
      extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
    },
    records: [record],
  };
  return {
    parent,
    parentSource,
    latest,
    observations,
    store,
    options,
    batch,
    result,
    journal,
  };
}
