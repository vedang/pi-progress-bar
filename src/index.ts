import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Monitor } from "./core/monitor";
import { selectedModelExtractor } from "./core/selected-model";
import { command } from "./ui/commands";
import { createUiController, type UiController } from "./ui/controller";
import { createUiHost } from "./ui/host";

export default function progressBar(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let notifiedError: string | undefined;
  let controller: UiController | undefined;
  const disposeController = () => {
    controller?.dispose();
    controller = undefined;
  };
  const render = () => {
    const ctx = context;
    if (!ctx) return;
    const presentation = monitor.presentationSnapshot();
    if (ctx.mode === "tui" && presentation.enabled) {
      const snapshot = { presentation, board: monitor.boardSnapshot() };
      if (!controller) {
        // Host contexts may be freshly wrapped for every event. Only explicit
        // session/branch/OFF lifecycle boundaries replace the UI generation.
        // Board construction belongs to U10. U08 only consumes Enter exactly once.
        controller = createUiController(createUiHost(ctx), snapshot, () => {});
      } else controller.update(snapshot);
      notifiedError = undefined;
      return;
    }
    disposeController();
    if (monitor.error && monitor.error !== notifiedError && ctx.hasUI) {
      ctx.ui.notify(monitor.error, "error");
      notifiedError = monitor.error;
    }
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
    },
  );
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
  };

  pi.registerCommand("progress", {
    description: "Show or turn automatic progress monitoring on/off",
    handler: (args, ctx) => command(args, ctx, monitor),
  });
  pi.on("session_start", async (_event, ctx) => {
    await restore(ctx, false);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await restore(ctx, true);
  });
  pi.on("session_shutdown", () => {
    disposeController();
    monitor.stop();
    context = undefined;
  });
  // Canonical active branch is authoritative; raw message_end is not observed.
  pi.on("context", (_event, ctx) => observe(ctx));
  pi.on("turn_end", (_event, ctx) => observe(ctx));
  pi.on("agent_start", (_event, ctx) => {
    context = ctx;
    monitor.setActivity("Agent active");
  });
  pi.on("agent_settled", (_event, ctx) => {
    monitor.setActivity("Idle");
    observe(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    context = ctx;
    monitor.modelSelected();
  });
  pi.on("tool_execution_start", (event, ctx) => {
    context = ctx;
    monitor.observeToolStart(
      event.toolCallId,
      event.toolName,
      event.args,
      ctx.sessionManager.getLeafId() ?? undefined,
    );
    monitor.setActivity("Tool active");
  });
  pi.on("tool_execution_end", (event, ctx) => {
    context = ctx;
    monitor.observeToolEnd(
      event.toolCallId,
      event.toolName,
      event.result,
      event.isError,
    );
    monitor.setActivity(ctx.isIdle() ? "Idle" : "Agent active");
  });
}
