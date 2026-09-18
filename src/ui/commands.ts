import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Monitor } from "../core/monitor";
import { lastJevCallLabel } from "./freshness";

const COMMANDS = `How to use:
  /progress                         Show this help and current state
  /progress on                      Start or resume automatic monitoring
  /progress off                     Stop monitoring and hide the widget
  /progress interval <seconds>      Set analysis interval (5-86400)`;

const help = (monitor: Monitor) => `Automatic progress monitor

State: ${monitor.enabled ? "ON" : "OFF"}
Analysis interval: ${monitor.interval}s
Jev usage: ${monitor.usage.calls} calls • ${monitor.usage.inputTokens} input tokens • ${monitor.usage.outputTokens} output tokens
Last Jev call: ${lastJevCallLabel(monitor.gateway.lastCallAt)}
Progress: ${monitor.progressState()}
Service: ${monitor.error ? `${monitor.error} • ${monitor.gateway.status}` : monitor.gateway.status}
Diagnostics: ${monitor.diagnosticSummary()}

${COMMANDS}

Monitoring starts automatically when TYPESAFE_API_KEY is available.`;

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
    const match = /^interval\s+(\d+)$/.exec(action);
    if (match) {
      monitor.setInterval(Number(match[1]), ctx.cwd);
      return;
    }
    throw new Error(`Unknown progress command.\n\n${COMMANDS}`);
  } catch (error) {
    if (ctx.hasUI)
      ctx.ui.notify(
        error instanceof Error ? error.message : "Progress command failed",
        "error",
      );
  }
}
