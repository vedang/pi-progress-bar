import { expect, it } from "vitest";
import { CoverageAdapter } from "../src/sources/coverage";

const xml = '<workbook><sheets><sheet name="One"/></sheets></workbook>';
const result = (id: string, text: string, toolName = "bash") => ({
  type: "message",
  id: `result-${id}`,
  message: {
    role: "toolResult",
    toolCallId: id,
    toolName,
    isError: false,
    content: [{ type: "text", text }],
  },
});
function fixture() {
  const adapter = new CoverageAdapter();
  const entries: ReturnType<typeof result>[] = [];
  function start(id: string, toolName: string, args: Record<string, unknown>) {
    adapter.start({ toolCallId: id, toolName, args }, 1);
  }
  function run(
    id: string,
    toolName: string,
    args: Record<string, unknown>,
    text: string,
  ) {
    start(id, toolName, args);
    adapter.end({ toolCallId: id, toolName }, 1);
    entries.push(result(id, text, toolName));
    return adapter.confirm(entries, 1);
  }
  function map(path = "docs/one.xlsx", suffix = "") {
    run(
      `manifest${suffix}`,
      "bash",
      { command: `unzip -p ${path} xl/workbook.xml` },
      xml,
    );
    run(
      `write${suffix}`,
      "write",
      { path: `export${suffix}.sh`, content: "script" },
      "written",
    );
    run(`read${suffix}`, "read", { path: `export${suffix}.sh` }, "script");
    return run(
      `list${suffix}`,
      "bash",
      { command: `bash export${suffix}.sh ${path}` },
      "One rows 2 nonempty rows 1 file extracted/one.txt",
    );
  }
  return { adapter, entries, start, run, map };
}
it("recognizes a single-file literal sed read", () => {
  const f = fixture();
  f.map();
  f.start("sed", "bash", { command: "sed -n '1,20p' extracted/one.txt" });
  expect(f.adapter.activity()).toHaveLength(1);
});
it("clears active access when its canonical mapping authority disappears", () => {
  const f = fixture();
  f.map();
  f.start("cat", "bash", { command: "cat extracted/one.txt" });
  expect(f.adapter.activity()).toHaveLength(1);
  f.adapter.confirm(
    f.entries.filter((entry) => entry.id !== "result-list"),
    1,
  );
  expect(f.adapter.activity()).toEqual([]);
});
it("does not read unrelated canonical tool payloads during bounded confirmation", () => {
  const f = fixture();
  const unrelated = result("unrelated", "");
  let reads = 0;
  Object.defineProperty(unrelated.message, "content", {
    get: () => {
      reads++;
      return [{ type: "text", text: "x".repeat(33000) }];
    },
  });
  f.entries.push(unrelated);
  expect(
    f.run(
      "manifest",
      "bash",
      { command: "unzip -p docs/one.xlsx xl/workbook.xml" },
      xml,
    ).inventories,
  ).toHaveLength(1);
  expect(reads).toBe(0);
});
it("does not reaccept the same canonical call after duplicate start/end delivery", () => {
  const f = fixture();
  f.run(
    "manifest",
    "bash",
    { command: "unzip -p docs/one.xlsx xl/workbook.xml" },
    xml,
  );
  f.start("manifest", "bash", {
    command: "unzip -p docs/one.xlsx xl/workbook.xml",
  });
  f.adapter.end({ toolCallId: "manifest", toolName: "bash" }, 1);
  expect(f.adapter.confirm(f.entries, 1).inventories).toEqual([]);
});
it("rejects invalid workbook root attributes instead of treating malformed XML as inventory", () => {
  const f = fixture();
  expect(
    f.run(
      "manifest",
      "bash",
      { command: "unzip -p docs/one.xlsx xl/workbook.xml" },
      xml.replace("<workbook>", "<workbook broken>"),
    ).inventories,
  ).toEqual([]);
});
it("cannot overwrite same-file ownership across separate workbook mappings", () => {
  const f = fixture();
  f.map();
  f.map("docs/two.xlsx", "2");
  f.start("cat", "bash", { command: "cat extracted/one.txt" });
  expect(f.adapter.activity()).toEqual([]);
});
it("requires script attestation to precede invocation, not merely exist by confirmation", () => {
  const f = fixture();
  f.run(
    "manifest",
    "bash",
    { command: "unzip -p docs/one.xlsx xl/workbook.xml" },
    xml,
  );
  f.start("write", "write", { path: "export.sh", content: "script" });
  f.adapter.end({ toolCallId: "write", toolName: "write" }, 1);
  f.start("read", "read", { path: "export.sh" });
  f.adapter.end({ toolCallId: "read", toolName: "read" }, 1);
  f.start("list", "bash", { command: "bash export.sh docs/one.xlsx" });
  f.adapter.end({ toolCallId: "list", toolName: "bash" }, 1);
  // Pending insertion order cannot overrule canonical chronology.
  f.entries.push(
    result("list", "One rows 2 nonempty rows 1 file extracted/one.txt"),
    result("write", "written", "write"),
    result("read", "script", "read"),
  );
  expect(f.adapter.confirm(f.entries, 1).access).toEqual([]);
});
