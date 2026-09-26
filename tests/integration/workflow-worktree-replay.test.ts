import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { systemClock } from "../../src/core/clock.js";
import { createWorktreeExtension } from "../../src/extensions/worktree.js";
import type { RunOutcome, SessionSpec, SpawnRequest, WorktreeDisposal } from "../../src/core/types.js";
import { buildEntry, CHAIN_SEED, taskKeyOf } from "../../src/workflow/journal.js";
import { verifyIsolatedEntries, type ProbeAgentBranchesFn } from "../../src/workflow/isolation-verify.js";
import { buildReplayIndex } from "../../src/workflow/replay.js";
import { decideReplay } from "../../src/workflow/replay.js";
import type { TaskSemantics } from "../../src/workflow/types.js";

const execFileAsync = promisify(execFile);
const realExec = async (
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; timeout?: number; signal?: AbortSignal },
) => {
  try {
    const r = await execFileAsync(cmd, [...args], { cwd: opts.cwd, timeout: opts.timeout, signal: opts.signal });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? String(e) };
  }
};

/** The real `probeAgentBranches` port (stack.ts's shape) — a single real `git for-each-ref`. */
function realProbe(repoCwd: () => string): ProbeAgentBranchesFn {
  return async (branches, opts) => {
    const result = await realExec(
      "git",
      ["for-each-ref", "--format=%(refname) %(objectname)", ...branches.map((b) => `refs/heads/${b}`)],
      { cwd: opts.cwd ?? repoCwd(), timeout: opts.timeoutMs, signal: opts.signal },
    );
    if (result.code !== 0) return { ok: false, error: result.stderr.trim() || `exit ${result.code}` };
    const tips = new Map<string, string>();
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const idx = trimmed.lastIndexOf(" ");
      if (idx === -1) continue;
      tips.set(trimmed.slice(0, idx), trimmed.slice(idx + 1));
    }
    return { ok: true, tips };
  };
}

const dirs: string[] = [];
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagent-replay-verify-"));
  dirs.push(dir);
  await realExec("git", ["init", "-q"], { cwd: dir });
  await realExec("git", ["config", "user.email", "t@t"], { cwd: dir });
  await realExec("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "a.txt"), "1");
  await realExec("git", ["add", "-A"], { cwd: dir });
  await realExec("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

const spec = (repo: string): SessionSpec =>
  ({ runId: "r-git", type: "worker", prompt: "p", cwd: repo }) as unknown as SessionSpec;
const req = (runId: string): SpawnRequest => ({ type: "worker", prompt: "p", runId, isolation: "worktree" });
const outcome = (runId: string): RunOutcome =>
  ({ runId, status: "completed", diag: {}, turns: 0, durationMs: 1 }) as unknown as RunOutcome;

/** Drives H2 (create) then H3 (commit) through the REAL worktree extension, and returns the disposal it reported. */
async function createAndCommit(repo: string, runId: string, wtRoot: string): Promise<WorktreeDisposal> {
  const ext = createWorktreeExtension({ exec: realExec, settings: { enabled: true }, worktreeRoot: wtRoot });
  const rewritten = await ext.resolveSessionSpec!(spec(repo), req(runId));
  await writeFile(join(rewritten.cwd!, `made-by-${runId}.txt`), "hello");
  let disposal: WorktreeDisposal | undefined;
  await ext.beforeReap!(outcome(runId), {
    cwd: rewritten.cwd!,
    deadlineMs: 10_000,
    setWorktreeDisposition: (d) => {
      disposal = d;
    },
  });
  return disposal!;
}

const isoSem = (prompt: string): TaskSemantics => ({
  agentType: "worker",
  agentTypeConfigHash: "h1",
  prompt,
  isolation: "worktree",
});

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("replay-verify plan §6 P2 test 21: real git + real worktree extension + the real verify/decide pipeline", () => {
  it("scenario: intact branch verifies and hits; deleted branch (merged & deleted) does not; forced/rebased branch does not", async () => {
    const repo = await makeRepo();
    const disposal = await createAndCommit(repo, "r-live", join(repo, ".wt"));
    expect(disposal.state).toBe("committed");
    const branch = disposal.branch!;
    const commit = disposal.commit!;

    const entry = buildEntry({
      scope: "chain",
      key: taskKeyOf(isoSem("do-the-thing")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "worker",
      isolation: "worktree",
      worktree: { state: "committed", branch, commit, isoId: "b".repeat(32) },
      value: "iso-out",
      completedAt: 1000,
      durationMs: 10,
    });

    // (1) Intact: verifies and would hit.
    {
      const result = await verifyIsolatedEntries(
        [entry],
        realProbe(() => repo),
        {
          cwd: repo,
          timeoutMs: 5_000,
          clock: systemClock,
        },
      );
      expect(result.verified).toEqual(new Set([entry.digest]));
      const index = buildReplayIndex([entry], 0, "chain");
      const decision = decideReplay({
        index,
        taskKey: entry.key,
        chainDigestBefore: CHAIN_SEED,
        occurrence: 0,
        noReplay: false,
        deterministic: true,
        now: 2_000,
        isolation: true,
        isolationReplay: "verify",
        isolationVerified: (e) => result.verified.has(e.digest),
      });
      expect(decision.kind).toBe("hit");
    }

    // (2) Merged and deleted: no longer verifies.
    await realExec("git", ["branch", "-D", branch], { cwd: repo });
    {
      const result = await verifyIsolatedEntries(
        [entry],
        realProbe(() => repo),
        {
          cwd: repo,
          timeoutMs: 5_000,
          clock: systemClock,
        },
      );
      expect(result.verified.size).toBe(0);
    }

    // (3) Recreate the branch pointing somewhere else (simulating a force-push/rebase): still no verify.
    await realExec("git", ["branch", branch], { cwd: repo }); // now points at current HEAD (init commit), not `commit`
    {
      const result = await verifyIsolatedEntries(
        [entry],
        realProbe(() => repo),
        {
          cwd: repo,
          timeoutMs: 5_000,
          clock: systemClock,
        },
      );
      expect(result.verified.size).toBe(0);
    }
  });

  it("scenario: probing from a repo subdirectory still finds the branch (for-each-ref works from any cwd inside the repo)", async () => {
    const repo = await makeRepo();
    const disposal = await createAndCommit(repo, "r-sub", join(repo, ".wt"));
    const branch = disposal.branch!;
    const commit = disposal.commit!;
    const entry = buildEntry({
      scope: "chain",
      key: taskKeyOf(isoSem("sub-thing")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "worker",
      isolation: "worktree",
      worktree: { state: "committed", branch, commit, isoId: "c".repeat(32) },
      value: "v",
      completedAt: 1000,
      durationMs: 10,
    });
    const sub = join(repo, "sub");
    await realExec("mkdir", ["-p", sub], {});
    const result = await verifyIsolatedEntries(
      [entry],
      realProbe(() => sub),
      {
        cwd: sub,
        timeoutMs: 5_000,
        clock: systemClock,
      },
    );
    expect(result.verified).toEqual(new Set([entry.digest]));
  });

  it("scenario: the repo is moved to a new directory — probing at the new location still finds the branch", async () => {
    const repo = await makeRepo();
    const disposal = await createAndCommit(repo, "r-mv", join(repo, ".wt"));
    const branch = disposal.branch!;
    const commit = disposal.commit!;
    const entry = buildEntry({
      scope: "chain",
      key: taskKeyOf(isoSem("mv-thing")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "worker",
      isolation: "worktree",
      worktree: { state: "committed", branch, commit, isoId: "d".repeat(32) },
      value: "v",
      completedAt: 1000,
      durationMs: 10,
    });
    const movedTo = `${repo}-moved`;
    dirs.push(movedTo);
    await rename(repo, movedTo);
    const result = await verifyIsolatedEntries(
      [entry],
      realProbe(() => movedTo),
      {
        cwd: movedTo,
        timeoutMs: 5_000,
        clock: systemClock,
      },
    );
    expect(result.verified).toEqual(new Set([entry.digest]));
  });

  it("scenario: probing a non-git directory degrades to live (probe error, nothing verified, never hangs)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-subagent-replay-verify-nogit-"));
    dirs.push(dir);
    const entry = buildEntry({
      scope: "chain",
      key: taskKeyOf(isoSem("no-git")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "worker",
      isolation: "worktree",
      worktree: { state: "committed", branch: "pi-agent-x", commit: "a".repeat(40), isoId: "e".repeat(32) },
      value: "v",
      completedAt: 1000,
      durationMs: 10,
    });
    const result = await verifyIsolatedEntries(
      [entry],
      realProbe(() => dir),
      {
        cwd: dir,
        timeoutMs: 5_000,
        clock: systemClock,
      },
    );
    expect(result.verified.size).toBe(0);
    expect(result.probeError).toBeDefined();
  });

  it("scenario: a merged-but-not-deleted branch still verifies (merging keeps the ref intact)", async () => {
    const repo = await makeRepo();
    const disposal = await createAndCommit(repo, "r-merge", join(repo, ".wt"));
    const branch = disposal.branch!;
    const commit = disposal.commit!;
    await realExec("git", ["merge", "--no-edit", branch], { cwd: repo }); // merge but do NOT delete the branch
    const entry = buildEntry({
      scope: "chain",
      key: taskKeyOf(isoSem("merge-thing")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "worker",
      isolation: "worktree",
      worktree: { state: "committed", branch, commit, isoId: "f".repeat(32) },
      value: "v",
      completedAt: 1000,
      durationMs: 10,
    });
    const result = await verifyIsolatedEntries(
      [entry],
      realProbe(() => repo),
      {
        cwd: repo,
        timeoutMs: 5_000,
        clock: systemClock,
      },
    );
    expect(result.verified).toEqual(new Set([entry.digest]));
  });

  it("scenario: a DIFFERENT clone of the same journal namespace — the branch doesn't exist there by default (only a remote-tracking ref) so it goes live; creating a same-name local branch with the same sha in the clone verifies (content, not path, is what matters)", async () => {
    const repo = await makeRepo();
    const disposal = await createAndCommit(repo, "r-clone", join(repo, ".wt"));
    const branch = disposal.branch!;
    const commit = disposal.commit!;
    const entry = buildEntry({
      scope: "chain",
      key: taskKeyOf(isoSem("clone-thing")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "worker",
      isolation: "worktree",
      worktree: { state: "committed", branch, commit, isoId: "g".repeat(32) },
      value: "v",
      completedAt: 1000,
      durationMs: 10,
    });

    const clone = await mkdtemp(join(tmpdir(), "pi-subagent-replay-verify-clone-"));
    dirs.push(clone);
    await realExec("git", ["clone", "-q", repo, clone], {});

    // (1) A plain local clone: `git clone` only creates a local branch for
    // the default checked-out ref; `pi-agent-*` exists only as
    // `refs/remotes/origin/...` there — `for-each-ref refs/heads/<branch>`
    // finds nothing, so this correctly goes live (plan §3's scenario table).
    {
      const result = await verifyIsolatedEntries(
        [entry],
        realProbe(() => clone),
        { cwd: clone, timeoutMs: 5_000, clock: systemClock },
      );
      expect(result.verified.size).toBe(0);
    }

    // (2) Create a same-name LOCAL branch in the clone pointing at the exact
    // same commit (e.g. the user fetched/checked it out themselves) — the
    // probe only cares about ref-name + object-sha, never the physical repo
    // path, so this now verifies.
    await realExec("git", ["branch", branch, commit], { cwd: clone });
    {
      const result = await verifyIsolatedEntries(
        [entry],
        realProbe(() => clone),
        { cwd: clone, timeoutMs: 5_000, clock: systemClock },
      );
      expect(result.verified).toEqual(new Set([entry.digest]));
    }
  });
});
