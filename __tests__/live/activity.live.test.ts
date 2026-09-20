import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  type ActivityMember,
  activityFocusRequest,
  captureDeclaredTools,
} from "../../src/analysis/activity-focus";
import { JevGateway } from "../../src/analysis/gateway";

if (process.env.PROGRESS_LIVE !== "1" || !process.env.TYPESAFE_API_KEY?.trim())
  throw new Error("Explicit live opt-in and Jev key required");
const dir = process.env.PROGRESS_LIVE_ARTIFACT_DIR;
const revision = process.env.PROGRESS_LIVE_REVISION;
if (!dir || !revision)
  throw new Error("Artifact directory and revision required");
const report = join(dir, `activity-live-${Date.now()}.jsonl`);
const tasks = [
  {
    id: "task:parser",
    label: "Implement escaped-delimiter handling in src/parser.ts",
    revision: 1,
  },
  {
    id: "task:database",
    label: "Fix transaction handling in src/database.ts",
    revision: 1,
  },
];
const cases: { name: string; tools: ActivityMember[]; allowed: string[] }[] = [
  {
    name: "parser-edit",
    tools: [{ toolName: "edit", path: "src/parser.ts" }],
    allowed: ["task:parser"],
  },
  {
    name: "database-edit",
    tools: [{ toolName: "edit", path: "src/database.ts" }],
    allowed: ["task:database"],
  },
  {
    name: "parallel-files",
    tools: [
      { toolName: "edit", path: "src/parser.ts" },
      { toolName: "edit", path: "src/database.ts" },
    ],
    allowed: ["concurrent"],
  },
  {
    name: "ambiguous-shell",
    tools: [{ toolName: "bash", shellCategory: "test" }],
    allowed: ["none", "uncertain"],
  },
  {
    name: "unknown-tool",
    tools: [{ toolName: "custom_runner" }],
    allowed: ["none", "uncertain"],
  },
];
it("bounded real Jev tool patterns distinguish paths and abstain on ambiguous categories", async () => {
  let calls = 0,
    acceptedCorrect = 0,
    abstentions = 0;
  const totals = { input_tokens: 0, output_tokens: 0 };
  const gateway = new JevGateway({
    getApiKey: () => process.env.TYPESAFE_API_KEY,
    fetch: async (url, init) => {
      if (++calls > 5) throw new Error("Activity live budget exceeded");
      return fetch(url, init);
    },
  });
  gateway.enable("activity-live");
  const failures: string[] = [];
  try {
    for (const item of cases) {
      const request = activityFocusRequest(item.tools, tasks);
      expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(
        24 * 1024,
      );
      const start = performance.now();
      const result = await gateway.evaluate(request, "activity-live", true);
      const answer = result?.answers.activityFocus;
      const probability =
        answer?.type === "choice"
          ? (answer.probabilities[answer.choice] ?? 0)
          : 0;
      const accepted =
        answer?.type === "choice" &&
        answer.confidence >= 0.5 &&
        probability >= 0.8;
      const choice = answer?.type === "choice" ? answer.choice : "unavailable";
      if (result) {
        totals.input_tokens += result.usage.input_tokens;
        totals.output_tokens += result.usage.output_tokens;
      }
      if (accepted && item.allowed.includes(choice)) acceptedCorrect++;
      else if (!accepted || ["none", "uncertain"].includes(choice))
        abstentions++;
      else failures.push(`${item.name}: wrong accepted ${choice}`);
      appendFileSync(
        report,
        `${JSON.stringify({ revision, case: item.name, request, choice, confidence: answer?.type === "choice" ? answer.confidence : 0, probability, accepted, usage: result?.usage, latencyMs: Math.round(performance.now() - start), service: gateway.status })}\n`,
      );
      if (!result) failures.push(`${item.name}: no validated response`);
    }
    const overflow = captureDeclaredTools(
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "PRIVATE_ID",
            name: "x".repeat(4097),
            arguments: { secret: "PRIVATE_SENTINEL" },
          },
        ],
      },
      "/repo",
    );
    expect(overflow?.kind).toBe("overflow");
    appendFileSync(
      report,
      `${JSON.stringify({ revision, totals, calls, acceptedCorrect, abstentions, failures, overflowCalls: 0 })}\n`,
    );
    expect(calls).toBe(5);
    expect(failures).toEqual([]);
    expect(acceptedCorrect).toBeGreaterThanOrEqual(2);
  } finally {
    gateway.pause();
  }
}, 120_000);
