import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSource } from "../src/sources/read-source";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "progress-source-"));
  roots.push(dir);
  return dir;
}
describe("bounded source read", () => {
  it("returns a complete checklist source inside approved workspace", async () => {
    const cwd = await temp();
    await writeFile(join(cwd, "plan.md"), "# Tasks\n- [x] A\n- [ ] B");
    const result = await readSource(cwd, "plan.md", "Tasks");
    expect(result.complete).toBe(true);
    expect(result.tasks).toHaveLength(2);
  });
  it("rejects escape, symlink escape, secrets, directories and oversized files", async () => {
    const cwd = await temp();
    const outside = await temp();
    await writeFile(join(outside, "private.md"), "# Tasks\n- [x] Secret");
    await symlink(join(outside, "private.md"), join(cwd, "link.md"));
    await writeFile(join(cwd, ".env"), "# Tasks\n- [x] Secret");
    await writeFile(join(cwd, "huge.md"), "a".repeat(256 * 1024 + 1));
    for (const path of [
      join(outside, "private.md"),
      "../outside.md",
      "link.md",
      ".env",
      ".",
      "huge.md",
    ])
      await expect(readSource(cwd, path, "Tasks")).rejects.toThrow();
  });
});
