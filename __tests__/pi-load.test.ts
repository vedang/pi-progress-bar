import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { MARKER } from "./fixtures/pi-registration-probe";

it("loads and shuts down the real Pi package offline without tools or network", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-progress-smoke-"));
  try {
    await writeFile(join(agentDir, "auth.json"), "{}\n", { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
    };
    delete env.TYPESAFE_API_KEY;
    delete env.PI_CODING_AGENT_SESSION_DIR;
    const child = spawnSync(
      join(root, "node_modules/.bin/pi"),
      [
        "--no-extensions",
        "-e",
        root,
        "-e",
        join(root, "__tests__/fixtures/pi-registration-probe.ts"),
        "--offline",
        "--no-session",
        "--mode",
        "rpc",
      ],
      { cwd: agentDir, env, input: "", encoding: "utf8", timeout: 10000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe("");
    expect(child.stderr.trim()).toBe(MARKER);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}, 15000);
