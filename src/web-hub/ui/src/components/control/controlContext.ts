/**
 * Control-plane injection keys (control-plan.md v2.1 §7.1/§7.4, §12.3 — C5 exclusive,
 * `components/control/**`).
 *
 * Why three keys:
 * - `HUB_CTX` — App.vue provides the live `HubHandle` exactly once. `TopBar` (the
 *   Read-only/Control chip), `HubStateBanner` (hub state) and `AgentCard` (needs-answer badge)
 *   are NOT descendants of `AgentDetail`, and their frozen `contracts.ts` props have no
 *   hub/control field — inject is the only channel that doesn't touch the frozen surface.
 * - `CONTROL_ENV` — App.vue-provided auth environment (notice copy variant, §7.6) plus the
 *   cross-agent ask_user draft map (§3.5 draft key `(agentKey, epoch, dialogId)`) and the
 *   shared ControlNotice expand state the TopBar chip toggles.
 * - `CONTROL_VIEW` — AgentDetail-provided per-agent view (reactive `agent`, `busy`, `commands`,
 *   queue merge, web-badge matcher) consumed by `DetailDock`/`Composer`/`AskUserForm`. The
 *   frozen `DetailDockEmits` has no `send/stop/retry/discard` events, so the dock calls the
 *   `ControlHandle` through this channel directly instead of emitting up.
 *
 * `CONTROL_CTX` (the FROZEN key from `composables/useControl.ts`, `{agentKey, control,
 * enabled}`) is separately provided by AgentDetail for `FleetActions` — plan §7.4's explicit
 * provide/inject seam for sub-agent ops, kept byte-identical to its frozen shape.
 */
import type { ComputedRef, InjectionKey, Ref } from "vue";
import type { AgentState, ControlHandle, HubHandle } from "../../types.js";

export const HUB_CTX: InjectionKey<HubHandle> = Symbol("web-hub-hub");

export interface ControlEnv {
  readonly authMode: "token" | "password";
  /** §7.6: plaintext source mirrors the LAN notice rule (password mode over http:). */
  readonly plaintext: boolean;
  /** ask_user selection drafts, keyed `${agentKey}|${epoch}|${dialogId}` (§3.5). */
  readonly dialogDrafts: Map<string, unknown>;
  /** Shared ControlNotice expanded state — the TopBar Control chip toggles it (§7.4). */
  readonly noticeExpanded: Ref<boolean>;
}
export const CONTROL_ENV: InjectionKey<ControlEnv> = Symbol("web-hub-control-env");

/** Reactive per-agent control view provided by `AgentDetail` (see this file's header). */
export interface ControlView {
  readonly agentKey: string;
  /** `null` when the hub never negotiated `cmd.v1` (`HubHandle.control` absent). */
  readonly control: ControlHandle | null;
  /** Hub `cmd.v1` ∧ agent card `control` ∧ agent live (not down/stale). */
  readonly enabled: ComputedRef<boolean>;
  /** i18n key of the read-only reason when `enabled` is false (§7.4 DetailDock table). */
  readonly readonlyReason: ComputedRef<string | null>;
  readonly agent: ComputedRef<AgentState>;
  readonly busy: ComputedRef<boolean>;
  /** The agent's `commands` slot rows (§4.6 commands frame items). */
  readonly commands: ComputedRef<readonly Record<string, unknown>[]>;
  /** §7.7: command mode needs the agent's `command.v1` slot, not just `cmd.v1`. */
  readonly commandsEnabled: ComputedRef<boolean>;
  /** Any optimistic pendingCtl item currently in `sending` (Composer's send-button gate). */
  readonly sending: ComputedRef<boolean>;
  /** §7.4 QueueList model: `mergeQueue(agent.queue, agent.pendingCtl)`. */
  readonly queueItems: ComputedRef<readonly unknown[]>;
  /** §7.7 transcript web badge: best-effort ctl-slot timestamp match; false on any doubt. */
  readonly isWebMessage: (timestamp: number | undefined) => boolean;
}
export const CONTROL_VIEW: InjectionKey<ControlView> = Symbol("web-hub-control-view");

/** Read-only detail metrics (context usage + cost) provided by `AgentDetail` for the
 * composer's `ContextRing` (2026-10-05, user 现场拍板: the context meter moved OUT of the
 * detail header INTO the composer as a ring indicator with a click-through details panel).
 * Inject-only so the frozen `ComposerProps` stay untouched — no provider (dashboard, read-only
 * dock) or a `contextUsage` that never arrived ⇒ the ring renders nothing, zero errors. */
export interface DetailMetricsView {
  readonly contextUsage: ComputedRef<{ tokens: number; contextWindow: number; percent: number } | undefined>;
  readonly costUsd: ComputedRef<number | undefined>;
  readonly subagentCostUsd: ComputedRef<number | undefined>;
}
export const DETAIL_METRICS: InjectionKey<DetailMetricsView> = Symbol("web-hub-detail-metrics");

/** §3.5 ask_user draft key. */
export function dialogDraftKey(agentKey: string, epoch: string, dialogId: string): string {
  return [agentKey, epoch, dialogId].join("\u0000");
}
