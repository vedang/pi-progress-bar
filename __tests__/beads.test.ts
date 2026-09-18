import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Task } from "../src/core/types";
import { enrichBeadsTasks, readBeadsExport } from "../src/sources/beads";

const roots: string[] = [];
const task = (text: string): Task => ({
  id: "task-1",
  text,
  status: "not-started",
  criteria: [],
  included: true,
  ref: {
    sourceId: "conversation:goal",
    entryId: "goal",
    start: 0,
    end: text.length,
    provenance: "user",
  },
});
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function workspace(lines: object[]) {
  const root = await mkdtemp(join(tmpdir(), "progress-beads-"));
  roots.push(root);
  await mkdir(join(root, ".beads"));
  await writeFile(
    join(root, ".beads", "issues.jsonl"),
    lines.map((line) => JSON.stringify(line)).join("\n"),
  );
  return root;
}

describe("read-only Beads enrichment", () => {
  it("grounds only exact IDs already present in admitted tasks", async () => {
    const cwd = await workspace([
      {
        id: "proj-123",
        title: "Build parser",
        status: "open",
        issue_type: "task",
      },
      {
        id: "proj-epic",
        title: "Container",
        status: "open",
        issue_type: "epic",
      },
      {
        id: "proj-124",
        title: "Other backlog",
        status: "closed",
        issue_type: "task",
      },
    ]);
    const exportData = await readBeadsExport(cwd);
    const enriched = enrichBeadsTasks([task("Implement proj-123")], exportData);
    expect(enriched[0]?.beads).toMatchObject({
      id: "proj-123",
      title: "Build parser",
      exportStatus: "open",
    });
    expect(enriched).toHaveLength(1);
    expect(JSON.stringify(enriched)).not.toContain("proj-124");
  });

  it("leaves missing, malformed, duplicate, and symlink exports incomplete without status authority", async () => {
    const missing = await readBeadsExport(await workspace([]));
    expect(
      enrichBeadsTasks([task("Implement proj-123")], missing)[0]?.status,
    ).toBe("not-started");
    const duplicateRoot = await workspace([
      { id: "proj-123", title: "A", status: "closed" },
      { id: "proj-123", title: "B", status: "open" },
    ]);
    expect((await readBeadsExport(duplicateRoot)).complete).toBe(false);
    const outside = await workspace([
      { id: "proj-123", title: "A", status: "closed" },
    ]);
    const linked = await mkdtemp(join(tmpdir(), "progress-beads-link-"));
    roots.push(linked);
    await mkdir(join(linked, ".beads"));
    await symlink(
      join(outside, ".beads", "issues.jsonl"),
      join(linked, ".beads", "issues.jsonl"),
    );
    expect((await readBeadsExport(linked)).complete).toBe(false);
  });

  it("never lets closed export status complete conversation-reported work", async () => {
    const cwd = await workspace([
      {
        id: "proj-123",
        title: "Build parser",
        status: "closed",
        issue_type: "task",
      },
    ]);
    const enriched = enrichBeadsTasks(
      [task("Implement proj-123")],
      await readBeadsExport(cwd),
    );
    expect(enriched[0]?.status).toBe("not-started");
    expect(enriched[0]?.beads?.conflict).toBe(true);
  });
});
