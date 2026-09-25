import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test-d.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
});
