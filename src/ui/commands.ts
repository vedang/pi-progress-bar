import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { reconcileLedger } from "../core/ledger";
import type { Monitor } from "../core/monitor";
import { readSource } from "../sources/read-source";
import { details, plain } from "./widget";

export async function command(
  args: string,
  ctx: ExtensionCommandContext,
  monitor: Monitor,
) {
  const epoch = monitor.epoch;
  const current = () => epoch === monitor.epoch;
  try {
    let action = args.trim();
    if (!action) {
      if (!ctx.hasUI) return;
      const choice = await ctx.ui.select("Progress", [
        "Select source",
        "Details",
        "Interval",
        "Enable",
        "Pause",
        "Resume",
      ]);
      if (!choice || !current()) return;
      action = choice === "Select source" ? "source" : choice.toLowerCase();
    }
    if (action === "enable") {
      if (!ctx.hasUI) return;
      const snapshot = monitor.snapshot();
      const disclosure = [
        "Experimental third-party analysis: sends selected checklist task, its owned criteria, task-local goal and evidence references to TypeSafe (https://api.typesafe.ai/v1/systemone), model jev-1.13.0.",
        "Permission covers future revisions of this selected source during this session only. Selecting a source again, reload or tree navigation requires new consent. No conversation or other files sent in this slice.",
        "Paid-work budget: at most 60 dispatch attempts per enablement, one per 15 seconds, one in flight, 10-second deadline, 24 KiB / 20 questions. No automatic retries of failed unchanged input. Enable renews the budget. Set TYPESAFE_API_KEY; key is never stored in checkpoints.",
        "Health never changes reported completion. Accuracy not live-validated. Pause retains local counts; resume can retry unchanged input.",
        snapshot
          ? `Current payload:\n${JSON.stringify(snapshot.request, null, 2)}\nOmissions: ${snapshot.omissions.join("; ")}`
          : "Current payload: none. Current task or essential evidence is Unknown; no request until selected evidence is available.",
      ].join("\n\n");
      if (
        (await ctx.ui.confirm(
          "Enable experimental Jev analysis?",
          plain(disclosure),
        )) &&
        current()
      )
        monitor.enableAnalysis();
      return;
    }
    if (action === "pause") {
      monitor.pauseAnalysis();
      return;
    }
    if (action === "resume") {
      monitor.resumeAnalysis();
      return;
    }
    if (action === "details") {
      await details(ctx, monitor);
      return;
    }
    if (action === "interval" || action.startsWith("interval ")) {
      const value =
        action.slice(8).trim() ||
        (ctx.hasUI
          ? await ctx.ui.input(
              "Refresh interval in seconds",
              String(monitor.interval),
            )
          : undefined);
      if (value === undefined || !current()) return;
      if (!/^\d+(?:\.\d+)?$/.test(value.trim()))
        throw new Error("Enter a positive interval in seconds");
      monitor.setInterval(Number(value), ctx.cwd);
      return;
    }
    if (action !== "source" && !action.startsWith("source "))
      throw new Error(
        "Use /progress [source path.md#Section | details | interval seconds | enable | pause | resume]",
      );
    if (!ctx.hasUI) return;
    const reference =
      action.slice(6).trim() ||
      (await ctx.ui.input("Checklist source: workspace path.md#Section"));
    if (!reference || !current()) return;
    const split = reference.indexOf("#");
    const path = split < 0 ? reference : reference.slice(0, split);
    const section = split < 0 ? undefined : reference.slice(split + 1);
    const snapshot = await readSource(ctx.cwd, path, section);
    if (!current()) return;
    const draft = reconcileLedger(undefined, snapshot);
    const listing = draft.tasks
      .map((task, i) => `${i + 1}. ${plain(task.text)}`)
      .join("\n");
    const scope = await ctx.ui.input(
      `Included task numbers, comma-separated; blank = all\n${listing}`,
    );
    if (scope === undefined || !current()) return;
    const numbers = scope.trim()
      ? scope.split(",").map((part) => {
          if (!/^\d+$/.test(part.trim()))
            throw new Error("Invalid task numbers");
          return Number(part.trim());
        })
      : draft.tasks.map((_, i) => i + 1);
    if (
      new Set(numbers).size !== numbers.length ||
      numbers.some((n) => n < 1 || n > draft.tasks.length)
    )
      throw new Error("Invalid task numbers");
    const included = draft.tasks.filter((_, i) => numbers.includes(i + 1));
    const options = [
      "Unknown",
      ...included.map((task, i) => `${i + 1}. ${plain(task.text)}`),
    ];
    const currentChoice = await ctx.ui.select(
      "Current task (optional)",
      options,
    );
    if (currentChoice === undefined || !current()) return;
    const index = options.indexOf(currentChoice) - 1;
    const selected = reconcileLedger(draft, snapshot, {
      includedIds: included.map((task) => task.id),
      currentTaskId: included[index]?.id,
    });
    if (
      !(await ctx.ui.confirm(
        "Apply progress source?",
        `${plain(reference)}\n${included.length} included tasks. Counts are reported, not verified.\n${included.map((task) => `${task.status}: ${plain(task.text)}`).join("\n")}`,
      )) ||
      !current()
    )
      return;
    monitor.apply(selected, { path, section });
  } catch (error) {
    if (current() && ctx.hasUI)
      ctx.ui.notify(
        error instanceof Error
          ? plain(error.message)
          : "Progress command failed",
        "error",
      );
  }
}
