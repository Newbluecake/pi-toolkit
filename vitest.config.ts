import vue from "@vitejs/plugin-vue";
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
    testTimeout: 10_000,
  },
});
