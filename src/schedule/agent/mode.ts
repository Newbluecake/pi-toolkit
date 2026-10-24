/**
 * Scheduled tasks — run-mode matrix and the unified execution gate (plan r3 §3.3, §7.6, §10.2; A0).
 *
 * Pure: every fact (pi run mode, session file, child marker, secure verdict, runtime lock, vault
 * predicate, liveness of the stack) is injected, so the same rules serve the session clock, the
 * manual-run path, the message dispatcher (A2) and the tool/command surfaces (A3).
 *
 * Matrix (§3.3), first matching row wins:
 *   secure / locked domain (or a runtime lock)  ⇒ kind "secure"     — every action E_SECURE, never arms
 *   independently opened child-session file     ⇒ kind "child"      — every action E_CHILD, never arms
 *   no persisted session file (--no-session)    ⇒ kind "ephemeral"  — create E_EPHEMERAL, reads empty
 *   print / json main session                   ⇒ kind "print"      — list/get/history only, never arms
 *   TUI / RPC main session with a session file  ⇒ kind "interactive" — everything, arms the clock
 * (Child sessions inside a host — HOST_KEY claimed — never reach this module: post-guard inert.)
 */
import { realpathSync } from "node:fs";
import type { ScheduleErrorCode, ScheduleTask } from "../core/spec.js";

export type ScheduleModeKind = "interactive" | "print" | "ephemeral" | "child" | "secure";

/** pi `ExtensionMode` plus anything a future host might report (unknown ⇒ treated like print). */
export type HostMode = "tui" | "rpc" | "json" | "print" | (string & {});

export type SecureKind = "plain" | "secure" | "locked";

export interface ScheduleModeFacts {
  mode: HostMode;
  /** `ctx.sessionManager.getSessionFile()` — undefined ⇔ `--no-session`. */
  sessionFile: string | undefined;
  /** The session carries the `subagent:child` self-marker, or lives in the consult-fork dir. */
  childFile: boolean;
  /** Frozen per-process domain verdict (`initSecureDomain`). */
  secure: SecureKind;
}

export interface ScheduleModeVerdict {
  kind: ScheduleModeKind;
  /** Only interactive sessions arm timers / execute. */
  arm: boolean;
}

export function resolveScheduleMode(f: ScheduleModeFacts): ScheduleModeVerdict {
  if (f.secure !== "plain") return { kind: "secure", arm: false };
  if (f.childFile) return { kind: "child", arm: false };
  if (f.sessionFile === undefined || f.sessionFile === "") return { kind: "ephemeral", arm: false };
  if (f.mode === "tui" || f.mode === "rpc") return { kind: "interactive", arm: true };
  return { kind: "print", arm: false };
}

/** Tool actions (§5.1). */
export type ScheduleToolAction =
  "list" | "get" | "create" | "update" | "pause" | "resume" | "delete" | "run_now" | "history";
export const SCHEDULE_READ_ACTIONS: readonly ScheduleToolAction[] = Object.freeze(["list", "get", "history"]);

export interface ScheduleRefusal {
  code: ScheduleErrorCode;
  detail: string;
}

const DETAIL: Readonly<Record<Exclude<ScheduleModeKind, "interactive">, string>> = Object.freeze({
  secure: "加密会话禁用定时任务（data-encryption D8）",
  child: "子 agent 会话文件不能拥有定时任务",
  ephemeral: "--no-session 会话没有可恢复的归属，不能创建定时任务",
  print: "print / json 模式只允许 list / get / history",
});

/**
 * Mode-level refusal for a tool action (A3's surface). `undefined` ⇒ allowed by the matrix
 * (per-task checks — owner, approval, overlap — still apply). Ephemeral sessions: `create` is
 * refused; every other action sees an empty task list (the caller answers "no such task").
 */
export function actionRefusal(v: ScheduleModeVerdict, action: ScheduleToolAction): ScheduleRefusal | undefined {
  switch (v.kind) {
    case "interactive":
      return undefined;
    case "secure":
      return { code: "E_SECURE", detail: DETAIL.secure };
    case "child":
      return { code: "E_CHILD", detail: DETAIL.child };
    case "ephemeral":
      return action === "create" ? { code: "E_EPHEMERAL", detail: DETAIL.ephemeral } : undefined;
    case "print":
      return SCHEDULE_READ_ACTIONS.includes(action) ? undefined : { code: "E_MODE", detail: DETAIL.print };
  }
}

/** Live facts read at EVERY execution point (timer claim, manual run, Feishu run, dispatcher send). */
export interface ExecGatePorts {
  verdict: ScheduleModeVerdict;
  /** The session this stack was built for (the ledger's owner sid). */
  ownerSessionId: string;
  /** Current session id from the live ctx (undefined ⇒ stale ctx). */
  currentSessionId(): string | undefined;
  /** This stack's epoch has been disposed (shutdown / rebuild). */
  disposed(): boolean;
  /** Runtime LOCKED reason from the secure guards (mid-session unmount), if any. */
  lockedReason?(): string | undefined;
  /** Encrypted-vault predicate over a CANONICAL path (secure/domain `inVaultDir` over every vault). */
  inVault?(canonicalPath: string): boolean;
  /** realpath (injectable for tests); throws when the path cannot be resolved. */
  realpath?(path: string): string;
}

/**
 * `assertExecutable()` (§7.6): plain domain and not locked; the matrix allows execution; the
 * current sid equals the owner sid; the stack is alive; and — when a task is given — its
 * `ownerCwd` resolves outside every vault. Timer callbacks never pass through the tool_call /
 * input guards, so this check is the only line of defence there.
 */
export function assertExecutable(p: ExecGatePorts, task?: Pick<ScheduleTask, "ownerCwd">): ScheduleRefusal | undefined {
  if (p.disposed()) return { code: "E_NOT_OWNER", detail: "stack disposed" };
  if (p.verdict.kind !== "interactive") {
    return p.verdict.kind === "print"
      ? { code: "E_MODE", detail: DETAIL.print }
      : (actionRefusal(p.verdict, "run_now") ?? { code: "E_EPHEMERAL", detail: DETAIL.ephemeral });
  }
  const locked = p.lockedReason?.();
  if (locked !== undefined) return { code: "E_SECURE", detail: `session LOCKED: ${locked}` };
  let current: string | undefined;
  try {
    current = p.currentSessionId();
  } catch {
    current = undefined; // stale ctx throws ⇒ not the owner any more
  }
  if (current !== p.ownerSessionId) return { code: "E_NOT_OWNER", detail: "not the owning session" };
  if (task !== undefined) {
    const inVault = p.inVault;
    if (inVault !== undefined) {
      let real: string;
      try {
        real = (p.realpath ?? realpathSync)(task.ownerCwd);
      } catch {
        return { code: "E_INVALID", detail: "owner cwd cannot be resolved" };
      }
      if (inVault(task.ownerCwd) || inVault(real)) return { code: "E_SECURE", detail: "owner cwd lies inside a vault" };
    }
  }
  return undefined;
}
