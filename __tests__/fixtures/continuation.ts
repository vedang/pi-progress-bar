import {
  captureContinuationPolicy,
  validateContinuationPolicy,
} from "../../src/advisory/continuation-policy";
import type { ReconciliationSettlement } from "../../src/advisory/delivery";
import type {
  Cursor,
  HybridTask,
  MutationEvent,
} from "../../src/core/hybrid-state";
import { subtaskHash, subtaskParent, subtaskSource } from "./subtasks";

export const continuationAuthorityFixture = () => {
  const text =
    "Compare deployment options and recommend an approach. Continue until finished.";
  const replyText =
    "The recommendation is pending, authorized and unblocked; nobody else owns it.";
  const authorization = {
    type: "message",
    id: "authorization",
    parentId: null,
    message: { role: "user", content: text },
  };
  const question = {
    type: "custom_message",
    id: "question",
    parentId: "authorization",
    customType: "pi-progress-advisory",
    content: "What is the actual status?",
    display: true,
    details: {
      kind: "reconciliation",
      opportunityId: "00000000-0000-4000-8000-000000000001",
      sendId: "00000000-0000-4000-8000-000000000002",
    },
  };
  const reply = {
    type: "message",
    id: "reply",
    parentId: "question",
    message: { role: "assistant", content: replyText, stopReason: "stop" },
  };
  const task: HybridTask = {
    ...subtaskParent(),
    source: subtaskSource("authorization", text),
  };
  const events: MutationEvent[] = [
    {
      id: "event:1",
      kind: "create",
      taskId: task.id,
      revision: 1,
      source: {
        entryId: "authorization",
        messageHash: subtaskHash(text),
        role: "user",
      },
    },
  ];
  const receipt: ReconciliationSettlement = {
    kind: "reconciliation",
    opportunityId: question.details.opportunityId,
    sendId: question.details.sendId,
    sessionEpoch: 1,
    branchEpoch: 2,
    replyRunId: 8,
    question: {
      entryId: "question",
      contentHash: subtaskHash(question.content),
    },
    replies: [
      {
        entryId: "reply",
        messageHash: subtaskHash(replyText),
        role: "assistant",
      },
    ],
  };
  const policyText =
    "Follow current user instructions. Continue only authorized unblocked work; respect pauses and peer ownership.";
  const input = {
    receipt,
    branch: [authorization, question, reply] as unknown[],
    tasks: [task],
    events,
    ready: true,
    cursor: { id: "reply", hash: subtaskHash(replyText), role: "assistant" } as
      | Cursor
      | undefined,
    policy: validateContinuationPolicy(
      captureContinuationPolicy(policyText),
      policyText,
    ),
    originalRunId: 7,
    sessionEpoch: 1,
    branchEpoch: 2,
    controlEpoch: 3,
    model: "fixture/selected",
  };
  return { input, authorization, question, reply, task };
};
