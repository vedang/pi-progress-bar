import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { noPatch } from "./fixtures/hybrid";
import { taskHealthHarness } from "./fixtures/task-health";

const running: ReturnType<typeof taskHealthHarness>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline-key");
});
afterEach(() => {
  for (const h of running.splice(0)) h.monitor.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
function fixture(count = 3) {
  const h = taskHealthHarness(count);
  running.push(h);
  return h;
}

it.each(["none", "concurrent", "uncertain", "below-threshold"])(
  "assesses every included task independently of %s focus",
  async (focus) => {
    const h = fixture();
    h.focus(
      focus === "below-threshold" ? "task:1" : focus,
      focus === "below-threshold" ? 0.2 : 1,
    );
    h.start();
    await h.settle("goal");
    expect(h.monitor.state.focusTaskId).toBeUndefined();
    expect(
      h
        .cards()
        .map((c) => c.taskId)
        .sort(),
    ).toEqual(["task:1", "task:2", "task:3"]);
    expect(h.healthRequests()).toHaveLength(3);
    expect(
      h.monitor.boardSnapshot().tasks.every((t) => t.status === "OPEN"),
    ).toBe(true);
  },
);

it("dispatches only one health request while first task assessment is held", async () => {
  const h = fixture();
  const transport = h.fetch.getMockImplementation();
  if (!transport) throw new Error("Missing transport");
  let release: (() => void) | undefined;
  let active = 0;
  let peak = 0;
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (!request.questions.clarity) return transport(url, init);
    active++;
    peak = Math.max(peak, active);
    const response = await transport(url, init);
    if (!release)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    active--;
    return response;
  });
  h.start();
  await h.settle("goal");
  expect(release).toBeDefined();
  expect(h.healthRequests()).toHaveLength(1);
  release?.();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.cards()).toHaveLength(3);
  expect(peak).toBe(1);
});

it("replaces revised health and retains failing-report context across a later unrelated observation", async () => {
  const h = fixture();
  h.focus("task:1");
  h.start();
  await h.settle("goal");
  expect(h.cards().find((c) => c.taskId === "task:1")?.revision).toBe(1);
  h.focus("concurrent");
  const revised = "Fix parser for unsigned parent filenames.";
  h.patches.set("revision", {
    ...noPatch(),
    revise: [
      {
        id: "task:1",
        label: "Fix parser filenames",
        requirementsChanged: true,
        quote: revised,
      },
    ],
  });
  h.append("revision", revised, "user");
  h.append(
    "red",
    "PARSER_RED_REPORT: parser regression produced 13 failing assertions.",
  );
  h.append("unrelated", "Documentation research is ongoing.");
  await h.settle("unrelated");
  const card = h.cards().find((c) => c.taskId === "task:1");
  expect(card).toMatchObject({
    revision: 2,
    health: { redEvidence: "Reported red" },
  });
  const latest = h
    .healthRequests()
    .filter(
      (r) =>
        (r.state as { evidence: { taskId: string } }).evidence.taskId ===
        "task:1",
    )
    .at(-1);
  expect(JSON.stringify(latest?.state)).toContain("PARSER_RED_REPORT");
  expect(JSON.stringify(latest?.state)).toContain(
    "Documentation research is ongoing",
  );
  expect(
    h
      .cards()
      .filter((c) => c.taskId !== "task:1")
      .every((c) => c.health.redEvidence !== "Reported red"),
  ).toBe(true);
  expect(h.monitor.state.focusTaskId).toBeUndefined();
  expect(h.monitor.state.tasks.every((t) => t.status !== "done")).toBe(true);
});

it("assesses terminal report while other tasks stay open, without refreshing done tasks later", async () => {
  const h = fixture();
  h.start();
  await h.settle("goal");
  h.completed.add("task:1");
  h.append("terminal", "Parser task complete; documentation is still open.");
  await h.settle("terminal");
  expect(
    h.cards().find((c) => c.taskId === "task:1")?.provenance.observation
      .entryId,
  ).toBe("terminal");
  const calls = h.healthRequests().length;
  h.append("later", "Documentation update.");
  await h.settle("later");
  expect(h.healthRequests().length - calls).toBe(2);
  expect(
    h.cards().find((c) => c.taskId === "task:1")?.provenance.observation
      .entryId,
  ).toBe("terminal");
});

it("retains archived health without new work and assesses a task restored without focus", async () => {
  const h = fixture();
  h.start();
  await h.settle("goal");
  const before = h.cards().find((c) => c.taskId === "task:1");
  expect(before).toBeDefined();
  h.patches.set("archive", {
    ...noPatch(),
    archive: [{ id: "task:1", quote: "Drop parser work." }],
  });
  h.append("archive", "Drop parser work.", "user");
  await h.settle("archive");
  expect(h.cards().find((c) => c.taskId === "task:1")).toEqual(before);
  expect(h.monitor.state.tasks[0]?.included).toBe(false);
  h.patches.set("restore-task", {
    ...noPatch(),
    restore: [
      {
        id: "task:1",
        label: "Fix parser",
        requirementsChanged: false,
        quote: "Restore parser work.",
      },
    ],
  });
  h.append("restore-task", "Restore parser work.", "user");
  await h.settle("restore-task");
  expect(h.monitor.state.tasks[0]?.included).toBe(true);
  expect(
    h.cards().find((c) => c.taskId === "task:1")?.provenance.observation
      .entryId,
  ).toBe("restore-task");
});
