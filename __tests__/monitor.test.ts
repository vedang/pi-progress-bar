import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileLedger } from "../src/core/ledger";
import { Monitor } from "../src/core/monitor";
import { parseChecklist } from "../src/sources/checklist";

const snapshot = (body = "- [x] A\n- [ ] B") =>
  parseChecklist(`# Tasks\n${body}`, {
    sourceId: "plan.md#Tasks",
    section: "Tasks",
  });
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
describe("monitor lifecycle", () => {
  it("refreshes counts and preserves stale source on failure", async () => {
    const read = vi.fn().mockResolvedValue(snapshot("- [x] A\n- [x] B"));
    const monitor = new Monitor(vi.fn(), vi.fn(), read);
    monitor.apply(reconcileLedger(undefined, snapshot()), {
      path: "plan.md",
      section: "Tasks",
    });
    await monitor.refresh("/workspace");
    expect(monitor.ledger?.tasks.every((task) => task.status === "done")).toBe(
      true,
    );
    read.mockRejectedValue(new Error("unavailable"));
    await monitor.refresh("/workspace");
    expect(monitor.ledger?.stale).toBe(true);
    expect(monitor.ledger?.tasks).toHaveLength(2);
  });
  it("invalidates an outstanding local read on stop", async () => {
    let finish!: (value: ReturnType<typeof snapshot>) => void;
    const read = vi.fn(
      () =>
        new Promise<ReturnType<typeof snapshot>>((resolve) => {
          finish = resolve;
        }),
    );
    const changed = vi.fn();
    const monitor = new Monitor(changed, vi.fn(), read);
    monitor.apply(reconcileLedger(undefined, snapshot()), {
      path: "plan.md",
      section: "Tasks",
    });
    const refresh = monitor.refresh("/workspace");
    monitor.stop();
    changed.mockClear();
    finish(snapshot("- [x] A\n- [x] B"));
    await refresh;
    expect(monitor.ledger?.tasks[1]?.status).toBe("not-started");
    expect(changed).not.toHaveBeenCalled();
  });
  it("restores IDs and explicit scope across reorder without source bodies", async () => {
    vi.useFakeTimers();
    const first = reconcileLedger(undefined, snapshot());
    const id = first.tasks[0]?.id;
    if (!id) throw new Error("Fixture task missing");
    const selected = reconcileLedger(first, snapshot(), {
      includedIds: [id],
      currentTaskId: id,
    });
    const monitor = new Monitor(vi.fn(), vi.fn());
    monitor.apply(selected, { path: "plan.md", section: "Tasks" });
    const cp = monitor.checkpoint();
    expect(JSON.stringify(cp)).not.toContain('"text"');
    const restored = new Monitor(
      vi.fn(),
      vi.fn(),
      vi.fn().mockResolvedValue(snapshot("- [ ] B\n- [x] A")),
    );
    await restored.restore("/workspace", cp);
    expect(restored.ledger?.tasks.find((task) => task.text === "A")?.id).toBe(
      id,
    );
    expect(restored.ledger?.tasks.filter((task) => task.included)).toHaveLength(
      1,
    );
    expect(restored.ledger?.currentTaskId).toBe(id);
    restored.stop();
  });
});
