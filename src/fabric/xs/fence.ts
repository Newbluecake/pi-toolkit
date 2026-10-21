/**
 * fabric phase-2 T1 (phase2-plan §7, r3 主会话裁定 M1 — the ruling OVERRIDES the §7.2 table
 * rows it deletes): the per-stack session-change fence every cross-session dispatch (including
 * deliver-only) must pass BEFORE touching the receiving session. A custom message written while
 * the session is being replaced / compacted / switched away lands in a context that is about to
 * vanish, while the sender already holds `applied` — so every session-change window REJECTS.
 *
 * M1 (2026-10-21, 评审收敛): the fence opens ONLY on
 *   1. a REAL completion event (success / failure / cancel each have their own event:
 *      `session_compact`, `session_compact_failed`, `session_tree`, `session_shutdown`), or
 *   2. `session_start` (the stack is rebuilt around a live session), or
 *   3. a human-local `/fabric fence reset` (`reset()`).
 * The r2 inference "a later `input` / `before_agent_start` / run start proves the switch was
 * cancelled" is DELETED — while a `session_before_switch` handler is still awaiting, the old
 * session keeps accepting input and starting runs (pi `prompt()` has no such mutex), so those
 * events are accepted here but deliberately IGNORED. No terminal evidence ⇒ keep rejecting;
 * the 30s stuck timer only marks + warns, it never opens the fence. The r2 "completion event +
 * `setTimeout(0)` proves the controller is cleaned" claim is likewise deleted: completion
 * events close their window SYNCHRONOUSLY inside `onEvent`, and every dispatch re-verifies
 * `sessionGen` + fence state in the SAME synchronous block via `beginDispatch()` /
 * `verifyDispatch()` (§7.4) — never depending on an async chain having drained.
 *
 * Windows (open → close evidence, M1-amended):
 *   compaction : `session_before_compact` → `session_compact` | `session_compact_failed` | `session_start`
 *   tree       : `session_before_tree`    → `session_tree` | `session_start`   (a cancelled
 *                `session_before_tree` has NO completion event at all (Fpi9) ⇒ stays closed
 *                until `session_start` / reset — stuck after 30s, still rejecting)
 *   switch     : `session_before_switch` | `session_before_fork` → `session_shutdown` |
 *                `session_start` (same no-event cancel path; a slow async before_switch
 *                handler keeps the window closed — correct: the switch really is in progress)
 *   web_exec / topic_switch / goal : late-bound read-only ports, read at CHECK time
 *                (`undefined` = inactive, `true` = active, THROWS = active — fail closed).
 *                `goal` active only downgrades a wake (`wakeOnly`), it never rejects delivery.
 *
 * Zero-hang: the fence never makes a caller wait — a hit returns synchronously; `stuck` only
 * costs the sender a `none` it may retry later. Pi-free by construction (XS0 source-scan gate:
 * `src/fabric/xs/**` must not import pi); the XW integration package is the only place that
 * forwards real pi events into `onEvent` and wires the three ports.
 */
import type { Clock, TimerHandle } from "../../core/clock.js";
import { systemClock } from "../../core/clock.js";

export type FenceName = "compaction" | "tree" | "switch" | "web_exec" | "topic_switch" | "goal";
export type FenceReason = `fenced:${FenceName}`;

export type FenceVerdict = { ok: true } | { ok: false; reason: FenceReason; wakeOnly?: true };

/**
 * Dispatch-point protocol (M1 / §7.4): the receiver pipeline calls `beginDispatch()` BEFORE
 * `pi.sendMessage(...)`, then `verifyDispatch(gen)` AFTER the synchronous evidence observation —
 * all inside ONE synchronous block, no awaits between. Any `ok:false` from either call means the
 * write is not provably applied to the live session (reject before the send, or discard the
 * evidence after it). `gen_changed` = the session identity moved underneath the dispatch
 * (`session_start` / `session_shutdown` fired mid-dispatch) — exactly the case the deleted
 * `setTimeout(0)` used to paper over: a completion event whose LATER handlers are still
 * long-awaiting.
 */
export type FenceDispatchReason = FenceReason | "gen_changed";
export type FenceDispatchVerdict =
  { ok: true; gen: number } | { ok: false; reason: FenceDispatchReason; wakeOnly?: true };

/** pi events the fence understands (XW maps real pi events onto this union; extras are dropped).
 *  `input` / `before_agent_start` are members ON PURPOSE: M1 deleted them as close evidence, so
 *  the fence ACCEPTS them (XW may forward verbatim) and deliberately ignores them. */
export type FenceEvent =
  | { type: "session_before_compact" }
  | { type: "session_compact" }
  | { type: "session_compact_failed" }
  | { type: "session_before_tree" }
  | { type: "session_tree" }
  | { type: "session_before_switch" }
  | { type: "session_before_fork" }
  | { type: "session_shutdown" }
  | { type: "session_start" }
  | { type: "input" } // M1: ignored — human input during a slow before_switch proves nothing
  | { type: "before_agent_start" }; // M1: ignored — run start proves nothing either

/** Late-bound port (§7.2): `undefined`/`false` = inactive, `true` = active, THROWS = active. */
export type FencePort = () => boolean | undefined;

export interface FencePorts {
  /** web resume exec (`switchInFlight()` ∨ exec claim held) — getter owned by X2. */
  webExec?: FencePort;
  /** topic-switch pending hold ∨ B1 mid-switch marker (`wire.ts`'s read-only `fenceActive()`). */
  topicSwitch?: FencePort;
  /** /goal loop running ⇒ `wakeOnly` (downgrade wake, never reject). */
  goal?: FencePort;
}

export interface FenceStatus {
  /** Currently active windows: open event windows + live-read ports, in FenceName order. */
  open: FenceName[];
  /** Event windows open past `stuckAfterMs` (ports have no age; they are never "stuck"). */
  stuck: FenceName[];
  /** Age in ms of the oldest OPEN event window; absent when none is open. */
  oldestOpenMs?: number;
}

export interface SessionFence {
  /** pi events forwarded by the XW assembly. Idempotent per window; ignored after dispose. */
  onEvent(e: FenceEvent): void;
  /** Synchronous gate: `ok:false` ⇒ reject the delivery (or downgrade, when `wakeOnly`). */
  check(): FenceVerdict;
  /** Current session generation — bumped by `session_start` / `session_shutdown` only. */
  generation(): number;
  /** Dispatch-point guard (M1): snapshot of check() + gen, taken before `pi.sendMessage`. */
  beginDispatch(): FenceDispatchVerdict;
  /** Dispatch-point recheck (M1): same synchronous block, AFTER the evidence observation. */
  verifyDispatch(gen: number): FenceDispatchVerdict;
  status(): FenceStatus;
  /** `/fabric fence reset` — LOCAL human action only (web invocations are refused upstream). */
  reset(): void;
  /** Stack teardown: cancel stuck timers, ignore further events; last state stays readable. */
  dispose(): void;
}

export interface SessionFenceOptions {
  ports?: FencePorts;
  /** Default `systemClock` (its timers unref — a ref'd timer wedges `pi -p`). */
  clock?: Clock;
  /** Default 30s (§7.3). Marking stuck NEVER opens the window; injectable for tests only. */
  stuckAfterMs?: number;
  /** Default `console.warn`; fires exactly once per stuck episode. */
  warn?: (message: string) => void;
}

const EVENT_WINDOW_ORDER = ["compaction", "tree", "switch"] as const;
type EventWindowName = (typeof EVENT_WINDOW_ORDER)[number];

interface EventWindow {
  openedAt: number;
  stuck: boolean;
  /** Armed at open, cleared on close; firing only marks stuck + warns once. */
  timer: TimerHandle | undefined;
}

/** Default stuck horizon (§7.3): warn + mark, keep rejecting. */
export const FENCE_STUCK_AFTER_MS = 30_000;

export function createSessionFence(options: SessionFenceOptions = {}): SessionFence {
  const clock: Clock = options.clock ?? systemClock;
  const stuckAfterMs: number = options.stuckAfterMs ?? FENCE_STUCK_AFTER_MS;
  const warn: (message: string) => void = options.warn ?? ((message) => console.warn(message));
  const ports = options.ports ?? {};
  const windows = new Map<EventWindowName, EventWindow>();
  let gen = 0;
  let disposed = false;

  /** Fail-closed port read (§7.2): a thrown port is an ACTIVE window. */
  function portActive(port: FencePort | undefined): boolean {
    if (port === undefined) return false;
    try {
      return port() === true;
    } catch {
      return true;
    }
  }

  function open(name: EventWindowName): void {
    if (disposed) return;
    const existing = windows.get(name);
    if (existing !== undefined) {
      // A second open while the first never completed keeps the ORIGINAL openedAt (the stuck
      // clock never restarts) and never arms a second timer.
      return;
    }
    const window: EventWindow = { openedAt: clock.now(), stuck: false, timer: undefined };
    window.timer = clock.setTimer(stuckAfterMs, () => {
      // §7.3: timeout only marks + warns — the window stays closed (still rejecting).
      window.timer = undefined;
      window.stuck = true;
      const ageSeconds = Math.max(0, Math.round((clock.now() - window.openedAt) / 1000));
      warn(
        `[pi-subagent] fabric fence stuck: ${name} open ${ageSeconds}s — still rejecting cross-session deliveries; /fabric fence reset to clear (local only)`,
      );
    });
    windows.set(name, window);
  }

  function close(name: EventWindowName): void {
    const window = windows.get(name);
    if (window === undefined) return;
    if (window.timer !== undefined) {
      try {
        clock.clearTimer(window.timer);
      } catch {
        /* best-effort */
      }
    }
    windows.delete(name);
  }

  function check(): FenceVerdict {
    // Fixed deterministic order: event windows first, then ports; a rejecting window always
    // wins over `goal`'s wakeOnly downgrade.
    for (const name of EVENT_WINDOW_ORDER) {
      if (windows.has(name)) return { ok: false, reason: `fenced:${name}` };
    }
    if (portActive(ports.webExec)) return { ok: false, reason: "fenced:web_exec" };
    if (portActive(ports.topicSwitch)) return { ok: false, reason: "fenced:topic_switch" };
    if (portActive(ports.goal)) return { ok: false, reason: "fenced:goal", wakeOnly: true };
    return { ok: true };
  }

  return {
    onEvent(e: FenceEvent): void {
      if (disposed) return;
      switch (e.type) {
        case "session_before_compact":
          open("compaction");
          return;
        case "session_compact":
        case "session_compact_failed":
          close("compaction");
          return;
        case "session_before_tree":
          open("tree");
          return;
        case "session_tree":
          close("tree");
          return;
        case "session_before_switch":
        case "session_before_fork":
          open("switch");
          return;
        case "session_shutdown":
          close("switch");
          gen += 1; // the session identity under any in-flight dispatch guard is gone
          return;
        case "session_start":
          // Stack-rebuild evidence: closes EVERY event window (fresh state, §7.2).
          for (const name of EVENT_WINDOW_ORDER) close(name);
          gen += 1;
          return;
        case "input":
        case "before_agent_start":
          // M1: deliberately ignored. Human input / run start during a slow before_switch
          // handler does NOT prove the switch was cancelled — pi's prompt() keeps accepting
          // input into the OLD session while the switch handler chain is still awaiting.
          return;
      }
    },
    check,
    generation(): number {
      return gen;
    },
    beginDispatch(): FenceDispatchVerdict {
      const verdict = check();
      return verdict.ok ? { ok: true, gen } : verdict;
    },
    verifyDispatch(snapshotGen: number): FenceDispatchVerdict {
      if (snapshotGen !== gen) return { ok: false, reason: "gen_changed" };
      const verdict = check();
      return verdict.ok ? { ok: true, gen } : verdict;
    },
    status(): FenceStatus {
      const openNames: FenceName[] = [];
      let oldestOpenMs: number | undefined;
      const stuckNames: FenceName[] = [];
      for (const name of EVENT_WINDOW_ORDER) {
        const window = windows.get(name);
        if (window === undefined) continue;
        openNames.push(name);
        if (window.stuck) stuckNames.push(name);
        const age = Math.max(0, clock.now() - window.openedAt);
        if (oldestOpenMs === undefined || age > oldestOpenMs) oldestOpenMs = age;
      }
      if (portActive(ports.webExec)) openNames.push("web_exec");
      if (portActive(ports.topicSwitch)) openNames.push("topic_switch");
      if (portActive(ports.goal)) openNames.push("goal");
      return oldestOpenMs === undefined
        ? { open: openNames, stuck: stuckNames }
        : { open: openNames, stuck: stuckNames, oldestOpenMs };
    },
    reset(): void {
      // Local human action: closes every window (clearing stuck), but does NOT bump gen — the
      // session identity is unchanged, so in-flight dispatch guards stay valid.
      for (const name of EVENT_WINDOW_ORDER) close(name);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Cancel armed stuck timers (nothing may fire into a dead stack); the window records
      // stay so a disposed-but-consulted fence keeps reporting its last state — fail closed.
      for (const window of windows.values()) {
        if (window.timer !== undefined) {
          try {
            clock.clearTimer(window.timer);
          } catch {
            /* best-effort */
          }
          window.timer = undefined;
        }
      }
    },
  };
}
