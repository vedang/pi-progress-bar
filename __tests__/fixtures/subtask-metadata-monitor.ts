import { expect, vi } from "vitest";
import type { EvaluationRequest } from "../../src/analysis/gateway";
import type { SubtaskProposalRequest } from "../../src/analysis/subtask-proposal";
import {
  type encodeSubtaskCheckpoint,
  subtaskCheckpointStorageStatus,
} from "../../src/core/hybrid-checkpoint";
import { coverageNames } from "./coverage";
import { branchEntry, jevReply, monitorHarness } from "./hybrid-monitor";

const metadataGoal =
  "Review every tab in docs/plan.xlsx and summarize the workbook.";
export const metadataCommand = "unzip -p docs/plan.xlsx xl/workbook.xml";
export const metadataXml = `<workbook><sheets>${coverageNames.map((name) => `<sheet name="${name}"/>`).join("")}</sheets></workbook>`;
export type MetadataEnvelope = ReturnType<typeof encodeSubtaskCheckpoint>;

/** Grounded22-child proposal for the metadata request, as a provider would return it. */
export function metadataProposalText(input: SubtaskProposalRequest["input"]) {
  const contextIndex = input.context.findIndex(
    (item) => item.id === "goal" && item.text === metadataGoal,
  );
  const resourceIndex = input.evidence?.resources.findIndex(
    (resource) => resource.source.entryId === "result-manifest",
  );
  expect(contextIndex).toBeGreaterThanOrEqual(0);
  expect(resourceIndex).toBeGreaterThanOrEqual(0);
  expect(
    input.evidence?.resources[resourceIndex ?? -1].items.map(
      (item) => item.label,
    ),
  ).toEqual(coverageNames);
  return JSON.stringify({
    proposals: [
      {
        parentIndex: 0,
        complete: true,
        knownTotal: 22,
        removals: [],
        children: coverageNames.map((label, itemIndex) => ({
          kind: "add",
          label,
          evidence: [{ contextIndex, start: 0, end: metadataGoal.length }],
          association: { resourceIndex, itemIndex },
        })),
      },
    ],
  });
}

/** Live public Monitor ingress. No seeded generic store or direct child admission. */
export function subtaskMetadataMonitor(sourceId = () => "session:test") {
  const requests: EvaluationRequest[] = [];
  const admissions: boolean[] = [];
  const proposalNetwork = vi.fn();
  const proposeSubtasks = vi.fn(
    async (
      request: SubtaskProposalRequest,
      signal: AbortSignal,
      onDispatch?: (at: number) => boolean,
      onPhysicalFlight?: (drain: Promise<void>) => void,
    ) => {
      const admitted = onDispatch?.(Date.now()) === true;
      admissions.push(admitted);
      if (!admitted || signal.aborted)
        throw new Error("Proposal dispatch vetoed");
      onPhysicalFlight?.(Promise.resolve());
      proposalNetwork();
      return {
        provider: "fixture",
        model: "selected",
        requestHash: request.requestHash,
        usage: { inputTokens: 3, outputTokens: 2 },
        text: metadataProposalText(request.input),
      };
    },
  );
  const h = monitorHarness([branchEntry("goal", metadataGoal)], {
    extractionText: (input) =>
      JSON.stringify({
        add: input.tasks.length
          ? []
          : [
              {
                label: "Summarize workbook",
                kind: "response",
                basis: "explicit",
                quote: metadataGoal,
              },
            ],
        revise: [],
        archive: [],
        restore: [],
        unresolved: false,
      }),
    monitorOptions: {
      sourceId,
      selectedModel: () => "fixture/selected",
      proposeSubtasks,
    },
  });
  h.fetch.mockImplementation(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as EvaluationRequest;
    requests.push(request);
    const response = (await jevReply(request).json()) as {
      answers: Record<string, unknown>;
    };
    if (request.questions["subtask:0"]) {
      const state = request.state as {
        evidence?: {
          resources: Array<{
            source: { entryId: string };
            items: Array<{ label: string }>;
          }>;
        };
        group?: unknown;
      };
      const need =
        !state.group &&
        !!state.evidence?.resources.some(
          (resource) =>
            resource.source.entryId === "result-manifest" &&
            JSON.stringify(resource.items.map((item) => item.label)) ===
              JSON.stringify(coverageNames),
        );
      response.answers["subtask:0"] = {
        type: "choice",
        choice: need ? "yes" : "no",
        confidence: 1,
        probabilities: { yes: Number(need), no: Number(!need), uncertain: 0 },
      };
    }
    for (const [key, question] of Object.entries(request.questions)) {
      if (!key.startsWith("subtask:subtask-child:")) continue;
      response.answers[key] = {
        type: "choice",
        choice: "unchanged",
        confidence: 1,
        probabilities: Object.fromEntries(
          Object.keys(question.criteria).map((choice) => [
            choice,
            Number(choice === "unchanged"),
          ]),
        ),
      };
    }
    return Response.json(response);
  });
  function counts() {
    const gate = requests.filter(
      (request) => request.questions["subtask:0"],
    ).length;
    const report = requests.filter((request) =>
      Object.keys(request.questions).some((key) =>
        key.startsWith("subtask:subtask-child:"),
      ),
    ).length;
    return {
      gate,
      report,
      proposal: proposalNetwork.mock.calls.length,
      mandatory: requests.length - gate - report,
      extraction: h.extract.mock.calls.length,
    };
  }
  async function run(
    id: string,
    toolName: string,
    args: Record<string, unknown>,
    body: string,
    error = false,
  ) {
    h.monitor.observeCoverageToolStart(id, toolName, args);
    h.monitor.observeCoverageToolEnd(id, toolName);
    h.replace([
      ...h.reader(),
      {
        type: "message",
        id: `result-${id}`,
        message: {
          role: "toolResult",
          toolCallId: id,
          toolName,
          content: [{ type: "text", text: body }],
          isError: error,
        },
      },
    ]);
    h.monitor.confirmCoverageBranch(h.reader());
    await vi.advanceTimersByTimeAsync(100);
  }
  function checkpoint() {
    const saved = h.monitor.checkpoint();
    expect(subtaskCheckpointStorageStatus(saved)).toBe("supported");
    return saved as MetadataEnvelope;
  }
  async function map() {
    await run("manifest", "bash", { command: metadataCommand }, metadataXml);
    await run(
      "write",
      "write",
      { path: "export.sh", content: "script" },
      "written",
    );
    await run("read-script", "read", { path: "export.sh" }, "script");
    await run(
      "listing",
      "bash",
      { command: "bash export.sh docs/plan.xlsx" },
      coverageNames
        .map(
          (name, i) =>
            `${name} rows 2 nonempty rows 1 file extracted/tab-${i}.txt`,
        )
        .join("\n"),
    );
  }
  async function readAll() {
    await run(
      "read-all",
      "bash",
      {
        command: `cat ${coverageNames.map((_, i) => `extracted/tab-${i}.txt`).join(" ")}`,
      },
      "PRIVATE_CONFIRMED_READ_BODY",
    );
  }
  return {
    ...h,
    requests,
    admissions,
    proposeSubtasks,
    proposalNetwork,
    counts,
    run,
    map,
    readAll,
    checkpoint,
  };
}
