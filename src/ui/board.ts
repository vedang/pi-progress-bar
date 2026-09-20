import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { type BoardLayout, layoutBoard } from "./layout";
import { sanitizeTerminalText, type WidgetSnapshot } from "./widget";

type BoardTask = WidgetSnapshot["board"]["tasks"][number];

interface BoardViewState {
  selectedId?: string;
  listOffset: number;
  detailOffset: number;
  debugger: boolean;
  pane: "list" | "detail";
}

export interface BoardOptions {
  theme: Theme;
  screenRows(): number;
  isFocused(): boolean;
  onClose(): void;
  requestRender(): void;
}

export interface BoardComponent extends Component {
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
    } else {
      this.selectedId = undefined;
      this.selectedIndex = 0;
      this.listOffset = 0;
      this.detailOffset = 0;
    }
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
    this.detailOffset = 0;
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
    this.requestRender();
  }

  private renderEmpty(layout: BoardLayout): string[] {
    const left = ["Tasks 0 retained", "No retained tasks"];
    const right = [
      "No retained tasks to inspect",
      `Service: ${this.snapshot.board.service.label}`,
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
        .map((item) => {
          const selected = item.taskId === task.taskId;
          return this.formatLine(
            `${selected ? ">" : " "} ${item.status.padEnd(8)} ${item.label}`,
            layout.leftWidth,
            selected ? "accent" : "muted",
            selected,
          );
        }),
    ];
    const detail = this.detailLines(task, layout);
    return this.compose(left, detail, layout);
  }

  private detailLines(task: BoardTask, layout: BoardLayout): string[] {
    const taskWidth = layout.rightWidth;
    const health = task.health;
    const staticLines = [
      `Task: ${task.label}`,
      `Identity: ${task.taskId} · revision ${task.revision} · ${task.kind}`,
      `Service: ${this.snapshot.board.service.label}`,
      "Summary:",
      `• Requirements: ${health.requirements}`,
      `• Acceptance: ${health.acceptance}`,
      `• New red test: ${health.newRedTest}`,
      `• Red evidence: ${health.redEvidence}`,
      `• Implementation: ${health.implementation}`,
      `Assessment: ${this.provenance(task)}`,
    ].map((line) => this.formatLine(line, taskWidth));
    const body = this.debugger
      ? [
          this.formatLine("Debugger: task-local facts", taskWidth, "accent"),
          this.formatLine(
            `Session-wide global calls: Jev ${this.snapshot.presentation.usage.jev.calls} · Extraction ${this.snapshot.presentation.usage.extraction.calls}`,
            taskWidth,
            "dim",
          ),
          this.formatLine("Transitions:", taskWidth),
          ...(task.transitions.length
            ? task.transitions.map((transition) =>
                this.formatLine(`• ${transition.kind}`, taskWidth),
              )
            : [
                this.formatLine(
                  "• No task-local transitions",
                  taskWidth,
                  "dim",
                ),
              ]),
        ]
      : [
          this.formatLine(
            "Debugger: off (d to inspect task-local facts)",
            taskWidth,
            "dim",
          ),
        ];
    const capacity = Math.max(0, layout.contentRows - staticLines.length);
    const maximum = Math.max(0, body.length - capacity);
    this.detailOffset = Math.max(0, Math.min(this.detailOffset, maximum));
    return [
      ...staticLines,
      ...body.slice(this.detailOffset, this.detailOffset + capacity),
    ];
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
    return Math.max(1, layout.contentRows - 10);
  }

  private detailMaximum(layout: BoardLayout): number {
    const task = this.selected();
    if (!task) return 0;
    const bodyLength = this.debugger ? task.transitions.length + 3 : 1;
    return Math.max(0, bodyLength - this.detailCapacity(layout));
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
    selected = false,
  ): string {
    const safe = truncateToWidth(
      sanitizeTerminalText(text),
      Math.max(1, width),
    );
    const colored = selected
      ? this.options.theme.bg(
          "selectedBg",
          this.options.theme.fg("accent", safe),
        )
      : this.options.theme.fg(tone, safe);
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
