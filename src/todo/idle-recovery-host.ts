/** #59 B2 host-only arrival producer and synchronous, fail-closed busy aggregation.
 * No registration/production wiring. B3 must supply real sources, never inferred role/text.
 * In particular ExtensionContext.sessionManager is NOT an AgentSession subscription port.
 */
import { randomUUID } from "node:crypto";
import type { TodoState } from "./state.js";
import type { IdleRecoveryStore } from "./idle-recovery-store.js";
import type { RecoveryHumanProof, RecoveryState } from "./idle-recovery.js";

export type RecoveryBusy = "clear" | "busy" | "unknown";
export const RECOVERY_BUSY_SOURCES = [
  "query",
  "workflow",
  "jobs",
  "notifier",
  "web",
  "scheduleMemory",
  "schedulePersistent",
  "otherRoot",
  "goal",
] as const;
export type RecoveryBusySource = (typeof RECOVERY_BUSY_SOURCES)[number];
export interface RecoveryIdentity {
  readonly sid: string;
  readonly owner: string;
}
export interface RecoverySdkSnapshot {
  readonly mode: string;
  readonly idle: boolean;
  readonly pending: boolean;
}
export interface RecoveryHostSnapshot {
  readonly identity: RecoveryIdentity | undefined;
  readonly sdk: RecoverySdkSnapshot | undefined;
  readonly todo: TodoState | undefined;
  readonly state: RecoveryState;
  readonly sources: Readonly<Record<RecoveryBusySource | "sdk", RecoveryBusy>>;
  readonly busy: RecoveryBusy;
}
export interface IdleRecoveryHostDeps extends RecoveryIdentity {
  readonly enabled: boolean;
  readonly store: IdleRecoveryStore;
  readonly currentIdentity: () => RecoveryIdentity | undefined;
  readonly readSdk: () => RecoverySdkSnapshot | undefined;
  /** Full TODO state, including archived/completed dependency targets, NOT Web projection. */
  readonly readTodo: () => TodoState | undefined;
  readonly busy?: Partial<Record<RecoveryBusySource, () => RecoveryBusy>>;
  /** Revoke previous attempt's deadline/abort rights BEFORE opening/persisting a new window. */
  readonly handover: () => void;
  /** Existing admitted-command ledger, consumed once at admission BEFORE held/native branch.
   * Must return false for replay/held release, and unknown if the ledger cannot attest freshness.
   * Host deliberately retains no lifetime command-id set/cap.
   */
  readonly takeAcceptedWebCommand?: (cmdId: string) => "fresh" | "replay" | "unknown";
  readonly createInputId?: () => string;
}
export interface IdleRecoveryHost {
  readHostSnapshot(): RecoveryHostSnapshot;
  /** Only call from actual public input callback; raw role:user/RPC/tool objects are not producers. */
  onTuiInput(event: unknown, context: RecoveryIdentity & { readonly mode: string }): boolean;
  /** Only the trusted, security/session-admitted new chat seam may call this method. */
  onWebArrival(admission: RecoveryIdentity & { readonly cmdId: string }): boolean;
  dispose(): void;
}
function safely<T>(read: (() => T) | undefined): T | undefined {
  try {
    return read?.();
  } catch {
    return undefined;
  }
}
function tri(value: unknown): RecoveryBusy {
  return value === "clear" || value === "busy" ? value : "unknown";
}
export function combineRecoveryBusy(values: readonly RecoveryBusy[]): RecoveryBusy {
  return values.includes("busy") ? "busy" : values.includes("unknown") ? "unknown" : "clear";
}
/** Missing/uninitialized goal is NOT proof of absence; paused goals still own root. */
export function recoveryGoalBusy(
  value: { initialized: boolean; evaluating: boolean; state: string | null } | undefined,
): RecoveryBusy {
  if (!value || value.initialized !== true || typeof value.evaluating !== "boolean") return "unknown";
  if (value.evaluating || value.state === "active" || value.state === "paused") return "busy";
  return value.state === null || value.state === "completed" || value.state === "aborted" ? "clear" : "unknown";
}
/** Caller folds actual persistent runs/notes/reports/digest into pending. A future schedule
 * alone is clear; degraded/uninitialized/unknown storage is never guessed empty.
 */
export function recoveryScheduleBusy(
  value: { initialized: boolean; degraded: boolean; pending: boolean; nextAt: number | null } | undefined,
  now: number,
): RecoveryBusy {
  if (
    !value ||
    value.initialized !== true ||
    value.degraded !== false ||
    typeof value.pending !== "boolean" ||
    !Number.isFinite(now)
  )
    return "unknown";
  if (value.pending) return "busy";
  if (value.nextAt === null) return "clear";
  if (!Number.isFinite(value.nextAt)) return "unknown";
  return value.nextAt <= now ? "busy" : "clear";
}

export function createIdleRecoveryHost(deps: IdleRecoveryHostDeps): IdleRecoveryHost {
  let disposed = false;
  let epochHighWater = 0;
  const events = new WeakSet<object>();
  const current = (identity: RecoveryIdentity | undefined): boolean =>
    !disposed && deps.enabled && identity?.sid === deps.sid && identity.owner === deps.owner;
  const identity = () => safely(deps.currentIdentity);
  const arrive = (): boolean => {
    if (!current(identity())) return false;
    // Handover is independent of successful budget persistence. Never restore old abort rights.
    deps.handover();
    if (!current(identity())) return false;
    const state = deps.store.view();
    const high = Math.max(epochHighWater, state.window?.epoch ?? 0);
    if (!Number.isSafeInteger(high) || high >= Number.MAX_SAFE_INTEGER) return false;
    epochHighWater = high + 1;
    const proof: RecoveryHumanProof = {
      sid: deps.sid,
      owner: deps.owner,
      epoch: epochHighWater,
      inputId: (deps.createInputId ?? (() => `arrival_${randomUUID()}`))(),
      provenance: "user-arrival",
    };
    const result = deps.store.noteHumanProof(proof);
    const latest = deps.store.view();
    return (
      result.kind === "opened" &&
      latest.latch === undefined &&
      latest.window?.epoch === proof.epoch &&
      latest.window.inputId === proof.inputId
    );
  };
  const readHostSnapshot = (): RecoveryHostSnapshot => {
    const id = identity();
    const sdk = safely(deps.readSdk);
    const todo = safely(deps.readTodo);
    const state = deps.store.view();
    const sources = {} as Record<RecoveryBusySource | "sdk", RecoveryBusy>;
    for (const name of RECOVERY_BUSY_SOURCES) sources[name] = tri(safely(deps.busy?.[name]));
    sources.sdk =
      !sdk ||
      !["tui", "rpc", "json", "print"].includes(sdk.mode) ||
      typeof sdk.idle !== "boolean" ||
      typeof sdk.pending !== "boolean"
        ? "unknown"
        : sdk.idle && !sdk.pending
          ? "clear"
          : "busy";
    const valid = current(id) && todo !== undefined && Array.isArray(todo.tasks);
    return {
      identity: id,
      sdk,
      todo,
      state,
      sources,
      busy: valid ? combineRecoveryBusy(Object.values(sources)) : "unknown",
    };
  };
  return {
    readHostSnapshot,
    onTuiInput(event, ctx) {
      if (!current(ctx) || !current(identity()) || ctx.mode !== "tui" || !event || typeof event !== "object")
        return false;
      const input = event as { type?: unknown; source?: unknown };
      if (input.type !== "input" || input.source !== "interactive" || events.has(event)) return false;
      events.add(event); // Weak: no lifetime 256-input denial and no retention of input text.
      return arrive();
    },
    onWebArrival(admission) {
      if (!current(admission) || !current(identity()) || !admission.cmdId) return false;
      if (safely(() => deps.takeAcceptedWebCommand?.(admission.cmdId)) !== "fresh") return false;
      return arrive();
    },
    dispose() {
      disposed = true;
    },
  };
}
