/**
 * P1 launcher end-to-end against REAL gocryptfs / fusermount3 / flock
 * (docs/dev/data-encryption/plan.md §2.1–§2.5, §6 "启动器测试" + "有界收尾").
 *
 * Self-gating like the P0 conformance: skipped unless Linux + gocryptfs + fusermount3 + flock +
 * script(1) + a usable /dev/fuse. Everything lives under ONE private 0700 mktemp dir used as HOME;
 * the password is a TEST-ONLY fake typed through a pty (script(1)) or, for test-side setup only,
 * read from a passfile. afterAll lazily unmounts every mount under that dir and deletes it.
 * pi is a fake package (re-exporting the real parseArgs) that records its argv/cwd/env.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");
const BIN = join(REPO, "src", "secure", "bin", "pi-secure");
const PI_ARGS = join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli", "args.js");
const FAKE_PW = "TESTPASS-fake-not-a-secret";

const which = (b: string) => {
  const r = spawnSync("sh", ["-c", `command -v ${b}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
};
const HAVE_FUSE =
  process.platform === "linux" &&
  ["gocryptfs", "fusermount3", "flock", "script"].every((b) => which(b) !== undefined) &&
  spawnSync("sh", ["-c", "[ -c /dev/fuse ] && [ -r /dev/fuse ] && [ -w /dev/fuse ]"]).status === 0;

function exe(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

describe.skipIf(!HAVE_FUSE)("pi-secure against real gocryptfs", () => {
  let root = "";
  let home = "";
  let record = "";
  let env: NodeJS.ProcessEnv = {};
  let dir = "";
  let mnt = "";
  let work = "";
  let state = "";
  let lock = "";
  let lease = "";
  let passfile = "";

  const mounted = () =>
    readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .some((l) => l.split(" ")[4] === mnt && l.includes(" - fuse.gocryptfs "));

  function run(args: string[], extraEnv: NodeJS.ProcessEnv = {}, timeout = 30_000) {
    const t0 = Date.now();
    const r = spawnSync(BIN, args, {
      env: { ...env, ...extraEnv },
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - t0 };
  }

  /** Under a pty; types the next answer at each new "Password:"/"Repeat:" prompt. */
  function runTty(
    cmd: string,
    answers: string[],
    timeoutMs = 60_000,
    extraEnv: NodeJS.ProcessEnv = {},
  ): Promise<{ code: number | null; text: string }> {
    return new Promise((resolve) => {
      const child = spawn("script", ["-qefc", cmd, "/dev/null"], {
        env: { ...env, ...extraEnv },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let text = "";
      let typed = 0;
      const onData = (b: Buffer) => {
        text += b.toString("utf8");
        const prompts = text.split(/Password:|Repeat:/).length - 1;
        if (prompts > typed && typed < answers.length && /(Password|Repeat): *$/.test(text.trimEnd() + " ")) {
          child.stdin.write(`${answers[typed++]}\r`);
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        child.stdin.destroy();
        resolve({ code, text: text.replace(/\r/g, "") });
      });
    });
  }

  /** Test-side setup only: mount with the fake passfile, bypassing the launcher. */
  function mountDirect(): void {
    if (mounted()) return;
    const r = spawnSync("gocryptfs", ["-q", "-nonempty", "-passfile", passfile, "--", join(dir, "cipher"), mnt], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(mounted()).toBe(true);
  }
  function unmountDirect(): void {
    if (mounted()) spawnSync("fusermount3", ["-u", mnt], { timeout: 10_000 });
    expect(mounted()).toBe(false);
  }
  const readRecord = () => JSON.parse(readFileSync(record, "utf8"));

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ps-fuse-"));
    chmodSync(root, 0o700);
    home = join(root, "home");
    mkdirSync(home, { mode: 0o700 });
    // fake pi package: real parseArgs, a binary that records how it was started
    const pkg = join(root, "fakepi");
    mkdirSync(join(pkg, "dist", "cli"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module" }),
    );
    writeFileSync(
      join(pkg, "dist", "cli", "args.js"),
      `export * from ${JSON.stringify(pathToFileURL(PI_ARGS).href)};\n`,
    );
    record = join(root, "pi-record.json");
    exe(
      join(pkg, "dist", "cli.js"),
      `#!/usr/bin/env node
import fs from "node:fs";
const e = process.env;
const lim = fs.readFileSync("/proc/self/limits", "utf8").split("\\n").find((l) => l.startsWith("Max core file size"));
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), umask: process.umask().toString(8), core: lim.split(/\\s{2,}/)[1],
  env: { PI_SECURE_VAULT: e.PI_SECURE_VAULT, PI_SECURE_SESSION: e.PI_SECURE_SESSION, PI_SECURE_ORIG_ENV: e.PI_SECURE_ORIG_ENV,
         PI_SECURE_STALE: e.PI_SECURE_STALE, TMPDIR: e.TMPDIR, ARMORY_MEMORY_ROOT: e.ARMORY_MEMORY_ROOT, PWD: e.PWD,
         PI_CODING_AGENT_SESSION_DIR: e.PI_CODING_AGENT_SESSION_DIR },
}));
process.exit(Number(e.FAKE_PI_EXIT ?? 0));
`,
    );
    mkdirSync(join(root, "bin"));
    symlinkSync(join(pkg, "dist", "cli.js"), join(root, "bin", "pi"));
    env = {
      PATH: `${join(root, "bin")}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      HOME: home,
      LANG: "C.UTF-8",
      TMPDIR: tmpdir(),
      PI_SECURE_STALE: "must-not-reach-pi",
      PI_CODING_AGENT_SESSION_DIR: "/must/not/reach/pi",
    };
    // §L.1 layout: metadata under <dir>, mount point ~/secure/acme
    dir = join(home, ".local", "share", "pi-toolkit-secure", "acme");
    mnt = join(home, "secure", "acme");
    work = join(mnt, "work");
    state = join(mnt, "state");
    lock = join(dir, "mount.lock");
    lease = join(dir, "mount.lease");
    passfile = join(root, "pf");
    writeFileSync(passfile, `${FAKE_PW}\n`, { mode: 0o600 });
  });

  afterAll(() => {
    if (!root) return;
    spawnSync("pkill", ["-CONT", "-f", `gocryptfs .*${root}`]);
    for (const l of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
      const mp = l.split(" ")[4];
      if (mp && mp.startsWith(root + "/")) spawnSync("fusermount3", ["-uz", mp], { timeout: 10_000 });
    }
    spawnSync("chmod", ["-R", "u+rwx", root]);
    rmSync(root, { recursive: true, force: true });
  });

  it("init: TTY password ×2 + master key printed once, layout + settings + link, first mount, left unmounted", async () => {
    const r = await runTty(`${BIN} init acme`, [FAKE_PW, FAKE_PW, FAKE_PW]);
    expect(r.code, r.text).toBe(0);
    const plain = r.text.replace(/\x1b\[[0-9;]*m/g, "");
    const key = plain
      .slice(plain.indexOf("master key is:"))
      .match(/[0-9a-f]{8}(?=-|\s)/g)
      ?.slice(0, 8)
      .join("");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(plain).toContain("clear");
    expect(plain).toContain("tmux clear-history");
    expect(JSON.parse(readFileSync(join(home, ".pi", "agent", "pi-subagent.json"), "utf8"))).toEqual({
      secure: { vaults: { acme: { dir, mnt } } },
    });
    expect(mounted()).toBe(false);
    // §L.1: the mount point is a real 0700 dir holding exactly the two sentinels; no entry symlink
    expect(readdirSync(mnt).sort()).toEqual(["state", "work"]);
    expect(lstatSync(mnt).isSymbolicLink()).toBe(false);
    expect(spawnSync("cd", [work], { shell: "/bin/sh" }).status).not.toBe(0); // sentinel: cd fails
    const leaseSt = lstatSync(lease);
    expect(leaseSt.isFile()).toBe(true);
    expect(leaseSt.mode & 0o777).toBe(0o600);
    // the master key is never persisted by the launcher
    const grep = spawnSync("grep", ["-rlF", key!, home], { encoding: "utf8" });
    expect(grep.stdout).toBe("");
    // re-init is refused
    const again = await runTty(`${BIN} init acme`, []);
    expect(again.code).toBe(1);
    expect(again.text).toContain("已存在");
  }, 90_000);

  it("unlock: mounts via the TTY prompt, verifies mountinfo, lock not leaked, project sessionDir written, dirs created", async () => {
    const r = await runTty(`${BIN} unlock acme`, [FAKE_PW]);
    expect(r.code, r.text).toBe(0);
    expect(mounted()).toBe(true);
    expect(spawnSync("flock", ["-n", lock, "true"]).status).toBe(0);
    expect(JSON.parse(readFileSync(join(work, ".pi", "settings.json"), "utf8"))).toEqual({
      sessionDir: join(state, "sessions", "default"),
    });
    for (const d of ["sessions/default", "tmp", "bash-jobs", "workflows", "consult", "memory"])
      expect(existsSync(join(state, d)), d).toBe(true);
    // second unlock needs no TTY: already mounted
    const again = run(["unlock", "acme"]);
    expect(again.code, again.err).toBe(0);
    expect(again.out).toContain("已挂载");
    const st = run(["status", "acme"]);
    expect(st.out).toMatch(new RegExp(`acme: mounted {2}layout ok {2}mnt ${mnt.replace(/\./g, "\\.")}$`, "m"));
  }, 60_000);

  it("run (already mounted): pi is a child with the contract env, -C cwd, --session-dir first; exit code is pi's; finalize unmounts", () => {
    mountDirect();
    mkdirSync(join(work, "sub"), { recursive: true });
    const r = run(["run", "acme", "-C", "sub", "--model", "x/y", "--", "--session-dir", "is a message"], {
      FAKE_PI_EXIT: "3",
    });
    expect(r.code, r.err).toBe(3);
    const rec = readRecord();
    expect(rec.argv).toEqual([
      "--session-dir",
      join(state, "sessions", "default"),
      "--model",
      "x/y",
      "--",
      "--session-dir",
      "is a message",
    ]);
    expect(rec.cwd).toBe(join(work, "sub"));
    expect(rec.umask).toBe("77");
    expect(rec.core).toBe("0");
    expect(rec.env).toEqual({
      PI_SECURE_VAULT: "acme",
      PI_SECURE_SESSION: "1",
      PI_SECURE_ORIG_ENV: JSON.stringify({ TMPDIR: tmpdir(), ARMORY_MEMORY_ROOT: null }),
      TMPDIR: join(state, "tmp"),
      ARMORY_MEMORY_ROOT: join(state, "memory"),
      PWD: join(work, "sub"),
    });
    expect(r.out).toContain("acme：已卸载");
    expect(mounted()).toBe(false);
  }, 60_000);

  it("run (locked): asks for the password via the TTY, runs pi with --no-session, unmounts", async () => {
    expect(mounted()).toBe(false);
    rmSync(record, { force: true });
    const r = await runTty(`${BIN} run acme --no-session -p hi`, [FAKE_PW]);
    expect(r.code, r.text).toBe(0);
    expect(readRecord().argv).toEqual([
      "--session-dir",
      join(state, "sessions", "default"),
      "--no-session",
      "-p",
      "hi",
    ]);
    expect(mounted()).toBe(false);
  }, 60_000);

  it("run: a bad pi argument is refused before mounting (no password prompt)", () => {
    rmSync(record, { force: true });
    const r = run(["run", "acme", "--session", join(root, "outside.jsonl")]);
    expect(r.code).toBe(64);
    expect(mounted()).toBe(false);
    expect(existsSync(record)).toBe(false);
  });

  it("a different project sessionDir blocks run/unlock (exit 78); init --fix-settings backs up and fixes", () => {
    mountDirect();
    const f = join(work, ".pi", "settings.json");
    writeFileSync(f, JSON.stringify({ sessionDir: "/home/someone/old", theme: "t" }));
    rmSync(record, { force: true });
    const r = run(["run", "acme"]);
    expect(r.code).toBe(78);
    expect(r.err).toContain("pi-secure init acme --fix-settings");
    expect(existsSync(record)).toBe(false);
    expect(mounted()).toBe(true); // it was already mounted before run: left as found
    expect(run(["unlock", "acme"]).code).toBe(78);
    const fix = run(["init", "acme", "--fix-settings"]);
    expect(fix.code, fix.err).toBe(0);
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ sessionDir: join(state, "sessions", "default"), theme: "t" });
    const backups = readdirSync(join(work, ".pi")).filter((n) => n.startsWith("settings.json.bak-"));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(work, ".pi", backups[0]!), "utf8")).sessionDir).toBe("/home/someone/old");
    expect(run(["unlock", "acme"]).code).toBe(0);
  }, 60_000);

  it("lock with a process whose cwd is inside: lists it, does not unmount; --lazy would; then plain lock succeeds", async () => {
    mountDirect();
    const occ = spawn("sleep", ["30"], { cwd: work, stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 150));
      const r = run(["lock", "acme"]);
      expect(r.code).toBe(76);
      expect(r.err).toContain(`pid ${occ.pid} sleep`);
      expect(mounted()).toBe(true);
    } finally {
      occ.kill("SIGKILL");
    }
    await new Promise((r) => setTimeout(r, 150));
    const ok = run(["lock", "acme"]);
    expect(ok.code, ok.err).toBe(0);
    expect(mounted()).toBe(false);
  }, 60_000);

  it("bounded finalize ① scan over budget ⇒ warns and skips the unmount, well within 11s", () => {
    mountDirect();
    const r = run(["lock", "acme"], { PI_SECURE_TEST_SCAN_DELAY_MS: "20000" });
    expect(r.code).toBe(75);
    expect(r.err).toContain("占用扫描超时，未卸载");
    expect(r.ms).toBeLessThan(11_000);
    expect(mounted()).toBe(true);
  }, 30_000);

  it("bounded finalize ② mount.lock held for long ⇒ gives up within 11s, still mounted", async () => {
    mountDirect();
    const holder = spawn("flock", [lock, "sleep", "60"], { stdio: "ignore", detached: true });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const r = run(["lock", "acme"]);
      expect([73, 75]).toContain(r.code);
      expect(r.err).toMatch(/mount\.lock|预算内完成/);
      expect(r.ms).toBeLessThan(11_000);
      expect(mounted()).toBe(true);
    } finally {
      process.kill(-holder.pid!, "SIGKILL");
    }
  }, 30_000);

  it("bounded finalize ③ an unmount helper that ignores TERM and never exits ⇒ group-KILLed, returns within 11s (lock and run)", async () => {
    mountDirect();
    const hang = join(root, "hangbin");
    const marker = `ps-hang-${process.pid}`;
    exe(join(hang, "fusermount3"), `#!/bin/bash\ntrap '' TERM INT HUP\nexec -a ${marker} sleep 120\n`);
    const pathWithHang = `${hang}:${env.PATH}`;
    const r = run(["lock", "acme"], { PATH: pathWithHang });
    expect(r.code).toBe(75);
    expect(r.err).toContain("卸载命令未在预算内完成");
    expect(r.ms).toBeLessThan(11_000);
    await new Promise((res) => setTimeout(res, 300));
    expect(spawnSync("pgrep", ["-f", marker]).status).toBe(1); // nothing left behind
    // the same through `run` (pi exits, finalize hangs on the fake helper): exit code stays pi's
    const r2 = run(["run", "acme", "--version"], { PATH: pathWithHang, FAKE_PI_EXIT: "0" });
    expect(r2.code).toBe(0);
    expect(r2.err).toContain("卸载命令未在预算内完成");
    expect(r2.ms).toBeLessThan(12_000);
    expect(mounted()).toBe(true);
    expect(spawnSync("pgrep", ["-f", marker]).status).toBe(1);
    expect(run(["lock", "acme"]).code).toBe(0);
    expect(mounted()).toBe(false);
  }, 60_000);

  it("stale mount (daemon killed ⇒ ENOTCONN): status says stale; lock clears it", async () => {
    mountDirect();
    const cipher = join(dir, "cipher");
    spawnSync("pkill", ["-KILL", "-f", `gocryptfs .*-fg .*${cipher}`]);
    await new Promise((r) => setTimeout(r, 400));
    expect(run(["status", "acme"]).out).toMatch(/acme: stale/);
    const r = run(["lock", "acme"]);
    expect(r.code, r.err).toBe(0);
    expect(mounted()).toBe(false);
  }, 30_000);

  // ───────── security review fixes (r2) ─────────

  it("review #1: state/sessions symlinked out of the vault + --fork ⇒ pi never starts, nothing new outside", () => {
    mountDirect();
    const outside = join(root, "outside-sessions");
    mkdirSync(join(outside, "default"), { recursive: true });
    const src = join(root, "plain-source.jsonl");
    writeFileSync(src, '{"type":"session","version":3,"id":"x","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n');
    rmSync(join(state, "sessions"), { recursive: true, force: true });
    symlinkSync(outside, join(state, "sessions"));
    rmSync(record, { force: true });
    const r = run(["run", "acme", "--fork", src]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/sessions 须为本用户的普通目录/);
    expect(existsSync(record)).toBe(false);
    expect(readdirSync(join(outside, "default"))).toEqual([]);
    expect(readdirSync(outside)).toEqual(["default"]);
    expect(mounted()).toBe(true); // was mounted before run ⇒ left as found
    rmSync(join(state, "sessions"));
    mkdirSync(join(state, "sessions", "default"), { recursive: true, mode: 0o700 });
  }, 60_000);

  it("review #1 + #4: same planted link on a FRESH mount ⇒ refused, and the mount this run made is undone", async () => {
    mountDirect();
    const outside = join(root, "outside-sessions-2");
    mkdirSync(outside);
    rmSync(join(state, "sessions"), { recursive: true, force: true });
    symlinkSync(outside, join(state, "sessions"));
    unmountDirect();
    rmSync(record, { force: true });
    const r = await runTty(`${BIN} run acme --fork ${join(root, "plain-source.jsonl")}`, [FAKE_PW]);
    expect(r.code, r.text).toBe(1);
    expect(r.text).toContain("本次挂载已撤销");
    expect(mounted()).toBe(false);
    expect(existsSync(record)).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
    mountDirect();
    rmSync(join(state, "sessions"));
    mkdirSync(join(state, "sessions", "default"), { recursive: true, mode: 0o700 });
    unmountDirect();
  }, 60_000);

  it("review #4: a NON-config failure after a fresh mount (state/tmp is a file) also rolls the mount back", async () => {
    mountDirect();
    rmSync(join(state, "tmp"), { recursive: true, force: true });
    writeFileSync(join(state, "tmp"), "not a dir");
    unmountDirect();
    rmSync(record, { force: true });
    const r = await runTty(`${BIN} run acme --version`, [FAKE_PW]);
    expect(r.code, r.text).toBe(1);
    expect(r.text).toMatch(/tmp 须为本用户的普通目录/);
    expect(r.text).toContain("本次挂载已撤销");
    expect(mounted()).toBe(false);
    expect(existsSync(record)).toBe(false);
    // unlock behaves the same
    const u = await runTty(`${BIN} unlock acme`, [FAKE_PW]);
    expect(u.code, u.text).toBe(1);
    expect(mounted()).toBe(false);
    mountDirect();
    rmSync(join(state, "tmp"));
    mkdirSync(join(state, "tmp"), { mode: 0o700 });
    unmountDirect();
  }, 90_000);

  it("review #2: in-vault links of different depth + relative --session: audit uses pi's real cwd", () => {
    mountDirect();
    mkdirSync(join(work, "a", "b"), { recursive: true });
    rmSync(join(work, "deep"), { force: true });
    rmSync(join(work, "x"), { recursive: true, force: true });
    symlinkSync(join(work, "a", "b"), join(work, "deep")); // shallow name → deeper dir
    mkdirSync(join(work, "x", "y"), { recursive: true });
    symlinkSync(work, join(work, "x", "y", "up")); // deeper name → shallower dir
    // inside lexically (work/deep/../.. = mnt) but pi would resolve from work/a/b ⇒ work/state/… (not the vault sessions)
    rmSync(record, { force: true });
    const r1 = run(["run", "acme", "-C", "deep", "--session", "../../state/sessions/default/x.jsonl"]);
    expect(r1.code, r1.err).toBe(64);
    expect(r1.err).toMatch(/参数被拒：--session/);
    expect(mounted()).toBe(true); // already mounted before run ⇒ refusal keeps it
    expect(existsSync(record)).toBe(false);
    // outside lexically already ⇒ refused before mounting-or-not (fail closed)
    expect(run(["run", "acme", "-C", "x/y/up", "--session", "../state/sessions/default/x.jsonl"]).code).toBe(64);
    // a genuinely valid relative --session from the canonical cwd passes, and pi gets that exact cwd
    const r3 = run(["run", "acme", "-C", "deep", "--session", "../../../state/sessions/default/x.jsonl"]);
    // lexical: work/deep/../../.. = dir (outside) ⇒ refused by the lexical pass — documented fail-closed
    expect(r3.code).toBe(64);
    const r4 = run(["run", "acme", "-C", "x/y/up", "--session", "../../../../state/sessions/default/x.jsonl"]);
    // lexical: work/x/y/up/../../../.. = mnt ⇒ mnt/state/sessions ✓; physical: work/../../../.. ⇒ outside ⇒ refused
    expect(r4.code).toBe(64);
    mountDirect();
    const ok = run(["run", "acme", "-C", "deep", "--version"]);
    expect(ok.code, ok.err).toBe(0);
    expect(readRecord().cwd).toBe(join(work, "a", "b"));
    expect(readRecord().env.PWD).toBe(join(work, "a", "b"));
    mountDirect();
    rmSync(join(work, "deep"));
    rmSync(join(work, "x"), { recursive: true });
  }, 60_000);

  it("review #3: a wedged FUSE daemon (SIGSTOP) cannot stall lock: ⇒ exit 75 with a leftover-mount warning, ≤ hard backstop", async () => {
    mountDirect();
    const cipher = join(dir, "cipher");
    const pids = spawnSync("pgrep", ["-f", `gocryptfs .*-fg .*${cipher}`], { encoding: "utf8" })
      .stdout.trim()
      .split("\n")
      .filter(Boolean);
    expect(pids.length).toBeGreaterThan(0);
    for (const p of pids) process.kill(Number(p), "SIGSTOP");
    try {
      const r = run(["lock", "acme"], {}, 20_000);
      expect(r.code, r.err).toBe(75);
      expect(r.err).toMatch(/可能仍挂载/);
      expect(r.ms).toBeLessThan(10_500 + 1_000);
      expect(r.err).toMatch(/挂载探测超时/);
    } finally {
      for (const p of pids) process.kill(Number(p), "SIGCONT");
    }
    await new Promise((res) => setTimeout(res, 300));
    const ok = run(["lock", "acme"]);
    expect(ok.code, ok.err).toBe(0);
    expect(mounted()).toBe(false);
  }, 60_000);

  it("review #2/r2 A3: an injected post-mount identity failure rolls the FRESH mount back (fusermount3 -u)", async () => {
    expect(mounted()).toBe(false);
    // gocryptfs really mounts; the post-mount identity check is forced to fail inside __mount;
    // doMount then throws and unlockVault MUST probe + unmount what this call created.
    const r = await runTty(`${BIN} unlock acme`, [FAKE_PW], 60_000, { PI_SECURE_TEST_MOUNT_VERIFY_FAIL: "1" });
    expect(r.code, r.text).toBe(1);
    expect(r.text).toContain("TEST 注入");
    expect(r.text).toContain("本次挂载已撤销");
    expect(mounted()).toBe(false);
    const st = run(["status", "acme"]);
    expect(st.out).toMatch(/acme: locked/); // nothing left mounted
    // the vault is still perfectly usable afterwards
    const again = await runTty(`${BIN} unlock acme`, [FAKE_PW]);
    expect(again.code, again.text).toBe(0);
    expect(mounted()).toBe(true);
    unmountDirect();
  }, 90_000);

  it("wrong password three times through the real gocryptfs ⇒ exit 77, nothing mounted, lock free", async () => {
    const r = await runTty(`${BIN} unlock acme`, ["wrong-1", "wrong-2", "wrong-3"]);
    expect(r.code, r.text).toBe(77);
    expect(r.text).toContain("口令错误（2/3）");
    expect(mounted()).toBe(false);
    expect(spawnSync("flock", ["-n", lock, "true"]).status).toBe(0);
    unmountDirect();
  }, 60_000);
});
