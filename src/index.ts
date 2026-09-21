import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  CorrectionAdapter,
  projectCorrectionAction,
  projectCorrectionPolicy,
} from "./advisory/correction-adapter";
import type {
  CorrectionBinding,
  CorrectionPolicyProjection,
} from "./advisory/corrections";
import {
  type AdvisoryDeliveryKind,
  ReconciliationDelivery,
  type SettlementOrigin,
} from "./advisory/delivery";
import { ReconciliationController } from "./advisory/reconciliation";
import { Monitor } from "./core/monitor";
import { selectedModelExtractor } from "./core/selected-model";
import { command } from "./ui/commands";
import { createUiController, type UiController } from "./ui/controller";
import { createUiHost } from "./ui/host";

export default function progressBar(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let notifiedError: string | undefined;
  let controller: UiController | undefined;
  let reconciliation: ReconciliationController | undefined;
  let delivery: ReconciliationDelivery | undefined;
  let sessionEpoch = 0;
  let branchEpoch = 0;
  let runEpoch = 0;
  /** Only a still-running source turn may receive its classifier result. */
  let activeCorrectionRun: number | undefined;
  let pendingCorrectionPolicy: CorrectionPolicyProjection | undefined;
  let activeCorrectionSource:
    | { sourceRun: number; policy: CorrectionPolicyProjection }
    | undefined;
  let currentOpportunity:
    | {
        id: string;
        kind: AdvisoryDeliveryKind;
        runId?: number;
        binding?: CorrectionBinding;
      }
    | undefined;
  const correctionAdapter = new CorrectionAdapter({
    tools: () => pi.getAllTools(),
  });
  const clearOpportunity = () => {
    currentOpportunity = undefined;
  };
  const clearCorrectionOpportunity = () => {
    if (currentOpportunity?.kind !== "reconciliation") clearOpportunity();
  };
  const disposeController = () => {
    controller?.dispose();
    controller = undefined;
  };
  const render = () => {
    const ctx = context;
    if (!ctx) return;
    const presentation = monitor.presentationSnapshot();
    if (!presentation.enabled) {
      // Monitor control publishes through this seam, including /progress off.
      // Cancelling here adds no advisory-specific command or preference.
      reconciliation?.cancel();
      delivery?.onMasterOff();
      correctionAdapter.reset();
      activeCorrectionRun = undefined;
      activeCorrectionSource = undefined;
      pendingCorrectionPolicy = undefined;
      clearOpportunity();
    }
    if (ctx.mode === "tui" && presentation.enabled) {
      const snapshot = { presentation, board: monitor.boardSnapshot() };
      if (!controller) {
        // Host contexts may be freshly wrapped for every event. Only explicit
        // session/branch/OFF lifecycle boundaries replace the UI generation.
        controller = createUiController(createUiHost(ctx), snapshot);
      } else controller.update(snapshot);
      notifiedError = undefined;
    } else {
      disposeController();
      if (monitor.error && monitor.error !== notifiedError && ctx.hasUI) {
        ctx.ui.notify(monitor.error, "error");
        notifiedError = monitor.error;
      }
    }
    // Semantic publish is controller's event-driven readiness refresh. The
    // controller owns deadline; this does not create a polling cadence.
    reconciliation?.refresh();
  };
  const monitor = new Monitor(
    render,
    (data) => pi.appendEntry("pi-progress-bar", data),
    {
      sourceId: () =>
        context?.sessionManager.getSessionId() ?? "unbound-session",
      extract: selectedModelExtractor(() => {
        if (!context) throw new Error("No active Pi context");
        return context;
      }),
      richDetailsEnabled: true,
      onCorrection: ({ kind, content, binding }) => {
        const target = delivery;
        // A classifier result is useful only in its originating active turn.
        // One chain owns all advisory retries; never replace a live opportunity.
        if (
          !target ||
          currentOpportunity ||
          !binding ||
          activeCorrectionRun !== binding.sourceRun ||
          !monitor.correctionIsCurrent(binding)
        )
          return;
        const opportunityId = randomUUID();
        currentOpportunity = { id: opportunityId, kind, binding };
        const result = target.request({
          kind,
          opportunityId,
          content,
          sessionEpoch,
          branchEpoch,
        });
        if (result !== "started") clearOpportunity();
      },
    },
  );
  delivery = new ReconciliationDelivery({
    state: () => {
      const snapshot = monitor.advisorySettlementSnapshot();
      const correctionBinding = currentOpportunity?.binding;
      const correctionRelevant =
        correctionBinding !== undefined &&
        activeCorrectionRun === correctionBinding.sourceRun &&
        monitor.correctionIsCurrent(correctionBinding);
      return {
        enabled: snapshot.enabled,
        mode: context?.mode ?? "print",
        sessionEpoch,
        branchEpoch,
        opportunityId: currentOpportunity?.id,
        relevant:
          snapshot.reason === "ready" &&
          (currentOpportunity?.kind === "reconciliation"
            ? snapshot.tasks.some((task) => task.status !== "done")
            : correctionRelevant),
        idle: context?.isIdle() ?? false,
        pendingMessages: context?.hasPendingMessages() ?? true,
      };
    },
    branch: () => context?.sessionManager.getBranch() ?? [],
    sendMessage: (message, options) => pi.sendMessage(message, options),
  });
  reconciliation = new ReconciliationController({
    snapshot: () => monitor.advisorySettlementSnapshot(),
    emit: ({ runId, content }) => {
      const opportunityId = randomUUID();
      currentOpportunity = {
        id: opportunityId,
        kind: "reconciliation",
        runId,
      };
      const result = delivery?.request({
        kind: "reconciliation",
        opportunityId,
        content,
        sessionEpoch,
        branchEpoch,
      });
      if (result === "suppressed") clearOpportunity();
    },
    clock: {
      now: () => Date.now(),
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (timer) => clearTimeout(timer),
    },
  });
  const checkpoint = (ctx: ExtensionContext) =>
    ctx.sessionManager
      .getBranch()
      .filter(
        (entry) =>
          entry.type === "custom" && entry.customType === "pi-progress-bar",
      )
      .at(-1);
  const restore = async (ctx: ExtensionContext, preserveControls: boolean) => {
    // Session replacement/tree restore invalidates the owned UI generation first.
    disposeController();
    context = ctx;
    const saved = checkpoint(ctx);
    await monitor.restore(
      ctx.cwd,
      // Entry presence matters: missing payload is corrupt, not a fresh session.
      saved?.type === "custom" ? (saved.data ?? null) : undefined,
      preserveControls,
      () => ctx.sessionManager.getBranch(),
    );
    render();
  };
  const observe = (ctx: ExtensionContext) => {
    context = ctx;
    monitor.observe(() => ctx.sessionManager.getBranch());
    reconciliation?.refresh();
  };
  const settle = (origin: SettlementOrigin | undefined) => {
    if (origin === undefined) return;
    if (origin !== "uncertain-advisory") clearOpportunity();
    reconciliation?.settled(runEpoch, origin);
  };

  pi.registerCommand("progress", {
    description: "Show or turn automatic progress monitoring on/off",
    handler: (args, ctx) => command(args, ctx, monitor),
  });
  pi.on("session_start", async (_event, ctx) => {
    // Session replacement normally sends shutdown first. Repeat disposal here
    // for a direct host start boundary; no old timer may survive either path.
    delivery?.onSessionShutdown();
    correctionAdapter.reset();
    reconciliation?.cancel();
    sessionEpoch++;
    branchEpoch++;
    runEpoch = 0;
    activeCorrectionRun = undefined;
    activeCorrectionSource = undefined;
    pendingCorrectionPolicy = undefined;
    clearOpportunity();
    await restore(ctx, false);
  });
  pi.on("session_before_tree", () => {
    delivery?.onNavigation();
    correctionAdapter.reset();
    monitor.invalidateCorrections();
    reconciliation?.cancel();
    activeCorrectionRun = undefined;
    activeCorrectionSource = undefined;
    pendingCorrectionPolicy = undefined;
    clearOpportunity();
  });
  pi.on("session_tree", async (_event, ctx) => {
    // Real hosts fire session_before_tree first; repeat cancellation so this
    // post-navigation boundary is also safe when delivered alone.
    delivery?.onNavigation();
    correctionAdapter.reset();
    monitor.invalidateCorrections();
    reconciliation?.cancel();
    branchEpoch++;
    activeCorrectionRun = undefined;
    activeCorrectionSource = undefined;
    pendingCorrectionPolicy = undefined;
    clearOpportunity();
    await restore(ctx, true);
  });
  pi.on("session_shutdown", () => {
    disposeController();
    delivery?.onSessionShutdown();
    correctionAdapter.reset();
    reconciliation?.cancel();
    activeCorrectionRun = undefined;
    activeCorrectionSource = undefined;
    pendingCorrectionPolicy = undefined;
    clearOpportunity();
    monitor.stop();
    context = undefined;
  });
  pi.on("input", () => {
    delivery?.onInput();
    correctionAdapter.reset();
    monitor.invalidateCorrections();
    reconciliation?.clearPendingIntent();
    activeCorrectionRun = undefined;
    activeCorrectionSource = undefined;
    pendingCorrectionPolicy = undefined;
    clearOpportunity();
  });
  // Canonical active branch is authoritative for semantic tracking. Tool activity
  // captures only safe runtime metadata from the post-listener assistant message.
  pi.on("message_end", (event, ctx) => {
    context = ctx;
    delivery?.onMessageEnd(event.message, ctx.sessionManager.getBranch());
    monitor.observeActivityDeclaration(event.message);
  });
  pi.on("context", (_event, ctx) => {
    delivery?.onContext(ctx.sessionManager.getBranch());
    observe(ctx);
  });
  pi.on("turn_end", (event, ctx) => {
    context = ctx;
    monitor.observeActivityTurnEnd(event.message);
    observe(ctx);
  });
  pi.on("before_agent_start", (event, ctx) => {
    context = ctx;
    pendingCorrectionPolicy = projectCorrectionPolicy(
      event.systemPromptOptions,
    );
  });
  pi.on("agent_start", (_event, ctx) => {
    context = ctx;
    // A subsequent logical run cannot receive stale classifier work from its
    // predecessor. Reconciliation retains its separate retry/compaction rules.
    delivery?.onCorrectionRunInvalidated();
    clearCorrectionOpportunity();
    const run = ++runEpoch;
    activeCorrectionRun = run;
    activeCorrectionSource = {
      sourceRun: run,
      policy: pendingCorrectionPolicy ?? { coverage: "unknown", entries: [] },
    };
    pendingCorrectionPolicy = undefined;
    delivery?.onAgentStart();
    reconciliation?.runStarted(run);
    monitor.setActivity("Agent active");
  });
  pi.on("agent_settled", (_event, ctx) => {
    context = ctx;
    monitor.setActivity("Idle");
    activeCorrectionRun = undefined;
    activeCorrectionSource = undefined;
    clearCorrectionOpportunity();
    // Final canonical observation precedes delivery-origin classification and
    // controller readiness/deadline handling.
    observe(ctx);
    const origin = delivery?.onAgentSettled(ctx.sessionManager.getBranch());
    delivery?.onCorrectionRunInvalidated();
    settle(origin);
  });
  pi.on("model_select", (_event, ctx) => {
    context = ctx;
    monitor.modelSelected();
  });
  pi.on("tool_execution_start", (event, ctx) => {
    context = ctx;
    monitor.observeActivityStart(event.toolCallId, event.toolName, event.args);
    monitor.observeToolStart(
      event.toolCallId,
      event.toolName,
      event.args,
      ctx.sessionManager.getLeafId() ?? undefined,
    );
    monitor.setActivity("Tool active");
    const correction = correctionAdapter.start(
      event.toolCallId,
      event.toolName,
      event.args,
      ctx.cwd,
    );
    const source = activeCorrectionSource;
    if (correction && source)
      void monitor.observeCorrectionAttempt(correction, {
        ...source,
        action: projectCorrectionAction(
          ctx.sessionManager.getBranch(),
          ctx.sessionManager.getLeafId(),
          event.toolCallId,
          ctx.cwd,
        ),
      });
  });
  pi.on("tool_execution_update", (event, ctx) => {
    context = ctx;
    const correction = correctionAdapter.update(
      event.toolCallId,
      event.toolName,
      event.partialResult,
    );
    const source = activeCorrectionSource;
    if (correction && source)
      void monitor.observeCorrectionAttempt(correction, {
        ...source,
        action: projectCorrectionAction(
          ctx.sessionManager.getBranch(),
          ctx.sessionManager.getLeafId(),
          event.toolCallId,
          ctx.cwd,
        ),
      });
  });
  pi.on("tool_execution_end", (event, ctx) => {
    context = ctx;
    correctionAdapter.end(event.toolCallId);
    monitor.observeToolEnd(
      event.toolCallId,
      event.toolName,
      event.result,
      event.isError,
    );
    monitor.setActivity(ctx.isIdle() ? "Idle" : "Agent active");
  });
}
