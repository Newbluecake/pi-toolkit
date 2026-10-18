/** F5: run the EXISTING suites unchanged, with an observer only. */
import { defineConfig } from "vitest/config";
import base from "../../../../vitest.config.js";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      "tests/web-hub/http/*headless*.test.ts",
      "tests/web-hub/hub/hub-spawn.test.ts",
      "tests/integration/web-hub-headless.test.ts",
    ],
    setupFiles: ["./tests/setup/sandbox-home.ts", "./tests/web-hub/hub/spawn/golden.setup.ts"],
    maxWorkers: 1,
    minWorkers: 1,
  },
});
