/**
 * V7 — launcher e2e for convert / export / import (convert-plan r3/r3.1 §7.2): REAL gocryptfs, the
 * REAL `pi-secure` launcher (bash entry → helper.mjs → convert/archive engines and their workers),
 * a fake pi, and a TEST-ONLY password typed through script(1). Everything lives under per-test mktemp
 * homes owned by a RealHarness (token-marked processes, token-scoped cleanup); nothing touches the
 * user's ~/secure or ~/.pi.
 *
 * Self-gating: skipped without gocryptfs / fusermount3 / flock / script / unshare / usable /dev/fuse
 * (realSkipReason). getfattr: when the real one is NOT installed, a python3 stand-in (os.listxattr,
 * same `-h -d -m - --absolute-names [-R]` dump format) is put first on the launcher's PATH so convert's
 * preflight can run; the "missing getfattr ⇒ 69" case runs only on such a machine. When the real one
 * exists it is used as is (V7-report §residual: XC7 pins the real tool's output).
 *
 * Seams used (test-only env, they can only make a flow fail / delay it):
 *   PI_SECURE_TEST_CONVERT_FAIL_AT=<step>:<before|after>       §7.2-3 rollback at every step
 *   PI_SECURE_TEST_CONVERT_STOP_AT=<step>:<before|mid|after>   the orchestrator SIGSTOPs itself:
 *                                                              SIGKILL ⇒ interruption at an exact phase,
 *                                                              change the world + SIGCONT ⇒ exact race
 *   PI_SECURE_TEST_ARCHIVE_STALL_MS                            archive worker delay before each op
 *
 * Iron rules asserted end to end: the source is never deleted (every path: success, rollback,
 * interruption, abort, refusal); the backup is read-only and byte-identical to the control copy; old
 * sessions and memory are only copied (bytes + mtime unchanged); a set-aside vault is renamed to
 * `.aborted-<txid>`, never deleted.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { snapshot } from "./convert-fixtures.js";
import { acquireGocryptfsTestLock } from "./gocryptfs-test-lock.js";
import {
  BIN,
  type Env,
  PW,
  REPO,
  RealHarness,
  globalMounted,
  plain,
  realSkipReason,
  sleep,
  until,
  which,
} from "./private-real-harness.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- plain-JS modules, no typings by design
const S: any = await import(pathToFileURL(join(REPO, "src", "secure", "bin", "sessions.mjs")).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Pi: any = await import(
  pathToFileURL(join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "session-manager.js"))
    .href
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const G: any = await import(pathToFileURL(join(REPO, "tests", "fixtures", "secure-tar-corpus", "gen.mjs")).href);

const SKIP = realSkipReason();
/**
 * Where a convert e2e can live (no product override exists, by design):
 *  - the SOURCE must be strictly under $HOME and outside SYSTEM_DIRS (/tmp, /var, …) ⇒ the scratch
 *    HOME lives in a mktemp root inside the repo's gitignored node_modules cache;
 *  - every ANCESTOR of the mount point must be owned by us/root and not group/other-writable unless
 *    root-owned + sticky (§L.1) — a developer home is often 0775 (this machine's is) ⇒ the mount point
 *    is put with `--path` into a mktemp dir under /tmp (root-owned, sticky).
 * Never the user's real ~/secure or ~/.pi; same token-scoped cleanup as every RealHarness dir.
 */
const E2E_ROOT = join(REPO, "node_modules", ".cache", "v7");
/** (Re)create the shared root right before use: a concurrent run's afterAll may rmdir it when empty. */
function e2eSetup(T: RealHarness): Env {
  for (let i = 0; ; i++) {
    mkdirSync(E2E_ROOT, { recursive: true, mode: 0o700 });
    try {
      return T.setup([], { acme: false, root: E2E_ROOT, prefix: "v7" });
    } catch (e) {
      if (i >= 3 || (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
const REAL_GETFATTR = which("getfattr");

const FAKE_GETFATTR = `#!/usr/bin/env python3
# TEST stand-in for attr's getfattr (only installed when the real one is missing): same dump format.
import os, sys
args = sys.argv[1:]
paths = args[args.index("--") + 1:] if "--" in args else [a for a in args if not a.startswith("-")]
rec = "-R" in args
rc = 0
def dump(p):
    global rc
    try:
        names = os.listxattr(p, follow_symlinks=False)
    except OSError as e:
        sys.stderr.write("getfattr: %s: %s\\n" % (p, e.strerror)); rc = 1; return
    if names:
        sys.stdout.write("# file: %s\\n" % p)
        for n in names:
            sys.stdout.write('%s=""\\n' % n)
        sys.stdout.write("\\n")
for p in paths:
    dump(p)
    if rec and os.path.isdir(p) and not os.path.islink(p):
        for d, dirs, files in os.walk(p, followlinks=False):
            for n in dirs + files:
                dump(os.path.join(d, n))
sys.exit(rc)
`;

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
function git(dir: string, ...a: string[]): string {
  const r = spawnSync("git", ["--no-optional-locks", "-C", dir, ...a], {
    env: { ...process.env, ...GIT_ENV },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

type Paths = {
  share: string;
  txn: string;
  settings: string;
  sessions: string;
  memory: string;
  dir: (n: string) => string;
  mnt: (n: string) => string;
};
const paths = (h: string): Paths => ({
  share: join(h, ".local", "share", "pi-toolkit-secure"),
  txn: join(h, ".local", "share", "pi-toolkit-secure", ".txn"),
  settings: join(h, ".pi", "agent", "pi-subagent.json"),
  sessions: join(h, ".pi", "agent", "sessions"),
  memory: join(h, ".pi", "agent", "memory"),
  dir: (n) => join(h, ".local", "share", "pi-toolkit-secure", n),
  mnt: (n) => join(h, "secure", n),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vaultsOf = (h: string): Record<string, any> =>
  JSON.parse(readFileSync(paths(h).settings, "utf8")).secure?.vaults ?? {};

/** Every non-symlink entry under `root` lacks all write bits (the backup is read-only). */
function writableEntries(root: string): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (st.mode & 0o222) out.push(p);
    if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n));
  };
  walk(root);
  return out;
}

/** Snapshot without the write bits (the backup keeps everything except w). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noW = (snap: Record<string, any>) =>
  Object.fromEntries(
    Object.entries(snap).map(([k, e]) => [k, { ...e, mode: (parseInt(e.mode, 8) & ~0o222).toString(8) }]),
  );

type FileFact = { path: string; sha: string; mtimeMs: number; ino: number; size: number };
function fact(p: string): FileFact {
  const st = statSync(p);
  return {
    path: p,
    sha: createHash("sha256").update(readFileSync(p)).digest("hex"),
    mtimeMs: st.mtimeMs,
    ino: st.ino,
    size: st.size,
  };
}

type Fixture = {
  e: Env;
  h: string;
  proj: string;
  /** the vault's mount point (`--path`, under a /tmp mktemp dir) */
  mnt: string;
  control: Record<string, unknown>;
  head: string;
  status: string;
  sessions: { root: string; child: string; sub: string; unrelated: string; worktree: string };
  ids: { root: string; child: string; sub: string; unrelated: string; worktree: string };
  memFile: string;
  oldFacts: FileFact[];
};

/** Install the fake getfattr (only when the real one is missing). */
function withGetfattr(e: Env): void {
  if (REAL_GETFATTR) return;
  const p = join(e.r, "bin", "getfattr");
  writeFileSync(p, FAKE_GETFATTR, { mode: 0o755 });
  chmodSync(p, 0o755);
}

/**
 * A project at $HOME/proj (git repo: 2 commits, untracked + modified files, `.bin` symlink, hardlink
 * group, subdir, empty dir, read-only file/dir, long name) + pi sessions (root, child agent with a
 * subagent:run reference, subdir session, unrelated) + project memory.
 */
function makeFixture(T: RealHarness, { sessions = true }: { sessions?: boolean } = {}): Fixture {
  const e = e2eSetup(T);
  withGetfattr(e);
  const h = e.h;
  const proj = join(h, "proj");
  const mnt = join(T.tmp("ps-v7mnt-"), "proj");
  mkdirSync(join(proj, "sub", "deep"), { recursive: true });
  mkdirSync(join(proj, "empty"));
  mkdirSync(join(proj, "scripts"));
  mkdirSync(join(proj, ".bin"));
  writeFileSync(join(proj, "README.md"), "# proj\n");
  writeFileSync(join(proj, "a.txt"), "hello\n");
  writeFileSync(join(proj, "scripts", "tool.sh"), "#!/bin/sh\necho tool\n", { mode: 0o755 });
  symlinkSync("../scripts/tool.sh", join(proj, ".bin", "tool"));
  writeFileSync(join(proj, "sub", "deep", "data.bin"), Buffer.alloc(200 * 1024 + 3, 7));
  git(proj, "init", "-q", "-b", "main");
  git(proj, "add", "-A");
  git(proj, "commit", "-q", "-m", "one");
  writeFileSync(join(proj, "a.txt"), "hello\nworld\n");
  git(proj, "commit", "-q", "-am", "two");
  writeFileSync(join(proj, "a.txt"), "hello\nworld\nmodified\n"); // modified, uncommitted
  writeFileSync(join(proj, "untracked.txt"), "u\n");
  linkSync(join(proj, "untracked.txt"), join(proj, "sub", "hard-u")); // hardlink group
  writeFileSync(join(proj, `${"L".repeat(200)}.txt`), "long name\n");
  writeFileSync(join(proj, "ro.txt"), "readonly\n");
  chmodSync(join(proj, "ro.txt"), 0o444);
  mkdirSync(join(proj, "rodir"));
  writeFileSync(join(proj, "rodir", "x"), "x\n");
  chmodSync(join(proj, "rodir"), 0o555);
  const head = git(proj, "rev-parse", "HEAD").trim();
  const status = git(proj, "status", "--porcelain");
  const ids = {
    root: "e2e-root",
    child: "e2e-child",
    sub: "e2e-sub",
    unrelated: "e2e-unrelated",
    worktree: "e2e-worktree",
  };
  const P = paths(h);
  const sess = (cwd: string, id: string, extra: Record<string, unknown> = {}, lines: string[] = []): string => {
    const d = join(P.sessions, S.sessionDirSlug(cwd));
    mkdirSync(d, { recursive: true });
    const f = join(d, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
    const hdr = { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd, ...extra };
    writeFileSync(f, [JSON.stringify(hdr), ...lines].join("\n") + "\n");
    return f;
  };
  let files = { root: "", child: "", sub: "", unrelated: "", worktree: "" };
  let memFile = "";
  if (sessions) {
    const child = sess(proj, ids.child);
    // a child agent that ran in an isolation worktree OUTSIDE the tree: reached only through the closure
    const worktree = sess(join(h, "wt", "pi-agent-x"), ids.worktree);
    const root = sess(proj, ids.root, {}, [
      JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "custom", id: "r1", customType: "subagent:run", data: { diag: { sessionFile: child } } }),
      JSON.stringify({
        type: "custom",
        id: "r2",
        customType: "subagent:run",
        data: { diag: { sessionFile: worktree } },
      }),
    ]);
    // the child points back at its parent (pi's parentSession header field)
    const childHdr = JSON.parse(readFileSync(child, "utf8").split("\n")[0]!);
    writeFileSync(child, JSON.stringify({ ...childHdr, parentSession: root }) + "\n");
    const sub = sess(join(proj, "sub"), ids.sub);
    const unrelated = sess(join(h, "other"), ids.unrelated);
    files = { root, child, sub, unrelated, worktree };
    const md = join(P.memory, S.memorySlug(proj));
    mkdirSync(md, { recursive: true });
    memFile = join(md, "core.md");
    writeFileSync(memFile, "# memory of proj\n");
  }
  const oldFacts = sessions ? [...Object.values(files), memFile].map(fact) : [];
  const control = snapshot(proj);
  return { e, h, proj, mnt, control, head, status, sessions: files, ids, memFile, oldFacts };
}

const confirmAnswers = (name: string): Array<[RegExp, string]> => [
  [new RegExp(`确认请输入保险库名 ${name}：`), name],
  [/继续？\[y\/N\]/, "y"],
];

/** `pi-secure convert <args>` in a pty, cwd = $HOME, answering the name confirmation and `y`. */
function convertTty(
  T: RealHarness,
  f: { e: Env; h: string; mnt: string },
  args: string,
  extra: Record<string, string> = {},
  opts: { name?: string; killAfterMs?: number; onText?: (t: string) => void } = {},
) {
  const name = opts.name ?? "proj";
  const withPath = args.startsWith("--") ? args : `${args} --path ${join(f.mnt, "..", name)}`;
  return T.tty(f.e, `convert ${withPath}`, extra, {
    cwd: f.h,
    answers: confirmAnswers(name),
    killAfterMs: opts.killAfterMs ?? 150_000,
    ...(opts.onText ? { onText: opts.onText } : {}),
  });
}

/** Test-side read-only look at a vault's plaintext through a passfile mount (never the launcher). */
function look<R>(e: Env, vaultDir: string, fn: (root: string) => R): R {
  const at = join(e.r, `look-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(at, { mode: 0o700 });
  const m = spawnSync("gocryptfs", ["-q", "-passfile", join(e.r, "pf"), "--", join(vaultDir, "cipher"), at], {
    env: e.env,
  });
  if (m.status !== 0) throw new Error(`test-side mount failed: ${m.stderr}`);
  try {
    return fn(at);
  } finally {
    spawnSync("fusermount3", ["-u", at]);
    rmdirSync(at);
  }
}

async function lookA<R>(e: Env, vaultDir: string, fn: (root: string) => Promise<R>): Promise<R> {
  const at = join(e.r, `look-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(at, { mode: 0o700 });
  const m = spawnSync("gocryptfs", ["-q", "-passfile", join(e.r, "pf"), "--", join(vaultDir, "cipher"), at], {
    env: e.env,
  });
  if (m.status !== 0) throw new Error(`test-side mount failed: ${m.stderr}`);
  try {
    return await fn(at);
  } finally {
    spawnSync("fusermount3", ["-u", at]);
    rmdirSync(at);
  }
}

/** pid of a running launcher node process of this harness whose argv contains `needle`. */
function launcherPid(T: RealHarness, needle: string): number | undefined {
  for (const n of readdirSync("/proc")) {
    if (!/^\d+$/.test(n) || !T.owned(Number(n))) continue;
    try {
      const argv = readFileSync(`/proc/${n}/cmdline`, "utf8").split("\0");
      if (argv.some((a) => a.endsWith("helper.mjs")) && argv.includes(needle)) return Number(n);
    } catch {
      /* gone */
    }
  }
  return undefined;
}

/** The stopped (SIGSTOP seam) launcher node process of this harness, if any. */
function stoppedLauncher(T: RealHarness): number | undefined {
  for (const n of readdirSync("/proc")) {
    if (!/^\d+$/.test(n)) continue;
    const pid = Number(n);
    if (!T.owned(pid)) continue;
    try {
      const cmd = readFileSync(`/proc/${n}/cmdline`, "utf8");
      const stat = readFileSync(`/proc/${n}/stat`, "utf8");
      if (cmd.includes("helper.mjs") && stat.slice(stat.lastIndexOf(")") + 2).startsWith("T")) return pid;
    } catch {
      /* gone */
    }
  }
  return undefined;
}
async function waitStopped(T: RealHarness, ms = 90_000): Promise<number> {
  let pid: number | undefined;
  await until(() => (pid = stoppedLauncher(T)) !== undefined, ms, "launcher stopped at the seam");
  return pid!;
}

const backupsOf = (h: string) => readdirSync(h).filter((n) => n.startsWith("proj.pi-secure-backup-"));
const abortedOf = (parent: string, base: string) =>
  existsSync(parent) ? readdirSync(parent).filter((n) => n.startsWith(`${base}.aborted-`)) : [];

/** Rolled back: source back at its path, identical to the control INCLUDING modes, no registration,
 *  no state file, nothing mounted, vault (if any) set aside as .aborted-<txid> (never deleted). */
function expectRolledBack(f: Fixture, { vault }: { vault: "aborted" | "none" | "any" }): void {
  const P = paths(f.h);
  expect(lstatSync(f.proj).isDirectory()).toBe(true);
  expect(snapshot(f.proj)).toEqual(f.control);
  expect(backupsOf(f.h)).toEqual([]);
  expect(vaultsOf(f.h).proj).toBeUndefined();
  expect(existsSync(join(P.txn, "convert-proj.json"))).toBe(false);
  expect(globalMounted(f.mnt)).toBe(false);
  expect(existsSync(P.dir("proj"))).toBe(false);
  expect(existsSync(f.mnt)).toBe(false);
  if (vault === "aborted") {
    const a = abortedOf(P.share, "proj");
    expect(a.length).toBe(1);
    expect(existsSync(join(P.share, a[0]!, "cipher", "gocryptfs.conf"))).toBe(true);
    expect(abortedOf(join(f.mnt, ".."), "proj").length).toBe(1); // the mount point too (sentinels inside)
  }
  if (vault === "none") expect(abortedOf(P.share, "proj")).toEqual([]);
  // old sessions + memory: never touched
  for (const o of f.oldFacts) expect(fact(o.path)).toEqual(o);
}

describe.skipIf(SKIP !== "")("V7 launcher e2e — convert / export / import (real gocryptfs, fake pi)", () => {
  // The cross-suite gocryptfs lock is held PER TEST (not for the whole ~3.5 min file) so the other
  // real-mount suites, whose acquire budgets are shorter, interleave instead of timing out. Each test
  // leaves nothing behind: T.cleanup() (token-owned processes, lazy unmounts under our scratch dirs,
  // scratch removal) runs before the lock is released.
  let release: (() => void) | undefined;
  const T = new RealHarness();
  beforeEach(async () => {
    release = await acquireGocryptfsTestLock(590_000);
  }, 600_000);
  afterEach(() => {
    try {
      T.cleanup();
    } finally {
      release?.();
      release = undefined;
    }
  });
  afterAll(() => {
    T.cleanup();
    try {
      rmdirSync(E2E_ROOT); // only if empty: every scratch home inside it is token-owned and gone
    } catch {
      /* not empty (another run) or already gone */
    }
  });

  // ───────────────────────────── §7.2-1 / -2 ─────────────────────────────

  it("§7.2-1/2 convert round trip: link, read-only backup = control, vault = control + settings, git intact, sessions/memory copied only", async () => {
    const f = makeFixture(T);
    const P = paths(f.h);
    const r = await convertTty(T, f, "proj");
    expect(r.code, r.text).toBe(0);
    // one confirmation, three password prompts (init ×2 + mount), master key printed once
    expect(r.text.match(/确认请输入保险库名 proj：/g)?.length).toBe(1);
    expect(r.text.split(/Password:|Repeat:/).length - 1).toBe(3);
    expect(r.text.match(/Your master key is:/g)?.length).toBe(1);
    // the original path is a symlink to ~/secure/proj/work; the backup is read-only and equals the control
    expect(lstatSync(f.proj).isSymbolicLink()).toBe(true);
    expect(readlinkSync(f.proj)).toBe(join(f.mnt, "work"));
    const [bk] = backupsOf(f.h);
    expect(bk).toMatch(/^proj\.pi-secure-backup-\d{8}-\d{6}-[0-9a-f]{4}$/);
    const backup = join(f.h, bk!);
    expect(writableEntries(backup)).toEqual([]);
    expect(noW(snapshot(backup))).toEqual(noW(f.control));
    expect(r.text).toContain(`原目录已改名为只读备份：${backup}`);
    // locked: entering the original path fails; nothing mounted; no txn files
    expect(globalMounted(f.mnt)).toBe(false);
    expect(spawnSync("sh", ["-c", `cd ${f.proj}`]).status).not.toBe(0);
    expect(readdirSync(P.txn).filter((n) => n.startsWith("convert-proj"))).toEqual([]);
    expect(vaultsOf(f.h).proj).toEqual({ dir: paths(f.h).dir("proj"), mnt: f.mnt, origin: f.proj, backup });
    // status: backup still present, no interrupted convert
    const st = plain(f.e, "status");
    expect(st.code, st.text).toBe(0);
    expect(st.text).toContain(`  backup: ${backup} (still present)`);
    expect(st.text).toContain(`  origin: ${f.proj}`);
    expect(st.text).not.toMatch(/convert proj: interrupted/);
    // inside the vault: identical to the control except .pi/settings.json (+ .bak); git intact
    await lookA(f.e, P.dir("proj"), async (root) => {
      const w = join(root, "work");
      const allowed = (k: string) => k === ".pi" || k === ".pi/settings.json" || k.startsWith(".pi/settings.json.bak-");
      // the work root itself is the vault's own 0700 directory (copy with applyRootMeta:false, V4 step 7)
      const strip = (o: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(o).filter(([k]) => !allowed(k) && k !== "."));
      expect(strip(snapshot(w))).toEqual(strip(f.control));
      expect(JSON.parse(readFileSync(join(w, ".pi", "settings.json"), "utf8")).sessionDir).toBe(
        join(f.mnt, "state", "sessions", "default"),
      );
      expect(git(w, "rev-parse", "HEAD").trim()).toBe(f.head);
      const lines = (t: string) =>
        t
          .split("\n")
          .filter((l) => l && l !== "?? .pi/")
          .sort();
      expect(lines(git(w, "status", "--porcelain"))).toEqual(lines(f.status));
      const fsck = spawnSync("git", ["-C", w, "fsck", "--no-dangling"], { env: { ...process.env, ...GIT_ENV } });
      expect(fsck.status, String(fsck.stderr)).toBe(0);
      // sessions: root/child/sub copied with rewritten cwd and visible to the real pi; unrelated not copied
      const sd = join(root, "state", "sessions", "default");
      const work = join(f.mnt, "work");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ids = (l: any[]) => l.map((x) => x.id).sort();
      expect(ids(await Pi.SessionManager.list(work, sd))).toEqual([f.ids.child, f.ids.root].sort());
      expect(ids(await Pi.SessionManager.list(join(work, "sub"), sd))).toEqual([f.ids.sub]);
      const all = readdirSync(sd).map((n) => readFileSync(join(sd, n), "utf8"));
      expect(all.some((t) => t.includes(f.ids.unrelated))).toBe(false);
      // closure: the worktree child is copied (header cwd outside the tree stays as is) and the root
      // copy's subagent:run reference points at the COPY, not at the old file
      const wtName = f.sessions.worktree.split("/").pop()!;
      const wtCopy = readFileSync(join(sd, wtName), "utf8");
      expect(JSON.parse(wtCopy.split("\n")[0]!).cwd).toBe(join(f.h, "wt", "pi-agent-x"));
      const rootCopy = readFileSync(join(sd, f.sessions.root.split("/").pop()!), "utf8");
      expect(rootCopy).toContain(JSON.stringify(join(f.mnt, "state", "sessions", "default", wtName)));
      expect(rootCopy).not.toContain(JSON.stringify(f.sessions.worktree));
      // memory: copied under the vault's own slug — unless the source slug is ambiguous (>10 dashes:
      // a deep checkout path), in which case convert leaves it alone and says so
      const srcSlug: string = S.memorySlug(f.proj);
      if ((srcSlug.slice(1).match(/-/g) ?? []).length <= 10)
        expect(readFileSync(join(root, "state", "memory", S.memorySlug(work), "core.md"), "utf8")).toBe(
          "# memory of proj\n",
        );
      else expect(r.text).toContain("memory 目录 slug 有歧义");
    });
    // old sessions + memory: bytes, mtime and inode unchanged, and listed in the output
    for (const o of f.oldFacts) expect(fact(o.path)).toEqual(o);
    expect(r.text).toContain(f.sessions.root);
    expect(existsSync(f.sessions.unrelated)).toBe(true);
  }, 240_000);

  // ───────────────────────────── §7.2-3 ─────────────────────────────

  const STEPS: Array<[number, "before" | "after"]> = [
    [2, "after"],
    [3, "after"],
    [4, "after"],
    [5, "before"],
    [6, "after"],
    [7, "after"],
    [8, "after"],
    [9, "after"],
    [10, "after"],
    [11, "before"],
    [12, "after"],
    [13, "after"],
    [14, "before"],
  ];
  it.each(STEPS)(
    "§7.2-3 fail seam at step %i:%s ⇒ rolled back: source restored (modes too), vault set aside, no registration",
    async (step, when) => {
      const f = makeFixture(T);
      const r = await convertTty(T, f, "proj", {
        PI_SECURE_TEST_SEAMS: "1",
        PI_SECURE_TEST_CONVERT_FAIL_AT: `${step}:${when}`,
      });
      expect(r.code, r.text).toBe(74);
      expect(r.text).toContain(`测试缝：第 ${step} 步（${when}）注入失败`);
      expect(r.text).toContain("已回滚");
      expectRolledBack(f, { vault: "aborted" });
      expect(r.text).toMatch(/内含本次拷贝的密文，核对后可自行删除/);
    },
    180_000,
  );

  it("§7.2-3 the step-11 barrier fails (sync -f exits non-zero) ⇒ rolled back the same way", async () => {
    const f = makeFixture(T);
    const fake = join(f.e.r, "bin", "sync");
    writeFileSync(
      fake,
      '#!/bin/sh\nfor a in "$@"; do [ "$a" = "-f" ] && { echo "sync: injected failure" >&2; exit 1; }; done\nexec /usr/bin/sync "$@"\n',
      { mode: 0o755 },
    );
    chmodSync(fake, 0o755);
    const r = await convertTty(T, f, "proj");
    expect(r.code, r.text).toBe(74);
    expect(r.text).toContain("持久化屏障");
    expect(r.text).toContain("已回滚");
    expectRolledBack(f, { vault: "aborted" });
  }, 180_000);

  // ───────────────────────────── §7.2-4 ─────────────────────────────

  async function killAt(f: Fixture, at: string): Promise<{ text: string }> {
    const run = convertTty(T, f, "proj", { PI_SECURE_TEST_SEAMS: "1", PI_SECURE_TEST_CONVERT_STOP_AT: at });
    const pid = await waitStopped(T);
    process.kill(pid, "SIGKILL"); // a kill -9 at exactly that phase
    const r = await run;
    return { text: r.text };
  }
  const resumeArgs = "--assume-unreadable-idle";

  it.each([
    ["3:mid", "renaming", false],
    ["7:before", "backed-up", true],
  ] as const)(
    "§7.2-4 kill -9 at %s (%s): status shows it, --resume refuses 76, --abort restores the source and sets the vault aside",
    async (at, phase, renamed) => {
      const f = makeFixture(T);
      await killAt(f, at);
      const P = paths(f.h);
      expect(JSON.parse(readFileSync(join(P.txn, "convert-proj.json"), "utf8")).phase).toBe(phase);
      expect(existsSync(f.proj)).toBe(!renamed);
      expect(backupsOf(f.h).length).toBe(renamed ? 1 : 0);
      const st = plain(f.e, "status");
      expect(st.text).toContain(`convert proj: interrupted (${phase})`);
      expect(st.text).toContain(`  pending: convert:`);
      const res = plain(f.e, `convert --resume proj ${resumeArgs}`);
      expect(res.code, res.text).toBe(76);
      expect(res.text).toContain(`转换停在 ${phase} 阶段`);
      const ab = plain(f.e, `convert --abort proj ${resumeArgs}`, 120_000);
      expect(ab.code, ab.text).toBe(1);
      expectRolledBack(f, { vault: "aborted" });
      expect(plain(f.e, "status").text).toMatch(/aborted: .*proj\.aborted-[0-9a-f]+/);
    },
    240_000,
  );

  it("§7.2-4 kill -9 at synced: --resume (interactive confirmation, no flag) completes link + commit; then --abort refuses", async () => {
    const f = makeFixture(T);
    await killAt(f, "12:before");
    const P = paths(f.h);
    expect(JSON.parse(readFileSync(join(P.txn, "convert-proj.json"), "utf8")).phase).toBe("synced");
    expect(plain(f.e, "status").text).toContain("convert proj: interrupted (synced)");
    const res = await T.tty(f.e, "convert --resume proj", {}, { answers: confirmAnswers("proj"), cwd: f.h });
    expect(res.code, res.text).toBe(0);
    expect(readlinkSync(f.proj)).toBe(join(f.mnt, "work"));
    expect(vaultsOf(f.h).proj.pending).toBeUndefined();
    expect(vaultsOf(f.h).proj.origin).toBe(f.proj);
    expect(existsSync(join(P.txn, "convert-proj.json"))).toBe(false);
    const [bk] = backupsOf(f.h);
    expect(noW(snapshot(join(f.h, bk!)))).toEqual(noW(f.control));
    for (const o of f.oldFacts) expect(fact(o.path)).toEqual(o);
    const ab = plain(f.e, `convert --abort proj ${resumeArgs}`);
    expect(ab.code, ab.text).toBe(66); // no unfinished conversion left to abort
    expect(lstatSync(f.proj).isSymbolicLink()).toBe(true);
  }, 240_000);

  it("§7.2-4 kill -9 at linked: --abort removes our link, restores the source, sets the vault aside", async () => {
    const f = makeFixture(T);
    await killAt(f, "13:after");
    const P = paths(f.h);
    expect(JSON.parse(readFileSync(join(P.txn, "convert-proj.json"), "utf8")).phase).toBe("linked");
    expect(lstatSync(f.proj).isSymbolicLink()).toBe(true);
    const ab = plain(f.e, `convert --abort proj ${resumeArgs}`, 120_000);
    expect(ab.code, ab.text).toBe(1);
    expectRolledBack(f, { vault: "aborted" });
  }, 240_000);

  it("§7.2-4 kill -9 after the commit: --abort refuses 76 (backup named), --resume only cleans up", async () => {
    const f = makeFixture(T);
    await killAt(f, "14:after");
    const P = paths(f.h);
    expect(existsSync(join(P.txn, "convert-proj.json"))).toBe(true);
    expect(vaultsOf(f.h).proj.pending).toBeUndefined();
    const ab = plain(f.e, `convert --abort proj ${resumeArgs}`);
    expect(ab.code, ab.text).toBe(76);
    expect(ab.text).toContain("不能撤销");
    expect(lstatSync(f.proj).isSymbolicLink()).toBe(true);
    const res = plain(f.e, `convert --resume proj ${resumeArgs}`, 120_000);
    expect(res.code, res.text).toBe(0);
    expect(existsSync(join(P.txn, "convert-proj.json"))).toBe(false);
    expect(backupsOf(f.h).length).toBe(1);
  }, 240_000);

  it("§7.2-4 rollback while the new vault is busy: --abort restores the source but keeps the vault (74), a second --abort finishes", async () => {
    const f = makeFixture(T);
    await killAt(f, "12:before");
    const P = paths(f.h);
    // the stale gocryptfs daemon keeps the vault mounted; a token-marked process sits inside it
    expect(globalMounted(f.mnt)).toBe(true);
    const holder = spawn("sleep", ["300"], { cwd: join(f.mnt, "work"), env: T.env(), stdio: "ignore" });
    T.track(holder.pid!);
    await sleep(200);
    const ab1 = plain(f.e, `convert --abort proj ${resumeArgs}`, 120_000);
    expect(ab1.code, ab1.text).toBe(74);
    expect(ab1.text).toContain("回滚不完整（状态文件与恢复记录已保留）");
    expect(ab1.text).toContain("新库仍挂载");
    expect(lstatSync(f.proj).isDirectory()).toBe(true); // the source is back first
    expect(snapshot(f.proj)).toEqual(f.control);
    expect(existsSync(P.dir("proj"))).toBe(true); // vault kept, never deleted
    expect(existsSync(join(P.txn, "convert-proj.json"))).toBe(true);
    holder.kill("SIGKILL");
    await new Promise((r) => holder.on("exit", r));
    const ab2 = plain(f.e, `convert --abort proj ${resumeArgs}`, 120_000);
    expect(ab2.code, ab2.text).toBe(1);
    expectRolledBack(f, { vault: "aborted" });
  }, 240_000);

  it("--resume/--abort without a TTY and without --assume-unreadable-idle: refused 75 when uninspectable same-uid processes exist", async () => {
    const f = makeFixture(T);
    await killAt(f, "7:before");
    const r = plain(f.e, "convert --abort proj", 120_000);
    if (r.code === 75) {
      expect(r.text).toContain("--assume-unreadable-idle");
      expect(existsSync(f.proj)).toBe(false); // nothing was rolled back yet
      expect(backupsOf(f.h).length).toBe(1);
    } else expect(r.code, r.text).toBe(1); // this machine has no uninspectable processes
    const ab = plain(f.e, `convert --abort proj ${resumeArgs}`, 120_000);
    expect([0, 1, 66]).toContain(ab.code);
    expectRolledBack(f, { vault: "aborted" });
  }, 240_000);

  // ───────────────────────────── §7.2-5 ─────────────────────────────

  it("§7.2-5 backup modified before step 12 ⇒ re-verification fails ⇒ rollback; the write survives in the restored source", async () => {
    const f = makeFixture(T);
    const run = convertTty(T, f, "proj", { PI_SECURE_TEST_SEAMS: "1", PI_SECURE_TEST_CONVERT_STOP_AT: "12:before" });
    const pid = await waitStopped(T);
    const [bk] = backupsOf(f.h);
    const victim = join(f.h, bk!, "README.md");
    chmodSync(victim, 0o644);
    writeFileSync(victim, "# changed during the conversion\n");
    process.kill(pid, "SIGCONT");
    const r = await run;
    expect(r.code, r.text).toBe(74);
    expect(r.text).toContain("备份在转换期间被改动");
    expect(readFileSync(join(f.proj, "README.md"), "utf8")).toBe("# changed during the conversion\n");
    const { ["README.md"]: _now, ...rest } = snapshot(f.proj);
    const { ["README.md"]: _ctl, ...ctlRest } = f.control as Record<string, unknown>;
    expect(rest).toEqual(ctlRest);
    expect(vaultsOf(f.h).proj).toBeUndefined();
    expect(abortedOf(paths(f.h).share, "proj").length).toBe(1);
  }, 240_000);

  // ───────────────────────────── §7.2-6 ─────────────────────────────

  async function expectRefused(f: Fixture, args: string, code: number, text: RegExp) {
    const before = snapshot(f.proj);
    const r = await convertTty(T, f, args);
    expect(r.code, r.text).toBe(code);
    expect(r.text).toMatch(text);
    expect(r.text).not.toMatch(/Password:/); // refused before any password prompt
    expect(snapshot(f.proj)).toEqual(before);
    expect(backupsOf(f.h)).toEqual([]);
    expect(vaultsOf(f.h).proj).toBeUndefined();
    expect(existsSync(paths(f.h).dir("proj"))).toBe(false);
    return r;
  }

  /** A group-writable (0775) directory owned by us, under a token-marked /tmp scratch dir. */
  function groupWritableDir(): string {
    const gw = join(T.tmp("ps-v8gw-"), "gw");
    mkdirSync(gw, { mode: 0o700 });
    chmodSync(gw, 0o775);
    return gw;
  }

  it("V8: convert with a group-writable mount-point ancestor ⇒ 78 before the name confirmation and any password; nothing changes", async () => {
    const f = makeFixture(T, { sessions: false });
    const gw = groupWritableDir();
    const before = snapshot(f.proj);
    const r = await T.tty(
      f.e,
      `convert proj --path ${join(gw, "proj")}`,
      {},
      {
        cwd: f.h,
        answers: confirmAnswers("proj"),
        killAfterMs: 60_000,
      },
    );
    expect(r.code, r.text).toBe(78);
    expect(r.text).toContain("挂载点祖先目录检查失败：");
    expect(r.text).toContain(`${gw} 对组/其他可写且无 sticky 位`);
    expect(r.text).not.toContain("确认请输入保险库名");
    expect(r.text).not.toContain("继续？"); // not even the uninspectable-process confirmation
    expect(r.text).not.toMatch(/Password:/);
    expect(snapshot(f.proj)).toEqual(before);
    expect(backupsOf(f.h)).toEqual([]);
    expect(vaultsOf(f.h).proj).toBeUndefined();
    expect(existsSync(paths(f.h).dir("proj"))).toBe(false);
    expect(existsSync(join(gw, "proj"))).toBe(false);
    expect(existsSync(join(paths(f.h).txn, "convert-proj.json"))).toBe(false);
    // the same location made compliant ⇒ the very same command gets past step 0 (to the confirmation)
    chmodSync(gw, 0o755);
    const ok = await T.tty(
      f.e,
      `convert proj --path ${join(gw, "proj")}`,
      {},
      {
        cwd: f.h,
        answers: [
          [/确认请输入保险库名 proj：/, "no"],
          [/继续？\[y\/N\]/, "y"],
        ],
        killAfterMs: 60_000,
      },
    );
    expect(ok.code, ok.text).toBe(1);
    expect(ok.text).toContain("已取消，未做任何修改");
    expect(snapshot(f.proj)).toEqual(before);
  }, 240_000);

  it("V8: import with a group-writable mount-point ancestor ⇒ 78 before the claim and before any password (plain and --verify-password)", async () => {
    const a = filledAcme();
    const P = paths(a.h);
    const pkg = join(a.e.r, "acme.tar");
    expect(plain(a.e, `export acme ${pkg}`, 120_000).code).toBe(0);
    const gw = groupWritableDir();
    const untouched = (name: string) => {
      expect(vaultsOf(a.h)[name]).toBeUndefined();
      expect(existsSync(P.dir(name))).toBe(false);
      expect(readdirSync(P.share).filter((n) => n.includes(`.${name}.import-`))).toEqual([]);
      expect(existsSync(join(P.txn, `import-${name}.json`))).toBe(false);
      expect(existsSync(join(gw, name))).toBe(false);
    };
    const im = plain(a.e, `import ${pkg} theta --path ${join(gw, "theta")}`, 60_000);
    expect(im.code, im.text).toBe(78);
    expect(im.text).toContain("挂载点祖先目录检查失败：");
    expect(im.text).toContain(`${gw} 对组/其他可写且无 sticky 位`);
    untouched("theta");
    const vp = await T.tty(
      a.e,
      `import ${pkg} iota --path ${join(gw, "iota")} --verify-password`,
      {},
      {
        killAfterMs: 60_000,
      },
    );
    expect(vp.code, vp.text).toBe(78);
    expect(vp.text).toContain("挂载点祖先目录检查失败：");
    expect(vp.text).not.toMatch(/Password:/);
    untouched("iota");
    expect(vaultsOf(a.h).acme).toEqual({}); // the source vault is untouched
  }, 300_000);

  it("§7.2-6 refusals before any change: occupied 76, $HOME/.config 65, xattr 65, setgid 65, escaping link 65, alternates 65; no TTY 2", async () => {
    const f = makeFixture(T, { sessions: false });
    // no TTY ⇒ 2, nothing touched
    const nt = plain(f.e, "convert proj");
    expect(nt.code, nt.text).toBe(2);
    // occupied (a token-marked process with cwd inside) ⇒ 76, no password prompt
    const occ = spawn("sleep", ["300"], { cwd: join(f.proj, "sub"), env: T.env(), stdio: "ignore" });
    T.track(occ.pid!);
    await sleep(200);
    await expectRefused(f, "proj", 76, /占用/);
    occ.kill("SIGKILL");
    await new Promise((r) => occ.on("exit", r));
    // escaping relative symlink
    symlinkSync("../../outside", join(f.proj, "sub", "escape"));
    await expectRefused(f, "proj", 65, /escape/);
    spawnSync("rm", ["--", join(f.proj, "sub", "escape")]);
    // setgid directory
    chmodSync(join(f.proj, "empty"), 0o2755);
    await expectRefused(f, "proj", 65, /empty/);
    chmodSync(join(f.proj, "empty"), 0o755);
    // user xattr (if the filesystem supports it)
    const xa = spawnSync("python3", [
      "-c",
      `import os; os.setxattr(${JSON.stringify(join(f.proj, "a.txt"))}, "user.e2e", b"1")`,
    ]);
    if (xa.status === 0) {
      await expectRefused(f, "proj", 65, /xattr|扩展属性/);
      spawnSync("python3", ["-c", `import os; os.removexattr(${JSON.stringify(join(f.proj, "a.txt"))}, "user.e2e")`]);
    }
    // git alternates outside the tree
    mkdirSync(join(f.h, "objs"), { recursive: true });
    writeFileSync(join(f.proj, ".git", "objects", "info", "alternates"), `${join(f.h, "objs")}\n`);
    await expectRefused(f, "proj", 65, /alternates/);
    spawnSync("rm", ["--", join(f.proj, ".git", "objects", "info", "alternates")]);
    // source under $HOME/.config
    const cfg = join(f.h, ".config", "proj2");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "x"), "x");
    const rc = await T.tty(f.e, "convert .config/proj2", {}, { cwd: f.h, answers: confirmAnswers("proj2") });
    expect(rc.code, rc.text).toBe(65);
    expect(rc.text).toContain("$HOME/.*");
    expect(readFileSync(join(cfg, "x"), "utf8")).toBe("x");
    // after removing every problem the same tree converts fine (the refusals were the only blockers)
    const ok = await convertTty(T, f, "proj");
    expect(ok.code, ok.text).toBe(0);
  }, 300_000);

  it("§7.2-6 a mount inside the tree ⇒ 65; a POSIX ACL ⇒ 65 (both before any change)", async () => {
    const f = makeFixture(T, { sessions: false });
    // a (test-side, passfile) gocryptfs mount inside the source tree stands in for a bind mount:
    // the rule is "no mount inside the tree" (mountinfo), whatever its type
    const c = join(f.e.r, "inner-cipher");
    mkdirSync(c, { mode: 0o700 });
    const pf = join(f.e.r, "pf");
    expect(spawnSync("gocryptfs", ["-init", "-q", "-scryptn", "10", "-passfile", pf, "--", c]).status).toBe(0);
    const m = join(f.proj, "sub", "m");
    mkdirSync(m);
    expect(spawnSync("gocryptfs", ["-q", "-passfile", pf, "--", c, m], { env: f.e.env }).status).toBe(0);
    try {
      await expectRefused(f, "proj", 65, /sub\/m/);
    } finally {
      spawnSync("fusermount3", ["-u", m]);
    }
    rmdirSync(m);
    // a POSIX access ACL written as the raw system.posix_acl_access xattr (setfacl not required):
    // v2 header + USER_OBJ rw, USER(uid) r, GROUP_OBJ r, MASK r, OTHER r
    const target = JSON.stringify(join(f.proj, "README.md"));
    const acl = [
      "import os, struct",
      "e = lambda tag, perm, i: struct.pack('<HHI', tag, perm, i & 0xffffffff)",
      "v = struct.pack('<I', 2) + e(1, 6, -1) + e(2, 4, os.getuid()) + e(4, 4, -1) + e(0x10, 4, -1) + e(0x20, 4, -1)",
      `os.setxattr(${target}, 'system.posix_acl_access', v)`,
    ].join("\n");
    const set = spawnSync("python3", ["-c", acl], { encoding: "utf8" });
    if (set.status === 0) {
      await expectRefused(f, "proj", 65, /posix_acl_access|xattr|扩展属性/);
      spawnSync("python3", ["-c", `import os; os.removexattr(${target}, 'system.posix_acl_access')`]);
    }
    const ok = await convertTty(T, f, "proj");
    expect(ok.code, ok.text).toBe(0);
  }, 300_000);

  it("§7.2-6 the backup name is taken right before the rename ⇒ the rename is judged failed, 65, source untouched", async () => {
    const f = makeFixture(T, { sessions: false });
    let live = "";
    const run = convertTty(
      T,
      f,
      "proj",
      { PI_SECURE_TEST_SEAMS: "1", PI_SECURE_TEST_CONVERT_STOP_AT: "3:before" },
      { onText: (t) => (live = t) },
    );
    const pid = await waitStopped(T);
    const bk = /原目录将改名为只读备份：(\S+?)（/.exec(live.replace(/\r/g, ""))?.[1] ?? "";
    expect(bk).toMatch(/proj\.pi-secure-backup-/);
    mkdirSync(bk); // an empty directory with exactly that name (mv -n -T would exit 0 without moving)
    process.kill(pid, "SIGCONT");
    const r = await run;
    expect(r.code, r.text).toBe(65);
    expect(r.text).toContain("改名为备份失败");
    expect(readdirSync(bk)).toEqual([]); // not replaced, nothing moved into it
    rmdirSync(bk); // our own squatter
    expectRolledBack(f, { vault: "aborted" });
  }, 240_000);

  it.skipIf(REAL_GETFATTR)(
    "§7.2-6 getfattr missing ⇒ 69 before any change",
    async () => {
      const f = makeFixture(T, { sessions: false });
      spawnSync("rm", ["--", join(f.e.r, "bin", "getfattr")]);
      const before = snapshot(f.proj);
      const r = await convertTty(T, f, "proj");
      expect(r.code, r.text).toBe(69);
      expect(r.text).toContain("getfattr");
      expect(snapshot(f.proj)).toEqual(before);
      expect(vaultsOf(f.h).proj).toBeUndefined();
    },
    120_000,
  );

  // ───────────────────────────── §7.2-7 ─────────────────────────────

  it("§7.2-7 original path re-created between steps 12 and 13 ⇒ not overwritten, 76, state kept; after removing it --resume completes", async () => {
    const f = makeFixture(T);
    const run = convertTty(T, f, "proj", { PI_SECURE_TEST_SEAMS: "1", PI_SECURE_TEST_CONVERT_STOP_AT: "12:after" });
    const pid = await waitStopped(T);
    mkdirSync(f.proj);
    writeFileSync(join(f.proj, "squatter"), "not ours\n");
    process.kill(pid, "SIGCONT");
    const r = await run;
    expect(r.code, r.text).toBe(76);
    expect(readFileSync(join(f.proj, "squatter"), "utf8")).toBe("not ours\n");
    const P = paths(f.h);
    expect(JSON.parse(readFileSync(join(P.txn, "convert-proj.json"), "utf8")).phase).toBe("synced");
    expect(plain(f.e, "status").text).toContain("convert proj: interrupted (synced)");
    spawnSync("rm", ["-r", "--", f.proj]);
    const res = plain(f.e, `convert --resume proj ${resumeArgs}`, 120_000);
    expect(res.code, res.text).toBe(0);
    expect(readlinkSync(f.proj)).toBe(join(f.mnt, "work"));
    expect(noW(snapshot(join(f.h, backupsOf(f.h)[0]!)))).toEqual(noW(f.control));
  }, 240_000);

  // ───────────────────────────── V7 security review M1 / M2 ─────────────────────────────

  async function pauseThenContinue(f: Fixture, at: string, change: boolean) {
    let live = "";
    const run = convertTty(
      T,
      f,
      "proj",
      { PI_SECURE_TEST_SEAMS: "1", PI_SECURE_TEST_CONVERT_STOP_AT: at },
      {
        onText: (t) => (live = t),
      },
    );
    const pid = await waitStopped(T);
    expect(live).toContain(`!!! 测试缝已启用：convert 将在第 ${at.split(":")[0]} 步（${at.split(":")[1]}）暂停`);
    // the notice is written right before the self-SIGSTOP; the pty may deliver it a moment after the
    // stop is observable — give the reader a bounded grace instead of racing it
    const notice = `测试缝：convert 在第 ${at.split(":")[0]} 步（${at.split(":")[1]}）暂停（pid ${pid}）`;
    for (let t0 = Date.now(); !live.includes(notice) && Date.now() - t0 < 3_000;) await sleep(50);
    expect(live).toContain(notice);
    if (change) {
      const victim = join(f.h, backupsOf(f.h)[0]!, "README.md");
      chmodSync(victim, 0o644);
      writeFileSync(victim, "# changed while the convert was paused\n");
    }
    await sleep(5_600); // > STALE_EVIDENCE_MS: the step-12 evidence is now stale
    process.kill(pid, "SIGCONT");
    return run;
  }

  it("M2: paused at 12:after >5 s, backup changed ⇒ re-verified before step 13 ⇒ rolled back, never success, source intact", async () => {
    const f = makeFixture(T);
    const r = await pauseThenContinue(f, "12:after", true);
    expect(r.code, r.text).toBe(74);
    expect(r.text).toContain("第 13 步之前重新复核备份");
    expect(r.text).toContain("备份在转换期间被改动");
    expect(r.text).not.toContain("完成：");
    expect(lstatSync(f.proj).isDirectory()).toBe(true);
    expect(readFileSync(join(f.proj, "README.md"), "utf8")).toBe("# changed while the convert was paused\n");
    const { ["README.md"]: _a, ...rest } = snapshot(f.proj);
    const { ["README.md"]: _b, ...ctl } = f.control as Record<string, unknown>;
    expect(rest).toEqual(ctl);
    expect(vaultsOf(f.h).proj).toBeUndefined();
    for (const o of f.oldFacts) expect(fact(o.path)).toEqual(o);
  }, 240_000);

  it("M2: paused at 13:after (link built) >5 s, backup changed ⇒ re-verified before the commit ⇒ link removed, rolled back", async () => {
    const f = makeFixture(T);
    const r = await pauseThenContinue(f, "13:after", true);
    expect(r.code, r.text).toBe(74);
    expect(r.text).toContain("第 14 步之前重新复核备份");
    expect(r.text).not.toContain("完成：");
    expect(lstatSync(f.proj).isDirectory()).toBe(true);
    expect(readFileSync(join(f.proj, "README.md"), "utf8")).toBe("# changed while the convert was paused\n");
    expect(vaultsOf(f.h).proj).toBeUndefined();
  }, 240_000);

  it("M2: paused at 12:after >5 s with NO change ⇒ re-verification passes ⇒ success", async () => {
    const f = makeFixture(T);
    const r = await pauseThenContinue(f, "12:after", false);
    expect(r.code, r.text).toBe(0);
    expect(r.text).toContain("第 13 步之前重新复核备份");
    expect(readlinkSync(f.proj)).toBe(join(f.mnt, "work"));
    expect(noW(snapshot(join(f.h, backupsOf(f.h)[0]!)))).toEqual(noW(f.control));
  }, 240_000);

  it("M1: STOP/FAIL seams WITHOUT PI_SECURE_TEST_SEAMS=1 are ignored with a warning — the convert runs normally", async () => {
    const f = makeFixture(T, { sessions: false });
    const r = await convertTty(T, f, "proj", {
      PI_SECURE_TEST_CONVERT_STOP_AT: "3:before",
      PI_SECURE_TEST_CONVERT_FAIL_AT: "7:after",
    });
    expect(r.code, r.text).toBe(0);
    expect(r.text).toContain(
      "检测到测试用环境变量 PI_SECURE_TEST_CONVERT_FAIL_AT、PI_SECURE_TEST_CONVERT_STOP_AT，已忽略（测试缝只在 PI_SECURE_TEST_SEAMS=1 时生效）",
    );
    expect(r.text).not.toContain("测试缝已启用");
    expect(r.text).not.toContain("暂停");
    expect(r.text).not.toContain("注入失败");
    expect(lstatSync(f.proj).isSymbolicLink()).toBe(true);
  }, 240_000);

  it("M1: the gate alone warns; status warns whenever any test variable is present (absent ⇒ no line)", () => {
    const f = makeFixture(T, { sessions: false });
    const run = (extra: Record<string, string>) =>
      spawnSync("sh", ["-c", `exec ${BIN} status </dev/null`], { env: { ...f.e.env, ...extra }, encoding: "utf8" });
    const clean = run({});
    expect(clean.status).toBe(0);
    expect(`${clean.stdout}${clean.stderr}`).not.toContain("测试");
    const gate = run({ PI_SECURE_TEST_SEAMS: "1" });
    expect(gate.status).toBe(0);
    expect(gate.stderr).toContain("检测到测试用环境变量 PI_SECURE_TEST_SEAMS，已忽略（没有设置任何测试缝）");
    expect(gate.stdout).toContain("warn: 测试用环境变量已设置：PI_SECURE_TEST_SEAMS（已忽略）");
    const lone = run({ PI_SECURE_TEST_CONVERT_STOP_AT: "3:before" });
    expect(lone.stderr).toContain("检测到测试用环境变量 PI_SECURE_TEST_CONVERT_STOP_AT，已忽略");
    expect(lone.stdout).toContain("warn: 测试用环境变量已设置：PI_SECURE_TEST_CONVERT_STOP_AT（已忽略）");
    const both = run({ PI_SECURE_TEST_SEAMS: "1", PI_SECURE_TEST_CONVERT_STOP_AT: "3:before" });
    expect(both.stderr).toContain("测试缝已启用（仅供测试，切勿用于真实数据）：PI_SECURE_TEST_CONVERT_STOP_AT");
    expect(both.stdout).toContain(
      "warn: 测试用环境变量已设置：PI_SECURE_TEST_CONVERT_STOP_AT、PI_SECURE_TEST_SEAMS（测试缝已启用）",
    );
  }, 120_000);

  // ───────────────────────────── §7.2-8 ─────────────────────────────

  /** A new-layout vault `acme` (passfile-initialised by the harness) filled through a test-side mount. */
  function filledAcme(): { e: Env; h: string; content: Record<string, unknown> } {
    const e = T.setup(); // under /tmp: import's default ~/secure/<名字> needs clean mount-point ancestors
    withGetfattr(e);
    const P = paths(e.h);
    const content = look(e, P.dir("acme"), (root) => {
      const w = join(root, "work");
      // the unmounted mnt holds sentinels; the test mount sees an empty plaintext root
      mkdirSync(join(w, "d"), { recursive: true });
      writeFileSync(join(w, "d", "f.txt"), "payload\n");
      linkSync(join(w, "d", "f.txt"), join(w, "hard"));
      symlinkSync("d/f.txt", join(w, "rel"));
      symlinkSync("/etc/hostname", join(w, "abs"));
      writeFileSync(join(w, `${"N".repeat(190)}`), "long\n");
      mkdirSync(join(root, "state", "sessions", "default"), { recursive: true });
      writeFileSync(
        join(root, "state", "sessions", "default", "s.jsonl"),
        JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: join(P.mnt("acme"), "work") }) +
          "\n",
      );
      return snapshot(w, true);
    });
    return { e, h: e.h, content };
  }
  /** inode numbers differ by construction; the root dir mtime and `.pi/` change with the relocation. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const comparable = (s: Record<string, any>) =>
    Object.fromEntries(
      Object.entries(s)
        .filter(([k]) => k !== ".pi" && !k.startsWith(".pi/"))
        // mtimes: restored through Node's utimes (a double of seconds ⇒ ≈0.25 µs resolution at
        // today's epoch), so compare at 1 µs; the root dir mtime moves with the relocation
        .map(([k, v]) => [k, { ...v, ino: undefined, mtimeMs: undefined }]),
    );

  it("§7.2-8 export → import --verify-password: tar -tf lists it; contents identical; relocation done; run works", async () => {
    const a = filledAcme();
    const P = paths(a.h);
    const pkg = join(a.e.r, "acme.tar");
    const ex = plain(a.e, `export acme ${pkg}`, 120_000);
    expect(ex.code, ex.text).toBe(0);
    const lst = spawnSync("tar", ["-tf", pkg], { encoding: "utf8" });
    expect(lst.status).toBe(0);
    expect(lst.stdout).toContain("pi-secure-vault/MANIFEST.json");
    expect(lst.stdout).toContain("pi-secure-vault/cipher/gocryptfs.conf");
    const im = await T.tty(a.e, `import ${pkg} beta --verify-password`, {}, { killAfterMs: 150_000 });
    expect(im.code, im.text).toBe(0);
    expect(vaultsOf(a.h).beta).toEqual({ dir: P.dir("beta"), mnt: P.mnt("beta") });
    look(a.e, P.dir("beta"), (root) => {
      const now = snapshot(join(root, "work"), true);
      expect(comparable(now)).toEqual(comparable(a.content));
      for (const [k, v] of Object.entries(a.content) as Array<[string, { mtimeMs: number }]>)
        if (k !== "." && !k.startsWith(".pi"))
          expect(Math.abs((now[k] as { mtimeMs: number }).mtimeMs - v.mtimeMs), k).toBeLessThan(0.002);
      // hardlink group preserved
      expect(statSync(join(root, "work", "hard")).ino).toBe(statSync(join(root, "work", "d", "f.txt")).ino);
      // session headers relocated to beta's work
      const hdr = JSON.parse(
        readFileSync(join(root, "state", "sessions", "default", "s.jsonl"), "utf8").split("\n")[0]!,
      );
      expect(hdr.cwd).toBe(join(P.mnt("beta"), "work"));
    });
    const run = await T.tty(a.e, "run beta");
    expect(run.code, run.text).toBe(0);
    // the source vault is untouched by the export (still registered, cipher intact)
    expect(vaultsOf(a.h).acme).toEqual({});
  }, 300_000);

  it("§7.2-8 import without --verify-password ⇒ run 78; init --fix-settings relocates; --path honoured; then run works", async () => {
    const a = filledAcme();
    const P = paths(a.h);
    const pkg = join(a.e.r, "acme.tar");
    expect(plain(a.e, `export acme ${pkg}`, 120_000).code).toBe(0);
    const at = join(a.h, "elsewhere", "gamma");
    mkdirSync(join(a.h, "elsewhere"), { mode: 0o700 });
    const im = plain(a.e, `import ${pkg} gamma --path ${at}`, 120_000);
    expect(im.code, im.text).toBe(0);
    expect(im.text).toContain("--fix-settings");
    expect(vaultsOf(a.h).gamma.mnt).toBe(at);
    expect(vaultsOf(a.h).gamma.relocate.phase).toBe("pending");
    const st = plain(a.e, "status");
    expect(st.text).toMatch(/gamma:[^\n]*\n(?:[^\n]*\n)*?\s+relocate: pending \(pending\)/);
    const run1 = await T.tty(a.e, "run gamma");
    expect(run1.code, run1.text).toBe(78);
    expect(plain(a.e, `export gamma ${join(a.e.r, "g.tar")}`).code).toBe(78);
    const fx = await T.tty(a.e, "init gamma --fix-settings", {}, { killAfterMs: 150_000 });
    expect(fx.code, fx.text).toBe(0);
    expect(vaultsOf(a.h).gamma.relocate).toBeUndefined();
    look(a.e, P.dir("gamma"), (root) => {
      const hdr = JSON.parse(
        readFileSync(join(root, "state", "sessions", "default", "s.jsonl"), "utf8").split("\n")[0]!,
      );
      expect(hdr.cwd).toBe(join(at, "work"));
    });
    const run2 = await T.tty(a.e, "run gamma");
    expect(run2.code, run2.text).toBe(0);
  }, 300_000);

  it("§7.2-8 private vault: import, mark private, init --fix-settings relocates inside the private namespace", async () => {
    const a = filledAcme();
    const P = paths(a.h);
    const pkg = join(a.e.r, "acme.tar");
    expect(plain(a.e, `export acme ${pkg}`, 120_000).code).toBe(0);
    expect(plain(a.e, `import ${pkg} delta`, 120_000).code).toBe(0);
    const s = JSON.parse(readFileSync(P.settings, "utf8"));
    s.secure.vaults.delta.private = true;
    writeFileSync(P.settings, JSON.stringify(s));
    const fx = await T.tty(a.e, "init delta --fix-settings", {}, { killAfterMs: 150_000 });
    expect(fx.code, fx.text).toBe(0);
    expect(fx.text).toContain("在私有命名空间内迁址");
    expect(vaultsOf(a.h).delta).toEqual({ dir: P.dir("delta"), mnt: P.mnt("delta"), private: true });
    expect(globalMounted(P.mnt("delta"))).toBe(false);
    look(a.e, P.dir("delta"), (root) => {
      const hdr = JSON.parse(
        readFileSync(join(root, "state", "sessions", "default", "s.jsonl"), "utf8").split("\n")[0]!,
      );
      expect(hdr.cwd).toBe(join(P.mnt("delta"), "work"));
    });
  }, 300_000);

  it("§7.2-8 export refusals: mounted ⇒ 76; unlock during a stalled export ⇒ 73 (no partial left behind)", async () => {
    const a = filledAcme();
    const pkg = join(a.e.r, "acme.tar");
    const un = await T.tty(a.e, "unlock acme");
    expect(un.code, un.text).toBe(0);
    const ex1 = plain(a.e, `export acme ${pkg}`);
    expect(ex1.code, ex1.text).toBe(76);
    expect(existsSync(pkg)).toBe(false);
    expect(plain(a.e, "lock acme").code).toBe(0);
    // stalled export holds mount.lock; a concurrent unlock gives up after its 10 s lock wait ⇒ 73
    const exp = spawn(BIN, ["export", "acme", pkg], {
      env: { ...a.e.env, PI_SECURE_TEST_SEAMS: "1", PI_SECURE_TEST_ARCHIVE_STALL_MS: "25000" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let expOut = "";
    exp.stdout.on("data", (b: Buffer) => (expOut += b.toString()));
    exp.stderr.on("data", (b: Buffer) => (expOut += b.toString()));
    await until(
      () => spawnSync("flock", ["-n", join(paths(a.h).dir("acme"), "mount.lock"), "true"]).status !== 0,
      15_000,
      "export holds mount.lock",
    );
    const un2 = await T.tty(a.e, "unlock acme", {}, { killAfterMs: 60_000 });
    expect(un2.code, un2.text).toBe(73);
    // NOTE (V7-report §open): plan G2 wanted 「挂载、卸载或导出」 here, but the frozen N0 golden pins this
    // wording (tests/fixtures/secure-launcher-off-golden.json) — left unchanged pending a ruling
    expect(un2.text).toContain("另一个 pi-secure 正在挂载或卸载（mount.lock 等待超时）");
    const code = await new Promise<number | null>((r) => exp.on("close", r));
    expect(code, expOut).toBe(0);
    expect(existsSync(pkg)).toBe(true);
    expect(readdirSync(a.e.r).filter((n) => n.includes(".partial-"))).toEqual([]);
  }, 300_000);

  it("§7.2-8 import --verify-password with a wrong password 3× ⇒ 77, the import itself is kept (registered, relocation pending)", async () => {
    const a = filledAcme();
    const P = paths(a.h);
    const pkg = join(a.e.r, "acme.tar");
    expect(plain(a.e, `export acme ${pkg}`, 120_000).code).toBe(0);
    const imw = await T.tty(
      a.e,
      `import ${pkg} zeta --verify-password`,
      {},
      {
        password: "WRONG-fake-password",
        killAfterMs: 150_000,
      },
    );
    expect(imw.code, imw.text).toBe(77);
    expect(imw.text.split("Password:").length - 1).toBe(3); // three attempts, then give up
    expect(imw.text).toContain("口令未验证");
    expect(vaultsOf(a.h).zeta.pending).toBeUndefined(); // committed: the import itself is kept
    expect(vaultsOf(a.h).zeta.relocate.phase).toBe("pending"); // nothing was rewritten
    expect(existsSync(join(P.dir("zeta"), "cipher", "gocryptfs.conf"))).toBe(true);
    expect(globalMounted(P.mnt("zeta"))).toBe(false);
    // with the right password the pending relocation completes
    const fx = await T.tty(a.e, "init zeta --fix-settings", {}, { killAfterMs: 150_000 });
    expect(fx.code, fx.text).toBe(0);
    expect(vaultsOf(a.h).zeta.relocate).toBeUndefined();
  }, 300_000);

  it("§7.2-8 relocation crashing midway ⇒ run/export refused (78) ⇒ init --fix-settings resumes and completes", async () => {
    const a = filledAcme();
    const P = paths(a.h);
    const pkg = join(a.e.r, "acme.tar");
    expect(plain(a.e, `export acme ${pkg}`, 120_000).code).toBe(0);
    expect(plain(a.e, `import ${pkg} eta`, 120_000).code).toBe(0);
    // relocation workers stall ⇒ kill -9 the launcher once a phase beyond "pending" is persisted
    const fx = T.tty(
      a.e,
      "init eta --fix-settings",
      { PI_SECURE_TEST_SEAMS: "1", PI_SECURE_TEST_ARCHIVE_STALL_MS: "20000" },
      { killAfterMs: 120_000 },
    );
    await until(() => vaultsOf(a.h).eta?.relocate?.phase === "sessions", 60_000, "relocation phase sessions");
    const pid = launcherPid(T, "--fix-settings");
    expect(pid).toBeDefined();
    process.kill(pid!, "SIGKILL");
    await fx;
    expect(vaultsOf(a.h).eta.relocate.phase).toBe("sessions");
    const st = plain(a.e, "status");
    expect(st.text).toContain("relocate: pending (sessions)");
    // the interrupted mount may still be up (stale daemon): unmount it the supported way first
    plain(a.e, "lock eta");
    expect((await T.tty(a.e, "run eta")).code).toBe(78);
    expect(plain(a.e, `export eta ${join(a.e.r, "e.tar")}`).code).toBe(78);
    const fx2 = await T.tty(a.e, "init eta --fix-settings", {}, { killAfterMs: 150_000 });
    expect(fx2.code, fx2.text).toBe(0);
    expect(vaultsOf(a.h).eta).toEqual({ dir: P.dir("eta"), mnt: P.mnt("eta") });
    look(a.e, P.dir("eta"), (root) => {
      const hdr = JSON.parse(
        readFileSync(join(root, "state", "sessions", "default", "s.jsonl"), "utf8").split("\n")[0]!,
      );
      expect(hdr.cwd).toBe(join(P.mnt("eta"), "work"));
    });
  }, 300_000);

  it("§7.2-8 import interrupted: status shows it; staged ⇒ --resume refuses, --abort removes only this import's artefacts", async () => {
    const a = filledAcme();
    const P = paths(a.h);
    const pkg = join(a.e.r, "acme.tar");
    expect(plain(a.e, `export acme ${pkg}`, 120_000).code).toBe(0);
    const before = readdirSync(P.share).sort();
    const im = spawn(BIN, ["import", pkg, "theta"], {
      env: { ...a.e.env, PI_SECURE_TEST_SEAMS: "1", PI_SECURE_TEST_ARCHIVE_STALL_MS: "30000" },
      stdio: "ignore",
    });
    const stateFile = join(P.txn, "import-theta.json");
    await until(() => JSON.parse(readFileSync(stateFile, "utf8")).phase === "staging", 30_000, "import staging");
    process.kill(im.pid!, "SIGKILL");
    await new Promise((r) => im.on("close", r));
    await sleep(500); // the worker's owner guard reaps its group
    const st = plain(a.e, "status");
    expect(st.text).toContain("import theta: interrupted (staging)");
    const res = plain(a.e, "import --resume theta");
    expect(res.code, res.text).toBe(1);
    const ab = plain(a.e, "import --abort theta", 60_000);
    expect(ab.code, ab.text).toBe(0);
    expect(vaultsOf(a.h).theta).toBeUndefined();
    expect(existsSync(stateFile)).toBe(false);
    expect(
      readdirSync(P.share)
        .filter((n) => n !== ".txn")
        .sort(),
    ).toEqual(before.filter((n) => n !== ".txn"));
    expect(readdirSync(P.txn).filter((n) => n.startsWith("import-theta") && n.endsWith(".json"))).toEqual([]);
    expect(existsSync(join(a.h, "secure", "theta"))).toBe(false);
    expect(existsSync(pkg)).toBe(true); // the package is never touched
  }, 300_000);

  it("§7.2-8 import interrupted during the post-publish sync ⇒ --resume refuses (not published), --abort undoes the whole import", async () => {
    const a = filledAcme();
    const P = paths(a.h);
    const pkg = join(a.e.r, "acme.tar");
    expect(plain(a.e, `export acme ${pkg}`, 120_000).code).toBe(0);
    const im = spawn(BIN, ["import", pkg, "iota"], {
      env: { ...a.e.env, PI_SECURE_TEST_SEAMS: "1", PI_SECURE_TEST_ARCHIVE_STALL_MS: "4000" },
      stdio: "ignore",
    });
    const stateFile = join(P.txn, "import-iota.json");
    // publish steps end with <mnt> + its sentinels; the stalled sync worker follows
    await until(
      () =>
        JSON.parse(readFileSync(stateFile, "utf8")).phase === "publishing" && existsSync(join(P.mnt("iota"), "state")),
      60_000,
      "import published",
    );
    process.kill(im.pid!, "SIGKILL"); // kill -9 while the sync worker stalls
    await new Promise((r) => im.on("close", r));
    await sleep(500);
    expect(vaultsOf(a.h).iota.pending).toMatch(/^import:/);
    expect(plain(a.e, "status").text).toContain("import iota: interrupted (publishing)");
    expect((await T.tty(a.e, "run iota")).code).toBe(76); // pending ⇒ refused
    const res = plain(a.e, "import --resume iota", 60_000);
    expect(res.code, res.text).toBe(1);
    expect(res.text).toContain("尚未发布完成");
    const ab = plain(a.e, "import --abort iota", 60_000);
    expect(ab.code, ab.text).toBe(0);
    expect(vaultsOf(a.h).iota).toBeUndefined();
    expect(existsSync(P.dir("iota"))).toBe(false);
    expect(existsSync(P.mnt("iota"))).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
    expect(existsSync(pkg)).toBe(true);
    // the source vault is untouched; a fresh import of the same package works
    expect(plain(a.e, `import ${pkg} iota`, 120_000).code).toBe(0);
  }, 300_000);

  // ───────────────────────────── §7.2-9 ─────────────────────────────

  it("§7.2-9 every malicious corpus package via the launcher ⇒ 65, zero residue, zero registration", () => {
    const e = T.setup([], { acme: false });
    withGetfattr(e);
    const P = paths(e.h);
    const corpus = join(e.r, "corpus");
    mkdirSync(corpus);
    const before = { share: readdirSync(P.share).sort(), secure: readdirSync(join(e.h, "secure")).sort() };
    const vaultsBefore = vaultsOf(e.h);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cases = (G.CASES as any[]).filter((c) => c.category !== "ok" && !c.budget);
    expect(cases.length).toBeGreaterThan(150);
    const bad: string[] = [];
    for (const c of cases) {
      const f = join(corpus, `${c.id}.tar`);
      writeFileSync(f, c.build());
      const r = plain(e, `import ${f} evil`, 30_000);
      if (r.code !== 65) bad.push(`${c.id}: ${r.code} ${r.text.slice(0, 200)}`);
    }
    expect(bad).toEqual([]);
    expect(readdirSync(P.share).sort()).toEqual(
      [...before.share, ".txn"].filter((v, i, a) => a.indexOf(v) === i).sort(),
    );
    expect(readdirSync(join(e.h, "secure")).sort()).toEqual(before.secure);
    expect(vaultsOf(e.h)).toEqual(vaultsBefore);
    expect(readdirSync(P.txn).filter((n) => n.endsWith(".json"))).toEqual([]);
  }, 600_000);
});
