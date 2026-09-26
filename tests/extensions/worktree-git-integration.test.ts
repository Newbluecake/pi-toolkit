import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { createWorktreeExtension } from "../../src/extensions/worktree.js";
import type { RunOutcome, SessionSpec, SpawnRequest } from "../../src/core/types.js";

const execFileAsync = promisify(execFile);
const realExec = async (cmd: string, args: readonly string[], opts: { cwd?: string; timeout?: number }) => {
  try {
    const r = await execFileAsync(cmd, [...args], { cwd: opts.cwd, timeout: opts.timeout });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? String(e) };
  }
};

const dirs: string[] = [];
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagent-git-"));
  dirs.push(dir);
  await realExec("git", ["init", "-q"], { cwd: dir });
  await realExec("git", ["config", "user.email", "t@t"], { cwd: dir });
  await realExec("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "a.txt"), "1");
  await realExec("git", ["add", "-A"], { cwd: dir });
  await realExec("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

// spec.cwd MUST point at the repo under test — without it the extension
// resolves process.cwd() and would operate on this project's own checkout
// (learned the hard way: a failing assertion + a stray pi-agent branch).
const spec = (repo: string): SessionSpec =>
  ({ runId: "r-git", type: "worker", prompt: "p", cwd: repo }) as unknown as SessionSpec;
const req = (runId: string): SpawnRequest => ({ type: "worker", prompt: "p", runId, isolation: "worktree" });
const outcome = (runId: string): RunOutcome =>
  ({ runId, status: "completed", diag: {}, turns: 0, durationMs: 1 }) as unknown as RunOutcome;

describe("X1 worktree against real git", () => {
  it("creates a real worktree, commits changes to a pi-agent branch, and removes the worktree", async () => {
    const repo = await makeRepo();
    const wtRoot = join(repo, ".wt");
    const ext = createWorktreeExtension({ exec: realExec, settings: { enabled: true }, worktreeRoot: wtRoot });

    const rewritten = await ext.resolveSessionSpec!(spec(repo), req("r-git"));
    expect(rewritten.cwd).toContain(".wt");
    // the worktree is a real git checkout
    const inside = await realExec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: rewritten.cwd });
    expect(inside.stdout.trim()).toBe("true");

    // simulate the subagent making a change inside the worktree
    await writeFile(join(rewritten.cwd!, "made-by-agent.txt"), "hello");
    const dispositions: Array<{ state: string; branch?: string; commit?: string; path?: string }> = [];
    await ext.beforeReap!(outcome("r-git"), {
      cwd: rewritten.cwd!,
      deadlineMs: 10_000,
      setWorktreeDisposition: (d) => dispositions.push(d),
    });

    // branch with the change exists in the main repo
    const branches = await realExec("git", ["branch", "--list", "pi-agent-r-git"], { cwd: repo });
    expect(branches.stdout.trim()).toContain("pi-agent-r-git");
    const files = await realExec("git", ["show", "--name-only", "--format=", "pi-agent-r-git"], { cwd: repo });
    expect(files.stdout).toContain("made-by-agent.txt");
    // worktree is gone
    const list = await realExec("git", ["worktree", "list", "--porcelain"], { cwd: repo });
    expect(list.stdout).not.toContain(".wt");
    // replay-verify plan D1: the reported commit sha equals the real branch tip
    const branchSha = (await realExec("git", ["rev-parse", "pi-agent-r-git"], { cwd: repo })).stdout.trim();
    expect(dispositions).toEqual([{ state: "committed", branch: "pi-agent-r-git", commit: branchSha }]);
  });

  it("removes the worktree without creating a branch when nothing changed", async () => {
    const repo = await makeRepo();
    const wtRoot = join(repo, ".wt2");
    const ext = createWorktreeExtension({ exec: realExec, settings: { enabled: true }, worktreeRoot: wtRoot });
    const rewritten = await ext.resolveSessionSpec!(spec(repo), req("r-clean"));
    await ext.beforeReap!(outcome("r-clean"), { cwd: rewritten.cwd!, deadlineMs: 10_000 });
    const branches = await realExec("git", ["branch", "--list", "pi-agent-r-clean"], { cwd: repo });
    expect(branches.stdout.trim()).toBe("");
    const list = await realExec("git", ["worktree", "list", "--porcelain"], { cwd: repo });
    expect(list.stdout).not.toContain(".wt2");
  });

  it("data-loss fix: a sub agent that commits its own work (clean tree, detached HEAD moved) still lands on a pi-agent branch instead of a dangling commit", async () => {
    const repo = await makeRepo();
    const wtRoot = join(repo, ".wt4");
    const ext = createWorktreeExtension({ exec: realExec, settings: { enabled: true }, worktreeRoot: wtRoot });
    const rewritten = await ext.resolveSessionSpec!(spec(repo), req("r-selfcommit"));

    // the sub agent runs its own `git add` + `git commit` (exactly what a real
    // Agent tool call can do inside its worktree), leaving the working tree
    // clean afterwards. Before this fix, H3 only looked at `git status` — a
    // clean tree here force-removed the worktree WITHOUT ever building the
    // pi-agent branch, turning the sub agent's commit into a dangling object
    // recoverable only via `git fsck --unreachable`.
    await writeFile(join(rewritten.cwd!, "agent-work.txt"), "done by the sub agent");
    await realExec("git", ["add", "-A"], { cwd: rewritten.cwd! });
    await realExec("git", ["commit", "-qm", "sub agent work"], { cwd: rewritten.cwd! });
    const selfCommit = (await realExec("git", ["rev-parse", "HEAD"], { cwd: rewritten.cwd! })).stdout.trim();
    const status = await realExec("git", ["status", "--porcelain"], { cwd: rewritten.cwd! });
    expect(status.stdout.trim()).toBe(""); // confirms the reproduction: clean tree, HEAD advanced

    const dispositions: Array<{ state: string; branch?: string; commit?: string }> = [];
    await ext.beforeReap!(outcome("r-selfcommit"), {
      cwd: rewritten.cwd!,
      deadlineMs: 10_000,
      setWorktreeDisposition: (d) => dispositions.push(d),
    });

    // pi-agent-<runId> exists in the MAIN repo and points at exactly the sub
    // agent's own commit.
    const branchHead = await realExec("git", ["rev-parse", "pi-agent-r-selfcommit"], { cwd: repo });
    expect(branchHead.stdout.trim()).toBe(selfCommit);
    // replay-verify plan D1: the clean+headAdvanced path also reports a sha —
    // it must equal the sub agent's own commit (H2 never touched anything).
    expect(dispositions).toEqual([{ state: "committed", branch: "pi-agent-r-selfcommit", commit: selfCommit }]);
    const files = await realExec("git", ["show", "--name-only", "--format=", "pi-agent-r-selfcommit"], { cwd: repo });
    expect(files.stdout).toContain("agent-work.txt");
    // worktree was still safely removed (the commit lives on the branch now)
    const list = await realExec("git", ["worktree", "list", "--porcelain"], { cwd: repo });
    expect(list.stdout).not.toContain(".wt4");
  });

  it("preserves the worktree (and its uncommitted files) when the commit is rejected by a hook", async () => {
    const repo = await makeRepo();
    // a pre-commit hook that always fails forces the commit chain to break
    await writeFile(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const wtRoot = join(repo, ".wt3");
    const diagnostics: Array<{ message: string }> = [];
    const ext = createWorktreeExtension({
      exec: realExec,
      settings: { enabled: true },
      worktreeRoot: wtRoot,
      onDiagnostic: (event) => diagnostics.push(event),
    });
    const rewritten = await ext.resolveSessionSpec!(spec(repo), req("r-hook"));
    await writeFile(join(rewritten.cwd!, "made-by-agent.txt"), "precious");
    await ext.beforeReap!(outcome("r-hook"), { cwd: rewritten.cwd!, deadlineMs: 10_000 });

    // worktree still on disk, uncommitted file intact, no branch created
    const list = await realExec("git", ["worktree", "list", "--porcelain"], { cwd: repo });
    expect(list.stdout).toContain(".wt3");
    const content = await realExec("git", ["status", "--porcelain"], { cwd: rewritten.cwd! });
    expect(content.stdout).toContain("made-by-agent.txt");
    // the branch ref exists (created by `git switch -c`) but points at HEAD —
    // it must NOT contain the uncommitted file
    const files = await realExec("git", ["show", "--name-only", "--format=", "pi-agent-r-hook"], { cwd: repo });
    expect(files.stdout).not.toContain("made-by-agent.txt");
    expect(diagnostics.some((d) => d.message.includes(`preserved at ${rewritten.cwd!}`))).toBe(true);

    // manual recovery path works: remove the preserved worktree ourselves
    const remove = await realExec("git", ["worktree", "remove", "--force", rewritten.cwd!], { cwd: repo });
    expect(remove.code).toBe(0);
  });
});
