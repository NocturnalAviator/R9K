import { defineConfig } from "vitest/config";
// Real-Telegram tests; never part of `npm test` or CI.
export default defineConfig({
  test: {
    include: ["tests/live/**/*.test.ts"],
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 60000,
  },
});
