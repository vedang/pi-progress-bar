import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { Task } from "../core/types";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 10_000;
interface BeadsRecord {
  id: string;
  title: string;
  status?: "open" | "in_progress" | "blocked" | "deferred" | "closed";
  issueType?: string;
  parentIds: string[];
}
export interface BeadsExport {
  complete: boolean;
  records: Map<string, BeadsRecord>;
  note: string;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Bounded stable read of conventional beads_rust JSONL; no CLI or database access. */
export async function readBeadsExport(cwd: string): Promise<BeadsExport> {
  const unavailable = (note: string): BeadsExport => ({
    complete: false,
    records: new Map(),
    note,
  });
  try {
    const root = await realpath(cwd);
    const target = resolve(root, ".beads", "issues.jsonl");
    const rel = relative(root, target);
    if (rel.startsWith(`..${sep}`)) return unavailable("outside workspace");
    if ((await lstat(join(root, ".beads"))).isSymbolicLink())
      return unavailable("symlink path unsupported");
    if ((await lstat(target)).isSymbolicLink())
      return unavailable("symlink export unsupported");
    if ((await realpath(target)) !== target)
      return unavailable("export realpath changed");
    const handle = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_BYTES)
        return unavailable("export is not a bounded regular file");
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const part = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!part.bytesRead) break;
        offset += part.bytesRead;
      }
      const after = await handle.stat();
      if (
        offset !== before.size ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        return unavailable("export changed during read");
      const lines = new TextDecoder("utf-8", { fatal: true })
        .decode(bytes)
        .split(/\r?\n/)
        .filter(Boolean);
      if (lines.length > MAX_RECORDS) return unavailable("too many records");
      const records = new Map<string, BeadsRecord>();
      for (const line of lines) {
        const value: unknown = JSON.parse(line);
        if (
          !record(value) ||
          typeof value.id !== "string" ||
          !value.id ||
          typeof value.title !== "string" ||
          !value.title ||
          (value.status !== undefined &&
            !["open", "in_progress", "blocked", "deferred", "closed"].includes(
              String(value.status),
            )) ||
          (value.issue_type !== undefined &&
            typeof value.issue_type !== "string") ||
          (value.dependencies !== undefined &&
            !Array.isArray(value.dependencies)) ||
          records.has(value.id)
        )
          return unavailable("malformed or duplicate record");
        records.set(value.id, {
          id: value.id,
          title: value.title,
          ...(typeof value.status === "string"
            ? { status: value.status as BeadsRecord["status"] }
            : {}),
          ...(typeof value.issue_type === "string"
            ? { issueType: value.issue_type }
            : {}),
          parentIds: Array.isArray(value.dependencies)
            ? value.dependencies.flatMap((dependency) =>
                record(dependency) &&
                dependency.type === "parent-child" &&
                typeof dependency.depends_on_id === "string"
                  ? [dependency.depends_on_id]
                  : [],
              )
            : [],
        });
      }
      return {
        complete: true,
        records,
        note: "bounded beads_rust JSONL export",
      };
    } finally {
      await handle.close();
    }
  } catch {
    return unavailable("Beads export unavailable or unsupported");
  }
}

/** A readable file is still incomplete when it drops current grounded records. */
export function hasGroundedBeadsRecords(
  tasks: readonly Task[],
  source: BeadsExport,
): boolean {
  return tasks.every(
    (task) => !task.beads || source.records.has(task.beads.id),
  );
}

export function enrichBeadsTasks(tasks: Task[], source: BeadsExport): Task[] {
  const grounded = tasks.map((task) => {
    const { beads: _stale, ...plain } = task;
    const ids = task.text.match(/[A-Za-z0-9][A-Za-z0-9._-]{2,127}/g) ?? [];
    const matches = [...new Set(ids)].flatMap((id) => {
      const item = source.records.get(id);
      return item ? [item] : [];
    });
    const issue = matches.length === 1 ? matches[0] : undefined;
    if (!issue) return plain as Task;
    return {
      ...plain,
      beads: {
        id: issue.id,
        title: issue.title,
        ...(issue.status ? { exportStatus: issue.status } : {}),
        ...(issue.issueType ? { issueType: issue.issueType } : {}),
        conflict:
          issue.status === undefined
            ? false
            : (issue.status === "closed") !== (task.status === "done"),
      },
    } as Task;
  });
  const activeIds = new Set(
    grounded
      .filter((task) => task.included)
      .flatMap((task) => task.beads?.id ?? []),
  );
  const seen = new Set<string>();
  return grounded.map((task) => {
    const id = task.beads?.id;
    if (!id) return task;
    const issue = source.records.get(id);
    const childActive = [...source.records.values()].some(
      (candidate) =>
        activeIds.has(candidate.id) && candidate.parentIds.includes(id),
    );
    const duplicate = seen.has(id);
    seen.add(id);
    return {
      ...task,
      included:
        task.included &&
        !duplicate &&
        !(issue?.issueType === "epic" && childActive),
    };
  });
}
