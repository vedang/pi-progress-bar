import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { type BoardLayout, layoutBoard } from "./layout";
import {
  lifecycleTone,
  sanitizeTerminalText,
  type WidgetSnapshot,
} from "./widget";

type BoardTask = WidgetSnapshot["board"]["tasks"][number];
type VisibilitySnapshot = NonNullable<WidgetSnapshot["visibility"]>;
type VisibilityAction = VisibilitySnapshot["actions"][number];

type DetailValue = {
  text: string;
  provenance?: {
    role?: unknown;
    validatedAt?: unknown;
    confidence?: unknown;
    probability?: unknown;
  };
};

interface BoardViewState {
  selectedId?: string;
  listOffset: number;
  detailOffset: number;
  debugger: boolean;
  pane: "list" | "detail";
}

interface ActionAnchor {
  id: string;
  order: number;
  lineOffset: number;
}

export interface BoardOptions {
  theme: Theme;
  screenRows(): number;
  isFocused(): boolean;
  onClose(): void;
  requestRender(): void;
}

export interface BoardComponent extends Component {
  handleInput(data: string): void;
  update(snapshot: WidgetSnapshot): void;
  dispose(): void;
  viewState(): BoardViewState;
}

const clone = (snapshot: WidgetSnapshot): WidgetSnapshot =>
  structuredClone(snapshot);

const time = (value: number | undefined) => {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toISOString().slice(11, 19)
    : undefined;
};

/** Pure board component over copied monitor projections. */
class TaskBoard implements BoardComponent {
  private snapshot: WidgetSnapshot;
  private selectedId: string | undefined;
  private selectedIndex = 0;
  private listOffset = 0;
  private detailOffset = 0;
  /** Stable action + wrapped-line position while the user scrolls history. */
  private actionAnchor: ActionAnchor | undefined;
  private actionAnchorGap = false;
  private debugger = false;
  private pane: "list" | "detail" = "list";
  private disposed = false;
  private lastLayout: BoardLayout;

  constructor(
    initial: WidgetSnapshot,
    private readonly options: BoardOptions,
  ) {
    this.snapshot = clone(initial);
    this.lastLayout = layoutBoard(80, options.screenRows());
    this.selectDefault();
  }

  update(next: WidgetSnapshot): void {
    if (this.disposed) return;
    const previousIndex = this.selectedIndex;
    const previousId = this.selectedId;
    const anchor = this.captureActionAnchor() ?? this.actionAnchor;
    this.snapshot = clone(next);
    const tasks = this.tasks();
    const currentIndex = previousId
      ? tasks.findIndex((task) => task.taskId === previousId)
      : -1;
    if (currentIndex >= 0) {
      this.selectedIndex = currentIndex;
      this.selectedId = tasks[currentIndex]?.taskId;
    } else if (tasks.length) {
      // Preserve the deleted task's visual slot when its stable ID disappears.
      this.selectedIndex = Math.min(previousIndex, tasks.length - 1);
      this.selectedId = tasks[this.selectedIndex]?.taskId;
      if (!previousId) this.selectDefault();
      this.resetActionAnchor();
    } else {
      this.selectedId = undefined;
      this.selectedIndex = 0;
      this.listOffset = 0;
      this.resetActionAnchor();
    }
    if (previousId !== this.selectedId) this.resetActionAnchor();
    else if (anchor) this.restoreActionAnchor(anchor);
    this.clampOffsets(this.lastLayout);
    this.options.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.selectedId = undefined;
  }

  viewState(): BoardViewState {
    return {
      ...(this.selectedId ? { selectedId: this.selectedId } : {}),
      listOffset: this.listOffset,
      detailOffset: this.detailOffset,
      debugger: this.debugger,
      pane: this.pane,
    };
  }

  invalidate(): void {
    // Output is rebuilt every render, so a theme invalidation needs no cache work.
  }

  handleInput(data: string): void {
    if (this.disposed || isKeyRelease(data) || !this.options.isFocused())
      return;
    if (matchesKey(data, "escape")) {
      this.disposed = true;
      this.options.onClose();
      return;
    }
    if (matchesKey(data, "tab")) {
      this.pane = this.pane === "list" ? "detail" : "list";
      this.requestRender();
      return;
    }
    if (matchesKey(data, "left")) {
      if (this.pane !== "list") {
        this.pane = "list";
        this.requestRender();
      }
      return;
    }
    if (matchesKey(data, "right")) {
      if (this.pane !== "detail") {
        this.pane = "detail";
        this.requestRender();
      }
      return;
    }
    if (matchesKey(data, "d") && this.selected()) {
      this.debugger = !this.debugger;
      this.detailOffset = 0;
      this.clampOffsets(this.lastLayout);
      this.requestRender();
      return;
    }
    if (this.pane === "detail") {
      this.handleDetailInput(data);
      return;
    }
    this.handleListInput(data);
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    const layout = layoutBoard(width, this.options.screenRows());
    this.lastLayout = layout;
    this.clampOffsets(layout);
    if (layout.height === 0) return [];
    if (!layout.usable)
      return this.limitRows(
        [
          this.formatLine(
            "Board too small — resize terminal",
            layout.width,
            "warning",
          ),
          this.formatLine("Esc: close", layout.width, "dim"),
        ],
        layout,
      );
    if (!this.selected()) return this.renderEmpty(layout);
    return this.renderTask(layout);
  }

  private tasks(): readonly BoardTask[] {
    return this.snapshot.board.tasks;
  }

  private selected(): BoardTask | undefined {
    return this.selectedId
      ? this.tasks().find((task) => task.taskId === this.selectedId)
      : undefined;
  }

  private selectDefault(): void {
    const tasks = this.tasks();
    if (!tasks.length) {
      this.selectedId = undefined;
      this.selectedIndex = 0;
      return;
    }
    const displayed = this.snapshot.board.currentTask?.taskId;
    const index = displayed
      ? tasks.findIndex((task) => task.taskId === displayed)
      : -1;
    this.selectedIndex = index >= 0 ? index : 0;
    this.selectedId = tasks[this.selectedIndex]?.taskId;
  }

  private requestRender(): void {
    if (!this.disposed) this.options.requestRender();
  }

  private handleListInput(data: string): void {
    const tasks = this.tasks();
    if (!tasks.length) return;
    let next = this.selectedIndex;
    const page = this.listPage(this.lastLayout);
    if (matchesKey(data, "up")) next--;
    else if (matchesKey(data, "down")) next++;
    else if (matchesKey(data, "pageUp")) next -= page;
    else if (matchesKey(data, "pageDown")) next += page;
    else if (matchesKey(data, "home")) next = 0;
    else if (matchesKey(data, "end")) next = tasks.length - 1;
    else return;
    next = Math.max(0, Math.min(next, tasks.length - 1));
    if (next === this.selectedIndex) return;
    this.selectedIndex = next;
    this.selectedId = tasks[next]?.taskId;
    this.resetActionAnchor();
    this.clampOffsets(this.lastLayout);
    this.requestRender();
  }

  private handleDetailInput(data: string): void {
    const maximum = this.detailMaximum(this.lastLayout);
    const page = Math.max(1, this.detailCapacity(this.lastLayout));
    let next = this.detailOffset;
    if (matchesKey(data, "up")) next--;
    else if (matchesKey(data, "down")) next++;
    else if (matchesKey(data, "pageUp")) next -= page;
    else if (matchesKey(data, "pageDown")) next += page;
    else if (matchesKey(data, "home")) next = 0;
    else if (matchesKey(data, "end")) next = maximum;
    else return;
    next = Math.max(0, Math.min(next, maximum));
    if (next === this.detailOffset) return;
    this.detailOffset = next;
    this.actionAnchor = this.captureActionAnchor();
    this.requestRender();
  }

  private renderEmpty(layout: BoardLayout): string[] {
    const left = ["Tasks 0 retained", "No retained tasks"];
    const right = [
      ...this.wrapLines("No retained tasks to inspect", layout.rightWidth),
      ...this.wrapLines(
        `Service: ${this.snapshot.board.service.label}`,
        layout.rightWidth,
      ),
    ];
    return this.compose(left, right, layout);
  }

  private renderTask(layout: BoardLayout): string[] {
    const task = this.selected();
    if (!task) return this.renderEmpty(layout);
    const leftRows = Math.max(1, layout.contentRows - 1);
    const left = [
      `Tasks ${this.tasks().length} retained`,
      ...this.tasks()
        .slice(this.listOffset, this.listOffset + leftRows)
        .map((item) =>
          this.taskLine(item, layout.leftWidth, item.taskId === task.taskId),
        ),
    ];
    const detail = this.detailLines(task, layout);
    return this.compose(left, detail, layout);
  }

  private detailLines(task: BoardTask, layout: BoardLayout): string[] {
    const { pinned, body } = this.detailContent(task, layout);
    const capacity = Math.max(1, layout.contentRows - pinned.length);
    const maximum = Math.max(0, body.length - capacity);
    this.detailOffset = Math.max(0, Math.min(this.detailOffset, maximum));
    return [
      ...pinned,
      ...body.slice(this.detailOffset, this.detailOffset + capacity),
    ];
  }

  /**
   * Each service/health value has one rendering owner. On roomy panes it is a
   * complete pinned Summary row. On tight panes only its heading is pinned and
   * its wrapped continuation becomes scrollable; duplicating values is never a
   * substitute for reachability.
   */
  private detailContent(
    task: BoardTask,
    layout: BoardLayout,
  ): {
    pinned: string[];
    body: string[];
    actions: Map<string, { order: number; start: number; end: number }>;
  } {
    const width = layout.rightWidth;
    const health = task.health;
    const fields = [
      ["Requirements", health.requirements],
      ["Acceptance", health.acceptance],
      ["New red test", health.newRedTest],
      ["Red evidence", health.redEvidence],
      ["Implementation", health.implementation],
    ] as const;
    const summary = [
      ...this.wrapLines(`Service: ${this.snapshot.board.service.label}`, width),
      this.formatLine("Summary:", width),
      ...fields.flatMap(([label, value]) =>
        this.wrapLines(`• ${label}: ${value}`, width),
      ),
    ];
    const pinValues = summary.length < layout.contentRows;
    const pinned = pinValues
      ? summary
      : [
          this.formatLine("Service:", width),
          this.formatLine("Summary:", width),
          ...fields.map(([label]) => this.formatLine(`• ${label}:`, width)),
        ];
    const body = [
      ...(pinValues
        ? []
        : [
            ...this.wrapLines(this.snapshot.board.service.label, width),
            ...fields.flatMap(([, value]) => this.wrapLines(value, width)),
          ]),
      ...this.wrapLines(`Task: ${task.label}`, width),
      ...this.wrapLines(`Assessment: ${this.provenance(task)}`, width),
      ...this.detailValueLines("Task Title", task.details?.title, width),
      ...this.detailValueLines("Description", task.details?.description, width),
      ...(task.details?.acceptanceCriteria?.length
        ? [
            ...this.wrapLines("Acceptance Criteria:", width),
            ...task.details.acceptanceCriteria.flatMap((value: DetailValue) =>
              this.detailValueLines("•", value, width),
            ),
          ]
        : []),
    ];
    const visibility = this.visibilityLines(task, width, body.length);
    body.push(...visibility.lines);
    if (!this.debugger) return { pinned, body, actions: visibility.actions };
    body.push(
      ...this.wrapLines("Debugger: task-local facts", width, "accent"),
      ...this.wrapLines(
        `Session-wide global calls: Jev ${this.snapshot.presentation.usage.jev.calls} · Extraction ${this.snapshot.presentation.usage.extraction.calls}`,
        width,
        "dim",
      ),
      ...(this.snapshot.visibility
        ? this.wrapLines(
            `Visibility: ↓ ${this.snapshot.visibility.usage.inputTokens} · ↑ ${this.snapshot.visibility.usage.outputTokens} tokens · ${this.snapshot.visibility.usage.calls} calls · ${this.snapshot.visibility.budgetRemaining} remaining · last ${time(this.snapshot.visibility.usage.lastCallAt) ?? "never"}`,
            width,
            "dim",
          )
        : []),
      ...this.wrapLines("Transitions:", width),
      ...(task.transitions.length
        ? task.transitions.flatMap((transition) =>
            this.wrapLines(`• ${transition.kind}`, width),
          )
        : this.wrapLines("• No task-local transitions", width, "dim")),
    );
    return { pinned, body, actions: visibility.actions };
  }

  private sameVisibilityTask(
    task: BoardTask,
    candidate: VisibilityAction["task"],
  ) {
    return (
      task.taskId === candidate.id &&
      task.label === candidate.label &&
      task.revision === candidate.revision &&
      task.sourceDigest === candidate.sourceDigest
    );
  }

  /** A bound "other task" must still exist under exact board identity. */
  private boardHasVisibilityTask(candidate: VisibilityAction["task"]) {
    const tasks = this.snapshot.board.tasks;
    return tasks.some((task) => this.sameVisibilityTask(task, candidate));
  }

  private visibilityLines(task: BoardTask, width: number, baseOffset: number) {
    const visibility = this.snapshot.visibility;
    const lines: string[] = [];
    const actions = new Map<
      string,
      { order: number; start: number; end: number }
    >();
    if (!visibility) return { lines, actions };
    lines.push(...this.wrapLines("Current Activity:", width));
    const current = visibility.current;
    if (!current)
      lines.push(...this.wrapLines("Agent current: unavailable", width, "dim"));
    else {
      const prefix =
        current.kind === "reported"
          ? current.provisional
            ? "Agent says (provisional)"
            : "Agent says"
          : "Agent current";
      const text = sanitizeTerminalText(current.text);
      if (current.task && this.sameVisibilityTask(task, current.task))
        lines.push(
          ...this.wrapLines(
            `${prefix}: ${text}${
              current.certainty === "maybe" ? " · (MAYBE)" : ""
            }`,
            width,
          ),
        );
      else if (current.task && this.boardHasVisibilityTask(current.task))
        lines.push(
          ...this.wrapLines(
            `Agent current: ${text} · other task ${sanitizeTerminalText(current.task.label)}${
              current.certainty === "maybe" ? " (MAYBE)" : ""
            }`,
            width,
          ),
        );
      else
        lines.push(
          ...this.wrapLines(`${prefix}: ${text} · task unconfirmed`, width),
        );
    }
    lines.push(...this.wrapLines("Meaningful Actions:", width));
    lines.push(
      ...this.wrapLines(
        "Since monitoring resumed · history may be incomplete",
        width,
        "dim",
      ),
    );
    if (visibility.budgetRemaining === 0)
      lines.push(
        ...this.wrapLines(
          "Visibility budget reached · history incomplete",
          width,
          "warning",
        ),
      );
    if (this.actionAnchorGap)
      lines.push(
        ...this.wrapLines(
          "History gap — viewed action no longer retained",
          width,
          "warning",
        ),
      );
    const taskActions = visibility.actions
      .filter((action) => this.sameVisibilityTask(task, action.task))
      .sort((left, right) => right.order - left.order);
    if (!taskActions.length)
      lines.push(
        ...this.wrapLines("• No task-bound reported actions", width, "dim"),
      );
    for (const action of taskActions) {
      const start = baseOffset + lines.length;
      lines.push(
        ...this.wrapLines(
          `Agent reported: ${sanitizeTerminalText(action.candidate.quote)}${
            action.certainty === "maybe" ? " · (MAYBE)" : ""
          }`,
          width,
        ),
      );
      actions.set(action.id, {
        order: action.order,
        start,
        end: baseOffset + lines.length,
      });
    }
    return { lines, actions };
  }

  private captureActionAnchor(): ActionAnchor | undefined {
    if (this.detailOffset <= 0) return;
    const task = this.selected();
    if (!task || !this.lastLayout.usable) return;
    const { actions } = this.detailContent(task, this.lastLayout);
    for (const [id, action] of actions) {
      if (this.detailOffset < action.start || this.detailOffset >= action.end)
        continue;
      return {
        id,
        order: action.order,
        lineOffset: this.detailOffset - action.start,
      };
    }
  }

  private restoreActionAnchor(anchor: ActionAnchor): void {
    const task = this.selected();
    if (!task || !this.lastLayout.usable) return;
    this.actionAnchor = anchor;
    this.actionAnchorGap = false;
    let actions = this.detailContent(task, this.lastLayout).actions;
    let matched = actions.get(anchor.id);
    if (!matched) {
      this.actionAnchorGap = true;
      actions = this.detailContent(task, this.lastLayout).actions;
      matched = [...actions.entries()]
        .map(([id, action]) => ({ id, action }))
        .sort(
          (left, right) =>
            Math.abs(left.action.order - anchor.order) -
            Math.abs(right.action.order - anchor.order),
        )[0]?.action;
      const nearest = [...actions.entries()].find(
        ([, action]) => action === matched,
      );
      if (nearest)
        this.actionAnchor = {
          id: nearest[0],
          order: nearest[1].order,
          lineOffset: 0,
        };
    }
    if (matched) {
      const lineOffset = this.actionAnchor?.lineOffset ?? anchor.lineOffset;
      this.detailOffset =
        matched.start + Math.min(lineOffset, matched.end - matched.start - 1);
    }
  }

  private resetActionAnchor(): void {
    this.detailOffset = 0;
    this.actionAnchor = undefined;
    this.actionAnchorGap = false;
  }

  private detailValueLines(
    label: string,
    value: DetailValue | undefined,
    width: number,
  ): string[] {
    if (!value) return [];
    const title = label === "•" ? `• ${value.text}` : `${label}: ${value.text}`;
    return [
      ...this.wrapLines(title, width),
      ...this.wrapLines(this.detailProvenance(value), width, "dim"),
    ];
  }

  /** Display only bounded detail-validation facts, never raw source metadata. */
  private detailProvenance(value: DetailValue): string {
    const provenance = value.provenance;
    const role =
      provenance &&
      typeof provenance.role === "string" &&
      ["user", "assistant", "intercom"].includes(provenance.role)
        ? provenance.role
        : "unknown";
    const validated =
      provenance && typeof provenance.validatedAt === "number"
        ? (time(provenance.validatedAt) ?? "unknown")
        : "unknown";
    return [
      `Source: ${role}`,
      `Validated: ${validated}`,
      `Confidence: ${this.percent(provenance?.confidence)}`,
      `Probability: ${this.percent(provenance?.probability)}`,
    ].join(" · ");
  }

  private percent(value: unknown): string {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    )
      return "unknown";
    return `${Math.round(value * 100)}%`;
  }

  private provenance(task: BoardTask): string {
    const parts: string[] = [task.provenance.state];
    if (task.provenance.role) parts.push(task.provenance.role);
    const assessed = time(task.provenance.assessedAt);
    if (assessed) parts.push(assessed);
    return parts.join(" · ");
  }

  private compose(
    left: readonly string[],
    right: readonly string[],
    layout: BoardLayout,
  ): string[] {
    const lines: string[] = [];
    for (let index = 0; index < layout.contentRows; index++) {
      const leftLine = left[index] ?? "";
      const rightLine = right[index] ?? "";
      lines.push(
        `${this.pad(leftLine, layout.leftWidth)} ${this.pad(rightLine, layout.rightWidth)}`,
      );
    }
    lines.push(
      this.formatLine(
        "↑↓ navigate · PgUp/PgDn scroll · ←→/Tab panes · d debugger · Esc close",
        layout.width,
        "dim",
      ),
    );
    return this.limitRows(lines, layout);
  }

  private listPage(layout: BoardLayout): number {
    return Math.max(1, layout.contentRows - 1);
  }

  private detailCapacity(layout: BoardLayout): number {
    const task = this.selected();
    if (!task) return 1;
    return Math.max(
      1,
      layout.contentRows - this.detailContent(task, layout).pinned.length,
    );
  }

  private detailMaximum(layout: BoardLayout): number {
    const task = this.selected();
    if (!task) return 0;
    const content = this.detailContent(task, layout);
    return Math.max(0, content.body.length - this.detailCapacity(layout));
  }

  private clampOffsets(layout: BoardLayout): void {
    const tasks = this.tasks();
    if (!tasks.length) {
      this.listOffset = 0;
      this.detailOffset = 0;
      return;
    }
    this.selectedIndex = Math.max(
      0,
      Math.min(this.selectedIndex, tasks.length - 1),
    );
    this.selectedId = tasks[this.selectedIndex]?.taskId;
    const capacity = this.listPage(layout);
    const maximum = Math.max(0, tasks.length - capacity);
    if (this.selectedIndex < this.listOffset)
      this.listOffset = this.selectedIndex;
    if (this.selectedIndex >= this.listOffset + capacity)
      this.listOffset = this.selectedIndex - capacity + 1;
    this.listOffset = Math.max(0, Math.min(this.listOffset, maximum));
    this.detailOffset = Math.max(
      0,
      Math.min(this.detailOffset, this.detailMaximum(layout)),
    );
  }

  private formatLine(
    text: string,
    width: number,
    tone: "accent" | "muted" | "dim" | "warning" = "muted",
  ): string {
    return this.styleLine(
      truncateToWidth(sanitizeTerminalText(text), Math.max(1, width)),
      width,
      tone,
    );
  }

  /** Style lifecycle token separately from its untrusted task label. */
  private taskLine(task: BoardTask, width: number, selected: boolean): string {
    const columns = Math.max(1, width);
    const status = sanitizeTerminalText(task.status);
    const prefix = `${selected ? ">" : " "} `;
    const padding = " ".repeat(Math.max(0, 8 - status.length));
    const safe = truncateToWidth(
      `${prefix}${status}${padding} ${sanitizeTerminalText(task.label)}`,
      columns,
    );
    const statusStart = Math.min(prefix.length, safe.length);
    const statusEnd = Math.min(statusStart + status.length, safe.length);
    const surroundingTone = selected ? "accent" : "muted";
    const styled = `${this.options.theme.fg(surroundingTone, safe.slice(0, statusStart))}${this.options.theme.fg(lifecycleTone(status), safe.slice(statusStart, statusEnd))}${this.options.theme.fg(surroundingTone, safe.slice(statusEnd))}`;
    const colored = selected
      ? this.options.theme.bg("selectedBg", styled)
      : styled;
    return visibleWidth(colored) <= columns ? colored : safe;
  }

  private wrapLines(
    text: string,
    width: number,
    tone: "accent" | "muted" | "dim" | "warning" = "muted",
  ): string[] {
    const safe = sanitizeTerminalText(text);
    const columns = Math.max(1, width);
    if (!safe) return [this.styleLine("", columns, tone)];
    const lines: string[] = [];
    let line = "";
    for (const { segment } of new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    }).segment(safe)) {
      const glyph = visibleWidth(segment) > columns ? "?" : segment;
      if (line && visibleWidth(line + glyph) > columns) {
        lines.push(this.styleLine(line, columns, tone));
        line = "";
      }
      line += glyph;
    }
    if (line || !lines.length) lines.push(this.styleLine(line, columns, tone));
    return lines;
  }

  private styleLine(
    safe: string,
    width: number,
    tone: "accent" | "muted" | "dim" | "warning" = "muted",
  ): string {
    const colored = this.options.theme.fg(tone, safe);
    return visibleWidth(colored) <= width ? colored : safe;
  }

  private pad(line: string, width: number): string {
    const remaining = Math.max(0, width - visibleWidth(line));
    return `${line}${" ".repeat(remaining)}`;
  }

  private limitRows(lines: readonly string[], layout: BoardLayout): string[] {
    return lines
      .slice(0, layout.height)
      .map((line) =>
        visibleWidth(line) <= layout.width
          ? line
          : truncateToWidth(line, layout.width),
      );
  }
}

export function createBoard(
  snapshot: WidgetSnapshot,
  options: BoardOptions,
): BoardComponent {
  return new TaskBoard(snapshot, options);
}
