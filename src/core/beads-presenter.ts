import {
  type BeadsPresentation,
  beadsPresentation,
  readBeadsExport,
} from "../sources/beads";
import type { HybridTask } from "./hybrid-state";

/** Live Monitor reads; every value is re-read at resolve time. */
export interface BeadsHost {
  cwd: () => string | undefined;
  enabled: () => boolean;
  epoch: () => number;
  sourceId: () => string;
  tasks: () => readonly HybridTask[];
  note: (code: "beads-unavailable") => void;
  publish: () => void;
}

const sameBeads = (
  left: ReadonlyMap<string, BeadsPresentation>,
  right: ReadonlyMap<string, BeadsPresentation>,
) =>
  left.size === right.size &&
  [...left].every(([taskId, value]) => {
    const candidate = right.get(taskId);
    return !!candidate && JSON.stringify(candidate) === JSON.stringify(value);
  });

/** Async Beads reads enrich copied display data only, never hybrid state. */
export class BeadsPresenter {
  private beads = new Map<string, BeadsPresentation>();
  private generation = 0;
  private inFlight = false;
  private refreshQueued = false;

  constructor(private readonly host: BeadsHost) {}

  get(taskId: string) {
    return this.beads.get(taskId);
  }

  /** Drop display data and fence any in-flight read. */
  clear() {
    this.beads.clear();
    this.generation++;
  }

  refresh() {
    const cwd = this.host.cwd();
    if (!cwd || !this.host.enabled()) return;
    const generation = ++this.generation;
    if (this.inFlight) {
      this.refreshQueued = true;
      return;
    }
    const epoch = this.host.epoch();
    const sourceId = this.host.sourceId();
    const current = () =>
      generation === this.generation &&
      this.host.enabled() &&
      epoch === this.host.epoch() &&
      sourceId === this.host.sourceId();
    this.inFlight = true;
    void readBeadsExport(cwd)
      .then((source) => {
        if (!current()) return;
        const next = new Map<string, BeadsPresentation>();
        if (source.complete) {
          for (const task of this.host.tasks()) {
            const beads = beadsPresentation(
              task.label,
              task.status === "done",
              source,
            );
            if (beads) next.set(task.id, beads);
          }
        } else this.host.note("beads-unavailable");
        const changed = !sameBeads(this.beads, next);
        if (changed) this.beads = next;
        if (!source.complete || changed) this.host.publish();
      })
      .catch(() => {
        if (!current()) return;
        this.beads.clear();
        this.host.note("beads-unavailable");
        this.host.publish();
      })
      .finally(() => {
        this.inFlight = false;
        if (this.refreshQueued) {
          this.refreshQueued = false;
          this.refresh();
        }
      });
  }
}
