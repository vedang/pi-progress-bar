import { describe, expect, it } from "vitest";
import { processObservation } from "../src/core/hybrid";
import { backend, initial, noPatch, observation } from "./fixtures/hybrid";

describe("hybrid task lifecycle", () => {
  it("withdraws only the targeted completed task using independent yes/no questions", async () => {
    const before = await initial(true);
    const p = backend(noPatch(), {
      gate: "unchanged",
      withdraw: { "task:2": "yes" },
    });
    const after = await processObservation(
      before,
      observation(
        "correction",
        "The regression is unfinished after all.",
        "assistant",
      ),
      p,
    );
    expect(after.tasks.map((task) => task.status)).toEqual([
      "done",
      "reopened",
      "done",
    ]);
    expect(after.tasks[1]?.latestAssessment).toMatchObject({
      rawChoice: "yes",
      reason: "accepted",
      source: { entryId: "correction" },
    });
    expect(
      p.evaluate.mock.calls.flatMap(([request]) =>
        Object.keys(request.questions),
      ),
    ).toEqual([
      "gate",
      "withdraw:task:1",
      "withdraw:task:2",
      "withdraw:task:3",
    ]);
    expect(before.tasks.every((task) => task.status === "done")).toBe(true);
  });
  it("retains completion through no new evidence and semantic uncertainty", async () => {
    const after = await processObservation(
      await initial(true),
      observation("unclear", "Perhaps something remains."),
      backend(noPatch(), {
        gate: "unchanged",
        withdraw: { "task:2": "uncertain" },
      }),
    );
    expect(after.tasks.every((task) => task.status === "done")).toBe(true);
    expect(after.tasks[1]?.latestAssessment).toMatchObject({
      rawChoice: "uncertain",
      reason: "semantic-unknown",
    });
  });
  it.each([false, true])(
    "revises in place and changes completion only when requirements change=%s",
    async (requirementsChanged) => {
      const before = await initial(true);
      const message = observation("revision", "Update the parser requirement.");
      const patch = {
        ...noPatch(),
        revise: [
          {
            id: "task:1",
            label: "Implement Unicode parser",
            requirementsChanged,
            quote: message.text,
          },
        ],
      };
      const after = await processObservation(before, message, backend(patch));
      expect(after.scopeError).toBeUndefined();
      expect(after.tasks[0]).toMatchObject({
        id: "task:1",
        label: "Implement Unicode parser",
        status: requirementsChanged ? "not-started" : "done",
        revision: requirementsChanged ? 2 : 1,
      });
      expect(after.nextTaskId).toBe(before.nextTaskId);
      expect(after.tasks.slice(1).map((task) => task.status)).toEqual([
        "done",
        "done",
      ]);
      expect(before.tasks[0]?.label).toBe("Implement parser");
    },
  );
  it("archives without claiming completion and clears an archived focus", async () => {
    const before = await initial();
    const message = observation("cancel", "Drop the parser task.");
    const p = backend(
      {
        ...noPatch(),
        archive: [{ id: "task:1", quote: message.text }],
      },
      { focus: "none" },
    );
    const after = await processObservation(before, message, p);
    expect(after.tasks[0]).toMatchObject({
      included: false,
      status: "not-started",
    });
    expect(after.tasks.filter((task) => task.included)).toHaveLength(2);
    expect(after.focusTaskId).toBeUndefined();
    expect(
      p.evaluate.mock.calls.flatMap(([request]) =>
        Object.keys(request.questions),
      ),
    ).not.toContain("complete:task:1");
  });
  it.each([false, true])(
    "restores the same archived ID with requirementsChanged=%s",
    async (requirementsChanged) => {
      const archive = observation("archive", "Archive the parser task.");
      const archived = await processObservation(
        await initial(true),
        archive,
        backend({
          ...noPatch(),
          archive: [{ id: "task:1", quote: archive.text }],
        }),
      );
      const restore = observation("restore", "Bring the parser task back.");
      const after = await processObservation(
        archived,
        restore,
        backend({
          ...noPatch(),
          restore: [
            {
              id: "task:1",
              label: "Implement Unicode parser",
              requirementsChanged,
              quote: restore.text,
            },
          ],
        }),
      );
      expect(after.scopeError).toBeUndefined();
      expect(after.tasks).toHaveLength(3);
      expect(after.tasks[0]).toMatchObject({
        id: "task:1",
        included: true,
        status: requirementsChanged ? "not-started" : "done",
        revision: requirementsChanged ? 2 : 1,
      });
      expect(after.nextTaskId).toBe(4);
      expect(after.focusTaskId).toBe(
        requirementsChanged ? "task:1" : undefined,
      );
    },
  );
  it("can complete revised requirements in the same report", async () => {
    const message = observation(
      "revised-delivery",
      "The Unicode parser requirement is now implemented.",
      "assistant",
    );
    const after = await processObservation(
      await initial(true),
      message,
      backend(
        {
          ...noPatch(),
          revise: [
            {
              id: "task:1",
              label: "Implement Unicode parser",
              requirementsChanged: true,
              quote: message.text,
            },
          ],
        },
        { complete: { "task:1": "yes" } },
      ),
    );
    expect(after.tasks[0]).toMatchObject({
      id: "task:1",
      revision: 2,
      status: "done",
    });
    expect(after.tasks[0]?.latestAssessment?.source.entryId).toBe(message.id);
  });
  it.each(["unknown", "duplicate", "restore-active"])(
    "rejects invalid lifecycle patch atomically: %s",
    async (variant) => {
      const before = await initial(true);
      const message = observation("invalid", "Change the work scope.");
      const patch = noPatch();
      if (variant === "restore-active")
        patch.restore.push({
          id: "task:1",
          label: "Parser",
          requirementsChanged: false,
          quote: message.text,
        });
      else
        patch.revise.push({
          id: variant === "unknown" ? "task:99" : "task:1",
          label: "Parser",
          requirementsChanged: true,
          quote: message.text,
        });
      if (variant === "duplicate")
        patch.archive.push({ id: "task:1", quote: message.text });
      const after = await processObservation(before, message, backend(patch));
      expect(after.pending?.block).toEqual({
        present: true,
        value: "invalid-patch",
      });
      expect(after.cursor).toEqual(before.cursor);
      expect(
        after.tasks.map(({ latestAssessment: _, ...task }) => task),
      ).toEqual(before.tasks.map(({ latestAssessment: _, ...task }) => task));
    },
  );
  it("keeps immutable operation evidence without events for no-change judgments", async () => {
    const before = await initial();
    const oldEvents = structuredClone(before.events);
    expect(oldEvents.map((event) => event.kind)).toEqual([
      "create",
      "create",
      "create",
    ]);
    const message = observation(
      "done",
      "The parser is implemented.",
      "assistant",
    );
    const after = await processObservation(
      before,
      message,
      backend(noPatch(), { gate: "unchanged", complete: { "task:1": "yes" } }),
    );
    expect(before.events).toEqual(oldEvents);
    expect(after.events.slice(0, oldEvents.length)).toEqual(oldEvents);
    expect(after.events.at(-1)).toMatchObject({
      kind: "complete",
      taskId: "task:1",
      revision: 1,
      source: { entryId: "done" },
    });
    expect(new Set(after.events.map((event) => event.id)).size).toBe(
      after.events.length,
    );
    const unchanged = await processObservation(
      after,
      observation("ack", "Thanks."),
      backend(noPatch(), { gate: "unchanged" }),
    );
    expect(unchanged.events).toEqual(after.events);
    expect(unchanged.tasks[0]?.latestAssessment?.source.entryId).toBe("ack");
  });
});
