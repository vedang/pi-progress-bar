export const correctionSource = (attempt: {
  toolName: string;
  path?: string;
}) => ({
  sourceRun: 1,
  policy: { coverage: "complete" as const, entries: [] },
  action: {
    coverage: "complete" as const,
    role: "assistant" as const,
    text: "Starting a new failing parser test, or the declared review of current parser work.",
    batch: [
      {
        toolName: attempt.toolName,
        ...(attempt.path ? { path: attempt.path } : {}),
        current: true,
      },
    ],
  },
});
