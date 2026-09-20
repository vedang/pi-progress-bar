import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const hostRoot =
  process.env.PROGRESS_PI_HOST_ROOT ??
  join(root, "node_modules/@earendil-works/pi-coding-agent");

it.each(["print", "json", "rpc"] as const)(
  "actual Pi CLI %s advisory transport preserves custom provenance",
  async (mode) => {
    const cwd = await mkdtemp(join(tmpdir(), "advisory-cli-"));
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PI_CODING_AGENT_DIR: cwd,
        PI_OFFLINE: "1",
      };
      delete env.TYPESAFE_API_KEY;
      delete env.PI_CODING_AGENT_SESSION_DIR;
      const args = [
        join(
          hostRoot,
          JSON.parse(readFileSync(join(hostRoot, "package.json"), "utf8")).bin
            .pi,
        ),
        "--no-extensions",
        "-e",
        join(root, "__tests__/fixtures/advisory-mode-probe.ts"),
        "--offline",
        "--no-session",
        "--no-skills",
        "--no-prompt-templates",
        "--provider",
        "advisory-probe",
        "--model",
        "faux-1",
        "--thinking",
        "off",
        ...(mode === "print" ? ["-p"] : ["--mode", mode]),
        ...(mode === "rpc" ? [] : ["Independent request"]),
      ];
      let stdout = "",
        stderr = "";
      let code: number | null;
      if (mode === "rpc") {
        const child = spawn(process.execPath, args, {
          cwd,
          env,
          stdio: "pipe",
        });
        code = await new Promise<number | null>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`RPC probe timeout: ${stderr}`));
          }, 10000);
          child.stdout.on("data", (chunk) => {
            stdout += chunk;
          });
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
            if (stderr.includes('"probe":"advisory-settled"'))
              child.stdin.end();
          });
          child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.on("close", (status) => {
            clearTimeout(timer);
            resolve(status);
          });
          child.stdin.write(
            `${JSON.stringify({ id: "probe", type: "prompt", message: "Independent request" })}\n`,
          );
        });
      } else {
        const child = spawnSync(process.execPath, args, {
          cwd,
          env,
          encoding: "utf8",
          timeout: 10000,
        });
        expect(child.error, child.stderr).toBeUndefined();
        stdout = child.stdout;
        stderr = child.stderr;
        code = child.status;
      }
      expect(code, stderr).toBe(0);
      const receipts = stderr
        .split("\n")
        .filter((line) => line.startsWith('{"probe":'))
        .map((line) => JSON.parse(line));
      expect(receipts).toHaveLength(2);
      expect(receipts[1]).toMatchObject({
        probe: "advisory-shutdown",
        armed: true,
      });
      expect(stderr).not.toContain("UNEXPECTED_IDLE_DEADLINE");
      expect(receipts[0]).toMatchObject({
        probe: "advisory-settled",
        mode,
        calls: 2,
        custom: [
          {
            customType: "pi-progress-advisory",
            display: true,
            content: "[Progress advisory] Status reconciliation only.",
            details: { opportunityId: "probe-1", sendId: "probe-send-1" },
          },
        ],
      });
      if (mode !== "print") {
        const events = stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(
          events.filter(
            (e) => e.type === "message_end" && e.message?.role === "custom",
          ),
        ).toMatchObject([
          {
            message: {
              customType: "pi-progress-advisory",
              display: true,
              content: "[Progress advisory] Status reconciliation only.",
              details: { opportunityId: "probe-1", sendId: "probe-send-1" },
            },
          },
        ]);
        expect(events.filter((e) => e.type === "agent_settled")).toHaveLength(
          1,
        );
      } else {
        expect(stdout).toContain("Status answer: pending.");
        // Print emits final assistant text, not custom rendering. H0 records this
        // limitation; display:true is not a claim of printable custom-message UI.
        expect(stdout).not.toContain("[Progress advisory]");
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  15000,
);
