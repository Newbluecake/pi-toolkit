/**
 * D4 tier classification gate (#27 P1; docs/dev/test-speed/plan.md r3 §1 D4/D4a).
 *
 * The partition itself lives in tests/tiers.ts (explicit lists, never name inference). This
 * suite has two jobs:
 *
 *  1. REAL manifest — validateManifest over the actually discovered test files: every tier1
 *     file that hits a D4 marker is registered in TIER1_DECLARED, every registered path
 *     exists and belongs to a project, no path is registered twice, and mount-marker hits
 *     carry kind "false-positive". A failure means a NEW file slipped into tier1 looking
 *     environment-sensitive: register it (TIER1_DECLARED), or move it (TIER2_FILES /
 *     SECURE_MOUNT_FILES) — the error text says which.
 *  2. SYNTHETIC negatives — the five D4 failure modes proven against injected tables, so the
 *     gate itself is known to fire (a gate that cannot fail protects nothing).
 *
 * Residual risk (plan D4a, r3-2): the markers are lexical. Sleeps behind helpers, indirect
 * spawns, or slow real I/O are NOT caught — new tests still need a human tier review; never
 * claim this gate covers every slow/environment-sensitive test.
 */
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BASE_TEST_INCLUDE,
  projectOf,
  SECURE_MOUNT_FILES,
  TIER1_DECLARED,
  tier1Exclude,
  TIER2_DIRS,
  TIER2_FILES,
  validateManifest,
} from "../tiers.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

function discoveredFiles(): string[] {
  // Same discovery scope as the workspace include globs (tests/fixtures/** has no test
  // files — plan D2a verified).
  return [...globSync([...BASE_TEST_INCLUDE], { cwd: REPO })].sort();
}

function readRepoFile(rel: string): string {
  return readFileSync(join(REPO, rel), "utf8");
}

function render(problems: ReturnType<typeof validateManifest>): string {
  return problems.map((p) => `${p.path}: ${p.problem}`).join("\n");
}

describe("tier partition manifest — real files (#27 P1 D4)", () => {
  it("validateManifest passes over the discovered test files", () => {
    const problems = validateManifest(discoveredFiles(), readRepoFile);
    expect(problems, render(problems)).toEqual([]);
  }, 120_000);

  it("every discovered file maps to exactly one project (partition is total and exclusive)", () => {
    const byProject = { tier1: 0, tier2: 0, secure: 0 };
    let unmapped = 0;
    for (const f of discoveredFiles()) {
      const p = projectOf(f);
      if (p === null) {
        unmapped++;
      } else {
        byProject[p]++;
      }
    }
    // totals move as tests are added/removed; only the structural facts are pinned
    expect(unmapped).toBe(0);
    expect(byProject.secure).toBe(SECURE_MOUNT_FILES.length);
    expect(byProject.tier2).toBeGreaterThanOrEqual(TIER2_FILES.length + 1);
    expect(byProject.tier1).toBeGreaterThan(0);
  });

  it("explicit lists beat directory prefixes (secure conformance files are not tier2)", () => {
    expect(projectOf("tests/conformance/secure-gocryptfs.test.ts")).toBe("secure");
    expect(projectOf("tests/conformance/fabric-xs.test.ts")).toBe("tier2");
    expect(projectOf("tests/integration/some-new-e2e.test.ts")).toBe("tier2");
    expect(projectOf("tests/secure/gocryptfs-test-lock.test.ts")).toBe("tier2");
    expect(projectOf("tests/core/state-machine.test.ts")).toBe("tier1");
    expect(projectOf("src/foo.test.ts")).toBeNull();
    expect(projectOf("tests/foo/bar.spec.ts")).toBeNull();
  });

  it("tier1Exclude is derived from the same lists (no hand-maintained second copy)", () => {
    const exclude = tier1Exclude();
    for (const d of TIER2_DIRS) expect(exclude).toContain(`${d}**`);
    for (const f of TIER2_FILES) expect(exclude).toContain(f);
    for (const f of SECURE_MOUNT_FILES) expect(exclude).toContain(f);
  });

  it("TIER1_DECLARED entries carry a known kind and non-empty evidence", () => {
    for (const [path, entry] of Object.entries(TIER1_DECLARED)) {
      expect(["proc", "timing", "false-positive"], path).toContain(entry.kind);
      expect(entry.why.length, path).toBeGreaterThan(0);
    }
  });
});

describe("tier partition manifest — synthetic D4 negatives (the gate must fire)", () => {
  // A tiny synthetic universe: files[0..3] are the discovered tier1 files; `read` serves
  // per-file content. Each case injects tables that break exactly one D4 rule.
  const FILES = ["tests/unit/a.test.ts", "tests/unit/b.test.ts", "tests/unit/c.test.ts", "tests/unit/d.test.ts"];
  const CONTENT: Record<string, string> = {
    "tests/unit/a.test.ts": "import { describe } from 'vitest';\n",
    "tests/unit/b.test.ts": "import { spawnSync } from 'node:child_process';\n",
    "tests/unit/c.test.ts": "const bin = 'gocryptfs';\n",
    "tests/unit/d.test.ts": "await new Promise((r) => setTimeout(r, 5_000));\n",
  };
  const read = (rel: string): string => CONTENT[rel] ?? "";
  const baseTables = {
    tier1: {} as Record<string, { kind: "proc" | "timing" | "false-positive"; why: string }>,
    tier2Files: [] as string[],
    secureMountFiles: [] as string[],
  };

  it("duplicate registration — the same path in two tables fails", () => {
    const problems = validateManifest(FILES, read, {
      ...baseTables,
      tier1: { "tests/unit/a.test.ts": { kind: "proc", why: "test" } },
      tier2Files: ["tests/unit/a.test.ts"],
    });
    const mine = problems.filter((p) => p.path === "tests/unit/a.test.ts");
    expect(mine.length).toBe(1);
    expect(mine[0]!.problem).toContain("two tables");
  });

  it("unregistered marker hit — a tier1 file with markers but no TIER1_DECLARED entry fails", () => {
    // b.test.ts imports node:child_process; c.test.ts holds a "gocryptfs" literal;
    // d.test.ts sleeps 5 s — none is registered.
    const problems = validateManifest(FILES, read, baseTables);
    const paths = problems.map((p) => p.path);
    expect(paths).toContain("tests/unit/b.test.ts");
    expect(paths).toContain("tests/unit/c.test.ts");
    expect(paths).toContain("tests/unit/d.test.ts");
    for (const p of problems) {
      expect(p.problem, p.path).toContain("not registered");
      expect(p.problem, p.path).toContain("TIER1_DECLARED");
      expect(p.problem, p.path).toContain("TIER2_FILES");
    }
  });

  it("registered but missing — a declared path the discovery did not find fails", () => {
    const problems = validateManifest(FILES, read, {
      ...baseTables,
      tier2Files: ["tests/unit/gone.test.ts"],
    });
    const mine = problems.filter((p) => p.path === "tests/unit/gone.test.ts");
    expect(mine.length).toBe(1);
    expect(mine[0]!.problem).toContain("missing from the discovered");
  });

  it("mount marker mislabeled proc — kind must be false-positive", () => {
    const problems = validateManifest(FILES, read, {
      ...baseTables,
      tier1: { "tests/unit/c.test.ts": { kind: "proc", why: "test" } },
    });
    const mine = problems.filter((p) => p.path === "tests/unit/c.test.ts");
    expect(mine.length).toBe(1);
    expect(mine[0]!.problem).toContain('kind is "proc"');
  });

  it("path belonging to no project — a registered non-test path fails", () => {
    const problems = validateManifest(FILES, read, {
      ...baseTables,
      secureMountFiles: ["src/secure/real-thing.test.ts"],
    });
    const mine = problems.filter((p) => p.path === "src/secure/real-thing.test.ts");
    expect(mine.length).toBe(1);
    expect(mine[0]!.problem).toContain("no project");
  });

  it("a clean synthetic universe produces zero problems", () => {
    const problems = validateManifest(FILES, read, {
      tier1: {
        "tests/unit/b.test.ts": { kind: "proc", why: "proc:node:child_process" },
        "tests/unit/c.test.ts": { kind: "false-positive", why: 'mount:"gocryptfs"' },
        "tests/unit/d.test.ts": { kind: "timing", why: "wait:setTimeout(…, 5_000)" },
      },
      tier2Files: [],
      secureMountFiles: [],
    });
    expect(problems).toEqual([]);
  });
});
