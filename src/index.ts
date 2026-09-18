import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Monitor } from "./core/monitor";
import { command } from "./ui/commands";
import { paint, widgetName } from "./ui/widget";

export default function progressBar(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  const monitor = new Monitor(
    () => {
      if (context) paint(context, monitor);
    },
    (data) => pi.appendEntry("pi-progress-bar", data),
  );
  const restore = async (ctx: ExtensionContext) => {
    context = ctx;
    const checkpoint = ctx.sessionManager
      .getBranch()
      .filter(
        (entry) =>
          entry.type === "custom" && entry.customType === "pi-progress-bar",
      )
      .at(-1);
    await monitor.restore(
      ctx.cwd,
      checkpoint?.type === "custom" ? checkpoint.data : undefined,
    );
  };
  pi.registerCommand("progress", {
    description:
      "Select a checklist, inspect reported progress, or set refresh interval",
    handler: (args, ctx) => command(args, ctx, monitor),
  });
  pi.on("session_start", async (_event, ctx) => {
    await restore(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await restore(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    monitor.stop();
    context = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget(widgetName, undefined);
  });
  pi.on("agent_start", (_event, ctx) => {
    monitor.activity = "Agent active";
    paint(ctx, monitor);
  });
  pi.on("agent_settled", (_event, ctx) => {
    monitor.activity = "Idle";
    paint(ctx, monitor);
  });
  pi.on("tool_execution_start", (_event, ctx) => {
    monitor.activity = "Tool active";
    paint(ctx, monitor);
  });
  pi.on("tool_execution_end", (_event, ctx) => {
    monitor.activity = ctx.isIdle() ? "Idle" : "Agent active";
    paint(ctx, monitor);
  });
}
