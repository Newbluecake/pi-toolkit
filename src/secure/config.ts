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
 * - transaction keys (convert-plan §4, V6): `pending` ("<op>:<txid>"), `origin` / `backup` (abs|~/),
 *   `relocate` ({from, to, txid, phase}) surface on the vault ONLY when present and valid; malformed
 *   ones are listed in `txnInvalid` (the vault is KEPT and judged locked — fail closed), each key
 *   validated independently.
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
  /** private-plan §1.1: `secure.vaults.<name>.private === true` (present ONLY when true; new layout only). */
  readonly private?: true;
  /**
   * convert-plan §4 (V6) transaction keys — each present ONLY when the entry carries it.
   * `pending`: a convert/import is in progress or interrupted (`<op>:<txid>`) ⇒ the domain judges
   * the vault locked. `origin`: the plain path a convert turned into a symlink to `<mnt>/work`
   * (feeds D4's bash spellings). `backup`: the read-only backup a convert left behind.
   * `relocate`: an import's unfinished path relocation (⇒ locked as well).
   */
  readonly pending?: string;
  readonly origin?: string;
  readonly backup?: string;
  readonly relocate?: SecureRelocate;
  /**
   * Security review V6 #1 (fail closed): present ONLY when one or more transaction keys are
   * malformed — their names, in the fixed order pending/origin/backup/relocate. The vault is kept
   * (path guards and write redirection still cover it) and judged LOCKED; a human must fix the
   * entry. The VALID keys are still carried individually.
   */
  readonly txnInvalid?: readonly SecureTxnKey[];
}

/** The four convert/import transaction keys of a vault entry (convert-plan §4). */
export type SecureTxnKey = "pending" | "origin" | "backup" | "relocate";

/** convert-plan §3.4 relocation marker (`secure.vaults.<name>.relocate`). */
export interface SecureRelocate {
  readonly from: string;
  readonly to: string;
  readonly txid: string;
  readonly phase: string;
}

export interface SecureInvalidVault {
  readonly name: string;
  readonly reason: "name" | "entry" | "dir" | "mnt" | "private";
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

/** V0 writer contract for `pending` (helper.mjs PENDING_RE): `<op>:<txid>`. */
export const SECURE_PENDING_RE = /^[a-z][a-z0-9]{0,15}:[!-~]{1,64}$/;

type TxnKeys = Pick<SecureVault, "pending" | "origin" | "backup" | "relocate" | "txnInvalid">;

const isAbsLiteral = (x: unknown): x is string =>
  typeof x === "string" && x.length <= 4096 && x.startsWith("/") && !x.includes("\0");

/**
 * convert-plan §4 / §8.2 (V6): the transaction keys of one entry, each validated INDEPENDENTLY
 * (security review V6 #1: one malformed key never drops the others). → the VALID present keys
 * (normalized) plus `txnInvalid` (malformed key names, fixed order) when any is malformed. The entry
 * is never dropped for these keys — it stays a vault and `txnInvalid` makes the domain LOCKED.
 * Accepts at least everything helper.mjs's V0 writers store. Parity twin of helper.mjs `parseTxnKeys`.
 */
function parseTxnKeys(entry: Record<string, unknown>, home: string): TxnKeys {
  const keys: { -readonly [K in keyof TxnKeys]: TxnKeys[K] } = {};
  const bad: SecureTxnKey[] = [];
  if (entry.pending !== undefined) {
    if (typeof entry.pending === "string" && SECURE_PENDING_RE.test(entry.pending)) keys.pending = entry.pending;
    else bad.push("pending");
  }
  for (const k of ["origin", "backup"] as const) {
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
      keys.relocate = { from: resolve(r.from), to: resolve(r.to), txid: r.txid, phase: r.phase };
    else bad.push("relocate");
  }
  if (bad.length) keys.txnInvalid = bad;
  return keys;
}

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
    // private-plan §1.1: `private` must be a boolean when present; only `true` surfaces.
    if (entry.private !== undefined && typeof entry.private !== "boolean") {
      invalid.push({ name, reason: "private" });
      continue;
    }
    // convert-plan §4 (V6): transaction keys (absent ⇒ no key on the vault object; malformed ⇒
    // the vault stays and carries `txnInvalid` ⇒ locked — never dropped, review V6 #1).
    const txn = { keys: parseTxnKeys(entry, home) };
    const oldDefaultLink = join(home, SECURE_DEFAULT_MNT_PARENT, name);
    // Legacy recognition (§L.3): a `link` key always means the pre-L0 layout; an entry without
    // `mnt` whose `<dir>/mnt` exists as a directory on disk does too (probed via `io`). The link
    // VALUE is not validated as a vault — it only feeds D4's known-address set (review L0 #3).
    if (entry.link !== undefined) {
      vaults.push({
        ...deriveLegacyVault(name, dir, expandSecurePath(entry.link, home) ?? oldDefaultLink),
        ...txn.keys,
      });
      continue;
    }
    const mntExplicit = entry.mnt !== undefined;
    const mnt = mntExplicit ? expandSecurePath(entry.mnt, home) : join(home, SECURE_DEFAULT_MNT_PARENT, name);
    if (mnt === undefined) {
      invalid.push({ name, reason: "mnt" });
      continue;
    }
    if (!mntExplicit && io?.legacyMntDir?.(join(dir, "mnt")) === true) {
      vaults.push({ ...deriveLegacyVault(name, dir, oldDefaultLink), ...txn.keys });
      continue;
    }
    vaults.push({
      ...deriveVault(name, dir, mnt),
      ...(entry.private === true ? { private: true as const } : {}),
      ...txn.keys,
    });
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

// ───────────────────────────── private instance record (private-plan r3 §3.2) ─────────────────────────────

/** Phases of a `--private` instance record (§3.2). */
export const PRIVATE_PHASES = ["starting", "mounting", "launching", "setup", "session", "finalizing"] as const;
export type PrivatePhase = (typeof PRIVATE_PHASES)[number];
/** `<dir>/private.json` is at most this many UTF-8 bytes (larger ⇒ corrupt, fail closed). */
export const PRIVATE_RECORD_MAX_BYTES = 4096;

/** A process identity (pid + /proc starttime in clock ticks) — no pid namespace, global pids. */
export interface PrivateIdentity {
  readonly pid: number;
  readonly start: number;
}

/** The validated `<dir>/private.json` (v3). Unknown keys are dropped by the parser. */
export interface PrivateRecord {
  readonly v: 3;
  readonly instanceId: string;
  readonly name: string;
  readonly phase: PrivatePhase;
  readonly mode?: "run" | "setup";
  readonly bootId: string;
  readonly createdAt: string;
  readonly realCipher: string;
  readonly realMnt: string;
  /** `mount.lease` identity: dev as decimal `maj:min`, inode number. */
  readonly lease: { readonly dev: string; readonly ino: number };
  readonly owner: PrivateIdentity;
  readonly supervisor?: PrivateIdentity;
  readonly gocryptfs?: PrivateIdentity;
  readonly pi?: PrivateIdentity;
  readonly piExit?: { readonly code: number };
  /** Exit code recorded by the supervisor when the instance failed before pi ran (1/69/75/77/78). */
  readonly failCode?: number;
  readonly inNsDone?: boolean;
  readonly inNsPending?: readonly string[];
  readonly ns?: { readonly mnt: string; readonly user: string; readonly innerUser?: string };
  readonly lazyDetachedAt?: string;
}

export type PrivateRecordParse =
  { readonly kind: "ok"; readonly record: PrivateRecord } | { readonly kind: "corrupt"; readonly reason: string };

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

const HEX32_RE = /^[0-9a-f]{32}$/;
const MAJMIN_RE = /^\d{1,10}:\d{1,10}$/;
const NS_MNT_RE = /^mnt:\[\d{1,20}\]$/;
const NS_USER_RE = /^user:\[\d{1,20}\]$/;

function isIdentity(v: unknown): v is PrivateIdentity {
  return (
    isPlainObject(v) &&
    Number.isSafeInteger(v.pid) &&
    (v.pid as number) >= 2 &&
    Number.isSafeInteger(v.start) &&
    (v.start as number) >= 0
  );
}
const isExitCode = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 255;
const isShortString = (v: unknown, max = 256): v is string => typeof v === "string" && v !== "" && v.length <= max;
const isAbsPath = (v: unknown): v is string => isShortString(v, 4096) && v.startsWith("/") && !v.includes("\0");

/**
 * Parse `<dir>/private.json` text (the caller has already lstat'ed it as an own regular file).
 * Strict on every known key, drops unknown keys, never throws. Same rules as the launcher's
 * `parsePrivateRecord` (helper.mjs) — pinned by the parity fixture's `privateRecord` cases.
 */
export function parsePrivateRecord(text: unknown): PrivateRecordParse {
  if (typeof text !== "string") return { kind: "corrupt", reason: "type" };
  if (utf8Length(text) > PRIVATE_RECORD_MAX_BYTES) return { kind: "corrupt", reason: "size" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "corrupt", reason: "json" };
  }
  if (!isPlainObject(raw)) return { kind: "corrupt", reason: "shape" };
  const bad = (field: string): PrivateRecordParse => ({ kind: "corrupt", reason: `field:${field}` });
  if (raw.v !== 3) return bad("v");
  if (typeof raw.instanceId !== "string" || !HEX32_RE.test(raw.instanceId)) return bad("instanceId");
  if (typeof raw.name !== "string" || !SECURE_VAULT_NAME_RE.test(raw.name)) return bad("name");
  if (typeof raw.phase !== "string" || !(PRIVATE_PHASES as readonly string[]).includes(raw.phase)) return bad("phase");
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
    (lease.ino as number) < 1
  )
    return bad("lease");
  if (!isIdentity(raw.owner)) return bad("owner");
  for (const k of ["supervisor", "gocryptfs", "pi"] as const)
    if (raw[k] !== undefined && !isIdentity(raw[k])) return bad(k);
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
  const id = (x: unknown): PrivateIdentity => {
    const o = x as PrivateIdentity;
    return { pid: o.pid, start: o.start };
  };
  const leaseOk = lease as { dev: string; ino: number };
  const nsOk = ns as { mnt: string; user: string; innerUser?: string } | undefined;
  const record: PrivateRecord = {
    v: 3,
    instanceId: raw.instanceId,
    name: raw.name,
    phase: raw.phase as PrivatePhase,
    ...(raw.mode !== undefined ? { mode: raw.mode } : {}),
    bootId: raw.bootId,
    createdAt: raw.createdAt,
    realCipher: raw.realCipher,
    realMnt: raw.realMnt,
    lease: { dev: leaseOk.dev, ino: leaseOk.ino },
    owner: id(raw.owner),
    ...(raw.supervisor !== undefined ? { supervisor: id(raw.supervisor) } : {}),
    ...(raw.gocryptfs !== undefined ? { gocryptfs: id(raw.gocryptfs) } : {}),
    ...(raw.pi !== undefined ? { pi: id(raw.pi) } : {}),
    ...(raw.piExit !== undefined ? { piExit: { code: (raw.piExit as { code: number }).code } } : {}),
    ...(raw.failCode !== undefined ? { failCode: raw.failCode } : {}),
    ...(raw.inNsDone !== undefined ? { inNsDone: raw.inNsDone } : {}),
    ...(raw.inNsPending !== undefined ? { inNsPending: [...(raw.inNsPending as string[])] } : {}),
    ...(nsOk !== undefined
      ? {
          ns: {
            mnt: nsOk.mnt,
            user: nsOk.user,
            ...(nsOk.innerUser !== undefined ? { innerUser: nsOk.innerUser } : {}),
          },
        }
      : {}),
    ...(raw.lazyDetachedAt !== undefined ? { lazyDetachedAt: raw.lazyDetachedAt } : {}),
  };
  return { kind: "ok", record };
}
