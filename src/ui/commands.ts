import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Monitor } from "../core/monitor";

const commands = `How to use:
  /progress                         Show this help and current state
  /progress on                      Start or resume automatic monitoring
  /progress off                     Stop monitoring and hide the widget

Widget controls:
  Right / →                         Select progress usage when editor is empty
  Enter                             Request task board
  Left / Esc                        Return selection to editor`;

const help = (monitor: Monitor) => {
  const view = monitor.presentationSnapshot();
  return `Automatic progress monitor

State: ${view.enabled ? "ON" : "OFF"}
Progress: ${view.progress.done}/${view.progress.total} (${view.progress.kind})
Service: ${view.service.label}
Jev requests: ${view.usage.jev.calls} actual dispatched requests • ${view.usage.jev.inputTokens} input tokens • ${view.usage.jev.outputTokens} output tokens
Extraction requests: ${view.usage.extraction.calls} actual dispatched requests • ${view.usage.extraction.inputTokens} input tokens • ${view.usage.extraction.outputTokens} output tokens
Request counts are session-wide transport dispatches, not questions or tasks.

${commands}`;
};

/** Deliberately small control surface: monitoring is automatic, never configured here. */
export async function command(
  args: string,
  ctx: ExtensionCommandContext,
  monitor: Monitor,
) {
  const action = args.trim();
  try {
    if (!action) {
      if (ctx.hasUI) ctx.ui.notify(help(monitor), "info");
      return;
    }
    if (action === "off") {
      monitor.turnOff();
      if (ctx.mode === "tui") ctx.ui.setWidget("pi-progress-bar", undefined);
      return;
    }
    if (action === "on") {
      const error = monitor.turnOn(ctx.cwd);
      if (error && ctx.hasUI) ctx.ui.notify(error, "error");
      return;
    }
    throw new Error(`Unknown progress command.\n\n${commands}`);
  } catch (error) {
    if (ctx.hasUI)
      ctx.ui.notify(
        error instanceof Error ? error.message : "Progress command failed",
        "error",
      );
  }
}
