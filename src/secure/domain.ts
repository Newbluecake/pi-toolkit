/**
 * Encrypted-session domain judgment (data-encryption plan r4 §2.4 step 1).
 *
 * `initSecureDomain()` runs as the FIRST statement of `activate()`, before any settings read:
 *   vault = env PI_SECURE_VAULT ?? matchVault(realpath(process.cwd()))
 *   - hit ∧ mounted ⇒ { kind: "secure" } + env redirection (TMPDIR / ARMORY_MEMORY_ROOT / PI_SECURE_*)
 *   - hit ∧ not mounted, or PI_SECURE_VAULT invalid ⇒ { kind: "locked" }
 *   - miss ⇒ { kind: "plain" }
 * The verdict is frozen per PROCESS on `Symbol.for("pi-subagent:secure-domain")` (child sessions
 * activate in the same process and read it; /reload keeps it). No module-scope mutable state.
 *
 * pi-free (imports only node:* and ./config.js, ./env.js): `src/config/settings.ts` imports it
 * for the settings override and the web-hub boundary closure pins that surface. The hub process
 * never calls `initSecureDomain`, so it always sees `undefined` (= plain, no override).
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  parsePrivateRecord,
  parseSecureConfig,
  pathWithin,
  PRIVATE_RECORD_MAX_BYTES,
  vaultMountState,
  type PrivateRecord,
  type SecureConfig,
  type SecureConfigIo,
  type SecureVault,
} from "./config.js";
import { resolveAgentDir } from "../core/agent-dir.js";
import { PI_SECURE_NS, PI_SECURE_ORIG_ENV, PI_SECURE_SESSION, PI_SECURE_VAULT, origEnvSnapshot } from "./env.js";
import { resolveSettingsLocation, type SettingsLocation } from "./settings-lock.js";

export const SECURE_DOMAIN_KEY = Symbol.for("pi-subagent:secure-domain");

/** A configured vault with its canonical roots (computed once, at judgment time). */
export interface SecureVaultRoots {
  readonly vault: SecureVault;
  /** realpath(vault.dir) — or the resolved literal when it does not exist. */
  readonly root: string;
  /**
   * The PHYSICAL mount point (private-plan §L.1): `join(realpath(dirname(mnt)), basename(mnt))` —
   * never a realpath of the mount point itself (that would traverse/hang on a live or ENOTCONN
   * mount). Legacy vaults keep the old derivation: `join(root, "mnt")` (§L.3).
   */
  readonly mntReal: string;
  /**
   * convert-plan §4 (V6): present ONLY when the entry carries `origin` — the origin's PHYSICAL
   * spelling `join(realpath(dirname(origin)), basename(origin))` (the origin itself is a symlink
   * into the vault: never followed here). Feeds D4's bash spellings; frozen with the verdict.
   */
  readonly originReal?: string;
}

/**
 * "This process lives inside a private mount namespace" (private-plan §2.9). Evidence-based:
 * `/proc/self/ns/mnt` equals a registered vault's `private.json` v3 record `ns.mnt` (same boot);
 * `PI_SECURE_NS=1` is an additional hint that only ever makes the verdict MORE conservative.
 * Judged with the domain verdict, independent of its kind — a plain-domain cwd inside the ns
 * hits just the same. `vault` names the matched vault (hint-only verdicts name the env vault
 * when it is registered, else carry none).
 */
export interface PrivateNsInfo {
  readonly via: "record" | "hint";
  readonly vault?: SecureVaultRoots;
}

export type SecureDomain =
  | {
      readonly kind: "plain";
      readonly vaults: readonly SecureVaultRoots[];
      readonly config: SecureConfig;
      /** private-plan §2.9: present ONLY inside a private mount ns (never `undefined`-valued). */
      readonly ns?: PrivateNsInfo;
    }
  | {
      readonly kind: "secure";
      readonly vault: SecureVaultRoots;
      readonly vaults: readonly SecureVaultRoots[];
      readonly config: SecureConfig;
      /** How the vault was selected. */
      readonly via: "env" | "cwd";
      readonly ns?: PrivateNsInfo;
    }
  | {
      readonly kind: "locked";
      readonly reason: string;
      readonly vaultName?: string;
      readonly vaults: readonly SecureVaultRoots[];
      readonly config: SecureConfig;
      readonly ns?: PrivateNsInfo;
    };

export interface SecureDomainDeps {
  /** Env read for PI_SECURE_VAULT and MUTATED on entering secure (default `process.env`). */
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Settings file to read the raw `secure` section from (default: resolved via the agentDir + settings-file protocol, `~/.pi/agent/pi-toolkit.json` / legacy `pi-subagent.json`). */
  settingsPath?: string;
  home?: string;
  readMountinfo?: () => string;
  /** private-plan §2.9 seams for the ns evidence judgment (defaults: real /proc reads). */
  readSelfMntNs?: () => string | undefined;
  readBootId?: () => string | undefined;
  /** Read one vault's `<dir>/private.json` (default: the fd-bound `readPrivateRecordFd`). */
  readPrivateRecord?: (file: string) => PrivateRecordRead;
  /** One-shot warning sink for a broken `secure` section (default console.warn). */
  warn?: (message: string) => void;
}

/** The derived in-vault locations for a secure domain (all under the physical mount point). */
export interface SecureStatePaths {
  readonly state: string;
  readonly work: string;
  readonly sessions: string;
  readonly tmp: string;
  readonly memory: string;
  readonly bashJobs: string;
  readonly workflows: string;
  /** consult fork root: `<state>/cache/consult-sessions` — mirrors `<agentDir>/cache/consult-sessions`. */
  readonly consult: string;
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** realpath of the nearest existing ancestor + the not-yet-existing remainder. Never throws. */
export function canonicalPath(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch {
      const parent = resolve(cur, "..");
      if (parent === cur) return resolve(p);
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

export function vaultRoots(vault: SecureVault): SecureVaultRoots {
  const root = realpathOr(vault.dir);
  const mntReal =
    vault.layout === "legacy" ? join(root, "mnt") : join(realpathOr(dirname(vault.mnt)), basename(vault.mnt));
  if (vault.origin === undefined) return { vault, root, mntReal };
  return { vault, root, mntReal, originReal: join(canonicalPath(dirname(vault.origin)), basename(vault.origin)) };
}

export function statePathsOf(v: SecureVaultRoots): SecureStatePaths {
  const state = join(v.mntReal, "state");
  return {
    state,
    work: join(v.mntReal, "work"),
    sessions: join(state, "sessions", "default"),
    tmp: join(state, "tmp"),
    memory: join(state, "memory"),
    bashJobs: join(state, "bash-jobs"),
    workflows: join(state, "workflows"),
    consult: join(state, "cache", "consult-sessions"),
  };
}

/** True when a canonical path lies inside the vault's physical mount (`<mntReal>/…`). */
export function inVaultMount(canonical: string, v: SecureVaultRoots): boolean {
  return pathWithin(canonical, v.mntReal);
}

/**
 * D3 write zone (security review P2 #1): strictly BELOW `<mntReal>/work` or `<mntReal>/state`.
 * Neither the two sentinel paths themselves nor any other entry at the mount-point root qualify —
 * while unmounted those are plain-text files on the lower filesystem.
 */
export function inVaultWriteZone(canonical: string, v: SecureVaultRoots): boolean {
  return [join(v.mntReal, "work"), join(v.mntReal, "state")].some(
    (base) => canonical !== base && pathWithin(canonical, base),
  );
}

/** True when a canonical path lies anywhere inside the vault dir OR its mount point (§L.2). */
export function inVaultDir(canonical: string, v: SecureVaultRoots): boolean {
  return pathWithin(canonical, v.root) || pathWithin(canonical, v.mntReal);
}

export type SecureSettingsRead =
  | { readonly kind: "missing" }
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "error"; readonly message: string };

/**
 * Read the settings file for the domain judgment. Absent (ENOENT / ENOTDIR) ⇒ "missing" (plain).
 * Present but unreadable or not JSON ⇒ "error" — treated as an INVALID secure section (security
 * review P2 #2: never a silent fail-open to plain).
 */
export function readSecureSettingsRaw(path: string): SecureSettingsRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return { kind: "error", message: `${path}: 无法读取（${code ?? String(error)}）` };
  }
  try {
    return { kind: "ok", value: JSON.parse(text) as unknown };
  } catch (error) {
    return {
      kind: "error",
      message: `${path}: JSON 无法解析（${error instanceof Error ? error.message : String(error)}）`,
    };
  }
}

function stableStringify(x: unknown): string {
  if (x === undefined) return "undefined";
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(",")}]`;
  if (x !== null && typeof x === "object")
    return `{${Object.keys(x)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((x as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(x);
}

function secureSectionOf(read: SecureSettingsRead): unknown {
  return read.kind === "ok" && read.value !== null && typeof read.value === "object"
    ? (read.value as Record<string, unknown>).secure
    : undefined;
}

/**
 * The settings read for the domain judgment over a resolved location. Normally just the location's
 * file; in the S6b conflict (two diverging files) the `secure` sections of BOTH must agree — a
 * mismatch is an invalid secure section (fail-closed, plan §3.6.3), never a silent "NEW wins".
 */
export function readSecureSettingsForLocation(loc: SettingsLocation): SecureSettingsRead {
  const primary = readSecureSettingsRaw(loc.path);
  if (loc.kind !== "new" || loc.legacy !== "conflict") return primary;
  const other = readSecureSettingsRaw(loc.legacyPath);
  if (other.kind === "missing") return primary;
  if (other.kind === "error") return other;
  if (primary.kind === "error") return primary;
  if (stableStringify(secureSectionOf(primary)) === stableStringify(secureSectionOf(other))) return primary;
  return { kind: "error", message: `两份设置文件的 secure 段不一致：${loc.newPath} 与 ${loc.legacyPath}` };
}

/** The settings read folded into a SecureConfig (an unreadable file is an enabled-but-invalid section). */
export function secureConfigFromRead(read: SecureSettingsRead, home: string, io?: SecureConfigIo): SecureConfig {
  if (read.kind === "error")
    return { present: true, enabled: true, valid: false, vaults: [], invalid: [], error: read.message };
  return parseSecureConfig(read.kind === "ok" ? read.value : undefined, home, io);
}

/** An enabled `secure` section that could not be used (bad shape, unreadable or corrupt file). */
export function secureConfigBroken(config: SecureConfig): boolean {
  return config.present && config.enabled && !config.valid;
}

export function readProcMountinfo(): string {
  try {
    return readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return "";
  }
}

// ── private-plan §2.9: ns evidence (defaults + the judgment itself) ─────────────────────────

/** readlink("/proc/self/ns/mnt") — e.g. `mnt:[4026532871]`; undefined on any error. */
export function readSelfMntNsDefault(): string | undefined {
  try {
    return readlinkSync("/proc/self/ns/mnt");
  } catch {
    return undefined;
  }
}

/** `/proc/sys/kernel/random/boot_id`, trimmed; undefined on any error. */
export function readBootIdDefault(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return undefined;
  }
}

/**
 * The default `<dir>/private.json` reader — FD-BOUND (security review N3 #3): one
 * `open(O_RDONLY|O_NOFOLLOW|O_NONBLOCK)` → `fstat` (own uid, REGULAR file, 0 < size ≤ 4 KiB) →
 * at most 4097 bytes read THROUGH THAT FD → close. A path swap between open and read is
 * impossible (the fd pins the inode); growth between fstat and read is caught by the byte cap.
 * ENOENT ⇒ absent; anything else that exists (symlink ⇒ ELOOP, foreign uid, not a regular
 * file, empty, over-limit, read error) ⇒ rejected — the JUDGMENT maps that to `unknown`, never
 * to "no evidence". Synchronous by design (one small file at gate time); no timer deadline —
 * a wedged fs stalls the gate the same way the activation-time settings read would.
 */
export type PrivateRecordRead =
  | { readonly kind: "absent" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "rejected"; readonly reason: string };

export function readPrivateRecordFd(file: string): PrivateRecordRead {
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "rejected", reason: code ?? "open-error" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { kind: "rejected", reason: "not-regular" };
    if (st.uid !== (process.getuid?.() ?? -1)) return { kind: "rejected", reason: "foreign-uid" };
    if (st.size <= 0) return { kind: "rejected", reason: "empty" };
    if (st.size > PRIVATE_RECORD_MAX_BYTES) return { kind: "rejected", reason: "over-limit" };
    const buf = Buffer.alloc(PRIVATE_RECORD_MAX_BYTES + 1);
    let total = 0;
    for (;;) {
      let n: number;
      try {
        n = readSync(fd, buf, total, buf.length - total, total);
      } catch (error) {
        return { kind: "rejected", reason: (error as NodeJS.ErrnoException).code ?? "read-error" };
      }
      if (n <= 0) break;
      total += n;
      if (total > PRIVATE_RECORD_MAX_BYTES) return { kind: "rejected", reason: "over-limit" };
    }
    return { kind: "text", text: buf.subarray(0, total).toString("utf8") };
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* best effort */
    }
  }
}

export interface PrivateNsIo {
  readonly readSelfMntNs: () => string | undefined;
  readonly readBootId: () => string | undefined;
  readonly readPrivateRecord: (file: string) => PrivateRecordRead;
}

/**
 * The FROZEN-domain ns field (private-plan §2.9): EVIDENCE — our `/proc/self/ns/mnt` equals some
 * registered vault's `private.json` v3 `ns.mnt` under the SAME boot id — ∨ HINT
 * (`PI_SECURE_NS=1`). A record from another boot never matches (ns ids are recycled across
 * reboots); the hint only ever makes the verdict more conservative; the vault it names is
 * resolved for display when registered. Never reads the mount itself, never throws.
 *
 * This feeds `/secure status` and `isPrivateNsSession()` ONLY. The hub GATES do not use it —
 * they run the fresh three-state `judgePrivateNsGate()` below (security review N3 #1).
 */
export function privateNsEvidence(
  vaults: readonly SecureVaultRoots[],
  env: Record<string, string | undefined>,
  io: PrivateNsIo,
): PrivateNsInfo | undefined {
  // Review round 2 #2: /proc is read ONLY when there is at least one vault to compare against —
  // a process with no registered vaults (and the hint path, which needs no comparison) performs
  // ZERO extra filesystem access, byte-identical to the pre-private-plan activation.
  if (vaults.length > 0) {
    const selfNs = io.readSelfMntNs();
    const bootId = io.readBootId();
    if (selfNs !== undefined && bootId !== undefined) {
      for (const v of vaults) {
        const r = io.readPrivateRecord(join(v.root, "private.json"));
        if (r.kind !== "text") continue;
        const parsed = parsePrivateRecord(r.text);
        if (parsed.kind !== "ok" || parsed.record.bootId !== bootId) continue;
        if (parsed.record.ns?.mnt === selfNs) return { via: "record", vault: v };
      }
    }
  }
  if (env[PI_SECURE_NS] === "1") {
    const named = env[PI_SECURE_VAULT];
    const vault = named !== undefined && named !== "" ? vaults.find((v) => v.vault.name === named) : undefined;
    return { via: "hint", ...(vault !== undefined ? { vault } : {}) };
  }
  return undefined;
}

// ── security review N3 #1 (ruling 2026-10-24): the fail-safe three-state GATE judgment ───────

export type PrivateNsGate = "in-ns" | "not-ns" | "unknown";

export interface PrivateNsGateVerdict {
  readonly gate: PrivateNsGate;
  /** in-ns: the matched vault's name; unknown: WHAT could not be established (refusal copy). */
  readonly reason?: string;
}

export interface PrivateNsGateDeps {
  env?: Record<string, string | undefined>;
  /** Default: the FROZEN domain's vault list (settings changes need a pi restart anyway). */
  vaults?: readonly SecureVaultRoots[];
  readSelfMntNs?: () => string | undefined;
  readBootId?: () => string | undefined;
  readPrivateRecord?: (file: string) => PrivateRecordRead;
}

type ScannedRecord =
  | { readonly kind: "absent" }
  | { readonly kind: "record"; readonly record: PrivateRecord }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * The settings-state factor shared by BOTH ns judgments (review round 2 #1): a PRESENT secure
 * section that could not be read/parsed — file read failure, corrupt JSON, wrong section shape,
 * or ANY invalid vault entry (the whole registry is then untrustworthy) — is `"unusable"` and
 * the gate answers `unknown` (never `not-ns`: with vaults=[] from a broken config we cannot
 * scan the records that would prove membership). Only a genuinely ABSENT section (or a valid,
 * deliberately disabled one) may yield `not-ns`. `undefined` config = the domain verdict has
 * not run (pre-activate / the hub process) — treated as absent; every production gate runs
 * post-activate.
 */
export type SecureConfigNsFactor = "absent" | "ok" | "off" | "unusable";

export function secureConfigNsFactor(config: SecureConfig | undefined): SecureConfigNsFactor {
  if (config === undefined || !config.present) return "absent";
  if (!config.valid || config.invalid.length > 0) return "unusable";
  return config.enabled ? "ok" : "off";
}

/**
 * The gate judgment every hub-spawn surface runs FRESH (never the frozen verdict — a miss must
 * not survive until process exit; security review N3 #1 ruling):
 *
 *   in-ns    — positive evidence: a same-boot record whose `ns.mnt` equals ours.
 *   unknown  — anything that could not be established: `PI_SECURE_NS=1` without matching
 *              evidence; a PRESENT secure section that is unreadable / corrupt / wrongly shaped
 *              / carries any invalid vault entry (review round 2 #1 — then vaults=[] means
 *              "could not determine", never "none"); ANY registered vault's private.json
 *              existing but unreadable / corrupt / not an own-uid regular file / over 4 KiB;
 *              `/proc/self/ns/mnt` (or boot_id) unreadable while a record exists; a same-boot
 *              claim record without `ns` yet; a different-boot record whose ns id string
 *              collides with ours (id reuse).
 *   not-ns   — ONLY when there is no hint AND the secure section is genuinely absent (or valid
 *              and deliberately disabled) AND every registered vault's record is either absent
 *              or legal with `ns.mnt` ≠ ours (different-boot records count when their ns id
 *              string differs — ids may be reused across reboots, never within one).
 *
 * Cost (per gate call — spawn admission / command invocation, rare): one open+read per
 * registered vault, plus `/proc/self/ns/mnt` + boot_id reads ONLY when at least one record
 * exists. NO vaults and no hint ⇒ `not-ns` with ZERO filesystem access (freeze: a plain
 * unconfigured process stays byte-identical). All IO is synchronous; there is no timer
 * deadline (see `readPrivateRecordFd`).
 */
export function judgePrivateNsGate(deps: PrivateNsGateDeps = {}): PrivateNsGateVerdict {
  const domain = getSecureDomain();
  // Review round 2 #1: same classification the activation-time judgment folded into `vaults` —
  // a present-but-unusable secure section means vaults=[] is "could not determine", not "none".
  const factor = secureConfigNsFactor(domain?.config);
  if (factor === "unusable")
    return {
      gate: "unknown",
      reason: `secure 配置存在但不可用（${domain?.config?.error ?? "读取失败/损坏/含非法库条目"}），无法排除私有挂载命名空间`,
    };
  const vaults = deps.vaults ?? domain?.vaults ?? [];
  const env = deps.env ?? process.env;
  const read = deps.readPrivateRecord ?? readPrivateRecordFd;
  const hint = env[PI_SECURE_NS] === "1";

  const scanned: ScannedRecord[] = [];
  let anyRecord = false;
  for (const v of vaults) {
    const r = read(join(v.root, "private.json"));
    if (r.kind === "absent") {
      scanned.push({ kind: "absent" });
      continue;
    }
    if (r.kind === "rejected") {
      return { gate: "unknown", reason: `保险库 ${v.vault.name} 的 private.json 存在但不可读（${r.reason}）` };
    }
    const parsed = parsePrivateRecord(r.text);
    if (parsed.kind !== "ok") {
      return { gate: "unknown", reason: `保险库 ${v.vault.name} 的 private.json 损坏（${parsed.reason}）` };
    }
    anyRecord = true;
    scanned.push({ kind: "record", record: parsed.record });
  }

  // Matching needs our own ns id — read it (and boot_id) only when there is something to match.
  let selfNs: string | undefined;
  let bootId: string | undefined;
  if (anyRecord) {
    selfNs = (deps.readSelfMntNs ?? readSelfMntNsDefault)();
    bootId = (deps.readBootId ?? readBootIdDefault)();
    if (selfNs === undefined || bootId === undefined)
      return { gate: "unknown", reason: "/proc/self/ns/mnt 或 boot_id 不可读，无法比对私有命名空间证据" };
  }

  for (const s of scanned) {
    if (s.kind !== "record") continue;
    const rec = s.record;
    if (rec.bootId === bootId) {
      if (rec.ns?.mnt === selfNs) return { gate: "in-ns", reason: rec.name };
      if (rec.ns === undefined)
        return { gate: "unknown", reason: `保险库 ${rec.name} 存在尚未登记 ns 的 --private 认领记录（${rec.phase}）` };
    } else if (rec.ns?.mnt === selfNs) {
      // different boot + colliding ns id string: kernel ids are reused across reboots — the
      // string matches but the boot does not, so this is neither evidence nor "≠ us".
      return {
        gate: "unknown",
        reason: `保险库 ${rec.name} 的记录来自上次启动且 ns id 与当前碰撞，需 pi-secure status 核对`,
      };
    }
  }

  if (hint)
    return { gate: "unknown", reason: "PI_SECURE_NS=1 但未找到匹配的 private.json 证据（记录可能已被移动或损坏）" };
  return { gate: "not-ns" };
}

/** The hub-gate helper: `unknown` BLOCKS exactly like `in-ns` (fail-safe). */
export function hubSpawnBlockedReason(): "private-ns" | "private-ns-unknown" | undefined {
  const v = judgePrivateNsGate();
  if (v.gate === "in-ns") return "private-ns";
  if (v.gate === "unknown") return "private-ns-unknown";
  return undefined;
}

/** The real-fs legacy-layout probe (§L.3): true when `<dir>/mnt` is a directory on disk. */
export function legacyMntDirProbe(mnt: string): boolean {
  try {
    return lstatSync(mnt).isDirectory();
  } catch {
    return false;
  }
}

/** Mount verdict + the plugin-side defence that `<state>` is a real directory (not the sentinel). */
export function judgeVaultMount(
  v: SecureVaultRoots,
  readMountinfo: () => string,
): { ok: true } | { ok: false; reason: string } {
  const mnt = v.mntReal;
  const st = vaultMountState(readMountinfo(), mnt, join(v.root, "cipher"));
  if (st === "absent") return { ok: false, reason: `保险库 ${v.vault.name} 未挂载` };
  if (st === "foreign") return { ok: false, reason: `保险库 ${v.vault.name} 的挂载点上不是它自己的 gocryptfs 挂载` };
  try {
    if (!lstatSync(join(mnt, "state")).isDirectory())
      return { ok: false, reason: `保险库 ${v.vault.name} 的 state 不是目录（挂载异常）` };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "error";
    return { ok: false, reason: `保险库 ${v.vault.name} 挂载失效（${code}），请 pi-secure lock 后重新 unlock` };
  }
  return { ok: true };
}

/** convert-plan §4 (V6): why a vault with transaction keys must not host a session (undefined ⇒ fine). */
export function vaultUnfinishedReason(v: SecureVault): string | undefined {
  // review V6 #1: malformed transaction keys ⇒ LOCKED (as if not unlocked), a human must fix them
  if (v.txnInvalid !== undefined)
    return `保险库 ${v.name} 的事务键损坏（${v.txnInvalid.join(", ")}），按锁定处理：请人工核对设置文件 secure.vaults.${v.name} 中的这些键（pi-secure status ${v.name}）`;
  if (v.pending !== undefined)
    return `保险库 ${v.name} 有未完成的转换/导入（${v.pending}）：先用 pi-secure convert|import --resume|--abort ${v.name} 处理`;
  if (v.relocate !== undefined) return `保险库 ${v.name} 迁址未完成：先执行 pi-secure init ${v.name} --fix-settings`;
  return undefined;
}

/** The first vault whose dir/mnt nests with `agentDir` (either way; lexical AND canonical families). */
export function agentDirVaultOverlap(
  agentDir: string,
  vaults: readonly SecureVaultRoots[],
): SecureVaultRoots | undefined {
  const lex = resolve(agentDir);
  const phys = canonicalPath(agentDir);
  const nested = (a: string, b: string): boolean => pathWithin(a, b) || pathWithin(b, a);
  return vaults.find(
    (v) =>
      nested(lex, resolve(v.vault.dir)) ||
      nested(lex, resolve(v.vault.mnt)) ||
      nested(phys, v.root) ||
      nested(phys, v.mntReal),
  );
}

/** Side-effect-free judgment (reads settings, realpath, mountinfo). */
export function computeSecureDomain(deps: SecureDomainDeps = {}): SecureDomain {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const agent = resolveAgentDir(env, home);
  const location = deps.settingsPath === undefined ? resolveSettingsLocation(agent) : undefined;
  const settingsPath = deps.settingsPath ?? location?.path ?? "";
  const readMountinfo = deps.readMountinfo ?? readProcMountinfo;
  const config = secureConfigFromRead(
    location === undefined ? readSecureSettingsRaw(settingsPath) : readSecureSettingsForLocation(location),
    home,
    { legacyMntDir: legacyMntDirProbe },
  );
  const usable = config.enabled && config.valid;
  const vaults = usable ? config.vaults.map(vaultRoots) : [];
  // private-plan §2.9: judged once with the domain verdict and frozen with it (the optional `ns`
  // key exists ONLY inside a private mount ns — non-ns objects stay deep-equal to pre-N3).
  const ns = privateNsEvidence(vaults, env, {
    readSelfMntNs: deps.readSelfMntNs ?? readSelfMntNsDefault,
    readBootId: deps.readBootId ?? readBootIdDefault,
    readPrivateRecord: deps.readPrivateRecord ?? readPrivateRecordFd,
  });
  const nsKey = ns === undefined ? {} : { ns };
  // settings-rename §3.6.2: an env-selected agentDir nested with a registered vault would hide the
  // registry inside the vault it describes — unsupported ⇒ locked (never active for the default dir).
  if (usable && agent.source === "env") {
    const hit = agentDirVaultOverlap(agent.dir, vaults);
    if (hit !== undefined)
      return {
        kind: "locked",
        reason: `PI_CODING_AGENT_DIR（${agent.dir}）位于保险库 ${hit.vault.name} 内：不支持（设置登记会藏进它自己描述的保险库）`,
        vaultName: hit.vault.name,
        vaults,
        config,
        ...nsKey,
      };
  }
  const envVault = env[PI_SECURE_VAULT];
  const fromVault = (v: SecureVaultRoots, via: "env" | "cwd"): SecureDomain => {
    // convert-plan §4 (V6): an unfinished convert/import (`pending`) or relocation ⇒ locked, even
    // when something mounted it — the launcher refuses to open such a vault, so a session inside
    // one is never a legitimate secure session.
    const unfinished = vaultUnfinishedReason(v.vault);
    if (unfinished !== undefined)
      return { kind: "locked", reason: unfinished, vaultName: v.vault.name, vaults, config, ...nsKey };
    const mount = judgeVaultMount(v, readMountinfo);
    if (!mount.ok) return { kind: "locked", reason: mount.reason, vaultName: v.vault.name, vaults, config, ...nsKey };
    return { kind: "secure", vault: v, vaults, config, via, ...nsKey };
  };
  if (envVault !== undefined && envVault !== "") {
    if (!usable)
      return {
        kind: "locked",
        reason: `设置了 PI_SECURE_VAULT=${envVault}，但 secure 配置${config.enabled ? "非法" : "已关闭"}`,
        vaultName: envVault,
        vaults,
        config,
        ...nsKey,
      };
    const v = vaults.find((x) => x.vault.name === envVault);
    if (!v)
      return {
        kind: "locked",
        reason: `PI_SECURE_VAULT=${envVault} 不是已登记的保险库${
          agent.source === "env" && settingsPath !== ""
            ? `（设置文件 ${settingsPath}；agentDir 来自 PI_CODING_AGENT_DIR，请确认 pi-secure 在同一环境下运行）`
            : ""
        }`,
        vaultName: envVault,
        vaults,
        config,
        ...nsKey,
      };
    return fromVault(v, "env");
  }
  if (vaults.length === 0) return { kind: "plain", vaults, config, ...nsKey };
  const cwd = canonicalPath(deps.cwd ?? process.cwd());
  const hit = vaults.find((v) => inVaultDir(cwd, v));
  return hit ? fromVault(hit, "cwd") : { kind: "plain", vaults, config, ...nsKey };
}

/** Apply the secure env redirection (plan §2.4 step 1). ORIG is written only when absent. */
export function enterSecureEnv(v: SecureVaultRoots, env: Record<string, string | undefined>): void {
  const p = statePathsOf(v);
  if (env[PI_SECURE_ORIG_ENV] === undefined) env[PI_SECURE_ORIG_ENV] = origEnvSnapshot(env);
  try {
    mkdirSync(p.tmp, { recursive: true, mode: 0o700 });
  } catch {
    /* a failed mkdir only means tmp writes fail inside the vault — never fall back outside */
  }
  env.TMPDIR = p.tmp;
  env.ARMORY_MEMORY_ROOT = p.memory;
  env[PI_SECURE_SESSION] = "1";
  // Strengthening over the plan: a cwd-derived domain also exports PI_SECURE_VAULT so a nested
  // `pi` started from this session's bash lands in the same (secure or locked) domain.
  env[PI_SECURE_VAULT] = v.vault.name;
}

/**
 * Judge once per process and freeze. Later calls (child sessions, /reload) return the frozen
 * verdict unchanged — the env redirection happens exactly once.
 */
export function initSecureDomain(deps: SecureDomainDeps = {}): SecureDomain {
  const g = globalThis as Record<symbol, unknown>;
  const existing = g[SECURE_DOMAIN_KEY] as SecureDomain | undefined;
  if (existing) return existing;
  const domain = computeSecureDomain(deps);
  if (domain.kind === "secure") enterSecureEnv(domain.vault, deps.env ?? process.env);
  // Security review P2 #2: a broken `secure` section is reported once per process (activate runs
  // this first; the verdict is frozen, so this never repeats on child sessions or /reload).
  if (secureConfigBroken(domain.config))
    (deps.warn ?? ((m: string) => console.warn(m)))(
      `[pi-subagent] secure 配置无效（${domain.config.error ?? "?"}）：加密保险库守护无法生效，见 /secure status`,
    );
  g[SECURE_DOMAIN_KEY] = Object.freeze(domain);
  return domain;
}

/** The frozen verdict, or undefined before `initSecureDomain` ran (e.g. the hub process, unit tests). */
export function getSecureDomain(): SecureDomain | undefined {
  return (globalThis as Record<symbol, unknown>)[SECURE_DOMAIN_KEY] as SecureDomain | undefined;
}

/**
 * Private-mount-ns info for THIS process (private-plan §2.9/§4.1), or undefined outside one.
 * Truthy ⇒ every hub-spawn surface refuses (spawnHub gate, /webhub restart, agent.nospawn.v1).
 * Undefined before `initSecureDomain` ran (the hub process itself, pre-activate imports) —
 * every consumer lives in plugin wiring that runs after activate, so that is "not in an ns".
 */
export function isPrivateNsSession(): PrivateNsInfo | undefined {
  return getSecureDomain()?.ns;
}

/** In-vault paths when the frozen domain is secure, else undefined. */
export function secureStatePaths(): SecureStatePaths | undefined {
  const d = getSecureDomain();
  return d?.kind === "secure" ? statePathsOf(d.vault) : undefined;
}

/** Test-only: forget the frozen verdict. */
export function resetSecureDomainForTests(): void {
  delete (globalThis as Record<symbol, unknown>)[SECURE_DOMAIN_KEY];
}

/**
 * Child-session placement (plan §2.5 「子会话落盘」): secure ⇒ the in-vault session dir; plain or no
 * verdict ⇒ undefined (pi's default dir, byte-identical call); locked ⇒ throws (no runs at all).
 */
export function secureChildSessionDir(): string | undefined {
  const d = getSecureDomain();
  if (d?.kind === "locked") throw new Error(`加密会话已锁定，拒绝创建子会话：${d.reason}`);
  return d?.kind === "secure" ? statePathsOf(d.vault).sessions : undefined;
}

/**
 * Cross-domain resume guard (plan §2.5 「跨域 resume」): secure ⇒ the file must live inside the vault
 * mount; plain ⇒ it must not live in any configured vault; locked ⇒ refused. Throws with the reason.
 */
export function assertSessionFileInDomain(sessionFile: string): void {
  const d = getSecureDomain();
  if (d === undefined) return;
  if (d.kind === "locked") throw new Error(`加密会话已锁定，拒绝恢复会话：${d.reason}`);
  const canonical = canonicalPath(sessionFile);
  if (d.kind === "secure") {
    if (!inVaultMount(canonical, d.vault)) throw new Error(`加密会话不能恢复保险库外的会话文件：${sessionFile}`);
    return;
  }
  const literal = resolve(sessionFile);
  const hit = d.vaults.find((v) => {
    if (inVaultDir(canonical, v) || pathWithin(literal, v.vault.dir) || pathWithin(literal, v.vault.mnt)) return true;
    return v.vault.legacyLink !== undefined && pathWithin(literal, v.vault.legacyLink); // review L0 #3
  });
  if (hit) throw new Error(`普通会话不能恢复保险库 ${hit.vault.name} 内的会话文件：${sessionFile}`);
}
