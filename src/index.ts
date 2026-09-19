import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Monitor } from "./core/monitor";
import { selectedModelExtractor } from "./core/selected-model";
import { command } from "./ui/commands";
import { paint, widgetName } from "./ui/widget";

export default function progressBar(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let notifiedError: string | undefined;
  const render = () => {
    if (!context) return;
    const view = monitor.presentationSnapshot();
    if (view.enabled) {
      paint(context, view);
      notifiedError = undefined;
    } else {
      if (context.mode === "tui") context.ui.setWidget(widgetName, undefined);
      if (monitor.error && monitor.error !== notifiedError && context.hasUI) {
        context.ui.notify(monitor.error, "error");
        notifiedError = monitor.error;
      }
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
    context = ctx;
    const saved = checkpoint(ctx);
    await monitor.restore(
      ctx.cwd,
      saved?.type === "custom" ? saved.data : undefined,
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
  pi.on("session_shutdown", (_event, ctx) => {
    monitor.stop();
    context = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget(widgetName, undefined);
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
