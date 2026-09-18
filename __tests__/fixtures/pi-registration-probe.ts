import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MARKER = "PI_PROGRESS_REGISTRATION_OK";
const entry = resolve(
  fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
);

export default function probe(pi: ExtensionAPI) {
  let attempts = 0;
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts++;
    throw new Error("Offline registration probe blocks network");
  };
  pi.on("session_start", () => {
    const commands = pi
      .getCommands()
      .filter((command) => command.name === "progress");
    if (
      commands.length !== 1 ||
      commands[0]?.sourceInfo.path !== entry ||
      pi.getAllTools().some((tool) => tool.sourceInfo.path === entry)
    )
      throw new Error(
        "Expected exactly one package-owned command and no tools",
      );
  });
  pi.on("session_shutdown", () => {
    globalThis.fetch = fetch;
    if (attempts) throw new Error("Unexpected network attempt");
    process.stderr.write(`${MARKER}\n`);
  });
}
