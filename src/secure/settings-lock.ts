/**
 * Settings-file protocol (docs/dev/settings-rename/plan.md r3 §3.3–§4.2): file-name resolution
 * (`pi-toolkit.json` vs legacy `pi-subagent.json`, states S0–S7), location resolution over the agentDir
 * (default / agentDir / inherited), the legacy→new migration (hard link + compat symlink, crash-healing
 * S6a) and the write-time `healSettingsFileLocked`. Mirrored for the launcher in
 * `src/secure/bin/helper.mjs` (parity: tests/secure/settings-file-resolve.test.ts / settings-file-heal.test.ts).
 *
 * Cross-process lock for rewriting the settings file (data-encryption P1 security review #5, the
 * "需 P2 配合" protocol in docs/dev/data-encryption/P1-report.md).
 *
 * Protocol shared with the launcher (`src/secure/bin/helper.mjs` registerVault): an exclusive
 * flock(2) on `<dir of settings>/.pi-subagent.json.lock` (FIXED name, I7: old and new plugin/launcher
 * must contend on the same lock whatever the settings file is called),
 * opened `O_RDONLY|O_CREAT|O_NOFOLLOW` 0600 and fstat-checked to be our own regular file, held over
 * the WHOLE re-read → merge → write tmp → rename. Wait ≤10 s, then give up the write (never fall
 * back to an unlocked write) — except when the `flock` binary does not exist at all: the launcher
 * itself requires `flock`, so without it no concurrent launcher writer can exist and an unlocked
 * (still atomic) write keeps settings persistence working on hosts such as macOS.
 *
 * Node has no flock(2): `flock -x -w 10 3` runs as a synchronous child on OUR descriptor (stdio slot
 * 3). flock locks belong to the open file description, so the lock outlives the child and is held
 * until we close the fd. Everything stays synchronous (callers are synchronous).
 *
 * pi-free; settings.ts imports it (web-hub boundary closure pins the import surface).
 */
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AgentDirInfo } from "../core/agent-dir.js";

export const SETTINGS_LOCK_WAIT_S = 10;
const FLOCK_TIMEOUT_EXIT = 75;

export const SETTINGS_FILE_NAME = "pi-toolkit.json";
export const LEGACY_SETTINGS_FILE_NAME = "pi-subagent.json";
/** I7 runtime old name: never follows the settings file name. */
export const SETTINGS_LOCK_FILE_NAME = ".pi-subagent.json.lock";

export function settingsLockPath(settingsPath: string): string {
  return join(dirname(settingsPath), SETTINGS_LOCK_FILE_NAME);
}

export type SettingsLockOutcome<T> =
  { ok: true; value: T; locked: boolean } | { ok: false; error: string; reason?: "no-flock" | "lock" | "open" };

export interface SettingsLockDeps {
  /** `flock` binary (tests). */
  flockBin?: string;
  waitS?: number;
  /** Refuse to run `fn` when no `flock` binary exists (the migration needs real mutual exclusion). */
  requireLock?: boolean;
}

/**
 * Run `fn` while holding the settings lock. Never throws: lock failures and `fn` throws come back
 * as `{ ok: false }`. `locked:false` only on the documented no-flock-binary exception.
 */
export function withSettingsFileLock<T>(
  settingsPath: string,
  fn: () => T,
  deps: SettingsLockDeps = {},
): SettingsLockOutcome<T> {
  const lockFile = settingsLockPath(settingsPath);
  let fd: number;
  try {
    mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 });
    fd = openSync(
      lockFile,
      constants.O_RDONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
  } catch (error) {
    return { ok: false, error: `设置锁文件 ${lockFile} 无法打开（${errText(error)}）；未写入`, reason: "open" };
  }
  try {
    const st = fstatSync(fd);
    const uid = process.getuid?.();
    if (!st.isFile() || (uid !== undefined && st.uid !== uid))
      return { ok: false, error: `设置锁文件 ${lockFile} 不是本用户的普通文件；未写入`, reason: "open" };
    const waitS = deps.waitS ?? SETTINGS_LOCK_WAIT_S;
    const r = spawnSync(deps.flockBin ?? "flock", ["-x", "-E", String(FLOCK_TIMEOUT_EXIT), "-w", String(waitS), "3"], {
      stdio: ["ignore", "ignore", "pipe", fd],
      timeout: (waitS + 5) * 1000,
    });
    let locked = true;
    if (r.error) {
      if ((r.error as NodeJS.ErrnoException).code !== "ENOENT")
        return { ok: false, error: `无法获取设置文件锁（${errText(r.error)}）；未写入`, reason: "lock" };
      if (deps.requireLock === true)
        return { ok: false, error: "没有 flock 二进制：无法互斥，不执行", reason: "no-flock" };
      locked = false; // no flock binary ⇒ no launcher writer can exist (see header)
    } else if (r.status === FLOCK_TIMEOUT_EXIT) {
      return {
        ok: false,
        error: `设置文件锁 ${lockFile} 等待 ${waitS}s 超时（另一个进程正在改写设置）；未写入`,
        reason: "lock",
      };
    } else if (r.status !== 0) {
      return {
        ok: false,
        error: `无法获取设置文件锁（flock exit ${String(r.status ?? r.signal)}）；未写入`,
        reason: "lock",
      };
    }
    try {
      return { ok: true, value: fn(), locked };
    } catch (error) {
      return { ok: false, error: errText(error) };
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Atomic settings write (tmp + rename) to the file's REAL location: a symlinked settings file keeps
 * its link (the target is replaced); an existing regular file keeps its permission bits minus
 * group/other write; a new file is 0600. Throws on a non-regular target.
 */
export function writeSettingsFileAtomic(settingsPath: string, text: string): void {
  let target = settingsPath;
  let st: Stats | undefined;
  try {
    target = realpathSync(settingsPath);
    st = lstatSync(target);
  } catch {
    st = undefined; // new file
  }
  if (st && !st.isFile()) throw new Error(`${settingsPath} 不是普通文件`);
  const mode = st ? (st.mode & 0o777 & ~0o022) | 0o600 : 0o600;
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { encoding: "utf8", mode, flag: "w" });
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

// ── file-name resolution (plan §3.3) ─────────────────────────────────────────────────────────

export type SettingsFileState =
  | {
      kind: "new";
      path: string;
      newPath: string;
      legacyPath: string;
      /** absent=S4 · compat-link=S5 · same-inode=S6a (crash window, heals) · conflict=S6b */
      legacy: "absent" | "compat-link" | "same-inode" | "conflict";
      legacyNewer?: boolean;
    }
  | {
      kind: "legacy";
      path: string;
      newPath: string;
      legacyPath: string;
      legacyType: "file" | "symlink" | "other";
    }
  | { kind: "none"; path: string; newPath: string; legacyPath: string; compatLinkDangling: boolean };

export type SettingsLocation = SettingsFileState & {
  scope: "default" | "agentDir" | "inherited";
  agent: AgentDirInfo;
};

export interface SettingsFsDeps {
  lstat?: (p: string) => Stats;
  readlink?: (p: string) => string;
  realpath?: (p: string) => string;
}

type EntType = "none" | "file" | "symlink" | "other";
interface Ent {
  type: EntType;
  st?: Stats;
}

function probe(p: string, lstat: (p: string) => Stats): Ent {
  try {
    const st = lstat(p);
    return { type: st.isSymbolicLink() ? "symlink" : st.isFile() ? "file" : "other", st };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { type: "none" } : { type: "other" };
  }
}

function sameInode(a: Ent, b: Ent): boolean {
  return a.st !== undefined && b.st !== undefined && a.st.dev === b.st.dev && a.st.ino === b.st.ino;
}

function tryOr<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Pure read: the S0–S7 table of the plan. Never throws. */
export function resolveSettingsFile(dir: string, deps: SettingsFsDeps = {}): SettingsFileState {
  const lstat = deps.lstat ?? ((p: string) => lstatSync(p));
  const readlink = deps.readlink ?? ((p: string) => readlinkSync(p));
  const realpath = deps.realpath ?? ((p: string) => realpathSync(p));
  const newPath = join(dir, SETTINGS_FILE_NAME);
  const legacyPath = join(dir, LEGACY_SETTINGS_FILE_NAME);
  const n = probe(newPath, lstat);
  const l = probe(legacyPath, lstat);
  const isCompatLink = (): boolean => {
    const target = tryOr(() => readlink(legacyPath));
    if (target === SETTINGS_FILE_NAME || target === newPath) return true;
    const rl = tryOr(() => realpath(legacyPath));
    const rn = tryOr(() => realpath(newPath));
    return rl !== undefined && rn !== undefined && rl === rn;
  };
  if (n.type !== "none") {
    let legacy: "absent" | "compat-link" | "same-inode" | "conflict";
    if (l.type === "none") legacy = "absent";
    else if (l.type === "symlink") legacy = isCompatLink() ? "compat-link" : "conflict";
    else if (l.type === "file" && n.type === "file" && sameInode(n, l)) legacy = "same-inode";
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
    const target = tryOr(() => readlink(legacyPath));
    if (target === SETTINGS_FILE_NAME || target === newPath)
      return { kind: "none", path: newPath, newPath, legacyPath, compatLinkDangling: true };
    return { kind: "legacy", path: legacyPath, newPath, legacyPath, legacyType: "symlink" };
  }
  return { kind: "legacy", path: legacyPath, newPath, legacyPath, legacyType: l.type === "file" ? "file" : "other" };
}

/** Directory level (two tiers) over the file-name level; the agentDir inheritance rule (拍板④). */
export function resolveSettingsLocation(agent: AgentDirInfo, deps: SettingsFsDeps = {}): SettingsLocation {
  const primary = resolveSettingsFile(agent.dir, deps);
  if (agent.source === "default") return { ...primary, scope: "default", agent };
  if (primary.kind !== "none" || primary.compatLinkDangling) return { ...primary, scope: "agentDir", agent };
  const home = resolveSettingsFile(agent.home, deps);
  if (home.kind !== "none") return { ...home, scope: "inherited", agent };
  return { ...primary, scope: "agentDir", agent };
}

// ── migration + write-time self-heal (plan §3.4 / §3.4.1) ────────────────────────────────────

export type SettingsMigrationOutcome =
  | { kind: "noop" }
  | { kind: "migrated"; from: string; to: string; healed: boolean }
  | { kind: "conflict"; newPath: string; legacyPath: string; legacyNewer: boolean }
  | {
      kind: "skipped";
      reason:
        | "no-flock"
        | "lock"
        | "not-regular"
        | "foreign-owner"
        | "secure-txn"
        | "link-unsupported"
        | "symlink-unsupported"
        | "io";
      detail: string;
    };

export interface SettingsMigrationDeps extends SettingsFsDeps, SettingsLockDeps {
  link?: (existing: string, created: string) => void;
  symlink?: (target: string, path: string) => void;
  /** Test seam between the hard link (step c) and the compat-symlink steps (e–g). */
  afterLink?: () => void;
}

const LNK_RE = /^pi-subagent\.json\.[0-9a-f]{16}\.lnk$/;
const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "ENOSYS", "EXDEV"]);

/** 16 hex chars from pid + clock; only the lock holder ever creates these. */
function lnkSuffix(): string {
  return `${process.pid.toString(16)}${Date.now().toString(16)}`.padStart(16, "0").slice(-16);
}

function cleanupLnk(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!LNK_RE.test(name)) continue;
    const full = join(dir, name);
    try {
      if (lstatSync(full).isSymbolicLink()) unlinkSync(full);
    } catch {
      /* best effort */
    }
  }
}

type HealResult = "healed" | "reverted-to-legacy" | "noop" | "conflict";

/** Steps 0 + e–g. `force` skips the S6a precondition (the caller just created the hard link). */
function healCore(dir: string, deps: SettingsMigrationDeps, force: boolean): { result: HealResult; detail: string } {
  const lstat = deps.lstat ?? ((p: string) => lstatSync(p));
  const st = resolveSettingsFile(dir, deps);
  const isS6a = st.kind === "new" && st.legacy === "same-inode";
  if (!force && !isS6a) return { result: "noop", detail: "" };
  cleanupLnk(dir);
  const newPath = join(dir, SETTINGS_FILE_NAME);
  const legacyPath = join(dir, LEGACY_SETTINGS_FILE_NAME);
  const lnk = join(dir, `pi-subagent.json.${lnkSuffix()}.lnk`);
  try {
    (deps.symlink ?? ((t: string, p: string) => symlinkSync(t, p)))(SETTINGS_FILE_NAME, lnk);
  } catch (error) {
    // Cannot build the compat link: step back to S1 (only while both names are still ONE inode).
    if (sameInode(probe(newPath, lstat), probe(legacyPath, lstat))) {
      try {
        unlinkSync(newPath);
      } catch {
        return { result: "noop", detail: errText(error) };
      }
      return { result: "reverted-to-legacy", detail: errText(error) };
    }
    return { result: "conflict", detail: errText(error) };
  }
  const n = probe(newPath, lstat);
  const l = probe(legacyPath, lstat);
  if (!(n.type === "file" && l.type === "file" && sameInode(n, l))) {
    tryOr(() => unlinkSync(lnk));
    return { result: "conflict", detail: "旧名在迁移期间被替换" };
  }
  try {
    renameSync(lnk, legacyPath);
  } catch (error) {
    tryOr(() => unlinkSync(lnk));
    return { result: "noop", detail: errText(error) };
  }
  return { result: "healed", detail: "" };
}

/**
 * LOCK-HELD ONLY. Completes a crash-window S6a (two names, one inode) into S5; every other state is a
 * no-op. Never throws. Every new-version writer calls this inside the settings lock before it resolves
 * its target (plan §3.4.1), so a writer can never turn S6a into the permanent conflict S6b.
 */
export function healSettingsFileLocked(dir: string, deps: SettingsMigrationDeps = {}): HealResult {
  try {
    return healCore(dir, deps, false).result;
  } catch {
    return "noop";
  }
}

function conflictOutcome(st: Extract<SettingsFileState, { kind: "new" }>): SettingsMigrationOutcome {
  return { kind: "conflict", newPath: st.newPath, legacyPath: st.legacyPath, legacyNewer: st.legacyNewer === true };
}

function hasSecureTxn(text: string): boolean {
  try {
    const root = JSON.parse(text) as { secure?: { vaults?: unknown } } | null;
    const vaults = root?.secure?.vaults;
    if (vaults === null || typeof vaults !== "object" || Array.isArray(vaults)) return false;
    return Object.values(vaults as Record<string, unknown>).some(
      (v) => v !== null && typeof v === "object" && ("pending" in v || "relocate" in v),
    );
  } catch {
    return false;
  }
}

/**
 * The legacy → new rename of the settings file: `link(LEGACY, NEW)` (zero copy, never overwrites) then a
 * compat symlink swapped over LEGACY. Main session only (see prepareSettingsFile). Never throws; a failed
 * migration just means the legacy name keeps being used.
 */
export function migrateLegacySettingsFile(dir: string, deps: SettingsMigrationDeps = {}): SettingsMigrationOutcome {
  const first = resolveSettingsFile(dir, deps);
  if (first.kind === "new" && first.legacy === "conflict") return conflictOutcome(first);
  const isS1 = first.kind === "legacy" && first.legacyType === "file";
  const isS6a = first.kind === "new" && first.legacy === "same-inode";
  if (!isS1 && !isS6a) return { kind: "noop" };
  const legacyPath = join(dir, LEGACY_SETTINGS_FILE_NAME);
  const newPath = join(dir, SETTINGS_FILE_NAME);
  const lstat = deps.lstat ?? ((p: string) => lstatSync(p));
  const locked = withSettingsFileLock<SettingsMigrationOutcome>(
    legacyPath,
    () => {
      try {
        cleanupLnk(dir);
        const st = resolveSettingsFile(dir, deps);
        if (st.kind === "new" && st.legacy === "conflict") return conflictOutcome(st);
        let fresh = false;
        if (st.kind === "legacy" && st.legacyType === "file") {
          const ent = probe(legacyPath, lstat);
          if (ent.type !== "file" || ent.st === undefined)
            return { kind: "skipped", reason: "not-regular", detail: legacyPath };
          const uid = process.getuid?.();
          if (uid !== undefined && ent.st.uid !== uid)
            return { kind: "skipped", reason: "foreign-owner", detail: legacyPath };
          const text = tryOr(() => readFileSync(legacyPath, "utf8"));
          if (text !== undefined && hasSecureTxn(text))
            return { kind: "skipped", reason: "secure-txn", detail: "secure.vaults 事务进行中" };
          try {
            (deps.link ?? ((a: string, b: string) => linkSync(a, b)))(legacyPath, newPath);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code ?? "";
            if (code === "EEXIST") return { kind: "conflict", newPath, legacyPath, legacyNewer: false };
            if (LINK_UNSUPPORTED.has(code)) return { kind: "skipped", reason: "link-unsupported", detail: code };
            return { kind: "skipped", reason: "io", detail: errText(error) };
          }
          fresh = true;
          deps.afterLink?.();
        } else if (!(st.kind === "new" && st.legacy === "same-inode")) return { kind: "noop" };
        const healed = healCore(dir, deps, fresh);
        if (healed.result === "healed") return { kind: "migrated", from: legacyPath, to: newPath, healed: !fresh };
        if (healed.result === "reverted-to-legacy")
          return { kind: "skipped", reason: "symlink-unsupported", detail: healed.detail };
        if (healed.result === "conflict") {
          const now = resolveSettingsFile(dir, deps);
          return now.kind === "new"
            ? conflictOutcome(now)
            : { kind: "conflict", newPath, legacyPath, legacyNewer: false };
        }
        return { kind: "skipped", reason: "io", detail: healed.detail };
      } catch (error) {
        return { kind: "skipped", reason: "io", detail: errText(error) };
      }
    },
    { ...deps, requireLock: true },
  );
  if (locked.ok) return locked.value;
  return { kind: "skipped", reason: locked.reason === "no-flock" ? "no-flock" : "lock", detail: locked.error };
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
