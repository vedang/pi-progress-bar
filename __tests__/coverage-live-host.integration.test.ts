import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import type { ExtractionInput } from "../src/analysis/extractor";
import type { EvaluationRequest } from "../src/analysis/gateway";
import type { SubtaskProposalRequest } from "../src/analysis/subtask-proposal";
import type { encodeSubtaskCheckpoint } from "../src/core/hybrid-checkpoint";
import { Monitor } from "../src/core/monitor";
import extension from "../src/index";
import { CoverageAdapter } from "../src/sources/coverage";
import { coverageNames } from "./fixtures/coverage";
import { coverageHost } from "./fixtures/coverage-host";
import { jevReply } from "./fixtures/hybrid-monitor";

it("production extension on real Pi yields22children and changing item/batch access", async () => {
  const { host, ai } = await coverageHost();
  const {
    fauxAssistantMessage,
    fauxProvider,
    fauxToolCall,
    InMemoryCredentialStore,
    Type,
  } = ai;
  const cwd = await mkdtemp(join(tmpdir(), "coverage-live-host-"));
  const manager = host.SessionManager.inMemory(cwd);
  const settingsManager = host.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const runtime = await host.ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const faux = fauxProvider({ provider: "coverage-vertical-host" });
  runtime.registerNativeProvider(faux.provider);
  const text = "Review every tab in docs/plan.xlsx and summarize the workbook.";
  const checkpoints = () =>
    manager
      .getBranch()
      .flatMap((entry) =>
        entry.type === "custom" && entry.customType === "pi-progress-bar"
          ? [entry.data as ReturnType<typeof encodeSubtaskCheckpoint>]
          : [],
      );
  let firstGate = true;
  let subtaskGates = 0;
  let proposedLists = 0;
  vi.stubEnv("TYPESAFE_API_KEY", "offline-only");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as EvaluationRequest;
      const response = (await jevReply(request).json()) as {
        answers: Record<string, unknown>;
      };
      if (request.questions.gate) {
        const choice = firstGate ? "changed" : "unchanged";
        firstGate = false;
        response.answers.gate = {
          type: "choice",
          choice,
          confidence: 1,
          probabilities: {
            changed: choice === "changed" ? 1 : 0,
            unchanged: choice === "unchanged" ? 1 : 0,
            uncertain: 0,
          },
        };
      }
      if (request.questions["subtask:0"]) {
        subtaskGates++;
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
      return Response.json(response);
    }),
  );
  const adapterStarts: unknown[] = [];
  const adapterStart = CoverageAdapter.prototype.start;
  vi.spyOn(CoverageAdapter.prototype, "start").mockImplementation(function (
    this: CoverageAdapter,
    ...args
  ) {
    const before = this.accessEvidence();
    adapterStart.apply(this, args);
    const after = this.accessEvidence();
    adapterStarts.push({
      tool: args[0].toolName,
      mappedBefore: before.mapped.reduce(
        (n, resource) => n + resource.itemKeys.length,
        0,
      ),
      activeAfter: after.active.map((call) => call.itemKeys.length),
      confirmedBefore: before.confirmed.length,
      omissions: after.omissions,
    });
  });
  const activities: number[] = [];
  const original = Monitor.prototype.observeCoverageToolStart;
  const coverageStarts = vi
    .spyOn(Monitor.prototype, "observeCoverageToolStart")
    .mockImplementation(function (this: Monitor, ...args) {
      original.apply(this, args);
      for (const group of this.subtaskAccessSnapshot().groups)
        activities.push(
          group.children.filter((child) => child.activeCallHashes.length > 0)
            .length,
        );
    });
  const steps = [
    fauxToolCall("bash", {
      command: "unzip -p docs/plan.xlsx xl/workbook.xml",
    }),
    fauxToolCall("write", { path: "export.sh", content: "script" }),
    fauxToolCall("read", { path: "export.sh" }),
    fauxToolCall("bash", { command: "bash export.sh docs/plan.xlsx" }),
    fauxToolCall("bash", { command: "cat extracted/tab-0.txt" }),
    fauxToolCall("bash", {
      command: "cat extracted/tab-1.txt extracted/tab-2.txt",
    }),
  ];
  let step = 0;
  const respond = async (context: Context) => {
    const last = context.messages.at(-1);
    const content =
      last?.role === "user" &&
      Array.isArray(last.content) &&
      last.content[0]?.type === "text"
        ? last.content[0].text
        : undefined;
    // Route by the actual extraction payload, independent of system-message representation.
    const input = content?.startsWith("{")
      ? (JSON.parse(content) as
          | ExtractionInput
          | SubtaskProposalRequest["input"])
      : undefined;
    if (input && "parents" in input) {
      proposedLists++;
      const contextIndex = input.context.findIndex(
        (item) => item.text === text,
      );
      expect(contextIndex).toBeGreaterThanOrEqual(0);
      expect(
        input.evidence?.resources[0].items.map((item) => item.label),
      ).toEqual(coverageNames);
      expect(
        checkpoints()
          .at(-1)
          ?.monitor?.subtasks?.journal.records.some(
            (record) =>
              record.gate?.choice === "yes" &&
              record.proposal?.outcome === "dispatched",
          ),
      ).toBe(true);
      return fauxAssistantMessage(
        JSON.stringify({
          proposals: [
            {
              parentIndex: 0,
              complete: true,
              removals: [],
              children: coverageNames.map((label, itemIndex) => ({
                kind: "add",
                label,
                evidence: [{ contextIndex, start: 0, end: text.length }],
                association: { resourceIndex: 0, itemIndex },
              })),
            },
          ],
        }),
      );
    }
    if (
      input &&
      "tasks" in input &&
      typeof input.instructions === "string" &&
      Array.isArray(input.tasks)
    ) {
      return fauxAssistantMessage(
        JSON.stringify({
          add: input.tasks.length
            ? []
            : [
                {
                  label: "Summarize workbook",
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
      );
    }
    // Generic decomposition is asynchronous, unlike the retired inventory
    // bypass. Settle the discovery turn before asking the host to read items.
    if (step === 4) {
      step++;
      return fauxAssistantMessage(
        "Inventory and exports are ready; review remains pending.",
      );
    }
    const call = steps[step > 4 ? step++ - 1 : step++];
    return call
      ? fauxAssistantMessage([call], { stopReason: "toolUse" })
      : fauxAssistantMessage(
          "Reads observed; review and synthesis remain pending.",
        );
  };
  faux.setResponses(Array.from({ length: 30 }, () => respond));
  const errors: unknown[] = [];
  const loader = new host.DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      extension,
      (pi) => {
        for (const name of ["bash", "write", "read"] as const)
          pi.registerTool({
            name,
            label: name,
            description:
              "Offline synthetic coverage replay, no commands or workbook reads",
            parameters: Type.Object({
              command: Type.Optional(Type.String()),
              path: Type.Optional(Type.String()),
              content: Type.Optional(Type.String()),
            }),
            async execute(_id, args) {
              const output =
                name === "write"
                  ? "written"
                  : name === "read"
                    ? "script"
                    : args.command?.startsWith("unzip")
                      ? `<workbook><sheets>${coverageNames.map((name) => `<sheet name="${name}"/>`).join("")}</sheets></workbook>`
                      : args.command?.startsWith("bash")
                        ? coverageNames
                            .map(
                              (name, i) =>
                                `${name} rows 2 nonempty rows 1 file extracted/tab-${i}.txt`,
                            )
                            .join("\n")
                        : "PRIVATE_SYNTHETIC_CELL";
              return { content: [{ type: "text", text: output }], details: {} };
            },
          });
      },
    ],
  });
  await loader.reload();
  const { session } = await host.createAgentSession({
    cwd,
    agentDir: join(cwd, "agent"),
    resourceLoader: loader,
    sessionManager: manager,
    settingsManager,
    modelRuntime: runtime,
    model: faux.getModel(),
    tools: ["bash", "write", "read"],
    thinkingLevel: "off",
  });
  try {
    await session.bindExtensions({
      mode: "print",
      onError: (error) => errors.push(error),
    });
    await session.prompt(text);
    expect(coverageStarts).toHaveBeenCalledTimes(4);
    await vi.waitFor(
      () =>
        expect(
          checkpoints().at(-1)?.monitor?.subtasks?.state.groups[0]?.children,
          JSON.stringify({
            subtaskGates,
            proposedLists,
            adapterStarts,
            versions: [...new Set(checkpoints().map((saved) => saved.version))],
            parents: checkpoints().at(-1)?.state.tasks.length,
            journal: checkpoints()
              .at(-1)
              ?.monitor?.subtasks?.journal.records.map((record) => ({
                phase: record.phase,
                state: record.state,
                gate: record.gate?.outcome,
                proposal: record.proposal?.outcome,
              })),
          }),
        ).toHaveLength(22),
      { timeout: 4000, interval: 10 },
    );
    await session.prompt("Continue the requested review.");
    expect(errors).toEqual([]);
    const saved = checkpoints().at(-1);
    expect(saved?.state.tasks).toHaveLength(1);
    expect(
      saved?.monitor?.subtasks?.state.groups[0].children.every(
        (child) => child.status === "pending",
      ),
    ).toBe(true);
    expect(activities, JSON.stringify(adapterStarts)).toContain(1);
    expect(activities).toContain(2);
    expect(JSON.stringify(saved)).not.toContain("PRIVATE_SYNTHETIC_CELL");
  } finally {
    await session.abort();
    session.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(cwd, { recursive: true, force: true });
  }
}, 15000);
