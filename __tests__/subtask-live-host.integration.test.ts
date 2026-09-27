import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import type { EvaluationRequest } from "../src/analysis/gateway";
import type { encodeSubtaskCheckpoint } from "../src/core/hybrid-checkpoint";
import extension from "../src/index";
import { coverageHost } from "./fixtures/coverage-host";
import { jevReply } from "./fixtures/hybrid-monitor";

it.each(["yes", "no", "uncertain"] as const)(
  "actual host conversation-only subtask gate %s uses strict v11 and yes-only proposal",
  async (choice) => {
    const { host, ai } = await coverageHost();
    const cwd = await mkdtemp(join(tmpdir(), "subtask-live-host-"));
    const manager = host.SessionManager.inMemory(cwd);
    const settingsManager = host.SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const runtime = await host.ModelRuntime.create({
      credentials: new ai.InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const faux = ai.fauxProvider({ provider: "subtask-live-host" });
    runtime.registerNativeProvider(faux.provider);
    const text =
      "Compare operating costs and delivery risks, then recommend a deployment approach.";
    const checkpoints = () =>
      manager
        .getBranch()
        .flatMap((entry) =>
          entry.type === "custom" && entry.customType === "pi-progress-bar"
            ? [entry.data as ReturnType<typeof encodeSubtaskCheckpoint>]
            : [],
        );
    const proposals: unknown[] = [];
    const gates: EvaluationRequest[] = [];
    let firstGate = true;
    vi.stubEnv("TYPESAFE_API_KEY", "offline-only");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as EvaluationRequest;
        const response = (await jevReply(request).json()) as {
          answers: Record<string, unknown>;
        };
        if (request.questions.gate) {
          const changed = firstGate;
          firstGate = false;
          response.answers.gate = {
            type: "choice",
            choice: changed ? "changed" : "unchanged",
            confidence: 1,
            probabilities: {
              changed: changed ? 1 : 0,
              unchanged: changed ? 0 : 1,
              uncertain: 0,
            },
          };
        }
        if (request.questions["subtask:0"]) {
          gates.push(request);
          expect(
            checkpoints()
              .at(-1)
              ?.monitor?.subtasks?.journal.records.some(
                (r) => r.gate?.outcome === "dispatched",
              ),
          ).toBe(true);
          response.answers["subtask:0"] = {
            type: "choice",
            choice,
            confidence: 1,
            probabilities: {
              yes: choice === "yes" ? 1 : 0,
              no: choice === "no" ? 1 : 0,
              uncertain: choice === "uncertain" ? 1 : 0,
            },
          };
        }
        return Response.json(response);
      }),
    );
    const respond = async (context: Context) => {
      const last = context.messages.at(-1);
      const content =
        last?.role === "user" &&
        Array.isArray(last.content) &&
        last.content[0]?.type === "text"
          ? last.content[0].text
          : undefined;
      const input = content?.startsWith("{") ? JSON.parse(content) : undefined;
      if (
        input &&
        Array.isArray(input.parents) &&
        Array.isArray(input.context)
      ) {
        proposals.push(input);
        expect(
          checkpoints()
            .at(-1)
            ?.monitor?.subtasks?.journal.records.some(
              (r) =>
                r.gate?.choice === "yes" &&
                r.proposal?.outcome === "dispatched",
            ),
        ).toBe(true);
        const contextIndex = input.context.findIndex(
          (item: { text: string }) => item.text === text,
        );
        expect(contextIndex).toBeGreaterThanOrEqual(0);
        return ai.fauxAssistantMessage(
          JSON.stringify({
            proposals: [
              {
                parentIndex: 0,
                complete: false,
                removals: [],
                children: [
                  "Compare operating costs",
                  "Assess delivery risks",
                  "Recommend deployment approach",
                ].map((label) => ({
                  kind: "add",
                  label,
                  evidence: [{ contextIndex, start: 0, end: text.length }],
                })),
              },
            ],
          }),
        );
      }
      if (
        input &&
        Array.isArray(input.tasks) &&
        typeof input.instructions === "string"
      ) {
        return ai.fauxAssistantMessage(
          JSON.stringify({
            add: input.tasks.length
              ? []
              : [
                  {
                    label: "Recommend deployment approach",
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
      return ai.fauxAssistantMessage("I will compare the options.");
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
      extensionFactories: [extension],
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
      tools: [],
      thinkingLevel: "off",
    });
    try {
      await session.bindExtensions({
        mode: "print",
        onError: (error) => errors.push(error),
      });
      await session.prompt(text);
      await vi.waitFor(
        () => {
          const saved = checkpoints().at(-1);
          expect(saved?.version).toBe(11);
          expect(saved?.state.tasks).toHaveLength(1);
          expect(
            saved?.monitor?.subtasks?.journal.records.some(
              (r) => r.state === "complete",
            ),
          ).toBe(true);
          if (choice === "yes")
            expect(
              saved?.monitor?.subtasks?.state.groups[0]?.children,
            ).toHaveLength(3);
        },
        { timeout: 4000, interval: 10 },
      );
      expect(gates.length).toBeGreaterThan(0);
      expect(errors).toEqual([]);
      if (choice === "yes") expect(proposals.length).toBeGreaterThan(0);
      else {
        expect(proposals).toEqual([]);
        expect(checkpoints().at(-1)?.monitor?.subtasks?.state.groups).toEqual(
          [],
        );
      }
      expect(
        checkpoints().every(
          (saved) =>
            saved.version === 11 &&
            !Object.hasOwn(saved.monitor ?? {}, "coverage"),
        ),
      ).toBe(true);
    } finally {
      await session.abort();
      session.dispose();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  15000,
);
