import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "__tests__/index.test.ts",
      "__tests__/pi-load.test.ts",
      "__tests__/**/*.integration.test.ts",
      "__tests__/integration/**/*.test.ts",
    ],
    exclude: [
      "__tests__/package.test.ts",
      "**/live*.test.ts",
      "**/*.live.test.ts",
      "**/live/**",
    ],
    passWithNoTests: true,
  },
});
