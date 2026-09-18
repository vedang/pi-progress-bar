/** Sanitized reconstruction of observed QA failure, not raw model verdicts.
 * Request 29acae97 and final summary 2fd7cc52 are verbatim visible text.
 * Insight is an excerpt; old-goal/old-done/working are synthetic connectors. Chronology
 * compressed: tool traffic, credentials, paths and unrelated conversation omitted.
 * Historical facts: old Insight selected; two later tasks missed; final report
 * cursor advanced while 0/1 persisted. Unknown: original Jev answers/build hash.
 */
const sessionReplay = [
  {
    id: "old-goal",
    role: "user",
    text: "Implement the planned progress monitor features from the tickets.",
  },
  {
    id: "55f2ddf0",
    role: "assistant",
    text: "★ Insight\nFirst lock scope from ticket bodies + `PRODUCT.md`; then behavior tests lead each increment.",
  },
  {
    id: "old-done",
    role: "assistant",
    text: "The planned progress monitor implementation is complete.",
  },
  {
    id: "29acae97",
    role: "user",
    text: "okay. Make the following changes to the code:\n1. The default analysis times should be 15s, 60s is too slow. \n2. /progress should show a better help message that clearly shows how to use it",
  },
  {
    id: "working",
    role: "assistant",
    text: "I am working on the 15-second default interval now; help text comes next.",
  },
  {
    id: "2fd7cc52",
    role: "assistant",
    text: "Implemented and committed: `e58ee7fa9d7c558031d3201a40817332cac78338`\n\nChanges:\n- New-session/default analysis interval: **15 seconds**\n- `/progress` now shows:\n  - ON/OFF state\n  - Current interval\n  - Jev usage\n  - Every supported command with descriptions and bounds\n- README and PRODUCT updated\n- Existing explicitly saved intervals remain unchanged; use `/progress interval 15` to update an existing session.\n\nValidation:\n- 74 unit tests passed\n- 10 integration tests passed\n- Biome, TypeScript, Knip, package dry-run passed\n- Bead closed/exported\n- Working copy clean\n\n`★ Insight ─────────────────────────────────────`\n- One shared constant now controls constructor and restore fallback defaults.\n- Help and invalid-command output share command definitions, avoiding documentation drift.\n`─────────────────────────────────────────────────`",
  },
] as const;

export const replayEntries = (length: number = sessionReplay.length) =>
  sessionReplay.slice(0, length).map((item, index) => ({
    type: "message",
    id: item.id,
    parentId: sessionReplay[index - 1]?.id ?? null,
    message: { role: item.role, content: item.text },
  }));
