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
/** convert-plan §6: 74 = IO / persistence failure (kept out of EXIT so its frozen shape is unchanged). */
const EXIT_IO = 74;
/** Internal codes between the outer launcher and the `__mount` child that runs under flock. */
const INNER_ALREADY = 20;
const FLOCK_TIMEOUT_CODE = 73;

// ───────────────────────────── settings contract (parity with src/secure/config.ts) ─────────────────────────────

/** Key-sorted JSON (CAS comparison of settings entries); undefined ⇒ "undefined". */
function canonicalJson(x) {
  if (x === undefined) return "undefined";
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(",")}]`;
  if (x !== null && typeof x === "object")
    return `{${Object.keys(x)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(x[k])}`)
      .join(",")}}`;
  return JSON.stringify(x);
}

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

const isAbsLiteral = (x) => typeof x === "string" && x.length <= 4096 && path.isAbsolute(x) && !x.includes("\0");

/**
 * convert-plan §4 / §8.2 (V6): `pending` / `origin` / `backup` / `relocate` of one entry, each key
 * validated INDEPENDENTLY (security review V6 #1: one malformed key never drops the others — a
 * valid `pending` survives a malformed `backup`). → {keys, txnInvalid?}: `keys` = the VALID present
 * keys (normalized); `txnInvalid` = the malformed key names in fixed order, present only when
 * non-empty. The ENTRY is never dropped for these keys: it stays a vault (path guards / write
 * redirection keep covering it) and `txnInvalid` makes it LOCKED everywhere (fail closed).
 * Accepts at least everything the V0 writers (`registerVault` / `patchVaultEntry`) can store:
 * pending ⇔ PENDING_RE; origin/backup absolute (or `~/`, expanded like dir/mnt); relocate exactly
 * {from, to (absolute), txid (1–64 printable), phase ([a-z0-9_-]{1,32})}. Parity twin of config.ts.
 */
export function parseTxnKeys(entry, home) {
  const keys = {};
  const bad = [];
  if (entry.pending !== undefined) {
    if (typeof entry.pending === "string" && PENDING_RE.test(entry.pending)) keys.pending = entry.pending;
    else bad.push("pending");
  }
  for (const k of ["origin", "backup"]) {
    if (entry[k] === undefined) continue;
    const p = expandSecurePath(entry[k], home);
    if (p !== undefined && !p.includes("\0") && p.length <= 4096) keys[k] = p;
    else bad.push(k);
  }
  if (entry.relocate !== undefined) {
    const r = entry.relocate;
    if (
      isPlainObject(r) &&
      Object.keys(r).every((k) => k === "from" || k === "to" || k === "txid" || k === "phase") &&
      isAbsLiteral(r.from) &&
      isAbsLiteral(r.to) &&
      typeof r.txid === "string" &&
      /^[!-~]{1,64}$/.test(r.txid) &&
      typeof r.phase === "string" &&
      /^[a-z0-9_-]{1,32}$/.test(r.phase)
    )
      keys.relocate = { from: path.resolve(r.from), to: path.resolve(r.to), txid: r.txid, phase: r.phase };
    else bad.push("relocate");
  }
  return bad.length ? { keys, txnInvalid: bad } : { keys };
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
    // private-plan §1.1: `private` must be a boolean when present (else invalid reason "private");
    // only `true` surfaces on the vault object (absent key ⇔ false — keeps the F4 parity shape).
    if (entry.private !== undefined && typeof entry.private !== "boolean") {
      invalid.push({ name, reason: "private" });
      continue;
    }
    // convert-plan §4 / V6: the transaction keys (absent ⇒ no key on the vault object).
    const t = parseTxnKeys(entry, home);
    const txn = { keys: t.txnInvalid ? { ...t.keys, txnInvalid: t.txnInvalid } : t.keys };
    const oldDefaultLink = defaultVaultMnt(name, home);
    // Legacy recognition (§L.3): a `link` key always means the pre-L0 layout; an entry without
    // `mnt` whose `<dir>/mnt` exists as a directory on disk does too. The link VALUE only feeds
    // D4's known-address set (review L0 #3), never validated as a vault.
    if (entry.link !== undefined) {
      vaults.push({
        ...deriveLegacyVault(name, dir, expandSecurePath(entry.link, home) ?? oldDefaultLink),
        ...txn.keys,
      });
      continue;
    }
    const mntExplicit = entry.mnt !== undefined;
    const mnt = mntExplicit ? expandSecurePath(entry.mnt, home) : defaultVaultMnt(name, home);
    if (mnt === undefined) {
      invalid.push({ name, reason: "mnt" });
      continue;
    }
    if (!mntExplicit && (io?.legacyMntDir ?? legacyMntDirProbe)(path.join(dir, "mnt")) === true) {
      vaults.push({ ...deriveLegacyVault(name, dir, oldDefaultLink), ...txn.keys });
      continue;
    }
    vaults.push({ ...deriveVault(name, dir, mnt), ...(entry.private === true ? { private: true } : {}), ...txn.keys });
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

export function lstatOrNull(p) {
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

// ───────────────────────────── user settings file (<agentDir>/pi-toolkit.json, legacy pi-subagent.json) ─────────────────────────────
// Mirror of src/secure/settings-lock.ts (file-name resolution S0–S7, location, write-time heal) —
// parity: tests/secure/settings-file-resolve.test.ts / settings-file-heal.test.ts. The launcher NEVER initiates the legacy→new
// migration; it only completes an existing crash-window S6a (healSettingsFileLocked) before it writes.

export const SETTINGS_FILE_NAME = "pi-toolkit.json";
export const LEGACY_SETTINGS_FILE_NAME = "pi-subagent.json";

export function homeDir() {
  return os.homedir();
}

function settingsProbe(p, lstat) {
  try {
    const st = lstat(p);
    return { type: st.isSymbolicLink() ? "symlink" : st.isFile() ? "file" : "other", st };
  } catch (e) {
    return e && (e.code === "ENOENT" || e.code === "ENOTDIR") ? { type: "none" } : { type: "other" };
  }
}
function settingsSameInode(a, b) {
  return a.st !== undefined && b.st !== undefined && a.st.dev === b.st.dev && a.st.ino === b.st.ino;
}
function settingsTry(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** S0–S7 (plan §3.3). Pure read, never throws. deps: {lstat, readlink, realpath} test seams. */
export function resolveSettingsFile(dir, deps = {}) {
  const lstat = deps.lstat ?? ((p) => fs.lstatSync(p));
  const readlink = deps.readlink ?? ((p) => fs.readlinkSync(p));
  const realpath = deps.realpath ?? ((p) => fs.realpathSync(p));
  const newPath = path.join(dir, SETTINGS_FILE_NAME);
  const legacyPath = path.join(dir, LEGACY_SETTINGS_FILE_NAME);
  const n = settingsProbe(newPath, lstat);
  const l = settingsProbe(legacyPath, lstat);
  const isCompatLink = () => {
    const target = settingsTry(() => readlink(legacyPath));
    if (target === SETTINGS_FILE_NAME || target === newPath) return true;
    const rl = settingsTry(() => realpath(legacyPath));
    const rn = settingsTry(() => realpath(newPath));
    return rl !== undefined && rn !== undefined && rl === rn;
  };
  if (n.type !== "none") {
    let legacy;
    if (l.type === "none") legacy = "absent";
    else if (l.type === "symlink") legacy = isCompatLink() ? "compat-link" : "conflict";
    else if (l.type === "file" && n.type === "file" && settingsSameInode(n, l)) legacy = "same-inode";
    else legacy = "conflict";
    const legacyNewer =
      legacy === "conflict" && l.type === "file" && n.st !== undefined && l.st !== undefined
        ? l.st.mtimeMs > n.st.mtimeMs
        : undefined;
    return {
      kind: "new",
      path: newPath,
      newPath,
      legacyPath,
      legacy,
      ...(legacyNewer === undefined ? {} : { legacyNewer }),
    };
  }
  if (l.type === "none") return { kind: "none", path: newPath, newPath, legacyPath, compatLinkDangling: false };
  if (l.type === "symlink") {
    const target = settingsTry(() => readlink(legacyPath));
    if (target === SETTINGS_FILE_NAME || target === newPath)
      return { kind: "none", path: newPath, newPath, legacyPath, compatLinkDangling: true };
    return { kind: "legacy", path: legacyPath, newPath, legacyPath, legacyType: "symlink" };
  }
  return { kind: "legacy", path: legacyPath, newPath, legacyPath, legacyType: l.type === "file" ? "file" : "other" };
}

/** Directory tiers over the file-name level (default / agentDir / inherited, plan §3.3). */
export function resolveSettingsLocation(agent, deps = {}) {
  const primary = resolveSettingsFile(agent.dir, deps);
  if (agent.source === "default") return { ...primary, scope: "default", agent };
  if (primary.kind !== "none" || primary.compatLinkDangling) return { ...primary, scope: "agentDir", agent };
  const home = resolveSettingsFile(agent.home, deps);
  if (home.kind !== "none") return { ...home, scope: "inherited", agent };
  return { ...primary, scope: "agentDir", agent };
}

const SETTINGS_LNK_RE = /^pi-subagent\.json\.[0-9a-f]{16}\.lnk$/;
function settingsLnkSuffix() {
  return `${process.pid.toString(16)}${Date.now().toString(16)}`.padStart(16, "0").slice(-16);
}
function settingsCleanupLnk(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!SETTINGS_LNK_RE.test(name)) continue;
    const full = path.join(dir, name);
    try {
      if (fs.lstatSync(full).isSymbolicLink()) fs.unlinkSync(full);
    } catch {
      /* best effort */
    }
  }
}

/**
 * LOCK-HELD ONLY (plan §3.4.1): completes a crash-window S6a (two names, ONE inode) into S5 — compat
 * symlink swapped over the legacy name. Every other state is a no-op. Never throws.
 * → "healed" | "reverted-to-legacy" | "noop" | "conflict". deps: {lstat, symlink, readlink, realpath}.
 */
export function healSettingsFileLocked(dir, deps = {}) {
  try {
    const lstat = deps.lstat ?? ((p) => fs.lstatSync(p));
    const st = resolveSettingsFile(dir, deps);
    if (!(st.kind === "new" && st.legacy === "same-inode")) return "noop";
    settingsCleanupLnk(dir);
    const newPath = path.join(dir, SETTINGS_FILE_NAME);
    const legacyPath = path.join(dir, LEGACY_SETTINGS_FILE_NAME);
    const lnk = path.join(dir, `pi-subagent.json.${settingsLnkSuffix()}.lnk`);
    try {
      (deps.symlink ?? ((t, p) => fs.symlinkSync(t, p)))(SETTINGS_FILE_NAME, lnk);
    } catch {
      if (settingsSameInode(settingsProbe(newPath, lstat), settingsProbe(legacyPath, lstat))) {
        try {
          fs.unlinkSync(newPath);
        } catch {
          return "noop";
        }
        return "reverted-to-legacy";
      }
      return "conflict";
    }
    const n = settingsProbe(newPath, lstat);
    const l = settingsProbe(legacyPath, lstat);
    if (!(n.type === "file" && l.type === "file" && settingsSameInode(n, l))) {
      settingsTry(() => fs.unlinkSync(lnk));
      return "conflict";
    }
    try {
      fs.renameSync(lnk, legacyPath);
    } catch {
      settingsTry(() => fs.unlinkSync(lnk));
      return "noop";
    }
    return "healed";
  } catch {
    return "noop";
  }
}

/** The launcher's settings file: new name when it exists / is a dangling compat target, else the legacy
 *  name — and with NO settings file at all the legacy name (拍板②: keeps the A′ golden byte-identical). */
export function settingsFilePath(home = homeDir(), env = process.env) {
  const loc = resolveSettingsLocation(resolveAgentDir(env, home));
  if (loc.kind !== "none" || loc.compatLinkDangling) return loc.path;
  return path.join(path.dirname(loc.newPath), LEGACY_SETTINGS_FILE_NAME);
}

/** Write-time heal + resolve, to be called INSIDE the settings lock before reading the target. */
function healedSettingsFilePath(home, env = process.env) {
  healSettingsFileLocked(path.dirname(settingsFilePath(home, env)));
  return settingsFilePath(home, env);
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

/** First registered vault whose dir/mnt nests with the (env-selected) agentDir — lexical AND physical. */
export function agentDirVaultOverlap(agentDir, vaults) {
  const lex = path.resolve(agentDir);
  const phys = realpathNearest(lex);
  const nested = (a, b) => pathWithin(a, b) || pathWithin(b, a);
  return vaults.find(
    (v) =>
      nested(lex, path.resolve(v.dir)) ||
      nested(lex, path.resolve(v.mnt)) ||
      nested(phys, realpathNearest(v.dir)) ||
      nested(phys, path.join(realpathNearest(path.dirname(v.mnt)), path.basename(v.mnt))),
  );
}

/**
 * {file, cfg, readError?, agentProblem?}. S6b (two diverging settings files): their `secure` sections
 * must agree, else an INVALID config (fail-closed ⇒ run/unlock exit 78). An env-selected agentDir
 * nested with a registered vault ⇒ `agentProblem` (resolveVault refuses; status prints it).
 */
export function loadSecureConfig(home = homeDir(), env = process.env) {
  const agent = resolveAgentDir(env, home);
  const loc = resolveSettingsLocation(agent);
  const file = loc.kind === "none" && !loc.compatLinkDangling ? settingsFilePath(home, env) : loc.path;
  const r = readJsonFile(file);
  if (r.kind === "error") return { file, readError: r.message, cfg: parseSecureConfig(undefined, home) };
  if (loc.kind === "new" && loc.legacy === "conflict") {
    const o = readJsonFile(loc.legacyPath);
    if (o.kind === "error") return { file, readError: o.message, cfg: parseSecureConfig(undefined, home) };
    if (o.kind === "ok") {
      const secureOf = (x) => (x.kind === "ok" && isPlainObject(x.value) ? x.value.secure : undefined);
      if (canonicalJson(secureOf(r)) !== canonicalJson(secureOf(o)))
        return {
          file,
          cfg: {
            present: true,
            enabled: true,
            valid: false,
            vaults: [],
            invalid: [],
            error: `两份设置文件的 secure 段不一致：${loc.newPath} 与 ${loc.legacyPath}（请手动合并到 ${SETTINGS_FILE_NAME} 后删除或改名 ${LEGACY_SETTINGS_FILE_NAME}）`,
          },
        };
    }
  }
  const cfg = parseSecureConfig(r.kind === "ok" ? r.value : undefined, home);
  if (agent.source === "env" && cfg.valid && cfg.enabled) {
    const hit = agentDirVaultOverlap(agent.dir, cfg.vaults);
    if (hit)
      return {
        file,
        cfg,
        agentProblem: `PI_CODING_AGENT_DIR（${agent.dir}）位于保险库 ${hit.name} 内：不支持（设置登记会藏进它自己描述的保险库）`,
      };
  }
  return { file, cfg };
}

export const SETTINGS_LOCK_NAME = ".pi-subagent.json.lock";
export const SETTINGS_LOCK_WAIT_S = 10;
export function settingsLockPath(home = homeDir(), env = process.env) {
  return path.join(path.dirname(settingsFilePath(home, env)), SETTINGS_LOCK_NAME);
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

/**
 * V0 (convert-plan §1.4/§3.3): transaction marker on a vault entry — `"<op>:<txid>"`
 * (`convert:<txid>` / `import:<txid>`). While present the vault is mid-transaction; V6 wires the
 * unlock/run/export refusals, V0 only writes/clears it. Prefix keeps its own namespace.
 */
export const PENDING_RE = /^[a-z][a-z0-9]{0,15}:[!-~]{1,64}$/;
/** Entry keys a convert/import transaction may touch through patchVaultEntry (V0 allowlist). */
export const TXN_ENTRY_KEYS = ["origin", "backup", "pending", "relocate"];

function assertVaultEntryShape(entry) {
  if (!isPlainObject(entry)) throw new Error("登记条目须为对象 {dir, mnt, private?}");
  for (const k of Object.keys(entry))
    if (k !== "dir" && k !== "mnt" && k !== "private")
      throw new Error(`登记条目不认识键 ${JSON.stringify(k)}（允许：dir/mnt/private）`);
  for (const k of ["dir", "mnt"])
    if (typeof entry[k] !== "string" || !path.isAbsolute(entry[k]) || entry[k].length > 4096 || entry[k].includes("\0"))
      throw new Error(`登记条目 ${k} 须为绝对路径字符串（≤4096）：${JSON.stringify(entry[k])}`);
  if (entry.private !== undefined && typeof entry.private !== "boolean") throw new Error("登记条目 private 须为布尔值");
}

/** Shared read side of every settings mutation: same refusals as registerVaultUnlocked. */
function loadMutableSettings(file) {
  const st = assertWritableSettingsFile(file);
  const r = readJsonFile(file);
  if (r.kind === "error") throw new Error(`拒绝改写设置文件：${r.message}`);
  const root = r.kind === "ok" ? r.value : {};
  if (!isPlainObject(root)) throw new Error(`拒绝改写设置文件：${file} 顶层不是对象`);
  if (root.secure !== undefined && !isPlainObject(root.secure))
    throw new Error(`拒绝改写设置文件：${file} 的 secure 不是对象`);
  return { st, root };
}

function mutableVaults(secure, file) {
  if (secure.vaults !== undefined && !isPlainObject(secure.vaults))
    throw new Error(`拒绝改写设置文件：${file} 的 secure.vaults 不是对象`);
  return secure.vaults ?? {};
}

/** Re-read → merge → write, all inside the settings lock (see withSettingsLock).
 *  V0 (convert-plan §8.1): `expectAbsent` turns the write into a CLAIM — an existing key (any
 *  value, even a broken one) refuses so same-name init/import/convert races leave exactly one
 *  winner; `pending` stamps the transaction marker onto the freshly claimed entry. */
export function registerVaultUnlocked(
  name,
  dir,
  mnt,
  home = homeDir(),
  { private: priv = false, expectAbsent = false, expectEntry, pending } = {},
) {
  if (typeof name !== "string" || !VAULT_NAME_RE.test(name))
    throw new Error(`保险库名不合法：${JSON.stringify(name)}（需匹配 ${VAULT_NAME_RE}）`);
  if (pending !== undefined && (typeof pending !== "string" || !PENDING_RE.test(pending)))
    throw new Error(`pending 须匹配 ${PENDING_RE}：${JSON.stringify(pending)}`);
  fs.mkdirSync(path.dirname(settingsFilePath(home)), { recursive: true, mode: 0o700 });
  const file = healedSettingsFilePath(home);
  const { st, root } = loadMutableSettings(file);
  const secure = { ...(root.secure ?? {}) };
  const vaults = mutableVaults(secure, file);
  if (expectAbsent && Object.hasOwn(vaults, name))
    throw new Error(`保险库名 ${name} 已在 ${file} 登记（expectAbsent 认领失败）；未改动任何内容`);
  // Security review V6 #2: compare-and-swap against the entry the caller read earlier.
  if (expectEntry !== undefined && canonicalJson(vaults[name]) !== canonicalJson(expectEntry))
    throw new Error(`保险库 ${name} 的登记项已被其他操作改动（CAS 失败）；未改动任何内容`);
  // N2: `private: true` only when requested (absent key ⇔ ordinary vault, byte-identical entry);
  // V0: `pending` rides only on transactional claims.
  secure.vaults = {
    ...vaults,
    [name]: { dir, mnt, ...(priv ? { private: true } : {}), ...(pending !== undefined ? { pending } : {}) },
  };
  const next = { ...root, secure };
  writeFileAtomic(file, JSON.stringify(next, null, 2) + "\n", settingsWriteMode(st));
}

/** Create/verify the settings lock file, then run `node helper.mjs <args…>` under
 *  `flock -E 73 -w <lockWaitS>` synchronously. Typed errors per convert-plan §6: lock-busy ⇒ 73
 *  (LOCK_BUSY), spawn failure ⇒ 69 (PREREQ), a non-regular/foreign lock file ⇒ 78 (CONFIG). */
function spawnUnderSettingsLock(home, lockWaitS, args) {
  const lockFile = settingsLockPath(home);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(lockFile, fsc.O_RDONLY | fsc.O_CREAT | fsc.O_NOFOLLOW | fsc.O_NONBLOCK, 0o600);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid())
      throw new CliError(EXIT.CONFIG, `设置锁文件 ${lockFile} 不是本用户的普通文件`);
  } finally {
    fs.closeSync(fd);
  }
  const self = fileURLToPath(import.meta.url);
  const r = spawnSync(
    "flock",
    ["-E", String(FLOCK_TIMEOUT_CODE), "-w", String(lockWaitS), lockFile, process.execPath, self, ...args],
    {
      encoding: "utf8",
      timeout: Math.ceil((lockWaitS + 10) * 1000),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: home },
    },
  );
  if (r.error) throw new CliError(EXIT.PREREQ, `无法执行 flock：${r.error.message}`);
  if (r.status === FLOCK_TIMEOUT_CODE)
    throw new CliError(EXIT.LOCK_BUSY, `设置文件锁 ${lockFile} 等待超时（另一个进程正在改写设置）`);
  return r;
}

const childErrText = (r, what) =>
  (r.stderr || "").replace(/^pi-secure: /gm, "").trim() || `${what}失败（exit ${r.status}）`;

/**
 * V0 (convert-plan §8.1/§8.2): `registerVault(name, entry, {expectAbsent, pending})` — the unified
 * name CLAIM used by init (N2 call site migrated 1:1, byte-identical entries), convert §1.4 step 2
 * and import §3.3 step 1. `entry` = `{dir, mnt, private?}`. Throws CliError: 73 (settings lock
 * busy), 69 (flock missing), 78 (expectAbsent lost the race / settings file refused / bad child).
 * `pending` (validated by PENDING_RE) lands on the entry as the transaction marker.
 */
export function registerVault(
  name,
  entry,
  { home = homeDir(), expectAbsent = false, expectEntry, pending, lockWaitS = SETTINGS_LOCK_WAIT_S } = {},
) {
  if (typeof name !== "string" || !VAULT_NAME_RE.test(name))
    throw new Error(`保险库名不合法：${JSON.stringify(name)}（需匹配 ${VAULT_NAME_RE}）`);
  assertVaultEntryShape(entry);
  if (pending !== undefined && (typeof pending !== "string" || !PENDING_RE.test(pending)))
    throw new Error(`pending 须匹配 ${PENDING_RE}：${JSON.stringify(pending)}`);
  const r = spawnUnderSettingsLock(home, lockWaitS, [
    "__register",
    name,
    entry.dir,
    entry.mnt,
    ...(entry.private ? ["--private"] : []),
    ...(expectAbsent ? ["--expect-absent"] : []),
    ...(expectEntry !== undefined ? ["--expect-entry", JSON.stringify(expectEntry)] : []),
    ...(pending !== undefined ? ["--pending", pending] : []),
  ]);
  if (r.status !== 0) throw new CliError(EXIT.CONFIG, childErrText(r, "登记"));
}

// ─────────────────── transactional entry patch/remove (V0: 「仅本 txid」清除) ───────────────────

function assertAbsPathValue(v, what) {
  if (typeof v !== "string" || !path.isAbsolute(v) || v.length > 4096 || v.includes("\0"))
    throw new Error(`${what} 须为绝对路径字符串（≤4096）：${JSON.stringify(v)}`);
}

/** convert-plan §3.4 relocate marker {from,to,txid,phase}; V0 only stores it, V5 owns the phases. */
function assertRelocateShape(rel) {
  if (!isPlainObject(rel)) throw new Error("relocate 须为对象 {from, to, txid, phase}");
  for (const k of Object.keys(rel))
    if (k !== "from" && k !== "to" && k !== "txid" && k !== "phase")
      throw new Error(`relocate 不认识键 ${JSON.stringify(k)}`);
  assertAbsPathValue(rel.from, "relocate.from");
  assertAbsPathValue(rel.to, "relocate.to");
  if (typeof rel.txid !== "string" || !/^[!-~]{1,64}$/.test(rel.txid))
    throw new Error(`relocate.txid 须为 1–64 个可打印字符：${JSON.stringify(rel.txid)}`);
  if (typeof rel.phase !== "string" || !/^[a-z0-9_-]{1,32}$/.test(rel.phase))
    throw new Error(`relocate.phase 须为 1–32 个 [a-z0-9_-] 字符：${JSON.stringify(rel.phase)}`);
}

/** Guard = the txid proof a patch/remove must present. At least one condition; unconditional
 *  mutation of a registration is not part of the V0 surface (convert-plan I-C8). */
function assertTxnGuard(guard, { requirePending = false } = {}) {
  if (!isPlainObject(guard)) throw new Error("guard 须为对象 {pending?, relocateTxid?}");
  for (const k of Object.keys(guard))
    if (k !== "pending" && k !== "relocateTxid") throw new Error(`guard 不认识键 ${JSON.stringify(k)}`);
  if (guard.pending !== undefined && (typeof guard.pending !== "string" || !PENDING_RE.test(guard.pending)))
    throw new Error(`guard.pending 须匹配 ${PENDING_RE}：${JSON.stringify(guard.pending)}`);
  if (
    guard.relocateTxid !== undefined &&
    (typeof guard.relocateTxid !== "string" || !/^[!-~]{1,64}$/.test(guard.relocateTxid))
  )
    throw new Error("guard.relocateTxid 须为 1–64 个可打印字符");
  if (requirePending && guard.pending === undefined)
    throw new Error("该操作要求 guard.pending（只对登记时带本 txid pending 的条目生效，convert-plan I-C8）");
  if (!requirePending && guard.pending === undefined && guard.relocateTxid === undefined)
    throw new Error("guard 至少要有一个条件（pending 或 relocateTxid）——不提供无条件修改");
}

function assertTxnPatch(patch) {
  if (!isPlainObject(patch)) throw new Error("patch 须为对象 {set?, remove?}");
  for (const k of Object.keys(patch))
    if (k !== "set" && k !== "remove") throw new Error(`patch 不认识键 ${JSON.stringify(k)}`);
  const set = patch.set ?? {};
  const remove = patch.remove ?? [];
  if (patch.set !== undefined && !isPlainObject(patch.set)) throw new Error("patch.set 须为对象");
  if (!Array.isArray(remove) || remove.some((k) => typeof k !== "string"))
    throw new Error("patch.remove 须为字符串数组");
  for (const k of [...Object.keys(set), ...remove]) {
    if (!TXN_ENTRY_KEYS.includes(k))
      throw new Error(`patch 键 ${JSON.stringify(k)} 不在允许清单 ${JSON.stringify(TXN_ENTRY_KEYS)} 内`);
    if (Object.hasOwn(set, k) && remove.includes(k))
      throw new Error(`patch 键 ${JSON.stringify(k)} 不能同时 set 与 remove`);
  }
  if (set.origin !== undefined) assertAbsPathValue(set.origin, "set.origin");
  if (set.backup !== undefined) assertAbsPathValue(set.backup, "set.backup");
  if (set.pending !== undefined && (typeof set.pending !== "string" || !PENDING_RE.test(set.pending)))
    throw new Error(`set.pending 须匹配 ${PENDING_RE}`);
  if (set.relocate !== undefined) assertRelocateShape(set.relocate);
}

/**
 * The「仅本 txid」half of V0, run UNDER the settings lock by patchVaultEntry: re-read the entry,
 * require EVERY given guard condition to match its CURRENT value, then apply `{set?, remove?}`
 * atomically. → {kind:"ok", entry} | {kind:"missing"} | {kind:"mismatch", reason} (no write).
 * This is convert §1.4 step 14 (clear pending + write origin/backup = the ONLY commit point) and
 * import §3.3 step 7 / §3.4 step 5 (clear pending / relocate once the transaction owns it).
 */
export function patchVaultEntryUnlocked(name, guard, patch, home = homeDir()) {
  if (typeof name !== "string" || !VAULT_NAME_RE.test(name))
    throw new Error(`保险库名不合法：${JSON.stringify(name)}（需匹配 ${VAULT_NAME_RE}）`);
  assertTxnGuard(guard);
  assertTxnPatch(patch);
  const file = healedSettingsFilePath(home);
  if (!lstatOrNull(file)) return { kind: "missing" }; // nothing claimed — never create for a patch
  const { st, root } = loadMutableSettings(file);
  const secure = { ...(root.secure ?? {}) };
  const vaults = mutableVaults(secure, file);
  if (!Object.hasOwn(vaults, name)) return { kind: "missing" };
  const cur = vaults[name];
  if (!isPlainObject(cur)) return { kind: "mismatch", reason: `secure.vaults.${name} 不是对象` };
  if (guard.pending !== undefined && cur.pending !== guard.pending)
    return {
      kind: "mismatch",
      reason: `pending 现为 ${JSON.stringify(cur.pending)}，要求 ${JSON.stringify(guard.pending)}`,
    };
  if (guard.relocateTxid !== undefined && !(isPlainObject(cur.relocate) && cur.relocate.txid === guard.relocateTxid))
    return {
      kind: "mismatch",
      reason: `relocate.txid 现为 ${
        isPlainObject(cur.relocate) ? JSON.stringify(cur.relocate.txid) : "缺失"
      }，要求 ${JSON.stringify(guard.relocateTxid)}`,
    };
  const next = { ...cur, ...(patch.set ?? {}) };
  for (const k of patch.remove ?? []) delete next[k];
  secure.vaults = { ...vaults, [name]: next };
  writeFileAtomic(file, JSON.stringify({ ...root, secure }, null, 2) + "\n", settingsWriteMode(st));
  return { kind: "ok", entry: next };
}

/** Rollback half (convert §1.6 R-A / import recovery): delete the WHOLE entry, but only when it
 *  still carries OUR pending marker — a committed (pending cleared) or foreign entry is never
 *  removed. → {kind:"ok"} | {kind:"missing"} | {kind:"mismatch", reason} (no write). */
export function removeVaultEntryUnlocked(name, guard, home = homeDir()) {
  if (typeof name !== "string" || !VAULT_NAME_RE.test(name))
    throw new Error(`保险库名不合法：${JSON.stringify(name)}（需匹配 ${VAULT_NAME_RE}）`);
  assertTxnGuard(guard, { requirePending: true });
  const file = healedSettingsFilePath(home);
  if (!lstatOrNull(file)) return { kind: "missing" };
  const { st, root } = loadMutableSettings(file);
  const secure = { ...(root.secure ?? {}) };
  const vaults = mutableVaults(secure, file);
  if (!Object.hasOwn(vaults, name)) return { kind: "missing" };
  const cur = vaults[name];
  if (!isPlainObject(cur))
    return { kind: "mismatch", reason: `secure.vaults.${name} 不是对象（无法证明属于本事务，不删除）` };
  if (cur.pending !== guard.pending)
    return {
      kind: "mismatch",
      reason: `pending 现为 ${JSON.stringify(cur.pending)}，要求 ${JSON.stringify(guard.pending)}（已提交或他人持有——不删除）`,
    };
  const rest = { ...vaults };
  delete rest[name];
  secure.vaults = rest;
  writeFileAtomic(file, JSON.stringify({ ...root, secure }, null, 2) + "\n", settingsWriteMode(st));
  return { kind: "ok" };
}

/** Locked wrapper (settings flock child `__vault-patch`). Same result kinds; throws CliError
 *  73/69/78 exactly like registerVault. `lockWaitS` is a test seam (default 10 s). */
export function patchVaultEntry(name, guard, patch, { home = homeDir(), lockWaitS = SETTINGS_LOCK_WAIT_S } = {}) {
  if (typeof name !== "string" || !VAULT_NAME_RE.test(name))
    throw new Error(`保险库名不合法：${JSON.stringify(name)}（需匹配 ${VAULT_NAME_RE}）`);
  assertTxnGuard(guard);
  assertTxnPatch(patch);
  const r = spawnUnderSettingsLock(home, lockWaitS, [
    "__vault-patch",
    name,
    JSON.stringify(guard),
    JSON.stringify(patch),
  ]);
  if (r.status !== 0) throw new CliError(EXIT.CONFIG, childErrText(r, "修改登记"));
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new CliError(EXIT.FAIL, `__vault-patch 输出无法解析：${String(r.stdout).slice(0, 200)}`);
  }
}

/** Locked wrapper (settings flock child `__vault-remove`). */
export function removeVaultEntry(name, guard, { home = homeDir(), lockWaitS = SETTINGS_LOCK_WAIT_S } = {}) {
  if (typeof name !== "string" || !VAULT_NAME_RE.test(name))
    throw new Error(`保险库名不合法：${JSON.stringify(name)}（需匹配 ${VAULT_NAME_RE}）`);
  assertTxnGuard(guard, { requirePending: true });
  const r = spawnUnderSettingsLock(home, lockWaitS, ["__vault-remove", name, JSON.stringify(guard)]);
  if (r.status !== 0) throw new CliError(EXIT.CONFIG, childErrText(r, "删除登记"));
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new CliError(EXIT.FAIL, `__vault-remove 输出无法解析：${String(r.stdout).slice(0, 200)}`);
  }
}

/**
 * {kind:"ok", vault, registered} | {kind:"error", code, message}. `allowUnregistered` (init only)
 * derives the default paths for a name that is not in settings yet.
 */
export function resolveVault(name, { allowUnregistered = false, home = homeDir(), allowAgentInVault = false } = {}) {
  if (typeof name !== "string" || !VAULT_NAME_RE.test(name))
    return {
      kind: "error",
      code: EXIT.USAGE,
      message: `保险库名不合法：${JSON.stringify(name)}（需匹配 ${VAULT_NAME_RE}）`,
    };
  const { file, cfg, readError, agentProblem } = loadSecureConfig(home);
  if (readError) return { kind: "error", code: EXIT.CONFIG, message: `设置文件无法读取：${readError}` };
  if (!cfg.valid) return { kind: "error", code: EXIT.CONFIG, message: `${file}：${cfg.error}` };
  if (agentProblem && !allowAgentInVault) return { kind: "error", code: EXIT.CONFIG, message: agentProblem };
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
 *
 * N2 review #2: `deps.unmappedUid` (status inside a NON-initial user namespace only — see
 * userNsUnmappedUid) is the overflow uid every unmapped host owner (root included) reads as there;
 * a level owned by it cannot be judged from inside, so its owner/write rules are skipped and the
 * level is reported through `deps.onIndeterminate(path)` instead of as a problem. Never used for
 * mount ADMISSION: the full chain is enforced in the initial namespace (`__mount`, and the
 * `__private-claim` before any private namespace exists).
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
    if (deps.unmappedUid !== undefined && st.uid === deps.unmappedUid && st.uid !== uid) {
      deps.onIndeterminate?.(cur); // owner unknowable from inside this user namespace
    } else if (st.uid !== uid && st.uid !== 0) {
      problems.push(`${cur} 属于其他用户（uid ${st.uid}），不可作为挂载点祖先（须为本用户或 root）`);
      break;
    } else {
      const sticky = (st.mode & 0o1000) !== 0;
      if ((st.mode & 0o022) !== 0 && !(st.uid === 0 && sticky)) {
        problems.push(
          `${cur} 对组/其他可写${sticky ? "但属主非 root" : "且无 sticky 位"}，其他用户可替换其下的路径，拒绝`,
        );
        break;
      }
    }
    if (cur === path.dirname(cur)) break; // reached "/"
    cur = path.dirname(cur);
  }
  return problems;
}

/**
 * V8 (convert-plan §8; main-session ruling): the SIDE-EFFECT-FREE preflight of createLayout's
 * position and mount-point ancestor rules, so convert/import refuse at step 0 — before any
 * confirmation prompt, name claim or password — instead of after the claim. It calls the SAME
 * functions (positionProblems, mntAncestorProblems) and relaxes nothing; the step-2 / publish
 * checks stay as defense in depth. The one thing createLayout may still create is the DEFAULT
 * parent `~/secure` (mkdir 0700 by this uid ⇒ a compliant level by construction): when it is
 * missing, the chain it will hang under (its own ancestors) is checked instead. A missing
 * non-default parent is refused exactly like createLayout does. Returns null (all clear) or
 * `{title, lines}` (exit 78). `deps.lstat` is the mntAncestorProblems test seam.
 */
export function layoutPreflightProblems(v, { others = [], home = homeDir(), uid = process.getuid(), lstat } = {}) {
  const pos = positionProblems(v, others, home);
  if (pos.length) return { title: "位置检查失败：", lines: pos };
  const parent = path.dirname(path.resolve(v.mnt));
  let probe = v;
  if (!lstatOrNull(parent)) {
    if (path.resolve(v.mnt) !== path.resolve(defaultVaultMnt(v.name, home)))
      return {
        title: `挂载点父目录 ${parent} 不存在（仅缺省 ~/secure 会自动创建，其他位置请先自建）`,
        lines: [],
      };
    probe = { ...v, mnt: parent }; // ~/secure will be created 0700 by us: judge the chain above it
  }
  const pp = mntAncestorProblems(probe, uid, lstat ? { lstat } : {});
  if (pp.length) return { title: "挂载点祖先目录检查失败：", lines: pp };
  return null;
}

/**
 * N2 review #2: inside a non-initial user namespace (uid_map is not the identity map) return the
 * overflow uid unmapped owners show as; undefined in the initial namespace (host rules unchanged).
 * Pure: facts = {uidMap, overflowUid}.
 */
export function userNsUnmappedUid({ uidMap, overflowUid } = {}) {
  const norm = (uidMap ?? "").trim().split(/\s+/).join(" ");
  if (norm === "" || norm === "0 0 4294967295") return undefined;
  const n = Number.parseInt(String(overflowUid ?? "").trim(), 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : 65534;
}

function currentUnmappedUid() {
  return userNsUnmappedUid({
    uidMap: readTextOr("/proc/self/uid_map", ""),
    overflowUid: readTextOr("/proc/sys/kernel/overflowuid", "65534"),
  });
}

/**
 * Problems with the on-disk layout. `mounted` skips the sentinel checks (the mount hides them).
 * New layout: `<dir>` side (cipher/conf/lock/lease) + `<mnt>` side (0700 dir, sentinels when
 * unmounted, parent rule, position rules). Legacy (§L.3): exactly the old checks — no lease and no
 * parent/position rules; when a legacy vault is mounted its sentinels are hidden as well.
 */
export function checkLayout(
  v,
  {
    mounted = false,
    uid = process.getuid(),
    others = [],
    home = homeDir(),
    ancestors = true,
    unmappedUid, // status only (N2 review #2): see mntAncestorProblems
  } = {},
) {
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
  const indeterminate = [];
  if (v.layout !== "legacy" && ancestors)
    problems.push(...mntAncestorProblems(v, uid, { unmappedUid, onIndeterminate: (p) => indeterminate.push(p) }));
  return { exists: true, problems, ...(indeterminate.length ? { indeterminate } : {}) };
}

/**
 * Security review L0 #4: recovery hint for an interrupted init — the new layout leaves BOTH the
 * metadata dir and the mount point behind. Commands only: the mount point must be confirmed
 * unmounted and sentinel-only before removal (extra entries are listed for MANUAL inspection —
 * they may be plaintext written under the mount point while locked). Since the init-cleanup ruling
 * (2026-10-24) init removes its OWN identity-recorded objects itself (removeInitVault); this hint
 * is printed for whatever that cleanup could not prove and therefore kept.
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

export function requireNewLayout(v) {
  if (v.layout === "legacy") throw new CliError(EXIT.CONFIG, legacyRefusal(v));
}

/** Text of the §3.5 pending refusal (76): which command finishes / undoes the transaction. */
export function pendingRefusal(v) {
  const p = v.pending ?? "";
  const at = p.indexOf(":");
  const op = at > 0 ? p.slice(0, at) : "convert";
  const txid = at > 0 ? p.slice(at + 1) : p;
  const kind = op === "import" ? "import" : "convert";
  return `保险库 ${v.name} 有未完成的${kind === "import" ? "导入" : "转换"}（${txid}）：pi-secure ${kind} --resume|--abort ${v.name}`;
}

/** §3.4 relocation refusal (78). */
export function relocateRefusal(v) {
  return `保险库 ${v.name} 迁址未完成：pi-secure init ${v.name} --fix-settings 继续`;
}

/** Review V6 #1: refusal text for a vault whose transaction keys are malformed (78). */
export function txnInvalidRefusal(v) {
  return `保险库 ${v.name} 的事务键损坏（${v.txnInvalid.join(", ")}），按锁定处理：请人工核对 ${settingsFilePath()} 中 secure.vaults.${v.name} 的这些键`;
}

/** `.txn/convert-<name>.json` / `.txn/import-<name>.json` that exist (any type; lstat only). */
export function txnStateFilesFor(name, home = homeDir()) {
  const txn = path.join(home, ".local", "share", "pi-toolkit-secure", ".txn");
  return [`convert-${name}.json`, `import-${name}.json`].map((f) => path.join(txn, f)).filter((f) => lstatOrNull(f));
}

/** Text of the refusal for a name that still has convert/import state files (76). */
export function txnStateRefusal(name, files) {
  const kind = files.some((f) => path.basename(f).startsWith("import-")) ? "import" : "convert";
  return `保险库 ${name} 有未完成的${kind === "import" ? "导入" : "转换"}状态文件（${files.join(", ")}）：pi-secure ${kind} --resume|--abort ${name}`;
}

/**
 * convert-plan §3.5 / §3.4 (V6 + security review): `unlock` / `run` (incl. --private) /
 * `init --fix-settings` / plain `init` never open or re-create a vault whose entry carries malformed
 * transaction keys (78), `pending` (76), or whose name still has convert/import state files (76) —
 * and only `--fix-settings` (the relocation entry, `{ allowRelocate: true }`) passes one carrying
 * `relocate` (78 otherwise). `lock` and `status` never call this. The inner `__mount` entry runs the
 * same checks itself (`innerMountTxnGate`), exempting only the in-process raw mount whose token
 * matches the CURRENT marker.
 */
export function refuseUnfinished(v, { allowRelocate = false, home = homeDir() } = {}) {
  if (v.txnInvalid !== undefined) throw new CliError(EXIT.CONFIG, txnInvalidRefusal(v));
  if (v.pending !== undefined) throw new CliError(EXIT.BUSY, pendingRefusal(v));
  const files = txnStateFilesFor(v.name, home);
  if (files.length) throw new CliError(EXIT.BUSY, txnStateRefusal(v.name, files));
  if (v.relocate !== undefined && !allowRelocate) throw new CliError(EXIT.CONFIG, relocateRefusal(v));
}

/**
 * Security review V6 #3 — the transaction gate of the inner `__mount <name> [--txn <token>]` entry
 * (defence in depth: it does not rely on the caller). No marker (no pending / relocate / state
 * file) and no token ⇒ allowed. Any marker ⇒ allowed ONLY with a token equal to the CURRENT
 * `pending` or `relocate.txid` — the token is what `unlockVault(v, {postMount:false})` (the V0
 * raw transactional mount used by convert / relocation) passes; the public `unlock` / `run` never
 * pass one. A token with nothing to match ⇒ refused. Malformed transaction keys ⇒ always refused.
 */
export function innerMountTxnGate(v, token, { home = homeDir() } = {}) {
  if (v.txnInvalid !== undefined) throw new CliError(EXIT.CONFIG, txnInvalidRefusal(v));
  const matches = token !== undefined && (token === v.pending || token === v.relocate?.txid);
  if (token !== undefined && !matches)
    throw new CliError(EXIT.BUSY, `保险库 ${v.name}：事务凭证与当前登记不符（登记项已变化？），拒绝挂载`);
  if (matches) return;
  if (v.pending !== undefined) throw new CliError(EXIT.BUSY, pendingRefusal(v));
  const files = txnStateFilesFor(v.name, home);
  if (files.length) throw new CliError(EXIT.BUSY, txnStateRefusal(v.name, files));
  if (v.relocate !== undefined) throw new CliError(EXIT.CONFIG, relocateRefusal(v));
}

/** Create the §L.1 layout for a fresh vault (dir and mnt must not exist). Throws on any problem. */
/** Identity {dev, ino} (bigint-exact, as strings) of `p` without following it; undefined when absent. */
function idOfPath(p) {
  try {
    const st = fs.lstatSync(p, { bigint: true });
    return { dev: String(st.dev), ino: String(st.ino) };
  } catch {
    return undefined;
  }
}

/** Identities of what init's createLayout just made: `<dir>`, `<mnt>` and both parents. */
export function initSkeletonIds(v) {
  return {
    dir: idOfPath(v.dir),
    dirParent: idOfPath(path.dirname(v.dir)),
    mnt: idOfPath(v.mnt),
    mntParent: idOfPath(path.dirname(v.mnt)),
  };
}

/** Sibling name for a set-aside init skeleton: `<base>.init-failed-<YYYYMMDD-HHMMSS>-<rand4>`. */
export function initFailedName(base, now = new Date(), rand = () => Math.floor(Math.random() * 0x10000)) {
  const p = (n) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${base}.init-failed-${ts}-${(rand() & 0xffff).toString(16).padStart(4, "0")}`;
}

/**
 * Security review V6 round 2 (ruling: init NEVER deletes): after a lost registration claim the
 * skeleton this run created is SET ASIDE, not removed — `<dir>` and `<mnt>` are each renamed as a
 * whole, with RENAME_NOREPLACE, to a sibling `<base>.init-failed-<ts>-<rand>` through tree.mjs's
 * reviewed `renameNoReplace` (parent pinned by fd + its recorded identity, source must still be the
 * recorded (dev, ino), verdict by post-move identity). Identity changed, parent swapped, target name
 * taken or any doubt ⇒ that path is left exactly as it is and only reported. No unlink / rmdir at all.
 * → {moved: [{from, to}], kept: [{path, reason}]}
 */
export async function setAsideInitSkeleton(v, ids, { renameImpl, now = new Date(), rand } = {}) {
  const rename = renameImpl ?? (await import("./tree.mjs")).renameNoReplace;
  const moved = [];
  const kept = [];
  for (const [p, expect, expectParent] of [
    [v.dir, ids.dir, ids.dirParent],
    [v.mnt, ids.mnt, ids.mntParent],
  ]) {
    if (!expect || !expectParent) {
      if (lstatOrNull(p)) kept.push({ path: p, reason: "创建时的身份未记录" });
      continue;
    }
    const to = initFailedName(path.basename(p), now, rand);
    let r;
    try {
      r = await rename({ parent: path.dirname(p), from: path.basename(p), to, expect, expectParent });
    } catch (e) {
      r = { ok: false, state: "unknown", reason: String((e && e.message) || e) };
    }
    if (r.ok) moved.push({ from: p, to: path.join(path.dirname(p), to) });
    else if (lstatOrNull(p) || r.state !== "unchanged") kept.push({ path: p, reason: r.reason });
  }
  return { moved, kept };
}

// ───────────────────── init cleanup (user ruling 2026-10-24; supersedes V6 r2 「init 不删」 for
// THIS run's own objects only — see docs/dev/data-encryption/init-cleanup-report.md). Security
// review r1 fixes: identity evidence is HELD (fds kept open from creation to cleanup, so an inode
// can never be reused under us), cipher files need provenance, the cleanup runs under the vault's
// mount.lease + mount.lock, sentinels must still look like sentinels, and every primitive failure
// is caught and reported.

/** The only names `gocryptfs -init` (1.8) writes into an empty cipher dir. */
export const INIT_CIPHER_NAMES = Object.freeze(["gocryptfs.conf", "gocryptfs.diriv"]);
/** Upper bound for an -init product (a real gocryptfs.conf is < 1 KiB, gocryptfs.diriv 16 B). */
export const INIT_CIPHER_MAX_BYTES = 64 * 1024;
/** Slack for the coarse kernel clock that stamps ctime/mtime (≈ one jiffy, generously rounded). */
const INIT_CLOCK_SLACK_NS = 100_000_000n;
const O_PATH_FLAG = 0o10000000; // Linux O_PATH (Node does not export it)
const INIT_DIR_READ = fsc.O_RDONLY | fsc.O_DIRECTORY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK;
const fdp = (fd, name) => `/proc/self/fd/${fd}/${name}`;
const nowNs = () => BigInt(Date.now()) * 1_000_000n;
const idEq = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino;
const stId = (st) => ({ dev: String(st.dev), ino: String(st.ino) });

/** fstat of a held fd → {dev, ino, st} | undefined (closed / invalid). */
function heldStat(fd) {
  if (typeof fd !== "number") return undefined;
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    return { ...stId(st), st };
  } catch {
    return undefined;
  }
}
/** `<held dir fd>/<name>` without following a symlink → {dev, ino, st} | undefined (absent). */
function entryAt(pfd, name) {
  let fd;
  try {
    fd = fs.openSync(fdp(pfd, name), O_PATH_FLAG | fsc.O_NOFOLLOW);
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return undefined;
    throw e;
  }
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    return { ...stId(st), st };
  } finally {
    fs.closeSync(fd);
  }
}

/** Close every fd init holds for its cleanup evidence (idempotent). */
export function closeInitHolds(made) {
  const fds = made?.fds;
  if (!fds) return;
  const all = [fds.dirParent, fds.dir, fds.cipher, fds.mntParent, fds.mnt];
  for (const g of [fds.dirFiles, fds.mntFiles, fds.cipherFiles]) all.push(...Object.values(g ?? {}));
  for (const fd of all) {
    try {
      if (typeof fd === "number") fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }
  delete made.fds;
}

/**
 * Just before `gocryptfs -init`: the HELD cipher dir must still be empty and still be what the
 * path `v.cipher` names; the start time bounds the provenance check of recordInitCipher.
 */
export function prepareInitCipher(v, made) {
  made.cipherT0 = String(nowNs() - INIT_CLOCK_SLACK_NS);
  delete made.cipherProblem;
  const h = heldStat(made.fds?.cipher);
  if (!h) return void (made.cipherProblem = "cipher 目录的身份证据（持有的 fd）不在");
  try {
    const p = fs.lstatSync(v.cipher, { bigint: true });
    if (!idEq(stId(p), h)) return void (made.cipherProblem = "cipher 路径已不指向本次创建的目录");
    const n = fs.readdirSync(`/proc/self/fd/${made.fds.cipher}`);
    if (n.length) made.cipherProblem = `gocryptfs -init 之前 cipher 已非空：${n.slice(0, 8).join(", ")}`;
  } catch (e) {
    made.cipherProblem = `无法检查 cipher（${e.code ?? e.message}）`;
  }
}

/**
 * Right after `gocryptfs -init` (success OR failure): through the HELD cipher dir fd, accept only
 * provable -init products — names in INIT_CIPHER_NAMES, regular file, owned by us, nlink 1, size ≤
 * INIT_CIPHER_MAX_BYTES, ctime AND mtime not earlier than prepareInitCipher's start — and hold an
 * O_PATH fd on each. Anything else ⇒ `cipherProblem` (the whole `<dir>` is then kept, only reported).
 */
export function recordInitCipher(v, made, { uid = process.getuid() } = {}) {
  made.cipherFiles = {};
  made.fds.cipherFiles = {};
  if (made.cipherProblem !== undefined) return made;
  const cfd = made.fds?.cipher;
  const t0 = BigInt(made.cipherT0 ?? "0");
  try {
    const odd = [];
    for (const n of fs.readdirSync(`/proc/self/fd/${cfd}`).sort()) {
      const e = INIT_CIPHER_NAMES.includes(n) ? entryAt(cfd, n) : undefined;
      const st = e?.st;
      if (
        !st ||
        !st.isFile() ||
        Number(st.uid) !== uid ||
        st.nlink !== 1n ||
        st.size > BigInt(INIT_CIPHER_MAX_BYTES) ||
        st.ctimeNs < t0 ||
        st.mtimeNs < t0
      ) {
        odd.push(n);
        continue;
      }
      const fd = fs.openSync(fdp(cfd, n), O_PATH_FLAG | fsc.O_NOFOLLOW);
      if (!idEq(heldStat(fd), e)) {
        fs.closeSync(fd);
        odd.push(n);
        continue;
      }
      made.fds.cipherFiles[n] = fd;
      made.cipherFiles[n] = stId(st);
    }
    if (odd.length) made.cipherProblem = `出现无法证明是本次 gocryptfs -init 产物的条目：${odd.slice(0, 8).join(", ")}`;
  } catch (e) {
    made.cipherProblem = `无法列出 cipher（${e.code ?? e.message}）`;
  }
  return made;
}

/** The registration init wrote (exact bytes of the CAS guard for the unclaim). */
export function initWrittenEntry(v, priv) {
  return { dir: v.dir, mnt: v.mnt, ...(priv ? { private: true } : {}) };
}

/**
 * Run UNDER the settings lock (`__vault-unclaim`): undo init's registration only while the entry
 * still canonically equals what THIS run wrote — then delete it (no earlier entry) or restore the
 * entry read before the claim. → {kind:"ok", action:"deleted"|"restored"} | {kind:"missing"} |
 * {kind:"mismatch", reason} (no write).
 */
export function unclaimInitEntryUnlocked(name, written, before, home = homeDir()) {
  if (typeof name !== "string" || !VAULT_NAME_RE.test(name))
    throw new Error(`保险库名不合法：${JSON.stringify(name)}（需匹配 ${VAULT_NAME_RE}）`);
  assertVaultEntryShape(written);
  if (before !== undefined && !isPlainObject(before)) throw new Error("before 须为对象");
  const file = healedSettingsFilePath(home);
  if (!lstatOrNull(file)) return { kind: "missing" };
  const { st, root } = loadMutableSettings(file);
  const secure = { ...(root.secure ?? {}) };
  const vaults = mutableVaults(secure, file);
  if (!Object.hasOwn(vaults, name)) return { kind: "missing" };
  if (canonicalJson(vaults[name]) !== canonicalJson(written))
    return { kind: "mismatch", reason: `secure.vaults.${name} 已不是本次 init 写入的内容（被其他操作改动）` };
  const rest = { ...vaults };
  if (before === undefined) delete rest[name];
  else rest[name] = before;
  secure.vaults = rest;
  writeFileAtomic(file, JSON.stringify({ ...root, secure }, null, 2) + "\n", settingsWriteMode(st));
  return { kind: "ok", action: before === undefined ? "deleted" : "restored" };
}

/** Locked wrapper (settings flock child `__vault-unclaim`). Throws CliError 73/69/78 like registerVault. */
export function unclaimInitEntry(name, written, before, { home = homeDir(), lockWaitS = SETTINGS_LOCK_WAIT_S } = {}) {
  const r = spawnUnderSettingsLock(home, lockWaitS, [
    "__vault-unclaim",
    name,
    JSON.stringify(written),
    JSON.stringify(before ?? null),
  ]);
  if (r.status !== 0) throw new CliError(EXIT.CONFIG, childErrText(r, "撤销登记"));
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new CliError(EXIT.FAIL, `__vault-unclaim 输出无法解析：${String(r.stdout).slice(0, 200)}`);
  }
}

/**
 * Hold the vault's mount.lease (outer, like releaseRecord) and mount.lock (inner) for the whole
 * cleanup: `flock -w … lease flock -w … lock sh -c 'echo locked $$; exec cat'`. The innermost process
 * inherits both lock fds (no -o) and lives until we close its stdin (or we die). The lock is only
 * accepted after proving, through that process's /proc fds, that the inodes it locked ARE the
 * lease/lock files this run created. → {release()} ; throws Error(reason) when not obtainable.
 */
export async function holdInitVaultLocks(v, made, { leaseWaitS = 5, lockWaitS = LOCK_WAIT_S } = {}) {
  const c = spawn(
    "flock",
    [
      "-E",
      String(FLOCK_TIMEOUT_CODE),
      "-w",
      String(leaseWaitS),
      v.lease,
      "flock",
      "-E",
      String(FLOCK_TIMEOUT_CODE),
      "-w",
      String(lockWaitS),
      v.lock,
      "sh",
      "-c",
      'echo "locked $$"; exec cat >/dev/null',
    ],
    { stdio: ["pipe", "pipe", "ignore"], cwd: "/" },
  );
  const release = async () => {
    try {
      c.stdin.end();
    } catch {
      /* gone */
    }
    if (c.exitCode !== null || c.signalCode !== null) return;
    await new Promise((res) => {
      const t = setTimeout(() => {
        try {
          c.kill("SIGKILL");
        } catch {
          /* gone */
        }
        res();
      }, 3_000);
      t.unref();
      c.once("exit", () => {
        clearTimeout(t);
        res();
      });
    });
  };
  const pid = await new Promise((resolve) => {
    let buf = "";
    const t = setTimeout(() => resolve(undefined), (leaseWaitS + lockWaitS + 5) * 1000);
    t.unref();
    c.stdout.on("data", (b) => {
      buf += b.toString("utf8");
      const m = /locked (\d+)\n/.exec(buf);
      if (m) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    });
    c.once("exit", (code) => {
      clearTimeout(t);
      resolve(code === FLOCK_TIMEOUT_CODE ? "busy" : undefined);
    });
    c.once("error", () => {
      clearTimeout(t);
      resolve(undefined);
    });
  });
  if (typeof pid !== "number") {
    await release();
    throw new Error(
      pid === "busy"
        ? "mount.lease/mount.lock 被占用（另一个 pi-secure 正在使用该库）"
        : "无法取得 mount.lease/mount.lock",
    );
  }
  const want = [made.dirFiles?.["mount.lease"], made.dirFiles?.["mount.lock"]];
  const seen = [];
  try {
    for (const n of fs.readdirSync(`/proc/${pid}/fd`)) {
      try {
        seen.push(stId(fs.statSync(`/proc/${pid}/fd/${n}`, { bigint: true })));
      } catch {
        /* closed meanwhile */
      }
    }
  } catch {
    /* unreadable ⇒ not proven */
  }
  if (!want.every((w) => w && seen.some((s) => idEq(s, w)))) {
    await release();
    throw new Error("加锁的文件不是本次创建的 mount.lease/mount.lock");
  }
  return { release };
}

/** A unique single-component tombstone name in the same directory. */
function tombstoneName(rand) {
  return `.pi-secure-rm-${rand().toString(16).padStart(8, "0").slice(-8)}`;
}

/**
 * Remove ONE object of ours: `<parent>/<name>`, where `pfd` is the HELD parent fd and `expect` the
 * identity of the HELD object fd (an inode that is held open cannot be reused, so the comparison
 * can never confuse a re-created object with ours).
 *  1. tree.mjs `renameNoReplace` moves it to a fresh tombstone name in the same directory (parent
 *     identity pinned, source must be `expect`, never replaces, verdict by identity). A non-ok
 *     verdict (including "unknown") is resolved by probing BOTH names through the held parent fd.
 *  2. the tombstone is opened O_PATH|O_NOFOLLOW through `/proc/self/fd/<pfd>/` — only `expect` passes;
 *  3. files: unlink, directories: rmdir (fails when not empty — never recursive), both through the
 *     held parent fd path. Anything unproven ⇒ renamed back (identity-checked) or left where it is,
 *     and reported with its actual location. Never throws.
 * → {ok:true} | {ok:false, reason}
 */
async function removeOwnObject({ parent, pfd, name, expect, expectParent, dir, shape, T, rand }) {
  const tomb = tombstoneName(rand);
  // review r2 #5: report coordinates from the HELD parent fd's current path (the parent may have been
  // renamed meanwhile); when that path no longer resolves to the held directory, say so.
  const where = (n) => {
    try {
      const cur = fs.readlinkSync(`/proc/self/fd/${pfd}`);
      const st = fs.lstatSync(cur, { bigint: true });
      if (path.isAbsolute(cur) && idEq(stId(st), heldStat(pfd))) return path.join(cur, n);
    } catch {
      /* fall through */
    }
    return `（父目录已移动，原位置未知）/${n}`;
  };
  try {
    let r;
    try {
      r = await T.renameNoReplace({ parent, from: name, to: tomb, expect, expectParent });
    } catch (e) {
      r = { ok: false, state: "unknown", reason: String((e && e.message) || e) };
    }
    if (!r.ok) {
      const atTomb = entryAt(pfd, tomb);
      const atName = entryAt(pfd, name);
      if (!idEq(atTomb, expect)) {
        if (idEq(atName, expect)) return { ok: false, reason: `无法移到墓碑名（${r.reason ?? r.state}），原样保留` };
        return {
          ok: false,
          reason: `移动结局不明（${r.reason ?? r.state}）；原名与墓碑名 ${where(tomb)} 都不是本次对象，未删除任何东西`,
        };
      }
      // "unknown" but it did move: carry on with the tombstone (identity proven just above)
    }
    const putBack = async (why) => {
      let moved;
      try {
        const now = entryAt(pfd, tomb);
        if (now && !entryAt(pfd, name)) {
          moved = stId(now.st);
          await T.renameNoReplace({ parent, from: tomb, to: name, expect: moved, expectParent });
        }
      } catch {
        /* the verdict below re-probes both names either way */
      }
      // review r2 #5: whatever the rename back reported (ok / unchanged / unknown / threw), the
      // ACTUAL location is decided by probing both names through the held parent fd
      try {
        const atName = entryAt(pfd, name);
        const atTomb = entryAt(pfd, tomb);
        if (moved && idEq(atName, moved)) return { ok: false, reason: `${why}，已改回原名 ${where(name)}` };
        if (atTomb) return { ok: false, reason: `${why}，留在 ${where(tomb)}` };
        if (atName) return { ok: false, reason: `${why}，${where(name)} 上现有一个对象（未删除）` };
        return { ok: false, reason: `${why}，原名与墓碑名 ${where(tomb)} 上都已不见，位置不明（未删除任何东西）` };
      } catch (e) {
        return {
          ok: false,
          reason: `${why}，无法确认位置（${e.code ?? e.message}）；可能在 ${where(name)} 或 ${where(tomb)}`,
        };
      }
    };
    const id = entryAt(pfd, tomb);
    if (!idEq(id, expect) || (dir ? !id.st.isDirectory() : !id.st.isFile()))
      return await putBack("墓碑身份与本次对象不符");
    // review r2 #4: re-check the sentinel shape on the tombstone itself, right before the unlink
    // (data written through an already-open fd after the preflight must not be deleted)
    const bad = dir || !shape ? undefined : fileShapeProblem(id.st, shape);
    if (bad) return await putBack(`墓碑上的文件已不是创建时的形状（${bad}）`);
    try {
      if (dir) fs.rmdirSync(fdp(pfd, tomb));
      else fs.unlinkSync(fdp(pfd, tomb));
    } catch (e) {
      return await putBack(e && e.code === "ENOTEMPTY" ? "目录非空" : `删除失败（${e.code ?? e.message}）`);
    }
    try {
      fs.fsyncSync(pfd);
    } catch {
      /* best effort */
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: `检查失败（${(e && (e.code ?? e.message)) || e}），未删除；可能留在 ${where(name)} 或 ${where(tomb)}`,
    };
  }
}

/** Sentinel-like files must still look exactly as created: empty, same mode, single link. */
function fileShapeProblem(st, { mode, cipher }) {
  if (!st.isFile()) return "不是普通文件";
  if (st.nlink !== 1n) return `链接数为 ${st.nlink}（应为 1）`;
  if (Number(st.uid) !== process.getuid()) return "属主不是本用户";
  if (cipher) return st.size > BigInt(INIT_CIPHER_MAX_BYTES) ? "大小超出 -init 产物上限" : undefined;
  if (st.size !== 0n) return `大小为 ${st.size} 字节（创建时为空——可能是误写入的数据）`;
  if (mode !== undefined && (Number(st.mode) & 0o7777) !== mode)
    return `权限为 ${(Number(st.mode) & 0o7777).toString(8)}（创建时为 ${mode.toString(8)}）`;
  return undefined;
}

/**
 * Remove the vault THIS init run created (user ruling 2026-10-24). `made` = createLayout(…, {hold})
 * + prepareInitCipher/recordInitCipher; its fds are the identity evidence and stay open until here.
 * Everything below runs while holding the vault's mount.lease + mount.lock (holdInitVaultLocks):
 *  A. preflight (no side effects): mount state absent, cipher provenance clean, and for every object
 *     — held fd present, same identity at `<held parent>/<name>`, shape (empty/mode/nlink for the
 *     files we created), directories holding nothing but planned children. ANY failure ⇒ nothing is
 *     unregistered or deleted; every problem is reported.
 *  B. settings-lock CAS unclaim (`written` must still be the entry; `before` restored if there was
 *     one) — mismatch ⇒ nothing deleted. Then bottom-up removal through `removeOwnObject`.
 * Never throws; the holds are closed at the end.
 * → {unclaimed: "deleted"|"restored"|"missing"|"skipped"|"mismatch", removed: string[], kept: [{path, reason}]}
 */
export async function removeInitVault(
  v,
  made,
  {
    written,
    before,
    home = homeDir(),
    probe = probeMountState,
    unclaim = unclaimInitEntry,
    treeImpl,
    rand,
    leaseWaitS,
    lockWaitS,
  } = {},
) {
  const kept = [];
  const removed = [];
  let unclaimed = "skipped";
  const fds = made?.fds ?? {};
  const plan = [
    ...Object.keys(made.cipherFiles ?? {}).map((n) => ({
      pfdKey: "cipher",
      parent: v.cipher,
      name: n,
      fd: fds.cipherFiles?.[n],
      cipher: true,
    })),
    { pfdKey: "dir", parent: v.dir, name: "cipher", fd: fds.cipher, dir: true },
    ...Object.keys(made.dirFiles ?? {}).map((n) => ({
      pfdKey: "dir",
      parent: v.dir,
      name: n,
      fd: fds.dirFiles?.[n],
      mode: 0o600,
    })),
    { pfdKey: "dirParent", parent: path.dirname(v.dir), name: path.basename(v.dir), fd: fds.dir, dir: true },
    ...Object.keys(made.mntFiles ?? {}).map((n) => ({
      pfdKey: "mnt",
      parent: v.mnt,
      name: n,
      fd: fds.mntFiles?.[n],
      mode: 0o400,
    })),
    { pfdKey: "mntParent", parent: path.dirname(v.mnt), name: path.basename(v.mnt), fd: fds.mnt, dir: true },
  ];
  let lock;
  try {
    try {
      lock = await holdInitVaultLocks(v, made, {
        ...(leaseWaitS !== undefined ? { leaseWaitS } : {}),
        ...(lockWaitS !== undefined ? { lockWaitS } : {}),
      });
    } catch (e) {
      kept.push({ path: v.dir, reason: `${(e && e.message) || e}，不删除` });
      return { unclaimed, removed, kept };
    }
    // ── A. preflight, inside the locks ──
    let st;
    try {
      st = await probe(v);
    } catch (e) {
      st = `unknown (${(e && e.message) || e})`;
    }
    if (st !== "absent") kept.push({ path: v.mnt, reason: `挂载状态不是 absent（${st}），不删除` });
    if (made.cipherProblem !== undefined) kept.push({ path: v.cipher, reason: made.cipherProblem });
    for (const o of plan) {
      const p = path.join(o.parent, o.name);
      try {
        const h = heldStat(o.fd);
        const ph = heldStat(fds[o.pfdKey]);
        if (!h || !ph) {
          kept.push({ path: p, reason: "创建时的身份证据（持有的 fd）不在" });
          continue;
        }
        let pathSt;
        try {
          pathSt = fs.lstatSync(o.parent, { bigint: true });
        } catch {
          pathSt = undefined;
        }
        const at = entryAt(fds[o.pfdKey], o.name);
        if (!pathSt || !pathSt.isDirectory() || !idEq(stId(pathSt), ph))
          kept.push({ path: p, reason: `父目录路径 ${o.parent} 已不指向本次持有的目录（被改名或替换）` });
        else if (!at) kept.push({ path: p, reason: "已不在原位置" });
        else if (!idEq(at, h)) kept.push({ path: p, reason: "原位置上已不是本次创建的对象（被替换或重建）" });
        else if (o.dir) {
          if (!h.st.isDirectory()) kept.push({ path: p, reason: "不是目录" });
          else {
            const want = new Set(plan.filter((c) => c.parent === p).map((c) => c.name));
            const extra = fs.readdirSync(`/proc/self/fd/${o.fd}`).filter((n) => !want.has(n));
            if (extra.length) kept.push({ path: p, reason: `含有非本次创建的条目：${extra.slice(0, 8).join(", ")}` });
          }
        } else {
          const bad = fileShapeProblem(h.st, o);
          if (bad) kept.push({ path: p, reason: bad });
        }
      } catch (e) {
        kept.push({ path: p, reason: `无法检查（${e.code ?? e.message}）` });
      }
    }
    if (kept.length) return { unclaimed, removed, kept };
    // ── B. unclaim (CAS), then remove bottom-up ──
    let u;
    try {
      u = unclaim(v.name, written, before, { home });
    } catch (e) {
      u = { kind: "mismatch", reason: String((e && e.message) || e) };
    }
    if (u.kind === "mismatch") {
      kept.push({ path: settingsFilePath(home), reason: u.reason });
      return { unclaimed: "mismatch", removed, kept };
    }
    unclaimed = u.kind === "ok" ? (u.action ?? "deleted") : "missing";
    const T = treeImpl ?? (await import("./tree.mjs"));
    const rnd = rand ?? (() => Math.floor(Math.random() * 0x100000000));
    for (const o of plan) {
      const p = path.join(o.parent, o.name);
      const h = heldStat(o.fd);
      const ph = heldStat(fds[o.pfdKey]);
      const r =
        h && ph
          ? await removeOwnObject({
              parent: o.parent,
              pfd: fds[o.pfdKey],
              name: o.name,
              expect: stId(h.st),
              expectParent: stId(ph.st),
              dir: !!o.dir,
              shape: o.dir ? undefined : { mode: o.mode, cipher: !!o.cipher },
              T,
              rand: rnd,
            })
          : { ok: false, reason: "创建时的身份证据（持有的 fd）不在" };
      if (r.ok) removed.push(p);
      else kept.push({ path: p, reason: r.reason });
    }
    return { unclaimed, removed, kept };
  } catch (e) {
    kept.push({ path: v.dir, reason: `清理中断（${(e && e.message) || e}）` });
    return { unclaimed, removed, kept };
  } finally {
    if (lock) await lock.release();
    closeInitHolds(made);
  }
}

/** Human report lines for removeInitVault, generated from the ACTUAL result (review r1 minor). */
export function formatInitCleanup(v, r) {
  const reg = `secure.vaults.${v.name}`;
  const lines = [
    {
      deleted: `  已撤销登记 ${reg}`,
      restored: `  已把 ${reg} 恢复为本次 init 之前的登记`,
      missing: `  登记项 ${reg} 已不存在（未改动）`,
      mismatch: `  登记未动：${reg}（已被其他操作改动）`,
      skipped: `  登记未动：${reg}`,
    }[r.unclaimed] ?? `  登记状态：${r.unclaimed}`,
  ];
  for (const p of r.removed) lines.push(`  已删除：${p}`);
  for (const k of r.kept) lines.push(`  保留未动：${k.path}（${k.reason}）`);
  if (r.kept.length) {
    if (r.unclaimed === "deleted" || r.unclaimed === "restored" || r.unclaimed === "missing")
      lines.push(
        `  登记已处理，但以上对象仍在：确认未挂载、其中没有要保留的数据后手工删除上列路径（${v.dir}、${v.mnt}），再 pi-secure init ${v.name}`,
      );
    else lines.push(initCleanupHint(v));
  }
  return lines;
}

export function createLayout(v, { others = [], home = homeDir(), hold = false } = {}) {
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
  // init cleanup (ruling 2026-10-24 + security review r1): every object is created INSIDE an
  // already-held parent dir fd (mkdir/open through /proc/self/fd/<pfd>/<name>, mkdirat-equivalent),
  // then opened and fstat'ed right away; directories must be fresh (owned by us, nlink 2, empty,
  // ctime ≥ start). With `hold` (init only) those fds stay open until removeInitVault — an inode
  // that is held open cannot be reused, so later identity checks can never confuse a re-created
  // object with ours. Without `hold` (convert's port) only the identities are returned and every
  // fd is closed here (convert's occupancy checks must not see this process inside the vault).
  const t0 = nowNs() - INIT_CLOCK_SLACK_NS;
  const uid = process.getuid();
  const fds = { dirFiles: {}, mntFiles: {}, cipherFiles: {} };
  const made = { t0: String(t0), dirFiles: {}, mntFiles: {}, fds };
  const opened = [];
  const keep = (fd) => (opened.push(fd), fd);
  const freshDir = (fd, p) => {
    const st = fs.fstatSync(fd, { bigint: true });
    if (
      !st.isDirectory() ||
      Number(st.uid) !== uid ||
      (st.nlink !== 2n && st.nlink !== 1n) || // btrfs reports 1 for directories
      st.ctimeNs < t0 ||
      fs.readdirSync(`/proc/self/fd/${fd}`).length !== 0
    )
      throw new CliError(EXIT.FAIL, `刚创建的目录 ${p} 不是预期的空目录（并发改动？），停止 init`);
    return stId(st);
  };
  const mkdirIn = (pfd, name, p) => {
    fs.mkdirSync(fdp(pfd, name), { mode: 0o700 });
    const fd = keep(fs.openSync(fdp(pfd, name), INIT_DIR_READ));
    return { fd, id: freshDir(fd, p) };
  };
  const createIn = (pfd, name, mode) => {
    // review r2 #3: the O_EXCL fd IS the evidence — it is held as-is (never closed and re-opened
    // by name), so nothing can be swapped in between creating the file and taking its identity.
    const fd = keep(fs.openSync(fdp(pfd, name), fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, mode));
    fs.fchmodSync(fd, mode);
    return { fd, id: stId(fs.fstatSync(fd, { bigint: true })) };
  };
  try {
    fds.dirParent = keep(fs.openSync(path.dirname(v.dir), INIT_DIR_READ));
    made.dirParent = stId(heldStat(fds.dirParent).st);
    const d = mkdirIn(fds.dirParent, path.basename(v.dir), v.dir);
    [fds.dir, made.dir] = [d.fd, d.id];
    const c = mkdirIn(fds.dir, "cipher", v.cipher);
    [fds.cipher, made.cipher] = [c.fd, c.id];
    fds.mntParent = keep(fs.openSync(path.dirname(v.mnt), INIT_DIR_READ));
    made.mntParent = stId(heldStat(fds.mntParent).st);
    const m = mkdirIn(fds.mntParent, path.basename(v.mnt), v.mnt);
    [fds.mnt, made.mnt] = [m.fd, m.id];
    for (const n of ["work", "state"]) {
      const f = createIn(fds.mnt, n, 0o400);
      [fds.mntFiles[n], made.mntFiles[n]] = [f.fd, f.id];
    }
    for (const n of ["mount.lock", "mount.lease"]) {
      const f = createIn(fds.dir, n, 0o600);
      [fds.dirFiles[n], made.dirFiles[n]] = [f.fd, f.id];
    }
  } catch (e) {
    for (const fd of opened) fs.closeSync(fd);
    throw e;
  }
  if (!hold) closeInitHolds(made);
  return made;
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

/**
 * V7 security review M1 — test-seam gate. Every `PI_SECURE_TEST_*` seam is honoured ONLY when the
 * gate `PI_SECURE_TEST_SEAMS=1` is set as well (only the test suites set both, in the env of the
 * child they spawn). One variable alone ⇒ the seam is ignored and every user-facing launcher command
 * prints a warning (main → testSeamWarnings); `status` adds a `warn:` line whenever any is present.
 * Not a security boundary against the same uid — it only stops a stray/inherited variable from
 * changing a real run. Mirrored (same rule, no import) in convert.mjs and archive.mjs.
 */
export const TEST_SEAMS_GATE = "PI_SECURE_TEST_SEAMS";
export function testSeam(name, env = process.env) {
  const v = env[name];
  if (v === undefined || v === "") return undefined;
  return env[TEST_SEAMS_GATE] === "1" ? v : undefined;
}
/** Names of the set (non-empty) seam variables, gate excluded, sorted. */
export function testSeamNames(env = process.env) {
  return Object.keys(env)
    .filter((k) => k.startsWith("PI_SECURE_TEST_") && k !== TEST_SEAMS_GATE && env[k] !== undefined && env[k] !== "")
    .sort();
}
/** Warning lines for a user-facing command (empty ⇔ no test variable at all). */
export function testSeamWarnings(env = process.env) {
  const names = testSeamNames(env);
  const gate = env[TEST_SEAMS_GATE];
  const gateSet = gate !== undefined && gate !== "";
  if (names.length && gate !== "1")
    return [`检测到测试用环境变量 ${names.join("、")}，已忽略（测试缝只在 ${TEST_SEAMS_GATE}=1 时生效）`];
  if (gateSet && !names.length) return [`检测到测试用环境变量 ${TEST_SEAMS_GATE}，已忽略（没有设置任何测试缝）`];
  if (names.length) return [`测试缝已启用（仅供测试，切勿用于真实数据）：${names.join("、")}`];
  return [];
}

function testScanDelay() {
  // TEST-ONLY seam (tests/secure/launcher-fuse.test.ts): delay the occupancy scan to prove the scan
  // budget. Can only make the launcher refuse to unmount — never weaker. Gated (testSeam).
  const n = Number(testSeam("PI_SECURE_TEST_SCAN_DELAY_MS") ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 60_000) : 0;
}

/**
 * TEST-ONLY seams for the N4 e2e suite (tests/secure/launcher-private.test.ts). Both can only make
 * a private run SLOWER or make it fail closed through its own budgets — never weaker:
 *   PI_SECURE_TEST_WORKER_DELAY="<op>:<ms>"  the `__mount-work` worker sleeps before op <op>
 *     (still inside the worker's own deadline — a long delay just becomes that op's timeout);
 *   PI_SECURE_TEST_FINALIZE_STALL_MS=<ms>     P1's in-ns finalize stalls first (its 10.5 s hard
 *     backstop still fires ⇒ exit 75 ⇒ P0's outer cleanup: the §3.4+§3.5 worst path).
 */
export function testWorkerDelayMs(op, env = process.env) {
  const m = /^([a-z-]{1,32}):(\d{1,6})$/.exec(testSeam("PI_SECURE_TEST_WORKER_DELAY", env) ?? "");
  return m && m[1] === op ? Math.min(Number(m[2]), 60_000) : 0;
}
export function testFinalizeStallMs(env = process.env) {
  const n = Number(testSeam("PI_SECURE_TEST_FINALIZE_STALL_MS", env) ?? 0);
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

// Mirror of src/core/agent-dir.ts — parity: tests/config/agent-dir-parity.test.ts.
/** Lexical resolution only: no trim, realpath, I/O or pi imports. Relative values are unsupported. */
export function resolveAgentDir(env, home) {
  const H = path.join(home, ".pi", "agent");
  const raw = env.PI_CODING_AGENT_DIR;
  if (raw === undefined || raw === "") return { dir: H, home: H, source: "default" };
  let expanded = raw === "~" ? home : raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw;
  if (raw.startsWith("file://")) {
    try {
      expanded = fileURLToPath(raw);
    } catch {
      // Invalid file URLs are unsupported too; fall back without throwing.
    }
  }
  if (!path.isAbsolute(expanded)) return { dir: H, home: H, source: "default", ignored: { raw, reason: "relative" } };
  const dir = path.resolve(expanded);
  return dir === H ? { dir: H, home: H, source: "default" } : { dir, home: H, source: "env" };
}

export function piAgentDir(home) {
  return resolveAgentDir(process.env, home).dir;
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

export const err = (s) => process.stderr.write(`pi-secure: ${s}\n`);
export const out = (s) => process.stdout.write(`${s}\n`);

/** Typed CLI error — `.code` is the §6 exit code. V0 exports it so convert/import (V4/V5) and
 *  tests can branch on it (lock-busy 73, config 78, busy 76, bad password 77, …). */
export class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function must(r) {
  if (r.kind === "error") throw new CliError(r.code, r.message);
  return r;
}

export function requirePrereqs() {
  const p = preflight();
  if (!p.ok) throw new CliError(EXIT.PREREQ, `前置检查失败：\n  - ${p.problems.join("\n  - ")}`);
}

export function requireTty(what) {
  if (!tty.isatty(0)) throw new CliError(EXIT.USAGE, `${what}需要在终端里输入口令（stdin 不是 TTY）`);
}

/** convert.mjs CONVERT_USAGE, indented (kept verbatim in sync — pinned by a test; helper does not
 *  load convert.mjs just to print its usage). */
export const CONVERT_USAGE_LINES = [
  "  pi-secure convert <明文目录> [<名字>] [--path <挂载点>] [--no-sessions] [--sessions-from <目录>]… [--private] [--assume-unreadable-idle]",
  "  pi-secure convert --resume <名字> [--assume-unreadable-idle]",
  "  pi-secure convert --abort  <名字> [--assume-unreadable-idle]",
].join("\n");

// USAGE text (Q9: new lines allowed). PRIVATE_BOUNDARY_LONG is declared further down (const, TDZ):
// usageText() reads it lazily so the order of declarations stays free.
export function usageText() {
  return `用法：
  pi-secure init <name> [--path <挂载点>] [--private] [--fix-settings]
  pi-secure unlock <name> [--global]
  pi-secure lock <name> [--lazy|--kill]
  pi-secure status [<name>]
  pi-secure run <name> [--private|--no-private] [-C <子目录>] [pi 参数…]
${CONVERT_USAGE_LINES}
  pi-secure export <名字> <文件.tar>
  pi-secure import <文件.tar> <名字> [--path <挂载点>] [--verify-password]
  pi-secure import --resume <名字>
  pi-secure import --abort  <名字>
布局（private-plan §L.1）：元数据在 ~/.local/share/pi-toolkit-secure/<name>/（cipher、mount.lock、mount.lease），
挂载点是 ~/secure/<name>/（0700 目录；未挂载时 work/state 是两个哨兵文件），项目根 ~/secure/<name>/work。
--path 指定挂载点位置（绝对路径或 ~/ 开头）。
--private/--no-private 只在紧跟 <name> 的位置识别（固定顺序：<name> [--private|--no-private] [-C <子目录>]，其余交给 pi）；
  缺省取 secure.vaults.<name>.private。init --private 登记为私有库（首次挂载、建目录、写 sessionDir、卸载都在私有命名空间内完成）。
私有库的 unlock 默认拒绝（全局挂载对所有同用户进程可见），--global 只解除这条默认、从不绕过互斥。
convert 把明文目录转成保险库：原目录改名为只读备份（从不删除），原路径改为指向 ~/secure/<名字>/work 的符号链接；中断后用 --resume（只完成链接）或 --abort（备份改回原名）。
export 只导出密文包（库须未挂载）；import 导入为新库，挂载点位置变化时登记迁址，完成前 run/unlock/export 被拒，用 init <名字> --fix-settings 继续（私有库在私有命名空间内完成）。
lock --kill 结束 --private 会话并收尾；lock --lazy 摘除该命名空间里的挂载路径；既有 cwd、已打开的文件和运行中的作业可能继续访问；插件在下一次输入/工具调用时拒绝。
${PRIVATE_BOUNDARY_LONG}
说明见 docs/dev/data-encryption/plan.md §2.2（run 之后的参数原样交给 pi 解析；"--" 之后全部是消息）`;
}

/** Run gocryptfs with the TTY inherited; resolves to its exit code. */
export function runInherited(cmd, args, { timeoutMs } = {}) {
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
  if (testSeam("PI_SECURE_TEST_MOUNT_VERIFY_FAIL") === "1")
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
async function cmdInnerMount(args) {
  const [name, ...flags] = args;
  let token;
  if (flags.length === 2 && flags[0] === "--txn" && /^[!-~]{1,80}$/.test(flags[1] ?? "")) token = flags[1];
  else if (flags.length) throw new CliError(EXIT.USAGE, "内部错误：__mount 参数不合法");
  const { vault: v } = must(resolveVault(name));
  requireNewLayout(v); // §L.3: legacy vaults never mount again
  innerMountTxnGate(v, token); // security review V6 #3: same txn refusals as unlock, at the entry itself
  await plainMountPrivateGate(v); // §1.2: private record conflicts, BEFORE any TTY/password
  let st = await probeMountState(v);
  if (st === "mounted") return INNER_ALREADY;
  if (st === "hung")
    throw new CliError(EXIT.FAIL, `${v.mnt} 的挂载探测超时（FUSE 卡住？），拒绝操作；必要时 fusermount3 -uz ${v.mnt}`);
  if (st === "foreign") throw new CliError(EXIT.FAIL, `${v.mnt} 上挂着别的文件系统（mountinfo 不符），拒绝挂载`);
  await plainMountLeaseGate(v); // §1.2: lease busy without a record ⇒ 76 (also before the stale cleanup)
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
      // §3.1: EVERY gocryptfs start runs under the lease — the shell opens + flocks fd 9 itself
      // (no CLOEXEC) and execs gocryptfs, whose daemon keeps holding it until unmount (NC2c).
      const code = await runInherited(
        "/bin/sh",
        leaseChainArgs(v.lease, ["gocryptfs", "-nonempty", "--", v.cipher, v.mnt]),
        { timeoutMs: MOUNT_ATTEMPT_TIMEOUT_MS },
      );
      if (code === LEASE_BUSY_CODE)
        throw new CliError(
          EXIT.BUSY,
          `${name} 的挂载租约正被另一个挂载持有（--private 实例或其他 gocryptfs），未挂载；pi-secure status ${name}`,
        );
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

/**
 * §1.2 for plain mount entries (`__mount`, under mount.lock): an existing private record blocks
 * unless it is `stale`, which is released here (mount.lock held ⇒ the lease is only TRIED, §3.1).
 */
async function plainMountPrivateGate(v) {
  const record = await readPrivateRecord(v, { deadline: Date.now() + PRIVATE_BUDGET.scanMs });
  if (record.kind === "none") return;
  const s = await privateInstanceState(v, { record });
  if (callerInPrivateNs(s.record))
    throw new CliError(
      EXIT.BUSY,
      `${v.name}：本进程就在该库的私有会话（命名空间）内部——拒绝再挂载；退出 pi 即自动收尾`,
    );
  if (s.state !== "stale") throw new CliError(EXIT.BUSY, `${describePrivateState(v.name, s, v)}——未挂载`);
  const rel = releaseRecordHoldingMountLock(v, s.record.instanceId);
  if (rel.kind !== "released" && rel.kind !== "none")
    throw new CliError(EXIT.BUSY, `${describePrivateState(v.name, s, v)}，但无法清理（${rel.kind}）——未挂载`);
  err(`${v.name}：清理了失效的 --private 记录`);
}

/** §1.2/F1c: lease probe (one /proc/locks read, ≤2 s). No lease file ⇒ checkLayout refuses later. */
async function plainMountLeaseGate(v) {
  const li = leaseIdentitySync(v);
  if (li.problem) return;
  const lease = await probeLease(li);
  if (lease === "free") return;
  if (lease === "unknown")
    throw new CliError(EXIT.DEADLINE, `无法读取 /proc/locks 判断 ${v.name} 的挂载租约——拒绝挂载（fail closed）`);
  const holders = await leaseHolders(li);
  throw new CliError(
    EXIT.BUSY,
    [
      `${describePrivateState(v.name, { state: "unrecorded" }, v)}——未挂载`,
      ...holders.map((h) => `  持有者 pid ${h.pid} ${h.comm ?? "(已退出/不可读)"}（/proc/locks，只报告）`),
    ].join("\n"),
  );
}

/** Mount (if needed) under `flock -o -w 10 mount.lock`, then ensure dirs. Returns "mounted-now"|"already". */
async function doMount(v, { txn } = {}) {
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
    ...(txn !== undefined ? ["--txn", txn] : []),
  ]);
  if (code === FLOCK_TIMEOUT_CODE)
    throw new CliError(EXIT.LOCK_BUSY, "另一个 pi-secure 正在挂载或卸载（mount.lock 等待超时）");
  if (code === INNER_ALREADY) return "already";
  if (code !== 0) throw new CliError(code, ""); // the inner process already printed why
  return "mounted-now";
}

// Named runPostMount: the unlockVault OPTION `postMount` (boolean) shadows this helper's name
// inside that function's scope — the golden caught `true(v, …)` TypeError when they shared it.
function runPostMount(v, { fix = false, realMnt } = {}) {
  ensureVaultDirs(v, { realMnt });
  const r = syncProjectSettings(v, { fix });
  if (r.kind === "conflict") throw new CliError(EXIT.CONFIG, r.message);
  if (r.kind === "written") err(`已写入 ${path.join(v.work, ".pi", "settings.json")} 的 sessionDir`);
  if (r.kind === "fixed")
    err(
      `已改写 sessionDir（原文件备份为 ${r.backup}${r.droppedOtherKeys ? "；原文件不是 JSON 对象，其余内容只在备份里" : ""}）`,
    );
}

export function printWarnings() {
  for (const w of systemWarnings()) err(`警告：${w}`);
}

export async function unlockVault(v, { fix = false, postMount = true } = {}) {
  requirePrereqs();
  // Security review V6 #3: only the V0 raw transactional mount (`postMount:false` — convert's own
  // mount, relocateVault / verifyVaultPassword) carries the CURRENT marker as its token, so the inner
  // entry exempts exactly the transaction owning that marker; `unlock` / `run` never pass one.
  const txn = postMount ? undefined : currentTxnToken(v.name);
  // `how` stays undefined until doMount settles — a THROW from doMount may still have MOUNTED
  // (identity verification runs INSIDE the __mount child, after gocryptfs succeeded), so the
  // catch treats how === undefined exactly like "mounted-now": probe & roll back (r2 ruling A3).
  let how;
  try {
    how = await doMount(v, { txn });
    const st = await probeMountState(v);
    if (st !== "mounted")
      throw new CliError(EXIT.FAIL, `挂载未生效（mountinfo：${st}），请 pi-secure status ${v.name}`);
    const { realMnt } = physicalPaths(v);
    // V0 (convert-plan §1.4 step 2 / §3.4): `postMount:false` mounts RAW — no ensureVaultDirs, no
    // sessionDir write. Transactional callers (convert's own mount, the init --fix-settings /
    // import --verify-password relocation entry) own the post-mount steps themselves.
    if (postMount) runPostMount(v, { fix, realMnt });
    return { how, realMnt };
  } catch (e) {
    if (how !== "already") await rollbackFreshMount(v, e); // a pre-existing mount is left as found
    throw e;
  }
}

/** The entry's current transaction marker (pending, else relocate.txid) — undefined when none / unreadable. */
function currentTxnToken(name) {
  let e;
  try {
    e = getVaultEntryRaw(name);
  } catch {
    return undefined; // the inner entry re-reads settings and refuses on its own
  }
  if (!isPlainObject(e)) return undefined;
  if (typeof e.pending === "string") return e.pending;
  if (isPlainObject(e.relocate) && typeof e.relocate.txid === "string") return e.relocate.txid;
  return undefined;
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
  // `unlock <name> [--global]` (Q5). Without --global the argv rule is byte-identical to before.
  const global = args.includes("--global");
  const pos = args.filter((a) => a !== "--global");
  const [name, ...rest] = pos;
  if (!name || rest.length || args.filter((a) => a === "--global").length > 1)
    throw new CliError(EXIT.USAGE, usageText());
  const { vault: v } = must(resolveVault(name));
  requireNewLayout(v); // §L.3
  refuseUnfinished(v); // convert-plan §3.5 / §3.4 (V6)
  if (v.private === true && !global)
    throw new CliError(
      EXIT.REFUSED_ARGS,
      `${name} 配置为 --private（secure.vaults.${name}.private=true）：默认不做全局解锁——全局挂载对所有同用户进程可见。` +
        `用 pi-secure run ${name}（私有命名空间）；确需全局解锁：pi-secure unlock ${name} --global（不绕过与私有实例的互斥）`,
    );
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
  let kill = false;
  const pos = [];
  for (const a of args) {
    if (a === "--lazy") lazy = true;
    else if (a === "--kill") kill = true;
    else pos.push(a);
  }
  if (pos.length !== 1) throw new CliError(EXIT.USAGE, usageText());
  if (lazy && kill) throw new CliError(EXIT.USAGE, "--lazy 与 --kill 不能同用");
  const { vault: v } = must(resolveVault(pos[0], { allowAgentInVault: true })); // locking stays possible
  // §3.7: private instances first; `none` ⇒ the original lock path below, output unchanged.
  if (v.layout !== "legacy") {
    const view = await freshView(v);
    const d = lockPrivateDecision(v, view, { lazy, kill });
    if (d.action !== "plain") return await lockPrivate(v, view, d, { lazy, kill });
    if (d.note) err(d.note);
  } else if (kill) err("--kill 只用于 --private 实例；按普通 lock 处理");
  const r = await finalizeBounded(v, { lazy });
  for (const l of r.lines) (r.code === 0 ? out : err)(l);
  return r.code;
}

export async function describeVault(v, { scan = true, probe = probeMountState, unmappedUid } = {}) {
  const lines = [];
  const st = await probe(v);
  // N2 review #1: status stays bounded. Only a PROVEN-absent mount lets checkLayout touch the
  // mount point (lstat/readdir of the sentinels, synchronous); hung (the probe's readdir never
  // finished), foreign and stale all skip every access under <mnt> — the <dir> metadata, position
  // and ancestor checks (all outside the mount) still run.
  // N2 review #2: inside a user namespace, unmapped ancestor owners are reported as n/a.
  const lay = checkLayout(v, {
    mounted: st !== "absent",
    others: otherRegisteredVaults(v),
    unmappedUid: unmappedUid === undefined ? currentUnmappedUid() : unmappedUid === null ? undefined : unmappedUid,
  });
  const notes = [];
  if (st === "hung")
    notes.push(`  ! 挂载探测超时（gocryptfs 无响应？）：未检查挂载点内容；必要时 fusermount3 -uz ${v.mnt}`);
  if (lay.indeterminate?.length)
    notes.push(
      `  ancestors: n/a for ${lay.indeterminate.length} level(s) (unmapped owner inside a user namespace; enforced outside at mount/claim time)`,
    );
  const layout = !lay.exists ? "missing" : lay.problems.length ? "incomplete" : v.layout === "legacy" ? "legacy" : "ok";
  // §3.8: a private instance (or an unrecorded lease holder) renders its own block; `none` keeps
  // the original output byte-for-byte (legacy vaults are never probed — they have no lease).
  if (v.layout !== "legacy") {
    const view = await vaultInstanceView(v, st);
    if (view.state !== "none") {
      const pl = renderPrivateStatus(v, { st, layout, problems: lay.problems, view });
      pl.splice(2 + lay.problems.length, 0, ...notes); // right after the dir / problem lines
      pl.push(...txnVaultLines(v, { quote: await backupQuoter(v) })); // V6: empty unless the entry carries the keys
      return { lines: pl, st, scan: false };
    }
  }
  lines.push(`${v.name}: ${st === "absent" ? "locked" : st}  layout ${layout}  mnt ${v.mnt}`);
  lines.push(`  dir ${v.dir}`);
  for (const p of lay.problems) lines.push(`  ! ${p}`);
  lines.push(...notes); // empty unless hung / inside a user namespace (host output unchanged)
  if (v.layout === "legacy") {
    lines.push(`  ! 旧布局（挂载点 ${v.mnt}）：仅 status/lock 可用，unlock/run/init --fix-settings 已拒绝`);
    lines.push(`  ! ${legacyRefusal(v)}`);
  } else if (layout !== "ok" && lay.exists)
    lines.push(
      `  恢复：确认 ${v.dir} 与挂载点 ${v.mnt}（未挂载、只含 work/state 两个哨兵）里没有要保留的数据后一并删除，再 pi-secure init ${v.name}`,
    );
  if (st === "stale") lines.push(`  ! 失效挂载（守护进程已不在）：pi-secure unlock ${v.name} 会先清理再挂载`);
  lines.push(...txnVaultLines(v, { quote: await backupQuoter(v) })); // V6: empty unless the entry carries the keys
  return { lines, st, scan: scan && st === "mounted" };
}

/**
 * convert-plan §1.7 / §3.4 / §3.5 (V6): per-vault lines for the transaction keys — each line
 * appears ONLY when its key is on the entry (backup: only while that path still exists), so a
 * vault without them prints byte-identical output (G1). lstat only (never follows, never reads).
 */
export function txnVaultLines(v, { exists = (p) => lstatOrNull(p) !== null, quote } = {}) {
  const lines = [];
  if (v.txnInvalid !== undefined) lines.push(`  ! ${txnInvalidRefusal(v)}`);
  if (v.pending !== undefined) lines.push(`  pending: ${v.pending} · ${pendingRefusal(v)}`);
  if (v.relocate !== undefined)
    lines.push(
      `  relocate: pending (${v.relocate.phase}) · ${v.relocate.from} → ${v.relocate.to} · pi-secure init ${v.name} --fix-settings`,
    );
  if (v.origin !== undefined) lines.push(`  origin: ${v.origin}`);
  // security review V6 #4: the copy-paste command quotes the path with V4's shellQuote (convert.mjs);
  // without a quoter only the path is shown — never an unquoted command.
  if (v.backup !== undefined && exists(v.backup))
    lines.push(
      quote
        ? `  backup: ${v.backup} (still present) · 确认保险库内容无误后自行删除：chmod -R u+w -- ${quote(v.backup)} && rm -rf -- ${quote(v.backup)}`
        : `  backup: ${v.backup} (still present) · 确认保险库内容无误后自行删除`,
    );
  return lines;
}

/** V4's shellQuote, loaded only when a backup line can appear (convert.mjs is not loaded otherwise). */
async function backupQuoter(v) {
  if (v.backup === undefined) return undefined;
  try {
    return (await import("./convert.mjs")).shellQuote;
  } catch {
    return undefined;
  }
}

/** `<name>.aborted-<txid>` leftovers of a rolled-back convert (convert-plan r3.1) next to a vault dir/mnt. */
const ABORTED_RE = /^([a-z0-9][a-z0-9_-]{0,31})\.aborted-([0-9a-f]{8,64})$/;

/**
 * Directories to look for `.aborted-<txid>` leftovers in: the default parents of `<dir>` and
 * `<mnt>` plus the parents of every registered vault's dir/mnt. Listing a parent never enters a
 * mount (readdir of the parent only); entries are lstat'ed, never followed.
 */
export function listAbortedLeftovers(home, vaults = [], { only } = {}) {
  const parents = new Set([path.dirname(defaultVaultDir("x", home)), path.dirname(defaultVaultMnt("x", home))]);
  for (const v of vaults) {
    parents.add(path.dirname(v.dir));
    parents.add(path.dirname(v.mnt));
  }
  const found = [];
  for (const dir of [...parents].sort()) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names.sort()) {
      const m = ABORTED_RE.exec(n);
      if (!m || (only !== undefined && m[1] !== only)) continue;
      const p = path.join(dir, n);
      const st = lstatOrNull(p);
      if (st && st.isDirectory() && !st.isSymbolicLink()) found.push(p);
    }
  }
  return found;
}

/**
 * V6 status block: interrupted convert / import state files (V4 `listInterruptedConverts`,
 * V5 `listImportStates`) and `.aborted-<txid>` leftovers. Nothing at all is printed (and neither
 * engine module is loaded) when `.txn/` has no entry and no leftover exists — G1.
 */
export async function txnStatusLines(home, vaults, { only } = {}) {
  const lines = [];
  const txn = path.join(home, ".local", "share", "pi-toolkit-secure", ".txn");
  let names = [];
  try {
    names = fs.readdirSync(txn);
  } catch {
    /* no .txn ⇒ nothing interrupted */
  }
  const want = (n) => only === undefined || n === only;
  if (names.some((n) => /^convert-.*\.json$/.test(n))) {
    try {
      const C = await import("./convert.mjs");
      for (const e of C.listInterruptedConverts(txn)) if (want(e.name)) lines.push(C.formatInterruptedLine(e));
    } catch (e) {
      lines.push(`convert: ! 无法读取中断的转换（${(e && e.message) || e}）`);
    }
  }
  if (names.some((n) => /^import-.*\.json$/.test(n))) {
    try {
      const A = await import("./archive.mjs");
      for (const l of A.listImportStates(home)) if (want(/^import (\S+):/.exec(l)?.[1])) lines.push(l);
    } catch (e) {
      lines.push(`import: ! 无法读取中断的导入（${(e && e.message) || e}）`);
    }
  }
  for (const p of listAbortedLeftovers(home, vaults, { only }))
    lines.push(`aborted: ${p} · 回滚留下的副本（内含本次拷贝的密文或数据），核对后可自行删除`);
  return lines;
}

/** Other vaults from the settings file (for §L.1 position rules); empty on any read problem. */
export function otherRegisteredVaults(v) {
  const { cfg } = loadSecureConfig(homeDir());
  return cfg.valid ? cfg.vaults.filter((x) => x.name !== v.name) : [];
}

async function cmdStatus(args) {
  if (args.length > 1) throw new CliError(EXIT.USAGE, usageText());
  const home = homeDir();
  const { file, cfg, readError, agentProblem } = loadSecureConfig(home);
  const p = preflight();
  out(`gocryptfs: ${p.version ? p.version.join(".") : "n/a"}${p.ok ? "" : "  (" + p.problems.join("; ") + ")"}`);
  // settings-rename §3.6.1: path-source suffix ONLY off the default dir (default output is byte-identical)
  const agentInfo = resolveAgentDir(process.env, home);
  const settingsTag =
    agentInfo.source === "env"
      ? resolveSettingsLocation(agentInfo).scope === "inherited"
        ? "  [inherited]"
        : "  [agentDir: env]"
      : "";
  out(
    `settings: ${file}${settingsTag}${readError ? `  ! ${readError}` : !cfg.valid ? `  ! ${cfg.error}` : cfg.present ? (cfg.enabled ? "" : "  secure.enabled=false") : "  (no secure section)"}`,
  );
  if (agentInfo.ignored)
    out("  ! PI_CODING_AGENT_DIR 是相对路径，已忽略：插件设置与 traffic 仍在 ~/.pi/agent（不支持的配置）");
  if (agentProblem) out(`  ! ${agentProblem}`);
  for (const bad of cfg.invalid) out(`  ! secure.vaults.${bad.name} invalid (${bad.reason})`);
  let vaults = cfg.vaults;
  if (args[0]) {
    const r = resolveVault(args[0], { allowUnregistered: true, allowAgentInVault: true });
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
  // V6: interrupted transactions + rollback leftovers (only when present ⇒ G1 byte-identical)
  for (const l of await txnStatusLines(home, cfg.valid ? cfg.vaults : [], { only: args[0] })) out(l);
  const w = systemWarnings(home);
  // V7 review M1: any test variable present (gated or not) is called out (absent ⇒ byte-identical)
  const seamVars = [...testSeamNames(), ...(process.env[TEST_SEAMS_GATE] ? [TEST_SEAMS_GATE] : [])];
  if (seamVars.length)
    w.push(
      `测试用环境变量已设置：${seamVars.join("、")}${testSeamWarnings().some((l) => l.startsWith("测试缝已启用")) ? "（测试缝已启用）" : "（已忽略）"}——真实使用时请 unset`,
    );
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
export function piChildEnv(v, cwd, env = process.env, { ns = false } = {}) {
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
  if (ns) next.PI_SECURE_NS = "1"; // private-plan §2.4: hint only (evidence-based check is authoritative)
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
  if (!name || name.startsWith("-")) throw new CliError(EXIT.USAGE, usageText());
  // §1.1 fixed order: [--private|--no-private] right after the name, then the old `-C` rule.
  const flags = parseRunFlags(rest);
  const { sub, piArgs } = flags;
  const r = must(resolveVault(name));
  const v = r.vault;
  requireNewLayout(v); // §L.3: legacy vaults never run
  refuseUnfinished(v); // convert-plan §3.5 / §3.4 (V6): pending ⇒ 76, relocate ⇒ 78 (both run modes)
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
  if (flags.private ?? v.private === true) return await runPrivate(v, { sub, piArgs, piBin, pkg });
  if (flags.private === false && v.private === true)
    err(`提醒：${name} 配置为 --private，本次以普通模式运行——会话期间明文挂载对所有同用户进程可见`);

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

// ═════════════════════════════ private mode (private-plan r3, package N1) ═════════════════════════════
//
// Process chain (§2.1): P0 (this launcher, initial ns) → /bin/sh opens + flocks mount.lease as fd 9
// (no CLOEXEC) and execs → unshare --user --map-root-user --mount --propagation private → P1
// (`__ns-root`, ns-root supervisor) → gocryptfs -fg (setsid, explicit stdio slot 9) and
// unshare --user --map-user/--map-group → pi (real uid, CapEff 0, slot 9). Node sets CLOEXEC on the
// inherited fd 9, so ONLY spawns built with LEASE_STDIO ever receive it (I-P9).
//
// Invariants implemented here (ids from §7.3): I-P2 (lease + non-stale record), I-P3 (records are
// deleted ONLY by `__private-release` running under the real lease + mount.lock, outside the ns,
// plus the single BUSY exception `__private-abort-start`), I-P4 (signals only to recorded /
// ns-proven identities, re-verified right before each signal), I-P5 (no sync fs on the mount
// path in supervisors — `__mount-work` workers; every stage bounded), I-P9 (fd 9 hygiene).

export const LEASE_BUSY_CODE = 213; // shell lease chain: another holder owns mount.lease (NC11: not a gocryptfs code)
export const PRIVATE_RECORD_FILE = "private.json";
export const PRIVATE_RECORD_MAX_BYTES = 4096;
export const PRIVATE_PHASES = ["starting", "mounting", "launching", "setup", "session", "finalizing"];
/** §2.6 budget table (ms unless noted). Every non-interactive stage is bounded by one of these. */
export const PRIVATE_BUDGET = Object.freeze({
  claimLockWaitS: 10,
  claimWorkMs: 3_000,
  preflightMs: 3_000,
  mountAttemptMs: MOUNT_ATTEMPT_TIMEOUT_MS,
  mountKillGraceMs: 2_000,
  mountAbandonMs: 3_000,
  readyMs: 3_000,
  postMountMs: 20_000,
  recordLockWaitS: 1.5,
  recordStepMs: 2_000,
  finalizeInNsMs: 10_000,
  releaseLeaseWaitS: 3,
  releaseMountLockWaitS: 2,
  scanMs: 2_000,
  outerCleanupMs: 10_000,
  hardGraceMs: 500,
  workerKillGraceMs: 2_000,
  workerAbandonMs: 1_000,
  sessionKillGraceMs: 5_000,
});
/** Explicit stdio for fd-9 holders (gocryptfs, inner unshare→pi): 0–2 inherited, 3–8 closed, 9 = fd 9. */
export const LEASE_STDIO = Object.freeze([
  "inherit",
  "inherit",
  "inherit",
  "ignore",
  "ignore",
  "ignore",
  "ignore",
  "ignore",
  "ignore",
  9,
]);
/** stdio for every other child (workers, flock, umount, record updaters): never slot 9. */
export const NO_LEASE_STDIO = Object.freeze(["ignore", "pipe", "pipe"]);

/** Internal exit codes of the record subcommands (never user-visible). */
export const REC = Object.freeze({
  OK: 0,
  MISMATCH: 22,
  MEMBERS: 21,
  INCOMPLETE: 23,
  NONE: 24,
  CORRUPT: 25,
  SUPERVISOR: 26, // review N4-r2 #1: the supervisor is not PROVABLY dead ⇒ no outer cleanup
});

export const PRIVATE_BOUNDARY_SHORT =
  "防路径直读/扫描/备份/其他程序的无意识访问；不防同 uid 定向进程（/proc/<pid>/root、setns）";
export const PRIVATE_BOUNDARY_LONG =
  "--private：明文挂载只存在于本次 pi 进程树的私有挂载命名空间里。其他程序按路径访问保险库只会看到占位文件，" +
  "find/grep/备份工具/其他 agent 的无意识访问都会被挡住。它不能防御同一用户下有意的恶意进程：" +
  "这类进程可以经 /proc/<pid>/root、/proc/<pid>/cwd 读到明文，或用 setns 加入该命名空间。" +
  "若需要硬边界，请用独立的系统用户运行 pi-secure。";

// ───────────────────────────── run flags (§1.1, fixed order) ─────────────────────────────

/**
 * `run <name> [--private|--no-private] [-C <sub>] [pi args…]`. The two new flags are recognized
 * ONLY right after the name; `-C` keeps its single first-position rule; everything else is pi's.
 * Without the new flags the split is byte-identical to the pre-N1 code (`rest[0] === "-C"`).
 */
export function parseRunFlags(rest) {
  let i = 0;
  let priv;
  if (rest[0] === "--private" || rest[0] === "--no-private") {
    priv = rest[0] === "--private";
    i = 1;
    if (rest[1] === "--private" || rest[1] === "--no-private")
      throw new CliError(EXIT.USAGE, "--private 与 --no-private 只能给一个（且只在保险库名之后紧跟一次）");
  }
  let sub;
  let piArgs = rest.slice(i);
  if (rest[i] === "-C") {
    if (rest.length < i + 2) throw new CliError(EXIT.USAGE, "-C 需要子目录");
    sub = rest[i + 1];
    piArgs = rest.slice(i + 2);
  }
  return { private: priv, sub, piArgs };
}

// ───────────────────────────── /proc facts ─────────────────────────────

/** Fields of /proc/<pid>/stat after the comm: {state, ppid, pgrp, sid, start}. undefined on junk. */
export function parseProcStat(text) {
  if (typeof text !== "string") return undefined;
  const close = text.lastIndexOf(")");
  if (close < 0) return undefined;
  const f = text
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  // field 3 (state) is f[0]; ppid 4 → f[1]; pgrp 5 → f[2]; session 6 → f[3]; starttime 22 → f[19]
  const start = Number(f[19]);
  if (!Number.isSafeInteger(start)) return undefined;
  return { state: f[0], ppid: Number(f[1]), pgrp: Number(f[2]), sid: Number(f[3]), start };
}

export function readProcStartSync(pid, procRoot = "/proc") {
  try {
    return parseProcStat(fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8"))?.start;
  } catch {
    return undefined;
  }
}

/**
 * Review N4-r2 #1: never swallow a read error. → {kind:"live", start} | {kind:"gone"} (ENOENT/ESRCH:
 * the process is gone; or a zombie: it has exited) | {kind:"error", code} (EACCES, EIO, EMFILE,
 * unparsable stat, … — says NOTHING about whether the process is alive).
 */
export async function readProcStart(pid, { procRoot = "/proc", readFile = fsp.readFile } = {}) {
  let t;
  try {
    t = await readFile(path.join(procRoot, String(pid), "stat"), "utf8");
  } catch (e) {
    return GONE_CODES.has(e?.code) ? { kind: "gone" } : { kind: "error", code: String(e?.code ?? "EUNKNOWN") };
  }
  const st = parseProcStat(t);
  if (!st) return { kind: "error", code: "EPARSE" };
  return st.state === "Z" ? { kind: "gone" } : { kind: "live", start: st.start };
}

/**
 * Three-state identity check (review N4-r2 #1): "dead" ONLY on proof — the pid is gone
 * (ENOENT/ESRCH / zombie) or a live process there has a different starttime; any other read
 * failure is "unknown" (callers must treat it as possibly alive). → "alive" | "dead" | "unknown"
 */
export async function identityState(id, opts = {}) {
  if (!id || !Number.isSafeInteger(id.pid) || id.pid < 2 || !Number.isSafeInteger(id.start)) return "unknown";
  const r = await readProcStart(id.pid, opts);
  if (r.kind === "gone") return "dead";
  if (r.kind === "error") return "unknown";
  return r.start === id.start ? "alive" : "dead";
}

/** pid+starttime still names the same live (non-zombie) process? (false also when unknown) */
export async function identityAlive(id, opts = {}) {
  return (await identityState(id, opts)) === "alive";
}

export function readBootIdSync() {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return undefined;
  }
}

export function readNsLinkSync(pid, kind, procRoot = "/proc") {
  try {
    return fs.readlinkSync(path.join(procRoot, String(pid), "ns", kind));
  } catch {
    return undefined;
  }
}

/** Linux dev_t → major/minor (glibc encoding; inverse of devFromMajMin). */
export function devMajMin(dev) {
  const d = BigInt(dev);
  const maj = Number(((d >> 8n) & 0xfffn) | ((d >> 32n) & 0xfffff000n));
  const min = Number((d & 0xffn) | ((d >> 12n) & 0xffffff00n));
  return { maj, min };
}

/**
 * /proc/locks lines: `1: FLOCK  ADVISORY  WRITE 1234 08:01:145137 0 EOF`; blocked waiters carry
 * `->` after the id. The device is HEX (`%02x:%02x`). → [{blocked,type,mode,rw,pid,maj,min,ino}]
 */
export function parseProcLocks(text) {
  const out = [];
  for (const line of (text ?? "").split("\n")) {
    const m = /^\s*\d+:\s+(->\s+)?(\S+)\s+(\S+)\s+(\S+)\s+(-?\d+)\s+([0-9a-fA-F]+):([0-9a-fA-F]+):(\d+)\s/.exec(
      line + " ",
    );
    if (!m) continue;
    out.push({
      blocked: m[1] !== undefined,
      type: m[2],
      mode: m[3],
      rw: m[4],
      pid: Number(m[5]),
      maj: parseInt(m[6], 16),
      min: parseInt(m[7], 16),
      ino: Number(m[8]),
    });
  }
  return out;
}

/** A granted (non-waiter) FLOCK on exactly the lease inode? `lease.dev` is decimal "maj:min". */
export function leaseHeldIn(procLocksText, lease) {
  const [maj, min] = String(lease.dev).split(":").map(Number);
  return parseProcLocks(procLocksText).some(
    (e) => !e.blocked && e.type === "FLOCK" && e.maj === maj && e.min === min && e.ino === lease.ino,
  );
}

/** Read-only lease probe (§3.1): "held" | "free" | "unknown" (unreadable / late ⇒ unknown ⇒ refuse). */
export async function probeLease(lease, { procRoot = "/proc", deadline = Date.now() + PRIVATE_BUDGET.scanMs } = {}) {
  if (!lease) return "unknown";
  const r = await deadlineRace(
    fsp.readFile(path.join(procRoot, "locks"), "utf8").then(
      (t) => (leaseHeldIn(t, lease) ? "held" : "free"),
      () => "unknown",
    ),
    deadline,
  ).catch(() => "unknown");
  return r === TIMEOUT ? "unknown" : r;
}

/** lstat the lease as an own 0600 regular file → {dev:"maj:min", ino} | {problem}. */
export function leaseIdentitySync(v, uid = process.getuid()) {
  const st = lstatOrNull(v.lease);
  if (!st) return { problem: `${v.lease} 缺失` };
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o777) !== 0o600)
    return { problem: `${v.lease} 须为本用户的 0600 普通文件` };
  const { maj, min } = devMajMin(st.dev);
  return { dev: `${maj}:${min}`, ino: st.ino };
}

// ───────────────────────────── private.json (§3.2) ─────────────────────────────

const HEX32_RE = /^[0-9a-f]{32}$/;
const MAJMIN_RE = /^\d{1,10}:\d{1,10}$/;
const NS_MNT_RE = /^mnt:\[\d{1,20}\]$/;
const NS_USER_RE = /^user:\[\d{1,20}\]$/;
const isIdentity = (v) =>
  isPlainObject(v) && Number.isSafeInteger(v.pid) && v.pid >= 2 && Number.isSafeInteger(v.start) && v.start >= 0;
const isExitCode = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 255;
const isShortString = (v, max = 256) => typeof v === "string" && v !== "" && v.length <= max;
const isAbsPath = (v) => isShortString(v, 4096) && v.startsWith("/") && !v.includes("\0");

/** Parity twin of config.ts `parsePrivateRecord` (strict known keys, unknown keys dropped, never throws). */
export function parsePrivateRecord(text) {
  if (typeof text !== "string") return { kind: "corrupt", reason: "type" };
  if (Buffer.byteLength(text, "utf8") > PRIVATE_RECORD_MAX_BYTES) return { kind: "corrupt", reason: "size" };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "corrupt", reason: "json" };
  }
  if (!isPlainObject(raw)) return { kind: "corrupt", reason: "shape" };
  const bad = (field) => ({ kind: "corrupt", reason: `field:${field}` });
  if (raw.v !== 3) return bad("v");
  if (typeof raw.instanceId !== "string" || !HEX32_RE.test(raw.instanceId)) return bad("instanceId");
  if (typeof raw.name !== "string" || !VAULT_NAME_RE.test(raw.name)) return bad("name");
  if (typeof raw.phase !== "string" || !PRIVATE_PHASES.includes(raw.phase)) return bad("phase");
  if (raw.mode !== undefined && raw.mode !== "run" && raw.mode !== "setup") return bad("mode");
  if (!isShortString(raw.bootId, 64)) return bad("bootId");
  if (!isShortString(raw.createdAt, 64)) return bad("createdAt");
  if (!isAbsPath(raw.realCipher)) return bad("realCipher");
  if (!isAbsPath(raw.realMnt)) return bad("realMnt");
  const lease = raw.lease;
  if (
    !isPlainObject(lease) ||
    typeof lease.dev !== "string" ||
    !MAJMIN_RE.test(lease.dev) ||
    !Number.isSafeInteger(lease.ino) ||
    lease.ino < 1
  )
    return bad("lease");
  if (!isIdentity(raw.owner)) return bad("owner");
  for (const k of ["supervisor", "gocryptfs", "pi"]) if (raw[k] !== undefined && !isIdentity(raw[k])) return bad(k);
  if (raw.piExit !== undefined && !(isPlainObject(raw.piExit) && isExitCode(raw.piExit.code))) return bad("piExit");
  if (raw.failCode !== undefined && !isExitCode(raw.failCode)) return bad("failCode");
  if (raw.inNsDone !== undefined && typeof raw.inNsDone !== "boolean") return bad("inNsDone");
  if (
    raw.inNsPending !== undefined &&
    !(
      Array.isArray(raw.inNsPending) &&
      raw.inNsPending.length <= 16 &&
      raw.inNsPending.every((x) => isShortString(x, 200))
    )
  )
    return bad("inNsPending");
  const ns = raw.ns;
  if (
    ns !== undefined &&
    !(
      isPlainObject(ns) &&
      typeof ns.mnt === "string" &&
      NS_MNT_RE.test(ns.mnt) &&
      typeof ns.user === "string" &&
      NS_USER_RE.test(ns.user) &&
      (ns.innerUser === undefined || (typeof ns.innerUser === "string" && NS_USER_RE.test(ns.innerUser)))
    )
  )
    return bad("ns");
  if (raw.lazyDetachedAt !== undefined && !isShortString(raw.lazyDetachedAt, 64)) return bad("lazyDetachedAt");
  const id = (x) => ({ pid: x.pid, start: x.start });
  const record = {
    v: 3,
    instanceId: raw.instanceId,
    name: raw.name,
    phase: raw.phase,
    ...(raw.mode !== undefined ? { mode: raw.mode } : {}),
    bootId: raw.bootId,
    createdAt: raw.createdAt,
    realCipher: raw.realCipher,
    realMnt: raw.realMnt,
    lease: { dev: lease.dev, ino: lease.ino },
    owner: id(raw.owner),
    ...(raw.supervisor !== undefined ? { supervisor: id(raw.supervisor) } : {}),
    ...(raw.gocryptfs !== undefined ? { gocryptfs: id(raw.gocryptfs) } : {}),
    ...(raw.pi !== undefined ? { pi: id(raw.pi) } : {}),
    ...(raw.piExit !== undefined ? { piExit: { code: raw.piExit.code } } : {}),
    ...(raw.failCode !== undefined ? { failCode: raw.failCode } : {}),
    ...(raw.inNsDone !== undefined ? { inNsDone: raw.inNsDone } : {}),
    ...(raw.inNsPending !== undefined ? { inNsPending: [...raw.inNsPending] } : {}),
    ...(ns !== undefined
      ? { ns: { mnt: ns.mnt, user: ns.user, ...(ns.innerUser !== undefined ? { innerUser: ns.innerUser } : {}) } }
      : {}),
    ...(raw.lazyDetachedAt !== undefined ? { lazyDetachedAt: raw.lazyDetachedAt } : {}),
  };
  return { kind: "ok", record };
}

export function privateRecordPath(v) {
  return path.join(v.dir, PRIVATE_RECORD_FILE);
}

function checkRecordStat(st, uid) {
  if (st.isSymbolicLink() || !st.isFile()) return "not-regular";
  if (st.uid !== uid) return "foreign-owner";
  if (st.size > PRIVATE_RECORD_MAX_BYTES) return "size";
  return undefined;
}

/** Sync read (short-lived children under mount.lock only; `<dir>` is a plain fs). none|ok|corrupt. */
export function readPrivateRecordSync(v, uid = process.getuid()) {
  const file = privateRecordPath(v);
  const st = lstatOrNull(file);
  if (!st) return { kind: "none" };
  const why = checkRecordStat(st, uid);
  if (why) return { kind: "corrupt", reason: why };
  let fd;
  try {
    fd = fs.openSync(file, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
    const fst = fs.fstatSync(fd);
    const w2 = checkRecordStat(fst, uid);
    if (w2) return { kind: "corrupt", reason: w2 };
    const buf = Buffer.alloc(PRIVATE_RECORD_MAX_BYTES + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n > PRIVATE_RECORD_MAX_BYTES) return { kind: "corrupt", reason: "size" };
    return parsePrivateRecord(buf.subarray(0, n).toString("utf8"));
  } catch (e) {
    if (e && e.code === "ENOENT") return { kind: "none" };
    return { kind: "corrupt", reason: `io:${(e && e.code) || "?"}` };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Async, deadline-bounded read for supervisors / status (never blocks the event loop). */
export async function readPrivateRecord(v, { deadline = Date.now() + PRIVATE_BUDGET.scanMs, uid } = {}) {
  const u = uid ?? process.getuid();
  const work = (async () => {
    const file = privateRecordPath(v);
    let fh;
    try {
      const st = await fsp.lstat(file);
      const why = checkRecordStat(st, u);
      if (why) return { kind: "corrupt", reason: why };
      fh = await fsp.open(file, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
      const fst = await fh.stat();
      const w2 = checkRecordStat(fst, u);
      if (w2) return { kind: "corrupt", reason: w2 };
      const buf = Buffer.alloc(PRIVATE_RECORD_MAX_BYTES + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (bytesRead > PRIVATE_RECORD_MAX_BYTES) return { kind: "corrupt", reason: "size" };
      return parsePrivateRecord(buf.subarray(0, bytesRead).toString("utf8"));
    } catch (e) {
      if (e && e.code === "ENOENT") return { kind: "none" };
      return { kind: "corrupt", reason: `io:${(e && e.code) || "?"}` };
    } finally {
      await fh?.close().catch(() => {});
    }
  })();
  const r = await deadlineRace(work, deadline).catch(() => ({ kind: "unknown" }));
  return r === TIMEOUT ? { kind: "unknown" } : r;
}

function fsyncDirSync(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, fsc.O_RDONLY | fsc.O_DIRECTORY);
    fs.fsyncSync(fd);
  } catch {
    /* best effort */
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeTmpRecord(v, rec) {
  const text = JSON.stringify(rec) + "\n";
  if (Buffer.byteLength(text) > PRIVATE_RECORD_MAX_BYTES) throw new Error("private.json 超过 4 KiB");
  const tmp = path.join(v.dir, `.${PRIVATE_RECORD_FILE}.tmp-${process.pid}-${Date.now()}`);
  const fd = fs.openSync(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return tmp;
}

/** O_EXCL-style creation (complete content or nothing): tmp + link(2) + unlink(tmp). EEXIST throws. */
export function writePrivateRecordExclusive(v, rec) {
  const tmp = writeTmpRecord(v, rec);
  try {
    fs.linkSync(tmp, privateRecordPath(v));
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
  fsyncDirSync(v.dir);
}

/** Replace an existing record (caller holds mount.lock and has compared instanceId). */
export function replacePrivateRecord(v, rec) {
  const tmp = writeTmpRecord(v, rec);
  try {
    fs.renameSync(tmp, privateRecordPath(v));
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
  fsyncDirSync(v.dir);
}

function deletePrivateRecordSync(v) {
  fs.unlinkSync(privateRecordPath(v));
  fsyncDirSync(v.dir);
}

/** Allowed phase transitions for record updates (setup mode: mounting → setup → finalizing). */
const PHASE_NEXT = {
  starting: ["starting", "mounting", "finalizing"],
  mounting: ["mounting", "launching", "setup", "finalizing"],
  launching: ["launching", "session", "finalizing"],
  setup: ["setup", "finalizing"],
  session: ["session", "finalizing"],
  finalizing: ["finalizing"],
};
const UPDATABLE_KEYS = [
  "phase",
  "supervisor",
  "gocryptfs",
  "pi",
  "piExit",
  "failCode",
  "inNsDone",
  "inNsPending",
  "ns",
  "lazyDetachedAt",
];

/**
 * Pure CAS step (§3.2): returns the next record or {error}. Only the instance owner (matching
 * instanceId) may write; phases only move forward; `instanceId`/`lease`/`owner`/paths are immutable.
 */
export function applyRecordPatch(current, instanceId, patch) {
  if (!current) return { error: "none" };
  if (current.instanceId !== instanceId) return { error: "mismatch" };
  if (!isPlainObject(patch)) return { error: "patch" };
  for (const k of Object.keys(patch)) if (!UPDATABLE_KEYS.includes(k)) return { error: `patch:${k}` };
  if (patch.phase !== undefined && !(PHASE_NEXT[current.phase] ?? []).includes(patch.phase))
    return { error: `phase:${current.phase}->${patch.phase}` };
  // Once registered, the ns ids are immutable (only `innerUser` may be added, once).
  if (patch.ns !== undefined && current.ns !== undefined) {
    const n = patch.ns;
    if (!isPlainObject(n) || n.mnt !== current.ns.mnt || n.user !== current.ns.user) return { error: "ns:immutable" };
    if (current.ns.innerUser !== undefined && n.innerUser !== current.ns.innerUser) return { error: "ns:immutable" };
  }
  for (const k of ["supervisor", "gocryptfs", "pi"])
    if (patch[k] !== undefined && current[k] !== undefined && JSON.stringify(patch[k]) !== JSON.stringify(current[k]))
      return { error: `${k}:immutable` };
  const next = { ...current, ...patch };
  const p = parsePrivateRecord(JSON.stringify(next));
  if (p.kind !== "ok") return { error: `invalid:${p.reason}` };
  return { record: p.record };
}

// ───────────────────────────── ns member scan (§3.3) ─────────────────────────────

/** Errors that PROVE a /proc entry is gone (the process exited / was reaped). Nothing else does. */
const GONE_CODES = new Set(["ENOENT", "ESRCH"]);

/** `Uid:` line of /proc/<pid>/status → [real, effective, saved, fs] (numbers) | undefined. */
export function parseStatusUids(text) {
  const m = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(text ?? "");
  return m ? m.slice(1, 5).map(Number) : undefined;
}

/**
 * Processes whose /proc/<pid>/ns/mnt equals `nsMnt` (security review N1 #1: FAIL CLOSED).
 *
 * Classification per pid: /proc/<pid>/status (world-readable, also for non-dumpable processes —
 * unlike the /proc/<pid> owner, which flips to root) gives the uids. ONLY ENOENT/ESRCH count as
 * "gone"; any other error on status/ns links/stat ⇒ the whole scan is `incomplete`. A process of
 * ANOTHER uid whose ns link is unreadable (EACCES/EPERM) is skipped — it cannot be one of our
 * members without privileges over our userns; a SAME-uid process whose link is unreadable
 * (ptrace/LSM refusal, non-dumpable) is skipped ONLY when its starttime proves it predates
 * `minStart` (never a member, §3.3) — otherwise the scan is incomplete. `minStart` excludes processes started before
 * the supervisor (never its descendants, §3.3). Members carry {pid,start,ppid,user,comm}.
 * `fsImpl` ({readdir, readlink, readFile}) is a test seam. `deniedMeans:"outside"` is reserved for
 * the supervisor's own in-ns finalize (see the inline note). Never returns an empty scan on doubt.
 * → {kind:"done", members} | {kind:"incomplete", reason}
 */
export async function scanNsMembers(
  nsMnt,
  {
    procRoot = "/proc",
    deadline = Date.now() + PRIVATE_BUDGET.scanMs,
    minStart,
    exclude = [],
    maxEntries = SCAN_MAX_ENTRIES,
    uid = process.getuid(),
    fsImpl = fsp,
    deniedMeans = "incomplete",
  } = {},
) {
  const skip = new Set(exclude.map(Number));
  const settle = (p) =>
    p.then(
      (value) => ({ value }),
      (e) => ({ code: (e && e.code) || "EUNKNOWN" }),
    );
  const work = (async () => {
    let names;
    try {
      names = (await fsImpl.readdir(procRoot)).filter((n) => /^\d+$/.test(n));
    } catch (e) {
      return { kind: "incomplete", reason: `readdir ${(e && e.code) || "?"}` };
    }
    if (names.length > maxEntries) return { kind: "incomplete", reason: `too-many ${names.length}` };
    const hits = [];
    for (let i = 0; i < names.length; i += 64) {
      if (Date.now() >= deadline) return TIMEOUT;
      const batch = names.slice(i, i + 64);
      const rows = await Promise.all(
        batch.map(async (n) => ({
          n,
          status: await settle(fsImpl.readFile(path.join(procRoot, n, "status"), "utf8")),
          link: await settle(fsImpl.readlink(path.join(procRoot, n, "ns", "mnt"))),
        })),
      );
      for (const { n, status, link } of rows) {
        if (status.code && GONE_CODES.has(status.code)) continue;
        if (status.code) return { kind: "incomplete", reason: `status ${n} ${status.code}` };
        const uids = parseStatusUids(status.value);
        if (!uids) return { kind: "incomplete", reason: `status ${n} unparsable` };
        const sameUid = uids.includes(uid);
        if (link.code) {
          if (GONE_CODES.has(link.code)) continue;
          const denied = link.code === "EACCES" || link.code === "EPERM";
          if (!sameUid && denied) continue;
          // ONLY the supervisor's in-ns finalize passes deniedMeans:"outside": as root of its own
          // userns it can read every process of its userns lineage, so a denial means the target
          // lives outside it (a host process) — and joining our mntns requires being in that
          // lineage (setns needs CAP_SYS_CHROOT in the caller's own userns, §1.2 ⑫/R21). Deletion
          // gates (release / judge / outer terminate) never use it: P0's scan from the initial
          // userns stays authoritative and fail-closed.
          if (denied && deniedMeans === "outside") continue;
          if (denied && minStart !== undefined) {
            // Same uid but unreadable (non-dumpable: sd-pam, sshd session, setuid helpers…). Its
            // starttime is world-readable: one that started BEFORE the supervisor can never be a
            // counted member (§3.3), so it is safely skipped; anything newer ⇒ incomplete.
            const stR = await settle(fsImpl.readFile(path.join(procRoot, n, "stat"), "utf8"));
            if (stR.code && GONE_CODES.has(stR.code)) continue;
            const pst = stR.code ? undefined : parseProcStat(stR.value);
            if (pst && pst.start < minStart) continue;
            const comm = await settle(fsImpl.readFile(path.join(procRoot, n, "comm"), "utf8"));
            return {
              kind: "incomplete",
              reason: `ns ${n}${comm.code ? "" : ` ${comm.value.trim()}`} ${link.code}${stR.code ? ` stat ${stR.code}` : ""}`,
            };
          }
          return { kind: "incomplete", reason: `ns ${n} ${link.code}` };
        }
        if (link.value === nsMnt) hits.push(Number(n));
      }
    }
    const members = [];
    for (const pid of hits) {
      if (skip.has(pid)) continue;
      if (Date.now() >= deadline) return TIMEOUT;
      const dir = path.join(procRoot, String(pid));
      const statR = await settle(fsImpl.readFile(path.join(dir, "stat"), "utf8"));
      if (statR.code && GONE_CODES.has(statR.code)) continue;
      if (statR.code) return { kind: "incomplete", reason: `stat ${pid} ${statR.code}` };
      const st = parseProcStat(statR.value);
      if (!st) return { kind: "incomplete", reason: `stat ${pid} unparsable` };
      if (st.state === "Z" || st.state === "X") continue; // a zombie holds no mount reference
      if (minStart !== undefined && st.start < minStart) continue;
      const userR = await settle(fsImpl.readlink(path.join(dir, "ns", "user")));
      if (userR.code && GONE_CODES.has(userR.code)) continue;
      if (userR.code) return { kind: "incomplete", reason: `ns/user ${pid} ${userR.code}` };
      const commR = await settle(fsImpl.readFile(path.join(dir, "comm"), "utf8"));
      members.push({
        pid,
        start: st.start,
        ppid: st.ppid,
        user: userR.value,
        comm: commR.code ? "?" : commR.value.trim(),
      });
    }
    return { kind: "done", members };
  })();
  const r = await deadlineRace(work, deadline).catch((e) => ({ kind: "incomplete", reason: String(e && e.message) }));
  return r === TIMEOUT ? { kind: "incomplete", reason: "timeout" } : r;
}

/**
 * Termination right for ONE ns member of a record (security review N1 #2, §3.3 I-P4):
 * same boot ∧ mount ns == record ns.mnt (checked by the scan) ∧ user ns ∈ {ns.user, ns.innerUser}
 * ∧ start ≥ supervisor.start ∧ (a recorded identity — supervisor/gocryptfs/pi, pid+start — or a
 * descendant provable through a live ppid chain to one of them; gocryptfs' helpers such as its
 * syslog `logger` are its children). Anything else is `unverified`: reported, never signalled
 * (an ns id recycled to an unrelated namespace can only produce unverified members).
 * `chain(pid)` → {pid, start, ppid} | undefined reads the live process table.
 */
export function memberAuthorized(rec, m, { chain, bootId } = {}) {
  if (!rec?.ns || !rec.supervisor || rec.bootId !== bootId) return false;
  const users = [rec.ns.user, rec.ns.innerUser].filter(Boolean);
  if (!users.includes(m.user)) return false;
  if (m.start < rec.supervisor.start) return false;
  const anchors = ["supervisor", "gocryptfs", "pi"].map((k) => rec[k]).filter(Boolean);
  const isAnchor = (p) => anchors.some((a) => a.pid === p.pid && a.start === p.start);
  let cur = { pid: m.pid, start: m.start, ppid: m.ppid };
  for (let hops = 0; hops < 64 && cur; hops++) {
    if (isAnchor(cur)) return true;
    if (!Number.isSafeInteger(cur.ppid) || cur.ppid < 2) return false;
    const parent = chain(cur.ppid);
    if (!parent || parent.start > cur.start) return false; // a parent never starts after its child
    cur = parent;
  }
  return false;
}

/** Live ppid-chain reader for memberAuthorized (sync, small reads of /proc/<pid>/stat). */
export function procChainReader(procRoot = "/proc") {
  return (pid) => {
    try {
      const st = parseProcStat(fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8"));
      return st && st.state !== "Z" ? { pid, start: st.start, ppid: st.ppid } : undefined;
    } catch {
      return undefined;
    }
  };
}

/** Split scanned members into {verified, unverified} by memberAuthorized. */
export function classifyMembers(rec, members, { procRoot = "/proc", bootId = readBootIdSync(), chain } = {}) {
  const c = chain ?? procChainReader(procRoot);
  const verified = [];
  const unverified = [];
  for (const m of members) (memberAuthorized(rec, m, { chain: c, bootId }) ? verified : unverified).push(m);
  return { verified, unverified };
}

// ───────────────────────────── instance state (§3.3) ─────────────────────────────

/**
 * Pure verdict from gathered facts:
 *   facts = { record: {kind:"none"|"ok"|"corrupt"|"unknown", record?}, lease: "held"|"free"|"unknown",
 *             bootId, scan: {kind:"done", members}|{kind:"incomplete"}|undefined,
 *             alive: {owner, supervisor, gocryptfs, pi} (booleans) }
 * → {state, reason?}. States: none · unrecorded · unknown · corrupt · stale · starting · mounting ·
 *   launching · session · finalizing · orphan · orphan-ns · ns-in-use (members present, none provable).
 *   `verified` = how many scanned members pass memberAuthorized (default 0).
 */
export function judgePrivateInstance(f) {
  const rk = f.record?.kind;
  if (rk === "unknown") return { state: "unknown", reason: "record-unreadable" };
  if (rk === "corrupt") return { state: "corrupt", reason: f.record.reason };
  if (rk !== "ok") {
    if (f.lease === "free") return { state: "none" };
    if (f.lease === "held") return { state: "unrecorded" };
    return { state: "unknown", reason: "lease-unknown" };
  }
  const rec = f.record.record;
  if (!f.bootId || rec.bootId !== f.bootId) return { state: "stale", reason: "boot" };
  if (f.lease === "unknown") return { state: "unknown", reason: "lease-unknown" };
  const a = f.alive ?? {};
  if (rec.ns) {
    if (!f.scan || f.scan.kind !== "done") return { state: "unknown", reason: "scan-incomplete" };
    const members = f.scan.members.length;
    if (f.lease === "free" && members === 0) return { state: "stale", reason: "no-holders" };
    if (rec.phase === "starting" && a.owner) return { state: "starting" };
    if (rec.phase === "mounting" && a.supervisor) return { state: "mounting" };
    if ((rec.phase === "launching" || rec.phase === "setup") && a.supervisor) return { state: "launching" };
    // r3.1 (N4 F1): a session needs its supervisor; a pi outliving P1 is an orphan (outer cleanup)
    if (rec.phase === "session" && a.pi && a.supervisor) return { state: "session" };
    if (rec.phase === "finalizing" && a.supervisor) return { state: "finalizing" };
    if (!a.supervisor && a.gocryptfs) return { state: "orphan" };
    // Review N1 #2: members whose membership cannot be PROVEN (recycled ns id, broken ppid
    // chain) still block (fail closed) but are reported as ns-in-use (unverified), never killed.
    if (!a.gocryptfs && members > 0) return { state: (f.verified ?? 0) > 0 ? "orphan-ns" : "ns-in-use" };
    return { state: "unknown", reason: "unclassified" };
  }
  // No ns registered yet (P1 never got that far): lease + owner/supervisor liveness only.
  if (f.lease === "free" && !a.owner && !a.supervisor) return { state: "stale", reason: "never-started" };
  if (rec.phase === "starting" && a.owner) return { state: "starting" };
  if (a.supervisor) return { state: rec.phase === "starting" ? "starting" : "mounting" };
  return { state: "unknown", reason: "unclassified" };
}

/** Gather facts (all async, each ≤2 s) and judge. Never throws. */
export async function privateInstanceState(v, { procRoot = "/proc", deadline, record: given, readFile } = {}) {
  const idOpts = readFile ? { procRoot, readFile } : { procRoot }; // `readFile`: tests inject read faults
  const dl = () => deadline ?? Date.now() + PRIVATE_BUDGET.scanMs;
  const record = given ?? (await readPrivateRecord(v, { deadline: dl() }));
  const rec = record.kind === "ok" ? record.record : undefined;
  let leaseId = rec?.lease;
  if (!leaseId) {
    const li = leaseIdentitySync(v);
    leaseId = li.problem ? undefined : li;
  }
  const lease = await probeLease(leaseId, { procRoot, deadline: dl() });
  const bootId = readBootIdSync();
  let scan;
  const alive = {};
  let supervisorState;
  if (rec && rec.bootId === bootId) {
    for (const k of ["owner", "gocryptfs", "pi"]) alive[k] = rec[k] ? await identityAlive(rec[k], idOpts) : false;
    // review N4-r2 #1: the supervisor is three-state; "unknown" counts as alive (session, never
    // orphan/orphan-ns, nothing signalled) and makes lock refuse
    supervisorState = rec.supervisor ? await identityState(rec.supervisor, idOpts) : "dead";
    if (rec.ns) scan = await scanNsMembers(rec.ns.mnt, { procRoot, deadline: dl(), minStart: rec.supervisor?.start });
    // a later scan that SEES the recorded P1 alive overrides any earlier negative reading
    const sup = rec.supervisor;
    if (sup && scan?.kind === "done" && scan.members.some((m) => m.pid === sup.pid && m.start === sup.start))
      supervisorState = "alive";
    alive.supervisor = supervisorState !== "dead";
  }
  const classes = scan?.kind === "done" ? classifyMembers(rec, scan.members, { procRoot, bootId }) : undefined;
  const verdict = judgePrivateInstance({ record, lease, bootId, scan, alive, verified: classes?.verified.length });
  return { ...verdict, record: rec, recordKind: record.kind, lease, scan, alive, classes, supervisorState };
}

export function describePrivateState(name, s, v) {
  const pi = s.record?.pi ? `pi pid ${s.record.pi.pid}` : undefined;
  switch (s.state) {
    case "starting":
    case "mounting":
      return `保险库 ${name} 有一个 --private 实例正在挂载（${s.state}）`;
    case "launching":
    case "session":
    case "finalizing":
      return `保险库 ${name} 有一个 --private 实例正在运行（${s.state}${pi ? `，${pi}` : ""}）`;
    case "orphan":
    case "orphan-ns":
      return `保险库 ${name} 有一个失去监督者的 --private 实例（${s.state}）：pi-secure lock ${name} 清理`;
    case "ns-in-use":
      return `保险库 ${name} 的 --private 记录所指的命名空间仍有进程（无法证明属于该实例，可能是 ns id 被复用）——不会自动终止；pi-secure status ${name} 查看后人工核对`;
    case "unrecorded":
      return `保险库 ${name} 的挂载租约被一个未登记的进程持有（可能仍有 gocryptfs 在运行）——无法证明归属，不会自动终止；pi-secure status ${name} 查看`;
    case "corrupt":
      return `保险库 ${name} 的 private.json 无法解析（${s.reason}）——拒绝操作（fail closed），请人工核对 ${privateRecordPath(v ?? { dir: "<dir>" })}`;
    case "stale":
      return `保险库 ${name} 有一条失效的 --private 记录`;
    default:
      return `无法确认保险库 ${name} 的 --private 实例状态（${s.reason ?? s.state}）——拒绝操作`;
  }
}

// ───────────────────────────── command surface (N2: §1.2, §3.7, §3.8) ─────────────────────────────

/** The caller's own mount ns IS the record's private ns (§1.2: lock/unlock/run from inside refuse). */
export function callerInPrivateNs(rec, selfMnt = readNsLinkSync("self", "mnt")) {
  return Boolean(rec?.ns?.mnt && selfMnt && selfMnt === rec.ns.mnt);
}

/** FLOCK holders of the lease from /proc/locks — REPORT ONLY, never a termination right (§3.3). */
export async function leaseHolders(lease, { procRoot = "/proc", deadline = Date.now() + PRIVATE_BUDGET.scanMs } = {}) {
  if (!lease) return [];
  const t = await deadlineRace(fsp.readFile(path.join(procRoot, "locks"), "utf8"), deadline).catch(() => TIMEOUT);
  if (typeof t !== "string") return [];
  const [maj, min] = String(lease.dev).split(":").map(Number);
  const seen = new Set();
  const holders = [];
  for (const e of parseProcLocks(t)) {
    if (e.blocked || e.type !== "FLOCK" || e.maj !== maj || e.min !== min || e.ino !== lease.ino) continue;
    if (seen.has(e.pid) || holders.length >= 16) continue;
    seen.add(e.pid);
    const comm = readTextOr(path.join(procRoot, String(e.pid), "comm"), "").trim();
    holders.push({ pid: e.pid, ...(comm ? { comm } : {}) });
  }
  return holders;
}

/**
 * The view every plain entry point (lock / status / __mount) starts from. `state:"none"` ⇔ no
 * record AND (no vault dir / no lease file — legacy or incomplete layouts never ran the lease
 * chain —, lease free, or a GLOBAL mount is present: an ordinary gocryptfs holds the lease too,
 * §3.1/§1.2 row 1). Otherwise privateInstanceState (+ `inNs`), or `unrecorded`/`unknown` with the
 * /proc/locks holders. `globalSt` = this caller's probeMountState(v). Never throws.
 */
export async function vaultInstanceView(v, globalSt, { procRoot = "/proc", selfMnt } = {}) {
  const none = (lease) => ({ state: "none", recordKind: "none", lease });
  const dirSt = lstatOrNull(v.dir);
  if (!dirSt || !dirSt.isDirectory() || !v.lease) return none("n/a");
  const record = await readPrivateRecord(v, { deadline: Date.now() + PRIVATE_BUDGET.scanMs });
  if (record.kind === "none") {
    const li = leaseIdentitySync(v);
    if (li.problem) return none("n/a");
    const lease = await probeLease(li, { procRoot });
    if (lease === "free" || globalSt !== "absent") return none(lease);
    const holders = await leaseHolders(li, { procRoot });
    return lease === "held"
      ? { state: "unrecorded", recordKind: "none", lease, holders }
      : { state: "unknown", reason: "lease-unknown", recordKind: "none", lease, holders };
  }
  const s = await privateInstanceState(v, { procRoot, record });
  return { ...s, inNs: callerInPrivateNs(s.record, selfMnt ?? readNsLinkSync("self", "mnt")) };
}

const STATUS_TOKENS = Object.freeze({
  session: "private",
  starting: "private:starting",
  mounting: "private:starting",
  launching: "private:launching",
  finalizing: "private:finalizing",
  orphan: "private:orphan",
  "orphan-ns": "private:orphan-ns",
  stale: "private:stale-record",
  "ns-in-use": "private:ns-in-use",
  unrecorded: "lease:unrecorded",
  corrupt: "private:corrupt-record",
  unknown: "private:unknown",
});
const PHASE_TOKENS = Object.freeze({
  starting: "private:starting",
  mounting: "private:starting",
  launching: "private:launching",
  setup: "private:launching",
  session: "private",
  finalizing: "private:finalizing",
});

/** §3.8 vault-line token. Inside the ns the scan cannot complete — being there proves liveness. */
export function privateStatusToken(view) {
  if (view.inNs && view.record) return PHASE_TOKENS[view.record.phase] ?? "private";
  return STATUS_TOKENS[view.state] ?? "private:unknown";
}

/** "2026-10-23 19:30" (local time); unparsable ⇒ the raw string. */
export function shortTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * §3.8 status block for a vault whose view is NOT `none` (pure). `st` = the caller's global
 * probeMountState, `layout`/`problems` as describeVault computed them.
 */
export function renderPrivateStatus(v, { st, layout, problems = [], view }) {
  const L = [];
  const name = v.name;
  L.push(`${name}: ${privateStatusToken(view)}  layout ${layout}  mnt ${v.mnt}`);
  L.push(`  dir ${v.dir}`);
  for (const p of problems) L.push(`  ! ${p}`);
  const rec = view.record;
  if (rec) {
    const parts = [rec.phase];
    for (const k of ["pi", "supervisor", "gocryptfs"]) if (rec[k]) parts.push(`${k} ${rec[k].pid}`);
    if (rec.ns) parts.push(`ns ${rec.ns.mnt}`);
    parts.push(`since ${shortTime(rec.createdAt)}`);
    parts.push(`id ${rec.instanceId.slice(0, 4)}…`);
    if (rec.mode === "setup") parts.push("mode setup");
    if (rec.lazyDetachedAt) parts.push(`lazy-detached ${shortTime(rec.lazyDetachedAt)}`);
    L.push(`  private: ${parts.join(" · ")}`);
  } else if (view.recordKind === "corrupt") L.push(`  private.json: corrupt (${view.reason})  ${privateRecordPath(v)}`);
  else if (view.recordKind === "unknown") L.push(`  private.json: n/a (unreadable within deadline)`);
  L.push(`  lease: ${view.state === "unrecorded" ? "held (unrecorded)" : view.lease}`);
  for (const h of view.holders ?? []) L.push(`    holder pid ${h.pid} ${h.comm ?? "(exited/unreadable)"}`);
  const outside = view.inNs
    ? "n/a (seen from inside the private namespace)"
    : st === "mounted"
      ? "! global mount also present (conflict)"
      : st === "absent"
        ? `not mounted · ${layout === "ok" ? "sentinels ok" : "! layout/sentinel problems (see above)"}`
        : `! global ${st}`;
  L.push(`  outside view: ${outside}`);
  if (rec?.ns) {
    if (view.scan?.kind === "done") {
      const unv = view.classes?.unverified ?? [];
      L.push(
        `  ns members: ${view.scan.members.length}${unv.length ? ` (unverified ${unv.length}: ${unv.map((m) => `pid ${m.pid} ${m.comm}`).join(", ")})` : ""}`,
      );
    } else L.push("  ns members: n/a (incomplete)");
  }
  if (view.inNs) L.push("  (this process is inside the private namespace)");
  switch (view.inNs ? "in-ns" : view.state) {
    case "orphan":
    case "orphan-ns":
      L.push(`  ! 监督进程已不在：pi-secure lock ${name} 终止有证明归属的进程并清理记录`);
      break;
    case "stale":
      L.push(`  ! 失效记录：pi-secure lock ${name} 清理（下一次 run/unlock 也会自动清理）`);
      break;
    case "unrecorded":
    case "ns-in-use":
      L.push(`  ! 无法证明归属，不会自动终止；确认后可手工 kill，或重启。期间一切挂载入口拒绝`);
      break;
    case "corrupt":
    case "unknown":
      L.push(
        `  ! 状态无法确认（${view.reason ?? view.state}）：一切挂载入口拒绝（fail closed）；人工核对 ${privateRecordPath(v)}`,
      );
      break;
    default:
      break;
  }
  if (rec) L.push(`  boundary: ${PRIVATE_BOUNDARY_SHORT}`);
  return L;
}

export const LAZY_DETACHED_TEXT =
  "已在私有命名空间内摘除挂载路径。既有 cwd、已打开的文件和运行中的作业可能继续访问明文；插件会在下一次输入/工具调用时拒绝（LOCKED）。要真正结束访问请用 --kill";

/**
 * §3.7 lock table (pure). → {action:"plain"|"refuse"|"kill"|"lazy"|"wait"|"outer"|"release",
 * code?, text?, note?, degrade?}. `plain` = the original (pre-N2) lock path, byte-identical.
 */
export function lockPrivateDecision(v, view, { lazy = false, kill = false } = {}) {
  const name = v.name;
  if (view.state === "none")
    return { action: "plain", ...(kill ? { note: "--kill 只用于 --private 实例；按普通 lock 处理" } : {}) };
  if (view.inNs)
    return { action: "refuse", code: EXIT.BUSY, text: `${name}：不能在私有会话内部收尾自己；退出 pi 即自动收尾` };
  if (view.supervisorState === "unknown")
    return {
      action: "refuse",
      code: EXIT.BUSY,
      text: `${name}：无法确认监督进程状态（pid ${view.record?.supervisor?.pid}，/proc 读取失败）——未执行任何操作；稍后重试，或 pi-secure status ${name}`,
    };
  const pi = view.record?.pi ? `pi pid ${view.record.pi.pid}` : "启动中";
  const running = `${name}：会话仍在运行（${pi}）：退出 pi 后自动收尾；--lazy 摘除该命名空间里的挂载路径；--kill 结束会话并收尾`;
  switch (view.state) {
    case "starting":
    case "mounting":
      return { action: "refuse", code: EXIT.LOCK_BUSY, text: `另一个 pi-secure 正在挂载 ${name}` };
    case "launching":
      if (kill) return { action: "kill" };
      return lazy
        ? { action: "refuse", code: EXIT.BUSY, text: `${name}：会话尚未启动完成，稍后再试` }
        : { action: "refuse", code: EXIT.BUSY, text: running };
    case "session":
      if (kill) return { action: "kill" };
      return lazy ? { action: "lazy" } : { action: "refuse", code: EXIT.BUSY, text: running };
    case "finalizing":
      return { action: "wait" };
    case "orphan":
    case "orphan-ns":
      return { action: "outer", degrade: lazy };
    case "stale":
      return { action: "release" };
    default:
      return {
        action: "refuse",
        code: EXIT.BUSY,
        text: `${describePrivateState(name, view, v)}。确认后可手工 kill，或重启`,
      };
  }
}

// ───────────────────────────── bounded children ─────────────────────────────

/**
 * Spawn one child in its own process group, bounded by `deadline`: TERM the group, +killGraceMs
 * KILL, +abandonMs give up (unref, never awaited). stdio defaults to NO_LEASE_STDIO.
 * Once the deadline fired the result is ALWAYS {kind:"timeout"} (even when the TERM/KILL made the
 * child close promptly — callers map it to 75), with the observed code/signal attached.
 * → {kind:"exit", code, signal, stdout, stderr} | {kind:"timeout", code?, signal?, stdout, stderr} | {kind:"error", message}
 */
export function runBounded(
  cmd,
  args,
  {
    deadline,
    stdio = NO_LEASE_STDIO,
    env = process.env,
    cwd = "/",
    killGraceMs = PRIVATE_BUDGET.workerKillGraceMs,
    abandonMs = PRIVATE_BUDGET.workerAbandonMs,
    spawnImpl = spawn,
  } = {},
) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(cmd, args, { detached: true, stdio: [...stdio], env, cwd });
    } catch (e) {
      resolve({ kind: "error", message: String(e && e.message) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b) => {
      if (stdout.length < 65536) stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b) => {
      if (stderr.length < 16384) stderr += b.toString("utf8");
    });
    let done = false;
    let timedOut = false; // review N1 #6: once the deadline fired the result is a timeout, whatever follows
    const timers = [];
    const finish = (r) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      resolve(r);
    };
    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        /* gone */
      }
    };
    const t1 = setTimeout(
      () => {
        timedOut = true;
        killGroup("SIGTERM");
        const t2 = setTimeout(() => {
          killGroup("SIGKILL");
          const t3 = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref();
            finish({ kind: "timeout", stdout, stderr });
          }, abandonMs);
          t3.unref();
          timers.push(t3);
        }, killGraceMs);
        t2.unref();
        timers.push(t2);
      },
      Math.max(0, deadline - Date.now()),
    );
    t1.unref();
    timers.push(t1);
    child.on("error", (e) => finish({ kind: "error", message: String(e && e.message) }));
    child.on("close", (code, signal) =>
      finish(
        timedOut
          ? { kind: "timeout", code: code ?? undefined, signal, stdout, stderr }
          : { kind: "exit", code: code ?? 128, signal, stdout, stderr },
      ),
    );
  });
}

const selfPath = () => fileURLToPath(import.meta.url);

/** Last JSON line of a child's stdout (workers / record commands report this way). */
export function lastJsonLine(text) {
  const lines = (text ?? "").split("\n").filter((l) => l.trim().startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

// ───────────────────────────── spawn specs (pinned by unit tests, I-P9) ─────────────────────────────

/** §2.2-6 / §3.1: the shell lease chain. `tail` = argv exec'd after the lease is locked. */
export function leaseChainArgs(lease, tail) {
  return ["-c", `exec 9<>"$1" && flock -n 9 || exit ${LEASE_BUSY_CODE}; shift; exec "$@"`, "sh", lease, ...tail];
}

export function nsRootTail(nodeBin = process.execPath, helper = selfPath()) {
  return [
    "unshare",
    "--user",
    "--map-root-user",
    "--mount",
    "--propagation",
    "private",
    "--",
    nodeBin,
    helper,
    "__ns-root",
  ];
}

/** gocryptfs -fg as a direct child of P1: setsid (detached) + slot 9. */
export function gocryptfsSpawnSpec(realCipher, realMnt, notifyPid) {
  return {
    cmd: "gocryptfs",
    args: ["-fg", `-notifypid=${notifyPid}`, "-nonempty", "--", realCipher, realMnt],
    opts: { detached: true, stdio: [...LEASE_STDIO], cwd: "/" },
  };
}

/** Inner userns back to the real uid/gid, then pi; slot 9 (pi holds the lease, its children do not). */
export function innerPiSpawnSpec({ uid, gid, piBin, sessionDir, piArgs, cwd, env }) {
  return {
    cmd: "unshare",
    args: ["--user", `--map-user=${uid}`, `--map-group=${gid}`, "--", piBin, "--session-dir", sessionDir, ...piArgs],
    opts: { detached: false, stdio: [...LEASE_STDIO], cwd, env },
  };
}

/** `__mount-work` worker: own process group, no slot 9. */
export function workerSpawnSpec(spec, env = process.env) {
  return {
    cmd: process.execPath,
    args: [selfPath(), "__mount-work"],
    opts: {
      detached: true,
      stdio: [...NO_LEASE_STDIO],
      cwd: "/",
      env: { ...env, PI_SECURE_WORK_SPEC: JSON.stringify(spec) },
    },
  };
}

// ───────────────────────────── preflight (§2.7) ─────────────────────────────

/**
 * `deps` (tests): {run(cmd,args,deadline) → runBounded-like result, read(p) → string|undefined,
 * which(b) → path|undefined, mkdtemp() → dir, rmdir(dir)}.
 */
export async function privatePreflight(deps = {}) {
  const deadline = Date.now() + PRIVATE_BUDGET.preflightMs;
  const run =
    deps.run ?? ((cmd, args, dl) => runBounded(cmd, args, { deadline: dl, killGraceMs: 200, abandonMs: 200 }));
  const read = deps.read ?? ((p) => readTextOr(p, undefined));
  const which = deps.which ?? ((b) => findOnPath(b));
  const problems = [];
  if (!which("unshare")) problems.push("缺少 unshare（util-linux）");
  if (!which("umount")) problems.push("缺少 umount（util-linux）");
  if (problems.length) return { ok: false, problems };
  const help = await run("unshare", ["--help"], Math.min(deadline, Date.now() + 1_000));
  if (help.kind !== "exit") return { ok: false, problems: [`unshare --help 未能完成（${help.kind}）`] };
  const text = `${help.stdout}${help.stderr}`;
  for (const f of ["--map-root-user", "--map-user", "--map-group", "--propagation"])
    if (!text.includes(f)) problems.push(`unshare 不支持 ${f}（util-linux 过旧）`);
  const clone = read("/proc/sys/kernel/unprivileged_userns_clone");
  if (clone !== undefined && clone.trim() !== "1")
    problems.push("kernel.unprivileged_userns_clone=0：非特权 user namespace 被禁用");
  const maxNs = read("/proc/sys/user/max_user_namespaces");
  if (maxNs !== undefined && !(Number(maxNs.trim()) > 0)) problems.push("user.max_user_namespaces=0");
  const aa = read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns");
  if (aa !== undefined && aa.trim() === "1")
    problems.push(
      "kernel.apparmor_restrict_unprivileged_userns=1：AppArmor 限制非特权 user namespace（保守拒绝，不检测 profile 例外）",
    );
  if (problems.length) return { ok: false, problems };
  let dir;
  try {
    dir = deps.mkdtemp ? deps.mkdtemp() : fs.mkdtempSync(path.join(os.tmpdir(), "pi-secure-probe-"));
    if (!deps.mkdtemp) fs.chmodSync(dir, 0o700);
    const r = await run(
      "unshare",
      [
        "--user",
        "--map-root-user",
        "--mount",
        "--propagation",
        "private",
        "--",
        "mount",
        "-t",
        "tmpfs",
        "-o",
        "size=4k",
        "pi-secure-probe",
        dir,
      ],
      deadline,
    );
    if (r.kind === "timeout") problems.push("私有命名空间实测超时（3 s）");
    else if (r.kind !== "exit" || r.code !== 0)
      problems.push(
        `私有命名空间实测失败：${(r.stderr ?? r.message ?? "").split("\n").find((l) => l.trim()) ?? `exit ${r.code}`}`,
      );
  } catch (e) {
    problems.push(`私有命名空间实测失败：${e && e.message}`);
  } finally {
    if (dir) (deps.rmdir ?? ((d) => fs.rmSync(d, { recursive: true, force: true })))(dir);
  }
  return { ok: problems.length === 0, problems };
}

// ───────────────────────────── record subcommands (run under flock) ─────────────────────────────

/** `__private-update <name> <instanceId> <patchJson>` — UNDER mount.lock. Prints {ok,record?}. */
function cmdPrivateUpdate(name, instanceId, patchJson) {
  const { vault: v } = must(resolveVault(name));
  const cur = readPrivateRecordSync(v);
  if (cur.kind === "none") return REC.NONE;
  if (cur.kind !== "ok") return REC.CORRUPT;
  let patch;
  try {
    patch = JSON.parse(patchJson);
  } catch {
    return EXIT.FAIL;
  }
  const r = applyRecordPatch(cur.record, instanceId, patch);
  if (r.error === "mismatch") return REC.MISMATCH;
  if (r.error) {
    err(`记录更新被拒：${r.error}`);
    return EXIT.FAIL;
  }
  replacePrivateRecord(v, r.record);
  out(JSON.stringify({ ok: true }));
  return REC.OK;
}

/**
 * `__private-release <name> <instanceId>` — the ONLY record deleter (I-P3). Runs while the caller's
 * flock holds mount.lease (proving every fd-9 holder exited) AND mount.lock; outside the ns.
 * Deletes iff instanceId matches ∧ (bootId differs ∨ the recorded ns has no member — complete scan).
 */
async function cmdPrivateRelease(name, instanceId) {
  const { vault: v } = must(resolveVault(name));
  const cur = readPrivateRecordSync(v);
  if (cur.kind === "none") return REC.NONE;
  if (cur.kind !== "ok") return REC.CORRUPT;
  const rec = cur.record;
  if (rec.instanceId !== instanceId) return REC.MISMATCH;
  if (rec.ns && rec.bootId === readBootIdSync()) {
    const s = await scanNsMembers(rec.ns.mnt, {
      deadline: Date.now() + PRIVATE_BUDGET.scanMs,
      minStart: rec.supervisor?.start,
    });
    if (s.kind !== "done") {
      out(JSON.stringify({ ok: false, incomplete: s.reason }));
      return REC.INCOMPLETE;
    }
    if (s.members.length) {
      out(JSON.stringify({ ok: false, members: s.members.slice(0, 16) }));
      return REC.MEMBERS;
    }
  }
  deletePrivateRecordSync(v);
  out(JSON.stringify({ ok: true }));
  return REC.OK;
}

/** §3.2 unique exception: the BUSY shell chain never built an ns ⇒ P0 drops its own `starting` record. */
function cmdPrivateAbortStart(name, instanceId) {
  const { vault: v } = must(resolveVault(name));
  const cur = readPrivateRecordSync(v);
  if (cur.kind === "none") return REC.NONE;
  if (cur.kind !== "ok") return REC.CORRUPT;
  const rec = cur.record;
  if (rec.instanceId !== instanceId) return REC.MISMATCH;
  if (rec.phase !== "starting" || rec.ns || rec.supervisor) return REC.MEMBERS;
  deletePrivateRecordSync(v);
  return REC.OK;
}

/**
 * `__private-terminate <name> <instanceId> <budgetMs>` — UNDER mount.lock (instanceId re-checked
 * inside the lock, I-P4). Signals ONLY recorded identities and ns members whose ns id and
 * starttime (≥ supervisor.start) are re-verified right before each signal. Non-gocryptfs members
 * first (TERM → ≤2 s → KILL), then gocryptfs (TERM → ≤2 s → KILL). Never calls fusermount (I-P7).
 */
async function cmdPrivateTerminate(name, instanceId, budgetMs) {
  const { vault: v } = must(resolveVault(name));
  const cur = readPrivateRecordSync(v);
  if (cur.kind === "none") return REC.NONE;
  if (cur.kind !== "ok") return REC.CORRUPT;
  const rec = cur.record;
  if (rec.instanceId !== instanceId) return REC.MISMATCH;
  if (rec.bootId !== readBootIdSync()) {
    out(JSON.stringify({ ok: true, killed: [], remaining: [] }));
    return REC.OK;
  }
  // review N4-r2 #1: outer cleanup presupposes a DEAD supervisor — re-proved here, under mount.lock
  if (rec.supervisor) {
    const ss = await identityState(rec.supervisor);
    if (ss !== "dead") {
      out(JSON.stringify({ ok: false, killed: [], remaining: [], supervisor: ss }));
      return REC.SUPERVISOR;
    }
  }
  const r = await terminateInstance(rec, { deadline: Date.now() + Math.max(500, Number(budgetMs) || 0) });
  out(JSON.stringify(r));
  return r.ok ? REC.OK : REC.MEMBERS;
}

/** Signal one process iff it still is `who` (pid+start, and mnt ns / user ns ∈ userNs when given). */
export function signalVerified(
  who,
  sig,
  { nsMnt, userNs, procRoot = "/proc", kill = process.kill.bind(process) } = {},
) {
  if (readProcStartSync(who.pid, procRoot) !== who.start) return false;
  if (nsMnt !== undefined && readNsLinkSync(who.pid, "mnt", procRoot) !== nsMnt) return false;
  if (userNs !== undefined && !userNs.includes(readNsLinkSync(who.pid, "user", procRoot))) return false;
  try {
    kill(who.pid, sig);
    return true;
  } catch {
    return false;
  }
}

/** The termination set of a record (I-P4). Shared by `__private-terminate`; `deps` for tests. */
export async function terminateInstance(
  rec,
  { deadline, procRoot = "/proc", kill, sleepMs = sleep, bootId = readBootIdSync(), chain, uid, fsImpl } = {},
) {
  const nsMnt = rec.ns?.mnt;
  const minStart = rec.supervisor?.start;
  const gocry = rec.gocryptfs;
  const killed = [];
  let unverifiedSeen = [];
  if (rec.bootId !== bootId) return { ok: true, killed, remaining: [], unverified: [] };
  if (!nsMnt) {
    // no registered ns ⇒ no target can pass the member authorization: report live identities only
    const unv = [];
    for (const k of ["pi", "supervisor", "gocryptfs"])
      if (rec[k] && (await identityState(rec[k], { procRoot })) !== "dead")
        unv.push({ pid: rec[k].pid, comm: `${k}（记录无命名空间，无法证明）` });
    return { ok: unv.length === 0, killed, remaining: [], unverified: unv };
  }
  const collect = async () => {
    const set = new Map();
    if (nsMnt) {
      const s = await scanNsMembers(nsMnt, {
        procRoot,
        deadline: Math.min(deadline, Date.now() + PRIVATE_BUDGET.scanMs),
        minStart,
        ...(uid !== undefined ? { uid } : {}),
        ...(fsImpl ? { fsImpl } : {}),
      });
      if (s.kind !== "done") return { incomplete: s.reason, set };
      // Review N1 #2: only PROVEN members (memberAuthorized) enter the termination set.
      const { verified, unverified } = classifyMembers(rec, s.members, { procRoot, bootId, chain });
      for (const m of verified) set.set(m.pid, { pid: m.pid, start: m.start, ppid: m.ppid, comm: m.comm, ns: true });
      unverifiedSeen = unverified.map((m) => ({ pid: m.pid, comm: m.comm }));
    }
    // Review N4-r2 #2: no backfill. A recorded identity (pi / supervisor / gocryptfs) that is alive
    // but did NOT pass the full member authorization above (outside the recorded mnt ns, foreign
    // user ns, …) is reported, never signalled; the caller keeps the record (non-zero exit).
    for (const k of ["pi", "supervisor", "gocryptfs"]) {
      const id = rec[k];
      if (id && !set.has(id.pid) && (await identityState(id, { procRoot })) !== "dead")
        if (!unverifiedSeen.some((u) => u.pid === id.pid))
          unverifiedSeen.push({ pid: id.pid, comm: `${k}（记录身份未通过命名空间/成员校验）` });
    }
    return { set };
  };
  const isGocry = (m) => gocry && m.pid === gocry.pid && m.start === gocry.start;
  const userNs = [rec.ns?.user, rec.ns?.innerUser].filter(Boolean);
  // every target came from the ns scan + memberAuthorized; re-verify pid+start, mnt ns and user ns
  const sig = (m, s) => signalVerified(m, s, { nsMnt, userNs, procRoot, kill });
  const waitGone = async (ms, pred) => {
    const end = Math.min(deadline, Date.now() + ms);
    while (Date.now() < end) {
      if (await pred()) return true;
      await sleepMs(100);
    }
    return pred();
  };
  for (const phase of ["members", "gocryptfs"]) {
    let c = await collect();
    if (c.incomplete) return { ok: false, incomplete: c.incomplete, killed, remaining: [] };
    const gocryKid = (m) => gocry && m.ppid === gocry.pid;
    let targets = [...c.set.values()].filter((m) =>
      phase === "members" ? !isGocry(m) && !gocryKid(m) : isGocry(m) || gocryKid(m),
    );
    if (!targets.length) continue;
    for (const m of targets) if (sig(m, "SIGTERM")) killed.push({ pid: m.pid, comm: m.comm, sig: "TERM" });
    const gone = async () => {
      for (const m of targets) if (readProcStartSync(m.pid, procRoot) === m.start) return false;
      return true;
    };
    if (!(await waitGone(2_000, gone))) {
      for (const m of targets) if (sig(m, "SIGKILL")) killed.push({ pid: m.pid, comm: m.comm, sig: "KILL" });
      await waitGone(500, gone);
    }
  }
  const final = await collect();
  if (final.incomplete) return { ok: false, incomplete: final.incomplete, killed, remaining: [] };
  const remaining = [...final.set.values()].map((m) => ({ pid: m.pid, comm: m.comm }));
  return { ok: remaining.length === 0 && unverifiedSeen.length === 0, killed, remaining, unverified: unverifiedSeen };
}

/**
 * `__private-claim <name> <instanceId> <ownerPid> <ownerStart> <mode>` — UNDER mount.lock (§2.2-4).
 * Any doubt refuses. Writes the `starting` record with O_EXCL semantics.
 */
async function cmdPrivateClaim(name, instanceId, ownerPid, ownerStart, mode = "run") {
  const { vault: v, enabled } = must(resolveVault(name));
  requireNewLayout(v);
  void enabled;
  if (!HEX32_RE.test(instanceId ?? "")) throw new CliError(EXIT.FAIL, "内部错误：instanceId 不合法");
  // 1. global mountinfo for THIS vault
  const st = await probeMountState(v);
  if (st === "mounted")
    throw new CliError(
      EXIT.BUSY,
      `${name} 已普通挂载（对所有同用户进程可见）。先 pi-secure lock ${name}，再 run --private；或去掉 --private`,
    );
  if (st === "foreign") throw new CliError(EXIT.FAIL, `${v.mnt} 上挂着别的文件系统（mountinfo 不符），拒绝挂载`);
  if (st === "hung") throw new CliError(EXIT.DEADLINE, `${v.mnt} 的挂载探测超时（FUSE 卡住？），拒绝操作`);
  // 2. Q10: another registered vault mounted globally would be copied into the new ns
  const { cfg } = loadSecureConfig(homeDir());
  for (const o of cfg.valid ? cfg.vaults : []) {
    if (o.name === v.name) continue;
    const ost = await probeMountState(o);
    if (ost === "mounted" || ost === "stale")
      throw new CliError(
        EXIT.BUSY,
        `保险库 ${o.name} 正全局挂载：私有命名空间会复制这个挂载，且无法在其中单独拆除，导致 ${o.name} 之后无法干净卸载。先 pi-secure lock ${o.name}`,
      );
    if (ost === "hung")
      throw new CliError(EXIT.DEADLINE, `保险库 ${o.name} 的挂载探测超时，无法确认它是否全局挂载——拒绝 run --private`);
  }
  // 3. existing record ⇒ judge; only `stale` may be released (non-blocking lease: we hold mount.lock)
  const li = leaseIdentitySync(v);
  if (li.problem) throw new CliError(EXIT.CONFIG, `布局校验失败，拒绝挂载：\n  - ${li.problem}`);
  const recNow = readPrivateRecordSync(v);
  if (recNow.kind !== "none") {
    const s = await privateInstanceState(v, { record: recNow });
    if (s.state !== "stale") throw new CliError(EXIT.BUSY, describePrivateState(name, s, v));
    const rel = releaseRecordHoldingMountLock(v, recNow.record.instanceId);
    if (rel.kind !== "released")
      throw new CliError(EXIT.BUSY, `${describePrivateState(name, s, v)}，但无法清理（${rel.kind}）——拒绝`);
    err(`${name}：清理了失效的 --private 记录`);
  }
  // 4. lease (read-only probe)
  const lease = await probeLease(li);
  if (lease === "held") throw new CliError(EXIT.BUSY, describePrivateState(name, { state: "unrecorded" }, v));
  if (lease !== "free") throw new CliError(EXIT.DEADLINE, `无法读取 /proc/locks 判断 ${name} 的挂载租约——拒绝`);
  // 5. stale global mount: lease is free ⇒ no gocryptfs holds it ⇒ safe to clean
  if (st === "stale") {
    err(`${name}：发现失效挂载（守护进程已不在），先清理`);
    spawnSync("fusermount3", ["-u", v.mnt], { stdio: "ignore", timeout: 5_000 });
    if ((await probeMountState(v)) !== "absent")
      throw new CliError(EXIT.FAIL, `无法清理失效挂载 ${v.mnt}：fusermount3 -uz ${v.mnt}`);
  }
  // 6. layout + sentinels (outside view must be pristine)
  const lay = checkLayout(v, { mounted: false, others: otherRegisteredVaults(v) });
  if (lay.problems.length)
    throw new CliError(EXIT.CONFIG, `布局校验失败，拒绝挂载：\n  - ${lay.problems.join("\n  - ")}`);
  const bootId = readBootIdSync();
  if (!bootId) throw new CliError(EXIT.PREREQ, "无法读取 /proc/sys/kernel/random/boot_id");
  const { realMnt, realCipher } = physicalPaths(v);
  const rec = {
    v: 3,
    instanceId,
    name,
    phase: "starting",
    mode: mode === "setup" ? "setup" : "run",
    bootId,
    createdAt: new Date().toISOString(),
    realCipher,
    realMnt,
    lease: { dev: li.dev, ino: li.ino },
    owner: { pid: Number(ownerPid), start: Number(ownerStart) },
  };
  if (parsePrivateRecord(JSON.stringify(rec)).kind !== "ok") throw new CliError(EXIT.FAIL, "内部错误：记录不合法");
  try {
    writePrivateRecordExclusive(v, rec);
  } catch (e) {
    if (e && e.code === "EEXIST") throw new CliError(EXIT.BUSY, `${name}：另一个 --private 实例抢先认领`);
    throw new CliError(EXIT.FAIL, `无法写入 ${privateRecordPath(v)}：${e && e.message}`);
  }
  return EXIT.OK;
}

// ───────────────────────────── release protocol (§3.2) ─────────────────────────────

function releaseResult(r) {
  if (r.kind === "timeout") return { kind: "timeout" };
  if (r.kind === "error") return { kind: "error", message: r.message };
  const info = lastJsonLine(r.stdout) ?? {};
  switch (r.code) {
    case REC.OK:
      return { kind: "released" };
    case LEASE_BUSY_CODE:
      return { kind: "lease-busy" };
    case FLOCK_TIMEOUT_CODE:
      return { kind: "lock-busy" };
    case REC.MEMBERS:
      return { kind: "members", members: info.members ?? [] };
    case REC.INCOMPLETE:
      return { kind: "incomplete", reason: info.incomplete };
    case REC.MISMATCH:
      return { kind: "mismatch" };
    case REC.NONE:
      return { kind: "none" };
    case REC.CORRUPT:
      return { kind: "corrupt" };
    default:
      return { kind: "error", message: (r.stderr || "").trim() || `exit ${r.code}` };
  }
}

/**
 * `releaseRecord` (outside the ns: P0 / lock): lease FIRST (blocking up to waitMs — proves every
 * fd-9 holder exited), then mount.lock (≤2 s), then `__private-release`. Lock order §3.1.
 * → {kind:"released"|"lease-busy"|"lock-busy"|"members"|"incomplete"|"mismatch"|"none"|"corrupt"|"timeout"|"error"}
 */
export async function releaseRecord(v, instanceId, { waitMs = PRIVATE_BUDGET.releaseLeaseWaitS * 1000 } = {}) {
  const waitS = Math.max(0.1, Math.floor(waitMs / 100) / 10);
  const lockS = PRIVATE_BUDGET.releaseMountLockWaitS;
  const r = await runBounded(
    "flock",
    [
      "-o",
      "-E",
      String(LEASE_BUSY_CODE),
      "-w",
      waitS.toFixed(1),
      v.lease,
      "flock",
      "-o",
      "-E",
      String(FLOCK_TIMEOUT_CODE),
      "-w",
      String(lockS),
      v.lock,
      process.execPath,
      selfPath(),
      "__private-release",
      v.name,
      instanceId,
    ],
    { deadline: Date.now() + waitS * 1000 + lockS * 1000 + PRIVATE_BUDGET.scanMs + 1_500 },
  );
  return releaseResult(r);
}

/** Claim path variant: mount.lock is already held ⇒ the lease may only be TRIED (`flock -n`). */
export function releaseRecordHoldingMountLock(v, instanceId) {
  const r = spawnSync(
    "flock",
    [
      "-o",
      "-n",
      "-E",
      String(LEASE_BUSY_CODE),
      v.lease,
      process.execPath,
      selfPath(),
      "__private-release",
      v.name,
      instanceId,
    ],
    { encoding: "utf8", timeout: PRIVATE_BUDGET.scanMs + 1_500, stdio: [...NO_LEASE_STDIO], cwd: "/" },
  );
  if (r.error) return { kind: r.error.code === "ETIMEDOUT" ? "timeout" : "error", message: r.error.message };
  return releaseResult({ kind: "exit", code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr });
}

/** Run a record command under `flock -w <s> mount.lock` (bounded). */
function underMountLock(v, sub, args, { waitS = PRIVATE_BUDGET.recordLockWaitS, workMs = 1_500 } = {}) {
  return runBounded(
    "flock",
    [
      "-o",
      "-E",
      String(FLOCK_TIMEOUT_CODE),
      "-w",
      String(waitS),
      v.lock,
      process.execPath,
      selfPath(),
      sub,
      v.name,
      ...args,
    ],
    { deadline: Date.now() + waitS * 1000 + workMs, killGraceMs: 300, abandonMs: 300 },
  );
}

/** P1's record transition (CAS on instanceId). → "ok" | "mismatch" | "failed" */
export async function updateRecord(v, instanceId, patch) {
  const r = await underMountLock(v, "__private-update", [instanceId, JSON.stringify(patch)]);
  if (r.kind === "exit" && r.code === REC.OK) return "ok";
  if (r.kind === "exit" && (r.code === REC.MISMATCH || r.code === REC.NONE)) return "mismatch";
  return "failed";
}

// ───────────────────────────── outer cleanup (§3.5) ─────────────────────────────

/**
 * P0 / `lock` (outside the ns): terminate proven members under mount.lock, then releaseRecord with
 * the remaining budget. No record ⇒ nothing is signalled (report only).
 * → {code, lines[]} (0 released · 75 kept)
 */
export async function outerPrivateCleanup(v, instanceId, { budgetMs = PRIVATE_BUDGET.outerCleanupMs } = {}) {
  const deadline = Date.now() + budgetMs;
  const lines = [];
  const termBudget = Math.max(500, Math.min(6_000, deadline - Date.now() - 3_500));
  const t = await underMountLock(v, "__private-terminate", [instanceId, String(termBudget)], {
    waitS: 2,
    workMs: termBudget + 1_000,
  });
  const info = t.kind === "exit" ? (lastJsonLine(t.stdout) ?? {}) : {};
  for (const k of info.killed ?? []) lines.push(`  已终止 pid ${k.pid} ${k.comm}（${k.sig}）`);
  if (t.kind === "exit" && t.code === REC.NONE) return { code: EXIT.OK, lines };
  if (t.kind === "exit" && t.code === REC.MISMATCH) {
    lines.push(`${v.name}：记录已属于另一个实例，不动它`);
    return { code: EXIT.OK, lines };
  }
  if (t.kind === "exit" && t.code === REC.SUPERVISOR) {
    lines.push(
      info.supervisor === "alive"
        ? `${v.name}：监督进程仍在运行，未执行外部收尾（记录保留）`
        : `${v.name}：无法确认监督进程状态，未执行外部收尾（记录保留）；稍后重试，或 pi-secure status ${v.name}`,
    );
    return { code: EXIT.BUSY, lines };
  }
  const left = deadline - Date.now();
  if (left < 600) {
    lines.push(`${v.name}：外部收尾预算耗尽，记录保留（pi-secure status ${v.name}）`);
    return { code: EXIT.DEADLINE, lines };
  }
  const rel = await releaseRecord(v, instanceId, { waitMs: Math.max(100, left - PRIVATE_BUDGET.scanMs - 1_500) });
  if (rel.kind === "released" || rel.kind === "none") return { code: EXIT.OK, lines };
  if (rel.kind === "members")
    lines.push(
      `${v.name}：命名空间仍有成员（${rel.members.map((m) => `pid ${m.pid} ${m.comm}`).join(", ")}），记录保留`,
    );
  else lines.push(`${v.name}：无法释放 --private 记录（${rel.kind}），记录保留；pi-secure status ${v.name}`);
  for (const r of info.remaining ?? []) lines.push(`  残留 pid ${r.pid} ${r.comm}`);
  for (const u of info.unverified ?? [])
    lines.push(`  未经证明的进程 pid ${u.pid} ${u.comm}（无法证明属于该实例，只报告、未终止；人工核对）`);
  return { code: EXIT.DEADLINE, lines };
}

// ───────────────────────────── external lock (§3.7) ─────────────────────────────

const LOCK_WAIT_MS = 10_000;

/** Re-read view (global probe + instance view). */
async function freshView(v) {
  return vaultInstanceView(v, await probeMountState(v));
}

/**
 * Wait ≤ms for the instance `instanceId` to disappear (record gone / owned by a successor),
 * re-judging liveness about once a second. → {kind:"gone"} | {kind:"stale"|"orphan"|"timeout", view}
 */
async function waitInstanceGone(v, instanceId, ms) {
  const end = Date.now() + ms;
  let nextJudge = Date.now() + 1_000;
  for (;;) {
    const r = await readPrivateRecord(v, { deadline: Date.now() + PRIVATE_BUDGET.scanMs });
    if (r.kind === "none" || (r.kind === "ok" && r.record.instanceId !== instanceId)) return { kind: "gone" };
    const last = Date.now() >= end;
    if (last || Date.now() >= nextJudge) {
      const view = await freshView(v);
      if (view.state === "none" || (view.record && view.record.instanceId !== instanceId)) return { kind: "gone" };
      if (view.state === "stale") return { kind: "stale", view };
      if (view.state === "orphan" || view.state === "orphan-ns") return { kind: "orphan", view };
      if (last) return { kind: "timeout", view };
      nextJudge = Date.now() + 1_000;
    }
    await sleep(200);
  }
}

/** §3.5 from `lock` (hard backstop outerCleanupMs + 0.5 s ⇒ 75). */
async function lockOuter(v, instanceId) {
  const hard = armHardExit(
    PRIVATE_BUDGET.outerCleanupMs + PRIVATE_BUDGET.hardGraceMs,
    `--private 外部收尾未完成（${v.name}），记录保留`,
  );
  try {
    const c = await outerPrivateCleanup(v, instanceId);
    for (const l of c.lines) (c.code === EXIT.OK ? out : err)(l);
    if (c.code === EXIT.OK) out(`${v.name}：已终止并清理 --private 实例`);
    return c.code;
  } finally {
    clearTimeout(hard);
  }
}

/** Read /proc/<pid>/mountinfo of the supervisor (initial-ns caller; bounded). undefined = unreadable. */
async function supervisorMountinfo(sup, procRoot = "/proc") {
  const t = await deadlineRace(
    fsp.readFile(path.join(procRoot, String(sup.pid), "mountinfo"), "utf8"),
    Date.now() + PRIVATE_BUDGET.scanMs,
  ).catch(() => TIMEOUT);
  return typeof t === "string" && readProcStartSync(sup.pid, procRoot) === sup.start ? t : undefined;
}

/**
 * Execute a lockPrivateDecision. `depth` bounds re-judging (a state that changes under us is
 * re-dispatched at most once more).
 */
async function lockPrivate(v, view, d, opts, depth = 0) {
  const name = v.name;
  const rec = view.record;
  const rejudge = async (why) => {
    const nv = await freshView(v);
    const nd = lockPrivateDecision(v, nv, opts);
    if (nd.action === "plain") {
      out(`${name}：--private 实例已不在${why ? `（${why}）` : ""}`);
      return EXIT.OK;
    }
    if (depth >= 1) {
      err(`${name}：--private 实例状态在操作期间变化（${nv.state}），未完成；pi-secure status ${name}`);
      return nd.action === "refuse" ? nd.code : EXIT.DEADLINE;
    }
    return lockPrivate(v, nv, nd, opts, depth + 1);
  };
  switch (d.action) {
    case "refuse": {
      err(d.text);
      for (const h of view.holders ?? [])
        err(`  持有者 pid ${h.pid} ${h.comm ?? "(已退出/不可读)"}（/proc/locks，只报告）`);
      for (const m of view.classes?.unverified ?? [])
        err(`  命名空间成员 pid ${m.pid} ${m.comm}（无法证明属于该实例，只报告、不终止）`);
      return d.code;
    }
    case "release": {
      const rel = await releaseRecord(v, rec.instanceId, { waitMs: 1_000 });
      if (rel.kind === "released" || rel.kind === "none") {
        out(`${name}：清理了失效的 --private 记录`);
        return EXIT.OK;
      }
      if (rel.kind === "mismatch") return rejudge("记录已换成另一个实例");
      if (depth >= 1) {
        err(`${name}：无法清理失效的 --private 记录（${rel.kind}）；pi-secure status ${name}`);
        return rel.kind === "timeout" || rel.kind === "lease-busy" ? EXIT.DEADLINE : EXIT.BUSY;
      }
      return rejudge();
    }
    case "outer":
      if (d.degrade)
        err(
          `${name}：监督进程已不在，无法在私有命名空间内摘除挂载路径（--lazy 退化）：改为终止有证明归属的进程（含 gocryptfs）并清理记录`,
        );
      return lockOuter(v, rec.instanceId);
    case "kill": {
      const sup = rec.supervisor;
      if (!sup || !signalVerified(sup, "SIGTERM", { nsMnt: rec.ns?.mnt }))
        return depth >= 1 ? EXIT.BUSY : rejudge("监督进程已变化");
      out(`${name}：已通知监督进程（pid ${sup.pid}）结束会话并收尾（≤10 s）…`);
      const hard = armHardExit(LOCK_WAIT_MS + PRIVATE_BUDGET.scanMs * 2 + 2_000, `等待 --private 收尾超时（${name}）`);
      let w;
      try {
        w = await waitInstanceGone(v, rec.instanceId, LOCK_WAIT_MS);
      } finally {
        clearTimeout(hard);
      }
      if (w.kind === "gone") {
        out(`${name}：--private 会话已结束并收尾`);
        return EXIT.OK;
      }
      if (w.kind === "stale") return lockPrivate(v, w.view, { action: "release" }, opts, depth + 1);
      err(`${name}：${w.kind === "orphan" ? "监督进程已退出但收尾未完成" : "10 s 内未完成收尾"}，执行外部收尾`);
      return lockOuter(v, rec.instanceId);
    }
    case "wait": {
      out(`${name}：--private 实例正在收尾，等待（≤10 s）…`);
      const hard = armHardExit(LOCK_WAIT_MS + PRIVATE_BUDGET.scanMs * 2 + 2_000, `等待 --private 收尾超时（${name}）`);
      let w;
      try {
        w = await waitInstanceGone(v, rec.instanceId, LOCK_WAIT_MS);
      } finally {
        clearTimeout(hard);
      }
      if (w.kind === "gone") {
        out(`${name}：--private 实例已收尾`);
        return EXIT.OK;
      }
      if (w.kind === "stale") return lockPrivate(v, w.view, { action: "release" }, opts, depth + 1);
      if (w.kind === "orphan") return lockPrivate(v, w.view, { action: "outer", degrade: opts.lazy }, opts, depth + 1);
      err(`${name}：--private 实例 10 s 内仍未收尾（${w.view.state}）；稍后 pi-secure status ${name}`);
      return EXIT.DEADLINE;
    }
    case "lazy": {
      const sup = rec.supervisor;
      const gone = (mi) => mi !== undefined && vaultMountState(mi, rec.realMnt, rec.realCipher) === "absent";
      if (!sup) return rejudge();
      if (gone(await supervisorMountinfo(sup))) {
        out(`${name}：${LAZY_DETACHED_TEXT}`);
        return EXIT.OK;
      }
      if (!signalVerified(sup, "SIGUSR2", { nsMnt: rec.ns?.mnt }))
        return depth >= 1 ? EXIT.BUSY : rejudge("监督进程已变化");
      const end = Date.now() + 3_000;
      while (Date.now() < end) {
        await sleep(100);
        const mi = await supervisorMountinfo(sup);
        if (mi === undefined && readProcStartSync(sup.pid) !== sup.start) return rejudge("监督进程已退出");
        if (gone(mi)) {
          out(`${name}：${LAZY_DETACHED_TEXT}`);
          return EXIT.OK;
        }
      }
      err(
        `${name}：未能确认私有命名空间内的挂载路径已摘除（监督进程 pid ${sup.pid} 的 mountinfo 仍有该条目）；pi-secure status ${name}；要结束访问请用 --kill`,
      );
      return EXIT.DEADLINE;
    }
    default:
      throw new CliError(EXIT.FAIL, `内部错误：未知 lock 动作 ${d.action}`);
  }
}

// ───────────────────────────── P0 outcome table (§3.6) ─────────────────────────────

/**
 * Pure decision after P1 ended. facts = {record:{kind,record?}, instanceId, p1Code, piAlive}.
 * → {action:"none"|"abort-start"|"release"|"wait-pi"|"outer", code?, note?}
 */
export function decidePrivateOutcome(f) {
  const r = f.record;
  if (r.kind === "none")
    return { action: "none", code: f.p1Code === LEASE_BUSY_CODE ? EXIT.BUSY : f.p1Code, note: "record-gone" };
  if (r.kind !== "ok") return { action: "none", code: EXIT.DEADLINE, note: "record-unreadable" };
  const rec = r.record;
  if (rec.instanceId !== f.instanceId) return { action: "none", code: f.p1Code, note: "successor" };
  if (!rec.ns && !rec.supervisor) {
    if (f.p1Code === LEASE_BUSY_CODE && rec.phase === "starting") return { action: "abort-start", code: EXIT.BUSY };
    return { action: "release", code: f.p1Code === 0 ? EXIT.FAIL : (rec.failCode ?? EXIT.PREREQ) };
  }
  // setup mode never has a pi: a completed in-ns finalize without failCode IS success (N2).
  const code = rec.piExit
    ? rec.piExit.code
    : (rec.failCode ??
      (rec.mode === "setup" && rec.inNsDone === true ? EXIT.OK : f.p1Code === 0 ? EXIT.FAIL : f.p1Code));
  if (rec.inNsDone === true) return { action: "release", code };
  // P1 was killed alone: wait for the user to leave pi, then clean up outside (piExit missing ⇒ 1).
  if (f.piAlive) return { action: "wait-pi", code: rec.piExit ? rec.piExit.code : EXIT.FAIL };
  return { action: "outer", code };
}

// ───────────────────────────── web-hub hint (§4.1-4) ─────────────────────────────

/** webHub.enabled === true and no candidate hub socket answers within 300 ms ⇒ one hint line. */
export async function webHubHint(home = homeDir(), { timeoutMs = 300 } = {}) {
  const r = readJsonFile(settingsFilePath(home));
  if (r.kind !== "ok" || !isPlainObject(r.value) || !isPlainObject(r.value.webHub) || r.value.webHub.enabled !== true)
    return undefined;
  const stateDir = path.join(home, ".pi", "agent", "web-hub");
  const cands = [path.join(stateDir, "hub.sock")];
  if (process.env.XDG_RUNTIME_DIR) cands.push(path.join(process.env.XDG_RUNTIME_DIR, "pi-webhub.sock"));
  cands.push(`/tmp/pi-webhub-${process.getuid()}/hub.sock`);
  const net = await import("node:net");
  const tryOne = (p) =>
    new Promise((resolve) => {
      if (Buffer.byteLength(p) > 100) return resolve(false);
      const s = net.connect(p);
      const t = setTimeout(() => {
        s.destroy();
        resolve(false);
      }, timeoutMs);
      t.unref();
      s.on("connect", () => {
        clearTimeout(t);
        s.destroy();
        resolve(true);
      });
      s.on("error", () => {
        clearTimeout(t);
        resolve(false);
      });
    });
  const ok = (await Promise.all(cands.map(tryOne))).some(Boolean);
  return ok
    ? undefined
    : "web-hub 当前未运行：私有命名空间内的会话不会自动拉起它（会被困在命名空间里并持有明文视图）。需要网页时，在普通终端的 pi 里执行 /webhub start";
}

// ───────────────────────────── P0: run --private (§2.2) ─────────────────────────────

/** P0 orchestration. Called by cmdRun after the shared checks + lexical audit. */
export async function runPrivate(v, { sub, piArgs, piBin, pkg, mode = "run", fix = false, relocateTxid } = {}) {
  requirePrereqs();
  const pf = await privatePreflight();
  if (!pf.ok)
    throw new CliError(
      EXIT.PREREQ,
      `--private 前置检查失败：\n  - ${pf.problems.join("\n  - ")}\n  去掉 --private 仍可用普通模式`,
    );
  requireTty("解锁");
  const instanceId = (await import("node:crypto")).randomBytes(16).toString("hex");
  const ownerStart = readProcStartSync(process.pid);
  if (ownerStart === undefined) throw new CliError(EXIT.PREREQ, "无法读取 /proc/self/stat");
  const claim = await runBounded(
    "flock",
    [
      "-o",
      "-E",
      String(FLOCK_TIMEOUT_CODE),
      "-w",
      String(PRIVATE_BUDGET.claimLockWaitS),
      v.lock,
      process.execPath,
      selfPath(),
      "__private-claim",
      v.name,
      instanceId,
      String(process.pid),
      String(ownerStart),
      mode,
    ],
    {
      deadline: Date.now() + PRIVATE_BUDGET.claimLockWaitS * 1000 + PRIVATE_BUDGET.claimWorkMs,
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  if (claim.kind === "timeout") throw new CliError(EXIT.DEADLINE, "认领超时（预算耗尽），未挂载");
  if (claim.kind === "error") throw new CliError(EXIT.FAIL, `无法执行 flock：${claim.message}`);
  if (claim.code === FLOCK_TIMEOUT_CODE)
    throw new CliError(EXIT.LOCK_BUSY, "另一个 pi-secure 正在挂载或卸载（mount.lock 等待超时）");
  if (claim.code !== 0) throw new CliError(claim.code, ""); // the claim child already printed why

  // setup (init --private / --fix-settings) never starts pi ⇒ no web-hub hint; the boundary
  // sentence is printed on every private start (§5.1), setup included.
  const hint = mode === "run" ? await webHubHint().catch(() => undefined) : undefined;
  if (hint) err(hint);
  err(PRIVATE_BOUNDARY_LONG);
  const spec = {
    v: 3,
    mode,
    name: v.name,
    instanceId,
    sub,
    piArgs,
    piBin,
    piPkg: pkg,
    fix,
    ...(mode === "setup" && relocateTxid !== undefined ? { relocateTxid } : {}),
    uid: process.getuid(),
    gid: process.getgid(),
  };
  const p1Code = await new Promise((resolve) => {
    const child = spawn("/bin/sh", leaseChainArgs(v.lease, nsRootTail()), {
      stdio: "inherit", // fd 9 is opened by the shell itself (I-P9); Node never passes it here
      cwd: "/",
      env: { ...process.env, PI_SECURE_NS_SPEC: JSON.stringify(spec) },
    });
    const noop = () => {};
    const fwd = (sig) => () => {
      try {
        child.kill(sig);
      } catch {
        /* gone */
      }
    };
    const handlers = { SIGINT: noop, SIGQUIT: noop, SIGTERM: fwd("SIGTERM"), SIGHUP: fwd("SIGHUP") };
    for (const [s, h] of Object.entries(handlers)) process.on(s, h);
    const done = (c) => {
      for (const [s, h] of Object.entries(handlers)) process.off(s, h);
      resolve(c);
    };
    child.on("error", () => done(127));
    child.on("close", (c, sig) => done(c ?? (sig ? 128 + (os.constants.signals[sig] ?? 0) : 1)));
  });
  return await privateOutcome(v, instanceId, p1Code);
}

async function privateOutcome(v, instanceId, p1Code) {
  const read = () => readPrivateRecord(v, { deadline: Date.now() + PRIVATE_BUDGET.scanMs });
  let record = await read();
  const piAlive = async (rec) => (rec?.pi ? identityAlive(rec.pi) : false);
  let d = decidePrivateOutcome({
    record,
    instanceId,
    p1Code,
    piAlive: record.kind === "ok" && (await piAlive(record.record)),
  });
  if (d.note === "record-gone" && p1Code !== LEASE_BUSY_CODE)
    err(`${v.name}：--private 记录已不在（可能已被 pi-secure lock 清理）`);
  if (d.note === "successor") err(`${v.name}：--private 记录已属于另一个实例，未改动`);
  if (d.note === "record-unreadable") err(`${v.name}：无法读取 --private 记录，未做清理；pi-secure status ${v.name}`);
  if (d.action === "abort-start") {
    const r = await underMountLock(v, "__private-abort-start", [instanceId], { waitS: 2 });
    if (!(r.kind === "exit" && (r.code === REC.OK || r.code === REC.NONE)))
      err(`${v.name}：未能删除本次的 starting 记录（pi-secure status ${v.name}）`);
    err(`${v.name}：挂载租约被另一个挂载抢先持有，未挂载`);
    return EXIT.BUSY;
  }
  if (d.action === "wait-pi") {
    err(`${v.name}：监督进程意外退出；等待 pi（pid ${record.record.pi.pid}）正常退出后收尾`);
    while (await piAlive(record.record)) await sleep(500);
    record = await read();
    d = { ...d, action: "outer" };
  }
  if (d.action === "release") {
    const hard = armHardExit(
      PRIVATE_BUDGET.outerCleanupMs + PRIVATE_BUDGET.hardGraceMs,
      `释放 --private 记录未完成（${v.name}）`,
    );
    try {
      const rel = await releaseRecord(v, instanceId, { waitMs: PRIVATE_BUDGET.releaseLeaseWaitS * 1000 });
      if (rel.kind === "released" || rel.kind === "none") return d.code;
      if (rel.kind === "mismatch") return d.code;
      err(
        rel.kind === "members"
          ? `${v.name}：命名空间仍有成员（${rel.members.map((m) => `pid ${m.pid} ${m.comm}`).join(", ")}），--private 记录保留；pi-secure status ${v.name} / pi-secure lock ${v.name}`
          : `${v.name}：无法释放 --private 记录（${rel.kind}），记录保留；pi-secure status ${v.name} / pi-secure lock ${v.name}`,
      );
      return EXIT.DEADLINE;
    } finally {
      clearTimeout(hard);
    }
  }
  if (d.action === "outer") {
    const hard = armHardExit(
      PRIVATE_BUDGET.outerCleanupMs + PRIVATE_BUDGET.hardGraceMs,
      `--private 外部收尾未完成（${v.name}），记录保留`,
    );
    try {
      err(`${v.name}：命名空间内收尾未完成，执行外部收尾`);
      const c = await outerPrivateCleanup(v, instanceId);
      for (const l of c.lines) err(l);
      return c.code === EXIT.OK ? d.code : EXIT.DEADLINE;
    } finally {
      clearTimeout(hard);
    }
  }
  return d.code;
}

// ───────────────────────────── relocation entry (convert-plan §3.4, V6) ─────────────────────────────

/**
 * `init <名字> --fix-settings` on an entry carrying `relocate` (convert-plan §3.4). Normal vault ⇒
 * V5 `relocateVault` (its own admission: unmounted, no instance, lease free, `to` = current work;
 * raw mount, fd-anchored workers, phase per step, clears the marker, always unmounts). Private vault
 * ⇒ the private setup mode: the same steps run INSIDE the private mount namespace (`relocateInNs`),
 * the vault must be unmounted and without a live instance; the marker is advanced/cleared OUTSIDE
 * the namespace under the settings lock with the relocateTxid guard.
 */
export async function fixSettingsRelocate(v, home, deps = {}) {
  const d = {
    relocateVault: async (o) => (await import("./archive.mjs")).relocateVault(o),
    probeMountState,
    vaultInstanceView,
    patchVaultEntry,
    runPrivate,
    requireTty,
    out,
    err,
    ...deps,
  };
  if (v.private !== true) return (await d.relocateVault({ name: v.name, home })).code;
  const name = v.name;
  const rel = v.relocate;
  const realWork = path.join(physicalPaths(v).realMnt, "work");
  if (realWork !== rel.to)
    throw new CliError(EXIT.CONFIG, `迁址目标 ${rel.to} 与保险库当前工作目录 ${realWork} 不一致——请人工检查登记项`);
  const st = await d.probeMountState(v);
  if (st !== "absent")
    throw new CliError(
      EXIT.BUSY,
      `保险库 ${name} 当前已挂载（${st}）——私有库迁址要求未挂载：先 pi-secure lock ${name}，再执行 pi-secure init ${name} --fix-settings`,
    );
  const view = await d.vaultInstanceView(v, st);
  if (view.state !== "none" && view.state !== "stale")
    throw new CliError(
      EXIT.BUSY,
      `保险库 ${name} 有正在运行或无法判定的私有实例 / 租约被占用（${view.state}）——拒绝迁址`,
    );
  d.requireTty("迁址"); // before the marker moves: a non-TTY call changes nothing
  const mark = (patch) => {
    const r = d.patchVaultEntry(name, { relocateTxid: rel.txid }, patch, { home });
    if (r.kind !== "ok") throw new CliError(EXIT_IO, `更新迁址标记失败（${r.kind}${r.reason ? `：${r.reason}` : ""}）`);
  };
  mark({ set: { relocate: { ...rel, phase: "sessions" } } });
  d.out(`${name}：在私有命名空间内迁址（${rel.from} → ${rel.to}；再输入一次口令，结束后自动卸载）：`);
  const code = await d.runPrivate(v, { mode: "setup", relocateTxid: rel.txid });
  if (code !== EXIT.OK) {
    d.err(`${name}：迁址未完成（exit ${code}）；迁址标记保留，修复原因后重试 pi-secure init ${name} --fix-settings`);
    return code;
  }
  mark({ set: { relocate: { ...rel, phase: "synced" } } });
  mark({ remove: ["relocate"] });
  d.out(`保险库 ${name} 迁址完成（${rel.from} → ${rel.to}；在私有命名空间内完成，已卸载）。`);
  return EXIT.OK;
}

/**
 * P1 side of the private relocation (setup stage, inside the ns, on the raw mount this supervisor
 * just made): re-checks that the entry still carries THIS txid and no pending, that `to` is the
 * in-ns physical work, then runs archive.mjs `runRelocateSteps` (fd-anchored workers, re-entrant,
 * `sync -f`). No settings writes here. → the post-mount worker's result shape {ok, code?, message?, notes}.
 */
export async function relocateInNs(v, txid, realMnt, S, { runSteps } = {}) {
  const rel = v.relocate;
  if (!rel || rel.txid !== txid || v.pending !== undefined)
    return { ok: false, code: EXIT.CONFIG, message: "迁址标记已变化（txid 不符或出现未完成的转换/导入），中止" };
  if (path.join(realMnt, "work") !== rel.to)
    return { ok: false, code: EXIT.CONFIG, message: `迁址目标 ${rel.to} 与挂载后的工作目录不一致，中止` };
  const ac = new AbortController();
  S.onRelocAbort = () => ac.abort();
  const warnings = [];
  try {
    const A = await import("./archive.mjs");
    try {
      await (runSteps ?? A.runRelocateSteps)({ v, rel, realMnt, home: homeDir(), signal: ac.signal, warnings });
      return { ok: true, notes: warnings };
    } catch (e) {
      const f = A.toFailure(e);
      return { ok: false, code: f.code, message: f.message, notes: warnings };
    }
  } catch (e) {
    return { ok: false, code: EXIT.FAIL, message: `无法加载迁址模块：${(e && e.message) || e}`, notes: warnings };
  } finally {
    S.onRelocAbort = undefined;
  }
}

// ───────────────────────────── worker (§2.6) ─────────────────────────────

/** `__mount-work` (env PI_SECURE_WORK_SPEC): sync fs under the mount, isolated in a KILLable process. */
async function cmdMountWork() {
  let spec;
  try {
    spec = JSON.parse(process.env.PI_SECURE_WORK_SPEC ?? "");
  } catch {
    out(JSON.stringify({ ok: false, code: EXIT.FAIL, message: "worker spec 无效" }));
    return EXIT.FAIL;
  }
  delete process.env.PI_SECURE_WORK_SPEC;
  const delay = testWorkerDelayMs(spec?.op);
  if (delay) await sleep(delay);
  try {
    const { vault: v } = must(resolveVault(spec.name));
    const { realMnt } = physicalPaths(v);
    if (spec.op === "readdir") {
      fs.readdirSync(v.mnt);
      out(JSON.stringify({ ok: true }));
      return EXIT.OK;
    }
    if (spec.op === "verify") {
      const pin = { ...spec.pin, fd: spec.pinFd, closed: true };
      verifyMountPointIdentity(v, pin, { readlink: () => fs.readlinkSync(`/proc/${spec.pinPid}/fd/${spec.pinFd}`) });
      out(JSON.stringify({ ok: true }));
      return EXIT.OK;
    }
    if (spec.op === "post-mount") {
      const notes = [];
      ensureVaultDirs(v, { realMnt });
      const r = syncProjectSettings(v, { fix: spec.fix === true });
      if (r.kind === "conflict") throw new CliError(EXIT.CONFIG, r.message);
      if (r.kind === "written") notes.push(`已写入 ${path.join(v.work, ".pi", "settings.json")} 的 sessionDir`);
      if (r.kind === "fixed")
        notes.push(
          `已改写 sessionDir（原文件备份为 ${r.backup}${r.droppedOtherKeys ? "；原文件不是 JSON 对象，其余内容只在备份里" : ""}）`,
        );
      if (spec.mode === "setup") {
        out(JSON.stringify({ ok: true, notes }));
        return EXIT.OK;
      }
      const cwd = resolveRunCwd(v, spec.sub ?? undefined, { physical: true, realMnt });
      const parseArgs = await loadPiParseArgs(spec.piPkg);
      if (!parseArgsShapeOk(parseArgs))
        throw new CliError(EXIT.REFUSED_ARGS, "pi parseArgs 的结果结构变了，参数审查无法保证，拒绝启动");
      const a2 = auditParsedArgs(parseArgs(spec.piArgs ?? []), {
        cwd,
        sessionsRoot: path.join(realMnt, "state", "sessions"),
        physical: true,
      });
      if (!a2.ok) throw new CliError(EXIT.REFUSED_ARGS, `参数被拒：${a2.reason}`);
      verifyRunPaths(v, cwd, { realMnt });
      out(JSON.stringify({ ok: true, cwd, notes }));
      return EXIT.OK;
    }
    throw new CliError(EXIT.FAIL, `未知 worker op：${spec.op}`);
  } catch (e) {
    const code = e instanceof CliError ? e.code : EXIT.FAIL;
    out(JSON.stringify({ ok: false, code, message: String((e && e.message) || e) }));
    return code;
  }
}

/** Run one worker op bounded by `ms` → {ok, code?, message?, …} (timeout ⇒ code 75). */
export async function runWorker(spec, ms) {
  const w = workerSpawnSpec(spec);
  const r = await runBounded(w.cmd, w.args, { deadline: Date.now() + ms, env: w.opts.env });
  return workerOutcome(r, spec.op);
}

/** Pure mapping of a worker's runBounded result (timeout ⇒ 75, even if the KILL let it close). */
export function workerOutcome(r, op) {
  if (r.kind === "timeout") return { ok: false, code: EXIT.DEADLINE, message: `挂载内操作 ${op} 超时（FUSE 卡住？）` };
  if (r.kind === "error") return { ok: false, code: EXIT.FAIL, message: r.message };
  const j = lastJsonLine(r.stdout);
  return j ?? { ok: false, code: EXIT.FAIL, message: (r.stderr || "").trim() || `worker exit ${r.code}` };
}

// ───────────────────────────── P1: ns-root supervisor (§2.3, §3.4) ─────────────────────────────

/** Self-check of the ns-root identity (§2.3-1). Pure: `facts` = {uid, uidMap, gidMap, spec}. */
export function nsRootSelfCheck({ uid, uidMap, gidMap, spec }) {
  const problems = [];
  if (uid !== 0) problems.push(`ns 内 uid ≠ 0（${uid}）`);
  const norm = (t) => (t ?? "").trim().split(/\s+/).join(" ");
  if (norm(uidMap) !== `0 ${spec?.uid} 1`) problems.push(`uid_map 不是 "0 ${spec?.uid} 1"（${norm(uidMap)}）`);
  if (norm(gidMap) !== `0 ${spec?.gid} 1`) problems.push(`gid_map 不是 "0 ${spec?.gid} 1"（${norm(gidMap)}）`);
  if (!spec || spec.v !== 3 || !HEX32_RE.test(spec.instanceId ?? "") || !VAULT_NAME_RE.test(spec.name ?? ""))
    problems.push("规格无效");
  return problems;
}

/**
 * TERM `id` now, KILL it after `graceMs` unless `exited` settles first (review N1 #4): the delayed
 * signal is cancelled on exit and every signal re-verifies pid+starttime (a recycled pid is never
 * hit). Returns the cancel function.
 */
export function termThenKill(id, { graceMs, exited, kill, procRoot = "/proc" }) {
  if (!id) return () => {};
  signalVerified(id, "SIGTERM", { procRoot, ...(kill ? { kill } : {}) });
  const t = setTimeout(() => signalVerified(id, "SIGKILL", { procRoot, ...(kill ? { kill } : {}) }), graceMs);
  t.unref();
  const cancel = () => clearTimeout(t);
  exited.then(cancel, cancel);
  return cancel;
}

/**
 * Review N1 #3 (Q10 inside the ns): what this freshly unshared mount namespace inherited. Any
 * fuse.gocryptfs mount, any mount on another registered vault's mount point, or anything already
 * on our own mount point ⇒ refuse (a global mount copied in here could never be detached).
 * → [problem strings] (empty ⇔ clean)
 */
export function inheritedMountProblems(mountinfo, { realMnt, others = [] }) {
  const problems = [];
  const otherMnts = new Map(others.map((o) => [o.realMnt, o.name]));
  for (const e of parseMountinfo(mountinfo)) {
    if (e.fsType === GOCRYPTFS_FSTYPE) problems.push(`继承到 gocryptfs 挂载 ${e.mountPoint}（${e.source}）`);
    else if (otherMnts.has(e.mountPoint))
      problems.push(`继承到保险库 ${otherMnts.get(e.mountPoint)} 的挂载点上的挂载 ${e.mountPoint}`);
    else if (e.mountPoint === realMnt) problems.push(`本库挂载点上已有挂载（${e.fsType}）`);
  }
  return problems;
}

/** Poll /proc/<pid>/ns/user until it differs from `outerUser` (the inner unshare ran) — ≤ maxMs. */
async function waitInnerUserNs(pid, outerUser, maxMs = 1_000) {
  const end = Date.now() + maxMs;
  for (;;) {
    const u = readNsLinkSync(pid, "user");
    if (u && u !== outerUser) return u;
    if (u === undefined || Date.now() >= end) return undefined;
    await sleep(10);
  }
}

async function cmdNsRoot() {
  // stderr EIO (terminal gone) must never crash the supervisor (K13).
  process.stderr.on("error", () => {});
  process.stdout.on("error", () => {});
  const say = (s) => {
    try {
      process.stderr.write(`pi-secure: ${s}\n`);
    } catch {
      /* EIO */
    }
  };
  const S = {
    stage: "init",
    gocry: undefined, // ChildProcess
    gocryId: undefined,
    pi: undefined,
    piId: undefined,
    abort: false,
    readyResolve: undefined,
    lazyBusy: false,
  };
  // Signals FIRST (gocryptfs' SIGUSR1 would otherwise kill us — default action terminates).
  process.on("SIGUSR1", () => S.readyResolve?.("usr1"));
  // N2: SIGUSR2 (`lock --lazy`) is handled from the start too — `lock` may read phase:"session"
  // the instant the record is written, before this process resumes; the default action would
  // kill the supervisor. lazyDetach itself is a no-op outside the session stage.
  process.on("SIGUSR2", () => {
    if (S.onUsr2) S.onUsr2();
    else if (S.stage === "launching") S.usr2Pending = true; // the race window right before "session"
  });
  const interrupt = () => {
    S.onRelocAbort?.(); // V6: a running relocation worker is aborted (setup stage only)
    if (S.stage === "mounting") {
      S.abort = true;
      signalVerified(S.gocryId ?? { pid: -1, start: -1 }, "SIGTERM"); // identity-checked (review N1 #4)
    }
  };
  process.on("SIGINT", interrupt);
  process.on("SIGQUIT", interrupt);
  process.on("SIGHUP", () => {
    try {
      S.pi && S.pi.kill("SIGHUP");
    } catch {
      /* gone */
    }
  });
  process.on("SIGTERM", () => {
    S.abort = true;
    S.onRelocAbort?.();
    if (S.stage === "mounting") interrupt();
    if (S.pi) {
      try {
        S.pi.kill("SIGTERM");
      } catch {
        /* gone */
      }
      const t = setTimeout(() => {
        try {
          S.pi?.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }, PRIVATE_BUDGET.sessionKillGraceMs);
      t.unref();
    }
  });

  let spec;
  try {
    spec = JSON.parse(process.env.PI_SECURE_NS_SPEC ?? "");
  } catch {
    say("内部错误：缺少 ns 规格");
    return EXIT.FAIL;
  }
  delete process.env.PI_SECURE_NS_SPEC;
  const problems = nsRootSelfCheck({
    uid: process.getuid(),
    uidMap: readTextOr("/proc/self/uid_map", ""),
    gidMap: readTextOr("/proc/self/gid_map", ""),
    spec,
  });
  const { vault: v } = (() => {
    const r = resolveVault(spec?.name);
    return r.kind === "ok" ? r : { vault: undefined };
  })();
  if (!v) problems.push("无法解析保险库");
  let rec;
  if (v) {
    const cur = readPrivateRecordSync(v);
    if (cur.kind !== "ok") problems.push(`记录不可用（${cur.kind}）`);
    else if (cur.record.instanceId !== spec.instanceId) problems.push("记录属于另一个实例");
    else if (cur.record.phase !== "starting") problems.push(`记录阶段不是 starting（${cur.record.phase}）`);
    else rec = cur.record;
  }
  // fd 9 must be the lease (dev/ino) AND this very description must hold the flock.
  if (rec) {
    let st;
    try {
      st = fs.fstatSync(9);
    } catch {
      problems.push("fd 9 不存在");
    }
    if (st) {
      const { maj, min } = devMajMin(st.dev);
      if (`${maj}:${min}` !== rec.lease.dev || st.ino !== rec.lease.ino) problems.push("fd 9 不是本库的 mount.lease");
      else {
        const self = await runBounded("flock", ["-n", "9"], {
          deadline: Date.now() + 1_000,
          stdio: ["ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9],
          killGraceMs: 200,
          abandonMs: 200,
        });
        if (!(self.kind === "exit" && self.code === 0)) problems.push("fd 9 未持有租约锁");
      }
    }
  }
  if (problems.length) {
    say(`私有命名空间自检失败，未挂载：${problems.join("；")}`);
    return EXIT.FAIL; // never touches the record of another instance; P0 releases ours
  }
  const id = spec.instanceId;
  const update = async (patch) => {
    const r = await updateRecord(v, id, patch);
    if (r !== "ok") S.abort = true;
    return r;
  };
  const myStart = readProcStartSync(process.pid);
  const nsMnt = readNsLinkSync("self", "mnt");
  const nsUser = readNsLinkSync("self", "user");
  if (
    (await update({
      phase: "mounting",
      supervisor: { pid: process.pid, start: myStart },
      ns: { mnt: nsMnt, user: nsUser },
    })) !== "ok"
  ) {
    say("记录变迁失败（instanceId 不符或 mount.lock 超时），未挂载");
    return EXIT.FAIL;
  }
  S.stage = "mounting";
  const { realMnt, realCipher } = physicalPaths(v);
  let failCode;
  let failMsg;
  let pin;
  try {
    // Review N1 #3: Q10 re-checked on what THIS namespace actually inherited (closes the window
    // between the claim's global check and unshare). Unreadable ⇒ refuse.
    const mi = await deadlineRace(
      fsp.readFile("/proc/self/mountinfo", "utf8"),
      Date.now() + PRIVATE_BUDGET.scanMs,
    ).catch(() => TIMEOUT);
    if (typeof mi !== "string") throw new CliError(EXIT.DEADLINE, "无法读取私有命名空间的 mountinfo，拒绝挂载");
    const others = otherRegisteredVaults(v).map((o) => ({ name: o.name, realMnt: physicalPaths(o).realMnt }));
    const inherited = inheritedMountProblems(mi, { realMnt, others });
    if (inherited.length)
      throw new CliError(
        EXIT.BUSY,
        `私有命名空间继承了不应存在的挂载，拒绝挂载（另一保险库在认领后被全局解锁？先 lock 它再试）：\n  - ${inherited.join("\n  - ")}`,
      );
    // Inside the userns every unmapped owner (root included) reads as the overflow uid, so the
    // ancestor-chain rule cannot be evaluated here — the claim (initial ns, under mount.lock)
    // already enforced it; everything else (dir/lease/sentinels/position) is re-checked here.
    const lay = checkLayout(v, { mounted: false, others: otherRegisteredVaults(v), ancestors: false });
    if (lay.problems.length)
      throw new CliError(EXIT.CONFIG, `布局校验失败，拒绝挂载：\n  - ${lay.problems.join("\n  - ")}`);
    pin = pinMountPoint(v);
    let mounted = false;
    for (let attempt = 1; attempt <= PASSWORD_TRIES && !mounted; attempt++) {
      if (S.abort) throw new CliError(EXIT.FAIL, "已中止");
      mountPointPinStillValid(v, pin);
      const g = gocryptfsSpawnSpec(realCipher, realMnt, process.pid);
      const child = spawn(g.cmd, g.args, g.opts);
      S.gocry = child;
      // Identity captured at spawn (review N1 #4): every later signal re-verifies pid+starttime.
      const gStart = child.pid ? readProcStartSync(child.pid) : undefined;
      S.gocryId = gStart === undefined ? undefined : { pid: child.pid, start: gStart };
      const exited = new Promise((resolve) => {
        child.on("error", () => resolve(127));
        child.on("close", (c, sig) => resolve(c ?? (sig ? 128 + (os.constants.signals[sig] ?? 0) : 1)));
      });
      const ready = new Promise((resolve) => (S.readyResolve = resolve));
      let attemptTimer;
      const timeout = new Promise((resolve) => {
        attemptTimer = setTimeout(() => resolve("timeout"), PRIVATE_BUDGET.mountAttemptMs);
        attemptTimer.unref();
      });
      const first = await Promise.race([ready, exited.then((c) => ({ exit: c })), timeout]);
      clearTimeout(attemptTimer);
      S.readyResolve = undefined;
      if (first === "timeout") {
        termThenKill(S.gocryId, { graceMs: PRIVATE_BUDGET.mountKillGraceMs, exited });
        await Promise.race([exited, sleep(PRIVATE_BUDGET.mountKillGraceMs + PRIVATE_BUDGET.mountAbandonMs)]);
        throw new CliError(EXIT.DEADLINE, "gocryptfs 在 180 s 内未完成挂载（口令提示无人应答？）");
      }
      if (first !== "usr1") {
        const code = first.exit;
        S.gocry = undefined;
        S.gocryId = undefined;
        if (S.abort) throw new CliError(EXIT.FAIL, "已中止");
        if (code === 12) {
          if (attempt < PASSWORD_TRIES) {
            say(`口令错误（${attempt}/${PASSWORD_TRIES}）`);
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
      // SIGUSR1 seen (Node cannot see the sender; the mountinfo + readdir checks below prove it).
      S.gocryExited = exited;
      mounted = true;
    }
    const readyDl = Date.now() + PRIVATE_BUDGET.readyMs;
    let st = "absent";
    while (Date.now() < readyDl) {
      const mi = await fsp.readFile("/proc/self/mountinfo", "utf8").catch(() => "");
      st = vaultMountState(mi, realMnt, realCipher);
      if (st === "mounted") break;
      await sleep(50);
    }
    if (st !== "mounted") throw new CliError(EXIT.FAIL, `gocryptfs 已就绪但 ns 内 mountinfo 不符（${st}）`);
    const rd = await runWorker({ op: "readdir", name: v.name }, PRIVATE_BUDGET.readyMs);
    if (!rd.ok) throw new CliError(rd.code ?? EXIT.FAIL, `挂载探活失败：${rd.message}`);
    if (!S.gocryId) throw new CliError(EXIT.FAIL, "无法读取 gocryptfs 的进程身份");
    const nextPhase = spec.mode === "setup" ? "setup" : "launching";
    if ((await update({ phase: nextPhase, gocryptfs: S.gocryId })) !== "ok")
      throw new CliError(EXIT.FAIL, "记录变迁失败，中止");
    S.stage = nextPhase;
    const vf = await runWorker(
      {
        op: "verify",
        name: v.name,
        pinPid: process.pid,
        pinFd: pin.fd,
        pin: { path: pin.path, dev: pin.dev, ino: pin.ino, parent: pin.parent },
      },
      PRIVATE_BUDGET.readyMs,
    );
    closeMountPointPin(pin);
    if (!vf.ok) throw new CliError(vf.code ?? EXIT.FAIL, vf.message);
    if (S.abort) throw new CliError(EXIT.FAIL, "已中止");
    // convert-plan §3.4 (V6): setup mode carrying a relocation runs the fd-anchored relocation steps
    // (archive.mjs, workers) on this RAW private mount instead of the path-based post-mount writes.
    const pm =
      spec.mode === "setup" && typeof spec.relocateTxid === "string"
        ? await relocateInNs(v, spec.relocateTxid, realMnt, S)
        : await runWorker(
            {
              op: "post-mount",
              name: v.name,
              mode: spec.mode,
              fix: spec.fix === true,
              sub: spec.sub ?? null,
              piArgs: spec.piArgs ?? [],
              piPkg: spec.piPkg,
            },
            PRIVATE_BUDGET.postMountMs,
          );
    for (const n of pm.notes ?? []) say(n);
    if (!pm.ok) throw new CliError(pm.code ?? EXIT.FAIL, pm.message);
    if (S.abort) throw new CliError(EXIT.FAIL, "已中止");
    if (spec.mode !== "setup") {
      const ps = innerPiSpawnSpec({
        uid: spec.uid,
        gid: spec.gid,
        piBin: spec.piBin,
        sessionDir: v.sessionDir,
        piArgs: spec.piArgs ?? [],
        cwd: pm.cwd,
        env: piChildEnv(v, pm.cwd, process.env, { ns: true }),
      });
      const pi = spawn(ps.cmd, ps.args, ps.opts);
      S.pi = pi;
      const piExited = new Promise((resolve) => {
        pi.on("error", (e) => {
          say(`无法启动 pi：${e && e.message}`);
          resolve(127);
        });
        pi.on("close", (c, sig) => resolve(c ?? (sig ? 128 + (os.constants.signals[sig] ?? 0) : 1)));
      });
      let piDone = false;
      piExited.then(() => (piDone = true));
      // Review N1 #5: the session (pi identity + its inner userns id) MUST be published before
      // the open-ended wait. Any failure ⇒ stop the just-started pi (ChildProcess-guarded TERM,
      // bounded KILL), then the normal bounded finalize with a failure code.
      const ps0 = pi.pid ? readProcStartSync(pi.pid) : undefined;
      if (ps0 !== undefined) S.piId = { pid: pi.pid, start: ps0 };
      const innerUser = S.piId ? await waitInnerUserNs(pi.pid, nsUser) : undefined;
      let published = "skipped";
      if (!piDone) {
        published =
          S.piId && innerUser
            ? await update({ phase: "session", pi: S.piId, ns: { mnt: nsMnt, user: nsUser, innerUser } })
            : "identity";
      }
      if (published !== "ok" && published !== "skipped" && !piDone) {
        say(
          `会话身份登记失败（${published === "failed" ? "mount.lock 超时或写入失败" : published === "mismatch" ? "记录已不属于本实例" : "无法读取 pi 的进程身份"}），终止 pi 并收尾`,
        );
        S.abort = true;
        try {
          pi.kill("SIGTERM"); // ChildProcess.kill is a no-op once the child was reaped
        } catch {
          /* gone */
        }
        if (
          (await Promise.race([piExited, sleep(PRIVATE_BUDGET.sessionKillGraceMs).then(() => TIMEOUT)])) === TIMEOUT
        ) {
          try {
            pi.kill("SIGKILL");
          } catch {
            /* gone */
          }
          await Promise.race([piExited, sleep(1_000)]);
        }
        S.pi = undefined;
        S.stage = "finalizing";
        const fc = published === "failed" ? EXIT.DEADLINE : EXIT.FAIL;
        await update({ phase: "finalizing", failCode: fc });
        return await finalizeInNs(v, { realMnt, id, S, say, exitCode: fc });
      }
      S.stage = "session";
      S.onUsr2 = () => void lazyDetach(v, realMnt, id, S, say);
      if (S.usr2Pending) {
        S.usr2Pending = false;
        S.onUsr2();
      }
      const code = await piExited;
      S.pi = undefined;
      S.stage = "finalizing";
      await update({ phase: "finalizing", piExit: { code } });
      return await finalizeInNs(v, { realMnt, id, S, say, exitCode: code });
    }
  } catch (e) {
    failCode = e instanceof CliError ? e.code : EXIT.FAIL;
    failMsg = e instanceof CliError ? e.message : String((e && e.message) || e);
  } finally {
    closeMountPointPin(pin);
  }
  if (failMsg) say(failMsg);
  S.stage = "finalizing";
  const code = failCode ?? EXIT.OK;
  await update({ phase: "finalizing", ...(failCode ? { failCode } : {}) });
  return await finalizeInNs(v, { realMnt, id, S, say, exitCode: code });
}

async function lazyDetach(v, realMnt, id, S, say) {
  if (S.lazyBusy || S.stage !== "session") return;
  S.lazyBusy = true;
  try {
    const r = await runBounded("umount", ["-n", "-l", realMnt], {
      deadline: Date.now() + 1_000,
      killGraceMs: 200,
      abandonMs: 200,
    });
    if (r.kind === "exit" && r.code === 0) {
      await updateRecord(v, id, { lazyDetachedAt: new Date().toISOString() });
      say(
        "已在私有命名空间内摘除挂载路径。既有 cwd、已打开的文件和运行中的作业可能继续访问明文；插件会在下一次输入/工具调用时拒绝（LOCKED）",
      );
    }
  } finally {
    S.lazyBusy = false;
  }
}

/**
 * §3.4 ns-internal finalize (P1): members TERM→KILL (≤3 rounds), umount -n (EBUSY ⇒ -l), wait /
 * TERM / KILL gocryptfs, verify, record inNsDone. NEVER deletes the record (I-P3). Budget 10 s,
 * hard backstop 10.5 s ⇒ exit 75.
 */
async function finalizeInNs(v, { realMnt, id, S, say, exitCode }) {
  const deadline = Date.now() + PRIVATE_BUDGET.finalizeInNsMs;
  const hard = armHardExit(PRIVATE_BUDGET.finalizeInNsMs + PRIVATE_BUDGET.hardGraceMs, `ns 内收尾未完成（${v.name}）`);
  const stall = testFinalizeStallMs();
  if (stall) await sleep(stall); // TEST-ONLY (see testFinalizeStallMs): the hard backstop above still fires
  const pending = [];
  const nsMnt = readNsLinkSync("self", "mnt");
  const myStart = readProcStartSync(process.pid);
  const gocryPid = S.gocry?.pid;
  const scan = () =>
    scanNsMembers(nsMnt, {
      deadline: Math.min(deadline, Date.now() + PRIVATE_BUDGET.scanMs),
      minStart: myStart,
      exclude: [process.pid, ...(gocryPid ? [gocryPid] : [])],
      deniedMeans: "outside",
    });
  try {
    // 2. members (re-verified per signal), at most 3 rounds, ≤3.5 s
    const memberDl = Math.min(deadline, Date.now() + 3_500);
    let listed = false;
    const gocryKids = new Map();
    for (let round = 0; round < 3; round++) {
      const s = await scan();
      if (s.kind !== "done") {
        pending.push(`members:${s.reason}`);
        break;
      }
      // gocryptfs' own helpers (its syslog `logger`, started because -notifypid marks it as the
      // daemon child) belong to gocryptfs: they end with it — killing them first could SIGPIPE it.
      for (const m of s.members) if (gocryPid && m.ppid === gocryPid) gocryKids.set(m.pid, m);
      s.members = s.members.filter((m) => !gocryKids.has(m.pid));
      if (!s.members.length) break;
      if (!listed) {
        say(`收尾：终止命名空间内遗留的进程（仅本次 ns 内启动的；外部启动的 tmux server 等不受影响）：`);
        listed = true;
      }
      for (const m of s.members) {
        say(`  pid ${m.pid} ${m.comm}`);
        signalVerified(m, round === 0 ? "SIGTERM" : "SIGKILL", { nsMnt });
      }
      const waitEnd = Math.min(memberDl, Date.now() + (round === 0 ? 2_000 : 500));
      while (Date.now() < waitEnd) {
        if (s.members.every((m) => readProcStartSync(m.pid) !== m.start)) break;
        await sleep(100);
      }
      for (const m of s.members) if (readProcStartSync(m.pid) === m.start) signalVerified(m, "SIGKILL", { nsMnt });
      if (Date.now() >= memberDl) break;
    }
    // 3. umount inside the ns (private mounts are invisible to outer fusermount3)
    if (S.gocry) {
      const left = () => deadline - Date.now();
      const u = await runBounded("umount", ["-n", realMnt], {
        deadline: Date.now() + Math.min(2_000, Math.max(100, left() - 3_000)),
        killGraceMs: 0,
        abandonMs: 100,
      });
      if (!(u.kind === "exit" && u.code === 0)) {
        const notMounted = u.kind === "exit" && /not mounted|未挂载/i.test(u.stderr);
        if (!notMounted) {
          const l = await runBounded("umount", ["-n", "-l", realMnt], {
            deadline: Date.now() + 1_000,
            killGraceMs: 0,
            abandonMs: 100,
          });
          if (!(l.kind === "exit" && l.code === 0)) pending.push("umount");
        }
      }
      // 4. gocryptfs (our direct child, -fg) exits once unmounted
      const gone = await Promise.race([S.gocryExited ?? Promise.resolve(0), sleep(2_000).then(() => TIMEOUT)]);
      if (gone === TIMEOUT && S.gocryId) {
        signalVerified(S.gocryId, "SIGTERM");
        const g2 = await Promise.race([S.gocryExited ?? Promise.resolve(0), sleep(500).then(() => TIMEOUT)]);
        if (g2 === TIMEOUT) {
          signalVerified(S.gocryId, "SIGKILL");
          await Promise.race([S.gocryExited ?? Promise.resolve(0), sleep(300)]);
        }
      }
      if (S.gocryId && readProcStartSync(S.gocryId.pid) === S.gocryId.start) pending.push("gocryptfs");
    }
    // 5. verify: no member left besides us (gocryptfs' helpers get ≤0.5 s to see EOF, then KILL)
    let fin = await scan();
    const isKid = (m) => gocryKids.get(m.pid)?.start === m.start;
    if (fin.kind === "done" && fin.members.length && fin.members.every(isKid)) {
      await sleep(500);
      fin = await scan();
      if (fin.kind === "done") for (const m of fin.members) signalVerified(m, "SIGKILL", { nsMnt });
      if (fin.kind === "done" && fin.members.length) {
        await sleep(200);
        fin = await scan();
      }
    }
    if (fin.kind !== "done") pending.push(`verify:${fin.reason}`);
    else if (fin.members.length) pending.push(`members:${fin.members.map((m) => m.pid).join(",")}`);
    const done = pending.length === 0;
    await updateRecord(v, id, done ? { inNsDone: true } : { inNsDone: false, inNsPending: pending.slice(0, 16) });
    if (!done) {
      say(`ns 内收尾未完成（${pending.join("，")}），将由启动器做外部收尾`);
      return EXIT.DEADLINE;
    }
    return exitCode;
  } finally {
    clearTimeout(hard);
  }
}

// ───────────────────────────── V6: convert / export / import wiring ─────────────────────────────

/**
 * Raw settings entry `secure.vaults.<name>` (V4 port `getVaultEntry`): a deep copy incl. keys the
 * vault object does not carry, or undefined when the file / section / entry is absent. An
 * unreadable or malformed file THROWS (never "absent" — a claim decision must not rest on it).
 */
export function getVaultEntryRaw(name, home = homeDir()) {
  const file = settingsFilePath(home);
  const r = readJsonFile(file);
  if (r.kind === "missing") return undefined;
  if (r.kind === "error") throw new CliError(EXIT.CONFIG, `设置文件无法读取：${r.message}`);
  if (!isPlainObject(r.value)) throw new CliError(EXIT.CONFIG, `${file}：不是 JSON 对象`);
  const sec = r.value.secure;
  if (sec === undefined) return undefined;
  if (!isPlainObject(sec)) throw new CliError(EXIT.CONFIG, `${file}：secure: not an object`);
  if (sec.vaults === undefined) return undefined;
  if (!isPlainObject(sec.vaults)) throw new CliError(EXIT.CONFIG, `${file}：secure.vaults: not an object`);
  return Object.hasOwn(sec.vaults, name) ? structuredClone(sec.vaults[name]) : undefined;
}

/** V4 port `leaseState`: "free" | "held" | "unknown" (a missing / malformed lease file ⇒ unknown). */
export async function leaseStateOf(v) {
  const li = leaseIdentitySync(v);
  if (li.problem) return "unknown";
  return await probeLease(li);
}

/** V4 port `initCipher`: `gocryptfs -init -- <cipher>` with the TTY inherited, NOT -q (master key). */
export async function initCipherOf(v) {
  if (!tty.isatty(1)) {
    err("gocryptfs -init 会在终端打印 master key，stdout 必须是终端（不要重定向到文件/管道）");
    return EXIT.USAGE;
  }
  return await runInherited("gocryptfs", ["-init", "--", v.cipher]);
}

/** V4 port `prompt`: one line from the terminal (interactive time is outside the bounded promise). */
export async function promptLine(question) {
  const readline = await import("node:readline");
  return await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let done = false;
    rl.on("close", () => {
      if (!done) resolve("");
      done = true;
    });
    rl.question(question, (a) => {
      done = true;
      rl.close();
      resolve(a);
    });
  });
}

/** The full port object convert.mjs expects (V4-report §1), assembled from this module. */
export function launcherPorts(home = homeDir()) {
  return {
    ...V0_PORTS,
    getVaultEntry: (name) => getVaultEntryRaw(name, home),
    listVaults: () => {
      const { cfg } = loadSecureConfig(home);
      return cfg.valid ? cfg.vaults : [];
    },
    deriveVault,
    defaultVaultDir,
    defaultVaultMnt,
    physicalPaths,
    createLayout,
    layoutPreflight: (v, o) => layoutPreflightProblems(v, o),
    ensureVaultDirs,
    syncProjectSettings,
    initCipher: initCipherOf,
    probeMountState,
    leaseState: leaseStateOf,
    isTty: () => tty.isatty(0) && tty.isatty(1),
    prompt: promptLine,
    out,
    err,
  };
}

/** The user's cwd (the launcher `cd /`s first and hands it over in PI_SECURE_ORIG_CWD). */
export function origCwdFrom(env, fallback) {
  const v = env.PI_SECURE_ORIG_CWD;
  if (typeof v === "string" && v.startsWith("/") && !v.includes("\0")) return path.resolve(v);
  return fallback;
}

/** `~/x` ⇒ $HOME/x; anything else unchanged (relative paths are resolved by the engines against cwd). */
function expandTilde(p, home) {
  return typeof p === "string" && p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

async function cmdConvertEntry(args, cwd) {
  const C = await import("./convert.mjs");
  const home = homeDir();
  const ctx = C.defaultConvertContext(process.env, { home, cwd, agentDir: piAgentDir(home) });
  return await C.cmdConvert(args, { ports: launcherPorts(home), ctx });
}

async function cmdExportEntry(args, cwd) {
  if (args.length !== 2 || args.some((a) => a.startsWith("-"))) throw new CliError(EXIT.USAGE, usageText());
  const home = homeDir();
  const A = await import("./archive.mjs");
  return await A.cmdExport({ name: args[0], file: expandTilde(args[1], home), home, cwd });
}

async function cmdImportEntry(args, cwd) {
  const home = homeDir();
  const A = await import("./archive.mjs");
  if (args[0] === "--resume" || args[0] === "--abort") {
    if (args.length !== 2 || args[1].startsWith("-")) throw new CliError(EXIT.USAGE, usageText());
    return args[0] === "--resume"
      ? await A.cmdImportResume({ name: args[1], home })
      : await A.cmdImportAbort({ name: args[1], home });
  }
  const pos = [];
  let mnt;
  let verify = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--path" && mnt === undefined && args[i + 1] !== undefined) mnt = args[++i];
    else if (a.startsWith("--path=") && mnt === undefined && a.length > 7) mnt = a.slice(7);
    else if (a === "--verify-password" && !verify) verify = true;
    else if (!a.startsWith("-")) pos.push(a);
    else throw new CliError(EXIT.USAGE, usageText());
  }
  if (pos.length !== 2) throw new CliError(EXIT.USAGE, usageText());
  return await A.cmdImport({
    file: expandTilde(pos[0], home),
    name: pos[1],
    ...(mnt !== undefined ? { path: expandTilde(mnt, home) } : {}),
    ...(verify ? { verifyPassword: true } : {}),
    home,
    cwd,
  });
}

/**
 * V0 helper ports (convert-plan §8.1 V0) — the injectable surface V4 (convert.mjs) and V5
 * (archive.mjs) receive: `unlockVault(v, {postMount:false})`, the claim/patch/remove settings
 * trio, and the pre-existing `finalizeBounded` / `scanCwdOccupants` / `preflight`. Signatures are
 * pinned by tests/secure/helper-v0-api.test.ts and documented in
 * docs/dev/data-encryption/V0-report.md. Frozen object: pass it around, never mutate it.
 */
export const V0_PORTS = Object.freeze({
  unlockVault,
  registerVault,
  patchVaultEntry,
  removeVaultEntry,
  finalizeBounded,
  scanCwdOccupants,
  preflight,
});

export async function main(argv) {
  const [cmd, ...args] = argv;
  try {
    // V6: the user's cwd for relative convert/export/import paths — taken BEFORE the chdir and the
    // hand-over variable is removed so it never reaches gocryptfs, workers or pi.
    let origCwd;
    try {
      origCwd = origCwdFrom(process.env, process.cwd());
    } catch {
      origCwd = origCwdFrom(process.env, undefined);
    }
    delete process.env.PI_SECURE_ORIG_CWD;
    process.chdir("/"); // never pin the vault ourselves; every user path is resolved explicitly
    // V7 review M1: stray / inherited test variables are reported on every user-facing command
    // (internal `__*` entries stay silent: their stderr belongs to the supervising launcher)
    if (typeof cmd === "string" && !cmd.startsWith("__")) for (const l of testSeamWarnings()) err(l);
    switch (cmd) {
      case "init":
        return await (await import("./init.mjs")).cmdInit(args); // lazy: a copy of helper.mjs alone still runs the rest
      case "unlock":
        return await cmdUnlock(args);
      case "lock":
        return await cmdLock(args);
      case "status":
        return await cmdStatus(args);
      case "run":
        return await cmdRun(args);
      // V6 (convert-plan §8.1): the engines run their workers through their OWN module entries
      // (`node convert.mjs __convert-work`, `node tree.mjs`, `node archive.mjs __archive-work`) —
      // helper needs no internal dispatch for them.
      case "convert":
        return await cmdConvertEntry(args, origCwd);
      case "export":
        return await cmdExportEntry(args, origCwd);
      case "import":
        return await cmdImportEntry(args, origCwd);
      case "__mount":
        return await cmdInnerMount(args);
      case "__private-claim":
        return await cmdPrivateClaim(args[0], args[1], args[2], args[3], args[4]);
      case "__private-update":
        return cmdPrivateUpdate(args[0], args[1], args[2]);
      case "__private-release":
        return await cmdPrivateRelease(args[0], args[1]);
      case "__private-abort-start":
        return cmdPrivateAbortStart(args[0], args[1]);
      case "__private-terminate":
        return await cmdPrivateTerminate(args[0], args[1], args[2]);
      case "__ns-root":
        return await cmdNsRoot();
      case "__mount-work":
        return await cmdMountWork();
      case "__register": {
        // internal: executed by registerVault() UNDER the settings flock (V0: + --expect-absent / --pending)
        try {
          const [name, dir, mnt, ...flags] = args;
          if (name === undefined || dir === undefined || mnt === undefined || flags.length > 6)
            throw new Error("内部错误：__register 参数不合法");
          let priv = false;
          let expectAbsent = false;
          let expectEntry;
          let pending;
          for (let i = 0; i < flags.length; i++) {
            const f = flags[i];
            if (f === "--private" && !priv) priv = true;
            else if (f === "--expect-absent" && !expectAbsent) expectAbsent = true;
            else if (f === "--expect-entry" && expectEntry === undefined && flags[i + 1] !== undefined)
              expectEntry = JSON.parse(flags[++i]);
            else if (f === "--pending" && pending === undefined && flags[i + 1] !== undefined) pending = flags[++i];
            else throw new Error(`内部错误：__register 参数不合法（${JSON.stringify(f)}）`);
          }
          if (expectAbsent && expectEntry !== undefined)
            throw new Error("内部错误：expectAbsent 与 expectEntry 不能同用");
          registerVaultUnlocked(name, dir, mnt, undefined, { private: priv, expectAbsent, expectEntry, pending });
        } catch (e) {
          throw new CliError(EXIT.CONFIG, String(e && e.message));
        }
        return EXIT.OK;
      }
      case "__vault-unclaim": {
        // internal: executed by unclaimInitEntry() UNDER the settings flock (init cleanup)
        try {
          if (args.length !== 3) throw new Error("内部错误：__vault-unclaim 参数个数不合法");
          const before = JSON.parse(args[2]);
          out(JSON.stringify(unclaimInitEntryUnlocked(args[0], JSON.parse(args[1]), before ?? undefined)));
        } catch (e) {
          throw new CliError(EXIT.CONFIG, String(e && e.message));
        }
        return EXIT.OK;
      }
      case "__vault-patch":
      case "__vault-remove": {
        // internal: executed by patchVaultEntry()/removeVaultEntry() UNDER the settings flock;
        // prints exactly one JSON result line on stdout (kind ok|missing|mismatch).
        try {
          if (args.length !== (cmd === "__vault-patch" ? 3 : 2)) throw new Error(`内部错误：${cmd} 参数个数不合法`);
          const parsed = args.slice(1).map((a) => JSON.parse(a));
          const result =
            cmd === "__vault-patch"
              ? patchVaultEntryUnlocked(args[0], parsed[0], parsed[1])
              : removeVaultEntryUnlocked(args[0], parsed[0]);
          out(JSON.stringify(result));
        } catch (e) {
          throw new CliError(EXIT.CONFIG, String(e && e.message));
        }
        return EXIT.OK;
      }
      case undefined:
      case "help":
      case "-h":
      case "--help":
        out(usageText());
        return cmd === undefined ? EXIT.USAGE : EXIT.OK;
      default:
        err(`未知命令：${cmd}`);
        err(usageText());
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
