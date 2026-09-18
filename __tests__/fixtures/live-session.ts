/** Sanitized reconstruction of observed QA failure, not raw model verdicts.
 * Original IDs/text retained only for relevant visible messages. Chronology
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
    text: "1. Change the default progress analysis interval to 15 seconds.\n2. Improve /progress help to show state, interval, Jev usage, and available commands.",
  },
  {
    id: "working",
    role: "assistant",
    text: "I am working on the 15-second default interval now; help text comes next.",
  },
  {
    id: "2fd7cc52",
    role: "assistant",
    text: "Both requested changes are complete: the default interval is now 15 seconds, and /progress help shows state, interval, Jev usage, and available commands. Tests pass.",
  },
] as const;

export const replayEntries = (length: number = sessionReplay.length) =>
  sessionReplay.slice(0, length).map((item, index) => ({
    type: "message",
    id: item.id,
    parentId: sessionReplay[index - 1]?.id ?? null,
    message: { role: item.role, content: item.text },
  }));
