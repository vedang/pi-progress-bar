import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { MAX_SOURCE_BYTES, parseChecklist } from "./checklist";

/** Deliberately reject symlinks, including internal ones, and private path components. */
export async function readSource(cwd: string, path: string, section?: string) {
  if (
    !path ||
    isAbsolute(path) ||
    path
      .split(/[\\/]/)
      .some(
        (part) =>
          part === ".." ||
          part.startsWith(".") ||
          /^(?:secrets?|credentials?)(?:[.-]|$)/i.test(part),
      ) ||
    !/\.md$/i.test(path)
  )
    throw new Error("Select a workspace-relative, non-secret Markdown file");
  const root = await realpath(cwd);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("Source outside workspace");
  let component = root;
  for (const part of rel.split(sep)) {
    component = resolve(component, part);
    if ((await lstat(component)).isSymbolicLink())
      throw new Error("Symlink sources are not allowed");
  }
  if ((await realpath(target)) !== target)
    throw new Error("Source realpath changed");
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_SOURCE_BYTES)
      throw new Error("Source must be a regular file at most 256 KiB");
    const bytes = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(target);
    if (
      size > MAX_SOURCE_BYTES ||
      size !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.isSymbolicLink() ||
      (await realpath(target)) !== target
    )
      throw new Error("Source changed during read; retry later");
    return parseChecklist(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
      {
        sourceId: `${rel}${section === undefined ? "" : `#${section}`}`,
        section,
      },
    );
  } finally {
    await handle.close();
  }
}
