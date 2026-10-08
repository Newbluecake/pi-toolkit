/**
 * worktree-diff plan §5 D3 source-scan (H2/H3/H4 static anchors):
 * - `hub/worktree-diff/**` imports NO `node:fs*` / `node:child_process` (the only disk/spawn
 *   entry is the injectable `PreviewFs` surface + the `GitRunner` seam);
 * - every direct `deps.run(` call site carries `envPolicy:"minimal"`, the fixed
 *   `pathOverride` and `signal` — and `pins` everywhere except the two admission commands
 *   (C1a/C1, §1.8's only unpinned pair);
 * - argv reach git ONLY through `wtDiffArgs.*` / `neutralizeArgs` (D1's frozen constructors —
 *   no inline argv array literal anywhere);
 * - the per-request audit line goes ONLY through `auditWorktreeDiff` (§2.9 whitelist);
 * - the cross-layer constant identity (D1 deviation #3 absorption): src/git/diff.ts's
 *   WTDIFF_DRIVER_SCAN_MAX === protocol/worktree-diff.ts's WTDIFF_DRIVERS_MAX (src/git must
 *   not import web-hub protocol, so the two are mirrored — and pinned equal here).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { WTDIFF_DRIVER_SCAN_MAX } from "../../../../src/git/diff.js";
import { WTDIFF_DRIVERS_MAX } from "../../../../src/web-hub/protocol/worktree-diff.js";

const DIR = fileURLToPath(new URL("../../../../src/web-hub/hub/worktree-diff/", import.meta.url));
const FILES = ["routes.ts", "membership.ts", "changeset.ts", "git.ts", "untracked.ts"] as const;

function src(name: (typeof FILES)[number]): string {
  return readFileSync(join(DIR, name), "utf8");
}

/** find `deps.run(` call sites and grab the argument text up to the balanced close */
function runCallSites(text: string): string[] {
  const sites: string[] = [];
  let at = text.indexOf("deps.run(");
  while (at >= 0) {
    let depth = 0;
    let i = at + "deps.run(".length - 1; // at the "("
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    sites.push(text.slice(at, i + 1));
    at = text.indexOf("deps.run(", at + 1);
  }
  return sites;
}

describe("worktree-diff D3 source-scan (§5)", () => {
  it("hub/worktree-diff/** imports no node:fs* and no node:child_process", () => {
    for (const f of FILES) {
      const text = src(f);
      expect(text.match(/from "node:(fs[^"]*|child_process[^"]*)"/g) ?? [], f).toEqual([]);
      expect(text.includes('require("node:fs'), f).toBe(false);
    }
  });

  it("every deps.run( site carries envPolicy minimal + pathOverride + signal; pins everywhere except C1a/C1", () => {
    let total = 0;
    let withoutPins = 0;
    for (const f of FILES) {
      for (const site of runCallSites(src(f))) {
        total += 1;
        expect(site, `${f}: ${site.slice(0, 80)}`).toContain('envPolicy: "minimal"');
        expect(site, `${f}: ${site.slice(0, 80)}`).toContain("pathOverride: WTDIFF_GIT_PATH");
        expect(site, `${f}: ${site.slice(0, 80)}`).toMatch(/signal: opts\.signal|\.\.\.\(opts\.signal === undefined/);
        if (site.includes("pins:")) {
          expect(site).toMatch(/pins: \{ wt: .* git: .* common: .*\}/);
        } else {
          withoutPins += 1;
          // the ONLY unpinned commands are the two admission ones — they carry the cwd instead
          expect(site).toContain("cwd: opts.cwd");
        }
      }
    }
    expect(total).toBe(2); // runAdmissionGit (C1a+C1 share it) + the pinned wrapper
    expect(withoutPins).toBe(1); // the admission helper — §1.8's only unpinned commands
  });

  it("argv reaches git ONLY through wtDiffArgs.* / neutralizeArgs — no inline argv literals", () => {
    for (const f of FILES) {
      const text = src(f);
      // no runner call is ever fed a literal array
      expect(text.match(/\.run\(\s*"/g) ?? [], f); // cmd-tagged sites are fine (they take argv after)
      expect(text.includes("run(["), f).toBe(false);
      expect(text.includes('run(["'), f).toBe(false);
      // the wtdiff constructors are the only argv producers referenced
      const producers = text.match(/wtDiffArgs\.\w+/g) ?? [];
      for (const p of producers) {
        expect([
          "wtDiffArgs.commonDir",
          "wtDiffArgs.worktreeList",
          "wtDiffArgs.head",
          "wtDiffArgs.driverScan",
          "wtDiffArgs.status",
          "wtDiffArgs.checkAttr",
          "wtDiffArgs.numstat",
          "wtDiffArgs.diff",
        ]).toContain(p);
      }
    }
    // every pinned .run("<CMD>", …) site's argv argument derives from wtDiffArgs/neutralizeArgs
    const routes = src("routes.ts");
    for (const m of routes.matchAll(/\.run\("(?:C0|Cc|C2|Ca|C3|C4)", ([^,]+),/g)) {
      expect(m[1]!.trim()).toMatch(/^(argv|caArgv|wtDiffArgs\.\w+\(.*\))$/);
    }
    // the two argv locals are themselves wtDiffArgs products
    expect(routes).toMatch(/const argv = wtDiffArgs\.(status|numstat|diff)\(/);
    expect(routes).toMatch(/wtDiffArgs\.checkAttr\(/);
    // L1/N are the D1 constructors (attrSourceArgs / neutralizeArgs) — no hand-rolled flags
    expect(routes).toContain("attrSourceArgs(c0.format)");
    expect(routes).toContain("neutralizeArgs(drivers)");
    const membership = src("membership.ts");
    expect(membership).toContain("wtDiffArgs.commonDir(args.cwd)");
    expect(membership).toContain("wtDiffArgs.worktreeList(args.cwd)");
  });

  it("the per-request audit line goes ONLY through auditWorktreeDiff (§2.9)", () => {
    for (const f of FILES) {
      const text = src(f);
      expect(text.includes('audit: "wtdiff"'), f).toBe(false); // never hand-built
      expect(text.match(/log\.info\("wtdiff"/g) ?? [], f).toEqual([]);
    }
    const routes = src("routes.ts");
    expect(routes).toContain("auditWorktreeDiff(log,");
    expect(routes.match(/auditWorktreeDiff\(/g)?.length).toBe(1); // exactly the ⑬ finally line
  });

  it("cross-layer constants: src/git WTDIFF_DRIVER_SCAN_MAX === protocol WTDIFF_DRIVERS_MAX (D1 deviation #3)", () => {
    expect(WTDIFF_DRIVER_SCAN_MAX).toBe(WTDIFF_DRIVERS_MAX);
    expect(WTDIFF_DRIVER_SCAN_MAX).toBe(16);
  });

  it("isGitTooOldExit covers BOTH frozen spellings: --attr-source (C2/C3/C4) and --source= (Ca)", async () => {
    const { attrSourceArgs, wtDiffArgs } = await import("../../../../src/git/diff.js");
    const { isGitTooOldExit } = await import("../../../../src/web-hub/hub/worktree-diff/git.js");
    const l1 = attrSourceArgs("sha1");
    const [caArgv] = wtDiffArgs.checkAttr("0123456789abcdef0123456789abcdef01234567", ["a.txt"]);
    // the real argv shapes (r_C08QEVY5 #4)
    expect(l1.some((a) => a.startsWith("--attr-source"))).toBe(true);
    expect(caArgv!.some((a) => a.startsWith("--source="))).toBe(true);
    expect(isGitTooOldExit(l1, 129)).toBe(true);
    expect(isGitTooOldExit(caArgv!, 129)).toBe(true);
    // non-129 exits and unrelated 129s stay out
    expect(isGitTooOldExit(l1, 128)).toBe(false);
    expect(isGitTooOldExit(["rev-parse", "HEAD"], 129)).toBe(false);
  });

  it("the pin-open flags are the documented Linux ABI (mirrored against node:fs in membership.test.ts)", () => {
    const membership = src("membership.ts");
    expect(membership).toContain("export const WTDIFF_DIR_OPEN_FLAGS = 0 | 0o200000 | 0o400000;");
  });
});
