import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { projectCorrectionPolicy } from "../src/advisory/correction-adapter";
import { coverageHost } from "./fixtures/coverage-host";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

// N00 host characterization only: no continuation controller or paid provider.
// A later forced prompt must not be mistaken for complete earlier policy.
it.each([false, true])(
  "actual host binds status reply and exposes late effective-policy changes (%s)",
  async (lateOverride) => {
    const { host, ai } = await coverageHost();
    const cwd = await mkdtemp(join(tmpdir(), "continuation-host-"));
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
    const faux = ai.fauxProvider({ provider: "continuation-host" });
    runtime.registerNativeProvider(faux.provider);
    const providerForcedPolicy: boolean[] = [];
    const providerPolicies: { hash: string; proofBytes: number }[] = [];
    const respond = (context: unknown) => {
      const request = context as {
        systemPrompt?: unknown;
        messages?: unknown[];
      };
      const transcript = ai as unknown as {
        getCurrentSystemPrompt?: (messages: unknown[]) => string;
      };
      // Installed Pi passes normalized system-message transcripts; pinned Pi
      // passes Context.systemPrompt. Use each paired SDK's own projection.
      const text = transcript.getCurrentSystemPrompt
        ? transcript.getCurrentSystemPrompt(request.messages ?? [])
        : request.systemPrompt;
      if (typeof text !== "string")
        throw new Error("Provider system prompt unavailable");
      providerPolicies.push({
        hash: hash(text),
        proofBytes: Buffer.byteLength(
          JSON.stringify({
            coverage: "complete",
            promptHash: hash(text),
            text,
          }),
          "utf8",
        ),
      });
      providerForcedPolicy.push(text.includes(forced));
      return ai.fauxAssistantMessage(
        providerForcedPolicy.length === 1
          ? "Comparison is underway; recommendation remains pending."
          : "Comparison is finished. Recommendation is pending, unblocked and not assigned to a peer.",
      );
    };
    faux.setResponses([respond, respond]);
    const capture: { api?: ExtensionAPI } = {};
    const policies: {
      hash: string;
      policy: ReturnType<typeof projectCorrectionPolicy>;
    }[] = [];
    const settled: {
      hash: string;
      ids: string[];
      customIds: string[];
      idle: boolean;
      includesForcedPolicy: boolean;
    }[] = [];
    const errors: unknown[] = [];
    const contextPolicies: { hash: string; includesForcedPolicy: boolean }[] =
      [];
    let replyResolved = () => {};
    const replySettled = new Promise<void>((resolve) => {
      replyResolved = resolve;
    });
    const forced =
      "LATE_EFFECTIVE_POLICY: status questions must not start new work.";
    const loader = new host.DefaultResourceLoader({
      cwd,
      agentDir: join(cwd, "agent"),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      appendSystemPrompt: [
        "Continue authorized work unless the user pauses it.",
      ],
      extensionFactories: [
        (pi) => {
          capture.api = pi;
          pi.on("before_agent_start", (event) => {
            policies.push({
              hash: hash(event.systemPrompt),
              policy: projectCorrectionPolicy(event.systemPromptOptions),
            });
          });
          pi.on("context", (_event, ctx) => {
            contextPolicies.push({
              hash: hash(ctx.getSystemPrompt()),
              includesForcedPolicy: ctx.getSystemPrompt().includes(forced),
            });
          });
          pi.on("agent_settled", (_event, ctx) => {
            const branch = ctx.sessionManager.getBranch();
            settled.push({
              hash: hash(ctx.getSystemPrompt()),
              ids: branch.map((entry) => entry.id),
              customIds: branch
                .filter((entry) => entry.type === "custom_message")
                .map((entry) => entry.id),
              idle: ctx.isIdle(),
              includesForcedPolicy: ctx.getSystemPrompt().includes(forced),
            });
            if (settled.length === 2) replyResolved();
          });
        },
        (pi) => {
          if (lateOverride)
            pi.on("before_agent_start", () => ({ systemPrompt: forced }));
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
      tools: [],
      thinkingLevel: "off",
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await session.bindExtensions({
        mode: "rpc",
        onError: (error) => errors.push(error),
      });
      await session.prompt(
        "Compare routing options and recommend one. Keep working until complete.",
      );
      expect(settled).toHaveLength(1);
      if (!capture.api) throw new Error("Host extension API unavailable");
      const opportunityId = randomUUID();
      const sendId = randomUUID();
      capture.api.sendMessage(
        {
          customType: "pi-progress-advisory",
          content: "What is the actual status: complete, pending, or blocked?",
          display: true,
          details: { kind: "reconciliation", opportunityId, sendId },
        },
        { deliverAs: "steer", triggerTurn: true },
      );
      await Promise.race([
        replySettled,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Continuation host reply did not settle")),
            5000,
          );
        }),
      ]);
      expect(errors).toEqual([]);
      expect(faux.state.callCount).toBe(2);
      expect(settled).toHaveLength(2);
      expect(settled[1].idle).toBe(true);
      const branch = manager.getBranch();
      const question = branch.find(
        (entry) =>
          entry.type === "custom_message" &&
          entry.customType === "pi-progress-advisory",
      );
      expect(question).toMatchObject({
        details: { kind: "reconciliation", opportunityId, sendId },
      });
      if (!question) throw new Error("Canonical status question missing");
      expect(settled[0].customIds).not.toContain(question.id);
      expect(settled[1].customIds).toContain(question.id);
      const following = branch
        .slice(branch.indexOf(question) + 1)
        .filter(
          (entry) =>
            entry.type === "message" && entry.message.role === "assistant",
        );
      expect(following).toHaveLength(1);
      expect(following[0]).toMatchObject({ message: { stopReason: "stop" } });
      expect(settled[1].ids).toContain(following[0].id);
      // Both tested hosts skip before_agent_start for the idle custom turn.
      // Reusing prior policy requires current effective-prompt equality, not
      // assuming that every agent_start supplied a fresh structured projection.
      expect(policies).toHaveLength(1);
      expect(contextPolicies).toHaveLength(2);
      let proofValid = true;
      const proofOutcomes: string[] = [];
      for (const [index, observed] of contextPolicies.entries()) {
        expect(providerPolicies[index].hash).toBe(observed.hash);
        expect(providerForcedPolicy[index]).toBe(observed.includesForcedPolicy);
        proofValid =
          proofValid &&
          observed.hash === policies[0].hash &&
          providerPolicies[index].proofBytes <= 8192;
        proofOutcomes.push(proofValid ? "complete" : "unknown");
      }
      expect(proofOutcomes).toEqual(
        lateOverride ? ["unknown", "unknown"] : ["complete", "complete"],
      );
      if (process.env.PROGRESS_HOST_DIAGNOSTICS === "1")
        process.stdout.write(
          `${JSON.stringify({ lateOverride, originalHash: policies[0].hash, providers: providerPolicies, proofOutcomes })}\n`,
        );
      expect(policies[0].policy.coverage).toBe("complete");
      expect(JSON.stringify(policies[0].policy)).not.toContain(forced);
      if (lateOverride) {
        expect(providerForcedPolicy[0]).toBe(true);
        expect(contextPolicies[0].includesForcedPolicy).toBe(true);
        expect(contextPolicies[0].hash).not.toBe(policies[0].hash);
      } else {
        expect(
          contextPolicies.every((item) => item.hash === policies[0].hash),
        ).toBe(true);
      }
    } finally {
      clearTimeout(timeout);
      await session.abort();
      session.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  15000,
);
