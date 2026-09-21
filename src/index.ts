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
  CorrectionAttempt,
  CorrectionAttemptSource,
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
  /** Latest adapter-admitted B/C action within active source run. */
  let activeCorrectionAttemptId: string | undefined;
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
  // Tool-end branch state can advance past its declaration. Keep only the
  // already-reduced source action until this one admitted review ends.
  const reviewSources = new Map<string, CorrectionAttemptSource>();
  const resetCorrections = () => {
    correctionAdapter.reset();
    reviewSources.clear();
    activeCorrectionAttemptId = undefined;
  };
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
      resetCorrections();
      activeCorrectionRun = undefined;
      activeCorrectionSource = undefined;
      pendingCorrectionPolicy = undefined;
      clearOpportunity();
    }
    if (ctx.mode === "tui" && presentation.enabled) {
      const snapshot = {
        presentation,
        board: monitor.boardSnapshot(),
        visibility: monitor.visibilitySnapshot(),
      };
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
          activeCorrectionAttemptId !== binding.attemptId ||
          !monitor.correctionIsCurrent(binding) ||
          (binding.reviewRunId !== undefined &&
            !correctionAdapter.isReviewActive(binding.reviewRunId))
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
        activeCorrectionAttemptId === correctionBinding.attemptId &&
        monitor.correctionIsCurrent(correctionBinding) &&
        (correctionBinding.reviewRunId === undefined ||
          correctionAdapter.isReviewActive(correctionBinding.reviewRunId));
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

  // Installed pi-subagents publishes this public lifecycle event after its
  // result watcher observes completion. It can revoke a known review only.
  const untrackAsyncReview = pi.events.on("subagent:async-complete", (data) => {
    correctionAdapter.complete(data);
    const binding = currentOpportunity?.binding;
    if (
      binding?.reviewRunId !== undefined &&
      !correctionAdapter.isReviewActive(binding.reviewRunId)
    ) {
      delivery?.onCorrectionRunInvalidated();
      clearCorrectionOpportunity();
    }
  });
  (
    pi as unknown as {
      trackEventBusSubscription?: (unsubscribe: () => void) => void;
    }
  ).trackEventBusSubscription?.(untrackAsyncReview);

  pi.registerCommand("progress", {
    description: "Show or turn automatic progress monitoring on/off",
    handler: (args, ctx) => command(args, ctx, monitor),
  });
  pi.on("session_start", async (_event, ctx) => {
    // Session replacement normally sends shutdown first. Repeat disposal here
    // for a direct host start boundary; no old timer may survive either path.
    delivery?.onSessionShutdown();
    resetCorrections();
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
    monitor.invalidateVisibility();
    delivery?.onNavigation();
    resetCorrections();
    monitor.invalidateCorrections();
    reconciliation?.cancel();
    activeCorrectionRun = undefined;
    activeCorrectionSource = undefined;
    pendingCorrectionPolicy = undefined;
    clearOpportunity();
  });
  pi.on("session_tree", async (_event, ctx) => {
    // Real hosts fire session_before_tree first; repeat cancellation so this
    monitor.invalidateVisibility();
    // post-navigation boundary is also safe when delivered alone.
    delivery?.onNavigation();
    resetCorrections();
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
    resetCorrections();
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
    resetCorrections();
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
    monitor.observeVisibilityMessage(
      event.message,
      ctx.sessionManager.getBranch(),
    );
  });
  pi.on("context", (_event, ctx) => {
    delivery?.onContext(ctx.sessionManager.getBranch());
    observe(ctx);
    monitor.confirmVisibilityBranch(ctx.sessionManager.getBranch());
  });
  pi.on("turn_end", (event, ctx) => {
    context = ctx;
    monitor.observeActivityTurnEnd(event.message);
    observe(ctx);
    monitor.confirmVisibilityBranch(ctx.sessionManager.getBranch());
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
    activeCorrectionAttemptId = undefined;
    activeCorrectionSource = {
      sourceRun: run,
      policy: pendingCorrectionPolicy ?? { coverage: "unknown", entries: [] },
    };
    pendingCorrectionPolicy = undefined;
    delivery?.onAgentStart();
    reconciliation?.runStarted(run);
    monitor.visibilityRunStarted();
    monitor.setActivity("Agent active");
  });
  pi.on("agent_settled", (_event, ctx) => {
    context = ctx;
    monitor.setActivity("Idle");
    activeCorrectionRun = undefined;
    activeCorrectionAttemptId = undefined;
    activeCorrectionSource = undefined;
    clearCorrectionOpportunity();
    // Final canonical observation precedes delivery-origin classification and
    // controller readiness/deadline handling.
    observe(ctx);
    monitor.confirmVisibilityBranch(ctx.sessionManager.getBranch());
    monitor.visibilityRunSettled();
    const origin = delivery?.onAgentSettled(ctx.sessionManager.getBranch());
    delivery?.onCorrectionRunInvalidated();
    settle(origin);
  });
  pi.on("model_select", (_event, ctx) => {
    context = ctx;
    monitor.modelSelected();
  });
  const observeCorrectionAttempt = (
    attempt: CorrectionAttempt,
    source: CorrectionAttemptSource,
  ) => {
    // A duplicate host start event for one tool call is not new authority.
    // A distinct admitted B/C action supersedes its predecessor immediately,
    // even while its classifier remains in flight or delivery retry is pending.
    if (activeCorrectionAttemptId !== attempt.id) {
      activeCorrectionAttemptId = attempt.id;
      delivery?.onCorrectionRunInvalidated();
      clearCorrectionOpportunity();
    }
    void monitor.observeCorrectionAttempt(attempt, source);
  };
  pi.on("tool_execution_start", (event, ctx) => {
    context = ctx;
    monitor.observeActivityStart(event.toolCallId, event.toolName, event.args);
    monitor.observeVisibilityToolStart(
      event.toolCallId,
      event.toolName,
      event.args,
    );
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
    const action = projectCorrectionAction(
      ctx.sessionManager.getBranch(),
      ctx.sessionManager.getLeafId(),
      event.toolCallId,
      ctx.cwd,
    );
    if (correction && source) {
      observeCorrectionAttempt(correction, { ...source, action });
    } else if (source && correctionAdapter.hasPendingReview(event.toolCallId)) {
      reviewSources.set(event.toolCallId, { ...source, action });
    }
  });
  pi.on("tool_execution_update", (event, ctx) => {
    context = ctx;
    // No C authority comes from foreground partial results or child progress.
    correctionAdapter.update(
      event.toolCallId,
      event.toolName,
      event.partialResult,
    );
  });
  pi.on("tool_execution_end", (event, ctx) => {
    context = ctx;
    const source = reviewSources.get(event.toolCallId);
    reviewSources.delete(event.toolCallId);
    const correction = correctionAdapter.end(
      event.toolCallId,
      event.toolName,
      event.result,
      event.isError,
    );
    if (correction && source) observeCorrectionAttempt(correction, source);
    monitor.observeToolEnd(
      event.toolCallId,
      event.toolName,
      event.result,
      event.isError,
    );
    monitor.observeVisibilityToolEnd(event.toolCallId);
    monitor.setActivity(ctx.isIdle() ? "Idle" : "Agent active");
  });
}
