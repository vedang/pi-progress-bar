/** Local rendering only; timestamp comes from actual gateway dispatch. */
export function lastJevCallLabel(
  dispatchedAt: number | undefined,
  now = Date.now(),
): string {
  if (
    typeof dispatchedAt !== "number" ||
    !Number.isFinite(dispatchedAt) ||
    dispatchedAt < 0
  )
    return "Never";
  const date = new Date(dispatchedAt);
  const elapsed = Math.max(0, now - dispatchedAt);
  const age =
    elapsed < 60_000
      ? "just now"
      : elapsed < 3_600_000
        ? `${Math.floor(elapsed / 60_000)}m ago`
        : elapsed < 86_400_000
          ? `${Math.floor(elapsed / 3_600_000)}h ago`
          : `${Math.floor(elapsed / 86_400_000)}d ago`;
  const localDate = date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const localTime = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return `${localDate} ${localTime} (${age})`;
}

/** `Current` was an opaque accepted-result status, not freshness information. */
export function gatewayStatusLabel(status: string): string {
  return status === "Current" ? "Jev ready" : status;
}
