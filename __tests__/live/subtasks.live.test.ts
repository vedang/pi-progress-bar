import { createHash } from "node:crypto";
import {
  appendFileSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { type EvaluationRequest, JevGateway } from "../../src/analysis/gateway";
import { buildSubtaskGate } from "../../src/analysis/subtask-gate";
import type { HybridTask, Observation } from "../../src/core/hybrid-state";
import {
  SubtaskRuntime,
  type SubtaskRuntimeCheckpoint,
} from "../../src/core/subtask-runtime";
import { selectedModelSubtasks } from "../../src/core/subtask-selected-model";
import { SubtaskStore } from "../../src/core/subtasks";

const mode = process.env.PROGRESS_C10_MODE;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function sources(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((item) => {
        const path = join(dir, item.name);
        return item.isDirectory()
          ? Object.entries(sources(path))
          : [[path, hash(readFileSync(path, "utf8"))]];
      }),
  );
}
type Case = {
  id: string;
  label: string;
  request: string;
  need: "yes" | "no" | "abstain";
  requiredConcepts: string[];
  forbiddenScope?: string[];
  reports: {
    text: string;
    completedConcepts: string[];
    blockedConcepts?: string[];
    uncertainConcepts?: string[];
  }[];
};
function fixture(item: Case, selectedModel: string) {
  let latest: Observation = {
    id: "request",
    role: "user",
    text: item.request,
    hash: hash(item.request),
  };
  const observations = new Map([[latest.id, latest]]);
  const parent: HybridTask = {
    id: "task:1",
    label: item.label,
    kind: "response",
    basis: "explicit",
    included: true,
    status: "not-started",
    revision: 1,
    source: {
      entryId: latest.id,
      messageHash: latest.hash,
      role: "user",
      start: 0,
      end: item.request.length,
      quoteHash: latest.hash,
    },
  };
  const current = () => ({
    sourceId: item.id,
    enabled: true,
    parents: [parent],
    latest,
    earlier: [...observations.values()].filter((o) => o.id !== latest.id),
    omissions: [],
    selectedModel,
    resolve: (id: string) => observations.get(id),
  });
  const observe = (text: string, index: number) => {
    latest = {
      id: `report:${index}`,
      role: "assistant",
      text,
      hash: hash(text),
    };
    observations.set(latest.id, latest);
    return {
      entryId: latest.id,
      messageHash: latest.hash,
      role: latest.role,
      start: 0,
      end: text.length,
      quoteHash: latest.hash,
    };
  };
  return { parent, current, observe };
}
const empty = (): SubtaskRuntimeCheckpoint => ({
  state: new SubtaskStore().checkpoint(),
  journal: {
    version: 1,
    dispatches: 0,
    records: [],
    reports: [],
    usage: {
      jev: { calls: 0, inputTokens: 0, outputTokens: 0 },
      extraction: { calls: 0, inputTokens: 0, outputTokens: 0 },
    },
  },
});

// Phase semantics only: accepted parent/context fixtures, actual runtime/transports/appliers.
// Full child obligation/report meaning requires independent review of the recorded outputs.
it.runIf(mode === "freeze" || mode === "run")(
  "fresh C10 subtask need, proposal and report runtime gate",
  async () => {
    const dir = process.env.PROGRESS_LIVE_ARTIFACT_DIR,
      revision = process.env.PROGRESS_LIVE_REVISION,
      provider = process.env.PI_PROVIDER,
      modelId = process.env.PI_MODEL;
    if (!dir || !revision || !provider || !modelId)
      throw new Error(
        "Explicit artifact directory, revision and model required",
      );
    const root = resolve(dir),
      text = readFileSync(join(root, "c10-fresh-cases.json"), "utf8");
    const corpus = JSON.parse(text) as {
      version: number;
      provenance: string;
      cases: Case[];
    };
    const host = await ModelRuntime.create({
      allowModelNetwork: false,
      signal: AbortSignal.timeout(15000),
    });
    const model = host.getModel(provider, modelId);
    if (!model) throw new Error("Selected model unavailable; no fallback");
    const selected = `${provider}/${modelId}`;
    const gates = corpus.cases.map((item) => {
      const h = fixture(item, selected);
      const { latest, earlier, omissions, selectedModel, resolve } =
        h.current();
      const batch = buildSubtaskGate({
        parent: h.parent,
        latest,
        earlier,
        omissions,
        selectedModel,
        resolve,
      });
      if (!batch) throw new Error(`Gate preflight unavailable: ${item.id}`);
      return batch.request;
    });
    const manifest = {
      version: 1,
      revision,
      provider,
      model: modelId,
      sourceHashes: sources("src"),
      runnerHash: hash(readFileSync(import.meta.filename, "utf8")),
      corpusHash: hash(text),
      corpus,
      gateRequests: gates,
      caps: { jev: 44, model: 7, reportChunksPerObservation: 4 },
      limits: {
        jevRequestBytes: 24576,
        jevResponseBytes: 131072,
        jevDeadlineMs: 10000,
        proposalTokens: 2048,
        proposalDeadlineMs: 60000,
        proposalResultBytes: 32768,
        retries: 0,
        downstreamTurns: 0,
      },
      purpose:
        "Fresh untuned phase semantics through actual SubtaskRuntime, JevGateway and selectedModelSubtasks. Synthetic accepted parents; no new mandatory extraction/host proof. Proposals and report requests depend on recorded provider outputs; freeze source, corpus, expectations, model and caps now, record exact dependent requests before dispatch. Independent obligation/report quality review REQUIRED; successful test alone is not semantic acceptance.",
    };
    expect(corpus.cases).toHaveLength(12);
    expect(corpus.cases.filter((c) => c.need === "yes")).toHaveLength(7);
    expect(corpus.cases.reduce((n, c) => n + c.reports.length, 0)).toBe(8);
    const manifestPath = join(root, "c10-manifest.json");
    if (mode === "freeze") {
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), {
        flag: "wx",
      });
      return;
    }
    if (
      process.env.PROGRESS_LIVE !== "1" ||
      !process.env.TYPESAFE_API_KEY?.trim()
    )
      throw new Error("Paid opt-in/key required");
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toEqual(manifest);
    const ledger = join(root, "c10-ledger.jsonl");
    writeFileSync(ledger, "", { flag: "wx" });
    const record = (data: unknown) =>
      appendFileSync(ledger, `${JSON.stringify(data)}\n`);
    const counts = { jev: 0, model: 0 };
    let current: Case = corpus.cases[0],
      fatal: string | undefined;
    const fail = (reason: string): never => {
      fatal = reason;
      throw new Error(reason);
    };
    const admit = (kind: keyof typeof counts) => {
      if (fatal) throw new Error(fatal);
      if (counts[kind] >= manifest.caps[kind]) fail(`${kind}-cap`);
      const attempt = ++counts[kind];
      record({
        type: "attempt",
        case: current.id,
        kind,
        attempt,
        at: new Date().toISOString(),
      });
      return attempt;
    };
    record({ type: "manifest", hash: hash(JSON.stringify(manifest)), counts });
    const registry = new ModelRegistry(host),
      complete = registry.complete.bind(registry);
    registry.complete = async (selectedModel, context, options) => {
      if (current.need !== "yes")
        return fail("Unexpected proposal after negative need case");
      expect(options).toMatchObject({
        maxRetries: 0,
        maxTokens: 2048,
        timeoutMs: 60000,
      });
      expect(context.tools).toEqual([]);
      const attempt = admit("model"),
        start = Date.now();
      record({ type: "model-request", case: current.id, attempt, context });
      try {
        const result = await complete(selectedModel, context, options);
        const text = result.content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n");
        record({
          type: "model-result",
          case: current.id,
          attempt,
          ms: Date.now() - start,
          stopReason: result.stopReason,
          usage: result.usage,
          text: Buffer.byteLength(text) <= 32768 ? text : undefined,
        });
        if (result.stopReason !== "stop" || Buffer.byteLength(text) > 32768)
          fail("Invalid proposal response");
        return result;
      } catch {
        record({
          type: "model-failure",
          case: current.id,
          attempt,
          ms: Date.now() - start,
        });
        return fail("Model failure; no retry");
      }
    };
    let outcome = "failed";
    try {
      for (const [index, item] of corpus.cases.entries()) {
        current = item;
        const h = fixture(item, selected);
        const evaluate = async (
          request: EvaluationRequest,
          signal: AbortSignal,
          onDispatch: (at: number) => boolean,
          onPhysicalFlight: (drain: Promise<void>) => void,
        ) => {
          const gateway = new JevGateway({
            getApiKey: () => process.env.TYPESAFE_API_KEY,
            beforeDispatch: (at) => !signal.aborted && onDispatch(at),
            onPhysicalFlight,
            fetch: async (url, init) => {
              expect(url).toBe("https://api.typesafe.ai/v1/systemone");
              expect(JSON.parse(String(init?.body))).toEqual(request);
              const attempt = admit("jev"),
                start = Date.now();
              record({ type: "jev-request", case: item.id, attempt, request });
              try {
                const response = await fetch(url, init);
                record({
                  type: "jev-transport",
                  case: item.id,
                  attempt,
                  status: response.status,
                  ms: Date.now() - start,
                });
                return response;
              } catch {
                record({ type: "jev-failure", case: item.id, attempt });
                return fail("Jev transport failure; no retry");
              }
            },
          });
          gateway.enable(item.id);
          try {
            const result = await gateway.evaluate(request, item.id, true);
            record({
              type: "jev-result",
              case: item.id,
              result,
              outcome: gateway.lastOutcome,
            });
            if (!result) return fail("Jev unavailable/invalid; no retry");
            return result;
          } finally {
            gateway.pause();
          }
        };
        const runtime = new SubtaskRuntime({
          initial: empty(),
          current: h.current,
          gate: (batch, signal, dispatch, physical) => {
            expect(batch.request).toEqual(gates[index]);
            return evaluate(batch.request, signal, dispatch, physical);
          },
          propose: selectedModelSubtasks(() => ({
            model,
            modelRegistry: registry,
          })),
          report: async (batch, signal, dispatch, physical) => ({
            kind: "result",
            result: await evaluate(batch.request, signal, dispatch, physical),
          }),
          canCommit: () => true,
          commit: (candidate) => {
            record({ type: "commit", case: item.id, checkpoint: candidate });
            return true;
          },
          onPublish: (snapshot) =>
            record({ type: "publish", case: item.id, snapshot }),
        });
        try {
          const gateCallsBefore = counts.jev;
          await runtime.run(h.parent.id);
          if (fatal) throw new Error(fatal);
          expect(counts.jev).toBe(gateCallsBefore + 1);
          const groups = runtime.snapshot().groups;
          record({
            type: "proposal-snapshot",
            case: item.id,
            snapshot: runtime.snapshot(),
            expected: item,
          });
          if (item.need !== "yes") {
            expect(groups).toHaveLength(0);
            continue;
          }
          expect(groups).toHaveLength(1);
          expect(groups[0].children.length).toBeGreaterThanOrEqual(2);
          for (const [reportIndex, report] of item.reports.entries()) {
            const source = h.observe(report.text, reportIndex);
            let finished = false;
            for (
              let chunk = 0;
              chunk < manifest.caps.reportChunksPerObservation;
              chunk++
            ) {
              const before = counts.jev;
              await runtime.runReport(h.parent.id, source);
              if (fatal) throw new Error(fatal);
              const job = runtime
                .checkpoint()
                .journal.reports.find(
                  (j) => j.source.entryId === source.entryId,
                );
              if (job?.state === "complete") {
                finished = true;
                break;
              }
              if (counts.jev === before)
                fail("Report made no progress; no retry");
              if (job?.state !== "ready")
                fail("Report failed/parked; no retry");
            }
            expect(finished).toBe(true);
            record({
              type: "report-snapshot",
              case: item.id,
              reportIndex,
              expected: report,
              snapshot: runtime.snapshot(),
              checkpoint: runtime.checkpoint(),
            });
          }
        } finally {
          runtime.invalidate();
        }
      }
      outcome = "completed-awaiting-independent-semantic-review";
    } finally {
      record({ type: "summary", outcome, counts, acceptance: false });
    }
  },
  900000,
);
