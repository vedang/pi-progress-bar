import type { BoardSnapshot } from "../../src/core/board-projection";
import type { PresentationSnapshot } from "../../src/core/monitor";

export function uxView(): {
  presentation: PresentationSnapshot;
  board: BoardSnapshot;
} {
  return {
    presentation: {
      enabled: true,
      progress: { done: 7, total: 12, kind: "current" },
      activity: "Idle",
      service: { code: "ready", label: "Ready" },
      usage: {
        jev: { calls: 200, inputTokens: 10400, outputTokens: 765 },
        extraction: { calls: 20, inputTokens: 1425, outputTokens: 194 },
      },
      lastJevCallAt: Date.parse("2026-09-20T10:03:12Z"),
    },
    board: {
      service: { code: "ready", label: "Ready" },
      currentTask: { taskId: "task:1", status: "INPROG" },
      tasks: [
        {
          taskId: "task:1",
          label: "Handle escaped delimiters in parser",
          revision: 1,
          kind: "action",
          included: true,
          status: "INPROG",
          health: {
            requirements: "Unassessed",
            acceptance: "Unassessed",
            newRedTest: "Unassessed",
            redEvidence: "Unassessed",
            implementation: "Unassessed",
          },
          provenance: { state: "unassessed" },
          transitions: [{ kind: "create" }],
        },
      ],
    },
  };
}
