/**
 * Encrypted-session (gocryptfs vault) configuration contract — pure, pi-free
 * (data-encryption plan r4 §2.2–§2.4 + private-plan §L; P1↔P2 env/config contract agreed 2026-10-23).
 *
 * The launcher (`src/secure/bin/helper.mjs`, P1) re-implements exactly the same
 * rules in plain JS; the two never import each other. Parity is enforced by the
 * shared fixture `tests/fixtures/secure-contract-parity.json`, run against both.
 *
 * Contract (settings file `pi-subagent.json`, key `secure`):
 *   { "secure": { "enabled"?: boolean (default true),
 *                 "vaults": { "<name>": { "dir"?: "<abs|~/…>", "mnt"?: "<abs|~/…>" } } } }
 * - name: /^[a-z0-9][a-z0-9_-]{0,31}$/
 * - dir default `~/.local/share/pi-toolkit-secure/<name>`, mnt default `~/secure/<name>`
 * - a path must be absolute or start with `~/`; otherwise that vault is invalid
 * - LEGACY entries (private-plan §L.3, read-only compat): an entry that carries a `link` key, or
 *   one without `mnt` whose `<dir>/mnt` is a directory on disk, parses with the OLD derivations
 *   (mnt = <dir>/mnt) and a `layout: "legacy"` marker. The `link` value itself is ignored.
 * - `secure` not an object, or `vaults` present but not an object ⇒ whole section invalid
 *   (no vaults). `vaults` absent ⇒ valid, no vaults.
 * - `enabled` non-boolean ⇒ default (true).
 * - derived (new layout): mnt=<mnt>, work=<mnt>/work, state=<mnt>/state,
 *   sessionDir=<state>/sessions/default, cipher=<dir>/cipher, lock=<dir>/mount.lock,
 *   lease=<dir>/mount.lease
 *
 * Mount state (from `/proc/self/mountinfo` text): the LAST line whose mount point
 * (octal-escape decoded) equals realpath(mnt) decides — it must be
 * `fuse.gocryptfs` with source == realpath(cipher).
 *
 * Imports only `node:path` (web-hub boundary closure pins this) — the legacy-layout disk probe
 * is INJECTED as `io.legacyMntDir` (callers with fs access pass a real lstat probe).
 */
import { join, resolve, sep } from "node:path";

export const SECURE_VAULT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const SECURE_DEFAULT_DIR_PARENT = [".local", "share", "pi-toolkit-secure"] as const;
export const SECURE_DEFAULT_MNT_PARENT = "secure";
export const GOCRYPTFS_FSTYPE = "fuse.gocryptfs";

/** A vault parsed from settings, with every derived path (private-plan §L.1). */
export interface SecureVault {
  readonly name: string;
  /** Plain-text metadata dir (cipher/, mount.lock, mount.lease, …). */
  readonly dir: string;
  /** Mount point (`~/secure/<name>` by default). For legacy vaults: `<dir>/mnt`. */
  readonly mnt: string;
  readonly cipher: string;
  readonly work: string;
  readonly state: string;
  readonly sessionDir: string;
  readonly lock: string;
  /** Mount lease file (created empty by L0's init; N1 holds it for every mount). */
  readonly lease: string;
  /** Present ONLY on entries parsed with the pre-L0 layout (read-only compat, §L.3). */
  readonly layout?: "legacy";
  /**
   * Present ONLY on legacy vaults (security review L0 #3): the pre-L0 ENTRY symlink address
   * (`link` from the settings entry when it expands, else the old default `~/secure/<name>`).
   * Kept so D4's known-address set (vaultSpellings / vaultOfPath) still covers the old entry
   * path a plain session's bash command could name — legacy vaults mounted by an older helper
   * stay reachable through it.
   */
  readonly legacyLink?: string;
}

export interface SecureInvalidVault {
  readonly name: string;
  readonly reason: "name" | "entry" | "dir" | "mnt";
}

/** Disk probe used ONLY to recognize legacy entries without an explicit `mnt` (§L.3). */
export interface SecureConfigIo {
  /** True when `<dir>/mnt` is a directory on disk (best-effort; false on any error). */
  legacyMntDir?(mnt: string): boolean;
}

export interface SecureConfig {
  /** The settings object carried a `secure` key at all. */
  readonly present: boolean;
  /** `secure.enabled` (default true). */
  readonly enabled: boolean;
  /** False when `secure` (or `secure.vaults`) has the wrong shape — then `vaults` is empty. */
  readonly valid: boolean;
  /** Valid vaults, sorted by name. */
  readonly vaults: readonly SecureVault[];
  /** Rejected entries, sorted by name. */
  readonly invalid: readonly SecureInvalidVault[];
  readonly error?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** `~/x` ⇒ resolve(home, x); absolute ⇒ resolve(p); anything else (incl. "~", "~user", relative, "") ⇒ undefined. */
export function expandSecurePath(raw: unknown, home: string): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  if (raw.startsWith("~/")) return resolve(home, raw.slice(2));
  if (raw.startsWith("/")) return resolve(raw);
  return undefined;
}

/** New layout (private-plan §L.1): the mount point IS `<mnt>` — no entry symlink. */
export function deriveVault(name: string, dir: string, mnt: string): SecureVault {
  const state = join(mnt, "state");
  return {
    name,
    dir,
    mnt,
    cipher: join(dir, "cipher"),
    work: join(mnt, "work"),
    state,
    sessionDir: join(state, "sessions", "default"),
    lock: join(dir, "mount.lock"),
    lease: join(dir, "mount.lease"),
  };
}

/** Pre-L0 layout (§L.3, read-only compat): mount point `<dir>/mnt`, derived exactly as before.
 *  `legacyLink` keeps the old entry address (review L0 #3): the expanded `link` value when valid,
 *  else the old default — it feeds D4's known-address set, never any launcher path logic. */
export function deriveLegacyVault(name: string, dir: string, legacyLink: string): SecureVault {
  const mnt = join(dir, "mnt");
  const state = join(mnt, "state");
  return {
    name,
    dir,
    mnt,
    cipher: join(dir, "cipher"),
    work: join(mnt, "work"),
    state,
    sessionDir: join(state, "sessions", "default"),
    lock: join(dir, "mount.lock"),
    lease: join(dir, "mount.lease"),
    layout: "legacy",
    legacyLink,
  };
}

/** True when the vault was parsed with the pre-L0 layout (§L.3 read-only compat). */
export function isLegacyVault(v: SecureVault): boolean {
  return v.layout === "legacy";
}

const EMPTY: readonly never[] = Object.freeze([]);

/** Parse the WHOLE settings-file object (not just the `secure` value). Never throws. */
export function parseSecureConfig(settings: unknown, home: string, io?: SecureConfigIo): SecureConfig {
  if (!isPlainObject(settings) || !("secure" in settings) || settings.secure === undefined)
    return { present: false, enabled: true, valid: true, vaults: EMPTY, invalid: EMPTY };
  const section = settings.secure;
  if (!isPlainObject(section))
    return {
      present: true,
      enabled: true,
      valid: false,
      vaults: EMPTY,
      invalid: EMPTY,
      error: "secure: not an object",
    };
  const enabled = typeof section.enabled === "boolean" ? section.enabled : true;
  const rawVaults = section.vaults;
  if (rawVaults === undefined) return { present: true, enabled, valid: true, vaults: EMPTY, invalid: EMPTY };
  if (!isPlainObject(rawVaults))
    return {
      present: true,
      enabled,
      valid: false,
      vaults: EMPTY,
      invalid: EMPTY,
      error: "secure.vaults: not an object",
    };
  const vaults: SecureVault[] = [];
  const invalid: SecureInvalidVault[] = [];
  for (const name of Object.keys(rawVaults).sort()) {
    const entry = rawVaults[name];
    if (!SECURE_VAULT_NAME_RE.test(name)) {
      invalid.push({ name, reason: "name" });
      continue;
    }
    if (!isPlainObject(entry)) {
      invalid.push({ name, reason: "entry" });
      continue;
    }
    const dir =
      entry.dir === undefined ? join(home, ...SECURE_DEFAULT_DIR_PARENT, name) : expandSecurePath(entry.dir, home);
    if (dir === undefined) {
      invalid.push({ name, reason: "dir" });
      continue;
    }
    const oldDefaultLink = join(home, SECURE_DEFAULT_MNT_PARENT, name);
    // Legacy recognition (§L.3): a `link` key always means the pre-L0 layout; an entry without
    // `mnt` whose `<dir>/mnt` exists as a directory on disk does too (probed via `io`). The link
    // VALUE is not validated as a vault — it only feeds D4's known-address set (review L0 #3).
    if (entry.link !== undefined) {
      vaults.push(deriveLegacyVault(name, dir, expandSecurePath(entry.link, home) ?? oldDefaultLink));
      continue;
    }
    const mntExplicit = entry.mnt !== undefined;
    const mnt = mntExplicit ? expandSecurePath(entry.mnt, home) : join(home, SECURE_DEFAULT_MNT_PARENT, name);
    if (mnt === undefined) {
      invalid.push({ name, reason: "mnt" });
      continue;
    }
    if (!mntExplicit && io?.legacyMntDir?.(join(dir, "mnt")) === true) {
      vaults.push(deriveLegacyVault(name, dir, oldDefaultLink));
      continue;
    }
    vaults.push(deriveVault(name, dir, mnt));
  }
  return { present: true, enabled, valid: true, vaults, invalid };
}

/** Decode mountinfo's octal escapes (`\040` space, `\011` tab, `\012` newline, `\134` backslash, any `\ooo`). */
export function decodeMountinfoField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

export interface MountinfoEntry {
  readonly mountPoint: string;
  readonly fsType: string;
  readonly source: string;
}

/** Parse `/proc/<pid>/mountinfo` text; malformed lines are skipped. */
export function parseMountinfo(text: string): MountinfoEntry[] {
  const out: MountinfoEntry[] = [];
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

export type SecureMountState = "mounted" | "absent" | "foreign";

/**
 * Mount verdict for one vault. `realMnt` / `realCipher` must already be realpath'd by the caller
 * (this function is pure). The LAST mountinfo line at `realMnt` decides (stacked mounts: the top
 * one is what a path lookup sees).
 */
export function vaultMountState(mountinfo: string, realMnt: string, realCipher: string): SecureMountState {
  let last: MountinfoEntry | undefined;
  for (const e of parseMountinfo(mountinfo)) if (e.mountPoint === realMnt) last = e;
  if (!last) return "absent";
  return last.fsType === GOCRYPTFS_FSTYPE && last.source === realCipher ? "mounted" : "foreign";
}

/** True when `p` equals `root` or lies below it (both already normalized/absolute). */
export function pathWithin(p: string, root: string): boolean {
  if (p === root) return true;
  const base = root.endsWith(sep) ? root : root + sep;
  return p.startsWith(base);
}
