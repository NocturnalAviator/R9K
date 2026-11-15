import { configDefaults, defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    // tests/live needs logged-in Telegram accounts; see vitest.live.config.ts.
    exclude: [...configDefaults.exclude, "tests/live/**"],
    fileParallelism: false,
    hookTimeout: 20000,
    testTimeout: 15000,
  },
});
