import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBeadsExport } from "../src/sources/beads";

const roots: string[] = [];
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

describe("read-only Beads export", () => {
  it("reads every valid record without assigning task authority", async () => {
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
    expect(exportData.complete).toBe(true);
    expect([...exportData.records.values()]).toEqual([
      {
        id: "proj-123",
        title: "Build parser",
        status: "open",
        issueType: "task",
        parentIds: [],
      },
      {
        id: "proj-epic",
        title: "Container",
        status: "open",
        issueType: "epic",
        parentIds: [],
      },
      {
        id: "proj-124",
        title: "Other backlog",
        status: "closed",
        issueType: "task",
        parentIds: [],
      },
    ]);
    const empty = await readBeadsExport(await workspace([]));
    expect(empty.complete).toBe(true);
    expect(empty.records.size).toBe(0);
  });

  it.each([
    "missing",
    "malformed-json",
    "malformed-record",
    "duplicate",
    "directory-symlink",
    "file-symlink",
  ] as const)(
    "rejects %s exports without retaining partial records",
    async (kind) => {
      const cwd = await mkdtemp(join(tmpdir(), "progress-beads-invalid-"));
      roots.push(cwd);
      const records = [{ id: "proj-123", title: "A", status: "closed" }];
      if (kind === "directory-symlink" || kind === "file-symlink") {
        const outside = await workspace(records);
        if (kind === "directory-symlink") {
          await symlink(join(outside, ".beads"), join(cwd, ".beads"));
        } else {
          await mkdir(join(cwd, ".beads"));
          await symlink(
            join(outside, ".beads", "issues.jsonl"),
            join(cwd, ".beads", "issues.jsonl"),
          );
        }
      } else if (kind !== "missing") {
        await mkdir(join(cwd, ".beads"));
        const invalid =
          kind === "malformed-json"
            ? "{"
            : JSON.stringify(
                kind === "duplicate"
                  ? records[0]
                  : { id: "proj-124", title: "B", status: "invalid" },
              );
        await writeFile(
          join(cwd, ".beads", "issues.jsonl"),
          `${JSON.stringify(records[0])}\n${invalid}\n`,
        );
      }
      const result = await readBeadsExport(cwd);
      expect(result.complete).toBe(false);
      expect(result.records.size).toBe(0);
    },
  );
});
