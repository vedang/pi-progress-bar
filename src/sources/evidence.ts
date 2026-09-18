export interface EvidenceLink {
  sourceId: string;
  taskId: string;
  taskRevision: string;
  scopeRevision: string;
}
interface PendingCall {
  callId: string;
  toolName: string;
  args: unknown;
  order: number;
  entryId?: string;
  link?: EvidenceLink;
}
export interface PassiveEvidence {
  kind: "observed-red" | "code-change" | "test-pass";
  callId: string;
  toolName: string;
  order: number;
  entryId?: string;
  /** Bound at tool start to the current source/task/revision. */
  link?: EvidenceLink;
  summary: string;
  revision: number;
}
interface ToolResult {
  content?: unknown;
  details?: unknown;
  isError?: boolean;
  excludeFromContext?: boolean;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const textContent = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .filter(record)
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n")
        .slice(0, 32 * 1024)
    : "";
const commandOf = (args: unknown) =>
  record(args) && typeof args.command === "string" ? args.command : "";
const pathOf = (args: unknown) =>
  record(args) && typeof args.path === "string" ? args.path : "";
const testCommand = (command: string) =>
  !/[;&|`$()<>\n\r]/.test(command) &&
  /^(?:(?:bun|npm|pnpm|yarn)\s+test|npx\s+(?:vitest|jest|mocha)|(?:uv\s+run\s+|python(?:3)?\s+-m\s+)?pytest|cargo\s+test|go\s+test)(?:\s|$)/i.test(
    command.trim(),
  );
const assertionFailure = (output: string) =>
  /(?:AssertionError|assertion failed|\bFAIL(?:ED)?\b.*(?:test|spec)|expected[\s\S]{0,200}(?:received|to be|but got))/i.test(
    output,
  );

/** Live main-session tool fact adapter; never executes or reads missing evidence. */
export class EvidenceStore {
  private pending = new Map<string, PendingCall>();
  private facts: PassiveEvidence[] = [];
  private revision = 0;

  start(
    callId: string,
    toolName: string,
    args: unknown,
    order: number,
    entryId?: string,
    link?: EvidenceLink,
  ) {
    if (!callId || this.pending.has(callId)) return;
    if (!["bash", "edit", "write"].includes(toolName)) return;
    this.pending.set(callId, {
      callId,
      toolName,
      args,
      order,
      entryId,
      ...(link ? { link: { ...link } } : {}),
    });
  }

  finish(callId: string, toolName: string, result: ToolResult, order: number) {
    const call = this.pending.get(callId);
    this.pending.delete(callId);
    if (
      !call ||
      call.toolName !== toolName ||
      order < call.order ||
      result.excludeFromContext
    )
      return;
    const output = textContent(result.content);
    if (toolName === "bash" && testCommand(commandOf(call.args))) {
      if (assertionFailure(output))
        this.push({
          kind: "observed-red",
          callId,
          toolName,
          order,
          ...(call.entryId ? { entryId: call.entryId } : {}),
          ...(call.link ? { link: { ...call.link } } : {}),
          summary:
            output
              .match(
                /[^\n]*(?:AssertionError|assertion failed|FAIL)[^\n]*/i,
              )?.[0]
              ?.slice(0, 500) ?? "assertion failure",
          revision: this.revision,
        });
      else if (!result.isError && /(?:pass|ok|success)/i.test(output))
        this.push({
          kind: "test-pass",
          callId,
          toolName,
          order,
          ...(call.entryId ? { entryId: call.entryId } : {}),
          ...(call.link ? { link: { ...call.link } } : {}),
          summary: output.slice(0, 500),
          revision: this.revision,
        });
      return;
    }
    if ((toolName === "edit" || toolName === "write") && !result.isError) {
      this.revision++;
      this.push({
        kind: "code-change",
        callId,
        toolName,
        order,
        ...(call.entryId ? { entryId: call.entryId } : {}),
        ...(call.link ? { link: { ...call.link } } : {}),
        summary: pathOf(call.args).slice(0, 500) || "bounded file mutation",
        revision: this.revision,
      });
    }
  }

  private push(evidence: PassiveEvidence) {
    this.facts.push(evidence);
    this.facts = this.facts.slice(-100);
  }

  redObservation(link?: EvidenceLink) {
    return [...this.facts]
      .reverse()
      .find(
        (item) =>
          item.kind === "observed-red" &&
          item.revision === this.revision &&
          (!link ||
            (item.link?.sourceId === link.sourceId &&
              item.link.taskId === link.taskId &&
              item.link.taskRevision === link.taskRevision &&
              item.link.scopeRevision === link.scopeRevision)),
      );
  }

  snapshot(link?: EvidenceLink) {
    return this.facts
      .filter(
        (item) =>
          !link ||
          (item.link?.sourceId === link.sourceId &&
            item.link.taskId === link.taskId &&
            item.link.taskRevision === link.taskRevision &&
            item.link.scopeRevision === link.scopeRevision),
      )
      .map((item) => ({
        ...item,
        ...(item.link ? { link: { ...item.link } } : {}),
      }));
  }

  codeRevision() {
    return this.revision;
  }

  clearPending() {
    this.pending.clear();
  }

  reset() {
    this.pending.clear();
    this.facts = [];
    this.revision = 0;
  }
}

export function redEvidenceLabel(input: {
  applicability?: "needed" | "not-needed" | "unknown";
  reported: boolean;
  observed?: PassiveEvidence;
  contradiction?: boolean;
}): string {
  if (input.contradiction) return "Contradictory";
  if (input.observed?.kind === "observed-red") return "Observed red";
  if (input.reported) return "Reported red";
  if (input.applicability === "not-needed") return "Not needed";
  return "Unknown";
}
