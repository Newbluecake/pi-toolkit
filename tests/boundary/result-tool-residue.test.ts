import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * #64 residue gate (the only one, introduced by the last package): the pre-rename result-tool name must not creep
 * back into live code, tests, skills or live docs. Every allowed occurrence is pinned per file with an EXACT count
 * and a reason, so a new hit — even inside an allowed file — fails the gate.
 *
 * Out of scope on purpose: CHANGELOG.md (generated), docs/research/**, scripts/**, and docs/dev/** files that are not
 * a subsystem README (old design archives); only docs/dev/<x>/README.md is scanned.
 *
 * The needle is assembled at runtime so this file never matches itself.
 */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const NEEDLE = ["get_subagent", "result"].join("_");

/** repo-relative posix path → exact allowed occurrence count + why. */
const ALLOWED: Readonly<Record<string, { count: number; why: string }>> = {
  // --- the single definition + history-only consumers ---
  "src/core/tool-names.ts": { count: 1, why: "LEGACY_RESULT_TOOL_NAME constant (single source)" },
  "src/runtime/tool-scope.ts": { count: 1, why: "RESERVED_TOOL_NAMES keeps the legacy entry in place (frozen golden)" },
  "src/tools/result-tool.ts": { count: 2, why: "doc comments: former name + legacy history renderer" },
  "src/tools/result-tool-activation.ts": { count: 1, why: "migration code header comment" },
  "src/feishu-notify/core.ts": { count: 1, why: "waitNotifyTools legacy-name mapping comment" },
  "src/web-hub/ui/src/logic/tools.js": {
    count: 2,
    why: "legacy name in RUN_REF_TOOLS + comment (historical transcripts)",
  },
  "src/web-hub/ui/src/components/transcript/ToolCard.vue": {
    count: 2,
    why: "legacy name in MD_RESULT_TOOLS + requirement comment (historical transcripts)",
  },
  // --- compat / migration tests ---
  "tests/core/tool-names.test.ts": { count: 1, why: "pins the legacy constant value" },
  "tests/runtime/tool-scope.test.ts": { count: 2, why: "legacy name stays reserved in child sessions" },
  "tests/tools/result-tool.test.ts": { count: 2, why: "legacy history renderer test" },
  "tests/tools/model-facing-strings.test.ts": {
    count: 1,
    why: "description keeps the 'Formerly named' transition note",
  },
  "tests/feishu-notify/core.test.ts": { count: 3, why: "waitNotifyTools legacy-name mapping tests" },
  "tests/conformance/result-tool-rename.test.ts": {
    count: 2,
    why: "R1-R8 resume/migration conformance (seed tool + comment)",
  },
  "tests/web-hub/ui/tool-card.test.ts": { count: 15, why: "web UI keeps rendering legacy-name historical cards" },
  // --- fixtures ---
  "tests/fixtures/fabric-xs-off-golden.json": {
    count: 1,
    why: "frozen golden: reservedToolNames keeps the legacy entry",
  },
  "tests/fixtures/preview-perf/stack-3609.ts.txt": { count: 1, why: "preview-perf corpus (verbatim real file)" },
  // --- user-facing compatibility docs ---
  "docs/guide/migration.md": { count: 3, why: "the user-facing compatibility note (heading + two mentions)" },
  "docs/guide/subagents.md": { count: 2, why: "'formerly named' note + link anchor to the migration section" },
  "docs/dev/scheduled-reports/README.md": { count: 1, why: "history note: the constant's former tool name" },
};

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (st.isFile()) out.push(full);
  }
}

function posix(path: string): string {
  return relative(ROOT, path).split(sep).join("/");
}

/** In scope: src/, tests/, skills/, docs/guide/, docs/dev/<x>/README.md, root README*.md, AGENTS.md, package.json. */
function scopedFiles(): string[] {
  const files: string[] = [];
  for (const dir of ["src", "tests", "skills", "docs/guide"]) {
    const abs = join(ROOT, dir);
    if (existsSync(abs)) walk(abs, files);
  }
  const dev = join(ROOT, "docs/dev");
  if (existsSync(dev)) {
    for (const name of readdirSync(dev)) {
      const readme = join(dev, name, "README.md");
      if (existsSync(readme)) files.push(readme);
    }
  }
  for (const name of readdirSync(ROOT)) {
    if (/^README.*\.md$/.test(name) || name === "AGENTS.md" || name === "package.json") files.push(join(ROOT, name));
  }
  return files;
}

function countIn(file: string): number {
  const buf = readFileSync(file);
  if (buf.includes(0)) return 0; // binary
  return buf.toString("utf8").split(NEEDLE).length - 1;
}

describe("result-tool rename residue gate (#64)", () => {
  const files = scopedFiles();
  const hits = new Map<string, number>();
  for (const file of files) {
    const n = countIn(file);
    if (n > 0) hits.set(posix(file), n);
  }

  it("scans a non-trivial file set (the walk itself works)", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(hits.size).toBeGreaterThan(5);
  });

  it("no occurrence of the pre-rename name outside the pinned allow-list", () => {
    const unexpected = [...hits].filter(([file]) => ALLOWED[file] === undefined).map(([file, n]) => `${file} x${n}`);
    expect(unexpected, "new use of the legacy result-tool name: use RESULT_TOOL_NAME / the new name").toEqual([]);
  });

  it("allowed files hold exactly the pinned number of occurrences (no new hits, no stale entries)", () => {
    const mismatched = Object.entries(ALLOWED)
      .filter(([file, { count }]) => (hits.get(file) ?? 0) !== count)
      .map(([file, { count }]) => `${file}: expected ${count}, found ${hits.get(file) ?? 0}`);
    expect(mismatched).toEqual([]);
  });

  it("every allow-list entry names an existing file and carries a reason", () => {
    for (const [file, { why }] of Object.entries(ALLOWED)) {
      expect(existsSync(join(ROOT, file)), file).toBe(true);
      expect(why.length, file).toBeGreaterThan(5);
    }
  });
});
