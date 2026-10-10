/**
 * worktree-graph plan v2 §2.6 (P2, source-scan): static anchors mirroring worktree-diff's own
 * `source-scan.test.ts` discipline for `hub/worktree-graph/**`.
 * - no `node:fs*` / `node:child_process` imports (the only disk/spawn entry is the injectable
 *   `PreviewFs` surface + the `GitRunner` seam, exactly like worktree-diff);
 * - git is reached ONLY through the shared `createPinnedGit` executor (with explicit stderr capture
 *   for classification only) — never a raw `run(` call;
 * - argv reaches git ONLY through `wtGraphArgs.*` (P1's frozen constructors) — no inline argv
 *   array literal anywhere;
 * - the per-request audit line goes ONLY through `auditWorktreeGraph` (§2.6 whitelist).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../../../../src/web-hub/hub/worktree-graph/", import.meta.url));
const FILES = ["routes.ts", "project.ts"] as const;

function src(name: (typeof FILES)[number]): string {
  return readFileSync(join(DIR, name), "utf8");
}

describe("worktree-graph P2 source-scan (§2.6)", () => {
  it("hub/worktree-graph/** imports no node:fs* and no node:child_process", () => {
    for (const f of FILES) {
      const text = src(f);
      expect(text.match(/from "node:(fs[^"]*|child_process[^"]*)"/g) ?? [], f).toEqual([]);
      expect(text.includes('require("node:fs'), f).toBe(false);
    }
  });

  it("routes.ts uses the shared createPinnedGit and never owns a pinned runner", () => {
    const text = src("routes.ts");
    expect(text).toContain("createPinnedGit");
    expect(text).not.toContain("function runPinned");
    expect(text).not.toContain("deps.run(");
    expect(text).not.toContain("WTDIFF_GIT_PATH");
  });

  it("argv reaches git ONLY through wtGraphArgs.* — no inline argv literals", () => {
    const text = src("routes.ts");
    expect(text.includes('runPinned("Gr", [')).toBe(false);
    expect(text.includes('runPinned("Gl", [')).toBe(false);
    expect(text).toContain("wtGraphArgs.refs()");
    expect(text).toContain("wtGraphArgs.log(tips.tips)");
    // every pinned call site's argv argument derives from wtGraphArgs
    for (const m of text.matchAll(/pinned\.run\("(?:Gr|Gl)",\s*([^,]+),/g)) {
      expect(m[1]!.trim()).toMatch(/^wtGraphArgs\.\w+\(.*\)$/);
    }
  });

  it("the per-request audit line goes ONLY through auditWorktreeGraph (§2.6)", () => {
    for (const f of FILES) {
      const text = src(f);
      expect(text.includes('audit: "wtgraph"'), f).toBe(false); // never hand-built
      expect(text.match(/log\.info\("wtgraph"/g) ?? [], f).toEqual([]);
    }
    const routes = src("routes.ts");
    expect(routes).toContain("auditWorktreeGraph(log,");
    expect(routes.match(/auditWorktreeGraph\(/g)?.length).toBe(1); // exactly the finally line
  });

  it("project.ts is pure: no fs/child_process/pi imports, no `require(`", () => {
    const text = src("project.ts");
    expect(text.match(/from "node:/g) ?? []).toEqual([]);
    expect(text.includes("require(")).toBe(false);
  });

  it("project.ts's only non-type import is from src/git/graph.js and the frozen protocol module", () => {
    const text = src("project.ts");
    const valueImports = [...text.matchAll(/^import (?!type)\{[^}]*\} from "([^"]+)";/gm)].map((m) => m[1]);
    for (const spec of valueImports) {
      expect(["../../../git/graph.js", "../../protocol/worktree-graph.js"]).toContain(spec);
    }
  });

  it("routes.ts never retains/logs the raw stderr text it reads for classification", () => {
    const text = src("routes.ts");
    // stderr is read (classifyGraphExit needs it) but never passed to log.*(...) or audit
    expect(text.match(/log\.(info|warn|error)\([^)]*stderr/g) ?? []).toEqual([]);
    expect(text.includes("acc.stderr")).toBe(false);
  });
});
