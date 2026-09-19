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
