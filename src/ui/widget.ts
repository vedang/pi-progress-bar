import {
  type ExtensionContext,
  truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { countReported } from "../core/ledger";
import type { Monitor } from "../core/monitor";

export const widgetName = "pi-progress-bar";
// Do not let source text supply terminal escape sequences.
export const plain = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, " ");
function signals(monitor: Monitor): string[] {
  const health = monitor.health;
  const freshness = health
    ? `as-of ${new Date(health.evaluatedAt).toISOString()}${monitor.gateway.status === "Current" ? "" : " • aged"}`
    : "Unknown; no inference as-of";
  const clarity = health?.result.answers.clarity;
  const acceptance = health?.result.answers.acceptance;
  const status = !monitor.consent
    ? "Disabled: consent required"
    : !monitor.snapshot()
      ? "Unknown: select current task / essential coverage unavailable"
      : monitor.gateway.status;
  return [
    `Experimental clarity: ${clarity?.type === "score" ? `${clarity.score}/3 • confidence ${clarity.confidence}` : "Unknown"} • ${freshness}`,
    `Experimental acceptance: ${acceptance?.type === "choice" ? `${acceptance.choice} • confidence ${acceptance.confidence}` : "Unknown"} • ${status}`,
  ];
}
export function paint(ctx: ExtensionContext, monitor: Monitor) {
  if (ctx.mode !== "tui") return;
  ctx.ui.setWidget(widgetName, (_tui, theme) => ({
    render(width) {
      if (width < 2) return [""];
      const count = countReported(monitor.ledger);
      const label = monitor.ledger
        ? `${monitor.ledger.kind === "conversation" ? "Conversation-reported" : "Reported"} ${count.done}/${count.total}${count.percent === null ? " • Unknown percentage" : ` • ${count.percent}%`}${monitor.ledger.stale ? " • Stale" : ""}`
        : "Progress: select a plan source with /progress";
      const filled = Math.floor((count.percent ?? 0) / 10);
      const bar =
        count.percent === null
          ? ""
          : `[${"#".repeat(filled)}${"-".repeat(10 - filled)}] `;
      const task = monitor.ledger?.tasks.find(
        (item) => item.id === monitor.ledger?.currentTaskId,
      );
      const lines = [
        theme.fg("accent", bar + label),
        theme.fg(
          "muted",
          `Source: ${plain(monitor.ledger?.sourceId ?? "None").slice(0, 120)} • Task: ${plain(task?.text ?? "Unknown").slice(0, 160)}`,
        ),
        theme.fg(
          "muted",
          `${monitor.activity} • Refresh ${monitor.interval}s${monitor.error ? ` • ${monitor.error}` : ""}`,
        ),
        ...(monitor.ledger?.kind === "conversation"
          ? [
              theme.fg(
                "muted",
                plain(
                  `${monitor.conversation.reportStatus} • ${monitor.consent ? monitor.gateway.status : "Disabled: consent required"}`,
                ).slice(0, 240),
              ),
            ]
          : []),
        ...signals(monitor).map((line) => theme.fg("muted", plain(line))),
      ];
      return lines.flatMap(
        (line) => truncateToVisualLines(line, 2, width, 0).visualLines,
      );
    },
    invalidate() {},
  }));
}
export async function details(ctx: ExtensionContext, monitor: Monitor) {
  if (!ctx.hasUI) return;
  const ledger = monitor.ledger;
  const selectedSource = monitor.source;
  const snapshot = monitor.health?.snapshot ?? monitor.snapshot();
  const lines = [
    "Reported completion only; not verified correctness.",
    `Source: ${monitor.source?.kind === "conversation" ? `Conversation entry ${plain(monitor.source.entryId)}` : monitor.source ? plain(`${monitor.source.path}${monitor.source.section ? `#${monitor.source.section}` : ""}`) : "None"}`,
    `Refresh: ${monitor.interval}s • ${monitor.activity}`,
    monitor.error ??
      "File markers or interpreted explicit conversation reports determine counts; health never changes ledger.",
    monitor.conversation.discoveryStatus,
    monitor.conversation.reportStatus,
    `Trajectory omissions: ${monitor.conversation.omissions.join("; ")}`,
    `Conversation source refs: ${JSON.stringify(monitor.source?.kind === "conversation" ? monitor.source : undefined)}`,
    `Original selected source: ${plain(selectedSource?.kind === "conversation" ? (monitor.conversation.trajectory.messages.find((m) => m.id === selectedSource.entryId)?.text ?? "Original unavailable") : "See selected file")}`,
    `Discovery model/questions/evidence/raw answers: ${plain(JSON.stringify(monitor.conversation.discoveryEvidence))}`,
    `Report model/questions/original evidence/raw answers: ${plain(JSON.stringify(monitor.conversation.reportEvidence))}`,
    `Report cursor / latest status proofs: ${JSON.stringify(monitor.ledger?.kind === "conversation" ? monitor.conversation.checkpoint(monitor.ledger) : undefined)}`,
    ...signals(monitor),
    "Health rubric v1 • experimental • not verified correctness or proof tests exist/pass.",
    ...(monitor.health
      ? [
          `Model: ${monitor.health.result.model} • evidence observed ${new Date(monitor.health.snapshot.observedAt).toISOString()} • inference as-of ${new Date(monitor.health.evaluatedAt).toISOString()}`,
          `Raw answers (legend, probabilities, confidence): ${plain(JSON.stringify(monitor.health.result.answers))}`,
          `Usage: ${JSON.stringify(monitor.health.result.usage)}`,
        ]
      : [
          "No validated health response. Current task and essential evidence required; no hidden default task.",
        ]),
    ...(snapshot
      ? [
          `Payload model: ${snapshot.request.model} • evidence observed ${new Date(snapshot.observedAt).toISOString()}`,
          `Raw questions: ${plain(JSON.stringify(snapshot.request.questions))}`,
          `Evidence: ${plain(JSON.stringify(snapshot.request.state))}`,
          `Omissions: ${snapshot.omissions.join("; ")}`,
        ]
      : [
          "Essential coverage unavailable or payload exceeds 24 KiB; no evidence truncated or sent.",
        ]),
    `Current task: ${plain(ledger?.tasks.find((task) => task.id === ledger.currentTaskId)?.text ?? "Unknown")}`,
    ...(ledger?.tasks.map(
      (task, i) =>
        `${i + 1}. ${task.included ? "Included" : "Excluded"} • ${task.status} • ${plain(task.text)}`,
    ) ?? []),
  ];
  const labels = lines.map(
    (line, i) =>
      `${i + 1}. ${line.slice(0, 240)}${line.length > 240 ? " … (select for full evidence)" : ""}`,
  );
  const choice = await ctx.ui.select("Progress details (read-only)", labels);
  if (!choice) return;
  const full = lines[labels.indexOf(choice)];
  if (!full || full.length <= 240) return;
  const pages = Array.from(
    { length: Math.ceil(full.length / 12000) },
    (_, i) => `Evidence page ${i + 1}`,
  );
  const page = await ctx.ui.select("Full raw evidence (read-only)", pages);
  if (!page) return;
  const offset = pages.indexOf(page) * 12000;
  if (offset < 0) return;
  const text = full.slice(offset, offset + 12000);
  await ctx.ui.select(
    "Raw evidence; display escapes sanitized",
    text.match(/[\s\S]{1,240}/g) ?? [],
  );
}
