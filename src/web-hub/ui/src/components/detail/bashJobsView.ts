/**
 * bash-jobs-panel plan §3 包 B (D4): pure view-logic for the detail header's background
 * bash-jobs panel. `bashJobsOf` narrows `AgentState.status.bashJobs` (a deliberately loose
 * `Record<string, unknown>` in `types.ts`, P0-frozen) to the `BashJobsWire` shape declared in
 * `@protocol/messages.js` — same posture as `worktreesView.ts`'s `worktreesOf` (the status
 * reducer replaces `agent.status` wholesale, so the panel reads the slot directly and
 * `state.js`/`types.ts` stay untouched, plan §0).
 *
 * Render rules the component consumes from here:
 * - a wire with no `rows` array (or an empty one) renders NO panel at all — same empty-state
 *   ruling as `TodoPanel`/`WorktreePanel` (absent ⇒ no background jobs / bash-jobs disabled /
 *   web-hub disabled / source missing, D5);
 * - `status` is an OPEN string on the wire (plan §2: a future status value must not be dropped
 *   by an older peer): `statusToken` maps the known lifecycle literals (`src/bash/types.ts`'s
 *   `JOB_STATUSES`) and falls back to a generic token that still shows the raw status text;
 * - freshness is AGENT-JUDGED (D3-3): the UI never compares `tailBytes`/`logBytes` itself, it
 *   only reads `tailCurrent` / `tailUnavailable` plus the `sampledAt - tailAt` age (same agent
 *   clock on both sides, so the subtraction is meaningful) for the `tail Ns old` marker;
 * - unknown future row/body fields (open schema, D5) are never read, so they never reach the DOM.
 */
import type { BashJobRowWire, BashJobsWire } from "@protocol/messages.js";
import type { AgentState } from "../../types.js";
import type { IconName } from "../../icons/names.js";
import { statusOf } from "./agentViews.js";

/** The wire when it exists and carries at least one row; `undefined` ⇒ render nothing. */
export function bashJobsOf(agent: Pick<AgentState, "status">): BashJobsWire | undefined {
  const w = statusOf(agent)?.bashJobs;
  if (w === null || typeof w !== "object") return undefined;
  if (!Array.isArray(w.rows) || w.rows.length === 0) return undefined;
  return w;
}

/** Collapsed-summary counts (D4: `bash 2 running · 5 done · 1 failed`). `done` is derived:
 * `total`/`running`/`failed` are full-population counts over the selected set (plan §2), so
 * the remainder is the successful/other terminal count. Clamped against malformed frames. */
export interface BashJobsSummaryCounts {
  readonly running: number;
  readonly done: number;
  readonly failed: number;
}

export function summaryCounts(wire: BashJobsWire): BashJobsSummaryCounts {
  const running = typeof wire.running === "number" && Number.isFinite(wire.running) ? Math.max(0, wire.running) : 0;
  const failed = typeof wire.failed === "number" && Number.isFinite(wire.failed) ? Math.max(0, wire.failed) : 0;
  const total = typeof wire.total === "number" && Number.isFinite(wire.total) ? Math.max(0, wire.total) : 0;
  return { running, failed, done: Math.max(0, total - running - failed) };
}

export type BashJobStatusKind = "running" | "done" | "failed" | "muted" | "generic";

export interface BashJobStatusToken {
  /** Compact inline marker — English-token-only in BOTH locales per the AGENTS.md UI-text rule. */
  readonly text: string;
  readonly kind: BashJobStatusKind;
  readonly icon: IconName;
  readonly spin: boolean;
  /** Non-terminal on the agent lifecycle: the elapsed display ticks locally off the wire
   * baseline (D4). Unknown future statuses are NOT live (never tick) — a new frame still
   * refreshes them via the wire's own `elapsedMs`. */
  readonly live: boolean;
}

/** Known lifecycle literals (`src/bash/types.ts`'s `JOB_STATUSES`). Display tokens are
 * English-only inline markers; the icon grammar follows TodoPanel (loader/clock/check). */
const KNOWN_STATUS: Readonly<Record<string, BashJobStatusToken>> = {
  staged: { text: "staged", kind: "muted", icon: "clock", spin: false, live: true },
  running: { text: "running", kind: "running", icon: "loader", spin: true, live: true },
  completed: { text: "done", kind: "done", icon: "check", spin: false, live: false },
  failed: { text: "failed", kind: "failed", icon: "x", spin: false, live: false },
  timed_out: { text: "timeout", kind: "failed", icon: "alert", spin: false, live: false },
  killed: { text: "killed", kind: "failed", icon: "ban", spin: false, live: false },
  exited_unknown: { text: "exited?", kind: "muted", icon: "alert", spin: false, live: false },
  orphaned: { text: "orphaned", kind: "muted", icon: "unplug", spin: false, live: false },
};

/** One row's status reduced to a display token; unknown future statuses render generic with
 * the raw wire text (open enum, plan §2 — never dropped). */
export function statusToken(row: BashJobRowWire): BashJobStatusToken {
  const status = typeof row.status === "string" ? row.status : "";
  const known = KNOWN_STATUS[status];
  if (known !== undefined) return known;
  return { text: status !== "" ? status : "?", kind: "generic", icon: "terminal", spin: false, live: false };
}

/** `tail Ns old` only beyond this age (D3-3: zombie-stuck rows have no freshness upper bound,
 * so the age marker appears only once it is meaningfully stale). */
export const TAIL_STALE_MS = 30_000;

export type TailFreshness =
  | { readonly kind: "current" } // tailCurrent: fresh — no marker
  | { readonly kind: "sampling" } // has a tail, not yet re-sampled: `sampling…` (old tail still shown)
  | { readonly kind: "stale"; readonly ageSec: number } // same, but older than TAIL_STALE_MS: `tail Ns old`
  | { readonly kind: "unavailable" } // sampler gave up (read failures ×3)
  | { readonly kind: "empty" }; // no tail and not sampling: `no output yet`

/** Row freshness, purely from the agent-judged flags (D3-3): `tailCurrent` wins over age —
 * a current tail is fresh relative to the record no matter how long ago it was sampled. */
export function tailFreshness(row: BashJobRowWire, sampledAt: number): TailFreshness {
  if (row.tailUnavailable === true) return { kind: "unavailable" };
  if (row.tailCurrent === true) return { kind: "current" };
  if (row.tail === undefined) return { kind: "empty" };
  const tailAt = row.tailAt;
  if (typeof tailAt === "number" && Number.isFinite(tailAt) && sampledAt - tailAt > TAIL_STALE_MS) {
    return { kind: "stale", ageSec: Math.floor((sampledAt - tailAt) / 1000) };
  }
  return { kind: "sampling" };
}

/** `logBytes` display (`512 B` / `12.3 KB` / `3.4 MB`); `—` for malformed values. */
export function formatBytes(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.floor(n)} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
