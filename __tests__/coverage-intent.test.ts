import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { CoverageIntentRequests } from "../src/analysis/coverage-intent";
import { processObservation } from "../src/core/hybrid";
import { emptyState } from "../src/core/hybrid-state";
import { coverageParent } from "./fixtures/coverage";
import { backend, noPatch, observation } from "./fixtures/hybrid";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const text = "Review every tab in docs/plan.xlsx.";
const latest = observation("intent", text);
function fixture() {
  const state = emptyState("session:coverage");
  state.tasks = [coverageParent()];
  state.nextTaskId = 2;
  const requests = new CoverageIntentRequests();
  const resolve = (id: string) => (id === latest.id ? latest : undefined);
  return { state, requests, resolve };
}
const proposal = (overrides = {}) =>
  JSON.stringify({
    intents: [
      {
        parentIndices: [0],
        quote: text,
        resource: "docs/plan.xlsx",
        kind: "unconditional-enumerable",
        ...overrides,
      },
    ],
  });

it("grounds exact canonical intent to the existing parent, with content-free receipt", () => {
  const { state, requests, resolve } = fixture();
  const before = structuredClone(state);
  const request = requests.begin(state, latest, 1);
  expect(request).toBeDefined();
  if (!request) throw new Error("Missing request");
  expect(request.input.latest).toEqual(latest);
  expect(request.input.tasks).toHaveLength(1);
  expect(request.input.instructions).toMatch(/conditional/i);
  expect(request.input.instructions).toMatch(/quoted/i);
  const result = requests.finish(request, proposal(), state, resolve, 1);
  expect(result.status).toBe("accepted");
  expect(result.intents).toHaveLength(1);
  expect(result.intents[0]).toMatchObject({
    parentTaskId: "task:1",
    parentRevision: 1,
    resourceKey: hash("docs/plan.xlsx"),
    source: {
      entryId: latest.id,
      messageHash: latest.hash,
      start: 0,
      end: text.length,
      quoteHash: hash(text),
    },
  });
  expect(state).toEqual(before);
  expect(JSON.stringify(requests.snapshot())).not.toContain(text);
  expect(JSON.stringify(requests.snapshot())).not.toContain("docs/plan.xlsx");
  expect(requests.begin(state, latest, 1)).toBeUndefined();
  expect(requests.begin(state, latest, 2)).toBeUndefined();
});
it("coalesces identical in-flight requests before dispatch", () => {
  const { state, requests } = fixture();
  expect(requests.begin(state, latest, 1)).toBeDefined();
  expect(requests.begin(state, latest, 1)).toBeUndefined();
});
it("offers intent after unchanged mandatory scope without mandatory re-extraction", async () => {
  const { state, requests } = fixture();
  const providers = backend(noPatch(), { gate: "unchanged" });
  const settled = await processObservation(state, latest, providers);
  expect(providers.extract).not.toHaveBeenCalled();
  expect(requests.begin(settled, latest, 1)).toBeDefined();
  expect(settled.tasks).toHaveLength(1);
});
it("binds new parent IDs only after mandatory creation succeeds", async () => {
  const requests = new CoverageIntentRequests();
  const blank = emptyState("session:coverage");
  expect(requests.begin(blank, latest, 1)).toBeUndefined();
  const settled = await processObservation(
    blank,
    latest,
    backend({
      ...noPatch(),
      add: [
        {
          label: "Summarize workbook",
          kind: "response",
          basis: "explicit",
          quote: text,
        },
      ],
    }),
  );
  const request = requests.begin(settled, latest, 1);
  if (!request) throw new Error("Missing post-patch request");
  expect(
    requests.finish(request, proposal(), settled, () => latest, 1).intents[0]
      .parentTaskId,
  ).toBe(settled.tasks[0].id);
});
it.each([
  { parentIndices: [0, 1] },
  { parentIndices: [9] },
  { parentIndices: [0, 0] },
  { quote: "invented" },
  { resource: "other.xlsx" },
  { resource: "../plan.xlsx" },
  { kind: "conditional" },
  { kind: "approval" },
  { kind: "third-party" },
  { kind: "quoted-example" },
  { groupId: "forged" },
])(
  "abstains on invalid/ambiguous optional proposal %j without parent mutation",
  (bad) => {
    const { state, requests, resolve } = fixture();
    const before = structuredClone(state);
    const request = requests.begin(state, latest, 1);
    if (!request) throw new Error("Missing request");
    const result = requests.finish(request, proposal(bad), state, resolve, 1);
    expect(result.status).toBe("abstained");
    expect(result.intents).toEqual([]);
    expect(state).toEqual(before);
  },
);
it.each(["epoch", "branch", "hash", "revision", "archive", "source"])(
  "fences %s changes after optional dispatch",
  (change) => {
    const { state, requests, resolve } = fixture();
    const request = requests.begin(state, latest, 1);
    if (!request) throw new Error("Missing request");
    const current = structuredClone(state);
    if (change === "revision") current.tasks[0].revision++;
    if (change === "archive") current.tasks[0].included = false;
    if (change === "source") current.sourceId = "session:other";
    const result = requests.finish(
      request,
      proposal(),
      current,
      change === "branch"
        ? () => undefined
        : change === "hash"
          ? () => observation("intent", "amended")
          : resolve,
      change === "epoch" ? 2 : 1,
    );
    expect(result.status).toBe("abstained");
    expect(result.intents).toEqual([]);
  },
);
it("malformed optional output never poisons successful mandatory patch", async () => {
  const { state, requests, resolve } = fixture();
  const settled = await processObservation(
    state,
    latest,
    backend(noPatch(), { gate: "unchanged" }),
  );
  const before = structuredClone(settled);
  const request = requests.begin(settled, latest, 1);
  if (!request) throw new Error("Missing request");
  expect(requests.finish(request, "not JSON", settled, resolve, 1).status).toBe(
    "abstained",
  );
  expect(settled).toEqual(before);
});
it("bounds requests and excludes unsupported tool roles", () => {
  const { state, requests } = fixture();
  expect(
    requests.begin(
      state,
      { ...latest, role: "toolResult" } as unknown as typeof latest,
      1,
    ),
  ).toBeUndefined();
  expect(
    requests.begin(state, observation("large", "x".repeat(13000)), 1),
  ).toBeUndefined();
  state.tasks = Array.from({ length: 21 }, (_, i) => ({
    ...coverageParent(),
    id: `task:${i + 1}`,
  }));
  expect(requests.begin(state, latest, 1)).toBeUndefined();
});
it("snapshots are detached and receipts are bounded", () => {
  const { state, requests } = fixture();
  for (let i = 0; i < 220; i++) {
    const source = observation(`intent-${i}`, text);
    const request = requests.begin(state, source, 1);
    if (request) requests.finish(request, proposal(), state, () => source, 1);
  }
  const snapshot = requests.snapshot();
  expect(snapshot.length).toBeLessThanOrEqual(200);
  const before = structuredClone(snapshot);
  snapshot.splice(0);
  expect(requests.snapshot()).toEqual(before);
});
