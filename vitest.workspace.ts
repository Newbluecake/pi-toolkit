/**
 * Vitest workspace — the three tier projects of #27 P1 (docs/dev/test-speed/plan.md r3 D1/D3).
 *
 * - Every include/exclude is generated from tests/tiers.ts (the single partition source);
 *   nothing is hand-listed here. Partition invariants are enforced by
 *   tests/governance/test-tiers.test.ts (the manifest gate) and verified against the REAL
 *   vitest glob by tests/integration/test-tiers-actual.test.ts (`vitest list` ×3).
 * - Inline projects do NOT inherit the root vitest.config.ts in vitest 2.1.9, so each project
 *   spreads `baseProject` (plugins/resolve/define/environment/globalSetup/setupFiles/
 *   testTimeout). The root config still provides maxWorkers/minWorkers for the whole run.
 * - `secure` is a Tier 2 project split out only so P2 can append its preflight
 *   globalSetup/setupFiles (`tests/setup/secure-preflight.*`) to the base arrays — appended,
 *   never replacing the base entries. #27 P2 wired them in.
 * - Only a project whose files were selected this run executes its globalSetup (vitest 2.1.9
 *   cli-api), so `--project tier1` never touches secure/tier2 hooks.
 */
import { configDefaults, defineWorkspace } from "vitest/config";
import { secureInclude, tier1Exclude, tier1Include, tier2Exclude, tier2Include } from "./tests/tiers.js";
import { baseProject } from "./vitest.config.js";

export default defineWorkspace([
  {
    ...baseProject,
    test: {
      ...baseProject.test,
      name: "tier1",
      include: tier1Include(),
      exclude: [...configDefaults.exclude, ...tier1Exclude()],
    },
  },
  {
    ...baseProject,
    test: {
      ...baseProject.test,
      name: "tier2",
      include: tier2Include(),
      exclude: [...configDefaults.exclude, ...tier2Exclude()],
    },
  },
  {
    ...baseProject,
    test: {
      ...baseProject.test,
      name: "secure",
      runner: "./tests/setup/secure-preflight.runner.ts",
      include: secureInclude(),
      exclude: [...configDefaults.exclude],
      // P2 (#27, plan r3 D3/D9): APPEND the secure preflight to the base hooks — global-tz
      // and sandbox-home stay first. Workers inject "secureEnv" (provided by the global
      // setup on every exit) and fail closed when the environment verdict is dirty.
      globalSetup: [...(baseProject.test?.globalSetup ?? []), "./tests/setup/secure-preflight.global.ts"],
      setupFiles: [...(baseProject.test?.setupFiles ?? []), "./tests/setup/secure-preflight.setup.ts"],
    },
  },
]);
