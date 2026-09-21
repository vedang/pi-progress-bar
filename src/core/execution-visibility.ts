import {
  buildLabelCandidates,
  type LabelBindings,
  type LabelCandidateBundle,
  type LabelSelections,
  type VisibilityTask,
} from "../analysis/activity-label";

const MAX_ACTIONS = 48;
const MAX_ACTIONS_PER_TASK = 16;
const MAX_LIVE_SOURCES = 8;
const MAX_DEDUPE = 256;
const VISIBILITY_BUDGET = 1024;
const CURRENT_FRESHNESS_MS = 5_000;
const MIN_CONFIDENCE = 0.5;
const MIN_PROBABILITY = 0.8;

type Candidate = LabelCandidateBundle["candidates"][number];
type SelectedLabel = NonNullable<LabelSelections["current"]>;
type LabelBinding = NonNullable<LabelBindings["current"]>;

export type VisibilityToolPhase =
  | "Inspecting code"
  | "Editing code"
  | "Running test command"
  | "Running build command"
  | "Review in progress"
  | "Using a tool";

export interface VisibilityUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  lastCallAt?: number;
}

export interface VisibilityCurrent {
  kind: "reported" | "tool";
  text: string;
  provisional?: boolean;
  task?: VisibilityTask;
}

export interface VisibilityAction {
  id: string;
  order: number;
  task: VisibilityTask;
  candidate: Candidate;
}

export interface ExecutionVisibilitySnapshot {
  generation: number;
  coverage: "since-monitoring-resumed" | "incomplete";
  current?: VisibilityCurrent;
  actions: VisibilityAction[];
  usage: VisibilityUsage;
  budgetRemaining: number;
}

interface Source {
  bundle: LabelCandidateBundle;
  ingressAt: number;
  order: number;
  runId?: number;
  confirmed: boolean;
  selections: LabelSelections;
}

interface ToolActivity {
  phase: VisibilityToolPhase;
  order: number;
}

export interface ExecutionVisibilityStoreOptions {
  now?: () => number;
}

const phases = new Set<VisibilityToolPhase>([
  "Inspecting code",
  "Editing code",
  "Running test command",
  "Running build command",
  "Review in progress",
  "Using a tool",
]);

const digest = /^[a-f0-9]{64}$/;
const cloneTask = (task: VisibilityTask): VisibilityTask => ({ ...task });
const cloneCandidate = (candidate: Candidate): Candidate => ({ ...candidate });
const cloneBundle = (bundle: LabelCandidateBundle): LabelCandidateBundle => ({
  liveToken: bundle.liveToken,
  messageHash: bundle.messageHash,
  text: bundle.text,
  candidates: bundle.candidates.map(cloneCandidate),
});
const cloneCurrent = (current: VisibilityCurrent): VisibilityCurrent => ({
  ...current,
  ...(current.task ? { task: cloneTask(current.task) } : {}),
});
const cloneAction = (action: VisibilityAction): VisibilityAction => ({
  ...action,
  task: cloneTask(action.task),
  candidate: cloneCandidate(action.candidate),
});

const validNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const validAssessment = (
  value: unknown,
  choice: string,
): value is { choice: string; confidence: number; probability: number } => {
  if (!value || typeof value !== "object") return false;
  const assessment = value as {
    choice?: unknown;
    confidence?: unknown;
    probability?: unknown;
  };
  return (
    assessment.choice === choice &&
    validNumber(assessment.confidence) &&
    assessment.confidence >= MIN_CONFIDENCE &&
    assessment.confidence <= 1 &&
    validNumber(assessment.probability) &&
    assessment.probability >= MIN_PROBABILITY &&
    assessment.probability <= 1
  );
};

const sameCandidate = (left: Candidate, right: unknown): right is Candidate => {
  if (!right || typeof right !== "object") return false;
  const candidate = right as Partial<Candidate>;
  return (
    candidate.id === left.id &&
    candidate.liveToken === left.liveToken &&
    candidate.messageHash === left.messageHash &&
    candidate.start === left.start &&
    candidate.end === left.end &&
    candidate.quote === left.quote &&
    candidate.quoteHash === left.quoteHash
  );
};

const sameSelected = (left: SelectedLabel, right: unknown) => {
  if (!sameCandidate(left, right)) return false;
  const selected = right as Partial<SelectedLabel>;
  return (
    selected.assessment?.choice === left.assessment.choice &&
    selected.assessment?.confidence === left.assessment.confidence &&
    selected.assessment?.probability === left.assessment.probability
  );
};

const sameTask = (
  left: VisibilityTask,
  right: unknown,
): right is VisibilityTask => {
  if (!right || typeof right !== "object") return false;
  const task = right as Partial<VisibilityTask>;
  return (
    task.id === left.id &&
    task.label === left.label &&
    task.revision === left.revision &&
    task.sourceDigest === left.sourceDigest
  );
};

const validTask = (task: unknown): task is VisibilityTask => {
  if (!task || typeof task !== "object") return false;
  const value = task as Partial<VisibilityTask>;
  return (
    typeof value.id === "string" &&
    !!value.id &&
    typeof value.label === "string" &&
    !!value.label &&
    Number.isSafeInteger(value.revision) &&
    (value.revision ?? -1) >= 0 &&
    typeof value.sourceDigest === "string" &&
    digest.test(value.sourceDigest)
  );
};

/**
 * Volatile execution-visibility reducer. It records reported activity only;
 * no method changes semantic task state, persists data, or dispatches a model.
 */
export class ExecutionVisibilityStore {
  private readonly now: () => number;
  private generation = 0;
  private runSequence = 0;
  private activeRunId: number | undefined;
  private sourceSequence = 0;
  private actionSequence = 0;
  private coverage: ExecutionVisibilitySnapshot["coverage"] =
    "since-monitoring-resumed";
  private sources = new Map<string, Source>();
  private latestToken: string | undefined;
  private reportedCurrent:
    | { token: string; current: VisibilityCurrent }
    | undefined;
  private tools = new Map<string, ToolActivity>();
  private toolSequence = 0;
  private actions: VisibilityAction[] = [];
  private dedupe: string[] = [];
  private readonly dedupeSet = new Set<string>();
  private usage: VisibilityUsage = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  constructor(options: ExecutionVisibilityStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Begin a logical agent run while retaining prior canonically confirmed history. */
  startRun(): void {
    this.activeRunId = ++this.runSequence;
    this.reportedCurrent = undefined;
    if (this.tools.size) this.coverage = "incomplete";
    this.tools.clear();
  }

  /** Clear current activity at settlement; canonical report history may still arrive. */
  settle(): void {
    this.activeRunId = undefined;
    this.reportedCurrent = undefined;
    if (this.tools.size) this.coverage = "incomplete";
    this.tools.clear();
  }

  /** Drop the complete runtime lifetime and fence all previously issued source tokens. */
  reset(): void {
    this.generation++;
    this.activeRunId = undefined;
    this.sources.clear();
    this.latestToken = undefined;
    this.reportedCurrent = undefined;
    this.tools.clear();
    this.actions = [];
    this.dedupe = [];
    this.dedupeSet.clear();
    this.usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
    this.coverage = "since-monitoring-resumed";
  }

  /** Capture a bounded, lossless provisional assistant report. */
  capture(text: string): LabelCandidateBundle | undefined {
    const liveToken = `visibility:${this.generation}:${++this.sourceSequence}`;
    const bundle = buildLabelCandidates(text, liveToken);
    if (!bundle) {
      this.coverage = "incomplete";
      return;
    }
    const stored = cloneBundle(bundle);
    this.sources.set(liveToken, {
      bundle: stored,
      ingressAt: this.now(),
      order: this.sourceSequence,
      runId: this.activeRunId,
      confirmed: false,
      selections: {},
    });
    this.latestToken = liveToken;
    this.reportedCurrent = undefined;
    while (this.sources.size > MAX_LIVE_SOURCES) {
      const oldest = this.sources.keys().next().value as string | undefined;
      if (!oldest) break;
      this.sources.delete(oldest);
      this.coverage = "incomplete";
    }
    return cloneBundle(stored);
  }

  /** Confirm exact canonical source text; mismatch irreversibly invalidates it. */
  confirm(token: string, text: string): boolean {
    const source = this.source(token);
    if (!source) return false;
    if (source.bundle.text !== text) {
      this.sources.delete(token);
      if (this.latestToken === token) {
        this.latestToken = undefined;
        this.reportedCurrent = undefined;
      }
      this.coverage = "incomplete";
      return false;
    }
    source.confirmed = true;
    if (this.reportedCurrent?.token === token)
      this.reportedCurrent.current.provisional = false;
    return true;
  }

  /** Admit only exact stored stage-1 selections. */
  acceptSelections(token: string, selections: LabelSelections): void {
    const source = this.source(token);
    if (!source) return;
    const current = this.selection(source, selections?.current);
    const history = this.selection(source, selections?.history);
    source.selections = {
      ...(current ? { current } : {}),
      ...(history ? { history } : {}),
    };
    if (
      !current ||
      this.activeRunId === undefined ||
      source.runId !== this.activeRunId ||
      this.latestToken !== token
    )
      return;
    if (this.now() - source.ingressAt > CURRENT_FRESHNESS_MS) {
      this.coverage = "incomplete";
      return;
    }
    this.reportedCurrent = {
      token,
      current: {
        kind: "reported",
        text: current.quote,
        provisional: !source.confirmed,
      },
    };
  }

  /**
   * Admit exact stored stage-2 bindings against the current full task identity.
   * Only a canonical history receipt can append an action.
   */
  acceptBindings(
    token: string,
    bindings: LabelBindings,
    currentTasks: readonly VisibilityTask[],
  ): void {
    const source = this.source(token);
    if (!source) return;
    const tasks = this.tasks(currentTasks);
    if (!tasks) {
      this.coverage = "incomplete";
      return;
    }
    const current = this.binding(source, "current", bindings?.current, tasks);
    const history = this.binding(source, "history", bindings?.history, tasks);
    if (
      current &&
      this.activeRunId !== undefined &&
      source.runId === this.activeRunId &&
      this.latestToken === token
    ) {
      if (this.now() - source.ingressAt > CURRENT_FRESHNESS_MS) {
        this.coverage = "incomplete";
      } else {
        this.reportedCurrent = {
          token,
          current: {
            kind: "reported",
            text: current.candidate.quote,
            provisional: !source.confirmed,
            ...(source.confirmed ? { task: cloneTask(current.task) } : {}),
          },
        };
      }
    }
    if (!source.confirmed || !history) return;
    this.appendHistory(source, history);
  }

  /** Publish one finite unattributed phase. Raw host IDs never enter snapshots. */
  toolStart(callId: string, phase: VisibilityToolPhase): void {
    if (typeof callId !== "string" || !callId || !phases.has(phase)) return;
    const existing = this.tools.get(callId);
    this.tools.set(callId, {
      phase,
      order: existing?.order ?? ++this.toolSequence,
    });
  }

  /** Remove only the matching finite phase; tool-only work cannot become history. */
  toolEnd(callId: string): void {
    if (!this.tools.delete(callId)) return;
    this.coverage = "incomplete";
  }

  /** Reserve one independent visibility provider dispatch. */
  recordDispatch(): boolean {
    if (this.usage.calls >= VISIBILITY_BUDGET) {
      this.coverage = "incomplete";
      return false;
    }
    this.usage.calls++;
    this.usage.lastCallAt = this.now();
    return true;
  }

  /** Record accepted response token use separately from existing monitor telemetry. */
  recordUsage(usage: { input_tokens: number; output_tokens: number }): void {
    if (validNumber(usage?.input_tokens) && usage.input_tokens >= 0)
      this.usage.inputTokens += usage.input_tokens;
    if (validNumber(usage?.output_tokens) && usage.output_tokens >= 0)
      this.usage.outputTokens += usage.output_tokens;
  }

  snapshot(): ExecutionVisibilitySnapshot {
    const tool = [...this.tools.values()].reduce<ToolActivity | undefined>(
      (latest, activity) =>
        !latest || activity.order > latest.order ? activity : latest,
      undefined,
    );
    const current = tool
      ? { kind: "tool" as const, text: tool.phase }
      : this.reportedCurrent?.current;
    return {
      generation: this.generation,
      coverage: this.coverage,
      ...(current ? { current: cloneCurrent(current) } : {}),
      actions: this.actions.map(cloneAction),
      usage: { ...this.usage },
      budgetRemaining: VISIBILITY_BUDGET - this.usage.calls,
    };
  }

  private source(token: string): Source | undefined {
    const source = this.sources.get(token);
    if (source) return source;
    if (token.startsWith(`visibility:${this.generation}:`))
      this.coverage = "incomplete";
    return;
  }

  private selection(source: Source, value: unknown): SelectedLabel | undefined {
    if (!value || typeof value !== "object") return;
    const selected = value as SelectedLabel;
    const candidate = source.bundle.candidates.find((entry) =>
      sameCandidate(entry, selected),
    );
    if (!candidate || !validAssessment(selected.assessment, candidate.id))
      return;
    return {
      ...cloneCandidate(candidate),
      assessment: { ...selected.assessment },
    };
  }

  private tasks(
    tasks: readonly VisibilityTask[],
  ): readonly VisibilityTask[] | undefined {
    if (
      !Array.isArray(tasks) ||
      !tasks.length ||
      tasks.length > 20 ||
      !tasks.every(validTask) ||
      new Set(tasks.map((task) => task.id)).size !== tasks.length
    )
      return;
    return tasks;
  }

  private binding(
    source: Source,
    kind: "current" | "history",
    value: unknown,
    tasks: readonly VisibilityTask[],
  ): LabelBinding | undefined {
    if (!value || typeof value !== "object") return;
    const binding = value as LabelBinding;
    const candidate = this.selection(source, binding.candidate);
    if (!candidate) return;
    const prior = source.selections[kind];
    if (prior && !sameSelected(prior, binding.candidate)) return;
    const task = tasks.find((entry) => sameTask(entry, binding.task));
    if (!task || !validAssessment(binding.assessment, task.id)) return;
    return {
      candidate,
      task: cloneTask(task),
      assessment: { ...binding.assessment },
    };
  }

  private appendHistory(source: Source, binding: LabelBinding): void {
    const key = [
      source.bundle.liveToken,
      binding.candidate.quoteHash,
      binding.task.id,
      binding.task.revision,
      binding.task.sourceDigest,
    ].join(":");
    if (this.dedupeSet.has(key)) return;
    const perTask = this.actions.filter(
      (action) => action.task.id === binding.task.id,
    );
    if (perTask.length >= MAX_ACTIONS_PER_TASK) {
      const oldest = [...this.actions]
        .reverse()
        .find((action) => action.task.id === binding.task.id);
      if (oldest)
        this.actions = this.actions.filter((action) => action !== oldest);
      this.coverage = "incomplete";
    }
    if (this.actions.length >= MAX_ACTIONS) {
      this.actions.pop();
      this.coverage = "incomplete";
    }
    this.actions.unshift({
      id: `visibility-action:${this.generation}:${++this.actionSequence}`,
      order: this.actionSequence,
      task: cloneTask(binding.task),
      candidate: cloneCandidate(binding.candidate),
    });
    this.dedupeSet.add(key);
    this.dedupe.push(key);
    if (this.dedupe.length > MAX_DEDUPE) {
      const oldest = this.dedupe.shift();
      if (oldest) this.dedupeSet.delete(oldest);
    }
  }
}
