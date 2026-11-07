/**
 * Actual-configuration partition check (#27 P1; plan r3 §3-1, r1 review #3).
 *
 * tests/governance/test-tiers.test.ts proves the manifest is self-consistent, but that alone
 * cannot prove the REAL vitest include/exclude globs select the same files. This suite spawns
 * `vitest list --filesOnly --project <p>` ×3 (list only globs — it never executes tests or
 * globalSetup) and asserts:
 *
 *  1. each project's actual file set equals the expected set (node fs.globSync over
 *     BASE_TEST_INCLUDE + projectOf from tests/tiers.ts);
 *  2. the three actual sets are pairwise disjoint;
 *  3. their union is exactly every discovered test file (no file lost, none doubled).
 *
 * Tier 2 by design (real child process); spawning the local vitest binary follows the
 * tests/web-hub/hub/spawn/golden.test.ts precedent.
 */
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BASE_TEST_INCLUDE, projectOf, type ProjectName } from "../tiers.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PROJECTS: ProjectName[] = ["tier1", "tier2", "secure"];

function listActualFiles(project: ProjectName): string[] {
  const res = spawnSync(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "list", "--filesOnly", "--project", project],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
  );
  expect(res.error, String(res.error)).toBeUndefined();
  expect(res.status, res.stderr).toBe(0);
  // lines look like `[tier1] tests/core/state-machine.test.ts` — strip the [name] prefix
  return res.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^\[[^\]]+\] /, ""))
    .sort();
}

let cache: Map<ProjectName, string[]> | undefined;

/** Spawns `vitest list` once per project (first caller); later calls reuse the cache. */
function actualSets(): Map<ProjectName, string[]> {
  cache ??= new Map(PROJECTS.map((p) => [p, listActualFiles(p)]));
  return cache;
}

describe("vitest workspace partition — actual `vitest list` evidence (#27 P1 §3-1)", () => {
  it("each project's real file set equals globSync + projectOf", () => {
    const discovered = [...globSync([...BASE_TEST_INCLUDE], { cwd: REPO })].sort();
    expect(discovered.length).toBeGreaterThan(0);
    for (const project of PROJECTS) {
      const expected = discovered.filter((f) => projectOf(f) === project);
      const actual = actualSets().get(project)!;
      const missing = expected.filter((f) => !actual.includes(f));
      const extra = actual.filter((f) => !expected.includes(f));
      expect(missing, `${project}: expected files vitest did not select`).toEqual([]);
      expect(extra, `${project}: files vitest selected but projectOf says otherwise`).toEqual([]);
      expect(actual.length, `${project} count`).toBe(expected.length);
    }
  }, 420_000);

  it("the three actual sets are pairwise disjoint", () => {
    const [a, b, c] = PROJECTS.map((p) => actualSets().get(p)!);
    const overlap = (x: string[], y: string[]) => x.filter((f) => y.includes(f));
    expect(overlap(a!, b!), "tier1 ∩ tier2").toEqual([]);
    expect(overlap(a!, c!), "tier1 ∩ secure").toEqual([]);
    expect(overlap(b!, c!), "tier2 ∩ secure").toEqual([]);
  });

  it("the union of the three actual sets is exactly the discovered test files", () => {
    const discovered = [...globSync([...BASE_TEST_INCLUDE], { cwd: REPO })].sort();
    const union = [...new Set(PROJECTS.flatMap((p) => actualSets().get(p)!))].sort();
    expect(union.length).toBe(discovered.length);
    expect(union).toEqual(discovered);
  });
});
