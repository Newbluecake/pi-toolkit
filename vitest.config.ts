import vue from "@vitejs/plugin-vue";
import { availableParallelism } from "node:os";
import { defineConfig, type UserWorkspaceConfig } from "vitest/config";
import { uiAliases } from "./src/web-hub/ui/aliases.js";

function testWorkers(): number {
  const raw = process.env.PI_TOOLKIT_TEST_WORKERS?.trim();
  if (raw !== undefined && /^[1-9][0-9]*$/.test(raw)) return Number(raw);
  return Math.max(1, Math.min(8, availableParallelism() - 1));
}

/**
 * Shared per-project base for the three inline projects in vitest.workspace.ts (#27 P1,
 * docs/dev/test-speed/plan.md D3). vitest 2.1.9 inline workspace projects do NOT inherit the
 * root config — every plugin/resolve/define/test setting a project needs must live here.
 * include/exclude/name are per project (generated from tests/tiers.ts) and are NOT set here.
 * The secure project APPENDS its preflight hooks to these arrays (P2), never replaces them.
 */
export const baseProject: UserWorkspaceConfig = {
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
    environment: "node",
    globalSetup: ["./tests/setup/global-tz.ts"],
    setupFiles: ["./tests/setup/sandbox-home.ts"],
    testTimeout: 10_000,
  },
};

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
    // With vitest.workspace.ts present (2026-11-05, #27 P1) the root config no longer runs a
    // test suite of its own: the three workspace projects own include/exclude (all generated
    // from tests/tiers.ts — the single partition source). This root config still governs the
    // run itself (maxWorkers/minWorkers below, reporters, the core project's globalSetup).
    // `npm test` selects every project, i.e. it stays the full 1760-file run.
    include: ["tests/**/*.test.ts", "tests/**/*.test-d.ts"],
    environment: "node",
    globalSetup: ["./tests/setup/global-tz.ts"],
    setupFiles: ["./tests/setup/sandbox-home.ts"],
    testTimeout: 10_000,
    // 2026-10-15: cap the fork pool at 8. On a 16-core box the default (cores − 1 = 15) was no
    // faster than 8 (4 full runs: ~210s either way) but doubled CPU contention, which is what
    // surfaced the load-sensitive flakes that blocked the v0.5.4 release. min() keeps smaller
    // machines (CI runners) on vitest's own default.
    // PI_TOOLKIT_TEST_WORKERS overrides it (CI and release.sh lower it on purpose: time is cheap
    // there, while timing-sensitive integration tests flake under CPU contention).
    maxWorkers: testWorkers(),
    minWorkers: 1,
  },
});
