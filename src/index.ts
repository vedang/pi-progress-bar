import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ContinuationAuthorityBinding } from "./advisory/continuation-authority";
import { ContinuationController } from "./advisory/continuation-controller";
import {
  captureContinuationPolicy,
  validateContinuationPolicy,
} from "./advisory/continuation-policy";
import { selectedModelContinuation } from "./advisory/continuation-selected-model";
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
import { selectedModelSubtasks } from "./core/subtask-selected-model";
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
  /** Full rendered policy proof for one independent run and its status reply. */
  let pendingContinuationPolicy:
    | ReturnType<typeof captureContinuationPolicy>
    | undefined;
  let continuationPolicy:
    | {
        runId: number;
        policy: ReturnType<typeof captureContinuationPolicy>;
      }
    | undefined;
  let continuationBinding: ContinuationAuthorityBinding | undefined;
  let continuationFingerprint: string | undefined;
  let continuationDeliveryActive = false;
  let continuationControlEpoch = 0;
  let continuationController: ContinuationController | undefined;
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
    if (
      currentOpportunity?.kind === "test-correction" ||
      currentOpportunity?.kind === "review-correction"
    )
      clearOpportunity();
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
      invalidateContinuation();
      clearOpportunity();
    }
    if (ctx.mode === "tui" && presentation.enabled) {
      const snapshot = {
        presentation,
        board: monitor.boardSnapshot(),
        visibility: monitor.visibilitySnapshot(),
        subtasks: monitor.subtaskSnapshot(),
        subtaskAccess: monitor.subtaskAccessSnapshot(),
        subtaskDiagnostics: monitor.subtaskDiagnosticsSnapshot(),
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
      selectedModel: () =>
        context?.model
          ? `${context.model.provider}/${context.model.id}`
          : undefined,
      proposeSubtasks: selectedModelSubtasks(() => {
        if (!context) throw new Error("No active Pi context");
        return context;
      }),
      richDetailsEnabled: true,
      onContinuationWake: () => wakeContinuation(),
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

  function releaseContinuationRoot(): void {
    continuationBinding = undefined;
    continuationFingerprint = undefined;
    continuationPolicy = undefined;
    continuationDeliveryActive = false;
    if (currentOpportunity?.kind === "continuation") clearOpportunity();
  }

  function invalidateContinuation(clearPendingPolicy = true): void {
    continuationControlEpoch++;
    continuationController?.invalidate();
    monitor.invalidateContinuation();
    releaseContinuationRoot();
    if (clearPendingPolicy) pendingContinuationPolicy = undefined;
  }

  /**
   * Rebuild continuation authority from host-effective policy/model state.
   * The retained binding is immutable admission evidence; it must never be
   * updated from a later prompt/model before comparison with that evidence.
   */
  function currentContinuationAuthority(binding: ContinuationAuthorityBinding) {
    const ctx = context;
    const model = ctx?.model;
    if (
      !ctx ||
      !model?.provider ||
      !model.id ||
      `${model.provider}/${model.id}` !== binding.model
    )
      return;

    let effectivePrompt: unknown;
    try {
      effectivePrompt = ctx.getSystemPrompt();
    } catch {
      return;
    }
    return monitor.continuationAuthority({
      ...binding,
      policy: validateContinuationPolicy(binding.policy, effectivePrompt),
    });
  }

  /**
   * Transport retries retain immutable content only while the exact authority
   * accepted for the root is still current. This remains live after controller
   * delivery has consumed its semantic phases.
   */
  function continuationTransportCurrent(): boolean {
    const binding = continuationBinding;
    const fingerprint = continuationFingerprint;
    if (!binding || !fingerprint) return false;
    const authority = currentContinuationAuthority(binding);
    return (
      authority?.available === true && authority.fingerprint === fingerprint
    );
  }

  function wakeContinuation(): void {
    const controller = continuationController;
    const binding = continuationBinding;
    if (!controller || !binding) return;
    const phase = controller.snapshot().phase;
    if (phase === "idle" || phase === "consumed") return;
    const authority = currentContinuationAuthority(binding);
    if (!authority?.available) {
      if (authority?.reason !== "frontier") invalidateContinuation();
      else
        void controller.wake().finally(() => {
          if (
            continuationBinding === binding &&
            controller.snapshot().phase === "consumed" &&
            !continuationDeliveryActive
          )
            releaseContinuationRoot();
        });
      return;
    }
    if (
      continuationFingerprint !== undefined &&
      continuationFingerprint !== authority.fingerprint
    ) {
      invalidateContinuation();
      return;
    }
    continuationFingerprint ??= authority.fingerprint;
    void controller.wake().finally(() => {
      if (
        continuationBinding === binding &&
        controller.snapshot().phase === "consumed" &&
        !continuationDeliveryActive
      )
        releaseContinuationRoot();
    });
  }

  continuationController = new ContinuationController({
    authority: () =>
      continuationBinding
        ? (currentContinuationAuthority(continuationBinding) ?? {
            available: false,
            reason: "stale",
          })
        : { available: false, reason: "stale" },
    canStart: () =>
      monitor.continuationCanStart() &&
      (context?.isIdle() ?? false) &&
      !(context?.hasPendingMessages() ?? true),
    gate: (batch, signal, admit, onPhysicalFlight) =>
      monitor.evaluateContinuationGate(batch, signal, admit, onPhysicalFlight),
    draft: selectedModelContinuation(() => {
      if (!context) throw new Error("No active Pi context");
      return context;
    }),
    emit: (draft) => {
      const binding = continuationBinding;
      const target = delivery;
      if (
        !binding ||
        !target ||
        currentOpportunity?.kind !== "continuation" ||
        currentOpportunity.id !== binding.receipt.opportunityId ||
        currentOpportunity.runId !== binding.originalRunId
      )
        return false;
      const result = target.request({
        kind: "continuation",
        opportunityId: binding.receipt.opportunityId,
        content: draft.message,
        sessionEpoch: binding.sessionEpoch,
        branchEpoch: binding.branchEpoch,
      });
      continuationDeliveryActive = result === "started";
      return continuationDeliveryActive;
    },
  });

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
          currentOpportunity?.kind === "reconciliation"
            ? snapshot.tasks.some((task) => task.status !== "done")
            : snapshot.reason === "ready" &&
              (currentOpportunity?.kind === "continuation"
                ? !!continuationBinding &&
                  continuationBinding.receipt.opportunityId ===
                    currentOpportunity.id &&
                  continuationBinding.originalRunId ===
                    currentOpportunity.runId &&
                  continuationTransportCurrent()
                : correctionRelevant),
        idle: context?.isIdle() ?? false,
        pendingMessages: context?.hasPendingMessages() ?? true,
      };
    },
    branch: () => context?.sessionManager.getBranch() ?? [],
    sendMessage: (message, options) => pi.sendMessage(message, options),
    onReconciliationSettled: (receipt) => {
      const original = currentOpportunity;
      const policy = continuationPolicy;
      const controller = continuationController;
      const model = context?.model;
      if (
        !controller ||
        original?.kind !== "reconciliation" ||
        original.id !== receipt.opportunityId ||
        original.runId === undefined ||
        original.runId !== policy?.runId ||
        receipt.sessionEpoch !== sessionEpoch ||
        receipt.branchEpoch !== branchEpoch ||
        !model?.provider ||
        !model.id
      )
        return;
      const binding: ContinuationAuthorityBinding = {
        receipt,
        policy: policy.policy,
        originalRunId: original.runId,
        sessionEpoch,
        branchEpoch,
        controlEpoch: continuationControlEpoch,
        model: `${model.provider}/${model.id}`,
      };
      if (
        !controller.arm({
          opportunityId: original.id,
          sessionEpoch,
          branchEpoch,
          originalRunId: original.runId,
        }) ||
        !controller.settle(receipt)
      )
        return;
      continuationBinding = binding;
      continuationFingerprint = undefined;
      // Root ownership moves only after original chain releases and receipt binds.
      currentOpportunity = {
        id: original.id,
        kind: "continuation",
        runId: original.runId,
      };
      wakeContinuation();
    },
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
    // Tool payloads remain ingress only. Confirm adapter facts from the fresh
    // host canonical branch after Monitor observes its mandatory state.
    monitor.confirmCoverageBranch(ctx.sessionManager.getBranch());
    reconciliation?.refresh();
    wakeContinuation();
  };
  const settle = (
    origin: SettlementOrigin | undefined,
    settlingKind: AdvisoryDeliveryKind | undefined,
  ) => {
    if (origin === undefined) return;
    if (origin !== "uncertain-advisory") {
      // Receipt callback may synchronously move reconciliation ownership into
      // its continuation root. Never clear that newly acquired opportunity.
      if (
        settlingKind === "reconciliation" &&
        currentOpportunity?.kind === "reconciliation"
      )
        clearOpportunity();
      else if (
        settlingKind === "continuation" &&
        currentOpportunity?.kind === "continuation"
      )
        releaseContinuationRoot();
    }
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
    invalidateContinuation();
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
    invalidateContinuation();
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
    invalidateContinuation();
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
    invalidateContinuation();
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
    invalidateContinuation();
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
    context = ctx;
    const rootRun =
      currentOpportunity?.kind === "reconciliation"
        ? currentOpportunity.runId
        : runEpoch;
    const policy = continuationPolicy;
    if (policy && policy.runId === rootRun) {
      let effectivePrompt: unknown;
      try {
        effectivePrompt = ctx.getSystemPrompt();
      } catch {
        // Missing host observation is unknown, never empty standing authority.
      }
      continuationPolicy = {
        runId: policy.runId,
        policy: validateContinuationPolicy(policy.policy, effectivePrompt),
      };
    }
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
    // Structured options omit assembled base/skill/tool guidance. Preserve the
    // full rendered prompt now, then validate it at provider-context time.
    pendingContinuationPolicy = captureContinuationPolicy(event.systemPrompt);
  });
  pi.on("agent_start", (_event, ctx) => {
    context = ctx;
    // Delivery alone distinguishes its own retry/compaction starts from a new
    // independent run. A new run immediately revokes an old continuation root.
    delivery?.onCorrectionRunInvalidated();
    const ownAdvisoryStart = delivery?.onAgentStart() ?? false;
    // Pi retries/compaction begin another low-level run without another
    // before_agent_start. Only an already-active source run can retain its
    // proof; an idle custom turn has no fresh capture and must be unknown.
    const priorContinuationPolicy = continuationPolicy?.policy;
    const continuingSourceRun = activeCorrectionRun !== undefined;
    if (!ownAdvisoryStart) {
      invalidateContinuation(false);
      clearOpportunity();
    }
    clearCorrectionOpportunity();
    const run = ++runEpoch;
    activeCorrectionRun = run;
    activeCorrectionAttemptId = undefined;
    activeCorrectionSource = {
      sourceRun: run,
      policy: pendingCorrectionPolicy ?? { coverage: "unknown", entries: [] },
    };
    pendingCorrectionPolicy = undefined;
    if (!ownAdvisoryStart) {
      continuationPolicy = {
        runId: run,
        policy:
          pendingContinuationPolicy ??
          (continuingSourceRun ? priorContinuationPolicy : undefined) ??
          captureContinuationPolicy(undefined),
      };
    }
    pendingContinuationPolicy = undefined;
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
    // controller readiness/frontier handling.
    observe(ctx);
    monitor.confirmVisibilityBranch(ctx.sessionManager.getBranch());
    monitor.visibilityRunSettled();
    const settlingKind = currentOpportunity?.kind;
    const origin = delivery?.onAgentSettled(ctx.sessionManager.getBranch());
    delivery?.onCorrectionRunInvalidated();
    settle(origin, settlingKind);
  });
  pi.on("model_select", (_event, ctx) => {
    context = ctx;
    invalidateContinuation();
    clearOpportunity();
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
    monitor.observeCoverageToolStart(
      event.toolCallId,
      event.toolName,
      event.args,
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
    monitor.observeCoverageToolEnd(event.toolCallId, event.toolName);
    monitor.observeVisibilityToolEnd(event.toolCallId);
    monitor.setActivity(ctx.isIdle() ? "Idle" : "Agent active");
  });
}
