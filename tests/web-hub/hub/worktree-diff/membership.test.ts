/**
 * worktree-diff plan §2.3 (D3): membership + three-fd pinning tests.
 *
 * Every branch of the plan pseudocode over the fake fs + scripted runner: literal match,
 * realpath fan-out, the 64-row fan-out cap (literal match still wins beyond it, #9), bare /
 * prunable / capped-output / dev-ino refusals, the gitdir family (main `.git` must be a
 * directory ≡ commondir; linked `.git` must be a ≤4 KiB `gitdir:` pointer whose realpath IS
 * `<common>/worktrees/<name>`), the denylist/virtual-fs/proc-fd-cwd denials, the C1a/C1 failure
 * mappings, and pin ownership — every failure path closes ALL opened handles (leak-counted).
 */

import { constants as fsConstants } from "node:fs";
import { describe, expect, it } from "vitest";

import { createReqDeadline } from "../../../../src/web-hub/hub/req-deadline.js";
import { denyCtxOf } from "../../../../src/web-hub/hub/preview/admit.js";
import { WTDIFF_DIR_OPEN_FLAGS, createMembership } from "../../../../src/web-hub/hub/worktree-diff/membership.js";
import { WTDIFF_WT_REALPATH_FANOUT_MAX } from "../../../../src/web-hub/protocol/worktree-diff.js";
import {
  AGENT,
  createFakeFs,
  HEAD_SHA1,
  LINKED,
  LINKED_GITDIR,
  REPO,
  REPO_GIT,
  isCmd,
  memLog,
  okRun,
  repoFixture,
  scriptedRunner,
  type ScriptedRunner,
} from "./helpers.js";

const DENY = denyCtxOf("/home/tester", "/home/tester/.pi/agent");

function membershipHarness(fs: FakeFs, runner: ScriptedRunner) {
  const log = memLog();
  const membership = createMembership({
    run: runner,
    fs,
    tracker: { zombies: 0, max: 2 },
    denyCtx: DENY,
    log,
    now: Date.now,
  });
  const call = (cwd: string, wtReq: string) =>
    membership({ cwd, wtReq, deadline: createReqDeadline(Date.now, 8_000), signal: undefined });
  return { membership, call, log };
}

describe("membership §2.3 — admission rows and target matching", () => {
  it("main worktree happy path: pins W/gitdir/commondir with the verified dev:ino ids", async () => {
    const fx = repoFixture();
    const { fs, runner } = fx;
    fx.scriptAdmission();
    const { call } = membershipHarness(fs, runner);
    const r = await call(REPO, REPO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // main worktree: gitdir ≡ commondir (same inode)
    expect(r.pinSet.ids.git.dev).toBe(r.pinSet.ids.common.dev);
    expect(r.pinSet.ids.git.ino).toBe(r.pinSet.ids.common.ino);
    expect(fs.node(REPO_GIT)!.ino).toBe(r.pinSet.ids.git.ino);
    expect(r.W).toBe(REPO);
    // ownership transferred: nothing closed yet
    expect(fs.leakCount()).toBe(3);
    await r.pinSet.release();
    expect(fs.leakCount()).toBe(0);
  });

  it("linked worktree happy path: gitdir is <common>/worktrees/<name> (dev:ino verified)", async () => {
    const fx = repoFixture();
    const { fs, runner } = fx;
    fx.scriptAdmission();
    const { call } = membershipHarness(fs, runner);
    const r = await call(REPO, LINKED);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pinSet.ids.git.ino).toBe(fs.node(LINKED_GITDIR)!.ino);
    expect(r.pinSet.ids.git.ino).not.toBe(r.pinSet.ids.common.ino);
    expect(r.W).toBe(LINKED);
    await r.pinSet.release();
    expect(fs.leakCount()).toBe(0);
  });

  it("argv: C1a and C1 are the ONLY unpinned commands — both carry the session cwd", async () => {
    const fx = repoFixture();
    const { fs, runner } = fx;
    fx.scriptAdmission();
    const { call } = membershipHarness(fs, runner);
    await call(REPO, LINKED);
    expect(runner.calls.length).toBe(2);
    expect(isCmd(runner.calls[0]!.argv, "C1a")).toBe(true);
    expect(isCmd(runner.calls[1]!.argv, "C1")).toBe(true);
    expect(runner.calls[0]!.opts.cwd).toBe(REPO);
    expect(runner.calls[0]!.opts.envPolicy).toBe("minimal");
    expect(runner.calls[0]!.opts.pins).toBeUndefined();
    expect(runner.calls[1]!.opts.pins).toBeUndefined();
  });

  it("symlinked spelling: realpath fan-out finds the row when the literal match misses", async () => {
    const fx = repoFixture();
    const { fs, runner } = fx;
    fx.scriptAdmission();
    fs.symlink("/w/link-to-repo", REPO);
    const { call } = membershipHarness(fs, runner);
    const r = await call(REPO, "/w/link-to-repo");
    expect(r).toMatchObject({ ok: true, W: REPO });
    if (r.ok) await r.pinSet.release();
  });

  it("#9: beyond the 64-row fanout cap a LITERAL match still succeeds", async () => {
    const fx = repoFixture();
    const { fs, runner } = fx;
    const rows = [`worktree ${REPO}`, `HEAD ${HEAD_SHA1}`, "branch refs/heads/main", ""];
    for (let i = 0; i < WTDIFF_WT_REALPATH_FANOUT_MAX + 5; i++) {
      rows.push(`worktree /w/other-${i}`, `HEAD ${HEAD_SHA1}`, "branch refs/heads/b", "");
    }
    // LINKED stays literally listed — the literal match must work even past the fanout cap
    rows.push(`worktree ${LINKED}`, `HEAD ${HEAD_SHA1}`, "branch refs/heads/f", "");
    rows.push("");
    const h = membershipHarness(fs, runner);
    runner.push(okRun(`${REPO_GIT}\n`), okRun(rows.join("\n")), okRun(`sha1\n${HEAD_SHA1}\n`));
    const r = await h.call(REPO, LINKED); // LINKED literally listed ⇒ no fan-out needed
    expect(r).toMatchObject({ ok: true, W: LINKED });
    if (r.ok) await r.pinSet.release();
    expect(fs.leakCount()).toBe(0);
  });

  it("#9: beyond the 64-row fanout cap with NO literal hit ⇒ not-worktree (no fan-out at all)", async () => {
    const { fs, runner } = repoFixture();
    const rows = [`worktree ${REPO}`, `HEAD ${HEAD_SHA1}`, "branch refs/heads/main", ""];
    for (let i = 0; i < WTDIFF_WT_REALPATH_FANOUT_MAX + 5; i++) {
      rows.push(`worktree /w/other-${i}`, `HEAD ${HEAD_SHA1}`, "branch refs/heads/b", "");
    }
    rows.push("");
    const h = membershipHarness(fs, runner);
    runner.push(okRun(`${REPO_GIT}\n`), okRun(rows.join("\n")));
    const r = await h.call(REPO, LINKED); // LINKED not in the listing, fanout would exceed 64
    expect(r).toMatchObject({ ok: false, kind: "denied", reason: "not-worktree" });
    expect(fs.leakCount()).toBe(0);
  });

  it("bare row and prunable row are filtered — a match against them ⇒ not-worktree", async () => {
    const bare = ["worktree /w/bare", "bare", ""].join("\n");
    const prunable = ["worktree /w/gone", `HEAD ${HEAD_SHA1}`, "branch refs/heads/x", "prunable", ""].join("\n");
    for (const [name, list] of [
      ["bare", bare],
      ["prunable", prunable],
    ] as const) {
      const { fs, runner } = repoFixture();
      const h = membershipHarness(fs, runner);
      runner.push(okRun(`${REPO_GIT}\n`), okRun(list));
      const r = await h.call(REPO, name === "bare" ? "/w/bare" : "/w/gone");
      expect(r).toMatchObject({ ok: false, kind: "denied", reason: "not-worktree" });
      expect(fs.leakCount()).toBe(0);
    }
  });

  it("capped porcelain output that never reaches a usable row ⇒ not-worktree", async () => {
    const { fs, runner } = repoFixture();
    const h = membershipHarness(fs, runner);
    runner.push(okRun(`${REPO_GIT}\n`), { ...okRun(`worktree ${REPO}\nHEAD ${HEAD_SHA1}\n`), stdoutCapped: true });
    const r = await h.call(REPO, LINKED);
    expect(r).toMatchObject({ ok: false, kind: "denied", reason: "not-worktree" });
  });

  it("dev/ino mismatch (row stat ≠ open handle) ⇒ not-worktree, pins closed", async () => {
    const fx = repoFixture();
    const { fs, runner } = fx;
    const h = membershipHarness(fs, runner);
    fx.scriptAdmission();
    // the fake's path-stat and handle-stat can never diverge on their own — force the row's
    // stat to report a foreign ino (the §2.3 swap race)
    fs.statInoOverride.set(LINKED, 999_999);
    const r = await h.call(REPO, LINKED);
    expect(r).toMatchObject({ ok: false, kind: "denied", reason: "not-worktree" });
    expect(fs.leakCount()).toBe(0);
  });
});

describe("membership §2.3 — gitdir / commondir family (second review #5)", () => {
  it("main worktree whose `.git` is a FILE ⇒ not-worktree", async () => {
    const fx = repoFixture();
    const { fs, runner } = fx;
    fx.scriptAdmission();
    fs.writeFile(`${REPO}/.git`, `gitdir: ${REPO_GIT}\n`); // .git dir replaced by a file
    const h = membershipHarness(fs, runner);
    const r = await h.call(REPO, REPO);
    expect(r).toMatchObject({ ok: false, kind: "denied", reason: "not-worktree" });
    expect(fs.leakCount()).toBe(0);
  });

  it("linked worktree whose `.git` is a DIRECTORY ⇒ not-worktree", async () => {
    const custom = createFakeFs();
    custom.mkdir("/w/m");
    custom.mkdir("/w/m/.git");
    custom.mkdir("/w/m/.git/worktrees/lw2");
    custom.mkdir("/w/l2");
    custom.mkdir("/w/l2/.git"); // directory, not a pointer file
    const runner2 = scriptedRunner();
    runner2.push(
      okRun("/w/m/.git\n"),
      okRun(
        [
          "worktree /w/m",
          `HEAD ${HEAD_SHA1}`,
          "branch refs/heads/main",
          "",
          "worktree /w/l2",
          `HEAD ${HEAD_SHA1}`,
          "branch refs/heads/f",
          "",
          "",
        ].join("\n"),
      ),
    );
    const h2 = membershipHarness(custom, runner2);
    const r2 = await h2.call("/w/m", "/w/l2");
    expect(r2).toMatchObject({ ok: false, kind: "denied", reason: "not-worktree" });
    expect(custom.leakCount()).toBe(0);
  });

  it("`.git` pointer content not matching the gitdir: format ⇒ not-worktree", async () => {
    const fx = repoFixture();
    const { fs, runner } = fx;
    fx.scriptAdmission();
    fs.writeFile(`${LINKED}/.git`, "this is not a pointer\n");
    const h = membershipHarness(fs, runner);
    const r = await h.call(REPO, LINKED);
    expect(r).toMatchObject({ ok: false, kind: "denied", reason: "not-worktree" });
  });

  it("`.git` pointer larger than 4 KiB ⇒ not-worktree", async () => {
    const fx = repoFixture();
    const { fs, runner } = fx;
    fx.scriptAdmission();
    fs.writeFile(`${LINKED}/.git`, `gitdir: ${LINKED_GITDIR}\n` + "#".repeat(5 * 1024));
    const h = membershipHarness(fs, runner);
    const r = await h.call(REPO, LINKED);
    expect(r).toMatchObject({ ok: false, kind: "denied", reason: "not-worktree" });
  });

  it("gitdir NOT under <common>/worktrees (another repo's entry) ⇒ not-worktree", async () => {
    // a second repo whose worktree entry the pointer points at — different commondir
    const fs = createFakeFs();
    fs.mkdir("/w/repoA");
    fs.mkdir("/w/repoA/.git");
    fs.mkdir("/w/repoA/.git/worktrees/x");
    fs.mkdir("/w/repoB");
    fs.mkdir("/w/repoB/.git");
    fs.mkdir("/w/repoB/.git/worktrees/y");
    fs.mkdir("/w/wtB");
    fs.writeFile("/w/wtB/.git", "gitdir: /w/repoB/.git/worktrees/y\n");
    const runner = scriptedRunner();
    runner.push(
      okRun("/w/repoA/.git\n"),
      okRun(
        [
          "worktree /w/repoA",
          `HEAD ${HEAD_SHA1}`,
          "branch refs/heads/main",
          "",
          "worktree /w/wtB",
          `HEAD ${HEAD_SHA1}`,
          "branch refs/heads/b",
          "",
          "",
        ].join("\n"),
      ),
    );
    const h = membershipHarness(fs, runner);
    const r = await h.call("/w/repoA", "/w/wtB");
    expect(r).toMatchObject({ ok: false, kind: "denied", reason: "not-worktree" });
    expect(fs.leakCount()).toBe(0);
  });

  it("main worktree gitdir ≢ commondir ⇒ not-worktree", async () => {
    // C1a reports a commondir that is NOT the main worktree's .git
    const { fs, runner } = repoFixture();
    fs.mkdir("/w/elsewhere");
    const h = membershipHarness(fs, runner);
    runner.push(okRun("/w/elsewhere\n"), okRun(`worktree ${REPO}\nHEAD ${HEAD_SHA1}\nbranch refs/heads/main\n\n`));
    const r = await h.call(REPO, REPO);
    expect(r).toMatchObject({ ok: false, kind: "denied", reason: "not-worktree" });
    expect(fs.leakCount()).toBe(0);
  });

  it("WTDIFF_DIR_OPEN_FLAGS mirrors node:fs's O_RDONLY|O_DIRECTORY|O_NOFOLLOW exactly", () => {
    expect(WTDIFF_DIR_OPEN_FLAGS).toBe(fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  });
});

describe("membership §2.3 — denials and git failures", () => {
  it("session cwd under /proc/*/fd ⇒ not-repo before any git", async () => {
    const { fs, runner } = repoFixture();
    const h = membershipHarness(fs, runner);
    const r = await h.call("/proc/self/fd/3", REPO);
    expect(r).toMatchObject({ ok: false, kind: "denied", reason: "not-repo" });
    expect(runner.calls.length).toBe(0);
  });

  it("denylist hit on W (via a symlinked spelling) ⇒ denied denylist", async () => {
    // any `.ssh` path segment is a denylist v2 rule — the alias resolves into one
    const deny = denyCtxOf("/home/tester", "/home/tester/.pi/agent");
    const fs = createFakeFs();
    fs.mkdir("/w/x/.ssh/wt");
    fs.mkdir("/w/x/.ssh/wt/.git");
    fs.symlink("/w/alias", "/w/x/.ssh/wt"); // the alias resolves INTO the denied path
    const runner = scriptedRunner();
    runner.push(
      okRun("/w/x/.ssh/wt/.git\n"),
      okRun("worktree /w/x/.ssh/wt\nHEAD " + HEAD_SHA1 + "\nbranch refs/heads/main\n\n\n"),
    );
    const membership = createMembership({
      run: runner,
      fs,
      tracker: { zombies: 0, max: 2 },
      denyCtx: deny,
      log: memLog(),
      now: Date.now,
    });
    const r = await membership({
      cwd: "/w/x/.ssh/wt",
      wtReq: "/w/alias",
      deadline: createReqDeadline(Date.now, 8_000),
      signal: undefined,
    });
    expect(r).toMatchObject({ ok: false, kind: "denied", reason: "denylist" });
  });

  it("virtual-fs W ⇒ denied virtual-fs", async () => {
    const fs = createFakeFs();
    // the worktree path resolves (through a symlink) under /proc — a virtual root
    fs.mkdir("/proc/self/fd_w");
    fs.symlink("/w/virtual", "/proc/self/fd_w");
    const runner = scriptedRunner();
    runner.push(okRun(`${REPO_GIT}\n`), okRun(`worktree ${REPO}\nHEAD ${HEAD_SHA1}\n\n\n`));
    const h = membershipHarness(fs, runner);
    const r = await h.call(REPO, "/w/virtual");
    expect(r).toMatchObject({ ok: false, kind: "denied", reason: "virtual-fs" });
  });

  it("C1a nonzero ⇒ not-repo; C1 timeout ⇒ deadline; spawn error ⇒ git-unavailable", async () => {
    const c1aNonZero = repoFixture();
    const h1 = membershipHarness(c1aNonZero.fs, c1aNonZero.runner);
    c1aNonZero.runner.push({ ...okRun(""), code: 128 });
    expect(await h1.call(REPO, REPO)).toMatchObject({ ok: false, kind: "denied", reason: "not-repo" });

    const c1Timeout = repoFixture();
    const h2 = membershipHarness(c1Timeout.fs, c1Timeout.runner);
    c1Timeout.runner.push(okRun(`${REPO_GIT}\n`), { ...okRun(""), killed: "timeout", code: null });
    expect(await h2.call(REPO, REPO)).toMatchObject({ ok: false, kind: "deadline" });

    const c1Spawn = repoFixture();
    const h3 = membershipHarness(c1Timeout.fs, c1Spawn.runner);
    c1Spawn.runner.push(okRun(`${REPO_GIT}\n`), { ...okRun(""), spawnError: "ENOENT git" });
    expect(await h3.call(REPO, REPO)).toMatchObject({ ok: false, kind: "git-unavailable" });
  });

  it("realpath(wtReq) ENOENT ⇒ not-worktree", async () => {
    const { fs, runner } = repoFixture();
    const h = membershipHarness(fs, runner);
    runner.push(okRun(`${REPO_GIT}\n`), okRun(`worktree ${REPO}\nHEAD ${HEAD_SHA1}\n\n\n`));
    const r = await h.call(REPO, "/w/nope");
    expect(r).toMatchObject({ ok: false, kind: "denied", reason: "not-worktree" });
  });

  it("failure AFTER opens: the gitdir step fails ⇒ every opened pin is closed (leak count 0)", async () => {
    // linked worktree whose pointer targets a nonexistent gitdir ⇒ wt+common opened, git open fails
    const fx = repoFixture({ linkedGitdir: "/w/repo/.git/worktrees/MISSING" });
    const { fs, runner } = fx;
    fx.scriptAdmission();
    const h = membershipHarness(fs, runner);
    const r = await h.call(REPO, LINKED);
    expect(r).toMatchObject({ ok: false, kind: "denied", reason: "not-worktree" });
    expect(fs.leakCount()).toBe(0);
    expect(fs.closedFds.length).toBeGreaterThanOrEqual(2);
  });
});
