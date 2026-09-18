import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["__tests__/offline-setup.ts"],
    include: ["__tests__/**/*.test.ts"],
    exclude: [
      "__tests__/index.test.ts",
      "__tests__/pi-load.test.ts",
      "**/*.integration.test.ts",
      "**/integration/**",
      "**/live*.test.ts",
      "**/*.live.test.ts",
      "**/live/**",
    ],
    passWithNoTests: true,
  },
});
