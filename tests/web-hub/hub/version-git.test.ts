/** web-hub-version plan §3.3/§3.11 — frozen argv, exit-129 handling, real-git behaviour. */
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunOptions, GitRunResult, GitRunner } from "../../../src/git/run.js";
import { createGitRunner } from "../../../src/git/run.js";
import {
  clipSubject,
  gitCommits,
  gitHead,
  VERSION_GIT_PREFIX,
  versionGitArgs,
  type GitCtx,
} from "../../../src/web-hub/hub/version-git.js";
import { createVersionInfoService } from "../../../src/web-hub/hub/version-info.js";
import type { HubInfo } from "../../../src/web-hub/hub/ports.js";
import { PROTO } from "../../../src/web-hub/protocol/version.js";

const PREFIX = [
  "--no-lazy-fetch",
  "--no-replace-objects",
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
];

function ctxOf(runner: GitRunner, over: Partial<GitCtx> = {}): GitCtx {
  return {
    pkgRoot: "/pkg",
    runner,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 10_000,
    now: () => Date.now(),
    realpath: async (p) => p,
    ...over,
  };
}

const ok = (stdout: string): GitRunResult => ({ code: 0, stdout, stdoutCapped: false, stderr: "" });

describe("frozen argv (byte-pinned)", () => {
  it("prefix", () => {
    expect([...VERSION_GIT_PREFIX]).toEqual(PREFIX);
  });
  it("every command starts with the prefix; the full vectors are frozen", () => {
    expect(versionGitArgs.toplevel()).toEqual([...PREFIX, "rev-parse", "--show-toplevel"]);
    expect(versionGitArgs.status()).toEqual([
      ...PREFIX,
      "status",
      "--porcelain",
      "--untracked-files=no",
      "--ignore-submodules=all",
    ]);
    expect(versionGitArgs.describe()).toEqual([...PREFIX, "describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"]);
    expect(versionGitArgs.head()).toEqual([
      ...PREFIX,
      "-c",
      "log.showSignature=false",
      "-c",
      "log.mailmap=false",
      "log",
      "--no-show-signature",
      "--no-use-mailmap",
      "--no-notes",
      "--no-decorate",
      "--no-color",
      "-1",
      "--format=%h%x09%ct",
    ]);
    expect(versionGitArgs.commits("v1.0.0..HEAD")).toEqual([
      ...PREFIX,
      "-c",
      "log.showSignature=false",
      "-c",
      "log.mailmap=false",
      "log",
      "--no-show-signature",
      "--no-use-mailmap",
      "--no-notes",
      "--no-decorate",
      "--no-color",
      "-n",
      "20",
      "--format=%h%x09%ct%x09%s",
      "v1.0.0..HEAD",
      "--",
    ]);
    expect(versionGitArgs.count("v1.0.0..HEAD")).toEqual([...PREFIX, "rev-list", "--count", "v1.0.0..HEAD", "--"]);
  });
  it("no author/email format placeholders are ever requested", () => {
    for (const a of [versionGitArgs.head(), versionGitArgs.commits("HEAD")]) {
      expect(a.join(" ")).not.toMatch(/%a[nNeE]|%c[nNeE]/);
    }
  });
});

describe("gitHead / gitCommits with a fake runner", () => {
  it("every runner call carries minimal env, the fixed PATH, the pkgRoot cwd, a signal and the prefix", async () => {
    const calls: { args: readonly string[]; opts: GitRunOptions }[] = [];
    const runner: GitRunner = async (args, opts) => {
      calls.push({ args, opts });
      const a = args.join(" ");
      if (a.includes("--show-toplevel")) return ok("/pkg\n");
      if (a.includes("--format=%h%x09%ct")) return ok("abc1234\t1700000000\n");
      if (a.includes("describe")) return ok("v1.2.3\n");
      if (a.includes("status")) return ok("");
      return ok("");
    };
    const h = await gitHead(ctxOf(runner));
    expect(h).toEqual({ kind: "ok", head: { commit: "abc1234", time: 1700000000 }, lastTag: "v1.2.3" });
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(c.args.slice(0, PREFIX.length)).toEqual(PREFIX);
      expect(c.opts).toMatchObject({ cwd: "/pkg", envPolicy: "minimal", pathOverride: "/usr/bin:/bin" });
      expect(c.opts.signal).toBeInstanceOf(AbortSignal);
      expect(c.opts.timeoutMs).toBeLessThanOrEqual(1000);
    }
  });

  it("dirty flag from status; toplevel mismatch ⇒ absent (host repo excluded)", async () => {
    const mk =
      (top: string, dirty: string): GitRunner =>
      async (args) => {
        const a = args.join(" ");
        if (a.includes("--show-toplevel")) return ok(`${top}\n`);
        if (a.includes("--format=%h%x09%ct")) return ok("abc1234\t1\n");
        if (a.includes("status")) return ok(dirty);
        return { code: 128, stdout: "", stdoutCapped: false, stderr: "fatal: No names found" };
      };
    expect(await gitHead(ctxOf(mk("/pkg", " M a.ts\n")))).toEqual({
      kind: "ok",
      head: { commit: "abc1234", time: 1, dirty: true },
    });
    expect(await gitHead(ctxOf(mk("/host", "")))).toEqual({ kind: "absent" });
  });

  it("exit 129 ⇒ git-too-old, exactly one attempt, the hardening is never dropped", async () => {
    const calls: string[][] = [];
    const runner: GitRunner = async (args) => {
      calls.push([...args]);
      return { code: 129, stdout: "", stdoutCapped: false, stderr: "unknown option: --no-lazy-fetch SECRET-STDERR" };
    };
    const h = await gitHead(ctxOf(runner));
    expect(h).toEqual({ kind: "error", error: "git-too-old" });
    expect(JSON.stringify(h)).not.toContain("SECRET-STDERR");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--no-lazy-fetch");
  });

  it("timeouts / aborts / overflow / spawn errors map to bounded error kinds without leaking stderr", async () => {
    const mk =
      (r: Partial<GitRunResult>): GitRunner =>
      async (args) =>
        args.includes("--show-toplevel")
          ? ok("/pkg\n")
          : { code: 0, stdout: "", stdoutCapped: false, stderr: "STDERR-LEAK", ...r };
    expect(await gitHead(ctxOf(mk({ killed: "timeout" })))).toEqual({ kind: "error", error: "timeout" });
    expect(await gitHead(ctxOf(mk({ killed: "abort" })))).toEqual({ kind: "error", error: "timeout" });
    expect(await gitHead(ctxOf(mk({ killed: "overflow" })))).toEqual({ kind: "error", error: "unavailable" });
    expect(await gitHead(ctxOf(mk({ spawnError: "ENOENT /secret/path" })))).toEqual({
      kind: "error",
      error: "unavailable",
    });
  });

  it("an expired deadline / aborted signal runs no git at all", async () => {
    let n = 0;
    const runner: GitRunner = async () => {
      n++;
      return ok("");
    };
    const ac = new AbortController();
    ac.abort();
    expect(await gitHead(ctxOf(runner, { signal: ac.signal }))).toEqual({ kind: "error", error: "timeout" });
    expect(await gitHead(ctxOf(runner, { deadlineAt: Date.now() - 1 }))).toEqual({ kind: "error", error: "timeout" });
    expect(n).toBe(0);
  });

  it("commits: parsing, subject clipping, control chars, total", async () => {
    const long = "x".repeat(500);
    const runner: GitRunner = async (args) => {
      if (args.includes("rev-list")) return ok("42\n");
      return ok(`abc1234\t100\tfeat: a\tb\u001b[31m\ndeadbee\t99\t${long}\nbad line\nZZZ\t1\tx\n`);
    };
    const r = await gitCommits(ctxOf(runner), "v1.0.0");
    expect(r.commitsTotal).toBe(42);
    expect(r.commits).toHaveLength(2);
    expect(r.commits![0]).toEqual({ commit: "abc1234", time: 100, subject: "feat: a b [31m" });
    expect(r.commits![1]!.subject).toHaveLength(200);
    expect(clipSubject("a\u0000b\nc")).toBe("a b c");
  });
});

// ---------------------------------------------------------------------------
// real git
// ---------------------------------------------------------------------------

let hasGit = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  hasGit = false;
}
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.test",
    },
  });
}
function mkRepo(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "pwh-vgit-")));
  dirs.push(d);
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "commit.gpgsign", "false");
  writeFileSync(join(d, "a.txt"), "1");
  git(d, "add", ".");
  git(d, "commit", "-q", "-m", "first");
  git(d, "tag", "v0.1.0");
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(d, "a.txt"), String(i + 2));
    git(d, "commit", "-aq", "-m", `change ${i}`);
  }
  return d;
}
const realCtx = (pkgRoot: string, runner: GitRunner = createGitRunner()): GitCtx => ({
  pkgRoot,
  runner,
  signal: new AbortController().signal,
  deadlineAt: Date.now() + 10_000,
  now: () => Date.now(),
});

describe.skipIf(!hasGit)("real git", () => {
  it("head/tag/commits/total; dirty only from tracked changes; submodule-free", async () => {
    const d = mkRepo();
    const h = await gitHead(realCtx(d));
    expect(h.kind).toBe("ok");
    if (h.kind !== "ok") return;
    expect(h.lastTag).toBe("v0.1.0");
    expect(h.head.dirty).toBeUndefined();
    expect(git(d, "rev-parse", "HEAD").startsWith(h.head.commit)).toBe(true);
    const c = await gitCommits(realCtx(d), h.lastTag);
    expect(c.commits!.map((x) => x.subject)).toEqual(["change 2", "change 1", "change 0"]);
    expect(c.commitsTotal).toBe(3);
    writeFileSync(join(d, "untracked.txt"), "u");
    expect(((await gitHead(realCtx(d))) as { head: { dirty?: boolean } }).head.dirty).toBeUndefined();
    writeFileSync(join(d, "a.txt"), "dirty");
    expect(((await gitHead(realCtx(d))) as { head: { dirty?: boolean } }).head.dirty).toBe(true);
  });

  it("a subdirectory of a host repo is not the toplevel ⇒ absent", async () => {
    const d = mkRepo();
    mkdirSync(join(d, "sub"));
    expect(await gitHead(realCtx(join(d, "sub")))).toEqual({ kind: "absent" });
  });

  it("not a repository ⇒ absent (nogit installs)", async () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "pwh-vgit-nogit-")));
    dirs.push(d);
    expect((await gitHead(realCtx(d))).kind).toBe("absent");
  });

  it("partial clone with an unreachable promisor remote: snapshot succeeds and git never fetches", async () => {
    const origin = mkRepo();
    git(origin, "config", "uploadpack.allowFilter", "true");
    git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "pwh-vgit-clone-")));
    dirs.push(parent);
    const clone = join(parent, "clone");
    git(parent, "clone", "-q", "--no-checkout", "--filter=blob:none", `file://${origin}`, clone);
    git(clone, "checkout", "-q", "main");
    // point the promisor remote at something unreachable AND make any fetch attempt observable
    let connections = 0;
    const trap: Server = createServer((sock) => {
      connections++;
      sock.destroy();
    });
    await new Promise<void>((r) => trap.listen(0, "127.0.0.1", r));
    const trapPort = (trap.address() as { port: number }).port;
    git(clone, "remote", "set-url", "origin", `http://127.0.0.1:${trapPort}/unreachable.git`);
    const log: string[][] = [];
    const real = createGitRunner();
    const recording: GitRunner = (args, opts) => {
      log.push([...args]);
      return real(args, { ...opts, timeoutMs: Math.min(opts.timeoutMs, 3000) });
    };
    const t0 = Date.now();
    const svc = createVersionInfoService({
      pkgRoot: clone,
      info: { version: "1", buildId: "b", pid: 1, startedAt: 1, proto: PROTO, caps: [] } as unknown as HubInfo,
      git: recording,
      now: () => Date.now(),
      log: { info() {}, warn() {}, error() {}, debug() {}, close() {} } as never,
    });
    const out = await svc.snapshot(new AbortController().signal);
    svc.dispose();
    await new Promise<void>((r) => trap.close(() => r()));
    expect(connections).toBe(0); // no promisor/lazy fetch ever touched the network
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.repo).toMatchObject({ head: { commit: expect.stringMatching(/^[0-9a-f]{7,}$/) } });
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(log.length).toBeGreaterThan(0);
    for (const a of log) {
      expect(a).toContain("--no-lazy-fetch");
      expect(a.some((x) => ["fetch", "pull", "clone"].includes(x))).toBe(false);
    }
  });
});
