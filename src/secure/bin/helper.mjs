// pi-secure helper — the Node half of the `pi-secure` launcher (docs/dev/data-encryption/plan.md §2,
// P1 + private-plan §L layout: metadata in `<dir>` (default ~/.local/share/pi-toolkit-secure/<name>/),
// mount point `~/secure/<name>/` with work/state sentinels; legacy entries are read-only compat).
// Plain ESM, ZERO dependencies beyond Node ≥22 built-ins; it is run straight from `src/` (git
// installs have no build step) and never imports the TypeScript plugin. The shared configuration /
// mount-state rules are re-implemented here on purpose and kept in lockstep with
// `src/secure/config.ts` by the parity fixture `tests/fixtures/secure-contract-parity.json`.
//
// Secrets: the vault password is typed by the user straight into gocryptfs (stdio inherited from
// the controlling TTY). This file never reads stdin, never takes a password argument, never logs.
//
// Every exported function is pure or takes its side effects as parameters so tests can drive it;
// the CLI dispatcher at the bottom only runs when this file is the process entry point.
import { spawn, spawnSync } from "node:child_process";
import { constants as fsc } from "node:fs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import tty from "node:tty";
import { fileURLToPath, pathToFileURL } from "node:url";

// ───────────────────────────── constants ─────────────────────────────

export const VAULT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const GOCRYPTFS_FSTYPE = "fuse.gocryptfs";
export const GOCRYPTFS_MIN = [1, 8];
export const STATE_SUBDIRS = ["sessions/default", "tmp", "bash-jobs", "workflows", "consult", "memory"];
export const FINALIZE_BUDGET_MS = 10_000;
export const HARD_EXIT_GRACE_MS = 500;
export const SCAN_MAX_MS = 3_000;
export const SCAN_MAX_ENTRIES = 4096;
export const LOCK_WAIT_S = 10;
export const PASSWORD_TRIES = 3;
export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const MOUNT_ATTEMPT_TIMEOUT_MS = 180_000; // a forgotten password prompt must not hold mount.lock forever
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/** Exit codes of `pi-secure` (documented in P1-report.md). `run` exits with pi's own code once pi ran. */
export const EXIT = Object.freeze({
  OK: 0,
  FAIL: 1,
  USAGE: 2,
  REFUSED_ARGS: 64,
  NOT_FOUND: 66,
  PREREQ: 69,
  LOCK_BUSY: 73,
  DEADLINE: 75,
  BUSY: 76,
  BAD_PASSWORD: 77,
  CONFIG: 78,
});
/** Internal codes between the outer launcher and the `__mount` child that runs under flock. */
const INNER_ALREADY = 20;
const FLOCK_TIMEOUT_CODE = 73;

// ───────────────────────────── settings contract (parity with src/secure/config.ts) ─────────────────────────────

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** `~/x` ⇒ resolve(home, x); absolute ⇒ resolve(p); anything else (incl. "~", "~user", relative, "") ⇒ undefined. */
export function expandSecurePath(raw, home) {
  if (typeof raw !== "string" || raw === "") return undefined;
  if (raw.startsWith("~/")) return path.resolve(home, raw.slice(2));
  if (raw.startsWith("/")) return path.resolve(raw);
  return undefined;
}

export function defaultVaultDir(name, home) {
  return path.join(home, ".local", "share", "pi-toolkit-secure", name);
}
export function defaultVaultMnt(name, home) {
  return path.join(home, "secure", name);
}

/** New layout (private-plan §L.1): the mount point IS `<mnt>` — no entry symlink. */
export function deriveVault(name, dir, mnt) {
  const state = path.join(mnt, "state");
  return {
    name,
    dir,
    mnt,
    cipher: path.join(dir, "cipher"),
    work: path.join(mnt, "work"),
    state,
    sessionDir: path.join(state, "sessions", "default"),
    lock: path.join(dir, "mount.lock"),
    lease: path.join(dir, "mount.lease"),
  };
}

/** Pre-L0 layout (§L.3, read-only compat): mount point `<dir>/mnt`, derived exactly as before.
 *  `legacyLink` keeps the old entry address (review L0 #3) for D4's known-address set. */
export function deriveLegacyVault(name, dir, legacyLink) {
  const mnt = path.join(dir, "mnt");
  const state = path.join(mnt, "state");
  return {
    name,
    dir,
    mnt,
    cipher: path.join(dir, "cipher"),
    work: path.join(mnt, "work"),
    state,
    sessionDir: path.join(state, "sessions", "default"),
    lock: path.join(dir, "mount.lock"),
    lease: path.join(dir, "mount.lease"),
    layout: "legacy",
    legacyLink,
  };
}

/** Default disk probe for §L.3 legacy recognition: true when `<dir>/mnt` is a directory. */
export function legacyMntDirProbe(mnt) {
  try {
    return fs.lstatSync(mnt).isDirectory();
  } catch {
    return false;
  }
}

/** Parse the WHOLE settings-file object (not just `secure`). Never throws. Same shape as config.ts. */
export function parseSecureConfig(settings, home, io) {
  if (!isPlainObject(settings) || !("secure" in settings) || settings.secure === undefined)
    return { present: false, enabled: true, valid: true, vaults: [], invalid: [] };
  const section = settings.secure;
  if (!isPlainObject(section))
    return { present: true, enabled: true, valid: false, vaults: [], invalid: [], error: "secure: not an object" };
  const enabled = typeof section.enabled === "boolean" ? section.enabled : true;
  const rawVaults = section.vaults;
  if (rawVaults === undefined) return { present: true, enabled, valid: true, vaults: [], invalid: [] };
  if (!isPlainObject(rawVaults))
    return {
      present: true,
      enabled,
      valid: false,
      vaults: [],
      invalid: [],
      error: "secure.vaults: not an object",
    };
  const vaults = [];
  const invalid = [];
  for (const name of Object.keys(rawVaults).sort()) {
    const entry = rawVaults[name];
    if (!VAULT_NAME_RE.test(name)) {
      invalid.push({ name, reason: "name" });
      continue;
    }
    if (!isPlainObject(entry)) {
      invalid.push({ name, reason: "entry" });
      continue;
    }
    const dir = entry.dir === undefined ? defaultVaultDir(name, home) : expandSecurePath(entry.dir, home);
    if (dir === undefined) {
      invalid.push({ name, reason: "dir" });
      continue;
    }
    const oldDefaultLink = defaultVaultMnt(name, home);
    // Legacy recognition (§L.3): a `link` key always means the pre-L0 layout; an entry without
    // `mnt` whose `<dir>/mnt` exists as a directory on disk does too. The link VALUE only feeds
    // D4's known-address set (review L0 #3), never validated as a vault.
    if (entry.link !== undefined) {
      vaults.push(deriveLegacyVault(name, dir, expandSecurePath(entry.link, home) ?? oldDefaultLink));
      continue;
    }
    const mntExplicit = entry.mnt !== undefined;
    const mnt = mntExplicit ? expandSecurePath(entry.mnt, home) : defaultVaultMnt(name, home);
    if (mnt === undefined) {
      invalid.push({ name, reason: "mnt" });
      continue;
    }
    if (!mntExplicit && (io?.legacyMntDir ?? legacyMntDirProbe)(path.join(dir, "mnt")) === true) {
      vaults.push(deriveLegacyVault(name, dir, oldDefaultLink));
      continue;
    }
    vaults.push(deriveVault(name, dir, mnt));
  }
  return { present: true, enabled, valid: true, vaults, invalid };
}

// ───────────────────────────── mountinfo (parity with src/secure/config.ts) ─────────────────────────────

/** Decode mountinfo octal escapes (`\040` space, `\011` tab, `\012` newline, `\134` backslash, any `\ooo`). */
export function decodeMountinfoField(field) {
  return field.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

export function parseMountinfo(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const sepAt = line.indexOf(" - ");
    if (sepAt < 0) continue;
    const pre = line.slice(0, sepAt).split(" ");
    const post = line.slice(sepAt + 3).split(" ");
    const mountPoint = pre[4];
    const fsType = post[0];
    const source = post[1];
    if (mountPoint === undefined || fsType === undefined || source === undefined) continue;
    out.push({ mountPoint: decodeMountinfoField(mountPoint), fsType, source: decodeMountinfoField(source) });
  }
  return out;
}

/** "mounted" | "absent" | "foreign" — the LAST line at realMnt decides (stacked mounts: the top one wins). */
export function vaultMountState(mountinfo, realMnt, realCipher) {
  let last;
  for (const e of parseMountinfo(mountinfo)) if (e.mountPoint === realMnt) last = e;
  if (!last) return "absent";
  return last.fsType === GOCRYPTFS_FSTYPE && last.source === realCipher ? "mounted" : "foreign";
}

export function pathWithin(p, root) {
  if (p === root) return true;
  const base = root.endsWith(path.sep) ? root : root + path.sep;
  return p.startsWith(base);
}

// ───────────────────────────── small fs helpers ─────────────────────────────

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * Physical path of `p` even when its tail does not exist (yet): realpath of the nearest existing
 * ancestor + the remaining components. Never throws (falls back to the lexical path).
 */
export function realpathNearest(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Real (physical) mnt / cipher paths (§L.1): `realMnt = join(realpath(dirname(mnt)), basename(mnt))` —
 * NEVER a realpath of the mount point itself (that would traverse or hang on a live/ENOTCONN
 * mount). Legacy vaults (§L.3) keep the old derivation `join(realDir, "mnt")`.
 */
export function physicalPaths(v, realDir) {
  if (realDir === undefined) {
    try {
      realDir = fs.realpathSync(v.dir);
    } catch {
      realDir = path.resolve(v.dir);
    }
  }
  if (v.layout === "legacy")
    return { realDir, realMnt: path.join(realDir, "mnt"), realCipher: path.join(realDir, "cipher") };
  let parent;
  try {
    parent = fs.realpathSync(path.dirname(v.mnt));
  } catch {
    parent = path.resolve(path.dirname(v.mnt));
  }
  return {
    realDir,
    realMnt: path.join(parent, path.basename(v.mnt)),
    realCipher: path.join(realDir, "cipher"),
  };
}

export const PROBE_MAX_MS = 2_000;

/**
 * "mounted" | "stale" (mountinfo says ours, but the mount root is dead — ENOTCONN) | "absent" |
 * "foreign" | "hung" (the probe did not finish before `deadline`).
 *
 * Security review #3: never blocks the main thread on the mount. The only IO under the mount (the
 * liveness readdir) runs in a SEPARATE child process that is SIGKILLed (whole process group) and
 * abandoned at `deadline` — so a wedged FUSE daemon can neither stall the event loop / hard-exit
 * timer nor park a libuv pool thread that process.exit would later have to join. The other two
 * reads (realpath of the vault dir, /proc/self/mountinfo) are outside the mount and still raced
 * against the deadline.
 */
export async function probeMountState(
  v,
  { deadline = Date.now() + PROBE_MAX_MS, readdirProbe = probeReaddirChild } = {},
) {
  const work = (async () => {
    const realDir = await fsp.realpath(v.dir).catch(() => path.resolve(v.dir));
    const { realMnt, realCipher } = physicalPaths(v, realDir);
    const mountinfo = await fsp.readFile("/proc/self/mountinfo", "utf8").catch(() => "");
    const st = vaultMountState(mountinfo, realMnt, realCipher);
    if (st !== "mounted") return st;
    // readdir, not stat: a dead FUSE daemon still answers stat of the mount root from cached
    // attributes, while any real lookup fails with ENOTCONN. The root only holds work/ + state/.
    const r = await readdirProbe(v.mnt, deadline);
    return r === "ok" ? "mounted" : r === "timeout" ? "hung" : "stale";
  })();
  const r = await deadlineRace(work, deadline).catch(() => "stale");
  return r === TIMEOUT ? "hung" : r;
}

/** readdir(dir) in a throw-away child process → "ok" | "error" | "timeout" (child KILLed, not awaited). */
export function probeReaddirChild(dir, deadline) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, ["-e", "require('node:fs').readdirSync(process.argv[1])", dir], {
        detached: true,
        stdio: "ignore",
        cwd: "/",
      });
    } catch {
      resolve("error");
      return;
    }
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(
      () => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* gone */
        }
        child.unref();
        finish("timeout");
      },
      Math.max(0, deadline - Date.now()),
    );
    timer.unref();
    child.on("error", () => finish("error"));
    child.on("close", (code) => finish(code === 0 ? "ok" : "error"));
  });
}

function writeFileAtomic(file, text, mode) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, mode);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmp, mode & 0o755);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

// ───────────────────────────── user settings file (~/.pi/agent/pi-subagent.json) ─────────────────────────────

export function homeDir() {
  return os.homedir();
}
export function settingsFilePath(home = homeDir()) {
  return path.join(home, ".pi", "agent", "pi-subagent.json");
}

/** {kind:"missing"} | {kind:"ok", value} | {kind:"error", message} */
export function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { kind: "missing" };
    return { kind: "error", message: `${file}: ${e && e.message}` };
  }
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch (e) {
    return { kind: "error", message: `${file}: invalid JSON (${e && e.message})` };
  }
}

export function loadSecureConfig(home = homeDir()) {
  const file = settingsFilePath(home);
  const r = readJsonFile(file);
  if (r.kind === "error") return { file, readError: r.message, cfg: parseSecureConfig(undefined, home) };
  return { file, cfg: parseSecureConfig(r.kind === "ok" ? r.value : undefined, home) };
}

export const SETTINGS_LOCK_NAME = ".pi-subagent.json.lock";
export const SETTINGS_LOCK_WAIT_S = 10;
export function settingsLockPath(home = homeDir()) {
  return path.join(path.dirname(settingsFilePath(home)), SETTINGS_LOCK_NAME);
}

/**
 * Mode for the rewritten settings file (security review #6): an existing REGULAR file keeps its
 * permission bits minus group/other write; a new file is 0600. Never derived from a symlink.
 */
export function settingsWriteMode(st) {
  if (!st) return 0o600;
  return (st.mode & 0o777 & ~0o022) | 0o600;
}

/** Throws unless `file` is absent or a regular file owned by us (no symlink, fifo, dir, …). */
export function assertWritableSettingsFile(file, uid = process.getuid()) {
  const st = lstatOrNull(file);
  if (!st) return undefined;
  if (st.isSymbolicLink())
    throw new Error(
      `拒绝改写设置文件：${file} 是符号链接（不会跟随或替换它）。请把 secure 段手工写进链接目标，或改用普通文件`,
    );
  if (!st.isFile()) throw new Error(`拒绝改写设置文件：${file} 不是普通文件`);
  if (st.uid !== uid) throw new Error(`拒绝改写设置文件：${file} 不属于当前用户`);
  return st;
}

/** Re-read → merge → write, all inside the settings lock (see withSettingsLock). */
export function registerVaultUnlocked(name, dir, mnt, home = homeDir()) {
  const file = settingsFilePath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const st = assertWritableSettingsFile(file);
  const r = readJsonFile(file);
  if (r.kind === "error") throw new Error(`拒绝改写设置文件：${r.message}`);
  const root = r.kind === "ok" ? r.value : {};
  if (!isPlainObject(root)) throw new Error(`拒绝改写设置文件：${file} 顶层不是对象`);
  if (root.secure !== undefined && !isPlainObject(root.secure))
    throw new Error(`拒绝改写设置文件：${file} 的 secure 不是对象`);
  const secure = { ...(root.secure ?? {}) };
  if (secure.vaults !== undefined && !isPlainObject(secure.vaults))
    throw new Error(`拒绝改写设置文件：${file} 的 secure.vaults 不是对象`);
  secure.vaults = { ...(secure.vaults ?? {}), [name]: { dir, mnt } };
  const next = { ...root, secure };
  writeFileAtomic(file, JSON.stringify(next, null, 2) + "\n", settingsWriteMode(st));
}

/**
 * Serialize settings read-modify-write across processes (security review #5): runs
 * `flock -w 10 <agentDir>/.pi-subagent.json.lock node helper.mjs __register …` synchronously.
 * The lock file is created 0600 with O_NOFOLLOW first (a symlinked lock path fails closed).
 * Protocol for other writers (P2 `persistSettingOverride`): take an exclusive flock(2) on the same
 * file for the whole re-read → merge → rename.
 */
export function registerVault(name, dir, mnt, home = homeDir()) {
  const lockFile = settingsLockPath(home);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(lockFile, fsc.O_RDONLY | fsc.O_CREAT | fsc.O_NOFOLLOW | fsc.O_NONBLOCK, 0o600);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid()) throw new Error(`设置锁文件 ${lockFile} 不是本用户的普通文件`);
  } finally {
    fs.closeSync(fd);
  }
  const self = fileURLToPath(import.meta.url);
  const r = spawnSync(
    "flock",
    [
      "-E",
      String(FLOCK_TIMEOUT_CODE),
      "-w",
      String(SETTINGS_LOCK_WAIT_S),
      lockFile,
      process.execPath,
      self,
      "__register",
      name,
      dir,
      mnt,
    ],
    {
      encoding: "utf8",
      timeout: (SETTINGS_LOCK_WAIT_S + 10) * 1000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: home },
    },
  );
  if (r.error) throw new Error(`无法执行 flock：${r.error.message}`);
  if (r.status === FLOCK_TIMEOUT_CODE) throw new Error(`设置文件锁 ${lockFile} 等待超时（另一个进程正在改写设置）`);
  if (r.status !== 0)
    throw new Error((r.stderr || "").replace(/^pi-secure: /gm, "").trim() || `登记失败（exit ${r.status}）`);
}

/**
 * {kind:"ok", vault, registered} | {kind:"error", code, message}. `allowUnregistered` (init only)
 * derives the default paths for a name that is not in settings yet.
 */
export function resolveVault(name, { allowUnregistered = false, home = homeDir() } = {}) {
  if (typeof name !== "string" || !VAULT_NAME_RE.test(name))
    return {
      kind: "error",
      code: EXIT.USAGE,
      message: `保险库名不合法：${JSON.stringify(name)}（需匹配 ${VAULT_NAME_RE}）`,
    };
  const { file, cfg, readError } = loadSecureConfig(home);
  if (readError) return { kind: "error", code: EXIT.CONFIG, message: `设置文件无法读取：${readError}` };
  if (!cfg.valid) return { kind: "error", code: EXIT.CONFIG, message: `${file}：${cfg.error}` };
  const bad = cfg.invalid.find((x) => x.name === name);
  if (bad) return { kind: "error", code: EXIT.CONFIG, message: `${file}：secure.vaults.${name} 非法（${bad.reason}）` };
  const v = cfg.vaults.find((x) => x.name === name);
  if (v) return { kind: "ok", vault: v, registered: true, enabled: cfg.enabled };
  if (allowUnregistered)
    return {
      kind: "ok",
      vault: deriveVault(name, defaultVaultDir(name, home), defaultVaultMnt(name, home)),
      registered: false,
      enabled: cfg.enabled,
    };
  return {
    kind: "error",
    code: EXIT.NOT_FOUND,
    message: `未找到保险库 ${name}（${file} 的 secure.vaults 中没有）。先执行：pi-secure init ${name}`,
  };
}

// ───────────────────────────── layout / sentinels (§L.1) ─────────────────────────────

function ownPrivateDir(st, uid) {
  return st && st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o077) === 0;
}

/** Physical address of `p` for the position rules (security review L0 #1): realpath of the nearest
 *  EXISTING ancestor + the remaining tail. Safe for mount points (never realpaths the mount itself:
 *  if it exists, its PARENT chain is resolved instead — see physMnt) and for metadata dirs. */
function physAddress(p) {
  return realpathNearest(p);
}

/** Physical mount-point address: resolve the parent chain, keep the last component literal —
 *  NEVER realpath `<mnt>` itself (a live or ENOTCONN mount would be traversed or hang). */
function physMnt(mnt) {
  return path.join(realpathNearest(path.dirname(mnt)), path.basename(mnt));
}

/** §L.1 position rules shared by checkLayout and createLayout (security review L0 #1):
 *  BOTH the lexical and the PHYSICAL address of every side are compared — a parent-dir symlink
 *  (e.g. ~/agent-alias → ~/.pi/agent) must not smuggle a mount point into a forbidden zone.
 *  Containment is checked in BOTH directions for all {new.mnt, new.dir} × {other.mnt, other.dir}
 *  pairs (A contains B and B contains A), plus the pi agent dir (also realpath-normalized). */
export function positionProblems(v, others = [], home = homeDir()) {
  const problems = [];
  const mine = {
    lex: { mnt: path.resolve(v.mnt), dir: path.resolve(v.dir) },
    phys: { mnt: physMnt(v.mnt), dir: physAddress(v.dir) },
  };
  /** True when a ⊆ b or b ⊆ a. */
  const nested = (a, b) => pathWithin(a, b) || pathWithin(b, a);
  if (nested(mine.lex.mnt, mine.lex.dir) || nested(mine.phys.mnt, mine.phys.dir))
    problems.push(`挂载点 ${v.mnt} 与元数据目录 ${v.dir} 不得互相包含`);
  for (const o of others) {
    if (o.name === v.name) continue;
    const theirs = {
      lex: { mnt: path.resolve(o.mnt), dir: path.resolve(o.dir) },
      phys: { mnt: physMnt(o.mnt), dir: physAddress(o.dir) },
    };
    let hit = false;
    for (const fam of ["lex", "phys"])
      for (const a of ["mnt", "dir"])
        for (const b of ["mnt", "dir"]) if (nested(mine[fam][a], theirs[fam][b])) hit = true;
    if (hit) problems.push(`挂载点/目录与保险库 ${o.name}（${o.mnt} / ${o.dir}）重叠`);
  }
  const agentLex = path.resolve(piAgentDir(home));
  let agentPhys;
  try {
    agentPhys = fs.realpathSync(agentLex);
  } catch {
    agentPhys = realpathNearest(agentLex);
  }
  if (
    nested(mine.lex.mnt, agentLex) ||
    nested(mine.lex.dir, agentLex) ||
    nested(mine.phys.mnt, agentPhys) ||
    nested(mine.phys.dir, agentPhys)
  )
    problems.push(`挂载点/目录不得位于 pi agent 目录（${agentLex}）内或包含它`);
  return problems;
}

/**
 * §L.1 ancestor rules for `<mnt>` (security review L0 #2 + r2 ruling A1): the WHOLE chain from the
 * mount point's parent up to AND INCLUDING `/` must be trustworthy — every level (on the physical
 * path; a symlink level is rejected outright so the lexical chain equals the physical one) must be
 * a real directory, owned by this uid or root, and NOT writable by group/other. The ONLY exception
 * to the write rule is a root-owned directory with the sticky bit (like /tmp: only the child's
 * owner may rename it, so another uid cannot swap our subtree). There is NO unconditional HOME
 * exemption: $HOME itself (e.g. a group-writable shared home) and every ancestor up to / are
 * checked like any other level. A violation reports the level and the reason. Legacy vaults skip
 * this check. `deps.lstat` is a test seam (defaults to fs.lstatSync).
 */
export function mntAncestorProblems(v, uid = process.getuid(), deps = {}) {
  const lstat = deps.lstat ?? ((p) => fs.lstatSync(p));
  const problems = [];
  let cur = path.dirname(path.resolve(v.mnt));
  for (let i = 0; i < 128; i++) {
    let st = null;
    try {
      st = lstat(cur);
    } catch {
      problems.push(`${cur} 不存在（挂载点祖先目录须已存在；缺省 ~/secure 由 init 自动创建）`);
      break;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      problems.push(`${cur} 须为真实目录（不得是符号链接/文件）`);
      break;
    }
    if (st.uid !== uid && st.uid !== 0) {
      problems.push(`${cur} 属于其他用户（uid ${st.uid}），不可作为挂载点祖先（须为本用户或 root）`);
      break;
    }
    const sticky = (st.mode & 0o1000) !== 0;
    if ((st.mode & 0o022) !== 0 && !(st.uid === 0 && sticky)) {
      problems.push(
        `${cur} 对组/其他可写${sticky ? "但属主非 root" : "且无 sticky 位"}，其他用户可替换其下的路径，拒绝`,
      );
      break;
    }
    if (cur === path.dirname(cur)) break; // reached "/"
    cur = path.dirname(cur);
  }
  return problems;
}

/**
 * Problems with the on-disk layout. `mounted` skips the sentinel checks (the mount hides them).
 * New layout: `<dir>` side (cipher/conf/lock/lease) + `<mnt>` side (0700 dir, sentinels when
 * unmounted, parent rule, position rules). Legacy (§L.3): exactly the old checks — no lease and no
 * parent/position rules; when a legacy vault is mounted its sentinels are hidden as well.
 */
export function checkLayout(v, { mounted = false, uid = process.getuid(), others = [], home = homeDir() } = {}) {
  const problems = [];
  const d = lstatOrNull(v.dir);
  if (!d) return { exists: false, problems: [`${v.dir} 不存在`] };
  if (!ownPrivateDir(d, uid)) problems.push(`${v.dir} 须为本用户的 0700 目录（不得是符号链接）`);
  const c = lstatOrNull(v.cipher);
  if (!ownPrivateDir(c, uid)) problems.push(`${v.cipher} 须为本用户的 0700 目录`);
  const conf = lstatOrNull(path.join(v.cipher, "gocryptfs.conf"));
  if (!conf || !conf.isFile()) problems.push(`${v.cipher}/gocryptfs.conf 缺失（init 未完成）`);
  const lock = lstatOrNull(v.lock);
  if (lock && !lock.isFile()) problems.push(`${v.lock} 须为普通文件`);
  if (v.layout !== "legacy") {
    const lease = lstatOrNull(v.lease);
    if (!lease) problems.push(`${v.lease} 缺失（mount.lease 由 init 创建）`);
    else if (!lease.isFile() || lease.isSymbolicLink() || lease.uid !== uid || (lease.mode & 0o777) !== 0o600)
      problems.push(`${v.lease} 须为本用户的 0600 普通文件`);
    problems.push(...positionProblems(v, others, home));
  }
  if (!mounted) {
    const m = lstatOrNull(v.mnt);
    if (!ownPrivateDir(m, uid)) problems.push(`${v.mnt} 须为本用户的 0700 目录`);
    else {
      let names = [];
      try {
        names = fs.readdirSync(v.mnt).sort();
      } catch (e) {
        problems.push(`${v.mnt} 不可读：${e && e.code}`);
      }
      const extra = names.filter((n) => n !== "work" && n !== "state");
      if (extra.length)
        problems.push(
          `${v.mnt} 下有多余条目：${extra.slice(0, 10).join(", ")}（可能是锁定期间写进挂载点底层的明文，人工检查）`,
        );
      for (const n of ["work", "state"]) {
        const s = lstatOrNull(path.join(v.mnt, n));
        if (!s) problems.push(`哨兵 ${v.mnt}/${n} 缺失`);
        else if (!s.isFile() || s.size !== 0 || (s.mode & 0o7777) !== 0o400 || s.uid !== uid)
          problems.push(`哨兵 ${v.mnt}/${n} 须为本用户的 0 字节 0400 普通文件`);
      }
    }
  }
  if (v.layout !== "legacy") problems.push(...mntAncestorProblems(v, uid));
  return { exists: true, problems };
}

/**
 * Security review L0 #4: recovery hint for an interrupted init — the new layout leaves BOTH the
 * metadata dir and the mount point behind. Commands only; nothing is auto-deleted, and the mount
 * point must be confirmed unmounted and sentinel-only before removal (extra entries are listed for
 * MANUAL inspection — they may be plaintext written under the mount point while locked).
 */
export function initCleanupHint(v) {
  return (
    `  清理（自行确认后执行）：确认未挂载、${v.mnt} 内只有 work/state 两个哨兵文件且无要保留的数据后，` +
    `删除元数据目录 ${v.dir} 与挂载点目录 ${v.mnt}，再 pi-secure init ${v.name}`
  );
}

/** The §L.3 read-only-compat refusal text for legacy-layout vaults. */
export function legacyRefusal(v) {
  return (
    `保险库 ${v.name} 使用旧布局（挂载点 ${v.mnt}）。` +
    `没有真实数据：pi-secure 登记项与目录删除后重新 init；` +
    `有真实数据：pi-secure export ${v.name} <文件> 后 pi-secure import <文件> <新名字>（新布局，会话与 sessionDir 自动迁址），确认无误再删除旧库。`
  );
}

function requireNewLayout(v) {
  if (v.layout === "legacy") throw new CliError(EXIT.CONFIG, legacyRefusal(v));
}

/** Create the §L.1 layout for a fresh vault (dir and mnt must not exist). Throws on any problem. */
export function createLayout(v, { others = [], home = homeDir() } = {}) {
  if (lstatOrNull(v.dir))
    throw new CliError(EXIT.FAIL, `${v.dir} 已存在——保险库已初始化，或上次 init 未完成（确认无用后删除该目录再 init）`);
  if (lstatOrNull(v.mnt))
    throw new CliError(
      EXIT.CONFIG,
      `挂载点 ${v.mnt} 已存在——init 不会接管已有目录；确认无用后删除，或用 --path 换一个位置`,
    );
  const pos = positionProblems(v, others, home);
  if (pos.length) throw new CliError(EXIT.CONFIG, `位置检查失败，拒绝 init：\n  - ${pos.join("\n  - ")}`);
  if (!lstatOrNull(path.dirname(v.mnt))) {
    if (v.mnt !== defaultVaultMnt(v.name, home))
      throw new CliError(
        EXIT.CONFIG,
        `挂载点父目录 ${path.dirname(v.mnt)} 不存在（仅缺省 ~/secure 会自动创建，其他位置请先自建）`,
      );
    fs.mkdirSync(path.dirname(v.mnt), { recursive: true, mode: 0o700 });
  }
  const pp = mntAncestorProblems(v, process.getuid());
  if (pp.length) throw new CliError(EXIT.CONFIG, `挂载点祖先目录检查失败：\n  - ${pp.join("\n  - ")}`);
  fs.mkdirSync(path.dirname(v.dir), { recursive: true, mode: 0o700 });
  fs.mkdirSync(v.dir, { mode: 0o700 });
  fs.mkdirSync(v.cipher, { mode: 0o700 });
  fs.mkdirSync(v.mnt, { mode: 0o700 });
  for (const n of ["work", "state"]) {
    const f = path.join(v.mnt, n);
    fs.closeSync(fs.openSync(f, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o400));
    fs.chmodSync(f, 0o400);
  }
  fs.closeSync(fs.openSync(v.lock, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600));
  fs.closeSync(fs.openSync(v.lease, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600));
}

/**
 * After a mount: make sure work/ and every state/<subdir> exist as private dirs (idempotent).
 * Security review #1: EVERY component from the mount root down (work, state, state/sessions,
 * state/sessions/default, …) is lstat'ed — never a symlink, always a dir owned by us — and created
 * one level at a time (no recursive mkdir that would follow a planted link). Finally each target's
 * realpath must equal its expected physical path under the confirmed mount `realMnt`.
 */
export function ensureVaultDirs(v, { realMnt = physicalPaths(v).realMnt, uid = process.getuid() } = {}) {
  const rels = [["work"], ...STATE_SUBDIRS.map((s) => ["state", ...s.split("/")])];
  for (const parts of rels) {
    let cur = v.mnt;
    let real = realMnt;
    for (const part of parts) {
      cur = path.join(cur, part);
      real = path.join(real, part);
      let st = lstatOrNull(cur);
      if (!st) {
        try {
          fs.mkdirSync(cur, { mode: 0o700 });
        } catch (e) {
          if (!e || e.code !== "EEXIST") throw new CliError(EXIT.FAIL, `无法创建 ${cur}：${e && e.message}`);
        }
        st = lstatOrNull(cur);
      }
      if (!st || st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid)
        throw new CliError(
          EXIT.FAIL,
          `${cur} 须为本用户的普通目录（不得是符号链接/文件）——拒绝使用该保险库，请检查后修复`,
        );
    }
    let resolved;
    try {
      resolved = fs.realpathSync(cur);
    } catch (e) {
      throw new CliError(EXIT.FAIL, `无法解析 ${cur}：${e && e.message}`);
    }
    if (resolved !== real)
      throw new CliError(EXIT.FAIL, `${cur} 实际指向 ${resolved}，不在已确认的挂载 ${realMnt} 内——拒绝`);
  }
}

/**
 * Right before starting pi: the dirs pi will write to (sessionDir, TMPDIR, memory) and its cwd must
 * physically sit inside the confirmed mount. Returns the canonical paths.
 */
export function verifyRunPaths(v, cwd, { realMnt = physicalPaths(v).realMnt } = {}) {
  const want = {
    sessionDir: path.join(realMnt, "state", "sessions", "default"),
    tmp: path.join(realMnt, "state", "tmp"),
    memory: path.join(realMnt, "state", "memory"),
  };
  const got = {
    sessionDir: v.sessionDir,
    tmp: path.join(v.state, "tmp"),
    memory: path.join(v.state, "memory"),
  };
  for (const k of Object.keys(want)) {
    let r;
    try {
      r = fs.realpathSync(got[k]);
    } catch (e) {
      throw new CliError(EXIT.FAIL, `无法解析 ${got[k]}：${e && e.message}`);
    }
    if (r !== want[k]) throw new CliError(EXIT.FAIL, `${got[k]} 实际指向 ${r}，不在保险库挂载内——拒绝启动 pi`);
  }
  let rc;
  try {
    rc = fs.realpathSync(cwd);
  } catch (e) {
    throw new CliError(EXIT.FAIL, `无法解析 cwd ${cwd}：${e && e.message}`);
  }
  if (rc !== cwd || !pathWithin(rc, path.join(realMnt, "work")))
    throw new CliError(EXIT.FAIL, `cwd ${cwd} 不在保险库 work 内（${rc}）——拒绝启动 pi`);
  return want;
}

// ───────────────────────────── project sessionDir (§2.3) ─────────────────────────────

function sameSessionDir(value, want, home) {
  if (typeof value !== "string" || value === "") return false;
  if (value === want) return true;
  const expanded = value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
  if (!path.isAbsolute(expanded)) return false;
  if (path.resolve(expanded) === want) return true;
  try {
    return fs.realpathSync(expanded) === fs.realpathSync(want);
  } catch {
    return false;
  }
}

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Idempotently make `<work>/.pi/settings.json` carry `sessionDir = <state>/sessions/default`.
 * Returns {kind:"unchanged"|"written"|"fixed", backup?} or {kind:"conflict", message}. Only `fix`
 * rewrites a different / unparsable value, after backing the file up as `settings.json.bak-<ts>`.
 */
export function syncProjectSettings(v, { fix = false, home = homeDir(), now = new Date() } = {}) {
  const want = v.sessionDir;
  const piDir = path.join(v.work, ".pi");
  const file = path.join(piDir, "settings.json");
  const ds = lstatOrNull(piDir);
  if (ds && (!ds.isDirectory() || ds.isSymbolicLink()))
    return { kind: "conflict", message: `${piDir} 不是普通目录（可能是符号链接）；请手工处理` };
  if (!ds) fs.mkdirSync(piDir, { mode: 0o700 });
  const fsSt = lstatOrNull(file);
  if (fsSt && (!fsSt.isFile() || fsSt.isSymbolicLink()))
    return { kind: "conflict", message: `${file} 不是普通文件（可能是符号链接）；请手工处理` };
  let obj = {};
  let parsedOk = true;
  if (fsSt) {
    const r = readJsonFile(file);
    if (r.kind === "ok" && isPlainObject(r.value)) obj = r.value;
    else parsedOk = false;
  }
  const mode = fsSt ? fsSt.mode & 0o777 : 0o600;
  if (parsedOk && sameSessionDir(obj.sessionDir, want, home)) return { kind: "unchanged" };
  const hasOther = parsedOk && obj.sessionDir !== undefined;
  if ((hasOther || !parsedOk) && !fix) {
    const what = parsedOk ? `sessionDir=${JSON.stringify(obj.sessionDir)}` : "内容不是 JSON 对象";
    return {
      kind: "conflict",
      message:
        `${file} 的 ${what}，与保险库要求的 ${want} 不一致——会话可能写到保险库外，拒绝启动。\n` +
        `  修复：pi-secure init ${v.name} --fix-settings（先备份原文件再改写）`,
    };
  }
  let backup;
  if (fsSt && (hasOther || !parsedOk)) {
    backup = `${file}.bak-${timestamp(now)}`;
    fs.copyFileSync(file, backup, fsc.COPYFILE_EXCL);
  }
  const next = parsedOk ? { ...obj, sessionDir: want } : { sessionDir: want };
  writeFileAtomic(file, JSON.stringify(next, null, 2) + "\n", mode);
  return backup ? { kind: "fixed", backup, droppedOtherKeys: !parsedOk } : { kind: "written" };
}

// ───────────────────────────── pi argument audit (§2.2.1 + §P0 C4) ─────────────────────────────

/** Locate pi's package root from the `pi` executable (realpath, walk up). */
export function findPiPackage(piBin) {
  let d;
  try {
    d = fs.realpathSync(piBin);
  } catch {
    return undefined;
  }
  for (let i = 0; i < 8; i++) {
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
    const pkgJson = path.join(d, "package.json");
    const r = readJsonFile(pkgJson);
    if (r.kind === "ok" && isPlainObject(r.value) && r.value.name === PI_PACKAGE_NAME) {
      return fs.existsSync(path.join(d, "dist", "cli", "args.js")) ? d : undefined;
    }
  }
  return undefined;
}

export function findOnPath(bin, envPath = process.env.PATH ?? "") {
  for (const dir of envPath.split(":")) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fsc.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* next */
    }
  }
  return undefined;
}

export async function loadPiParseArgs(pkgDir) {
  const mod = await import(pathToFileURL(path.join(pkgDir, "dist", "cli", "args.js")).href);
  if (typeof mod.parseArgs !== "function") throw new Error("pi dist/cli/args.js 没有导出 parseArgs");
  return mod.parseArgs;
}

/** Fail closed when pi's parseArgs result shape drifted from what the audit understands (C4). */
export function parseArgsShapeOk(parseArgs) {
  try {
    const a = parseArgs(["--fork", "F", "--session", "S", "--session-dir", "D", "--export", "E", "-e", "X", "@f", "m"]);
    const b = parseArgs(["--no-extensions", "--no-session"]);
    const c = parseArgs(["--session-dir"]);
    const d = parseArgs(["--", "--fork", "x"]);
    return (
      Array.isArray(a.messages) &&
      Array.isArray(a.fileArgs) &&
      a.unknownFlags instanceof Map &&
      Array.isArray(a.diagnostics) &&
      a.fork === "F" &&
      a.session === "S" &&
      a.sessionDir === "D" &&
      a.export === "E" &&
      Array.isArray(a.extensions) &&
      a.extensions[0] === "X" &&
      a.fileArgs[0] === "f" &&
      b.noExtensions === true &&
      b.noSession === true &&
      !Object.hasOwn(c, "sessionDir") &&
      c.unknownFlags.has("session-dir") &&
      !Object.hasOwn(d, "fork") &&
      d.messages[0] === "--fork"
    );
  } catch {
    return false;
  }
}

/** pi's own `resolvePath` semantics for a session argument (tilde + file:// + resolve against cwd). */
function piResolvePath(input, cwd, home) {
  let p = input;
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = path.join(home, p.slice(2));
  if (/^file:\/\//.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      /* leave as is */
    }
  }
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
}

/** pi's `main.js` rule: a session argument is a PATH when it has a separator or ends with .jsonl. */
export function sessionArgIsPath(s) {
  return s.includes("/") || s.includes("\\") || s.endsWith(".jsonl");
}

const REJECTED_UNKNOWN_FLAGS = ["session-dir", "session", "fork", "export", "extension", "no-extensions"];

/**
 * Audit a parsed pi argv for `pi-secure run`. `physical` additionally realpaths a session path
 * (only meaningful once the vault is mounted). → {ok:true} | {ok:false, reason}
 */
export function auditParsedArgs(parsed, { cwd, sessionsRoot, home = homeDir(), physical = false }) {
  if (
    !parsed ||
    !Array.isArray(parsed.messages) ||
    !Array.isArray(parsed.fileArgs) ||
    !(parsed.unknownFlags instanceof Map) ||
    !Array.isArray(parsed.diagnostics)
  )
    return { ok: false, reason: "pi 参数解析结果结构变化，无法审查（拒绝）" };
  if (Object.hasOwn(parsed, "sessionDir"))
    return { ok: false, reason: "不允许 --session-dir：加密会话的会话目录固定在保险库内" };
  for (const f of REJECTED_UNKNOWN_FLAGS)
    if (parsed.unknownFlags.has(f)) return { ok: false, reason: `不允许 --${f}（缺少取值或用了 --${f}=… 形式）` };
  if (Object.hasOwn(parsed, "export"))
    return { ok: false, reason: "不允许 --export：请在会话内用 /export（默认写到保险库内的 cwd）" };
  if (parsed.noExtensions) return { ok: false, reason: "不允许 --no-extensions：加密守护依赖 pi-toolkit 扩展" };
  if (Object.hasOwn(parsed, "extensions"))
    return { ok: false, reason: "不允许 -e/--extension：加密会话不追加扩展路径（务实版简化）" };
  if (Object.hasOwn(parsed, "session")) {
    const s = parsed.session;
    if (typeof s !== "string") return { ok: false, reason: "--session 取值异常" };
    if (sessionArgIsPath(s)) {
      const lexical = piResolvePath(s, cwd, home);
      const target = physical ? realpathNearest(lexical) : lexical;
      const root = physical ? realpathNearest(sessionsRoot) : sessionsRoot;
      if (!pathWithin(target, root) || target === root)
        return {
          ok: false,
          reason: `--session ${s} 不在保险库会话目录 ${sessionsRoot}/ 内；库外会话请用 --fork 复制进来`,
        };
    }
  }
  return { ok: true };
}

// ───────────────────────────── occupancy scan + finalize (§2.5) ─────────────────────────────

const TIMEOUT = Symbol("timeout");
// REF'd on purpose: an unref'd sleep is the only thing alive during a retry back-off, and the
// process would silently exit 0 mid-flow.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function deadlineRace(promise, deadline) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(TIMEOUT), Math.max(0, deadline - Date.now()));
    t.unref();
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Processes (own uid only — others are unreadable) whose cwd is inside `realMnt`. All async; bounded
 * by `deadline`. → {kind:"done", occupants:[{pid,comm,cwd}]} | {kind:"timeout"} | {kind:"too-many", count}
 */
export async function scanCwdOccupants(
  realMnt,
  { deadline, procRoot = "/proc", maxEntries = SCAN_MAX_ENTRIES, delayMs = 0, selfPid = process.pid } = {},
) {
  const work = (async () => {
    if (delayMs > 0) await sleep(delayMs);
    const names = (await fsp.readdir(procRoot)).filter((n) => /^\d+$/.test(n) && Number(n) !== selfPid);
    if (names.length > maxEntries) return { kind: "too-many", count: names.length };
    const occupants = [];
    for (let i = 0; i < names.length; i += 64) {
      if (Date.now() >= deadline) return TIMEOUT;
      const batch = names.slice(i, i + 64);
      const links = await Promise.all(
        batch.map((n) => fsp.readlink(path.join(procRoot, n, "cwd")).catch(() => undefined)),
      );
      batch.forEach((n, j) => {
        let cwd = links[j];
        if (typeof cwd !== "string") return;
        if (cwd.endsWith(" (deleted)")) cwd = cwd.slice(0, -" (deleted)".length);
        if (pathWithin(cwd, realMnt)) occupants.push({ pid: Number(n), cwd, comm: "" });
      });
    }
    for (const o of occupants.slice(0, 10)) {
      if (Date.now() >= deadline) break;
      o.comm = (await fsp.readFile(path.join(procRoot, String(o.pid), "comm"), "utf8").catch(() => "?")).trim();
    }
    return { kind: "done", occupants };
  })();
  const r = await deadlineRace(work, deadline).catch((e) => ({ kind: "error", message: String(e && e.message) }));
  return r === TIMEOUT ? { kind: "timeout" } : r;
}

/**
 * `flock -o -w <s> <lock> fusermount3 -u [-z] <mnt>` as ONE detached child (own process group). At
 * the deadline: SIGKILL the whole group, drop the pipe and unref — never wait (a fusermount stuck in
 * D-state cannot be reaped). → {kind:"exit", code, stderr} | {kind:"timeout"} | {kind:"error", message}
 */
export function spawnUnmount(v, { lazy, deadline }) {
  return new Promise((resolve) => {
    const waitS = Math.max(0.1, Math.floor((deadline - Date.now() - 1_000) / 100) / 10);
    const args = ["-o", "-E", String(FLOCK_TIMEOUT_CODE), "-w", waitS.toFixed(1), v.lock, "fusermount3", "-u"];
    if (lazy) args.push("-z");
    args.push(v.mnt);
    let child;
    try {
      child = spawn("flock", args, { detached: true, stdio: ["ignore", "ignore", "pipe"], cwd: "/" });
    } catch (e) {
      resolve({ kind: "error", message: String(e && e.message) });
      return;
    }
    let stderr = "";
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(
      () => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
        child.stderr?.destroy();
        child.unref();
        finish({ kind: "timeout" });
      },
      Math.max(0, deadline - Date.now()),
    );
    timer.unref();
    child.stderr?.on("data", (b) => {
      if (stderr.length < 4096) stderr += b.toString("utf8");
    });
    child.on("error", (e) => finish({ kind: "error", message: String(e && e.message) }));
    child.on("close", (code, signal) => finish({ kind: "exit", code: code ?? (signal ? 128 : 1), stderr }));
  });
}

/**
 * Bounded unmount shared by `run` (after pi exits) and `lock`. Every stage spends the SAME remaining
 * budget. Returns {code, lines[]} — it never throws and never waits past `budgetMs` (the caller's
 * hard-exit timer is the last backstop for a wedged libuv threadpool).
 */
export async function finalize(v, { lazy = false, budgetMs = FINALIZE_BUDGET_MS, deps = {} } = {}) {
  const start = Date.now();
  const deadline = start + budgetMs;
  // Every probe is async + deadline-bounded (security review #3); `deps.mountState` may be sync or async.
  const rawMountState = deps.mountState ?? ((dl) => probeMountState(v, { deadline: dl }));
  const mountState = async (dl) => {
    const r = await deadlineRace(
      Promise.resolve().then(() => rawMountState(dl)),
      dl,
    ).catch(() => "stale");
    return r === TIMEOUT ? "hung" : r;
  };
  const probeDeadline = () => Math.min(deadline, Date.now() + PROBE_MAX_MS);
  const hungLine = `${v.name}：挂载探测超时（FUSE 可能卡住），未卸载——保险库可能仍挂载；稍后 pi-secure status / pi-secure lock ${v.name}，必要时 fusermount3 -uz ${v.mnt}`;
  const scan =
    deps.scan ??
    ((realMnt, scanDeadline) => scanCwdOccupants(realMnt, { deadline: scanDeadline, delayMs: testScanDelay() }));
  const unmount = deps.unmount ?? ((opts) => spawnUnmount(v, opts));
  const lines = [];
  const st = await mountState(probeDeadline());
  if (st === "hung") return { code: EXIT.DEADLINE, lines: [hungLine] };
  if (st === "absent") return { code: EXIT.OK, lines: [`${v.name}：未挂载`] };
  if (st === "foreign") return { code: EXIT.FAIL, lines: [`${v.name}：${v.mnt} 上挂着别的文件系统，不动它`] };
  const realDir =
    deps.realDir ?? (await deadlineRace(fsp.realpath(v.dir), probeDeadline()).catch(() => path.resolve(v.dir)));
  if (realDir === TIMEOUT) return { code: EXIT.DEADLINE, lines: [hungLine] };
  const { realMnt } = physicalPaths(v, realDir);
  if (st === "mounted") {
    const scanDeadline = Math.min(deadline, Date.now() + SCAN_MAX_MS);
    const r = await scan(realMnt, scanDeadline);
    if (r.kind === "timeout")
      return { code: EXIT.DEADLINE, lines: [`${v.name}：占用扫描超时，未卸载（稍后 pi-secure lock ${v.name}）`] };
    if (r.kind === "too-many")
      return {
        code: EXIT.DEADLINE,
        lines: [`${v.name}：进程过多（${r.count}）无法在预算内扫描，未卸载（pi-secure lock ${v.name} --lazy 可强制）`],
      };
    if (r.kind === "error") return { code: EXIT.FAIL, lines: [`${v.name}：占用扫描失败（${r.message}），未卸载`] };
    if (r.occupants.length > 0 && !lazy) {
      lines.push(`${v.name}：仍有进程在保险库内（cwd），未卸载：`);
      for (const o of r.occupants.slice(0, 10)) lines.push(`  pid ${o.pid} ${o.comm}  ${o.cwd}`);
      if (r.occupants.length > 10) lines.push(`  …共 ${r.occupants.length} 个`);
      lines.push(`  退出它们后执行：pi-secure lock ${v.name}`);
      return { code: EXIT.BUSY, lines };
    }
  }
  if (deadline - Date.now() < 1_200)
    return { code: EXIT.DEADLINE, lines: [`${v.name}：收尾预算耗尽，未卸载（pi-secure lock ${v.name}）`] };
  const u = await unmount({ lazy, deadline });
  if (u.kind === "timeout")
    return {
      code: EXIT.DEADLINE,
      lines: [
        `${v.name}：卸载命令未在预算内完成，可能仍在后台；稍后 pi-secure status / pi-secure lock ${v.name}（必要时 fusermount3 -uz ${v.mnt}）`,
      ],
    };
  if (u.kind === "error") return { code: EXIT.FAIL, lines: [`${v.name}：无法执行卸载（${u.message}）`] };
  if (u.code === FLOCK_TIMEOUT_CODE)
    return { code: EXIT.LOCK_BUSY, lines: [`${v.name}：另一个 pi-secure 正在挂载或卸载（mount.lock 超时），未卸载`] };
  if (u.code !== 0) {
    const busy = /busy/i.test(u.stderr);
    const first = u.stderr.split("\n").find((l) => l.trim()) ?? `exit ${u.code}`;
    return {
      code: busy ? EXIT.BUSY : EXIT.FAIL,
      lines: busy
        ? [`${v.name}：保险库正被占用（EBUSY），未卸载；关闭占用的程序后 pi-secure lock ${v.name}`]
        : [`${v.name}：卸载失败：${first.trim()}`],
    };
  }
  const after = await mountState(Math.max(probeDeadline(), Date.now() + 300));
  if (after === "absent") return { code: EXIT.OK, lines: [`${v.name}：已卸载`] };
  return { code: EXIT.FAIL, lines: [`${v.name}：fusermount3 返回成功但挂载仍在（${after}）`] };
}

function testScanDelay() {
  // TEST-ONLY seam (tests/secure/launcher-fuse.test.ts): delay the occupancy scan to prove the scan
  // budget. Can only make the launcher refuse to unmount — never weaker.
  const n = Number(process.env.PI_SECURE_TEST_SCAN_DELAY_MS ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 60_000) : 0;
}

/** Arm the hard backstop: exit non-zero with one stderr line, even if an fs call is wedged. */
export function armHardExit(ms, line, code = EXIT.DEADLINE) {
  const t = setTimeout(() => {
    try {
      fs.writeSync(2, `pi-secure: ${line}\n`);
    } catch {
      /* ignore */
    }
    process.exit(code);
  }, ms);
  t.unref();
  return t;
}

export async function finalizeBounded(v, opts = {}) {
  const budgetMs = opts.budgetMs ?? FINALIZE_BUDGET_MS;
  const hard = armHardExit(budgetMs + HARD_EXIT_GRACE_MS, `卸载未完成，保险库 ${v.name} 可能仍挂载（${v.mnt}）`);
  try {
    return await finalize(v, { ...opts, budgetMs });
  } finally {
    clearTimeout(hard);
  }
}

// ───────────────────────────── swap / core / traffic-record detection (warn only) ─────────────────────────────

function readTextOr(p, fallback) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return fallback;
  }
}

/** Warnings for /proc/swaps. `sys(p)` reads sysfs (injectable). */
export function swapWarnings(
  swapsText,
  { sys = (p) => readTextOr(p, undefined), realpath = (p) => fs.realpathSync(p) } = {},
) {
  const out = [];
  const lines = (swapsText ?? "")
    .split("\n")
    .slice(1)
    .filter((l) => l.trim());
  for (const l of lines) {
    const [dev, type] = l.trim().split(/\s+/);
    if (!dev) continue;
    const zram = /^\/dev\/zram(\d+)$/.exec(dev);
    if (zram) {
      const backing = sys(`/sys/block/zram${zram[1]}/backing_dev`);
      if (backing === undefined) out.push(`swap ${dev}：无法确认 zram 是否启用 writeback（可能落盘）`);
      else if (backing.trim() !== "none")
        out.push(`swap ${dev}：zram 启用了 writeback 到 ${backing.trim()}，内存页可能明文落盘`);
      continue;
    }
    let real = dev;
    try {
      real = realpath(dev);
    } catch {
      /* keep */
    }
    const dm = /^\/dev\/(dm-\d+)$/.exec(real);
    if (dm && (sys(`/sys/block/${dm[1]}/dm/uuid`) ?? "").startsWith("CRYPT-")) continue;
    out.push(
      `swap ${dev}（${type ?? "?"}）：未确认加密，内存页（含明文）可能换出到磁盘——建议加密 swap / zram（无 writeback）/ 关闭 swap`,
    );
  }
  return out;
}

export function coreWarnings(corePattern) {
  const p = (corePattern ?? "").trim();
  if (p.startsWith("|"))
    return [
      `core_pattern 是管道（${p.split(/\s+/)[0]}），不受 ulimit -c 0 约束，崩溃转储可能落盘——可关闭 apport（sudo systemctl disable --now apport）`,
    ];
  return [];
}

function piAgentDir(home) {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env) return env === "~" ? home : env.startsWith("~/") ? path.join(home, env.slice(2)) : path.resolve(env);
  return path.join(home, ".pi", "agent");
}

/** Candidate install dirs for one pi package source (pi package-manager layout; best effort). */
function packageDirCandidates(source, baseDir) {
  if (source.startsWith("npm:")) {
    const spec = source.slice(4);
    const name = spec.startsWith("@") ? spec.split("@").slice(0, 2).join("@") : spec.split("@")[0];
    return [path.join(baseDir, "npm", "node_modules", name)];
  }
  const g = /^(?:git:|git\+)?(?:https?:\/\/|ssh:\/\/|git@)?([^/:]+)[/:](.+?)(?:\.git)?(?:@[^/]*)?$/.exec(source);
  if (source.startsWith("git:") || /^(https?|ssh):\/\//.test(source) || source.startsWith("git@")) {
    return g ? [path.join(baseDir, "git", g[1], g[2])] : [];
  }
  const local =
    source === "~" ? os.homedir() : source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : source;
  return [path.resolve(baseDir, local)];
}

/** D5: traffic-record present but not declaring `piSecure.honors = "PI_SECURE_SESSION/1"` ⇒ warn. */
export function trafficRecordWarnings(home = homeDir(), agentDir = piAgentDir(home)) {
  const out = [];
  const r = readJsonFile(path.join(agentDir, "settings.json"));
  if (r.kind !== "ok" || !isPlainObject(r.value)) return out;
  const sources = [];
  for (const key of ["packages", "extensions"]) {
    const list = r.value[key];
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      const s = typeof e === "string" ? e : isPlainObject(e) && typeof e.source === "string" ? e.source : undefined;
      if (s && /traffic-record/i.test(s)) sources.push(s);
    }
  }
  for (const s of sources) {
    let ok;
    for (const dir of packageDirCandidates(s, agentDir)) {
      let pj = path.join(dir, "package.json");
      if (!fs.existsSync(pj) && fs.existsSync(path.join(path.dirname(dir), "package.json")))
        pj = path.join(path.dirname(dir), "package.json");
      const p = readJsonFile(pj);
      if (p.kind === "ok" && isPlainObject(p.value)) {
        ok = isPlainObject(p.value.piSecure) && p.value.piSecure.honors === "PI_SECURE_SESSION/1";
        break;
      }
    }
    if (ok === true) continue;
    out.push(
      ok === false
        ? `traffic-record（${s}）未声明 piSecure.honors，加密会话的请求/响应正文可能写入 traffic.db——升级它或在加密会话里禁用`
        : `traffic-record（${s}）：找不到其 package.json，无法确认是否适配 PI_SECURE_SESSION`,
    );
  }
  return out;
}

export function systemWarnings(home = homeDir()) {
  return [
    ...swapWarnings(readTextOr("/proc/swaps", "")),
    ...coreWarnings(readTextOr("/proc/sys/kernel/core_pattern", "")),
    ...trafficRecordWarnings(home),
  ];
}

// ───────────────────────────── prerequisites ─────────────────────────────

export function parseGocryptfsVersion(text) {
  const m = /gocryptfs v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(text ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}

export function versionAtLeast(v, min) {
  for (let i = 0; i < min.length; i++) {
    if ((v[i] ?? 0) > min[i]) return true;
    if ((v[i] ?? 0) < min[i]) return false;
  }
  return true;
}

export function preflight() {
  const problems = [];
  if (process.platform !== "linux") problems.push("仅支持 Linux");
  for (const b of ["gocryptfs", "fusermount3", "flock"])
    if (!findOnPath(b))
      problems.push(
        `缺少 ${b}（Ubuntu：sudo apt install ${b === "flock" ? "util-linux" : b === "fusermount3" ? "fuse3" : "gocryptfs"}）`,
      );
  let version;
  if (findOnPath("gocryptfs")) {
    const r = spawnSync("gocryptfs", ["-version"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    version = parseGocryptfsVersion(`${r.stdout ?? ""}${r.stderr ?? ""}`);
    if (!version) problems.push("无法识别 gocryptfs 版本");
    else if (!versionAtLeast(version, GOCRYPTFS_MIN))
      problems.push(`gocryptfs ${version.join(".")} 过旧，需要 ≥ ${GOCRYPTFS_MIN.join(".")}`);
  }
  try {
    fs.accessSync("/dev/fuse", fsc.R_OK | fsc.W_OK);
  } catch {
    problems.push("/dev/fuse 不可用");
  }
  return { ok: problems.length === 0, problems, version };
}

// ───────────────────────────── CLI ─────────────────────────────

const err = (s) => process.stderr.write(`pi-secure: ${s}\n`);
const out = (s) => process.stdout.write(`${s}\n`);

class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function must(r) {
  if (r.kind === "error") throw new CliError(r.code, r.message);
  return r;
}

function requirePrereqs() {
  const p = preflight();
  if (!p.ok) throw new CliError(EXIT.PREREQ, `前置检查失败：\n  - ${p.problems.join("\n  - ")}`);
}

function requireTty(what) {
  if (!tty.isatty(0)) throw new CliError(EXIT.USAGE, `${what}需要在终端里输入口令（stdin 不是 TTY）`);
}

const USAGE = `用法：
  pi-secure init <name> [--path <挂载点>] [--fix-settings]
  pi-secure unlock <name>
  pi-secure lock <name> [--lazy]
  pi-secure status [<name>]
  pi-secure run <name> [-C <子目录>] [pi 参数…]
布局（private-plan §L.1）：元数据在 ~/.local/share/pi-toolkit-secure/<name>/（cipher、mount.lock、mount.lease），
挂载点是 ~/secure/<name>/（0700 目录；未挂载时 work/state 是两个哨兵文件），项目根 ~/secure/<name>/work。
--path 指定挂载点位置（绝对路径或 ~/ 开头）。
说明见 docs/dev/data-encryption/plan.md §2.2（run 之后的参数原样交给 pi 解析；"--" 之后全部是消息）`;

/** Run gocryptfs with the TTY inherited; resolves to its exit code. */
function runInherited(cmd, args, { timeoutMs } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd: "/" });
    let timer;
    if (timeoutMs) {
      timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      timer.unref();
    }
    child.on("error", () => resolve(127));
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1));
    });
  });
}

async function waitMountState(v, want, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const st = await probeMountState(v);
    if (st === want || Date.now() >= end) return st;
    await sleep(100);
  }
}

/** Linux glibc makedev (enough for the small fuse devices mountinfo reports). */
export function devFromMajMin(maj, min) {
  return (min & 0xff) | ((maj & 0xfff) << 8) | ((min & ~0xff) << 12) | Number(BigInt(maj & ~0xfff) << 32n);
}

export function pinMountPoint(v) {
  let fd;
  try {
    fd = fs.openSync(v.mnt, fsc.O_RDONLY | fsc.O_DIRECTORY | fsc.O_NOFOLLOW);
  } catch (e) {
    throw new CliError(
      EXIT.FAIL,
      `无法固定挂载点身份（open ${v.mnt}：${(e && e.code) || (e && e.message)}），拒绝挂载`,
    );
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isDirectory()) throw new Error("not a directory");
    // The PHYSICAL path now (pre-mount: safe to realpath) and the parent's identity — the r2
    // ruling's provable pin: post-mount we re-read /proc/self/fd/<fd> (fd links follow RENAMES)
    // and the parent's dev/ino to prove the mount landed on the very inode we validated.
    const real = fs.realpathSync(v.mnt);
    const parent = fs.statSync(path.dirname(v.mnt));
    return {
      fd,
      dev: st.dev,
      ino: st.ino,
      path: real,
      parent: { dev: parent.dev, ino: parent.ino },
      closed: false,
    };
  } catch (e) {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    throw new CliError(EXIT.FAIL, `无法固定挂载点身份（fstat ${v.mnt}：${(e && e.message) || e}），拒绝挂载`);
  }
}

export function closeMountPointPin(pin) {
  if (!pin || pin.closed) return;
  pin.closed = true;
  try {
    fs.closeSync(pin.fd);
  } catch {
    /* already gone */
  }
}

/** The path still resolves to the pinned inode? (rename swaps change (dev,ino)). */
export function mountPointPinStillValid(v, pin) {
  let st;
  try {
    st = fs.lstatSync(v.mnt);
  } catch (e) {
    throw new CliError(
      EXIT.FAIL,
      `挂载点 ${v.mnt} 在解锁过程中消失（${(e && e.code) || e}），拒绝继续；请 pi-secure status ${v.name}`,
    );
  }
  if (!st.isDirectory() || st.dev !== pin.dev || st.ino !== pin.ino)
    throw new CliError(
      EXIT.FAIL,
      `挂载点 ${v.mnt} 在解锁过程中被替换（dev/ino 变化），拒绝继续；人工检查后 pi-secure status ${v.name}`,
    );
  return true;
}

/** The maj:min of the LAST mountinfo line at `realMnt` (raw field 3, octal escapes decoded for the path). */
export function mountinfoDevAt(mountinfo, realMnt) {
  let majMin;
  for (const line of mountinfo.split("\n")) {
    const sepAt = line.indexOf(" - ");
    if (sepAt < 0) continue;
    const pre = line.slice(0, sepAt).split(" ");
    if (pre.length < 5) continue;
    if (decodeMountinfoField(pre[4]) === realMnt) majMin = pre[2];
  }
  return majMin;
}

export function verifyMountPointIdentity(v, pin, deps = {}) {
  if (process.env.PI_SECURE_TEST_MOUNT_VERIFY_FAIL === "1")
    throw new CliError(EXIT.FAIL, `TEST 注入：挂载点身份核验失败（${v.mnt}）`);
  try {
    const { realCipher } = physicalPaths(v);
    const readMountinfo = deps.readMountinfo ?? (() => fs.readFileSync("/proc/self/mountinfo", "utf8"));
    const stat = deps.stat ?? ((p) => fs.statSync(p));
    const readlink = deps.readlink ?? ((p) => fs.readlinkSync(p));
    const mountinfo = readMountinfo();
    // (a) the pinned inode still sits at the pinned PHYSICAL path — fd links follow renames, so a
    //     swap during the mount window shows up here; this is what binds the kernel's mount to OUR pin.
    let fdPath;
    try {
      fdPath = readlink(`/proc/self/fd/${pin.fd}`);
    } catch (e) {
      throw new CliError(
        EXIT.FAIL,
        `挂载点身份核验失败：无法读取 pin fd 的当前路径（${(e && e.message) || e}），拒绝使用`,
      );
    }
    if (fdPath !== pin.path)
      throw new CliError(
        EXIT.FAIL,
        `挂载点在挂载过程中被改名/替换（pin 现指向 ${fdPath}，预期 ${pin.path}），拒绝使用`,
      );
    // (b) mountinfo carries OUR gocryptfs mount at exactly that physical path.
    const line = parseMountinfo(mountinfo).find(
      (e) => e.mountPoint === pin.path && e.fsType === GOCRYPTFS_FSTYPE && e.source === realCipher,
    );
    if (!line)
      throw new CliError(
        EXIT.FAIL,
        `挂载后 mountinfo 里没有 ${pin.path} 的 gocryptfs 条目（source ${realCipher}），请 pi-secure status ${v.name}`,
      );
    // (c) the parent directory's identity is unchanged.
    const parent = stat(path.dirname(v.mnt));
    if (parent.dev !== pin.parent.dev || parent.ino !== pin.parent.ino)
      throw new CliError(EXIT.FAIL, `挂载点父目录（${path.dirname(v.mnt)}）身份变化，拒绝使用`);
    // (+) the path now HOSTS that mount: its device equals the mountinfo line's fuse maj:min.
    const st = stat(v.mnt);
    const majMin = mountinfoDevAt(mountinfo, pin.path);
    if (majMin === undefined || !/^\d+:\d+$/.test(majMin))
      throw new CliError(EXIT.FAIL, `无法从 mountinfo 解析 ${pin.path} 的设备号，拒绝使用该挂载`);
    const [maj, min] = majMin.split(":").map(Number);
    if (st.dev !== devFromMajMin(maj, min))
      throw new CliError(
        EXIT.FAIL,
        `挂载点身份核验失败：${v.mnt} 当前设备 ${st.dev} ≠ mountinfo 的 ${majMin}——路径可能在挂载中被替换，拒绝使用`,
      );
    return true;
  } finally {
    closeMountPointPin(pin);
  }
}

/** Inner half of a mount, executed by the outer launcher UNDER `flock -o mount.lock`. */
async function cmdInnerMount(name) {
  const { vault: v } = must(resolveVault(name));
  requireNewLayout(v); // §L.3: legacy vaults never mount again
  let st = await probeMountState(v);
  if (st === "mounted") return INNER_ALREADY;
  if (st === "hung")
    throw new CliError(EXIT.FAIL, `${v.mnt} 的挂载探测超时（FUSE 卡住？），拒绝操作；必要时 fusermount3 -uz ${v.mnt}`);
  if (st === "foreign") throw new CliError(EXIT.FAIL, `${v.mnt} 上挂着别的文件系统（mountinfo 不符），拒绝挂载`);
  if (st === "stale") {
    err(`${name}：发现失效挂载（守护进程已不在），先清理`);
    spawnSync("fusermount3", ["-u", v.mnt], { stdio: "ignore", timeout: 10_000 });
    st = await probeMountState(v);
    if (st !== "absent") throw new CliError(EXIT.FAIL, `无法清理失效挂载 ${v.mnt}：fusermount3 -uz ${v.mnt}`);
  }
  const lay = checkLayout(v, { mounted: false, others: otherRegisteredVaults(v) });
  if (lay.problems.length)
    throw new CliError(EXIT.CONFIG, `布局校验失败，拒绝挂载：\n  - ${lay.problems.join("\n  - ")}`);
  requireTty("解锁");
  const pin = pinMountPoint(v); // security review L0 #2: identity fixed right before mounting
  try {
    for (let attempt = 1; attempt <= PASSWORD_TRIES; attempt++) {
      mountPointPinStillValid(v, pin); // re-checked before EVERY attempt (incl. password retries)
      // Password: typed into gocryptfs directly (stdio inherited); we never see it.
      const code = await runInherited("gocryptfs", ["-nonempty", "--", v.cipher, v.mnt], {
        timeoutMs: MOUNT_ATTEMPT_TIMEOUT_MS,
      });
      if (code === 0) {
        const now = await waitMountState(v, "mounted", 3_000);
        if (now !== "mounted")
          throw new CliError(EXIT.FAIL, `gocryptfs 返回成功，但 mountinfo 不符（${now}），请 pi-secure status ${name}`);
        verifyMountPointIdentity(v, pin); // the path now hosts exactly the matched mount
        return 0;
      }
      if (code === 12) {
        if (attempt < PASSWORD_TRIES) {
          err(`口令错误（${attempt}/${PASSWORD_TRIES}）`);
          await sleep(RETRY_DELAYS_MS[attempt - 1]);
          continue;
        }
        throw new CliError(EXIT.BAD_PASSWORD, `口令连续错误 ${PASSWORD_TRIES} 次`);
      }
      const why =
        code === 10
          ? "挂载点非空"
          : code === 19
            ? "挂载点不可写"
            : code === 23
              ? "gocryptfs.conf 无法读取"
              : code >= 128
                ? "被中断"
                : `exit ${code}`;
      throw new CliError(EXIT.FAIL, `gocryptfs 挂载失败（${why}）`);
    }
    return EXIT.FAIL;
  } finally {
    closeMountPointPin(pin);
  }
}

/** Mount (if needed) under `flock -o -w 10 mount.lock`, then ensure dirs. Returns "mounted-now"|"already". */
async function doMount(v) {
  const self = fileURLToPath(import.meta.url);
  const code = await runInherited("flock", [
    "-o",
    "-E",
    String(FLOCK_TIMEOUT_CODE),
    "-w",
    String(LOCK_WAIT_S),
    v.lock,
    process.execPath,
    self,
    "__mount",
    v.name,
  ]);
  if (code === FLOCK_TIMEOUT_CODE)
    throw new CliError(EXIT.LOCK_BUSY, "另一个 pi-secure 正在挂载或卸载（mount.lock 等待超时）");
  if (code === INNER_ALREADY) return "already";
  if (code !== 0) throw new CliError(code, ""); // the inner process already printed why
  return "mounted-now";
}

function postMount(v, { fix = false, realMnt } = {}) {
  ensureVaultDirs(v, { realMnt });
  const r = syncProjectSettings(v, { fix });
  if (r.kind === "conflict") throw new CliError(EXIT.CONFIG, r.message);
  if (r.kind === "written") err(`已写入 ${path.join(v.work, ".pi", "settings.json")} 的 sessionDir`);
  if (r.kind === "fixed")
    err(
      `已改写 sessionDir（原文件备份为 ${r.backup}${r.droppedOtherKeys ? "；原文件不是 JSON 对象，其余内容只在备份里" : ""}）`,
    );
}

function printWarnings() {
  for (const w of systemWarnings()) err(`警告：${w}`);
}

async function unlockVault(v, { fix = false } = {}) {
  requirePrereqs();
  // `how` stays undefined until doMount settles — a THROW from doMount may still have MOUNTED
  // (identity verification runs INSIDE the __mount child, after gocryptfs succeeded), so the
  // catch treats how === undefined exactly like "mounted-now": probe & roll back (r2 ruling A3).
  let how;
  try {
    how = await doMount(v);
    const st = await probeMountState(v);
    if (st !== "mounted")
      throw new CliError(EXIT.FAIL, `挂载未生效（mountinfo：${st}），请 pi-secure status ${v.name}`);
    const { realMnt } = physicalPaths(v);
    postMount(v, { fix, realMnt });
    return { how, realMnt };
  } catch (e) {
    if (how !== "already") await rollbackFreshMount(v, e); // a pre-existing mount is left as found
    throw e;
  }
}

/** Unmount a mount we made ourselves after a failure; always tells the user the outcome.
 *  r2 A3: probes first (nothing actually mounted ⇒ no rollback noise), unmounts with
 *  `fusermount3 -u` and retries with `-uz` once when it comes back EBUSY — the mount being undone
 *  is by definition not one we want to keep waiting for. */
async function rollbackFreshMount(v, cause) {
  const why = cause instanceof CliError ? cause.message : String((cause && cause.message) || cause);
  if (why) err(why);
  if (cause instanceof CliError) cause.message = "";
  else if (cause && typeof cause === "object") cause.reportedAlready = true;
  const mounted = await probeMountState(v);
  if (mounted === "absent") return; // nothing this failure left behind
  let f = await finalizeBounded(v);
  if (f.code === EXIT.BUSY) f = await finalizeBounded(v, { lazy: true }); // fusermount3 -u ⇒ -uz
  if (f.code === 0) err(`${v.name}：本次挂载已撤销（已卸载）`);
  else {
    for (const l of f.lines) err(l);
    err(
      `${v.name}：本次挂载未能撤销——保险库可能仍挂载。稍后执行 pi-secure status ${v.name} / pi-secure lock ${v.name}（必要时 fusermount3 -uz ${v.mnt}）`,
    );
  }
}

async function cmdUnlock(args) {
  const [name, ...rest] = args;
  if (!name || rest.length) throw new CliError(EXIT.USAGE, USAGE);
  const { vault: v } = must(resolveVault(name));
  requireNewLayout(v); // §L.3
  const { how } = await unlockVault(v);
  printWarnings();
  out(
    how === "already"
      ? `${name}：已挂载（挂载点 ${v.mnt}，项目根 ${v.work}）`
      : `${name}：已解锁（挂载点 ${v.mnt}，项目根 ${v.work}）；用完执行 pi-secure lock ${name}`,
  );
  return EXIT.OK;
}

async function cmdLock(args) {
  let lazy = false;
  const pos = [];
  for (const a of args) {
    if (a === "--lazy") lazy = true;
    else pos.push(a);
  }
  if (pos.length !== 1) throw new CliError(EXIT.USAGE, USAGE);
  const { vault: v } = must(resolveVault(pos[0]));
  const r = await finalizeBounded(v, { lazy });
  for (const l of r.lines) (r.code === 0 ? out : err)(l);
  return r.code;
}

async function cmdInit(args) {
  let name;
  let mntArg;
  let fix = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--path") mntArg = args[++i];
    else if (a.startsWith("--path=")) mntArg = a.slice(7);
    else if (a === "--fix-settings") fix = true;
    else if (!name && !a.startsWith("-")) name = a;
    else throw new CliError(EXIT.USAGE, USAGE);
  }
  if (!name) throw new CliError(EXIT.USAGE, USAGE);
  const home = homeDir();
  if (fix) {
    if (mntArg !== undefined) throw new CliError(EXIT.USAGE, "--fix-settings 不与 --path 同用");
    const { vault: v } = must(resolveVault(name));
    requireNewLayout(v); // §L.3
    await unlockVault(v, { fix: true });
    out(`${name}：sessionDir 已对齐；保险库保持挂载（pi-secure lock ${name} 卸载）`);
    return EXIT.OK;
  }
  const r = must(resolveVault(name, { allowUnregistered: true }));
  if (r.registered && r.vault.layout === "legacy") {
    throw new CliError(EXIT.CONFIG, legacyRefusal(r.vault)); // §L.3: re-init over a legacy vault
  }
  if (lstatOrNull(r.vault.dir)) {
    const lay = checkLayout(r.vault, {
      mounted: (await probeMountState(r.vault)) !== "absent",
      others: otherRegisteredVaults(r.vault),
    });
    throw new CliError(
      EXIT.FAIL,
      lay.problems.length
        ? `${r.vault.dir} 已存在但布局不完整（上次 init 未完成？）：\n  - ${lay.problems.join("\n  - ")}\n${initCleanupHint(r.vault)}`
        : `保险库 ${name} 已存在（${r.vault.dir}）。修正项目 sessionDir 用：pi-secure init ${name} --fix-settings`,
    );
  }
  let v = r.vault;
  if (mntArg !== undefined) {
    // §L.1: --path is the MOUNT POINT location now (used to be the entry symlink).
    const m = expandSecurePath(mntArg, home);
    if (!m) throw new CliError(EXIT.USAGE, `--path 须为绝对路径或 ~/ 开头：${mntArg}`);
    v = deriveVault(name, v.dir, m);
  }
  requirePrereqs();
  requireTty("init");
  if (!tty.isatty(1))
    throw new CliError(EXIT.USAGE, "init 会在终端打印 master key，stdout 必须是终端（不要重定向到文件/管道）");
  createLayout(v, { others: otherRegisteredVaults(v) });
  // Registered BEFORE gocryptfs -init so an interrupted init shows up in `status` as incomplete.
  try {
    registerVault(name, v.dir, v.mnt, home);
  } catch (e) {
    throw new CliError(EXIT.CONFIG, `${String(e && e.message)}\n  ${v.dir} 已建好但未登记。\n${initCleanupHint(v)}`);
  }
  out(
    `即将创建保险库 ${name}：gocryptfs 会要求输入两次新口令，然后在终端打印 master key（只显示这一次，请抄下离线保存）。`,
  );
  // NOT -q: with -q gocryptfs 1.8 does not print the master key (P0 C1).
  const code = await runInherited("gocryptfs", ["-init", "--", v.cipher]);
  if (code !== 0) {
    throw new CliError(EXIT.FAIL, `gocryptfs -init 失败（exit ${code}）\n${initCleanupHint(v)}`);
  }
  out(`首次解锁以建立目录结构（再输入一次口令）：`);
  await unlockVault(v);
  const f = await finalizeBounded(v);
  for (const l of f.lines) (f.code === 0 ? out : err)(l);
  printWarnings();
  out(
    [
      `完成：挂载点 ${v.mnt}，项目放在 ${v.work}，会话落在 ${v.sessionDir}。`,
      `master key 仍留在终端回滚里：现在执行 clear；若在 tmux 中再执行 tmux clear-history（尽力清理，不等于安全擦除）。`,
      `之后：pi-secure run ${name}  或  pi-secure unlock ${name}`,
    ].join("\n"),
  );
  return f.code === 0 ? EXIT.OK : f.code;
}

async function describeVault(v, { scan = true } = {}) {
  const lines = [];
  const st = await probeMountState(v);
  const lay = checkLayout(v, {
    mounted: st === "mounted" || st === "stale",
    others: otherRegisteredVaults(v),
  });
  const layout = !lay.exists ? "missing" : lay.problems.length ? "incomplete" : v.layout === "legacy" ? "legacy" : "ok";
  lines.push(`${v.name}: ${st === "absent" ? "locked" : st}  layout ${layout}  mnt ${v.mnt}`);
  lines.push(`  dir ${v.dir}`);
  for (const p of lay.problems) lines.push(`  ! ${p}`);
  if (v.layout === "legacy") {
    lines.push(`  ! 旧布局（挂载点 ${v.mnt}）：仅 status/lock 可用，unlock/run/init --fix-settings 已拒绝`);
    lines.push(`  ! ${legacyRefusal(v)}`);
  } else if (layout !== "ok" && lay.exists)
    lines.push(
      `  恢复：确认 ${v.dir} 与挂载点 ${v.mnt}（未挂载、只含 work/state 两个哨兵）里没有要保留的数据后一并删除，再 pi-secure init ${v.name}`,
    );
  if (st === "stale") lines.push(`  ! 失效挂载（守护进程已不在）：pi-secure unlock ${v.name} 会先清理再挂载`);
  return { lines, st, scan: scan && st === "mounted" };
}

/** Other vaults from the settings file (for §L.1 position rules); empty on any read problem. */
function otherRegisteredVaults(v) {
  const { cfg } = loadSecureConfig(homeDir());
  return cfg.valid ? cfg.vaults.filter((x) => x.name !== v.name) : [];
}

async function cmdStatus(args) {
  if (args.length > 1) throw new CliError(EXIT.USAGE, USAGE);
  const home = homeDir();
  const { file, cfg, readError } = loadSecureConfig(home);
  const p = preflight();
  out(`gocryptfs: ${p.version ? p.version.join(".") : "n/a"}${p.ok ? "" : "  (" + p.problems.join("; ") + ")"}`);
  out(
    `settings: ${file}${readError ? `  ! ${readError}` : !cfg.valid ? `  ! ${cfg.error}` : cfg.present ? (cfg.enabled ? "" : "  secure.enabled=false") : "  (no secure section)"}`,
  );
  for (const bad of cfg.invalid) out(`  ! secure.vaults.${bad.name} invalid (${bad.reason})`);
  let vaults = cfg.vaults;
  if (args[0]) {
    const r = resolveVault(args[0], { allowUnregistered: true });
    if (r.kind === "error") throw new CliError(r.code, r.message);
    vaults = [r.vault];
    if (!r.registered) out(`  ${args[0]}：未在设置中登记`);
  }
  if (!vaults.length) out("(no vaults)");
  for (const v of vaults) {
    const d = await describeVault(v);
    for (const l of d.lines) out(l);
    if (d.scan) {
      const s = await scanCwdOccupants(physicalPaths(v).realMnt, { deadline: Date.now() + SCAN_MAX_MS });
      if (s.kind === "done") {
        out(`  cwd-in-vault: ${s.occupants.length}`);
        for (const o of s.occupants.slice(0, 10)) out(`    pid ${o.pid} ${o.comm}  ${o.cwd}`);
      } else out(`  cwd-in-vault: n/a (${s.kind})`);
    }
  }
  const w = systemWarnings(home);
  for (const x of w) out(`warn: ${x}`);
  if (!w.length) out("warn: none");
  return EXIT.OK;
}

/** Original values of the variables the secure session overrides (for hubSafeEnv); kept if already set. */
export function origEnvJson(env = process.env) {
  if (typeof env.PI_SECURE_ORIG_ENV === "string" && env.PI_SECURE_ORIG_ENV !== "") return env.PI_SECURE_ORIG_ENV;
  return JSON.stringify({ TMPDIR: env.TMPDIR ?? null, ARMORY_MEMORY_ROOT: env.ARMORY_MEMORY_ROOT ?? null });
}

/** Environment for the pi child (§2.4 / §R3 contract with P2). */
export function piChildEnv(v, cwd, env = process.env) {
  const next = {};
  for (const [k, val] of Object.entries(env)) if (!k.startsWith("PI_SECURE_") && val !== undefined) next[k] = val;
  next.PI_SECURE_ORIG_ENV = origEnvJson(env);
  next.PI_SECURE_VAULT = v.name;
  next.PI_SECURE_SESSION = "1";
  next.TMPDIR = path.join(v.state, "tmp");
  next.ARMORY_MEMORY_ROOT = path.join(v.state, "memory");
  next.PWD = cwd;
  delete next.PI_CODING_AGENT_SESSION_DIR; // --session-dir wins anyway; keep the env unambiguous
  delete next.OLDPWD;
  return next;
}

/**
 * `-C <sub>`: must stay inside work. Lexical mode (before mounting) returns the lexical target.
 * Physical mode (security review #2) returns the CANONICAL realpath — the exact directory the child
 * will run in (`process.cwd()` of pi), so the second argument audit resolves relative paths
 * against the same base pi does. The default (no -C) goes through the same branch.
 */
export function resolveRunCwd(v, sub, { physical = false, realMnt } = {}) {
  let rel = sub === undefined || sub === "" ? "." : sub;
  if (path.isAbsolute(rel)) {
    const abs = path.resolve(rel);
    if (!pathWithin(abs, v.work)) throw new CliError(EXIT.USAGE, `-C ${sub} 不在保险库 ${v.mnt}/work 内`);
    rel = path.relative(v.work, abs) || ".";
  }
  const target = path.resolve(v.work, rel);
  if (!pathWithin(target, v.work)) throw new CliError(EXIT.USAGE, `-C ${sub} 跳出了保险库`);
  if (!physical) return target;
  const realWork = path.join(realMnt ?? physicalPaths(v).realMnt, "work");
  let real;
  try {
    real = fs.realpathSync(target);
  } catch {
    throw new CliError(EXIT.USAGE, `-C ${sub}：目录不存在（${target}）`);
  }
  if (!pathWithin(real, realWork)) throw new CliError(EXIT.USAGE, `-C ${sub} 经符号链接指向保险库外（${real}）`);
  if (!fs.statSync(real).isDirectory()) throw new CliError(EXIT.USAGE, `-C ${sub} 不是目录`);
  return real;
}

async function cmdRun(args) {
  const [name, ...rest] = args;
  if (!name || name.startsWith("-")) throw new CliError(EXIT.USAGE, USAGE);
  let sub;
  let piArgs = rest;
  if (rest[0] === "-C") {
    if (rest.length < 2) throw new CliError(EXIT.USAGE, "-C 需要子目录");
    sub = rest[1];
    piArgs = rest.slice(2);
  }
  const r = must(resolveVault(name));
  const v = r.vault;
  requireNewLayout(v); // §L.3: legacy vaults never run
  if (!r.enabled)
    throw new CliError(EXIT.CONFIG, "secure.enabled=false：插件守护已关闭，拒绝 run（unlock/lock/status 仍可用）");
  const piBin = findOnPath("pi");
  if (!piBin) throw new CliError(EXIT.PREREQ, "PATH 上找不到 pi");
  const pkg = findPiPackage(piBin);
  if (!pkg)
    throw new CliError(
      EXIT.PREREQ,
      `无法从 ${piBin} 定位 pi 包（需要 ${PI_PACKAGE_NAME} 的 dist/cli/args.js）——拒绝启动`,
    );
  let parseArgs;
  try {
    parseArgs = await loadPiParseArgs(pkg);
  } catch (e) {
    throw new CliError(EXIT.PREREQ, `加载 pi 参数解析器失败：${e && e.message}`);
  }
  if (!parseArgsShapeOk(parseArgs))
    throw new CliError(
      EXIT.REFUSED_ARGS,
      "pi parseArgs 的结果结构变了，参数审查无法保证，拒绝启动（先跑 conformance C4）",
    );
  const lexCwd = resolveRunCwd(v, sub);
  const parsed = parseArgs(piArgs);
  // 1st pass: lexical, BEFORE asking for the password (bad args never mount anything).
  const a1 = auditParsedArgs(parsed, { cwd: lexCwd, sessionsRoot: path.join(v.state, "sessions") });
  if (!a1.ok) throw new CliError(EXIT.REFUSED_ARGS, `参数被拒：${a1.reason}`);

  const { how, realMnt } = await unlockVault(v); // rolls back a fresh mount on ANY failure (review #4)
  let cwd;
  try {
    printWarnings();
    // Canonical cwd (review #2): the very value pi gets as process.cwd(), used for audit #2 too.
    cwd = resolveRunCwd(v, sub, { physical: true, realMnt });
    const a2 = auditParsedArgs(parsed, {
      cwd,
      sessionsRoot: path.join(realMnt, "state", "sessions"),
      physical: true,
    });
    if (!a2.ok) throw new CliError(EXIT.REFUSED_ARGS, `参数被拒：${a2.reason}`);
    // Review #1: what pi will actually write to must be inside the confirmed mount.
    verifyRunPaths(v, cwd, { realMnt });
  } catch (e) {
    // Not yet in pi's lifecycle: a mount made by THIS run is undone (review #4).
    if (how === "mounted-now") await rollbackFreshMount(v, e);
    throw e;
  }

  const code = await runPiChild(piBin, ["--session-dir", v.sessionDir, ...piArgs], cwd, piChildEnv(v, cwd));
  const f = await finalizeBounded(v);
  for (const l of f.lines) (f.code === 0 ? out : err)(l);
  return code;
}

/** pi as a CHILD (never exec): SIGINT/SIGQUIT go to pi via the TTY's process group; TERM/HUP forwarded. */
function runPiChild(bin, args, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env, stdio: "inherit" });
    const noop = () => {};
    const forward = (sig) => () => {
      try {
        child.kill(sig);
      } catch {
        /* gone */
      }
    };
    const handlers = { SIGINT: noop, SIGQUIT: noop, SIGTERM: forward("SIGTERM"), SIGHUP: forward("SIGHUP") };
    for (const [s, h] of Object.entries(handlers)) process.on(s, h);
    const done = (code) => {
      for (const [s, h] of Object.entries(handlers)) process.off(s, h);
      resolve(code);
    };
    child.on("error", (e) => {
      err(`无法启动 pi：${e && e.message}`);
      done(127);
    });
    child.on("close", (code, signal) => done(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)));
  });
}

export async function main(argv) {
  const [cmd, ...args] = argv;
  try {
    process.chdir("/"); // never pin the vault ourselves; every user path is resolved explicitly
    switch (cmd) {
      case "init":
        return await cmdInit(args);
      case "unlock":
        return await cmdUnlock(args);
      case "lock":
        return await cmdLock(args);
      case "status":
        return await cmdStatus(args);
      case "run":
        return await cmdRun(args);
      case "__mount":
        return await cmdInnerMount(args[0]);
      case "__register":
        // internal: executed by registerVault() UNDER the settings flock
        try {
          registerVaultUnlocked(args[0], args[1], args[2]);
        } catch (e) {
          throw new CliError(EXIT.CONFIG, String(e && e.message));
        }
        return EXIT.OK;
      case undefined:
      case "help":
      case "-h":
      case "--help":
        out(USAGE);
        return cmd === undefined ? EXIT.USAGE : EXIT.OK;
      default:
        err(`未知命令：${cmd}`);
        err(USAGE);
        return EXIT.USAGE;
    }
  } catch (e) {
    if (e instanceof CliError) {
      if (e.message) err(e.message);
      return e.code;
    }
    if (e && e.reportedAlready) return EXIT.FAIL;
    err(`内部错误：${e && e.stack ? e.stack : e}`);
    return EXIT.FAIL;
  }
}

const isEntry = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 22) {
    err(`需要 Node ≥ 22（当前 ${process.version}）`);
    process.exit(EXIT.PREREQ);
  }
  process.exitCode = EXIT.FAIL; // an unsettled main (event loop drained early) must never look like success
  main(process.argv.slice(2)).then(
    (code) => {
      // Exit NOW: a leftover (abandoned) fs request or timer must not keep the launcher alive past
      // its own deadlines. stdout/stderr are synchronous for files, pipes and TTYs on Linux.
      process.exit(code);
    },
    (e) => {
      err(`内部错误：${e}`);
      process.exit(EXIT.FAIL);
    },
  );
}
