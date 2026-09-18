import { createHash } from "node:crypto";
import { readSource } from "../sources/read-source";
import { reconcileLedger } from "./ledger";
import type { Ledger, Task } from "./types";

const key = (task: Task) =>
  createHash("sha256")
    .update(task.anchor ? `anchor:${task.anchor}` : `text:${task.text}`)
    .digest("hex");
export interface Checkpoint {
  version: 1;
  interval: number;
  source?: { path: string; section?: string };
  revision?: string;
  mappings: { hash: string; id: string; included: boolean }[];
  currentTaskId?: string;
  nextTaskId: number;
}
function validInterval(seconds: number) {
  return (
    Number.isFinite(seconds) && seconds >= 0.001 && seconds * 1000 <= 2147483647
  );
}

/** Local controller. Callbacks keep host UI/persistence outside ledger operations. */
export class Monitor {
  ledger?: Ledger;
  source?: Checkpoint["source"];
  interval = 15;
  activity = "Idle";
  error?: string;
  epoch = 0;
  private timer?: ReturnType<typeof setInterval>;
  private reading = false;
  constructor(
    private readonly changed: () => void,
    private readonly persist: (checkpoint: Checkpoint) => void,
    private readonly read = readSource,
  ) {}
  checkpoint(): Checkpoint {
    return {
      version: 1,
      interval: this.interval,
      source: this.source,
      revision: this.ledger?.sourceRevision,
      mappings:
        this.ledger?.tasks.map((task) => ({
          hash: key(task),
          id: task.id,
          included: task.included,
        })) ?? [],
      currentTaskId: this.ledger?.currentTaskId,
      nextTaskId: this.ledger?.nextTaskId ?? 1,
    };
  }
  save() {
    this.persist(this.checkpoint());
  }
  stop() {
    this.epoch++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  start(cwd: string) {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.refresh(cwd);
    }, this.interval * 1000);
  }
  setInterval(seconds: number, cwd: string) {
    if (!validInterval(seconds))
      throw new Error("Interval must be 0.001–2147483.647 seconds");
    this.interval = seconds;
    this.start(cwd);
    this.save();
    this.changed();
  }
  apply(ledger: Ledger, source: NonNullable<Checkpoint["source"]>) {
    this.epoch++;
    this.ledger = ledger;
    this.source = source;
    this.error = undefined;
    this.save();
    this.changed();
  }
  async refresh(cwd: string) {
    if (this.reading || !this.source) return;
    const epoch = this.epoch;
    this.reading = true;
    try {
      const snapshot = await this.read(
        cwd,
        this.source.path,
        this.source.section,
      );
      if (epoch !== this.epoch) return;
      const old = this.ledger;
      this.ledger = reconcileLedger(old, snapshot);
      this.error = undefined;
      if (old?.sourceRevision !== snapshot.revision) this.save();
    } catch {
      if (epoch !== this.epoch) return;
      this.error =
        "Source unavailable or changed; last complete count is stale";
      if (this.ledger) this.ledger = { ...this.ledger, stale: true };
    } finally {
      this.reading = false;
      if (epoch === this.epoch) this.changed();
    }
  }
  async restore(cwd: string, data: unknown) {
    this.stop();
    const epoch = this.epoch;
    this.ledger = undefined;
    this.source = undefined;
    this.error = undefined;
    this.interval = 15;
    this.activity = "Idle";
    this.changed();
    try {
      if (!data || typeof data !== "object") return;
      const cp = data as Checkpoint;
      if (cp.version !== 1 || !validInterval(cp.interval))
        throw new Error("Invalid checkpoint");
      this.interval = cp.interval;
      if (!cp.source) return;
      if (
        typeof cp.source.path !== "string" ||
        (cp.source.section !== undefined &&
          typeof cp.source.section !== "string") ||
        !Array.isArray(cp.mappings) ||
        cp.mappings.length > 200 ||
        !Number.isSafeInteger(cp.nextTaskId) ||
        cp.nextTaskId < 1
      )
        throw new Error("Invalid checkpoint");
      const ids = new Set<string>();
      const hashes = new Set<string>();
      for (const map of cp.mappings) {
        if (
          !map ||
          typeof map.hash !== "string" ||
          !/^[a-f0-9]{64}$/.test(map.hash) ||
          typeof map.id !== "string" ||
          map.id.length > 200 ||
          typeof map.included !== "boolean" ||
          ids.has(map.id) ||
          hashes.has(map.hash)
        )
          throw new Error("Invalid mapping");
        ids.add(map.id);
        hashes.add(map.hash);
      }
      const snapshot = await this.read(cwd, cp.source.path, cp.source.section);
      if (epoch !== this.epoch) return;
      const ledger = reconcileLedger(undefined, snapshot);
      const maps = new Map(cp.mappings.map((map) => [map.hash, map]));
      let next = cp.nextTaskId;
      ledger.tasks = ledger.tasks.map((task) => {
        const map = maps.get(key(task));
        let id = map?.id;
        if (!id) {
          do {
            id = `${task.id.split(":task:")[0]}:task:${next++}`;
          } while (ids.has(id));
        }
        ids.add(id);
        return { ...task, id, included: map?.included ?? false };
      });
      ledger.nextTaskId = next;
      ledger.explicitSelection = true;
      if (
        ledger.tasks.some(
          (task) => task.id === cp.currentTaskId && task.included,
        )
      )
        ledger.currentTaskId = cp.currentTaskId;
      this.source = { path: cp.source.path, section: cp.source.section };
      this.ledger = ledger;
    } catch {
      if (epoch === this.epoch)
        this.error =
          "Saved source unavailable or checkpoint invalid; select source again";
    } finally {
      if (epoch === this.epoch) {
        this.start(cwd);
        this.changed();
      }
    }
  }
}
