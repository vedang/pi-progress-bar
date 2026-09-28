import type {
  SubtaskOmissionReason,
  SubtaskOmissionSummary,
} from "./hybrid-checkpoint";

const MAX_SUBTASK_OMISSIONS = 64; // [ref:subtask_omission_summary]

type SubtaskOmissionEntry = Readonly<SubtaskOmissionSummary["entries"][number]>;
type ReadonlySubtaskOmissionSummary = Readonly<SubtaskOmissionSummary>;
type SummaryResult = {
  summary: SubtaskOmissionSummary;
  changed: boolean;
};
type MergeResult = {
  summary: SubtaskOmissionSummary | undefined;
  changed: boolean;
};

const copySummary = (
  summary: ReadonlySubtaskOmissionSummary,
): SubtaskOmissionSummary => ({
  entries: summary.entries.map(({ identity, reason }) => ({
    identity,
    reason,
  })),
  saturated: summary.saturated,
});

const sameSummary = (
  candidate: SubtaskOmissionSummary,
  live: ReadonlySubtaskOmissionSummary | undefined,
) =>
  live !== undefined &&
  candidate.saturated === live.saturated &&
  candidate.entries.length === live.entries.length &&
  candidate.entries.every(
    (entry, index) =>
      entry.identity === live.entries[index]?.identity &&
      entry.reason === live.entries[index]?.reason,
  );

const result = (
  summary: SubtaskOmissionSummary,
  live: ReadonlySubtaskOmissionSummary | undefined,
): SummaryResult => ({ summary, changed: !sameSummary(summary, live) });

/** Append an internally constructed omission without evicting durable detail. */
export const appendSubtaskOmission = (
  live: ReadonlySubtaskOmissionSummary | undefined,
  entry: SubtaskOmissionEntry,
): SummaryResult => {
  const summary = live ? copySummary(live) : { entries: [], saturated: false };
  if (
    summary.saturated ||
    summary.entries.some(({ identity }) => identity === entry.identity)
  )
    return result(summary, live);
  if (summary.entries.length === MAX_SUBTASK_OMISSIONS)
    summary.saturated = true;
  else summary.entries.push({ identity: entry.identity, reason: entry.reason });
  return result(summary, live);
};

/** Produce smallest candidate that marks retained omission detail incomplete. */
export const saturateSubtaskOmissions = (
  live: ReadonlySubtaskOmissionSummary | undefined,
): SummaryResult => {
  const summary = live ? copySummary(live) : { entries: [], saturated: false };
  summary.saturated = true;
  return result(summary, live);
};

/** Merge same-session durable summaries, preserving live entry order and reasons. */
export const mergeSubtaskOmissions = (
  live: ReadonlySubtaskOmissionSummary | undefined,
  incoming: ReadonlySubtaskOmissionSummary | undefined,
): MergeResult => {
  if (!live && !incoming) return { summary: undefined, changed: false };

  const entries: SubtaskOmissionSummary["entries"] = [];
  const identities = new Set<string>();
  let truncated = false;
  for (const summary of [live, incoming]) {
    for (const entry of summary?.entries ?? []) {
      if (identities.has(entry.identity)) continue;
      identities.add(entry.identity);
      if (entries.length === MAX_SUBTASK_OMISSIONS) {
        truncated = true;
        continue;
      }
      entries.push({ identity: entry.identity, reason: entry.reason });
    }
  }
  const summary = {
    entries,
    saturated: Boolean(live?.saturated || incoming?.saturated || truncated),
  };
  return { summary, changed: !sameSummary(summary, live) };
};

/** Expose detached bounded diagnostic counts without durable identities. */
export const projectSubtaskOmissions = (
  summary: ReadonlySubtaskOmissionSummary | undefined,
) => {
  const byReason: Record<SubtaskOmissionReason, number> = {
    "report-oversized": 0,
    coalesced: 0,
    capacity: 0,
  };
  for (const entry of summary?.entries ?? []) byReason[entry.reason] += 1;
  return {
    total: summary?.entries.length ?? 0,
    byReason,
    saturated: summary?.saturated ?? false,
  };
};
