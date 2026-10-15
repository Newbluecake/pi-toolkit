import vue from "@vitejs/plugin-vue";
import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";
import { uiAliases } from "./src/web-hub/ui/aliases.js";

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: uiAliases },
  define: {
    // Mirror of vite.config.ts's `__PWH_UI_BUILD__` define so components importing
    // `src/build-info.ts` (e.g. TopBar's build stamp) also work under vitest.
    __PWH_UI_BUILD__: JSON.stringify({
      version: "0.0.0-test",
      proto: { major: 1 },
      commit: "0123456789ab",
      builtAt: "2026-01-02T03:04:05.000Z",
    }),
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test-d.ts"],
    environment: "node",
    setupFiles: ["./tests/setup/sandbox-home.ts"],
    testTimeout: 10_000,
    // 2026-10-15: cap the fork pool at 8. On a 16-core box the default (cores − 1 = 15) was no
    // faster than 8 (4 full runs: ~210s either way) but doubled CPU contention, which is what
    // surfaced the load-sensitive flakes that blocked the v0.5.4 release. min() keeps smaller
    // machines (CI runners) on vitest's own default.
    maxWorkers: Math.max(1, Math.min(8, availableParallelism() - 1)),
    minWorkers: 1,
  },
});
