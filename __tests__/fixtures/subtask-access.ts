import {
  applySubtaskGate,
  buildSubtaskGate,
} from "../../src/analysis/subtask-gate";
import {
  applySubtaskProposal,
  buildSubtaskProposal,
} from "../../src/analysis/subtask-proposal";
import { CoverageAdapter } from "../../src/sources/coverage";
import { subtaskProposalFixture } from "./subtask-proposal";

export type AssociationClaim =
  | { resourceIndex: number; itemIndex: number }
  | undefined;
export function subtaskAccessFixture(resourceNames = [["One"], ["One"]]) {
  const h = subtaskProposalFixture();
  const adapter = new CoverageAdapter();
  const entries: Array<{
    type: string;
    id: string;
    message: {
      role: string;
      toolCallId: string;
      toolName: string;
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
  }> = [];
  function run(
    id: string,
    toolName: string,
    args: Record<string, unknown>,
    text: string,
    extra = {},
  ) {
    adapter.start({ toolCallId: id, toolName, args }, 1);
    adapter.end({ toolCallId: id, toolName }, 1);
    entries.push({
      type: "message",
      id: `result-${id}`,
      message: {
        role: "toolResult",
        toolCallId: id,
        toolName,
        content: [{ type: "text", text }],
        isError: false,
        ...extra,
      },
    });
    return adapter.confirm(entries, 1);
  }
  resourceNames.forEach((names, resourceIndex) => {
    const path = `docs/resource-${resourceIndex}.xlsx`;
    run(
      `manifest-${resourceIndex}`,
      "bash",
      { command: `unzip -p ${path} xl/workbook.xml` },
      `<workbook><sheets>${names.map((name) => `<sheet name="${name}"/>`).join("")}</sheets></workbook>`,
    );
    const script = `export-${resourceIndex}.sh`;
    run(
      `write-${resourceIndex}`,
      "write",
      { path: script, content: "script" },
      "written",
    );
    run(`script-${resourceIndex}`, "read", { path: script }, "script");
    run(
      `list-${resourceIndex}`,
      "bash",
      { command: `bash ${script} ${path}` },
      names
        .map(
          (name, itemIndex) =>
            `${name} rows 2 nonempty rows 1 file extracted/r${resourceIndex}-${itemIndex}.txt`,
        )
        .join("\n"),
    );
  });
  const parents = [h.parent];
  h.store.reconcile(parents);
  function propose(
    claims: AssociationClaim[],
    parentId = "task:1",
    retain = false,
  ) {
    let parent = parents.find((item) => item.id === parentId);
    if (!parent) {
      parent = { ...h.parent, id: parentId };
      parents.push(parent);
      h.store.reconcile(parents);
    }
    const group = h.store
      .snapshot()
      .groups.find((item) => item.parentTaskId === parentId);
    const evidence = adapter.metadata();
    if (!evidence) throw new Error("Expected validated names");
    const options = { ...h.options, parent, group, evidence };
    const batch = buildSubtaskGate(options);
    if (!batch) throw new Error("Expected gate");
    const gate = applySubtaskGate(batch, h.result, options, {
      dispatch: 1,
      at: 123,
    });
    if (!gate) throw new Error("Expected gate decision");
    const request = buildSubtaskProposal(
      batch,
      { ...h.journal, records: [gate] },
      options,
    );
    if (!request) throw new Error("Expected proposal request");
    const contextIndex = request.input.context.findIndex(
      (item) => item.id === h.latest.id,
    );
    const children = claims.map((association, index) => ({
      ...(retain
        ? { kind: "retain", childIndex: index }
        : {
            kind: "add",
            label: `Grounded obligation ${index + 1}`,
            evidence: [{ contextIndex, start: 0, end: h.latest.text.length }],
          }),
      ...(association ? { association } : {}),
    }));
    const raw = JSON.stringify({
      proposals: [{ parentIndex: 0, children, removals: [], complete: false }],
    });
    return {
      applied: applySubtaskProposal(request, raw, options),
      request,
      options,
      raw,
      parent,
    };
  }
  return { ...h, adapter, entries, run, parents, propose };
}
