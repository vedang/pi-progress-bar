import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { reconcileLedger } from "../core/ledger";
import type { Checkpoint, Monitor } from "../core/monitor";
import type { SourceSnapshot } from "../core/types";
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
        "Experimental third-party analysis: sends selected task, owned criteria, source goal/context, and visible user/assistant text from the current active Pi branch to TypeSafe (https://api.typesafe.ai/v1/systemone), model jev-1.13.0. Includes plan candidates, exact task spans and original reports. No sibling sessions, system/thinking/private shell/tool bodies, summaries or monitor metadata sent. Interactive tool answers excluded: no verified provenance adapter.",
        "Permission covers future visible current-branch conversation and selected-source revisions during this session only. Enable without a file permits discovery. Selecting a source again, reload or tree navigation requires new consent. No automatic source replacement. Suggestions require confirmation; interpreted reports are experimental, not observed completion.",
        `Trajectory bounds: 512 entries / 256 KiB; 12 candidates and 200 selected tasks. Current discovery/report sample and omissions:\n${JSON.stringify(monitor.conversation.preview(monitor.ledger), null, 2)}`,
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
        "Use /progress [source path.md#Section | source conversation | details | interval seconds | enable | pause | resume]",
      );
    if (!ctx.hasUI) return;
    const reference =
      action.slice(6).trim() ||
      (await ctx.ui.input("Checklist source: workspace path.md#Section"));
    if (!reference || !current()) return;
    const split = reference.indexOf("#");
    const path = split < 0 ? reference : reference.slice(0, split);
    const section = split < 0 ? undefined : reference.slice(split + 1);
    let snapshot: SourceSnapshot;
    let source: NonNullable<Checkpoint["source"]>;
    let ambiguous = false;
    const isConversation = path === "conversation";
    if (isConversation) {
      if (section) {
        monitor.conversation.narrow(section);
        monitor.scheduleAnalysis();
      }
      const proposals = monitor.conversation.proposals;
      if (!proposals.length)
        throw new Error(
          `No conversation proposal ready. Use /progress enable, wait, then select again. ${monitor.conversation.discoveryStatus}. Interactive tool answers excluded: no verified provenance adapter.`,
        );
      const labels = proposals.map(
        (item, i) =>
          `${i + 1}. Entry ${item.candidate.entryId}: ${plain(item.candidate.text).slice(0, 160)}${item.ambiguous ? " • ambiguous; explicit task numbers required" : ""}`,
      );
      const choice = await ctx.ui.select(
        "Conversation plan suggestion (not automatic authority)",
        labels,
      );
      if (!choice || !current()) return;
      const item = proposals[labels.indexOf(choice)];
      if (!item) return;
      source = monitor.conversation.source(item);
      snapshot = monitor.conversation.rehydrate(source);
      ambiguous = item.ambiguous;
    } else {
      snapshot = await readSource(ctx.cwd, path, section);
      source = { path, section };
    }
    if (!current()) return;
    const draft = reconcileLedger(undefined, snapshot);
    const listing = draft.tasks
      .map((task, i) => `${i + 1}. ${plain(task.text).slice(0, 240)}`)
      .join("\n");
    const scope = await ctx.ui.input(
      `Included task numbers, comma-separated; blank = all\n${listing}`,
    );
    if (scope === undefined || !current()) return;
    if (ambiguous && !scope.trim())
      throw new Error(
        "Ambiguous segmentation: explicitly choose task numbers; blank cannot establish denominator",
      );
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
      ...included.map(
        (task, i) => `${i + 1}. ${plain(task.text).slice(0, 240)}`,
      ),
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
        `${plain(reference)}\n${included.length} included tasks. Counts are reported, not verified.\n${included.map((task) => `${task.status}: ${plain(task.text).slice(0, 240)}`).join("\n")}\n${isConversation ? monitor.conversation.omissions.join("; ") : ""}`,
      )) ||
      !current()
    )
      return;
    monitor.apply(selected, source);
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
