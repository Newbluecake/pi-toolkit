/**
 * V4 convert — early checks & authoritative checks (convert-plan.md §1.1 / §1.3 / §1.3.1 / §7.1
 * convert-preflight).
 *
 * Covers: argument syntax + name derivation, the §1.3 path rules (both spellings, $HOME, $HOME/.*,
 * system dirs, vault/agent overlap), mountinfo fixtures, xattr via an injected getfattr, git rules
 * on real temporary repositories (linked worktree, submodule, alternates, core.worktree,
 * commondir, unborn HEAD, record counting, minimal env), the occupancy scan (cwd / fd / exe / maps,
 * timeout and over-limit ⇒ uncertain), every early refusal with ZERO side effects, the convert
 * lock, and the authoritative check on the frozen BACKUP (early check passes, the backup grows a
 * problem after the rename ⇒ refuse + full rollback).
 *
 * All in private mktemp dirs with fake launcher ports (no FUSE). Never touches ~/secure or ~/.pi.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  C,
  T,
  cleanupTmps,
  fixtureScanOccupants,
  git,
  gitInit,
  makeEnv,
  mkTmp,
  script,
  snapshot,
  wrappedTreeArgv,
} from "./convert-fixtures.js";

afterAll(cleanupTmps);

const kids: ChildProcess[] = [];
afterAll(() => {
  for (const k of kids) k.kill("SIGKILL");
});

/** No registry call, no vault dir, no state file, source byte-for-byte unchanged. */
function expectNoSideEffects(E: ReturnType<typeof makeEnv>, before: Record<string, unknown>) {
  expect(E.reg.size).toBe(0);
  expect(E.calls.filter((c) => !c.startsWith("finalize"))).toEqual([]);
  const v = E.vault();
  expect(existsSync(v.dir)).toBe(false);
  expect(existsSync(v.mnt)).toBe(false);
  expect(existsSync(join(E.txnDir, "convert-proj.json"))).toBe(false);
  expect(snapshot(E.src)).toEqual(before);
  expect(readdirSync(E.home).filter((n) => n.includes("pi-secure-backup"))).toEqual([]);
}

describe("§1.1 syntax", () => {
  it("parses the three forms and refuses malformed input with exit 2", () => {
    expect(C.parseConvertArgs(["~/p"])).toEqual({
      mode: "convert",
      src: "~/p",
      noSessions: false,
      sessionsFrom: [],
      private: false,
    });
    expect(
      C.parseConvertArgs([
        "/a/b",
        "acme",
        "--path",
        "/m/x",
        "--sessions-from",
        "/s1",
        "--sessions-from=/s2",
        "--private",
      ]),
    ).toEqual({
      mode: "convert",
      src: "/a/b",
      name: "acme",
      mnt: "/m/x",
      noSessions: false,
      sessionsFrom: ["/s1", "/s2"],
      private: true,
    });
    expect(C.parseConvertArgs(["--resume", "acme"])).toEqual({ mode: "resume", name: "acme" });
    expect(C.parseConvertArgs(["--abort", "acme"])).toEqual({ mode: "abort", name: "acme" });
    for (const bad of [
      [],
      ["a", "b", "c"],
      ["--resume"],
      ["--resume", "acme", "/x"],
      ["--abort", "Bad Name"],
      ["/a", "UPPER"],
      ["/a", "--yes"],
      ["/a", "--no-sessions", "--sessions-from", "/s"],
      ["/a", "--path"],
      ["--resume", "a", "--abort", "a"],
    ])
      expect(() => C.parseConvertArgs(bad), bad.join(" ")).toThrow(expect.objectContaining({ exit: 2 }));
  });

  it("derives the default name from the basename", () => {
    expect(C.deriveVaultName("/home/u/My Project.v2")).toBe("my-project-v2");
    expect(C.deriveVaultName("/home/u/" + "x".repeat(40))).toBe("x".repeat(32));
    expect(C.deriveVaultName("/home/u/__")).toBeUndefined();
    expect(C.deriveVaultName("/home/u/中文")).toBeUndefined();
  });
});

describe("§1.3 path rules", () => {
  const home = "/home/u";
  const P = (src: string, extra: Record<string, unknown> = {}) =>
    C.pathRuleProblems({ src, srcReal: src, home, agentDir: "/home/u/.pi/agent", ...extra }).map((p: any) => p.code);
  it("requires strictly below $HOME, outside $HOME/.*, system dirs, vaults and the agent dir", () => {
    expect(P("/home/u/proj")).toEqual([]);
    expect(P("/home/u")).toContain("path-home");
    expect(P("/home")).toContain("path-home");
    expect(P("/srv/x")).toEqual(expect.arrayContaining(["path-home", "path-system"]));
    expect(P("/home/u/.config/x")).toContain("path-dot");
    expect(P("/home/u/.pi")).toEqual(expect.arrayContaining(["path-dot", "path-agent"]));
    expect(
      P("/home/u/proj", { vaults: [{ name: "v", dir: "/home/u/proj/inner", mnt: "/home/u/secure/v" }] }),
    ).toContain("path-vault");
    expect(P("/home/u/secure/v/work/x", { vaults: [{ name: "v", dir: "/d", mnt: "/home/u/secure/v" }] })).toContain(
      "path-vault",
    );
    expect(C.pathRuleProblems({ src: "/home/u/p", srcReal: "/lib64/x", home }).map((p: any) => p.code)).toEqual(
      expect.arrayContaining(["path-system", "path-home"]),
    );
    expect(
      C.pathRuleProblems({ src: "/tmp/h/p", srcReal: "/tmp/h/p", home: "/tmp/h" }).map((p: any) => p.code),
    ).toContain("path-system");
  });

  it("checks the realpath spelling too (symlinked ancestor)", () => {
    const base = mkTmp("pr");
    mkdirSync(join(base, "home"));
    mkdirSync(join(base, "real", "proj"), { recursive: true });
    symlinkSync(join(base, "real"), join(base, "home", "link"));
    const r = C.pathRuleProblems({
      src: join(base, "home", "link", "proj"),
      srcReal: join(base, "real", "proj"),
      home: join(base, "home"),
      systemDirs: [],
    });
    expect(r.map((p: any) => p.code)).toEqual(["path-home"]);
  });
});

describe("§1.3 mountinfo fixtures", () => {
  const mi = [
    "22 1 8:1 / / rw - ext4 /dev/sda1 rw",
    "40 22 8:1 /data /home/u/proj/bind rw - ext4 /dev/sda1 rw",
    "41 22 8:1 /f /home/u/proj/file\\040x rw - ext4 /dev/sda1 rw",
    "42 22 0:50 / /home/u/proj2/ov rw - overlay overlay rw",
    "43 22 0:51 / /home/u/projX rw - tmpfs tmpfs rw",
  ].join("\n");
  it("finds same-fs bind, file bind with octal escape and overlay inside the root; not prefix siblings", () => {
    expect(T.mountProblems(mi, ["/home/u/proj"]).map((p: any) => p.path)).toEqual([
      "/home/u/proj/bind",
      "/home/u/proj/file x",
    ]);
    expect(T.mountProblems(mi, ["/home/u/proj2"]).map((p: any) => p.path)).toEqual(["/home/u/proj2/ov"]);
    expect(T.mountProblems(mi, ["/home/u/projX"]).map((p: any) => p.path)).toEqual(["/home/u/projX"]);
  });
});

describe("§1.3.1 git rules (real git, minimal env)", () => {
  const ctxOf = () => makeEnv("git", { project: false }).ctx();
  it("plain repo passes; unborn HEAD is recorded as null", async () => {
    const base = mkTmp("g1");
    const r1 = join(base, "r1");
    mkdirSync(r1);
    writeFileSync(join(r1, "f"), "x");
    gitInit(r1);
    const ctx = ctxOf();
    const g = await C.gitRuleProblems(r1, { gitEntries: [{ rel: ".git", type: "dir" }], ctx });
    expect(g.problems).toEqual([]);
    expect(g.repos[0].head).toMatch(/^[0-9a-f]{40}$/);
    expect(g.repos[0].status).toBeUndefined(); // r3.1 M6: no porcelain status any more
    const r2 = join(base, "r2");
    mkdirSync(r2);
    spawnSync("git", ["-C", r2, "init", "-q"]);
    const g2 = await C.gitRuleProblems(r2, { gitEntries: [{ rel: ".git", type: "dir" }], ctx });
    expect(g2.problems).toEqual([]);
    expect(g2.repos[0].head).toBeNull();
  });

  it("linked worktree: refused in the main repo (2 records) and in the linked checkout (gitdir outside)", async () => {
    const base = mkTmp("g2");
    const main = join(base, "main");
    mkdirSync(main);
    writeFileSync(join(main, "f"), "x");
    gitInit(main);
    git(main, "worktree", "add", "-q", join(base, "wt"));
    const ctx = ctxOf();
    const g = await C.gitRuleProblems(main, { gitEntries: [{ rel: ".git", type: "dir" }], ctx });
    expect(g.problems.map((p: any) => p.code)).toEqual(["git-linked-worktree"]);
    const g2 = await C.gitRuleProblems(join(base, "wt"), { gitEntries: [{ rel: ".git", type: "file" }], ctx });
    expect(g2.problems.map((p: any) => p.code)).toEqual(["git-gitdir-outside"]);
  });

  it("alternates outside, core.worktree on the root and commondir outside are refused", async () => {
    const base = mkTmp("g3");
    const up = join(base, "up");
    mkdirSync(up);
    writeFileSync(join(up, "f"), "x");
    gitInit(up);
    spawnSync("git", ["clone", "-q", "--shared", up, join(base, "sh")]);
    const ctx = ctxOf();
    const a = await C.gitRuleProblems(join(base, "sh"), { gitEntries: [{ rel: ".git", type: "dir" }], ctx });
    expect(a.problems.map((p: any) => p.code)).toEqual(["git-alternates"]);
    const cw = join(base, "cw");
    mkdirSync(cw);
    writeFileSync(join(cw, "f"), "x");
    gitInit(cw);
    git(cw, "config", "core.worktree", cw);
    const b = await C.gitRuleProblems(cw, { gitEntries: [{ rel: ".git", type: "dir" }], ctx });
    expect(b.problems.map((p: any) => p.code)).toContain("git-core-worktree");
    const cd = join(base, "cd");
    mkdirSync(cd);
    writeFileSync(join(cd, "f"), "x");
    gitInit(cd);
    writeFileSync(join(cd, ".git", "commondir"), join(up, ".git") + "\n");
    const c = await C.gitRuleProblems(cd, { gitEntries: [{ rel: ".git", type: "dir" }], ctx });
    expect(c.problems.map((p: any) => p.code)).toEqual(["git-commondir"]);
  });

  it("a submodule (relative gitdir + its own core.worktree) inside the tree is accepted", async () => {
    const base = mkTmp("g4");
    const lib = join(base, "lib");
    mkdirSync(lib);
    writeFileSync(join(lib, "l"), "l");
    gitInit(lib);
    const top = join(base, "top");
    mkdirSync(top);
    writeFileSync(join(top, "t"), "t");
    gitInit(top);
    git(top, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "sub");
    const ctx = ctxOf();
    const g = await C.gitRuleProblems(top, {
      gitEntries: [
        { rel: ".git", type: "dir" },
        { rel: "sub/.git", type: "file" },
      ],
      ctx,
    });
    expect(g.problems).toEqual([]);
  });

  it("counts worktree records by blank-line separated porcelain blocks; env strips every GIT_*", () => {
    expect(
      C.countWorktreeRecords("worktree /a\nHEAD x\nbranch refs/heads/m\n\nworktree /b\nHEAD y\ndetached\n\n"),
    ).toBe(2);
    expect(C.countWorktreeRecords("worktree /a\nbare\n")).toBe(1);
    const e = C.gitEnv(
      { PATH: "/opt/evil:/bin", HOME: "/h", GIT_DIR: "/evil", GIT_CONFIG_PARAMETERS: "x", LANG: "x", OTHER: "1" },
      { ceiling: "/c" },
    );
    expect(e).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/h",
      LC_ALL: "C",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CEILING_DIRECTORIES: "/c",
    });
    expect(C.GIT_BASE_ARGS).toEqual([
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.attributesFile=/dev/null",
    ]);
    expect(C.GIT_EMPTY_TREE.sha1).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });

  it("r3.1 M6: configured filter/diff drivers are blanked and attributes come from the empty tree; nothing executes", async () => {
    const base = mkTmp("g5");
    const r = join(base, "r");
    mkdirSync(r);
    writeFileSync(join(r, "f.txt"), "x\n");
    writeFileSync(join(r, ".gitattributes"), "* filter=evil diff=evil\n");
    gitInit(r);
    const marker = join(base, "MARKER");
    const cmd = `sh -c 'echo ran >> ${marker}; cat'`;
    git(r, "config", "filter.evil.clean", cmd);
    git(r, "config", "filter.evil.smudge", cmd);
    git(r, "config", "filter.evil.process", `sh -c 'echo ran >> ${marker}'`);
    git(r, "config", "filter.evil.required", "true");
    git(r, "config", "diff.evil.textconv", cmd);
    writeFileSync(join(r, "f.txt"), "changed\n"); // a dirty file a porcelain status would have filtered
    const ctx = ctxOf();
    const hz = await C.gitHardening(ctx, r);
    expect(hz.ok).toBe(true);
    expect(hz.hard[0]).toBe(`--attr-source=${C.GIT_EMPTY_TREE.sha1}`);
    for (const k of [
      "filter.evil.clean=",
      "filter.evil.smudge=",
      "filter.evil.process=",
      "filter.evil.required=false",
      "diff.evil.textconv=",
      "diff.evil.command=",
    ])
      expect(hz.hard).toContain(k);
    const g = await C.gitRuleProblems(r, { gitEntries: [{ rel: ".git", type: "dir" }], ctx });
    expect(g.problems).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    // a driver name that cannot be passed safely ⇒ uncertain ⇒ refused
    git(r, "config", "filter.bad name.clean", "true");
    const g2 = await C.gitRuleProblems(r, { gitEntries: [{ rel: ".git", type: "dir" }], ctx });
    expect(g2.problems.map((p: any) => p.code)).toEqual(["git-uncertain"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("r3.1 M7: a symlinked .git is refused; unreadable alternates / commondir are refused (only ENOENT = absent)", async () => {
    const base = mkTmp("g6");
    const r = join(base, "r");
    mkdirSync(r);
    writeFileSync(join(r, "f"), "x");
    gitInit(r);
    const ctx = ctxOf();
    const s1 = await C.gitRuleProblems(r, { gitEntries: [{ rel: "sub/.git", type: "symlink" }], ctx });
    expect(s1.problems.map((p: any) => p.code)).toEqual(["git-symlink"]);
    const alt = join(r, ".git", "objects", "info", "alternates");
    writeFileSync(alt, "");
    chmodSync(alt, 0o000);
    const a = await C.gitRuleProblems(r, { gitEntries: [{ rel: ".git", type: "dir" }], ctx });
    expect(a.problems.map((p: any) => p.code)).toEqual(["git-uncertain"]);
    expect(a.problems[0].detail).toContain("alternates");
    chmodSync(alt, 0o600);
    spawnSync("rm", ["-f", alt]);
    mkdirSync(alt); // not a regular file
    const a2 = await C.gitRuleProblems(r, { gitEntries: [{ rel: ".git", type: "dir" }], ctx });
    expect(a2.problems.map((p: any) => p.code)).toEqual(["git-uncertain"]);
    spawnSync("rmdir", [alt]);
    symlinkSync("/etc/hostname", join(r, ".git", "commondir"));
    const c = await C.gitRuleProblems(r, { gitEntries: [{ rel: ".git", type: "dir" }], ctx });
    expect(c.problems.map((p: any) => p.code)).toEqual(["git-uncertain"]);
    expect(c.problems[0].detail).toContain("commondir");
  });
});

describe("§1.3 occupancy scan", () => {
  it("finds cwd, fd and exe/maps occupants; uncertain scans are reported as such", async () => {
    const base = mkTmp("occ");
    const tree = join(base, "tree");
    mkdirSync(join(tree, "sub"), { recursive: true });
    writeFileSync(join(tree, "held"), "x");
    copyFileSync("/bin/sleep", join(tree, "mysleep"));
    chmodSync(join(tree, "mysleep"), 0o755);
    const a = spawn("sleep", ["30"], { cwd: join(tree, "sub"), stdio: "ignore" });
    const b = spawn("sleep", ["30"], { cwd: "/", stdio: [openSync(join(tree, "held"), "r"), "ignore", "ignore"] });
    const c = spawn(join(tree, "mysleep"), ["30"], { cwd: "/", stdio: "ignore" });
    kids.push(a, b, c);
    await new Promise((r) => setTimeout(r, 300));
    const r = await C.scanOccupants([tree]);
    expect(r.kind).toBe("done");
    const by = (pid: number) => r.occupants.find((o: any) => o.pid === pid);
    expect(by(a.pid!)?.via).toBe("cwd");
    expect(by(b.pid!)?.via).toBe("fd 0");
    expect(["exe", "maps"]).toContain(by(c.pid!)?.via);
    expect(await C.scanOccupants([tree], { deadlineMs: 0 })).toEqual({ kind: "timeout" });
    expect((await C.scanOccupants([tree], { maxProcs: 1 })).kind).toBe("too-many");
    for (const k of [a, b, c]) k.kill("SIGKILL");
  });

  it("M8: a same-uid process whose /proc entries cannot be read is listed with pid/comm/start (zombies excluded)", async () => {
    const base = mkTmp("occ2");
    const proc = join(base, "proc");
    mkdirSync(join(proc, "424242", "fd"), { recursive: true });
    writeFileSync(join(proc, "424242", "cwd"), ""); // readlink ⇒ EINVAL: not inspectable
    writeFileSync(join(proc, "424242", "comm"), "ghost\n");
    const statLine = (st: string) => `424242 (ghost) ${st} 1 424242 424242 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 12345 0 0\n`;
    writeFileSync(join(proc, "424242", "stat"), statLine("S"));
    writeFileSync(join(proc, "stat"), "cpu 0\nbtime 1700000000\n");
    chmodSync(join(proc, "424242", "fd"), 0o000);
    const r = await C.scanOccupants(["/somewhere"], { procRoot: proc, recheckDelayMs: 1 });
    // a zombie is never "unreadable" (nothing left to hold)
    writeFileSync(join(proc, "424242", "stat"), statLine("Z"));
    const z = await C.scanOccupants(["/somewhere"], { procRoot: proc, recheckDelayMs: 1 });
    chmodSync(join(proc, "424242", "fd"), 0o700);
    expect(z).toEqual({ kind: "done", occupants: [], unreadable: 0, unreadablePids: [] });
    expect(r).toEqual({
      kind: "done",
      occupants: [],
      unreadable: 1,
      unreadablePids: [{ pid: 424242, comm: "ghost", start: "12345" }],
    });
    expect(C.describeUnreadable(r.unreadablePids[0], proc)).toBe(
      `  pid 424242  ghost  exe （不可读）  启动于 ${new Date((1700000000 + 123.45) * 1000).toISOString()}`,
    );
  });
});

const GHOST_A = { pid: 4_000_001, comm: "ghost-a", start: "111" };
const GHOST_B = { pid: 4_000_002, comm: "ghost-b", start: "222" };
/** Real (fixture) scan + injected uninspectable processes chosen per call by `pick()`. */
function ghostScan(pick: () => any[]) {
  return async (roots: string[], opts: any) => {
    const r = await fixtureScanOccupants(roots, opts);
    if (r.kind !== "done") return r;
    const extra = pick();
    return { ...r, unreadablePids: [...r.unreadablePids, ...extra], unreadable: r.unreadable + extra.length };
  };
}

describe("user ruling 2026-10-24: uninspectable processes are listed and must be confirmed", () => {
  it("parses --assume-unreadable-idle in all three modes", () => {
    expect(C.parseConvertArgs(["~/p", "--assume-unreadable-idle"]).assumeUnreadableIdle).toBe(true);
    expect(C.parseConvertArgs(["--resume", "acme", "--assume-unreadable-idle"])).toEqual({
      mode: "resume",
      name: "acme",
      assumeUnreadableIdle: true,
    });
    expect(C.parseConvertArgs(["--abort", "acme", "--assume-unreadable-idle"]).assumeUnreadableIdle).toBe(true);
    expect(C.CONVERT_USAGE).toContain("--assume-unreadable-idle");
  });

  it("interactive: only an exact y / yes continues; anything else ⇒ 75 with zero side effects", async () => {
    for (const ans of ["n", "Y", "", "yes please", "proj"]) {
      const E = makeEnv(`ui-no`);
      const before = snapshot(E.src);
      E.ports.prompt = async (q: string) => (q.includes("继续") ? ans : "proj");
      expect(await E.run([E.src], { scanOccupants: ghostScan(() => [GHOST_A]) }), JSON.stringify(ans)).toBe(75);
      const out = E.out.join("\n");
      expect(out).toContain("无法确认它们是否在使用该目录");
      expect(out).toContain(`pid ${GHOST_A.pid}  ghost-a`);
      expect(out).toContain("输入 y 继续");
      expect(E.err.join("\n")).toContain("未确认无法检查的进程");
      expectNoSideEffects(E, before);
    }
  });

  it("interactive: y confirms exactly the listed set; it is persisted in the state file; one prompt for the whole run", async () => {
    const E = makeEnv("ui-y");
    let prompts = 0;
    E.ports.prompt = async (q: string) => (q.includes("继续") ? (prompts++, "yes") : "proj");
    let midState: any;
    E.world.onOut = (l) => {
      if (l.startsWith("拷贝")) midState = JSON.parse(readFileSync(join(E.txnDir, "convert-proj.json"), "utf8"));
    };
    expect(await E.run([E.src], { scanOccupants: ghostScan(() => [GHOST_A]) })).toBe(0);
    expect(prompts).toBe(1);
    expect(midState.unreadableAck).toEqual([
      expect.objectContaining({ pid: GHOST_A.pid, start: "111", comm: "ghost-a" }),
    ]);
    expect(typeof midState.unreadableAck[0].at).toBe("string");
  });

  it("a NEW uninspectable process after the confirmation ⇒ asked again (only the new one listed); declining then ⇒ 75, source restored", async () => {
    for (const second of ["y", "n"]) {
      const E = makeEnv(`ui-new-${second}`);
      const before = snapshot(E.src);
      let copying = false;
      const asked: string[][] = [];
      let cur: string[] = [];
      E.world.onOut = (l) => {
        if (l.startsWith("拷贝")) copying = true;
        if (l.includes("无法确认它们是否在使用该目录")) cur = [];
        if (l.startsWith("  pid ")) cur.push(l);
      };
      E.ports.prompt = async (q: string) => {
        if (!q.includes("继续")) return "proj";
        asked.push(cur);
        return asked.length === 1 ? "y" : second;
      };
      const code = await E.run([E.src], { scanOccupants: ghostScan(() => (copying ? [GHOST_A, GHOST_B] : [GHOST_A])) });
      // "n": the rollback's own occupancy check of the new vault asks again (never inherits) — the
      // user declines again, so the source is restored but the vault and state are kept ⇒ 「回滚不完整」 74
      expect(asked.length).toBe(second === "y" ? 2 : 3);
      expect(asked[0]!.join("\n")).toContain(`pid ${GHOST_A.pid}`);
      expect(asked[1]!.join("\n")).toContain(`pid ${GHOST_B.pid}`);
      expect(asked[1]!.join("\n")).not.toContain(`pid ${GHOST_A.pid}`);
      if (second === "y") expect(code).toBe(0);
      else {
        expect(code).toBe(74);
        expect(E.err.join("\n")).toContain("未确认无法检查的进程");
        expect(lstatSync(E.src).isDirectory()).toBe(true);
        expect(snapshot(E.src)).toEqual(before);
        expect(E.err.join("\n")).toContain("回滚不完整");
        expect(E.reg.get("proj").pending).toMatch(/^convert:/);
        expect(existsSync(E.vault().dir)).toBe(true);
        expect(existsSync(join(E.txnDir, "convert-proj.json"))).toBe(true);
      }
    }
  });

  it("round 2 M5: a process whose start time cannot be read is never persisted — asked at EVERY scan", async () => {
    const ANON = { pid: 4_000_003, comm: "ghost-anon" }; // no start ⇒ no identity
    const E = makeEnv("ui-anon");
    let prompts = 0;
    let midState: any;
    E.ports.prompt = async (q: string) => (q.includes("继续") ? (prompts++, "y") : "proj");
    E.world.onOut = (l) => {
      if (l.startsWith("拷贝")) midState = JSON.parse(readFileSync(join(E.txnDir, "convert-proj.json"), "utf8"));
    };
    expect(await E.run([E.src], { scanOccupants: ghostScan(() => [ANON]) })).toBe(0);
    expect(prompts).toBeGreaterThanOrEqual(4); // early check, after the passwords, before the copy, final re-check
    expect(midState.unreadableAck ?? []).toEqual([]);
    expect(E.out.join("\n")).toContain("读不到启动时间、无法绑定身份");
    // non-interactive: the flag is needed — and accepted — at every listing; without it ⇒ 75
    const errs: string[] = [];
    const ctx: any = {
      procRoot: "/proc",
      unreadable: {
        acked: new Map(),
        interactive: false,
        assume: true,
        assumeSpent: false,
        out: () => {},
        err: (l: string) => errs.push(l),
      },
    };
    await C.confirmUnreadable([ANON], ctx, "x");
    await C.confirmUnreadable([GHOST_A], ctx, "x"); // first identifiable set
    await C.confirmUnreadable([ANON, GHOST_A], ctx, "x"); // anon listed again, still under the flag
    expect(ctx.unreadable.acked.size).toBe(1);
    expect(errs.filter((l) => l.includes(`pid ${ANON.pid}`)).length).toBe(2); // listed (and covered) each time it appears
    const noFlag: any = {
      procRoot: "/proc",
      unreadable: { acked: new Map(), interactive: false, assume: false, out: () => {} },
    };
    await expect(C.confirmUnreadable([ANON], noFlag, "x")).rejects.toMatchObject({ exit: 75 });
    // persisted confirmations without a start time are rejected outright
    expect(
      C.stateProblem(
        {
          v: 1,
          txid: "0123456789abcdef",
          name: "acme",
          phase: "claimed",
          origin: "/h/acme",
          originReal: "/h/acme",
          backup: "/h/acme.pi-secure-backup-20261024-010203-abcd",
          vault: { dir: "/d", mnt: "/m" },
          ids: { originParent: { dev: "1", ino: "2" }, origin: { dev: "1", ino: "3" } },
          unreadableAck: [{ pid: 5, comm: "x", at: "t" }],
        },
        "acme",
      ),
    ).toBe("unreadableAck 不合法");
  });

  it("round 2 M6: EVERY unconfirmed process is shown (and only those are confirmed); more than 200 ⇒ 75 without asking", async () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ pid: 5_000_000 + i, comm: `g${i}`, start: String(100 + i) }));
    const shown: string[] = [];
    let asked = 0;
    const ctx: any = {
      procRoot: "/proc",
      unreadable: {
        acked: new Map(),
        interactive: true,
        assume: false,
        out: (l: string) => shown.push(l),
        prompt: async () => (asked++, "y"),
      },
    };
    await C.confirmUnreadable(many(25), ctx, "x");
    for (let i = 0; i < 25; i++)
      expect(
        shown.some((l) => l.includes(`pid ${5_000_000 + i}  g${i}`)),
        String(i),
      ).toBe(true);
    expect(ctx.unreadable.acked.size).toBe(25);
    expect(asked).toBe(1);
    const ctx2: any = { procRoot: "/proc", unreadable: { ...ctx.unreadable, acked: new Map() } };
    await expect(C.confirmUnreadable(many(201), ctx2, "x")).rejects.toMatchObject({ exit: 75 });
    expect(asked).toBe(1); // never asked for a list that cannot be shown
    expect(ctx2.unreadable.acked.size).toBe(0);
    // non-interactive: the complete list goes to stderr
    const errs: string[] = [];
    const ctx3: any = {
      procRoot: "/proc",
      unreadable: {
        acked: new Map(),
        interactive: false,
        assume: true,
        assumeSpent: false,
        out: () => {},
        err: (l: string) => errs.push(l),
      },
    };
    await C.confirmUnreadable(many(25), ctx3, "x");
    for (let i = 0; i < 25; i++)
      expect(
        errs.some((l) => l.includes(`pid ${5_000_000 + i}  g${i}`)),
        String(i),
      ).toBe(true);
    expect(C.UNREADABLE_LIST_MAX).toBe(200);
  });

  it("non-interactive: the flag confirms only the FIRST set of the run; a later new process ⇒ 75 (never inherits)", async () => {
    const out: string[] = [];
    const ctx: any = {
      procRoot: "/proc",
      unreadable: {
        acked: new Map(),
        interactive: false,
        assume: true,
        assumeSpent: false,
        out: (l: string) => out.push(l),
      },
    };
    await C.confirmUnreadable([GHOST_A], ctx, "x");
    await C.confirmUnreadable([GHOST_A], ctx, "x"); // same identity: no new confirmation needed
    await expect(C.confirmUnreadable([GHOST_A, GHOST_B], ctx, "x")).rejects.toMatchObject({ exit: 75 });
    // same pid, new start time = a different process ⇒ not covered either
    await expect(C.confirmUnreadable([{ ...GHOST_A, start: "999" }], ctx, "x")).rejects.toMatchObject({ exit: 75 });
    expect(out.join("\n")).toContain("--assume-unreadable-idle");
    const noFlag: any = {
      procRoot: "/proc",
      unreadable: { acked: new Map(), interactive: false, assume: false, out: () => {} },
    };
    await expect(C.confirmUnreadable([GHOST_A], noFlag, "x")).rejects.toMatchObject({
      exit: 75,
      lines: expect.arrayContaining([expect.stringContaining("--assume-unreadable-idle")]),
    });
  });
});

describe("early refusals have zero side effects", () => {
  it("$HOME itself and $HOME/.config ⇒ 65", async () => {
    const E = makeEnv("e1");
    mkdirSync(join(E.home, ".config", "x"), { recursive: true });
    expect(await E.run([E.home, "hh"])).toBe(65);
    expect(await E.run([join(E.home, ".config", "x"), "cfg"])).toBe(65);
    expect(E.reg.size).toBe(0);
    expect(E.err.join("\n")).toContain("$HOME");
  });

  it("symlink source ⇒ 65, missing ⇒ 66, registered name ⇒ 78, pending state ⇒ 76", async () => {
    const E = makeEnv("e2");
    const before = snapshot(E.src);
    symlinkSync(E.src, join(E.home, "lnk"));
    expect(await E.run([join(E.home, "lnk"), "lnk"])).toBe(65);
    expect(await E.run([join(E.home, "nope")])).toBe(66);
    E.reg.set("proj", { dir: "/x", mnt: "/y" });
    expect(await E.run([E.src])).toBe(78);
    E.reg.clear();
    E.calls.length = 0;
    mkdirSync(E.txnDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(E.txnDir, "convert-proj.json"), "{}");
    expect(await E.run([E.src])).toBe(78); // malformed state is never guessed
    expect(E.calls).toEqual([]);
    expect(snapshot(E.src)).toEqual(before);
  });

  it("no TTY ⇒ 2; failing preflight / missing getfattr ⇒ 69", async () => {
    const E = makeEnv("e3");
    const before = snapshot(E.src);
    E.ports.isTty = () => false;
    expect(await E.run([E.src])).toBe(2);
    E.ports.isTty = () => true;
    E.ports.preflight = () => ({ ok: false, problems: ["gocryptfs 缺失"] });
    expect(await E.run([E.src])).toBe(69);
    E.ports.preflight = () => ({ ok: true, problems: [] });
    expect(
      await E.run([E.src], {
        bins: { mv: "mv", sync: "sync", getfattr: join(E.bin, "nope"), flock: "flock", git: "git" },
      }),
    ).toBe(69);
    expect(E.err.join("\n")).toContain("getfattr");
    expectNoSideEffects(E, before);
  });

  it("content problems on the original (xattr, setgid dir, escaping link) ⇒ 65 before any prompt", async () => {
    const E = makeEnv("e4");
    script(
      E.bin,
      "getfattr",
      `for a in "$@"; do case "$a" in */a.txt) printf '# file: %s\\nuser.k="v"\\n\\n' "$a";; esac; done; exit 0`,
    );
    let prompted = false;
    E.ports.prompt = async () => {
      prompted = true;
      return "proj";
    };
    const before = snapshot(E.src);
    expect(await E.run([E.src])).toBe(65);
    expect(E.err.join("\n")).toContain("扩展属性");
    script(E.bin, "getfattr", "exit 0");
    mkdirSync(join(E.src, "sg"));
    chmodSync(join(E.src, "sg"), 0o2755);
    expect(await E.run([E.src])).toBe(65);
    chmodSync(join(E.src, "sg"), 0o755);
    symlinkSync("../../outside", join(E.src, "src", "esc"));
    expect(await E.run([E.src])).toBe(65);
    expect(prompted).toBe(false);
    expect(E.reg.size).toBe(0);
    expect(existsSync(E.vault().dir)).toBe(false);
    void before;
  });

  it("occupied source ⇒ 76; group-writable parent ⇒ 65; declined confirmation ⇒ 1 「未做任何修改」", async () => {
    const E = makeEnv("e5");
    const before = snapshot(E.src);
    const k = spawn("sleep", ["30"], { cwd: join(E.src, "src"), stdio: "ignore" });
    kids.push(k);
    await new Promise((r) => setTimeout(r, 200));
    expect(await E.run([E.src])).toBe(76);
    expect(E.err.join("\n")).toContain(`pid ${k.pid}`);
    k.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 100));
    chmodSync(E.home, 0o770);
    expect(await E.run([E.src])).toBe(65);
    chmodSync(E.home, 0o700);
    E.world.promptAnswer = "nope";
    expect(await E.run([E.src])).toBe(1);
    expect(E.out.join("\n")).toContain("已取消，未做任何修改");
    expectNoSideEffects(E, before);
  });

  it("the global convert lock is exclusive ⇒ 73", async () => {
    const E = makeEnv("e6");
    const lockPath = join(E.home, ".local", "share", "pi-toolkit-secure", ".convert.lock");
    const held = await C.acquireConvertLock(lockPath);
    try {
      expect(await E.run([E.src])).toBe(73);
      await expect(C.acquireConvertLock(lockPath)).rejects.toMatchObject({ exit: 73 });
    } finally {
      await held.release();
    }
    const again = await C.acquireConvertLock(lockPath);
    await again.release();
  });
});

describe("authoritative check runs on the frozen backup", () => {
  it("backup gains a setuid file after the early check ⇒ 65, rolled back, source home again", async () => {
    const E = makeEnv("auth1");
    const before = snapshot(E.src);
    E.world.treeArgvOverride = (op) =>
      op === "freeze" ? wrappedTreeArgv(E.base, op, `fs.chmodSync(path.join(B, "run.sh"), 0o4755);`) : undefined;
    expect(await E.run([E.src])).toBe(65);
    expect(E.err.join("\n")).toContain("权威检查");
    expect(E.out.join("\n")).toContain("已回滚");
    const after = snapshot(E.src);
    expect({ ...after, "run.sh": undefined }).toEqual({ ...before, "run.sh": undefined });
    expect((after["run.sh"] as any).mode).toBe("4755"); // the concurrent change itself is kept, never undone
    expect(E.reg.size).toBe(0);
    expect(existsSync(E.vault().dir)).toBe(false);
    expect(existsSync(E.vault().mnt)).toBe(false);
    expect(existsSync(join(E.txnDir, "convert-proj.json"))).toBe(false);
  });

  it("an xattr appearing only on the backup ⇒ 65 (early check clean), rolled back", async () => {
    const E = makeEnv("auth2");
    script(
      E.bin,
      "getfattr",
      `for a in "$@"; do case "$a" in */xattr-marker) printf '# file: %s\\nsystem.posix_acl_access=0sAg==\\n\\n' "$a";; esac; done; exit 0`,
    );
    E.world.treeArgvOverride = (op) =>
      op === "check"
        ? wrappedTreeArgv(
            E.base,
            op,
            `if (spec.manifestOut) { fs.chmodSync(B, 0o755); fs.writeFileSync(path.join(B, "xattr-marker"), "m"); fs.chmodSync(B, 0o555); }`,
          )
        : undefined;
    const rootMode = (snapshot(E.src)["."] as any).mode;
    expect(await E.run([E.src])).toBe(65);
    expect(E.err.join("\n")).toMatch(/xattr-marker：带扩展属性/);
    expect(E.out.join("\n")).toContain("已回滚");
    expect(existsSync(join(E.src, "xattr-marker"))).toBe(true); // data never deleted
    expect((snapshot(E.src)["."] as any).mode).toBe(rootMode);
    expect(E.reg.size).toBe(0);
    expect(existsSync(E.vault().dir)).toBe(false);
  });
});
