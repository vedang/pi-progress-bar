import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EvaluationRequest } from "../src/analysis/gateway";
import type { SubtaskProposalRequest } from "../src/analysis/subtask-proposal";
import {
  branchEntry,
  jevReply,
  monitorHarness,
} from "./fixtures/hybrid-monitor";

const running: ReturnType<typeof monitorHarness>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline");
});
afterEach(() => {
  for (const h of running.splice(0)) h.monitor.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([false, true])(
  "uses optional canonical metadata through the same generic gate and binds read-only access after publication (advance conversation: %s)",
  async (advanceConversation) => {
    const text =
      "Compare operating costs and risks, then recommend deployment.";
    const proposeSubtasks = vi.fn(
      async (
        request: SubtaskProposalRequest,
        signal: AbortSignal,
        onDispatch?: (at: number) => boolean,
        onPhysicalFlight?: (drain: Promise<void>) => void,
      ) => {
        if (onDispatch?.(Date.now()) === false || signal.aborted)
          throw new Error("vetoed");
        onPhysicalFlight?.(Promise.resolve());
        expect(request.input.evidence?.resources[0].items).toHaveLength(2);
        const contextIndex = request.input.context.findIndex(
          (item) => item.text === text,
        );
        return {
          provider: "fixture",
          model: "selected",
          requestHash: request.requestHash,
          usage: { inputTokens: 1, outputTokens: 1 },
          text: JSON.stringify({
            proposals: [
              {
                parentIndex: 0,
                complete: false,
                removals: [],
                children: [
                  "Compare operating costs",
                  "Assess deployment risks",
                ].map((label, itemIndex) => ({
                  kind: "add",
                  label,
                  evidence: [{ contextIndex, start: 0, end: text.length }],
                  association: { resourceIndex: 0, itemIndex },
                })),
              },
            ],
          }),
        };
      },
    );
    const h = monitorHarness([branchEntry("goal", text)], {
      extractionText: () =>
        JSON.stringify({
          add: [
            {
              label: "Recommend deployment",
              kind: "response",
              basis: "explicit",
              quote: text,
            },
          ],
          revise: [],
          archive: [],
          restore: [],
          unresolved: false,
        }),
      monitorOptions: {
        selectedModel: () => "fixture/selected",
        proposeSubtasks,
      },
    });
    running.push(h);
    h.fetch.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as EvaluationRequest;
      const response = (await jevReply(request).json()) as {
        answers: Record<string, unknown>;
      };
      if (request.questions["subtask:0"]) {
        const need = Boolean(
          request.state &&
            typeof request.state === "object" &&
            "evidence" in request.state &&
            request.state.evidence &&
            !("group" in request.state),
        );
        response.answers["subtask:0"] = {
          type: "choice",
          choice: need ? "yes" : "no",
          confidence: 1,
          probabilities: { yes: need ? 1 : 0, no: need ? 0 : 1, uncertain: 0 },
        };
      }
      // This conversation reports inventory readiness, not child completion.
      // Report questions are now live; do not inherit the generic mock's first
      // composite choice (completed-item) for this access-only control.
      for (const [key, question] of Object.entries(request.questions)) {
        if (!key.startsWith("subtask:subtask-child:")) continue;
        response.answers[key] = {
          type: "choice",
          choice: "unchanged",
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(question.criteria).map((choice) => [
              choice,
              choice === "unchanged" ? 1 : 0,
            ]),
          ),
        };
      }
      return Response.json(response);
    });
    async function tool(
      id: string,
      toolName: string,
      args: Record<string, unknown>,
      body: string,
    ) {
      h.monitor.observeCoverageToolStart(id, toolName, args);
      if (id === "read-one") {
        expect(
          h.monitor
            .subtaskAccessSnapshot()
            .groups[0]?.children.map((child) => child.activeCallHashes.length),
        ).toEqual([1, 0]);
      }
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
            isError: false,
          },
        },
      ]);
      h.monitor.confirmCoverageBranch(h.reader());
      await vi.advanceTimersByTimeAsync(100);
    }
    h.start();
    await h.settle("goal");
    expect(proposeSubtasks).not.toHaveBeenCalled();
    const parents = structuredClone(h.monitor.state.tasks);
    await tool(
      "manifest",
      "bash",
      { command: "unzip -p docs/resource.xlsx xl/workbook.xml" },
      '<workbook><sheets><sheet name="One"/><sheet name="Two"/></sheets></workbook>',
    );
    expect(proposeSubtasks).toHaveBeenCalledTimes(1);
    expect(h.monitor.subtaskSnapshot().groups[0]?.children).toHaveLength(2);
    await tool(
      "write-script",
      "write",
      { path: "export.sh", content: "script" },
      "written",
    );
    await tool("read-script", "read", { path: "export.sh" }, "script");
    await tool(
      "listing",
      "bash",
      { command: "bash export.sh docs/resource.xlsx" },
      "One rows 2 nonempty rows 1 file extracted/one.txt\nTwo rows 2 nonempty rows 1 file extracted/two.txt",
    );
    if (advanceConversation) {
      h.replace([
        ...h.reader(),
        branchEntry(
          "access-progress",
          "Inventory is ready; review remains pending.",
          "assistant",
        ),
      ]);
      h.observe();
      await h.settle("access-progress");
      expect(h.monitor.state.tasks).toEqual(parents);
      expect(
        h.monitor
          .subtaskAccessSnapshot()
          .groups[0]?.children.map((child) => child.status),
      ).toEqual(["no-observation", "no-observation"]);
    }
    const calls = h.fetch.mock.calls.length;
    await tool(
      "read-one",
      "read",
      { path: "extracted/one.txt" },
      "PRIVATE_ACCESS_BODY",
    );
    expect(
      h.monitor
        .subtaskAccessSnapshot()
        .groups[0]?.children.map((child) => child.status),
    ).toEqual(["observed", "no-observation"]);
    expect(
      h.monitor
        .subtaskSnapshot()
        .groups[0].children.every((child) => child.status === "pending"),
    ).toBe(true);
    expect(h.monitor.state.tasks).toEqual(parents);
    expect(h.fetch).toHaveBeenCalledTimes(calls);
    expect(proposeSubtasks).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.monitor.checkpoint())).not.toContain(
      "PRIVATE_ACCESS_BODY",
    );
    const reconciliation = h.monitor.advisorySettlementSnapshot();
    expect(reconciliation).toMatchObject({
      subtasks: [
        {
          parentTaskId: parents[0].id,
          parentRevision: parents[0].revision,
          reportedCompleted: 0,
          reportedBlocked: 0,
          pending: 2,
          observedAccess: 1,
          gaps: ["Compare operating costs", "Assess deployment risks"],
          omittedChildren: 0,
        },
      ],
    });
    expect(reconciliation).not.toHaveProperty("coverage");
    expect(h.fetch).toHaveBeenCalledTimes(calls);
    h.monitor.turnOff();
    expect(
      h.monitor
        .subtaskAccessSnapshot()
        .groups.every((group) =>
          group.children.every((child) => child.status === "unavailable"),
        ),
    ).toBe(true);
  },
);

it.each(["clarification", "idle amendment", "held amendment"])(
  "runs fresh generic decomposition after %s without tools",
  async (mode) => {
    let text = "Compare operating costs and risks, then recommend deployment.";
    let need = false;
    let gateDispatches = 0;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const proposeSubtasks = vi.fn(
      async (
        request: SubtaskProposalRequest,
        signal: AbortSignal,
        onDispatch?: (at: number) => boolean,
        onPhysicalFlight?: (drain: Promise<void>) => void,
      ) => {
        expect(onPhysicalFlight).toBeTypeOf("function");
        onPhysicalFlight?.(Promise.resolve());
        if (onDispatch?.(Date.now()) === false || signal.aborted)
          throw new Error("vetoed");
        const contextIndex = request.input.context.findIndex(
          (item) => item.text === text,
        );
        return {
          provider: "fixture",
          model: "selected",
          requestHash: request.requestHash,
          usage: { inputTokens: 1, outputTokens: 1 },
          text: JSON.stringify({
            proposals: [
              {
                parentIndex: 0,
                complete: false,
                removals: [],
                children: [
                  "Compare operating costs",
                  "Assess deployment risks",
                ].map((label) => ({
                  kind: "add",
                  label,
                  evidence: [{ contextIndex, start: 0, end: text.length }],
                })),
              },
            ],
          }),
        };
      },
    );
    const h = monitorHarness([branchEntry("goal", text)], {
      extractionText: () =>
        JSON.stringify({
          add: [
            {
              label: "Recommend deployment",
              kind: "response",
              basis: "explicit",
              quote: text,
            },
          ],
          revise: [],
          archive: [],
          restore: [],
          unresolved: false,
        }),
      monitorOptions: {
        selectedModel: () => "fixture/selected",
        proposeSubtasks,
      },
    });
    running.push(h);
    h.fetch.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as EvaluationRequest;
      const response = (await jevReply(request).json()) as {
        answers: Record<string, unknown>;
      };
      if (request.questions["subtask:0"]) {
        gateDispatches++;
        const hold = mode === "held amendment" && gateDispatches === 1;
        const yes = need || hold;
        response.answers["subtask:0"] = {
          type: "choice",
          choice: yes ? "yes" : "no",
          confidence: 1,
          probabilities: { yes: Number(yes), no: Number(!yes), uncertain: 0 },
        };
        if (hold) await held; // Deliberately ignores transport abort.
      }
      return Response.json(response);
    });
    h.start();
    await h.settle("goal");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.monitor.state.tasks).toHaveLength(1);
    expect(proposeSubtasks).not.toHaveBeenCalled();
    const tasks = structuredClone(h.monitor.state.tasks);
    const extractionCalls = h.extract.mock.calls.length;
    need = true;
    try {
      if (mode === "clarification") {
        h.append(
          "clarification",
          "Explain the tradeoffs in separate steps.",
          "user",
        );
        await h.settle("clarification");
      } else {
        expect(gateDispatches).toBe(1);
        text += " Include ongoing support costs.";
        h.replace([branchEntry("goal", text)]);
        await h.settle("goal");
        if (mode === "held amendment") {
          expect(gateDispatches).toBe(1);
          expect(proposeSubtasks).not.toHaveBeenCalled();
          expect(h.monitor.subtaskSnapshot().groups).toEqual([]);
          release();
          await vi.advanceTimersByTimeAsync(100);
          h.observe(); // Named fresh wake after old physical settlement.
        }
      }
      await vi.advanceTimersByTimeAsync(200);
      expect(h.extract).toHaveBeenCalledTimes(
        extractionCalls + Number(mode !== "clarification"),
      );
      expect(proposeSubtasks).toHaveBeenCalledTimes(1);
      expect(h.monitor.subtaskSnapshot().groups[0]?.children).toHaveLength(2);
      if (mode === "clarification")
        expect(h.monitor.state.tasks).toEqual(tasks);
      else
        expect(h.monitor.state.tasks[0].source.messageHash).not.toBe(
          tasks[0].source.messageHash,
        );
    } finally {
      release();
    }
    const saved = h.monitor.checkpoint();
    expect(saved).toMatchObject({ version: 11 });
    h.observe();
    h.observe();
    await vi.advanceTimersByTimeAsync(200);
    expect(proposeSubtasks).toHaveBeenCalledTimes(1);
  },
);
