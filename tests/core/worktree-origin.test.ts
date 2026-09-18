import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { forgetWorktreeOrigin, recordWorktreeOrigin, resolveWorktreeOrigin } from "../../src/core/worktree-origin.js";

/** Unique non-existent paths — realpath fails → raw fallback keeps keys exact. */
function fakePath(tag: string): string {
  return join(mkdtempSync(join(tmpdir(), "wto-")), "nonexistent-" + tag);
}

describe("worktree-origin registry", () => {
  it("record / resolve / forget round-trip", () => {
    const wt = fakePath("wt");
    const repo = fakePath("repo");
    expect(resolveWorktreeOrigin(wt)).toBeUndefined();
    recordWorktreeOrigin(wt, repo);
    expect(resolveWorktreeOrigin(wt)).toBe(repo);
    forgetWorktreeOrigin(wt);
    expect(resolveWorktreeOrigin(wt)).toBeUndefined();
  });

  it("resolve is undefined for unknown paths (non-worktree sessions unchanged)", () => {
    expect(resolveWorktreeOrigin(fakePath("unknown"))).toBeUndefined();
  });

  it("resolves transitively (worktree-of-worktree → main repo), cap 4 hops", () => {
    const [a, b, c, d, e, f] = [
      fakePath("a"),
      fakePath("b"),
      fakePath("c"),
      fakePath("d"),
      fakePath("e"),
      fakePath("f"),
    ];
    recordWorktreeOrigin(a, b);
    recordWorktreeOrigin(b, c);
    expect(resolveWorktreeOrigin(a)).toBe(c); // A→B→C fully resolved
    // extend to a 5-link chain: A→B→C→D→E→F needs 5 hops, cap is 4 → stops at E
    recordWorktreeOrigin(c, d);
    recordWorktreeOrigin(d, e);
    recordWorktreeOrigin(e, f);
    expect(resolveWorktreeOrigin(a)).toBe(e);
    for (const p of [a, b, c, d, e]) forgetWorktreeOrigin(p);
  });

  it("re-record overwrites and refreshes recency", () => {
    const wt = fakePath("wt");
    const r1 = fakePath("r1");
    const r2 = fakePath("r2");
    recordWorktreeOrigin(wt, r1);
    recordWorktreeOrigin(wt, r2);
    expect(resolveWorktreeOrigin(wt)).toBe(r2);
    forgetWorktreeOrigin(wt);
  });

  it("evicts the OLDEST entry (FIFO) past the 256 cap — no blanket clear (R6)", () => {
    const first = fakePath("first");
    const firstRepo = fakePath("first-repo");
    const recorded: string[] = [first];
    recordWorktreeOrigin(first, firstRepo);
    let second = "";
    for (let i = 0; i < 256; i++) {
      const p = fakePath(`bulk-${i}`);
      if (i === 0) second = p;
      recorded.push(p);
      recordWorktreeOrigin(p, fakePath(`bulk-repo-${i}`));
    }
    // 257 records over a 256 cap → exactly the oldest (first) is evicted
    expect(resolveWorktreeOrigin(first)).toBeUndefined();
    expect(resolveWorktreeOrigin(second)).toBeDefined(); // everything newer survives
    for (const p of recorded) forgetWorktreeOrigin(p);
  });

  it("normalizes symlinked keys on both record and resolve (R1)", () => {
    const real = mkdtempSync(join(tmpdir(), "wto-real-"));
    const linkDir = mkdtempSync(join(tmpdir(), "wto-link-"));
    const link = join(linkDir, "wt-link");
    symlinkSync(real, link);
    const repo = fakePath("repo");
    // record via the symlink, resolve via the realpath — and vice versa
    recordWorktreeOrigin(link, repo);
    expect(resolveWorktreeOrigin(real)).toBe(repo);
    expect(resolveWorktreeOrigin(link)).toBe(repo);
    expect(resolveWorktreeOrigin(realpathSync(real))).toBe(repo);
    forgetWorktreeOrigin(real);
    expect(resolveWorktreeOrigin(link)).toBeUndefined();
  });

  it("normalizes symlinked originalCwd values too", () => {
    const realRepo = mkdtempSync(join(tmpdir(), "wto-repo-"));
    const linkDir = mkdtempSync(join(tmpdir(), "wto-repolink-"));
    const repoLink = join(linkDir, "repo-link");
    symlinkSync(realRepo, repoLink);
    const wt = fakePath("wt2");
    recordWorktreeOrigin(wt, repoLink);
    expect(resolveWorktreeOrigin(wt)).toBe(realpathSync(realRepo));
    forgetWorktreeOrigin(wt);
  });

  it("mkdir-sync'd real dirs resolve through realpath normalization (macOS /var vs /private/var shape)", () => {
    // tmpdir() itself may sit behind a symlink; recording the raw tmpdir path
    // and resolving the realpath (or vice versa) must still hit.
    const wt = mkdtempSync(join(tmpdir(), "wto-wt-"));
    const repo = fakePath("repo3");
    recordWorktreeOrigin(wt, repo);
    expect(resolveWorktreeOrigin(realpathSync(wt))).toBe(repo);
    forgetWorktreeOrigin(wt);
    expect(resolveWorktreeOrigin(realpathSync(wt))).toBeUndefined();
  });
});
