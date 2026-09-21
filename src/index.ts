import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CorrectionAdapter } from "./advisory/correction-adapter";
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
  let currentOpportunity:
    | { id: string; kind: AdvisoryDeliveryKind; runId?: number }
    | undefined;
  const correctionAdapter = new CorrectionAdapter({
    tools: () => pi.getAllTools(),
  });
  const clearOpportunity = () => {
    currentOpportunity = undefined;
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
      onCorrection: ({ kind, content }) => {
        const target = delivery;
        // One chain owns all advisory retries. Never replace a live
        // reconciliation opportunity with a concurrent correction.
        if (!target || currentOpportunity) return;
        const opportunityId = randomUUID();
        currentOpportunity = { id: opportunityId, kind };
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
      return {
        enabled: snapshot.enabled,
        mode: context?.mode ?? "print",
        sessionEpoch,
        branchEpoch,
        opportunityId: currentOpportunity?.id,
        relevant:
          snapshot.reason === "ready" &&
          (currentOpportunity?.kind !== "reconciliation" ||
            snapshot.tasks.some((task) => task.status !== "done")),
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
    clearOpportunity();
    await restore(ctx, false);
  });
  pi.on("session_before_tree", () => {
    delivery?.onNavigation();
    correctionAdapter.reset();
    monitor.invalidateCorrections();
    reconciliation?.cancel();
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
    clearOpportunity();
    await restore(ctx, true);
  });
  pi.on("session_shutdown", () => {
    disposeController();
    delivery?.onSessionShutdown();
    correctionAdapter.reset();
    reconciliation?.cancel();
    clearOpportunity();
    monitor.stop();
    context = undefined;
  });
  pi.on("input", () => {
    delivery?.onInput();
    correctionAdapter.reset();
    monitor.invalidateCorrections();
    reconciliation?.clearPendingIntent();
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
  pi.on("agent_start", (_event, ctx) => {
    context = ctx;
    delivery?.onAgentStart();
    reconciliation?.runStarted(++runEpoch);
    monitor.setActivity("Agent active");
  });
  pi.on("agent_settled", (_event, ctx) => {
    context = ctx;
    monitor.setActivity("Idle");
    // Final canonical observation precedes delivery-origin classification and
    // controller readiness/deadline handling.
    observe(ctx);
    settle(delivery?.onAgentSettled(ctx.sessionManager.getBranch()));
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
    if (correction) void monitor.observeCorrectionAttempt(correction);
  });
  pi.on("tool_execution_update", (event, ctx) => {
    context = ctx;
    const correction = correctionAdapter.update(
      event.toolCallId,
      event.toolName,
      event.partialResult,
    );
    if (correction) void monitor.observeCorrectionAttempt(correction);
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
