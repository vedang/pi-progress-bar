import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Monitor } from "../core/monitor";

const USAGE =
  "Usage: /progress on | /progress off | /progress interval <5-86400>";

/** Deliberately small control surface: monitoring is automatic, never configured here. */
export async function command(
  args: string,
  ctx: ExtensionCommandContext,
  monitor: Monitor,
) {
  const action = args.trim();
  try {
    if (!action) {
      if (ctx.hasUI)
        ctx.ui.notify(
          `${USAGE}. State: ${monitor.enabled ? "ON" : "OFF"}; interval ${monitor.interval}s.`,
          "info",
        );
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
    throw new Error(USAGE);
  } catch (error) {
    if (ctx.hasUI)
      ctx.ui.notify(
        error instanceof Error ? error.message : "Progress command failed",
        "error",
      );
  }
}
