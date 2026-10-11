import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LoadSettings } from "../config/settings.js";
import { buildLoadEscalationText, buildLoadRecoveryText } from "./render.js";
import type { LoadLevel, LoadPort, LoadTransition, TopSnapshot } from "./types.js";

export const LOAD_CUSTOM_TYPE = "subagent:load";

export interface LoadHintState {
  readonly latches: Map<LoadLevel, number>;
  lastSentAt: number;
  hasSent: boolean;
  recoveryPending: boolean;
  rejectedSinceRecovery: boolean;
}

export interface LoadHintDeps {
  readonly settings: LoadSettings;
  readonly port: () => LoadPort | undefined;
  readonly transition?: () => LoadTransition | undefined;
  readonly state?: () => LoadHintState;
  readonly sendMessage: (
    message: { customType: string; content: string; display: boolean; details: unknown },
    options: { triggerTurn: false },
  ) => void;
  readonly now?: () => number;
  readonly context?: () => { ownRuns?: readonly string[] };
}

export function createLoadHintState(): LoadHintState {
  return {
    latches: new Map(),
    lastSentAt: 0,
    hasSent: false,
    recoveryPending: false,
    rejectedSinceRecovery: false,
  };
}

export function createLoadHintHook(deps: LoadHintDeps): (event: unknown, ctx: ExtensionContext) => void {
  const state = deps.state?.() ?? createLoadHintState();
  const now = deps.now ?? (() => Date.now());
  let previous: LoadLevel = "unknown";
  let recoveryImmediate = false;
  return (_event, ctx): void => {
    if (ctx.mode === "print" || ctx.mode === "json" || !deps.settings.enabled || !deps.settings.hint.enabled) return;
    const port = deps.port();
    if (port === undefined) return;
    let verdict;
    try {
      verdict = port.verdict();
    } catch {
      return;
    }
    const transition = deps.transition?.();
    if (
      transition?.provenRecovered === true &&
      !state.recoveryPending &&
      (state.rejectedSinceRecovery ||
        [...state.latches.keys()].some((level) => rank(level) >= rank(deps.settings.gateLevel)))
    ) {
      state.recoveryPending = true;
      recoveryImmediate = true;
    }
    const previousBefore = previous;
    if (verdict.level !== "unknown" && rank(verdict.level) >= rank(deps.settings.gateLevel))
      state.recoveryPending = false;
    const t = now();
    // Only an escalation INTO warn/crit is news. `ok` is never announced as an escalation — in
    // particular the very first known sample after activation (`previous` starts at "unknown")
    // used to fire a "系统负载过高" hint on a perfectly idle machine.
    const rose =
      rank(verdict.level) >= rank("warn") && (previous === "unknown" || rank(verdict.level) > rank(previous));
    const critRepeat =
      verdict.level === "crit" &&
      state.latches.get("crit") !== undefined &&
      t - state.latches.get("crit")! >= deps.settings.hint.repeatMs;
    const normalAllowed = !state.hasSent || t - state.lastSentAt >= deps.settings.hint.minIntervalMs;
    const recovery =
      state.recoveryPending && !verdict.gating && verdict.level !== "unknown" && (recoveryImmediate || normalAllowed);
    const announce = recovery || ((rose || critRepeat) && (normalAllowed || verdict.level === "crit"));
    previous = verdict.level;
    if (!announce) return;
    const context = deps.context?.();
    const content = recovery
      ? buildLoadRecoveryText(verdict, deps.settings.gate)
      : buildLoadEscalationText(verdict, {
          ...(context?.ownRuns === undefined ? {} : { ownRuns: context.ownRuns }),
          ...topContext(port),
        });
    if (recovery && recoveryImmediate) recoveryImmediate = false;
    try {
      deps.sendMessage(
        {
          customType: LOAD_CUSTOM_TYPE,
          content,
          display: deps.settings.hint.display,
          details: { level: verdict.level, gating: verdict.gating },
        },
        { triggerTurn: false },
      );
      state.lastSentAt = t;
      state.hasSent = true;
      if (recovery) {
        state.recoveryPending = false;
        state.rejectedSinceRecovery = false;
      } else state.latches.set(verdict.level, t);
    } catch {
      previous = previousBefore;
      // State is intentionally not advanced on a failed send; next turn retries.
    }
  };
}

function topContext(port: LoadPort): { top?: TopSnapshot } {
  try {
    const top = port.top();
    // Fire-and-forget: the hint never waits on a scan; a later message sees the fresher snapshot.
    port.refreshTop();
    return top === undefined ? {} : { top };
  } catch {
    return {};
  }
}

function rank(level: LoadLevel): number {
  return level === "unknown" ? -1 : level === "ok" ? 0 : level === "warn" ? 1 : 2;
}
