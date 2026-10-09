/**
 * topic-switch · pi-free import scan (plan.md §2: "pi-free：
 * `src/topic-switch/{types,settings,filters,economics,gate,judge,state,records}.ts`、
 * `src/cache-ttl/warmth.ts` 禁止 import `@earendil-works/*`（`pi-free.test.ts` 扫 import 行；
 * `node:crypto` 允许）").
 *
 * This is a textual scan of each file's `import`/`export … from`/`require(...)` lines — it does
 * NOT walk the transitive import graph (a pi-free file importing a non-pi-free one would still be
 * caught at review time by this same rule applied to ITS target, and the P1/P2 files this test
 * covers only import other pi-free modules in practice). The scan is deliberately strict: even a
 * `import type { … } from "@earendil-works/...";` counts, since "pi-free" means zero coupling to
 * the host package shape, not just zero runtime dependency.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

const PI_FREE_FILES: readonly string[] = [
  "src/topic-switch/types.ts",
  "src/topic-switch/settings.ts",
  "src/topic-switch/filters.ts",
  "src/topic-switch/economics.ts",
  "src/topic-switch/gate.ts",
  "src/topic-switch/judge.ts",
  "src/topic-switch/state.ts",
  "src/topic-switch/records.ts",
  "src/cache-ttl/warmth.ts",
];

/** Matches `@earendil-works/...` anywhere inside an import/export/require specifier string. */
const FORBIDDEN_SPECIFIER_RE =
  /from\s+["']@earendil-works\/[^"']*["']|require\(\s*["']@earendil-works\/[^"']*["']\s*\)/;

function importLines(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => /^\s*import\b|^\s*export\s+(?:type\s+)?\{[^}]*\}\s*from\b|require\(/.test(line));
}

describe("topic-switch pi-free files never import @earendil-works/*", () => {
  for (const relPath of PI_FREE_FILES) {
    it(relPath, () => {
      const source = readFileSync(resolve(REPO_ROOT, relPath), "utf8");
      const offenders = importLines(source).filter((line) => FORBIDDEN_SPECIFIER_RE.test(line));
      expect(offenders, `${relPath} has forbidden @earendil-works import(s):\n${offenders.join("\n")}`).toEqual([]);
    });
  }

  it("the file list itself matches plan.md §2 exactly (fails loudly if a P1/P2 file is renamed or a new one should be added here)", () => {
    expect(PI_FREE_FILES).toHaveLength(9);
  });
});
