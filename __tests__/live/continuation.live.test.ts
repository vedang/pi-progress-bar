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
import { projectContinuationAuthority } from "../../src/advisory/continuation-authority";
import { ContinuationController } from "../../src/advisory/continuation-controller";
import {
  captureContinuationPolicy,
  validateContinuationPolicy,
} from "../../src/advisory/continuation-policy";
import { selectedModelContinuation } from "../../src/advisory/continuation-selected-model";
import {
  ReconciliationDelivery,
  type ReconciliationSettlement,
} from "../../src/advisory/delivery";
import {
  applyContinuationGate,
  buildContinuationGate,
} from "../../src/analysis/continuation-gate";
import { JevGateway } from "../../src/analysis/gateway";
import type { HybridTask, MutationEvent } from "../../src/core/hybrid-state";
import {
  gradeQualification,
  type QualificationGrade,
  validateQualificationCases,
} from "../fixtures/semantic-qualification";

// Separate opt-in prevents ordinary test-live groups from dispatching this gate.
const mode = process.env.PROGRESS_N06_MODE;
const enabled = mode === "freeze" || mode === "run";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
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
  labels: string[];
  user: string;
  laterUsers?: string[];
  intercom?: string;
  reply: string;
  eligible: number[];
  actionExpectation: string;
};
type Corpus = {
  version: number;
  provenance: string;
  policy: string;
  cases: Case[];
};

/** Synthetic accepted-task/frontier fixtures; real receipt, authority and phase code.
 * Host ordering and mandatory extraction accuracy are separate offline/previous gates.
 */
function authorityFor(
  item: Case,
  index: number,
  policyText: string,
  model: string,
) {
  const branch: unknown[] = [];
  const append = (id: string, role: string, content: string) =>
    branch.push({
      type: "message",
      id,
      parentId: branch.length ? `entry-${branch.length - 1}` : null,
      message: { role, content, stopReason: "stop" },
    });
  append("authorization", "user", item.user);
  for (const [i, text] of (item.laterUsers ?? []).entries())
    append(`later-${i}`, "user", text);
  if (item.intercom)
    branch.push({
      type: "custom_message",
      id: "intercom",
      customType: "intercom_message",
      content: item.intercom,
    });
  const source = {
    entryId: "authorization",
    role: "user" as const,
    messageHash: hash(item.user),
    start: 0,
    end: item.user.length,
    quoteHash: hash(item.user),
  };
  const tasks: HybridTask[] = item.labels.map((label, i) => ({
    id: `task:${i + 1}`,
    label,
    revision: 1,
    source,
    kind: "action",
    basis: "explicit",
    included: true,
    status: "not-started",
  }));
  const events: MutationEvent[] = tasks.map((task, i) => ({
    id: `event:${i + 1}`,
    kind: "create",
    taskId: task.id,
    revision: 1,
    source: {
      entryId: source.entryId,
      role: source.role,
      messageHash: source.messageHash,
    },
  }));
  const opportunityId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
  let sent: unknown;
  let receipt: ReconciliationSettlement | undefined;
  const delivery = new ReconciliationDelivery({
    state: () => ({
      enabled: true,
      mode: "rpc",
      sessionEpoch: 1,
      branchEpoch: 1,
      opportunityId,
      relevant: true,
      idle: true,
      pendingMessages: false,
    }),
    branch: () => branch,
    uuid: () =>
      `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    sendMessage: (message) => {
      sent = message;
    },
    onReconciliationSettled: (value) => {
      receipt = value;
    },
  });
  try {
    expect(
      delivery.request({
        kind: "reconciliation",
        opportunityId,
        content:
          "Report actual status, blockers and current ownership of unfinished tasks.",
        sessionEpoch: 1,
        branchEpoch: 1,
      }),
    ).toBe("started");
    delivery.onAgentStart();
    branch.push({
      ...(sent as object),
      type: "custom_message",
      id: "question",
    });
    append("reply", "assistant", item.reply);
    delivery.onContext(branch);
    expect(delivery.onAgentSettled(branch)).toBe("advisory-only");
    if (!receipt) throw new Error(`Missing production receipt for ${item.id}`);
    const policy = validateContinuationPolicy(
      captureContinuationPolicy(policyText),
      policyText,
    );
    const authority = projectContinuationAuthority({
      receipt,
      branch,
      tasks,
      events,
      ready: true,
      cursor: { id: "reply", role: "assistant", hash: hash(item.reply) },
      policy,
      originalRunId: index + 1,
      sessionEpoch: 1,
      branchEpoch: 1,
      controlEpoch: 1,
      model,
    });
    if (!authority.available)
      throw new Error(`Authority preflight ${item.id}: ${authority.reason}`);
    return authority;
  } finally {
    delivery.dispose();
  }
}

it.runIf(enabled)(
  "frozen N06 production-controller semantic gate",
  async () => {
    const dir = process.env.PROGRESS_LIVE_ARTIFACT_DIR;
    const provider = process.env.PI_PROVIDER;
    const modelId = process.env.PI_MODEL;
    const revision = process.env.PROGRESS_LIVE_REVISION;
    if (!dir || !provider || !modelId || !revision)
      throw new Error(
        "Explicit artifact directory, revision and selected model required",
      );
    const root = resolve(dir);
    const corpusText = readFileSync(join(root, "n06-fresh-cases.json"), "utf8");
    const corpus = JSON.parse(corpusText) as Corpus;
    const qualificationCases = corpus.cases.map((item) => ({
      id: item.id,
      parentCount: item.labels.length,
      eligible: item.eligible,
    }));
    validateQualificationCases(qualificationCases);
    const runtime = await ModelRuntime.create({
      allowModelNetwork: false,
      signal: AbortSignal.timeout(15_000),
    });
    const model = runtime.getModel(provider, modelId);
    if (!model)
      throw new Error("Selected model unavailable locally; no fallback");
    const authorities = corpus.cases.map((item, i) =>
      authorityFor(item, i, corpus.policy, `${provider}/${modelId}`),
    );
    const requests = authorities.map((authority) => {
      const batch = buildContinuationGate(authority);
      if (!batch) throw new Error("Gate preflight failed");
      return batch.request;
    });
    const manifest = {
      version: 2,
      policy: {
        positiveTargets: 40,
        minimumCorrect: 38,
        maximumUnexpected: 0,
        completeCorpusRequired: true,
        independentOutputReviewRequired: true,
      },
      revision,
      provider,
      model: modelId,
      caps: { jev: 80, model: 40 },
      limits: {
        jevRequestBytes: 24576,
        jevResponseBytes: 131072,
        jevDeadlineMs: 10000,
        draftMaxTokens: 512,
        draftDeadlineMs: 60000,
        retries: 0,
        downstreamTurns: 0,
      },
      sourceHashes: sources("src"),
      runnerHash: hash(readFileSync(import.meta.filename, "utf8")),
      scoringHash: hash(
        readFileSync("__tests__/fixtures/semantic-qualification.ts", "utf8"),
      ),
      corpusHash: hash(corpusText),
      corpus,
      gateRequests: requests,
      purpose:
        "Fresh untuned semantic gate; synthetic accepted parent/frontier, actual receipt/controller/builders/gateway/selected-model adapter. Independent draft semantic review required.",
    };
    const manifestPath = join(root, "n06-manifest.json");
    if (mode === "freeze") {
      expect(corpus.cases).toHaveLength(80);
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
    const ledger = join(root, "n06-ledger.jsonl");
    writeFileSync(ledger, "", { flag: "wx" }); // A second run must never append/retry silently.
    const record = (data: unknown) =>
      appendFileSync(ledger, `${JSON.stringify(data)}\n`);
    const counts = { jev: 0, model: 0 };
    const completed = { jev: 0, model: 0 };
    const failed = { jev: 0, model: 0 };
    const cancelled = { jev: 0, model: 0 };
    const grades: QualificationGrade[] = [];
    const finishedCases: string[] = [];
    const startedCases: string[] = [];
    let current = "preflight";
    let fatal: string | undefined;
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
        case: current,
        kind,
        attempt,
        at: new Date().toISOString(),
      });
      return attempt;
    };
    record({ type: "manifest", hash: hash(JSON.stringify(manifest)), counts });
    const registry = new ModelRegistry(runtime);
    const complete = registry.complete.bind(registry);
    registry.complete = async (selected, context, options) => {
      expect(options).toMatchObject({
        maxRetries: 0,
        maxTokens: 512,
        timeoutMs: 60000,
      });
      expect(context.tools).toEqual([]);
      const attempt = admit("model"),
        start = Date.now();
      record({ type: "model-request", case: current, attempt, context });
      try {
        const result = await complete(selected, context, options);
        const text = result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        record({
          type: "model-result",
          case: current,
          attempt,
          ms: Date.now() - start,
          usage: result.usage,
          stopReason: result.stopReason,
          text: Buffer.byteLength(text) <= 4096 ? text : undefined,
        });
        if (result.stopReason !== "stop" || Buffer.byteLength(text) > 4096)
          fail("model-result-invalid");
        completed.model++;
        return result;
      } catch {
        if (options?.signal?.aborted) cancelled.model++;
        else failed.model++;
        record({
          type: "model-failure",
          case: current,
          attempt,
          ms: Date.now() - start,
        });
        return fail("model-failure");
      }
    };
    let outcome = "operational-failure";
    try {
      for (const [i, item] of corpus.cases.entries()) {
        current = item.id;
        startedCases.push(item.id);
        const authority = authorities[i];
        let admitted: number[] | undefined;
        let unexpected: number[] = [];
        let dispatch = () => false;
        let physical = (_drain: Promise<void>) => {};
        const gateway = new JevGateway({
          getApiKey: () => process.env.TYPESAFE_API_KEY,
          beforeDispatch: () => dispatch(),
          onPhysicalFlight: (drain) => physical(drain),
          fetch: async (url, init) => {
            expect(url).toBe("https://api.typesafe.ai/v1/systemone");
            expect(JSON.parse(String(init?.body))).toEqual(requests[i]);
            const attempt = admit("jev"),
              start = Date.now();
            try {
              const response = await fetch(url, init);
              const text = await response.clone().text();
              if (Buffer.byteLength(text) > 131072) fail("jev-response-cap");
              const body = JSON.parse(text);
              record({
                type: "jev-result",
                case: current,
                attempt,
                ms: Date.now() - start,
                status: response.status,
                answers: body.answers,
                usage: body.usage,
              });
              if (!response.ok) fail("jev-http-failure");
              completed.jev++;
              return response;
            } catch {
              if (init?.signal?.aborted) cancelled.jev++;
              else failed.jev++;
              record({
                type: "jev-failure",
                case: current,
                attempt,
                ms: Date.now() - start,
              });
              return fail("jev-failure");
            }
          },
        });
        gateway.enable(item.id);
        const emitted: unknown[] = [];
        const draft = selectedModelContinuation(() => ({
          model,
          modelRegistry: registry,
        }));
        const controller = new ContinuationController({
          authority: () => authority,
          canStart: () => true,
          gate: async (batch, signal, admission, onPhysical) => {
            dispatch = admission;
            physical = onPhysical;
            const abort = () => gateway.invalidate();
            signal.addEventListener("abort", abort, { once: true });
            try {
              const result = await gateway.evaluate(
                batch.request,
                item.id,
                true,
              );
              const applied = applyContinuationGate(batch, result, authority);
              if (!applied) return fail("gate-invalid-or-unavailable");
              admitted = [...applied.acceptedIndices];
              unexpected = admitted.filter(
                (index) => !item.eligible.includes(index),
              );
              grades.push({ id: item.id, acceptedIndices: admitted });
              record({
                type: "gate-grade",
                case: current,
                expected: item.eligible,
                actual: admitted,
                missed: item.eligible.filter(
                  (index) => !admitted?.includes(index),
                ),
                unexpected,
                assessments: applied.assessments,
              });
              return result;
            } finally {
              signal.removeEventListener("abort", abort);
            }
          },
          draft: async (...args) => {
            if (unexpected.length) {
              record({
                type: "downstream-fenced",
                case: item.id,
                unexpected,
                phase: "draft",
                exercised: false,
              });
              throw new Error(
                "Qualification fence: unexpected target admission",
              );
            }
            return draft(...args);
          },
          emit: (draft) => {
            emitted.push(draft);
            return true;
          }, // Never trigger a paid main-agent turn.
        });
        try {
          expect(
            controller.arm({
              opportunityId: authority.receipt.opportunityId,
              sessionEpoch: 1,
              branchEpoch: 1,
              originalRunId: i + 1,
            }),
          ).toBe(true);
          expect(controller.settle(authority.receipt)).toBe(true);
          await controller.wake();
          if (fatal) throw new Error(fatal);
          if (!admitted) fail("missing-gate-grade");
          record({
            type: "case-result",
            case: current,
            snapshot: controller.snapshot(),
            emitted,
            expectedAction: item.actionExpectation,
            semanticDraftReview: emitted.length
              ? "pending-independent-review"
              : "not-exercised",
            downstreamFenced: unexpected.length > 0,
          });
          expect(emitted).toHaveLength(
            !unexpected.length && admitted?.length ? 1 : 0,
          );
          finishedCases.push(item.id);
        } finally {
          controller.invalidate();
          gateway.pause();
        }
      }
      const score = gradeQualification(qualificationCases, grades);
      record({ type: "qualification-score", score, acceptance: false });
      outcome = score.gateCriteriaMet
        ? "gate-criteria-met-draft-review-pending"
        : "semantic-gate-failed";
    } finally {
      record({
        type: "summary",
        outcome,
        counts,
        completed,
        failed,
        cancelled,
        failure: fatal,
        finishedCases,
        unrunCases: corpus.cases
          .filter((item) => !startedCases.includes(item.id))
          .map((item) => item.id),
        unfinishedCases: startedCases.filter(
          (id) => !finishedCases.includes(id),
        ),
        acceptance: false,
      });
    }
    expect(outcome).toBe("gate-criteria-met-draft-review-pending");
  },
  3_600_000,
);
