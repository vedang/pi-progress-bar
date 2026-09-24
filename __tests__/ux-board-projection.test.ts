import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationRequest } from "../src/analysis/gateway";
import type { Monitor } from "../src/core/monitor";
import { noPatch } from "./fixtures/hybrid";
import { branchEntry, monitorHarness } from "./fixtures/hybrid-monitor";

function board(monitor: Monitor) {
  return monitor.boardSnapshot();
}
function task(monitor: Monitor, id: string) {
  const found = board(monitor).tasks.find((item) => item.taskId === id);
  expect(found, `retained task ${id} stays reachable`).toBeDefined();
  if (!found) throw new Error("Missing board task");
  return found;
}
const unassessed = {
  requirements: "Unassessed",
  acceptance: "Unassessed",
  newRedTest: "Unassessed",
  redEvidence: "Unassessed",
  implementation: "Unassessed",
};
const running: ReturnType<typeof monitorHarness>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-20T03:00:00Z"));
  vi.stubEnv("TYPESAFE_API_KEY", "offline-key");
});
afterEach(() => {
  for (const h of running.splice(0)) h.monitor.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
function fixture() {
  const h = monitorHarness();
  running.push(h);
  let focus = "task:1";
  let complete: string[] = [];
  let changed = false;
  let acceptance = "explicit";
  const transport = h.fetch.getMockImplementation();
  if (!transport) throw new Error("Missing transport");
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body)) as EvaluationRequest;
    const response = await transport(url, init);
    const body = (await response.json()) as {
      answers: Record<string, unknown>;
    };
    for (const [key, question] of Object.entries(request.questions)) {
      if (question.type !== "choice") continue;
      const choice =
        key === "focus"
          ? focus
          : key.startsWith("complete:") && complete.includes(key.slice(9))
            ? "yes"
            : key === "gate" && changed
              ? "changed"
              : key === "acceptance"
                ? acceptance
                : undefined;
      if (!choice) continue;
      body.answers[key] = {
        type: "choice",
        choice,
        confidence: 1,
        probabilities: Object.fromEntries(
          Object.keys(question.criteria).map((k) => [k, k === choice ? 1 : 0]),
        ),
      };
    }
    return Response.json(body);
  });
  return Object.assign(h, {
    published: h.changed,
    focus: (value: string) => {
      focus = value;
    },
    complete: (value: string[]) => {
      complete = value;
    },
    changed: (value: boolean) => {
      changed = value;
    },
    acceptance: (value: string) => {
      acceptance = value;
    },
  });
}

describe("passive retained task board", () => {
  it("lists newest-first all tasks with independently assessed health", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    expect(board(h.monitor).tasks.map((t) => t.taskId)).toEqual([
      "task:3",
      "task:2",
      "task:1",
    ]);
    expect(task(h.monitor, "task:2")).toMatchObject({
      status: "OPEN",
      included: true,
      health: { acceptance: "explicit" },
      provenance: { state: "retained" },
    });
    expect(task(h.monitor, "task:1").health.acceptance).toBe("explicit");
    expect(task(h.monitor, "task:1").provenance.assessedAt).toBeGreaterThan(0);
  });

  it("retains separate assessments across focus switches and current-version reload", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    const first = task(h.monitor, "task:1");
    h.focus("task:2");
    h.acceptance("partial");
    h.append("switch", "Now writing the regression.");
    await h.settle("switch");
    expect(task(h.monitor, "task:1").health.acceptance).toBe("partial");
    expect(task(h.monitor, "task:1").provenance.assessedAt).toBeGreaterThan(
      first.provenance.assessedAt ?? 0,
    );
    expect(task(h.monitor, "task:1").provenance.state).toBe("retained");
    expect(task(h.monitor, "task:2").health.acceptance).toBe("partial");
    const checkpoint = h.monitor.checkpoint();
    expect(checkpoint).toHaveProperty("version", 9);
    const calls = h.fetch.mock.calls.length;
    const extracts = h.extract.mock.calls.length;
    await h.monitor.restore(
      "/nonexistent-hybrid-test",
      checkpoint,
      false,
      h.reader,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(task(h.monitor, "task:1").health.acceptance).toBe("partial");
    expect(task(h.monitor, "task:2").health.acceptance).toBe("partial");
    expect(h.fetch).toHaveBeenCalledTimes(calls);
    expect(h.extract).toHaveBeenCalledTimes(extracts);
  });

  it("distinguishes assessed Unknown from never assessed", async () => {
    const h = fixture();
    h.acceptance("unknown");
    h.start();
    await h.settle("goal");
    expect(task(h.monitor, "task:1").health.acceptance.toLowerCase()).toBe(
      "unknown",
    );
    expect(task(h.monitor, "task:1").provenance.state).toBe("current");
    expect(task(h.monitor, "task:2").health.acceptance).toBe("unknown");
  });

  it("copies every nested projection and reads without history, persistence, or inference", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    const baseline = board(h.monitor);
    const persisted = h.monitor.checkpoint();
    const counts = [
      h.reader.mock.calls.length,
      h.save.mock.calls.length,
      h.fetch.mock.calls.length,
      h.extract.mock.calls.length,
    ];
    const edited = board(h.monitor);
    const first = edited.tasks[0];
    if (!first) throw new Error("Missing task");
    first.label = "mutated";
    first.health.requirements = "mutated";
    first.provenance.state = "current";
    first.transitions.push({ kind: "mutated" });
    edited.tasks.reverse();
    edited.service.label = "mutated";
    for (let i = 0; i < 20; i++) expect(board(h.monitor)).toEqual(baseline);
    expect(h.monitor.checkpoint()).toEqual(persisted);
    expect([
      h.reader.mock.calls.length,
      h.save.mock.calls.length,
      h.fetch.mock.calls.length,
      h.extract.mock.calls.length,
    ]).toEqual(counts);
  });

  it("keeps all 200 retained tasks and 1000 task-local events reachable", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    const seed = h.monitor.state.tasks[0];
    const event = h.monitor.state.events[0];
    if (!seed || !event) throw new Error("Missing seed");
    h.monitor.state.tasks = Array.from({ length: 200 }, (_, i) => ({
      ...structuredClone(seed),
      id: `task:${i + 1}`,
      included: i < 20,
    }));
    h.monitor.state.nextTaskId = 201;
    h.monitor.state.events = Array.from({ length: 1000 }, (_, i) => ({
      ...structuredClone(event),
      id: `event:${i + 1}`,
      taskId: `task:${(i % 200) + 1}`,
      kind: i < 200 ? "create" : "revise",
    }));
    const value = board(h.monitor);
    expect(value.tasks).toHaveLength(200);
    expect(value.tasks[0]?.taskId).toBe("task:200");
    expect(value.tasks.at(-1)?.taskId).toBe("task:1");
    expect(value.tasks.filter((t) => t.status === "ARCHIVED")).toHaveLength(
      180,
    );
    expect(value.tasks.reduce((sum, t) => sum + t.transitions.length, 0)).toBe(
      1000,
    );
  });

  it("never exposes raw source IDs, hashes, errors or report/tool payloads", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    h.append(
      "PRIVATE_SOURCE_ID",
      "PRIVATE_REPORT_SENTINEL: now implementing parser.",
    );
    await h.settle("PRIVATE_SOURCE_ID");
    const snapshot = JSON.stringify(board(h.monitor));
    expect(snapshot).not.toContain("PRIVATE_SOURCE_ID");
    expect(snapshot).not.toContain("PRIVATE_REPORT_SENTINEL");
    for (const item of h.monitor.state.tasks) {
      expect(snapshot).not.toContain(item.source.messageHash);
      expect(snapshot).not.toContain(item.source.quoteHash);
    }
    expect(snapshot).not.toMatch(
      /requestHash|snapshotIdentity|messageHash|quoteHash|entryId/,
    );
  });
});

describe("task source provenance", () => {
  it("labels old same-task health replacement-pending while a newer report is being assessed", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    const before = task(h.monitor, "task:1").health;
    const transport = h.fetch.getMockImplementation();
    if (!transport) throw new Error("Missing transport");
    h.fetch.mockImplementation(async (url, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.questions.clarity) return new Promise<Response>(() => {});
      return transport(url, init);
    });
    h.append(
      "new-report",
      "Parser work has changed; reassess current implementation.",
    );
    await h.settle("new-report");
    expect(task(h.monitor, "task:1").health).toEqual(before);
    expect(task(h.monitor, "task:1").provenance.state).toBe(
      "replacement-pending",
    );
  });

  it("does not label an assessment current after its code/evidence identity changes", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    const calls = h.fetch.mock.calls.length;
    h.monitor.observeToolStart("edit-after-health", "edit", {
      path: "src/parser.ts",
    });
    h.monitor.observeToolEnd(
      "edit-after-health",
      "edit",
      {
        content: [{ type: "text", text: "Successfully edited src/parser.ts" }],
      },
      false,
    );
    expect(h.monitor.evidence.codeRevision()).toBeGreaterThan(0);
    expect(task(h.monitor, "task:1").provenance.state).not.toBe("current");
    // A validated evidence generation is a named health wake, not ownership.
    await vi.advanceTimersByTimeAsync(100);
    expect(h.fetch).toHaveBeenCalledTimes(calls + 3);
    expect(h.monitor.evidenceLink()).toBeUndefined();
  });

  it("publishes no old-source widget health at intermediate revised commit before completion settles", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    h.changed(true);
    const text = "Parser source restated at an intermediate boundary.";
    h.extract.mockResolvedValue({
      text: JSON.stringify({
        ...noPatch(),
        revise: [
          {
            id: "task:1",
            label: "Implement parser",
            requirementsChanged: false,
            quote: text,
          },
        ],
      }),
      provider: "offline",
      model: "fixture",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const transport = h.fetch.getMockImplementation();
    if (!transport) throw new Error("Missing transport");
    let completionHeld = false;
    h.fetch.mockImplementation(async (url, init) => {
      const request = JSON.parse(String(init?.body));
      if (
        Object.keys(request.questions).some((key) =>
          key.startsWith("complete:"),
        )
      ) {
        completionHeld = true;
        return new Promise<Response>(() => {});
      }
      return transport(url, init);
    });
    h.append("intermediate-revise", text, "user");
    await vi.advanceTimersByTimeAsync(100);
    expect(completionHeld).toBe(true);
    expect(h.monitor.state.tasks[0]?.source.entryId).toBe(
      "intermediate-revise",
    );
    expect(h.monitor.state.pending?.phase).toBe("complete");
    expect(task(h.monitor, "task:1").health).toEqual(unassessed);
    expect(h.monitor.presentationSnapshot().card).toBeUndefined();
  });

  it("same-label cosmetic revise cannot reuse stale health while replacement is unavailable", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    const before = structuredClone(h.monitor.state.tasks[0]);
    h.changed(true);
    h.extract.mockResolvedValue({
      text: JSON.stringify({
        ...noPatch(),
        revise: [
          {
            id: "task:1",
            label: "Implement parser",
            requirementsChanged: false,
            quote: "Parser requirements restated here.",
          },
        ],
      }),
      provider: "offline",
      model: "fixture",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const transport = h.fetch.getMockImplementation();
    if (!transport) throw new Error("Missing transport");
    h.fetch.mockImplementation(async (url, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.questions.clarity) throw new Error("PRIVATE_HEALTH_FAILURE");
      return transport(url, init);
    });
    h.append("cosmetic", "Parser requirements restated here.", "user");
    await h.settle("cosmetic");
    expect(h.monitor.state.tasks[0]).toMatchObject({
      id: before?.id,
      label: before?.label,
      revision: before?.revision,
    });
    expect(h.monitor.state.tasks[0]?.source).not.toEqual(before?.source);
    expect(task(h.monitor, "task:1").health).toEqual(unassessed);
    expect(task(h.monitor, "task:1").provenance.state).not.toBe("current");
    expect(JSON.stringify(board(h.monitor))).not.toContain(
      "PRIVATE_HEALTH_FAILURE",
    );
  });

  it.each(["amend", "remove"])(
    "invalidates a retained card when its health-only report is %s",
    async (change) => {
      const h = fixture();
      h.start();
      await h.settle("goal");
      h.append(
        "health-only-report",
        "Parser requirements and acceptance are explicit.",
      );
      await h.settle("health-only-report");
      h.focus("task:2");
      for (const id of ["switch-b", "later-b", "latest-b"]) {
        h.append(id, "Now working on regression task B.");
        await h.settle(id);
      }
      expect(task(h.monitor, "task:1").health.acceptance).toBe("explicit");
      const before = structuredClone(h.monitor.state);
      const calls = h.fetch.mock.calls.length;
      const entries = h.reader().flatMap((entry) => {
        if ((entry as { id?: string }).id !== "health-only-report")
          return [entry];
        return change === "remove"
          ? []
          : [
              branchEntry(
                "health-only-report",
                "Previous parser report was mistaken.",
                "assistant",
              ),
            ];
      });
      const publications = h.published.mock.calls.length;
      h.replace(entries);
      await vi.advanceTimersByTimeAsync(100);
      expect(h.published.mock.calls.length).toBeGreaterThan(publications);
      expect(task(h.monitor, "task:1").health).toEqual(unassessed);
      expect(h.monitor.state).toEqual(before);
      expect(h.fetch).toHaveBeenCalledTimes(calls);
    },
  );

  it("canonical amendment does not leak prior-source assessment into rebuilt tasks", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    h.acceptance("unknown");
    h.replace([
      branchEntry(
        "goal",
        "Implement parser using amended requirements and validate it.",
      ),
    ]);
    await h.settle("goal");
    expect(task(h.monitor, "task:1").health.acceptance.toLowerCase()).not.toBe(
      "explicit",
    );
  });
});

describe("truthful display status", () => {
  it("projects accepted focus independently of core status", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    expect(task(h.monitor, "task:1").status).toBe("INPROG");
    expect(task(h.monitor, "task:2").status).toBe("OPEN");
    expect(board(h.monitor).currentTask).toMatchObject({
      taskId: "task:1",
      status: "INPROG",
    });
    h.focus("task:2");
    h.append("switch", "Now writing the regression.");
    await h.settle("switch");
    expect(task(h.monitor, "task:1").status).toBe("OPEN");
    expect(task(h.monitor, "task:2").status).toBe("INPROG");
  });

  it("reopened task without accepted focus remains OPEN", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    const reopened = h.monitor.state.tasks.find((t) => t.id === "task:2");
    if (!reopened) throw new Error("Missing task");
    reopened.status = "reopened";
    expect(task(h.monitor, "task:2").status).toBe("OPEN");
  });

  it.each(["none", "uncertain", "concurrent"])(
    "shows an OPEN provisional selection, not inferred activity, for %s focus",
    async (focus) => {
      const h = fixture();
      h.start();
      await h.settle("goal");
      h.focus(focus);
      h.append(
        "ambiguous",
        "Activity is paused or spread across multiple tasks.",
      );
      await h.settle("ambiguous");
      expect(board(h.monitor).currentTask).toMatchObject({
        status: "OPEN",
        qualifier: "Selected · awaiting activity",
      });
      expect(board(h.monitor).tasks.every((t) => t.status === "OPEN")).toBe(
        true,
      );
    },
  );

  it("retains exact completed displayed task as qualified idle DONE, until newer work", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    h.focus("none");
    h.complete(["task:1", "task:2", "task:3"]);
    h.append("finished", "All three requested tasks are complete.");
    await h.settle("finished");
    expect(board(h.monitor).currentTask).toEqual({
      taskId: "task:1",
      status: "DONE",
      qualifier: "Last reported · idle",
    });
    expect(board(h.monitor).tasks.every((t) => t.status === "DONE")).toBe(true);
    h.append("new-work", "Investigate another parser boundary.", "user");
    expect(board(h.monitor).currentTask?.status).not.toBe("DONE");
    await h.settle("new-work");
    expect(board(h.monitor).currentTask?.status).not.toBe("DONE");
  });

  it("OFF/ON cannot resurrect idle DONE after work arrived while monitoring was off", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    h.focus("none");
    h.complete(["task:1", "task:2", "task:3"]);
    h.append("finished", "All three requested tasks are complete.");
    await h.settle("finished");
    expect(board(h.monitor).currentTask?.status).toBe("DONE");
    h.monitor.turnOff();
    h.append("off-work", "Investigate another parser boundary.", "user");
    const saves = h.save.mock.calls.length;
    h.monitor.turnOn("/nonexistent-hybrid-test");
    expect(h.save.mock.calls[saves]?.[0]).toBeDefined();
    expect(h.save.mock.calls[saves]?.[0]).not.toHaveProperty(
      "monitor.idleDoneTaskId",
    );
    expect(board(h.monitor).currentTask).toBeUndefined();
    await h.settle("off-work");
    expect(board(h.monitor).currentTask).toBeUndefined();
  });

  it("reload never resurrects an idle DONE invalidated by newer work", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    h.focus("none");
    h.complete(["task:1", "task:2", "task:3"]);
    h.append("finished", "All three requested tasks are complete.");
    await h.settle("finished");
    h.append("new-work", "Investigate another parser boundary.", "user");
    await h.settle("new-work");
    expect(board(h.monitor).currentTask).toBeUndefined();
    const checkpoint = h.monitor.checkpoint();
    h.monitor.stop();
    const fresh = monitorHarness(h.reader());
    running.push(fresh);
    await fresh.monitor.restore(
      "/nonexistent-hybrid-test",
      checkpoint,
      false,
      fresh.reader,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(board(fresh.monitor).currentTask).toBeUndefined();
    expect(fresh.fetch).not.toHaveBeenCalled();
    expect(fresh.extract).not.toHaveBeenCalled();
  });

  it("withdraws INPROG immediately while newer semantic work is unresolved", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    const transport = h.fetch.getMockImplementation();
    if (!transport) throw new Error("Missing transport");
    h.fetch.mockImplementation(async (url, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.questions.gate) throw new Error("provider unavailable");
      return transport(url, init);
    });
    h.append("pending", "Change task requirements.", "user");
    await vi.advanceTimersByTimeAsync(100);
    expect(task(h.monitor, "task:1").status).toBe("OPEN");
    expect(board(h.monitor).currentTask).toMatchObject({
      status: "OPEN",
      qualifier: "Selected · awaiting activity",
    });
    expect(
      board(h.monitor).tasks.every((item) => item.status !== "INPROG"),
    ).toBe(true);
  });

  it("archives keep distinct lifecycle status, retained health, and task-local transitions", async () => {
    const h = fixture();
    h.start();
    await h.settle("goal");
    const oldHealth = task(h.monitor, "task:1").health;
    h.changed(true);
    h.focus("task:2");
    h.extract.mockResolvedValue({
      text: JSON.stringify({
        ...noPatch(),
        archive: [{ id: "task:1", quote: "Parser task is no longer needed." }],
      }),
      provider: "offline",
      model: "fixture",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    h.append("archive", "Parser task is no longer needed.", "user");
    await h.settle("archive");
    expect(task(h.monitor, "task:1")).toMatchObject({
      included: false,
      status: "ARCHIVED",
      health: oldHealth,
    });
    expect(task(h.monitor, "task:1").transitions.map((t) => t.kind)).toContain(
      "archive",
    );
    expect(
      task(h.monitor, "task:2").transitions.map((t) => t.kind),
    ).not.toContain("archive");
  });
});
