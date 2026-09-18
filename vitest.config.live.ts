import { defineConfig } from "vitest/config";

// Never included by make test. Explicit opt-in and key required by live suite.
export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/live/*.live.test.ts"],
    fileParallelism: false,
    retry: 0,
    testTimeout: 120_000,
    hookTimeout: 10_000,
  },
});
