import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createGitRunner } from "../../src/git/run.js";
import { scanWorktrees } from "../../src/git/worktrees.js";

// Real-git regression: the mocked-runner suite could not notice that `--untracked-files normal`
// (space-separated) makes git treat `normal` as a pathspec, so every worktree probed as clean.
describe("scanWorktrees against a real git repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-scan-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
  };

  it("counts a tracked modification and an untracked file; degraded mode skips the untracked one", async () => {
    git("init", "-q");
    writeFileSync(join(dir, "tracked.txt"), "a\n");
    git("add", "tracked.txt");
    git("commit", "-qm", "init");
    writeFileSync(join(dir, "tracked.txt"), "b\n");
    writeFileSync(join(dir, "new.txt"), "n\n");

    const run = createGitRunner();
    const normal = await scanWorktrees(run, dir, { signal: new AbortController().signal });
    expect(normal.kind).toBe("ok");
    if (normal.kind !== "ok") return;
    expect(normal.worktrees[0]?.probe?.dirty).toBe(2);

    const degraded = await scanWorktrees(run, dir, {
      signal: new AbortController().signal,
      realpath: async () => "/degraded",
      degraded: new Set(["/degraded"]),
    });
    expect(degraded.kind).toBe("ok");
    if (degraded.kind !== "ok") return;
    expect(degraded.worktrees[0]?.probe?.dirty).toBe(1);
    expect(degraded.worktrees[0]?.probe?.untrackedSkipped).toBe(true);
  });
});
