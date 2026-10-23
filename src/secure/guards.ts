/**
 * Encrypted-session guards (data-encryption plan r4 §2.4 steps 3 + LOCKED, §2.5 D3/D4/switch).
 *
 * Pure decisions (`decideToolCall`, `verifySessionFacts`, `decideSwitch`, `bashTouchesVault`) plus
 * one assembly function, `wireSecureGuards`, called early in `activate()` (pre-guard: child
 * sessions run in the same process and need D3/D4 too). Child sessions never receive
 * `session_start`, so the runtime LOCKED verdict is main-session only; a child inherits the frozen
 * process verdict (a frozen `locked` blocks it outright).
 *
 * Not a security boundary for bash: D4's bash check is a best-effort substring scan (plan §5 R7/R8).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createGitRunner, type GitRunner } from "../git/run.js";
import { pathWithin } from "./config.js";
import {
  canonicalPath,
  inVaultDir,
  inVaultMount,
  inVaultWriteZone,
  judgeVaultMount,
  readProcMountinfo,
  secureConfigBroken,
  statePathsOf,
  type SecureDomain,
  type SecureVaultRoots,
} from "./domain.js";

/** TUI status key + its two English tokens (UI language split: compact markers stay English). */
export const SECURE_STATUS_KEY = "pi-subagent:secure";
export const SECURE_STATUS_TEXT = "secure";
export const SECURE_STATUS_LOCKED = "secure:locked";
/** Plain process whose enabled `secure` section is unusable (bad shape / unreadable / corrupt file). */
export const SECURE_STATUS_INVALID = "secure:invalid";

/** Tools whose `path` input is checked (pi built-ins). `grep`/`find`/`ls` default to the cwd. */
const PATH_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const WRITE_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

export interface ToolCallVerdict {
  block: true;
  reason: string;
}

/** Resolve a tool `path` the way pi's tools do: strip a leading `@`, expand `~`, resolve against cwd. */
export function resolveToolPath(raw: string, cwd: string, home: string = homedir()): string {
  let p = raw.startsWith("@") ? raw.slice(1) : raw;
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = join(home, p.slice(2));
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

function vaultOfPath(abs: string, vaults: readonly SecureVaultRoots[]): SecureVaultRoots | undefined {
  const canonical = canonicalPath(abs);
  return vaults.find((v) => {
    if (inVaultDir(canonical, v) || pathWithin(abs, v.vault.dir) || pathWithin(abs, v.vault.mnt)) return true;
    // Legacy vaults keep the pre-L0 entry symlink address in the known-address set (review L0 #3):
    // a plain session naming `~/secure/<old>` directly must stay blocked while an old helper's
    // mount is still live behind it.
    return v.vault.legacyLink !== undefined && pathWithin(abs, v.vault.legacyLink);
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every textual spelling of a vault a shell command could use (absolute, `~/…`, `$HOME/…`). */
export function vaultSpellings(v: SecureVaultRoots, home: string = homedir()): string[] {
  const out = new Set<string>();
  const paths = [v.root, v.vault.dir, v.vault.mnt, v.mntReal];
  if (v.vault.legacyLink !== undefined) paths.push(v.vault.legacyLink); // review L0 #3
  for (const p of paths) {
    out.add(p);
    const rel = relative(home, p);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
      out.add(`~/${rel}`);
      out.add(`$HOME/${rel}`);
      out.add(`\${HOME}/${rel}`);
    }
  }
  return [...out];
}

/** Best-effort: does this shell command text mention any vault path? (prefix + path boundary) */
export function bashTouchesVault(
  command: string,
  vaults: readonly SecureVaultRoots[],
  home: string = homedir(),
): SecureVaultRoots | undefined {
  for (const v of vaults) {
    for (const spelling of vaultSpellings(v, home)) {
      if (new RegExp(`${escapeRe(spelling)}(?=$|[/\\s'"\`;|&)<>:])`).test(command)) return v;
    }
  }
  return undefined;
}

/**
 * The tool_call decision. `locked` (runtime or frozen) blocks everything; secure ⇒ D3 (write/edit
 * must stay inside the vault mount); plain ⇒ D4 (no path tool / bash may touch a vault).
 *
 * D3's write zone (§L.2): strictly below the physical `<mntReal>/work` / `<mntReal>/state`; the
 * sentinel paths themselves and any other entry at the mount-point root are refused.
 */
export function decideToolCall(
  domain: SecureDomain,
  lockedReason: string | undefined,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  home: string = homedir(),
): ToolCallVerdict | undefined {
  if (lockedReason !== undefined) return { block: true, reason: `会话已锁定：${lockedReason}` };
  if (domain.kind === "locked") return { block: true, reason: `会话已锁定：${domain.reason}` };
  const pathArg = typeof input.path === "string" && input.path !== "" ? input.path : undefined;
  if (domain.kind === "secure") {
    if (!WRITE_TOOLS.has(toolName)) return undefined;
    if (pathArg === undefined) return undefined; // the tool itself rejects a missing path
    const target = canonicalPath(resolveToolPath(pathArg, cwd, home));
    if (inVaultWriteZone(target, domain.vault)) return undefined;
    return {
      block: true,
      reason: `加密会话禁止把文件写到保险库外（${target}）。请写到 ${statePathsOf(domain.vault).work} 内。`,
    };
  }
  if (domain.vaults.length === 0) return undefined;
  if (PATH_TOOLS.has(toolName)) {
    const target = resolveToolPath(pathArg ?? ".", cwd, home);
    const hit = vaultOfPath(target, domain.vaults);
    if (hit)
      return {
        block: true,
        reason: `普通会话禁止访问加密保险库 ${hit.vault.name}（${target}）。请用 pi-secure run ${hit.vault.name} 打开加密会话。`,
      };
    return undefined;
  }
  if (toolName === "bash" && typeof input.command === "string") {
    const hit = bashTouchesVault(input.command, domain.vaults, home);
    if (hit)
      return {
        block: true,
        reason: `普通会话的 bash 命令涉及加密保险库 ${hit.vault.name} 的路径，已拦截。请用 pi-secure run ${hit.vault.name} 打开加密会话。`,
      };
  }
  return undefined;
}

export interface SessionFacts {
  cwd: string;
  sessionFile: string | undefined;
  sessionDir: string;
}

/** Plan §2.4 step 3. Returns the LOCKED reason, or undefined when the session is consistent. */
export function verifySessionFacts(
  domain: SecureDomain,
  facts: SessionFacts,
  readMountinfo?: () => string,
): string | undefined {
  if (domain.kind === "locked") return domain.reason;
  const persisted = facts.sessionFile !== undefined || facts.sessionDir !== "";
  if (domain.kind === "secure") {
    const v = domain.vault;
    const name = v.vault.name;
    const mount = judgeVaultMount(v, readMountinfo ?? readProcMountinfo);
    if (!mount.ok) return mount.reason;
    if (!inVaultMount(canonicalPath(facts.cwd), v))
      return `会话目录 ${facts.cwd} 不在保险库 ${name} 内。请用 pi-secure run ${name} -C <子目录> 重开。`;
    if (persisted) {
      const sessionsRoot = join(statePathsOf(v).state, "sessions");
      if (facts.sessionDir === "" || !pathWithin(canonicalPath(facts.sessionDir), sessionsRoot))
        return `会话记录目录 ${facts.sessionDir || "(未知)"} 不在保险库 ${name} 内。请用 pi-secure run ${name} -C <子目录> 重开。`;
      if (facts.sessionFile !== undefined && !pathWithin(canonicalPath(facts.sessionFile), sessionsRoot))
        return `会话文件 ${facts.sessionFile} 不在保险库 ${name} 内。请用 pi-secure run ${name} 重开。`;
    }
    return undefined;
  }
  if (domain.vaults.length === 0) return undefined;
  const candidates = [facts.cwd, ...(persisted ? [facts.sessionFile, facts.sessionDir] : [])];
  for (const p of candidates) {
    if (p === undefined || p === "") continue;
    const hit = vaultOfPath(resolve(p), domain.vaults);
    if (hit)
      return `普通进程打开了保险库 ${hit.vault.name} 内的会话或目录（${p}）。请用 pi-secure run ${hit.vault.name} 重开。`;
  }
  return undefined;
}

/** `session_before_switch` (resume/import target): cross-domain targets are cancelled. */
export function decideSwitch(domain: SecureDomain, targetSessionFile: string | undefined): string | undefined {
  if (domain.kind === "locked") return `会话已锁定，拒绝切换会话：${domain.reason}`;
  if (targetSessionFile === undefined) return undefined;
  if (domain.kind === "secure") {
    if (inVaultMount(canonicalPath(targetSessionFile), domain.vault)) return undefined;
    return `加密会话不能切换到保险库外的会话（${targetSessionFile}）。`;
  }
  if (domain.vaults.length === 0) return undefined;
  const hit = vaultOfPath(resolve(targetSessionFile), domain.vaults);
  return hit
    ? `普通会话不能打开保险库 ${hit.vault.name} 内的会话。请用 pi-secure run ${hit.vault.name} 打开。`
    : undefined;
}

/* ------------------------------------------------------------------------------------------- */
/* pi-facing assembly                                                                          */
/* ------------------------------------------------------------------------------------------- */

interface GuardUi {
  notify?(message: string, type?: "info" | "warning" | "error"): void;
  setStatus?(key: string, text: string | undefined): void;
}
interface GuardCtx {
  cwd: string;
  hasUI?: boolean;
  ui?: GuardUi;
  sessionManager?: { getSessionFile?(): string | undefined; getSessionDir?(): string };
}
/** The slice of pi's ExtensionAPI the guards use (tests pass a structural fake). */
export type SecureGuardPi = Pick<ExtensionAPI, "on">;

export interface SecureGuardOptions {
  domain: SecureDomain;
  isChildSession: boolean;
  readMountinfo?: () => string;
  git?: GitRunner;
  home?: string;
}

export interface SecureGuardWiring {
  /** Current runtime LOCKED reason (main session), or the frozen locked reason. */
  lockedReason(): string | undefined;
}

/** True when the guards have anything to do for this verdict (plain with no vaults ⇒ zero wiring). */
export function secureGuardsNeeded(domain: SecureDomain | undefined): domain is SecureDomain {
  return (
    domain !== undefined && (domain.kind !== "plain" || domain.vaults.length > 0 || secureConfigBroken(domain.config))
  );
}

function safeNotify(ctx: GuardCtx, message: string, type: "info" | "warning" | "error"): void {
  try {
    ctx.ui?.notify?.(message, type);
  } catch {
    /* stale ctx / headless */
  }
}

/**
 * Register the guards. Call only when `secureGuardsNeeded(domain)`; register as EARLY as possible
 * in activate() — pi runs one extension's handlers in registration order and the first
 * `handled` / `block` / `cancel` wins.
 */
export function wireSecureGuards(pi: SecureGuardPi, opts: SecureGuardOptions): SecureGuardWiring {
  const { domain } = opts;
  const home = opts.home ?? homedir();
  const state: { runtimeLock: string | undefined; statusShown: string | undefined } = {
    runtimeLock: undefined,
    statusShown: undefined,
  };
  const lockedReason = (): string | undefined =>
    state.runtimeLock ?? (domain.kind === "locked" ? domain.reason : undefined);
  const on = pi.on.bind(pi) as unknown as (event: string, handler: (event: unknown, ctx: GuardCtx) => unknown) => void;
  const readMountinfo = opts.readMountinfo ?? readProcMountinfo;
  const applyStatus = (ctx: GuardCtx): void => {
    const status =
      state.runtimeLock !== undefined || domain.kind === "locked"
        ? SECURE_STATUS_LOCKED
        : domain.kind === "secure"
          ? SECURE_STATUS_TEXT
          : secureConfigBroken(domain.config)
            ? SECURE_STATUS_INVALID
            : undefined;
    if (status === state.statusShown) return;
    state.statusShown = status;
    try {
      ctx.ui?.setStatus?.(SECURE_STATUS_KEY, status);
    } catch {
      /* headless */
    }
  };
  const lockNow = (reason: string, ctx: GuardCtx): void => {
    state.runtimeLock = reason;
    applyStatus(ctx);
    safeNotify(ctx, `会话已锁定：${reason}（输入与工具调用都会被拒绝；可用 /quit 退出）`, "error");
  };
  /**
   * Security review P2 #1: a secure process re-verifies its mount on every tool call and input (one
   * small /proc read). A vault unmounted mid-session (e.g. `pi-secure lock` from another terminal)
   * locks the session at once — before any write could reach the lower, plain-text directory.
   */
  const recheckMount = (ctx: GuardCtx): void => {
    if (domain.kind !== "secure" || state.runtimeLock !== undefined) return;
    let verdict: ReturnType<typeof judgeVaultMount>;
    try {
      verdict = judgeVaultMount(domain.vault, readMountinfo);
    } catch (error) {
      verdict = { ok: false, reason: `挂载核验失败：${String(error)}` };
    }
    if (!verdict.ok) lockNow(`${verdict.reason}（会话运行中保险库被卸载）`, ctx);
  };

  on("tool_call", (event, ctx) => {
    const e = event as { toolName?: unknown; input?: unknown };
    const toolName = typeof e.toolName === "string" ? e.toolName : "";
    const input = e.input !== null && typeof e.input === "object" ? (e.input as Record<string, unknown>) : {};
    try {
      recheckMount(ctx);
      return decideToolCall(domain, lockedReason(), toolName, input, ctx.cwd || process.cwd(), home);
    } catch (error) {
      // Fail closed outside plain: a guard that cannot decide must not let a write through.
      if (domain.kind !== "plain") return { block: true, reason: `加密守护判定失败：${String(error)}` };
      return undefined;
    }
  });

  on("input", (_event, ctx) => {
    recheckMount(ctx);
    const reason = lockedReason();
    if (reason === undefined) return undefined;
    safeNotify(ctx, `会话已锁定：${reason}（可用 /quit 退出）`, "error");
    return { action: "handled" };
  });

  on("user_bash", () => {
    const reason = lockedReason();
    if (reason === undefined) return undefined;
    return { result: { output: `会话已锁定：${reason}\n`, exitCode: 1, cancelled: false, truncated: false } };
  });

  on("session_before_switch", (event, ctx) => {
    const target = (event as { targetSessionFile?: unknown }).targetSessionFile;
    const reason = decideSwitch(domain, typeof target === "string" ? target : undefined);
    if (reason === undefined) return undefined;
    safeNotify(ctx, reason, "error");
    return { cancel: true };
  });

  if (!opts.isChildSession) {
    const git = opts.git ?? createGitRunner();
    on("session_start", (_event, ctx) => {
      let sessionFile: string | undefined;
      let sessionDir = "";
      try {
        sessionFile = ctx.sessionManager?.getSessionFile?.();
        sessionDir = ctx.sessionManager?.getSessionDir?.() ?? "";
      } catch {
        /* treat as non-persisted */
      }
      let reason: string | undefined;
      try {
        reason = verifySessionFacts(domain, { cwd: ctx.cwd || process.cwd(), sessionFile, sessionDir }, readMountinfo);
      } catch (error) {
        reason = domain.kind === "plain" ? undefined : `加密守护核验失败：${String(error)}`;
      }
      if (reason !== undefined) {
        lockNow(reason, ctx);
        return;
      }
      state.runtimeLock = undefined;
      applyStatus(ctx);
      if (domain.kind === "secure") void warnGitCommonDir(git, ctx, domain.vault);
    });
  }

  return { lockedReason };
}

/** R9: a linked worktree / external `.git` writes objects outside the vault. One bounded git call. */
async function warnGitCommonDir(git: GitRunner, ctx: GuardCtx, vault: SecureVaultRoots): Promise<void> {
  try {
    const cwd = ctx.cwd || process.cwd();
    const r = await git(["rev-parse", "--git-common-dir"], { cwd, timeoutMs: 3_000, maxStdoutBytes: 8_192 });
    if (r.code !== 0) return; // not a git repo (or git missing): nothing to warn about
    const out = r.stdout.trim();
    if (out === "") return;
    const common = canonicalPath(resolve(cwd, out));
    if (inVaultMount(common, vault)) return;
    safeNotify(
      ctx,
      `注意：此 git 仓库的 common-dir（${common}）在保险库外，commit 对象会以明文写到那里。请把整个仓库（含 .git）放进保险库。`,
      "warning",
    );
  } catch {
    /* diagnostic only */
  }
}
