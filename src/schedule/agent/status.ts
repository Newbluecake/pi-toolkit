/**
 * Scheduled tasks — TUI status bar (plan r3 §5.4; A3). Key `pi-subagent:schedule`
 * (`SCHED_STATUS_KEY`). English tokens only (AGENTS.md UI language split):
 *   `sched 2 · next 08:00 · run 1 · pending 1 · busy · msg off`
 * Shown only for an interactive session that owns at least one task; otherwise the key is cleared.
 */
import type { Clock, TimerHandle } from "../../core/clock.js";
import { nextOccurrence } from "../core/cron.js";
import { compileTask } from "../core/occurrence.js";
import { isApproved, isExecutable, isTerminalRunState, type ScheduleStateFile } from "../core/spec.js";
import type { XsHostCapabilityState } from "../../fabric/xs/host-cap.js";
import type { ScheduleAgent } from "./wire.js";

export const SCHED_STATUS_REFRESH_MS = 15_000;

function localParts(at: number, tz: string): { day: string; hm: string; md: string } | undefined {
  try {
    const f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const o: Record<string, string> = {};
    for (const p of f.formatToParts(new Date(at))) o[p.type] = p.value;
    return { day: `${o.year}-${o.month}-${o.day}`, hm: `${o.hour}:${o.minute}`, md: `${o.month}-${o.day}` };
  } catch {
    return undefined;
  }
}

/** Earliest next occurrence over the executable tasks, rendered in that task's own tz. */
export function nextLabel(state: ScheduleStateFile, now: number): string | undefined {
  let best: { at: number; tz: string } | undefined;
  for (const t of state.tasks) {
    if (!isExecutable(t)) continue;
    const c = compileTask(t);
    const at = c === undefined ? undefined : nextOccurrence(c, now);
    if (at !== undefined && (best === undefined || at < best.at)) best = { at, tz: t.when.tz };
  }
  if (best === undefined) return undefined;
  const p = localParts(best.at, best.tz);
  if (p === undefined) return undefined;
  const today = localParts(now, best.tz);
  return today !== undefined && today.day === p.day ? p.hm : `${p.md} ${p.hm}`;
}

export interface StatusFacts {
  state: ScheduleStateFile | undefined;
  now: number;
  /** The clock reports the ledger as degraded / unreachable (lock held across hosts, unreadable …). */
  busy: boolean;
  capability: XsHostCapabilityState;
}

/** `undefined` ⇒ clear the status key. */
export function renderStatus(f: StatusFacts): string | undefined {
  const st = f.state;
  if (st === undefined || st.tasks.length === 0) return undefined;
  const parts = [`sched ${st.tasks.length}`];
  const next = nextLabel(st, f.now);
  if (next !== undefined) parts.push(`next ${next}`);
  const running = st.runs.filter((r) => !isTerminalRunState(r.state)).length;
  if (running > 0) parts.push(`run ${running}`);
  const pending = st.tasks.filter((t) => !isApproved(t)).length;
  if (pending > 0) parts.push(`pending ${pending}`);
  if (f.busy) parts.push("busy");
  const usesMsg = st.tasks.some((t) => t.form === "message" || t.bg?.handoff === true);
  if (usesMsg && f.capability === "absent") parts.push("msg off");
  else if (usesMsg && f.capability === "unknown" && st.runs.some((r) => r.state === "queued")) parts.push("msg ?");
  return parts.join(" · ");
}

export interface ScheduleStatusDeps {
  agent(): ScheduleAgent | undefined;
  /** `ctx.ui.setStatus(SCHED_STATUS_KEY, text)`; `undefined` clears. May throw (stale ctx) — swallowed. */
  setStatus(text: string | undefined): void;
  capability(): XsHostCapabilityState;
  clock: Clock;
}

export interface ScheduleStatus {
  refresh(): void;
  /** Arm the unref'd re-render timer (next-run time and run counts drift without any event). */
  start(): void;
  dispose(): void;
}

export function createScheduleStatus(deps: ScheduleStatusDeps): ScheduleStatus {
  let disposed = false;
  let last: string | undefined; // undefined ⇒ the bar is clear (initially, and after a clear)
  let timer: TimerHandle | undefined;

  const refresh = (): void => {
    if (disposed) return;
    let text: string | undefined;
    try {
      const agent = deps.agent();
      if (agent !== undefined && agent.mode.kind === "interactive" && !agent.isDisposed()) {
        const r = agent.readState();
        text = renderStatus({
          state: r.kind === "ok" ? r.state : undefined,
          now: deps.clock.now(),
          busy: r.kind === "degraded" || agent.clock?.status().degraded !== undefined,
          capability: deps.capability(),
        });
      }
    } catch {
      return; // never let a status render break a turn
    }
    if (text === last) return;
    last = text;
    try {
      deps.setStatus(text);
    } catch {
      /* stale ctx — the next session_start rebuilds the controller */
    }
  };

  const arm = (): void => {
    if (disposed) return;
    timer = deps.clock.setTimer(SCHED_STATUS_REFRESH_MS, () => {
      timer = undefined;
      refresh();
      arm();
    });
  };

  return {
    refresh,
    start() {
      refresh();
      if (timer === undefined) arm();
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) deps.clock.clearTimer(timer);
      timer = undefined;
      if (last !== undefined) {
        try {
          deps.setStatus(undefined);
        } catch {
          /* stale ctx */
        }
      }
      last = undefined;
    },
  };
}
