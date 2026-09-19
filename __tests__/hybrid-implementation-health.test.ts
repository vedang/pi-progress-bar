import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  aggregateImplementation,
  implementationFromResult,
} from "../src/analysis/implementation";
import {
  type PassiveEvidence,
  redEvidenceLabel,
} from "../src/sources/evidence";
import { addPatch, observation } from "./fixtures/hybrid";
import { branchEntry, monitorHarness } from "./fixtures/hybrid-monitor";

const evidence: PassiveEvidence[] = [
  {
    kind: "code-change",
    callId: "edit-parser",
    toolName: "edit",
    order: 1,
    summary: "src/parser.ts",
    revision: 1,
  },
];

it("shows implementation not-needed without demanding implementation evidence", () => {
  expect(
    aggregateImplementation(["Explain current status"], ["not-needed"], [], 0),
  ).toBe("not-needed");
});
it("aggregates explicit partial support for a single concrete deliverable", () => {
  expect(
    aggregateImplementation(
      ["Parser handles valid and malformed input"],
      ["partial"],
      evidence,
      1,
    ),
  ).toBe("partial");
});
it("excludes not-needed criteria from required implementation coverage", () => {
  expect(
    aggregateImplementation(
      ["Implement parser", "Explain status"],
      ["supports", "not-needed"],
      evidence,
      1,
    ),
  ).toBe("appears complete");
  expect(
    aggregateImplementation(
      ["Implement parser", "Explain status"],
      ["insufficient", "not-needed"],
      evidence,
      1,
    ),
  ).toBe("unverified");
});
it("never upgrades implementation from missing, red-only or stale evidence", () => {
  expect(aggregateImplementation(["Parser"], ["partial"], [], 1)).toBe(
    "unverified",
  );
  expect(
    aggregateImplementation(
      ["Parser"],
      ["supports"],
      [{ ...evidence[0], kind: "observed-red" } as PassiveEvidence],
      1,
    ),
  ).toBe("unverified");
  expect(aggregateImplementation(["Parser"], ["partial"], evidence, 2)).toBe(
    "unverified",
  );
});
it("does not upgrade implementation from low-confidence positive judgments", () => {
  expect(
    implementationFromResult(
      ["Parser"],
      {
        model: "jev-1.13.0",
        usage: { input_tokens: 1, output_tokens: 1 },
        answers: {
          "criterion:0": {
            type: "choice",
            choice: "supports",
            confidence: 0.49,
            probabilities: { supports: 1, contradicts: 0, insufficient: 0 },
          },
        },
      },
      evidence,
      1,
    ),
  ).toBe("unverified");
});
it("derives red Not needed without hiding real reported or contradictory evidence", () => {
  expect(
    redEvidenceLabel({ applicability: "not-needed", reported: false }),
  ).toBe("Not needed");
  expect(
    redEvidenceLabel({ applicability: "not-needed", reported: true }),
  ).toBe("Reported red");
  expect(
    redEvidenceLabel({
      applicability: "not-needed",
      reported: true,
      contradiction: true,
    }),
  ).toBe("Contradictory");
});

const running: ReturnType<typeof monitorHarness>[] = [];
const requestText =
  "Implement the parser in src/parser.ts with valid-input parsing and malformed-input rejection; add regression tests and validate it.";
function fixture() {
  const h = monitorHarness([branchEntry("goal", requestText)]);
  running.push(h);
  return h;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TYPESAFE_API_KEY", "offline-key");
});
afterEach(() => {
  for (const h of running.splice(0)) h.monitor.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function judgments(
  h: ReturnType<typeof monitorHarness>,
  choice: string,
  done = false,
) {
  const original = h.fetch.getMockImplementation();
  if (!original) throw new Error("Missing fetch");
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    const response = await original(url, init);
    const body = (await response.json()) as {
      answers: Record<string, unknown>;
    };
    for (const [key, question] of Object.entries(request.questions) as [
      string,
      { criteria: Record<string, unknown> },
    ][]) {
      const selected = key.startsWith("criterion:")
        ? choice
        : done && key === "complete:task:1"
          ? "yes"
          : undefined;
      if (selected)
        body.answers[key] = {
          type: "choice",
          choice: selected,
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(question.criteria).map((key) => [
              key,
              key === selected ? 1 : 0,
            ]),
          ),
        };
    }
    return Response.json(body);
  });
}
function toolFacts(h: ReturnType<typeof monitorHarness>) {
  h.monitor.observeToolStart("edit-parser", "edit", { path: "src/parser.ts" });
  h.monitor.observeToolEnd(
    "edit-parser",
    "edit",
    { content: [{ type: "text", text: "Successfully edited src/parser.ts" }] },
    false,
  );
  h.monitor.observeToolStart("test-parser", "bash", {
    command: "bun test src/parser.test.ts",
  });
  h.monitor.observeToolEnd(
    "test-parser",
    "bash",
    {
      content: [
        {
          type: "text",
          text: "PASS src/parser.test.ts: valid input and malformed input tests passed",
        },
      ],
    },
    false,
  );
}

it.each([
  ["partial", "partial"],
  ["supports", "appears complete"],
])(
  "exposes %s implementation from real monitor evidence wiring",
  async (choice, display) => {
    const h = fixture();
    judgments(h, choice);
    h.start();
    await h.settle("goal");
    toolFacts(h);
    h.append(
      "implementation-report",
      "The src/parser.ts implementation handles valid input; src/parser.test.ts checks its behavior. Malformed-input handling is described in this task's requirements.",
    );
    await h.settle("implementation-report");
    const health = h.requests
      .filter((request) => "criterion:0" in request.questions)
      .at(-1);
    expect(JSON.stringify(health?.state)).toContain("edit-parser");
    expect(JSON.stringify(health?.state)).toContain("test-parser");
    expect(JSON.stringify(health?.state)).toContain(requestText);
    expect(health?.questions["criterion:0"]?.criteria).toHaveProperty(
      "partial",
    );
    expect(health?.questions["criterion:0"]?.criteria).toHaveProperty(
      "not-needed",
    );
    expect(h.monitor.presentationSnapshot().card?.health.implementation).toBe(
      display,
    );
    expect(
      h.monitor.state.tasks.every((task) => task.status === "not-started"),
    ).toBe(true);
    expect(h.monitor.evidenceLink()).toBeUndefined();
    expect(
      h.monitor.evidence.snapshot().every((fact) => fact.link === undefined),
    ).toBe(true);
  },
);

it("shows Not needed for an informational task without marking its answer delivered", async () => {
  const h = fixture();
  h.extract.mockImplementation(
    async (input, _signal, onDispatch?: (at: number) => void) => {
      onDispatch?.(Date.now());
      return {
        text: JSON.stringify({
          ...addPatch(
            observation(input.latest.id, input.latest.text, input.latest.role),
            ["Explain the parser status"],
          ),
          add: [
            {
              label: "Explain the parser status",
              kind: "response",
              basis: "explicit",
              quote: input.latest.text,
            },
          ],
        }),
        provider: "offline",
        model: "fixture",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  );
  h.replace([branchEntry("goal", "Explain the current parser status.")]);
  judgments(h, "not-needed");
  h.start();
  await h.settle("goal");
  expect(h.monitor.presentationSnapshot().card?.health.implementation).toBe(
    "Not needed",
  );
  expect(h.monitor.state.tasks[0]?.status).toBe("not-started");
});

it("keeps unsupported self-reports unverified even if the model claims support", async () => {
  const h = fixture();
  judgments(h, "supports");
  h.start();
  await h.settle("goal");
  h.append("unsupported-report", "I implemented everything correctly.");
  await h.settle("unsupported-report");
  expect(h.monitor.presentationSnapshot().card?.health.implementation).toBe(
    "unverified",
  );
});

it("keeps unrelated evidence insufficient rather than assigning tools by display focus", async () => {
  const h = fixture();
  judgments(h, "insufficient");
  h.start();
  await h.settle("goal");
  h.monitor.observeToolStart("other-edit", "edit", {
    path: "src/unrelated.ts",
  });
  h.monitor.observeToolEnd("other-edit", "edit", { content: [] }, false);
  h.append(
    "unrelated-report",
    "Only src/unrelated.ts changed; the parser is untouched.",
  );
  await h.settle("unrelated-report");
  expect(h.monitor.presentationSnapshot().card?.health.implementation).toBe(
    "unverified",
  );
  expect(h.monitor.evidenceLink()).toBeUndefined();
});

it("assesses final implementation evidence when all work completes in the same observation", async () => {
  const h = fixture();
  h.extract.mockResolvedValueOnce({
    text: JSON.stringify(
      addPatch(observation("goal", requestText), ["Implement parser"]),
    ),
    provider: "offline",
    model: "fixture",
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  h.start();
  await h.settle("goal");
  toolFacts(h);
  judgments(h, "supports", true);
  h.append(
    "final-implementation",
    "The src/parser.ts deliverable is complete and its parser tests passed.",
  );
  await h.settle("final-implementation");
  expect(h.monitor.state.tasks[0]?.status).toBe("done");
  expect(h.monitor.presentationSnapshot().card).toMatchObject({
    retained: true,
    replacementPending: false,
    health: { implementation: "appears complete" },
  });
});

it("drops passive facts when canonical task authority is reset", async () => {
  const h = fixture();
  judgments(h, "supports");
  h.start();
  await h.settle("goal");
  toolFacts(h);
  expect(h.monitor.evidence.snapshot().length).toBeGreaterThan(0);
  h.replace([
    branchEntry("goal", `${requestText} Also support streaming input.`),
  ]);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.evidence.snapshot()).toEqual([]);
  expect(h.monitor.presentationSnapshot().card?.health.implementation).toBe(
    "unverified",
  );
});

it("does not admit an implementation assessment after its code evidence changes in flight", async () => {
  const h = fixture();
  judgments(h, "supports");
  h.start();
  await h.settle("goal");
  toolFacts(h);
  const original = h.fetch.getMockImplementation();
  if (!original) throw new Error("Missing fetch");
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let heldHealth = false;
  h.fetch.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.questions["criterion:0"] && !heldHealth) {
      heldHealth = true;
      await held;
    }
    return original(url, init);
  });
  h.append("health-report", "src/parser.ts is implemented and its tests pass.");
  await vi.advanceTimersByTimeAsync(5);
  expect(heldHealth).toBe(true);
  h.monitor.observeToolStart("new-parser-edit", "edit", {
    path: "src/parser.ts",
  });
  h.monitor.observeToolEnd("new-parser-edit", "edit", { content: [] }, false);
  release();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.monitor.presentationSnapshot().card?.health.implementation).not.toBe(
    "appears complete",
  );
});

it("asks implementation applicability before treating absent evidence as insufficient", async () => {
  const h = fixture();
  h.start();
  await h.settle("goal");
  const question = h.requests.find(
    (request) => "criterion:0" in request.questions,
  )?.questions["criterion:0"];
  expect(question?.instructions).toContain(
    "First determine whether this task requires",
  );
  expect(question?.instructions).toContain(
    "not-needed even without passive evidence",
  );
  expect(question?.instructions).toContain(
    "Only when implementation is required",
  );
});
