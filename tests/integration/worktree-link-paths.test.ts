import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readlinkSync, realpathSync } from "node:fs";
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
async function makeRepoWithLinkPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagent-linkpaths-"));
  dirs.push(dir);
  await realExec("git", ["init", "-q"], { cwd: dir });
  await realExec("git", ["config", "user.email", "t@t"], { cwd: dir });
  await realExec("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, ".gitignore"), "vendor_link/\n");
  await writeFile(join(dir, "a.txt"), "1");
  await realExec("git", ["add", "-A"], { cwd: dir });
  await realExec("git", ["commit", "-qm", "init"], { cwd: dir });
  // the "shared dependency" directory: created AFTER the initial commit,
  // gitignored, never tracked.
  await import("node:fs/promises").then((fs) => fs.mkdir(join(dir, "vendor_link")));
  await writeFile(join(dir, "vendor_link", "lib.js"), "module.exports = 1;\n");
  return dir;
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const spec = (repo: string): SessionSpec => ({ cwd: repo }) as unknown as SessionSpec;
const req = (runId: string): SpawnRequest => ({ type: "worker", prompt: "p", runId, isolation: "worktree" });
const outcome = (runId: string): RunOutcome =>
  ({ runId, status: "completed", diag: {}, turns: 0, durationMs: 1 }) as unknown as RunOutcome;

describe("D9 linkPaths against real git (workflow-worktree plan, P1 test #6)", () => {
  it("symlinks the configured path read-only into the worktree and adds a promptNotes entry", async () => {
    const repo = await makeRepoWithLinkPath();
    const wtRoot = join(repo, ".wt-link");
    const ext = createWorktreeExtension({
      exec: realExec,
      settings: { enabled: true, linkPaths: ["vendor_link"] },
      worktreeRoot: wtRoot,
    });
    const rewritten = await ext.resolveSessionSpec!(spec(repo), req("r-link"));
    expect(rewritten.cwd).toContain(".wt-link");
    const linkPath = join(rewritten.cwd!, "vendor_link");
    expect(realpathSync(linkPath)).toBe(realpathSync(join(repo, "vendor_link")));
    expect(readlinkSync(linkPath)).toBe(join(repo, "vendor_link"));
    expect(rewritten.promptNotes).toBeDefined();
    expect(rewritten.promptNotes!.join(" ")).toContain("vendor_link");
    expect(rewritten.promptNotes!.join(" ")).toContain("READ-ONLY");

    // the agent reads through the symlink but only writes real changes elsewhere
    await writeFile(join(rewritten.cwd!, "made-by-agent.txt"), "hello");
    await ext.beforeReap!(outcome("r-link"), { cwd: rewritten.cwd!, deadlineMs: 10_000 });

    // the branch must contain the real change but never the symlink itself
    const files = await realExec("git", ["show", "--name-only", "--format=", "pi-agent-r-link"], { cwd: repo });
    expect(files.stdout).toContain("made-by-agent.txt");
    expect(files.stdout).not.toContain("vendor_link");

    // main checkout's vendor_link is untouched
    const mainContent = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(repo, "vendor_link", "lib.js"), "utf8"),
    );
    expect(mainContent).toBe("module.exports = 1;\n");
  });

  it("removes a worktree with only a symlink touched as clean (never tracks the symlink)", async () => {
    const repo = await makeRepoWithLinkPath();
    const wtRoot = join(repo, ".wt-link-clean");
    const ext = createWorktreeExtension({
      exec: realExec,
      settings: { enabled: true, linkPaths: ["vendor_link"] },
      worktreeRoot: wtRoot,
    });
    const rewritten = await ext.resolveSessionSpec!(spec(repo), req("r-link-clean"));
    // "read" through the symlink but make no real changes
    await import("node:fs/promises").then((fs) => fs.readFile(join(rewritten.cwd!, "vendor_link", "lib.js"), "utf8"));
    await ext.beforeReap!(outcome("r-link-clean"), { cwd: rewritten.cwd!, deadlineMs: 10_000 });
    const branches = await realExec("git", ["branch", "--list", "pi-agent-r-link-clean"], { cwd: repo });
    expect(branches.stdout.trim()).toBe(""); // clean — no branch created
    const list = await realExec("git", ["worktree", "list", "--porcelain"], { cwd: repo });
    expect(list.stdout).not.toContain(".wt-link-clean");
  });

  it("default linkPaths=[] leaves the prompt byte-identical (no promptNotes key at all)", async () => {
    const repo = await makeRepoWithLinkPath();
    const wtRoot = join(repo, ".wt-nolink");
    const ext = createWorktreeExtension({ exec: realExec, settings: { enabled: true }, worktreeRoot: wtRoot });
    const rewritten = await ext.resolveSessionSpec!(spec(repo), req("r-nolink"));
    expect(Object.keys(rewritten)).not.toContain("promptNotes");
    await ext.beforeReap!(outcome("r-nolink"), { cwd: rewritten.cwd!, deadlineMs: 10_000 });
  });
});
