import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as pinnedPi from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import progressBar from "../src/index";

const hashText = (text: string) =>
  createHash("sha256").update(text).digest("hex");

function latch() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function bounded(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Host probe stalled")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Ref = { id: string; role: string; hash: string };
type Snapshot = { hook: string; refs: Ref[]; disk: string; idle: boolean };

it.each([false, true])(
  "actual Pi delivers canonical users mid-turn and assistants at turn_end (production monitor=%s)",
  async (withMonitor) => {
    const {
      createAgentSession,
      DefaultResourceLoader,
      ModelRuntime,
      SessionManager,
      SettingsManager,
    } = process.env.PROGRESS_PI_HOST_ROOT
      ? ((await import(
          pathToFileURL(
            join(process.env.PROGRESS_PI_HOST_ROOT, "dist/index.js"),
          ).href
        )) as typeof pinnedPi)
      : pinnedPi;
    const cwd = await mkdtemp(join(tmpdir(), "progress-host-events-"));
    await writeFile(join(cwd, "evidence.txt"), "tool evidence");
    const firstStarted = latch();
    const secondStarted = latch();
    const firstRelease = latch();
    const secondRelease = latch();
    const snapshots: Snapshot[] = [];
    const errors: unknown[] = [];
    const manager = SessionManager.create(cwd, join(cwd, "sessions"));
    const assessed: string[] = [];
    const assessmentsComplete = latch();
    if (withMonitor) {
      vi.stubEnv("TYPESAFE_API_KEY", "offline-host-fixture");
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          expect(url).toBe("https://api.typesafe.ai/v1/systemone");
          const request = JSON.parse(String(init?.body));
          expect(Object.keys(request.questions)).toEqual(["gate"]);
          const id = request.state.latest.id as string;
          expect(
            manager
              .getBranch()
              .some((entry) => entry.type === "message" && entry.id === id),
          ).toBe(true);
          assessed.push(id);
          if (assessed.length === 4) assessmentsComplete.release();
          return Response.json({
            model: "jev-1.13.0",
            answers: {
              gate: {
                type: "choice",
                choice: "unchanged",
                confidence: 1,
                probabilities: Object.fromEntries(
                  Object.keys(request.questions.gate.criteria).map((key) => [
                    key,
                    key === "unchanged" ? 1 : 0,
                  ]),
                ),
              },
            },
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        }),
      );
    }
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const faux = fauxProvider({ provider: "progress-host-events" });
    runtime.registerNativeProvider(faux.provider);
    faux.setResponses([
      async () => {
        firstStarted.release();
        await firstRelease.promise;
        return fauxAssistantMessage(
          [
            { type: "text", text: "first answer" },
            fauxToolCall("read", { path: join(cwd, "evidence.txt") }),
          ],
          { stopReason: "toolUse" },
        );
      },
      async () => {
        secondStarted.release();
        await secondRelease.promise;
        return fauxAssistantMessage("second answer");
      },
    ]);
    const observe = (hook: string, ctx: ExtensionContext) => {
      const file = manager.getSessionFile();
      snapshots.push({
        hook,
        idle: ctx.isIdle(),
        disk: file && existsSync(file) ? readFileSync(file, "utf8") : "",
        refs: ctx.sessionManager.getBranch().flatMap((entry) => {
          if (entry.type !== "message" || !("content" in entry.message))
            return [];
          const content = entry.message.content;
          const text =
            typeof content === "string"
              ? content
              : content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("");
          return [
            { id: entry.id, role: entry.message.role, hash: hashText(text) },
          ];
        }),
      });
    };
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: join(cwd, "agent"),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        ...(withMonitor ? [progressBar] : []),
        (pi) => {
          pi.on("message_end", (event, ctx) =>
            observe(`message_end:${event.message.role}`, ctx),
          );
          pi.on("context", (_event, ctx) => {
            observe("context", ctx);
          });
          pi.on("turn_end", (_event, ctx) => observe("turn_end", ctx));
          pi.on("tool_execution_end", (_event, ctx) =>
            observe("tool_execution_end", ctx),
          );
          pi.on("agent_settled", (_event, ctx) =>
            observe("agent_settled", ctx),
          );
        },
      ],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir: join(cwd, "agent"),
      resourceLoader: loader,
      sessionManager: manager,
      settingsManager,
      modelRuntime: runtime,
      model: faux.getModel(),
      tools: ["read"],
      thinkingLevel: "off",
    });
    let running: Promise<void> | undefined;
    try {
      await session.bindExtensions({
        mode: "print",
        onError: (error) => errors.push(error),
      });
      running = session.prompt("root user");
      await bounded(
        Promise.race([
          firstStarted.promise,
          running.then(() => {
            throw new Error("No first stream");
          }),
        ]),
      );
      const rootContext = snapshots.find(
        (snapshot) => snapshot.hook === "context",
      );
      expect(rootContext).toMatchObject({
        idle: false,
        refs: [{ role: "user", hash: hashText("root user") }],
      });
      // Canonical manager acceptance is NOT initial-user filesystem durability.
      expect(rootContext?.disk).not.toContain("root user");
      expect(
        snapshots.find((snapshot) => snapshot.hook === "message_end:user")
          ?.refs,
      ).toEqual([]);

      await session.steer("steering user");
      firstRelease.release();
      await bounded(
        Promise.race([
          secondStarted.promise,
          running.then(() => {
            throw new Error("No steering stream");
          }),
        ]),
      );
      const contexts = snapshots.filter(
        (snapshot) => snapshot.hook === "context",
      );
      expect(contexts).toHaveLength(2);
      const steeringContext = contexts[1];
      expect(steeringContext?.idle).toBe(false);
      expect(steeringContext?.refs.map((ref) => ref.hash)).toEqual([
        hashText("root user"),
        hashText("first answer"),
        hashText("tool evidence"),
        hashText("steering user"),
      ]);
      expect(steeringContext?.disk).toContain("steering user");
      const steeringEnd = snapshots.filter(
        (snapshot) => snapshot.hook === "message_end:user",
      )[1];
      expect(steeringEnd?.refs.map((ref) => ref.hash)).not.toContain(
        hashText("steering user"),
      );
      expect(
        snapshots.some((snapshot) => snapshot.hook === "agent_settled"),
      ).toBe(false);

      secondRelease.release();
      await bounded(running);
      const final = snapshots.find(
        (snapshot) => snapshot.hook === "agent_settled",
      );
      expect(final?.refs.map((ref) => ref.hash)).toEqual([
        hashText("root user"),
        hashText("first answer"),
        hashText("tool evidence"),
        hashText("steering user"),
        hashText("second answer"),
      ]);
      expect(
        snapshots
          .filter((snapshot) => snapshot.hook === "turn_end")
          .map((snapshot) => snapshot.refs.length),
      ).toEqual([3, 5]);
      expect(
        snapshots
          .find((snapshot) => snapshot.hook === "tool_execution_end")
          ?.refs.map((ref) => ref.role),
      ).toEqual(["user", "assistant"]);
      expect(steeringContext?.refs.map((ref) => ref.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
        "user",
      ]);
      for (const snapshot of snapshots) {
        expect(new Set(snapshot.refs.map((ref) => ref.id)).size).toBe(
          snapshot.refs.length,
        );
        for (const ref of snapshot.refs)
          expect(final?.refs).toContainEqual(ref);
      }
      const file = manager.getSessionFile();
      if (!file) throw new Error("Missing file-backed session path");
      const disk = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        disk
          .filter((entry) => entry.type === "message")
          .map((entry) => entry.id),
      ).toEqual(final?.refs.map((ref) => ref.id));
      expect(errors).toEqual([]);
      expect(faux.state.callCount).toBe(2);
      if (withMonitor) {
        await bounded(assessmentsComplete.promise);
        const eligible =
          final?.refs
            .filter((ref) => ref.role === "user" || ref.role === "assistant")
            .map((ref) => ref.id) ?? [];
        expect([...assessed].sort()).toEqual([...eligible].sort());
        expect(assessed).toHaveLength(4);
        const requests = vi
          .mocked(fetch)
          .mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
        const optional = requests.filter((request) =>
          Object.keys(request.questions).some((key) =>
            [
              "currentCandidate",
              "historyCandidate",
              "currentTask",
              "historyTask",
            ].includes(key),
          ),
        );
        expect(requests.length - optional.length).toBe(4);
        expect(optional).toHaveLength(1);
        expect(optional[0].questions).toHaveProperty("currentCandidate");
        await session.prompt("/progress off");
      } else expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    } finally {
      firstRelease.release();
      secondRelease.release();
      await session.abort();
      await running?.catch(() => {});
      session.dispose();
      vi.unstubAllEnvs();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  15000,
);
