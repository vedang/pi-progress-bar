import type { ScopePatch } from "../../src/analysis/extractor";
import type { EvaluationRequest } from "../../src/analysis/gateway";
import type { HealthCard } from "../../src/core/hybrid-checkpoint";
import { addPatch, observation } from "./hybrid";
import { branchEntry, monitorHarness } from "./hybrid-monitor";

/** Deterministic task-linkage answers, not evidence of real model accuracy. */
export function taskHealthHarness(count = 3) {
  const patches = new Map<string, ScopePatch>();
  const labels = Array.from({ length: count }, (_, i) =>
    i === 0
      ? "Fix parser"
      : i === 1
        ? "Document parser"
        : `Research option ${i}`,
  );
  const entries = [];
  for (let start = 0; start < labels.length; start += 6) {
    const id = start === 0 ? "goal" : `goal-${start}`;
    const batch = labels.slice(start, start + 6);
    const text = batch.join("; ");
    patches.set(id, addPatch(observation(id, text), batch));
    entries.push(branchEntry(id, text));
  }
  const h = monitorHarness(entries, {
    extractionText: (input) => JSON.stringify(patches.get(input.latest.id)),
  });
  let focus = "none";
  let confidence = 1;
  const completed = new Set<string>();
  const original = h.fetch.getMockImplementation();
  if (!original) throw new Error("Missing fake transport");
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body)) as EvaluationRequest;
    const response = await original(url, init);
    const body = (await response.json()) as {
      answers: Record<string, unknown>;
    };
    const latest = (request.state as { latest?: { id: string } }).latest?.id;
    const taskId = (request.state as { evidence?: { taskId?: string } })
      .evidence?.taskId;
    for (const [key, question] of Object.entries(request.questions)) {
      if (question.type !== "choice") continue;
      const choice =
        key === "gate"
          ? patches.has(latest ?? "")
            ? "changed"
            : "unchanged"
          : key === "focus"
            ? focus
            : key.startsWith("complete:")
              ? completed.has(key.slice(9))
                ? "yes"
                : "no"
              : key === "redApplicability"
                ? taskId === "task:1"
                  ? "needed"
                  : "not-needed"
                : key === "redReport"
                  ? taskId === "task:1" &&
                    JSON.stringify(request.state).includes("PARSER_RED_REPORT")
                    ? "reported-red"
                    : "not-found"
                  : undefined;
      if (!choice) continue;
      body.answers[key] = {
        type: "choice",
        choice,
        confidence: key === "focus" ? confidence : 1,
        probabilities: Object.fromEntries(
          Object.keys(question.criteria).map((k) => [k, k === choice ? 1 : 0]),
        ),
      };
    }
    return Response.json(body);
  });
  return Object.assign(h, {
    patches,
    initialTarget: entries.at(-1)?.id ?? "goal",
    completed,
    focus: (value: string, certainty = 1) => {
      focus = value;
      confidence = certainty;
    },
    healthRequests: () => h.requests.filter((r) => "clarity" in r.questions),
    cards: () =>
      (h.monitor.checkpoint() as { monitor?: { healthCards?: HealthCard[] } })
        .monitor?.healthCards ?? [],
  });
}
