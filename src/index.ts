import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Monitor } from "./core/monitor";
import { command } from "./ui/commands";
import { paint, widgetName } from "./ui/widget";

export default function progressBar(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let notifiedError: string | undefined;
  const monitor = new Monitor(
    () => {
      if (!context) return;
      if (monitor.enabled) {
        paint(context, monitor);
        notifiedError = undefined;
      } else {
        if (context.mode === "tui") context.ui.setWidget(widgetName, undefined);
        if (monitor.error && monitor.error !== notifiedError && context.hasUI) {
          context.ui.notify(monitor.error, "error");
          notifiedError = monitor.error;
        }
      }
    },
    (data) => pi.appendEntry("pi-progress-bar", data),
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
    monitor.observe(() => ctx.sessionManager.getBranch());
    const saved = checkpoint(ctx);
    await monitor.restore(
      ctx.cwd,
      saved?.type === "custom" ? saved.data : undefined,
      preserveControls,
    );
    if (!monitor.enabled && ctx.mode === "tui")
      ctx.ui.setWidget(widgetName, undefined);
  };
  pi.registerCommand("progress", {
    description: "Turn automatic progress monitoring on/off or set interval",
    handler: (args, ctx) => {
      monitor.observe(() => ctx.sessionManager.getBranch());
      return command(args, ctx, monitor);
    },
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
  pi.on("message_end", (_event, ctx) => {
    if (!monitor.enabled) return;
    monitor.observe(() => ctx.sessionManager.getBranch());
    monitor.scheduleAnalysis();
  });
  pi.on("agent_start", (_event, ctx) => {
    if (!monitor.enabled) return;
    monitor.activity = "Agent active";
    paint(ctx, monitor);
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!monitor.enabled) return;
    monitor.activity = "Idle";
    monitor.observe(() => ctx.sessionManager.getBranch());
    monitor.scheduleAnalysis();
    paint(ctx, monitor);
  });
  pi.on("tool_execution_start", (_event, ctx) => {
    if (!monitor.enabled) return;
    monitor.activity = "Tool active";
    paint(ctx, monitor);
  });
  pi.on("tool_execution_end", (_event, ctx) => {
    if (!monitor.enabled) return;
    monitor.activity = ctx.isIdle() ? "Idle" : "Agent active";
    paint(ctx, monitor);
  });
}
