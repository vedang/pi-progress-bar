import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readBeadsExport } from "../src/sources/beads";
import { addPatch, observation } from "./fixtures/hybrid";
import { branchEntry, monitorHarness } from "./fixtures/hybrid-monitor";

vi.mock("../src/sources/beads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sources/beads")>()),
  readBeadsExport: vi.fn(),
}));
const running: ReturnType<typeof monitorHarness>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline-key");
  vi.mocked(readBeadsExport).mockReset();
});
afterEach(() => {
  for (const h of running.splice(0)) h.monitor.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("enriches exact admitted IDs from Beads without importing backlog or treating closed as completion", async () => {
  vi.mocked(readBeadsExport).mockResolvedValue({
    complete: true,
    note: "bounded beads_rust JSONL export",
    records: new Map([
      [
        "demo-123",
        {
          id: "demo-123",
          title: "Parser issue",
          status: "closed",
          parentIds: [],
        },
      ],
      [
        "demo-999",
        {
          id: "demo-999",
          title: "UNRELATED_BACKLOG_SECRET",
          status: "open",
          parentIds: [],
        },
      ],
    ]),
  });
  const text = "Implement parser for demo-123.";
  const h = monitorHarness([branchEntry("goal", text)]);
  running.push(h);
  h.extract.mockResolvedValueOnce({
    text: JSON.stringify(
      addPatch(observation("goal", text), ["Implement parser for demo-123"]),
    ),
    provider: "offline",
    model: "fixture",
    usage: { inputTokens: 3, outputTokens: 2 },
  });
  h.start();
  await h.settle("goal");
  expect(readBeadsExport).toHaveBeenCalledWith("/nonexistent-hybrid-test");
  expect(h.monitor.state.tasks).toHaveLength(1);
  expect(h.monitor.state.tasks[0]?.status).toBe("not-started");
  expect(h.monitor.presentationSnapshot().progress).toMatchObject({
    done: 0,
    total: 1,
  });
  expect(h.monitor.presentationSnapshot().card).toMatchObject({
    beads: {
      id: "demo-123",
      title: "Parser issue",
      exportStatus: "closed",
      conflict: true,
    },
  });
  expect(JSON.stringify(h.monitor.presentationSnapshot())).not.toContain(
    "UNRELATED_BACKLOG_SECRET",
  );
  expect(JSON.stringify(h.monitor.debugSnapshot())).not.toContain("demo-123");
});

it("publishes async export failure safely without a new semantic observation", async () => {
  let rejectRead: ((error: Error) => void) | undefined;
  const held = new Promise<Awaited<ReturnType<typeof readBeadsExport>>>(
    (_, reject) => {
      rejectRead = reject;
    },
  );
  vi.mocked(readBeadsExport).mockReturnValue(held);
  const h = monitorHarness();
  running.push(h);
  h.start();
  await h.settle("goal");
  const publications = h.changed.mock.calls.length;
  const calls = h.fetch.mock.calls.length;
  rejectRead?.(new Error("PRIVATE_EXPORT_ERROR"));
  await vi.advanceTimersByTimeAsync(50);
  expect(h.changed.mock.calls.length).toBeGreaterThan(publications);
  expect(h.fetch).toHaveBeenCalledTimes(calls);
  expect(JSON.stringify(h.monitor.debugSnapshot())).toMatch(
    /Beads export unavailable/,
  );
  expect(JSON.stringify(h.monitor.debugSnapshot())).not.toContain(
    "PRIVATE_EXPORT_ERROR",
  );
});

it("ignores late Beads callbacks after stop", async () => {
  let resolveRead:
    | ((value: Awaited<ReturnType<typeof readBeadsExport>>) => void)
    | undefined;
  vi.mocked(readBeadsExport).mockReturnValue(
    new Promise((resolve) => {
      resolveRead = resolve;
    }),
  );
  const h = monitorHarness();
  running.push(h);
  h.start();
  await h.settle("goal");
  h.monitor.stop();
  const publications = h.changed.mock.calls.length;
  const view = structuredClone(h.monitor.presentationSnapshot());
  resolveRead?.({
    complete: false,
    records: new Map(),
    note: "PRIVATE_LATE_NOTE",
  });
  await vi.advanceTimersByTimeAsync(50);
  expect(h.changed).toHaveBeenCalledTimes(publications);
  expect(h.monitor.presentationSnapshot()).toEqual(view);
});

it("refreshes changed exact-ID metadata on new evidence without changing lifecycle or reading on display", async () => {
  const records = (title: string, status: "closed" | "open") => ({
    complete: true,
    note: "fixture",
    records: new Map([
      ["demo-123", { id: "demo-123", title, status, parentIds: [] }],
    ]),
  });
  vi.mocked(readBeadsExport).mockResolvedValue(
    records("Original title", "closed"),
  );
  const text = "Implement parser for demo-123.";
  const h = monitorHarness([branchEntry("goal", text)]);
  running.push(h);
  h.extract.mockResolvedValueOnce({
    text: JSON.stringify(addPatch(observation("goal", text), [text])),
    provider: "offline",
    model: "fixture",
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  h.start();
  await h.settle("goal");
  vi.mocked(readBeadsExport).mockResolvedValue(
    records("Updated title", "open"),
  );
  h.append("acknowledgment", "Work remains ongoing.");
  await h.settle("acknowledgment");
  expect(h.monitor.presentationSnapshot().card).toMatchObject({
    beads: { title: "Updated title", exportStatus: "open", conflict: false },
  });
  expect(h.monitor.state.tasks[0]?.status).toBe("not-started");
  const reads = vi.mocked(readBeadsExport).mock.calls.length;
  for (let i = 0; i < 20; i++) {
    h.monitor.presentationSnapshot();
    h.monitor.debugSnapshot();
  }
  await vi.advanceTimersByTimeAsync(50);
  expect(readBeadsExport).toHaveBeenCalledTimes(reads);
});
