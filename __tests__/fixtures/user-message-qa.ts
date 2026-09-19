/** Sanitized September 19 user QA, not a captured Jev verdict trace.
 * User messages/IDs below are from the reported session. Parent links are rebuilt;
 * intervening tools, private text and screenshot paths are deliberately omitted.
 * Historical padding is synthetic and explicitly tests replay backlog, not an
 * assertion about the exact number/content of original session messages.
 */
export const userMessageQa = {
  historical: {
    id: "4e9449e0",
    text: "Excellent work. Please let me know when the currently planned work is closed. I'm eager to test the changes!",
  },
  reading: {
    id: "74093355",
    text: "Excellent work. While I am testing the changes you have made, I'd like  you to read through and understand .agents/plans/20260918T190403--plan-independent-advisory-steering__planning/plan.md and supporting documents. This is the next bit of work we want to do as part of the Jev extension.",
  },
  clarification: {
    id: "da3a4bef",
    text: "Ask clarifying questions if any",
  },
  investigation: {
    id: "1b1eb924",
    text: "Right. Please investigate. Basically, any time the user enters a message, the extension should check if the task-list needs to be updated? and if yes, should update it",
  },
  stillHistorical: {
    id: "93e96089",
    text: 'Even with all the messages I have entered describing the bug,the "last task" is still the historical one',
  },
  regression: {
    id: "20fe2681",
    text: "so treat this session as QA and convert it to an appropriate test for the progress-bar extension",
  },
} as const;

export function qaEntry(
  message: { id: string; text: string },
  parentId: string | null,
  role: "user" | "assistant" = "user",
) {
  return {
    type: "message",
    id: message.id,
    parentId,
    message: { role, content: message.text },
  };
}
