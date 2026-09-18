import { createHash } from "node:crypto";
import type { SourceSnapshot, SourceTask } from "../core/types";

export const MAX_SOURCE_BYTES = 256 * 1024;
export const MAX_TASKS = 200;

/** Parse only direct checklist items; offsets are UTF-16 source offsets. */
export function parseChecklist(
  text: string,
  options: { sourceId: string; section?: string },
): SourceSnapshot {
  if (!options.sourceId || Buffer.byteLength(text, "utf8") > MAX_SOURCE_BYTES) {
    throw new Error("Missing source identity or checklist exceeds 256 KiB");
  }
  const lines = text.split(/\r?\n/);
  const visible: { text: string; start: number; end: number }[] = [];
  let offset = 0;
  let fence: { char: string; length: number } | undefined;
  for (const line of lines) {
    const start = offset;
    offset +=
      line.length +
      (text.slice(offset + line.length).startsWith("\r\n") ? 2 : 1);
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1]?.[0] === fence.char &&
        marker[1].length >= fence.length &&
        !marker[2]?.trim()
      )
        fence = undefined;
      visible.push({ text: "", start, end: start + line.length });
    } else if (
      marker &&
      !(marker[1]?.[0] === "`" && marker[2]?.includes("`"))
    ) {
      fence = { char: marker[1]?.[0] ?? "`", length: marker[1]?.length ?? 3 };
      visible.push({ text: "", start, end: start + line.length });
    } else visible.push({ text: line, start, end: start + line.length });
  }
  const heading = (line: string) =>
    /^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/.exec(line);
  let start = 0;
  let end = visible.length;
  if (options.section !== undefined) {
    const matches = visible.flatMap((line, index) => {
      const match = heading(line.text);
      const title = match?.[2]?.replace(/[ \t]+#+[ \t]*$/, "").trim() ?? "";
      return match && title === options.section
        ? [{ index, level: match[1]?.length ?? 1 }]
        : [];
    });
    if (matches.length !== 1)
      throw new Error("Selected ATX section missing or ambiguous");
    const selected = matches[0];
    if (!selected) throw new Error("Missing section");
    start = selected.index + 1;
    for (let i = start; i < visible.length; i++) {
      const match = heading(visible[i]?.text ?? "");
      if (match && (match[1]?.length ?? 1) <= selected.level) {
        end = i;
        break;
      }
    }
  }
  const tasks: SourceTask[] = [];
  const anchors = new Set<string>();
  const identities = new Set<string>();
  let blocks = 0;
  let inBlock = false;
  let owner: SourceTask | undefined;
  for (const line of visible.slice(start, end)) {
    const match = /^- \[([ xX])\][ \t]+(.*)$/.exec(line.text);
    if (match) {
      if (!inBlock) blocks++;
      inBlock = true;
      const raw = match[2] ?? "";
      const markers = [
        ...raw.matchAll(/<!--\s*progress:id=([A-Za-z0-9_.:-]+)\s*-->/g),
      ];
      if (
        markers.length > 1 ||
        (raw.includes("progress:id") && markers.length !== 1)
      )
        throw new Error("Invalid task anchor");
      const anchor = markers[0]?.[1];
      const taskText = raw
        .replace(/<!--\s*progress:id=([A-Za-z0-9_.:-]+)\s*-->/g, "")
        .trim();
      if (!taskText) throw new Error("Empty checklist task");
      const identity = anchor ? `anchor:${anchor}` : `text:${taskText}`;
      if ((anchor && anchors.has(anchor)) || identities.has(identity))
        throw new Error("Duplicate or ambiguous checklist task");
      if (anchor) anchors.add(anchor);
      identities.add(identity);
      owner = {
        text: taskText,
        status: match[1] === " " ? "not-started" : "done",
        ...(anchor ? { anchor } : {}),
        criteria: [],
        ref: {
          sourceId: options.sourceId,
          start: line.start,
          end: line.end,
          provenance: "file-marker",
        },
      };
      tasks.push(owner);
      if (tasks.length > MAX_TASKS)
        throw new Error("Checklist exceeds 200 tasks");
    } else if (
      /^(?:[-+*](?:\s|$)|\d+[.)](?:\s|$)|\[[^\]]*\])/.test(line.text)
    ) {
      throw new Error("Unsupported or mixed direct task-list syntax");
    } else if (/^[ \t]+\S/.test(line.text) && owner && !heading(line.text)) {
      owner.criteria.push(line.text.trim());
    } else if (line.text.trim()) {
      inBlock = false;
      owner = undefined;
    }
  }
  if (options.section === undefined && blocks !== 1)
    throw new Error("Whole document requires one unambiguous direct task list");
  return {
    sourceId: options.sourceId,
    kind: "checklist",
    revision: createHash("sha256").update(text).digest("hex"),
    complete: true,
    tasks,
  };
}
