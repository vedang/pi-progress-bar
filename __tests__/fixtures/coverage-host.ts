import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as pinnedAi from "@earendil-works/pi-ai";
import * as pinnedPi from "@earendil-works/pi-coding-agent";

/** Host probes must use that host's provider protocol, not a different SDK's faux provider. */
export async function coverageHost() {
  const root = process.env.PROGRESS_PI_HOST_ROOT;
  if (!root) return { host: pinnedPi, ai: pinnedAi };
  const host = (await import(
    pathToFileURL(join(root, "dist/index.js")).href
  )) as typeof pinnedPi;
  const ai = (await import(
    pathToFileURL(join(root, "..", "pi-ai", "dist/index.js")).href
  )) as typeof pinnedAi;
  return { host, ai };
}
