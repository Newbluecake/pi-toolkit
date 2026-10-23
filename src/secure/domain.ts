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
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  parseSecureConfig,
  pathWithin,
  vaultMountState,
  type SecureConfig,
  type SecureConfigIo,
  type SecureVault,
} from "./config.js";
import { PI_SECURE_ORIG_ENV, PI_SECURE_SESSION, PI_SECURE_VAULT, origEnvSnapshot } from "./env.js";

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
}

export type SecureDomain =
  | { readonly kind: "plain"; readonly vaults: readonly SecureVaultRoots[]; readonly config: SecureConfig }
  | {
      readonly kind: "secure";
      readonly vault: SecureVaultRoots;
      readonly vaults: readonly SecureVaultRoots[];
      readonly config: SecureConfig;
      /** How the vault was selected. */
      readonly via: "env" | "cwd";
    }
  | {
      readonly kind: "locked";
      readonly reason: string;
      readonly vaultName?: string;
      readonly vaults: readonly SecureVaultRoots[];
      readonly config: SecureConfig;
    };

export interface SecureDomainDeps {
  /** Env read for PI_SECURE_VAULT and MUTATED on entering secure (default `process.env`). */
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Settings file to read the raw `secure` section from (default `~/.pi/agent/pi-subagent.json`). */
  settingsPath?: string;
  home?: string;
  readMountinfo?: () => string;
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
  return { vault, root, mntReal };
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

/** Side-effect-free judgment (reads settings, realpath, mountinfo). */
export function computeSecureDomain(deps: SecureDomainDeps = {}): SecureDomain {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const settingsPath = deps.settingsPath ?? join(home, ".pi", "agent", "pi-subagent.json");
  const readMountinfo = deps.readMountinfo ?? readProcMountinfo;
  const config = secureConfigFromRead(readSecureSettingsRaw(settingsPath), home, { legacyMntDir: legacyMntDirProbe });
  const usable = config.enabled && config.valid;
  const vaults = usable ? config.vaults.map(vaultRoots) : [];
  const envVault = env[PI_SECURE_VAULT];
  const fromVault = (v: SecureVaultRoots, via: "env" | "cwd"): SecureDomain => {
    const mount = judgeVaultMount(v, readMountinfo);
    if (!mount.ok) return { kind: "locked", reason: mount.reason, vaultName: v.vault.name, vaults, config };
    return { kind: "secure", vault: v, vaults, config, via };
  };
  if (envVault !== undefined && envVault !== "") {
    if (!usable)
      return {
        kind: "locked",
        reason: `设置了 PI_SECURE_VAULT=${envVault}，但 secure 配置${config.enabled ? "非法" : "已关闭"}`,
        vaultName: envVault,
        vaults,
        config,
      };
    const v = vaults.find((x) => x.vault.name === envVault);
    if (!v)
      return {
        kind: "locked",
        reason: `PI_SECURE_VAULT=${envVault} 不是已登记的保险库`,
        vaultName: envVault,
        vaults,
        config,
      };
    return fromVault(v, "env");
  }
  if (vaults.length === 0) return { kind: "plain", vaults, config };
  const cwd = canonicalPath(deps.cwd ?? process.cwd());
  const hit = vaults.find((v) => inVaultDir(cwd, v));
  return hit ? fromVault(hit, "cwd") : { kind: "plain", vaults, config };
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
