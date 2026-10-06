import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitRunner } from "../../src/git/run.js";
import { scanWorktrees } from "../../src/git/worktrees.js";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const tempRoots = new Set<string>();

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-worktrees-"));
  tempRoots.add(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "tracked.txt"), "initial\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-qm", "initial"]);
  return root;
}

afterEach(async () => {
  await Promise.all([...tempRoots].map((root) => rm(root, { force: true, recursive: true })));
  tempRoots.clear();
});

describe.skipIf(!hasGit)("real git worktree scanning", () => {
  it("reports main, linked, detached, locked, and current symlink rows", async () => {
    const root = await repo();
    const linked = `${root}-linked`;
    const detached = `${root}-detached`;
    const cwdLink = `${root}-cwd-link`;
    git(root, ["worktree", "add", "-q", "-b", "feature", linked]);
    git(root, ["worktree", "add", "-q", "--detach", detached]);
    git(root, ["worktree", "lock", "--reason", "test", linked]);
    await mkdir(join(linked, "subdir"));
    await symlink(linked, cwdLink, "dir");
    const result = await scanWorktrees(createGitRunner(), join(cwdLink, "subdir"), {
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const linkedRow = result.worktrees.find((row) => row.path === linked);
    expect(linkedRow?.current).toBe(true);
    expect(linkedRow?.locked).toBe(true);
    expect(result.worktrees.some((row) => row.detached)).toBe(true);
  });

  it("reports a bare repository main worktree without probing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-bare-"));
    tempRoots.add(root);
    const source = await repo();
    const bare = join(root, "remote.git");
    const linked = join(root, "linked");
    git(root, ["clone", "--bare", source, bare]);
    git(root, ["--git-dir", bare, "worktree", "add", "-q", linked, "main"]);
    const result = await scanWorktrees(createGitRunner(), linked, { signal: new AbortController().signal });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const bareRow = result.worktrees.find((row) => row.path === bare);
    expect(bareRow?.main).toBe(true);
    expect(bareRow?.bare).toBe(true);
    expect(bareRow?.probe).toBeUndefined();
  });

  it("rebuilds a pruned linked worktree without duplicate rows", async () => {
    const root = await repo();
    const linked = `${root}-rebuild`;
    git(root, ["worktree", "add", "-q", "-b", "rebuild", linked]);
    await rm(linked, { force: true, recursive: true });
    git(root, ["worktree", "prune"]);
    git(root, ["worktree", "add", "-q", "-b", "recreated", linked]);
    const result = await scanWorktrees(createGitRunner(), root, { signal: new AbortController().signal });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.worktrees.filter((row) => row.path === linked)).toHaveLength(1);
    expect(result.worktrees.find((row) => row.path === linked)?.prunable).toBeUndefined();
  });

  it("marks only the nested worktree current", async () => {
    const root = await repo();
    const nested = join(root, ".wt", "x");
    await mkdir(join(root, ".wt"));
    git(root, ["worktree", "add", "-q", "-b", "nested", nested]);
    const result = await scanWorktrees(createGitRunner(), nested, { signal: new AbortController().signal });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.worktrees.find((row) => row.path === nested)?.current).toBe(true);
    expect(result.worktrees.find((row) => row.path === root)?.current).toBe(false);
  });

  it("reports upstream ahead and distinguishes a branch without upstream", async () => {
    const root = await repo();
    const remote = join(root, "remote.git");
    git(root, ["init", "-q", "--bare", remote]);
    git(root, ["remote", "add", "origin", remote]);
    git(root, ["push", "-q", "--set-upstream", "origin", "main"]);
    await writeFile(join(root, "ahead.txt"), "ahead\n");
    git(root, ["add", "ahead.txt"]);
    git(root, ["commit", "-qm", "ahead"]);
    const noUpstream = `${root}-no-upstream`;
    git(root, ["worktree", "add", "-q", "-b", "no-upstream", noUpstream]);
    const result = await scanWorktrees(createGitRunner(), root, { signal: new AbortController().signal });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const main = result.worktrees.find((row) => row.path === root);
    const other = result.worktrees.find((row) => row.path === noUpstream);
    expect(main?.probe?.upstream).toBe(true);
    expect(main?.probe?.ahead).toBe(1);
    expect(other?.probe?.upstream).toBe(false);
    expect(other?.probe?.ahead).toBe(0);
    expect(other?.probe?.behind).toBe(0);
  });

  it("samples concurrently with git commit without index.lock conflict", async () => {
    const root = await repo();
    const runner = createGitRunner();
    const scan = scanWorktrees(runner, root, { signal: new AbortController().signal });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await writeFile(join(root, "concurrent.txt"), "commit\n");
    git(root, ["add", "concurrent.txt"]);
    expect(() => git(root, ["commit", "-qm", "x"])).not.toThrow();
    const result = await scan;
    expect(result.kind).toBe("ok");
  });

  it("counts a large untracked set as a lower bound when status output caps", async () => {
    const root = await repo();
    await Promise.all(
      Array.from({ length: 3000 }, (_, index) =>
        writeFile(join(root, `zzwt-${String(index).padStart(4, "0")}-with-a-long-name.data`), "x"),
      ),
    );
    const realRunner = createGitRunner();
    const cappedRunner = async (args: readonly string[], options: Parameters<typeof realRunner>[1]) => {
      const result = await realRunner(args, { ...options, maxStdoutBytes: 256 * 1024 });
      if (args.includes("status")) {
        return {
          ...result,
          stdout: result.stdout.slice(0, 4 * 1024),
          stdoutCapped: true,
          killed: "overflow" as const,
          code: null,
        };
      }
      return result;
    };
    const result = await scanWorktrees(cappedRunner, root, { signal: new AbortController().signal });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const main = result.worktrees.find((row) => row.main);
    expect(main?.branch).toBe("main");
    expect(main?.probe?.dirtyCapped).toBe(true);
    expect(main?.probe?.dirty).toBeGreaterThan(0);
  });

  it.skip("supports newline paths in a future -z parser; v1 intentionally does not support them", () => {});
});
