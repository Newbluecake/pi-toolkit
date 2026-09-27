import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";
import { uiAliases } from "./src/web-hub/ui/aliases.js";

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: uiAliases },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test-d.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
});
