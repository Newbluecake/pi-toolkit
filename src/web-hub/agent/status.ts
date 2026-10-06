/**
 * Status + fleet projection (plan §包 D — status.ts).
 *
 * `readStatus` samples the live ctx (every call guarded: a stale ctx after a
 * session replacement throws, and that must stay silent). `projectFleet` reuses
 * the fleet widget's view-model (`buildFleetViewModel`) and keeps the wire
 * subset; `fleetFingerprint` strips per-second jitter (elapsed/phase ages and
 * the in-flight tool's live duration) so the 1Hz tick only sends on real change.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunSnapshot } from "../../core/types.js";
import { buildFleetViewModel, phaseLabel } from "../../ui/fleet-panel.js";
import type { FleetOmitted, FleetRowWire, StatusInfo, WorktreesWire } from "../protocol/messages.js";
import type { EventTap } from "./event-tap.js";
import type { QueueMirror } from "./queue-mirror.js";
import { projectTodo } from "./todo.js";
import type { TodoState } from "../../todo/state.js";

/** Web rows: more than the TUI widget, still bounded. */
const WEB_MAX_ACTIVE_ROWS = 64;
const WEB_RECENT_TERMINAL = 8;

export function readStatus(
  ctx: ExtensionContext,
  tap: EventTap,
  fleet: readonly RunSnapshot[],
  queueMirror?: QueueMirror,
  todo?: () => TodoState,
  worktrees?: () => WorktreesWire | undefined,
): StatusInfo {
  const status: StatusInfo = {
    leafId: safe(() => ctx.sessionManager.getLeafId(), null),
    busy: safe(() => !ctx.isIdle(), false),
    pending: safe(() => ctx.hasPendingMessages(), false),
  };
  const usage = safe(() => ctx.getContextUsage(), undefined);
  if (usage !== undefined && usage.tokens !== null && usage.percent !== null) {
    status.contextUsage = { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent };
  }
  const cost = tap.costUsd();
  if (Number.isFinite(cost)) status.costUsd = cost;
  let sub = 0;
  let anySub = false;
  for (const s of fleet) {
    const c = s.diag.usage?.costUsd;
    if (typeof c === "number" && Number.isFinite(c)) {
      sub += c;
      anySub = true;
    }
  }
  if (anySub) status.subagentCostUsd = sub;
  if (queueMirror !== undefined) {
    const items = queueMirror.items();
    if (items.length > 0) status.queue = items.slice();
    const dropped = queueMirror.takeDropped();
    if (dropped.length > 0) status.queueDropped = dropped;
  }
  // todo-web plan §3.3 (T3): sampled in the same call as busy/leafId/queue so the
  // browser never sees a torn "new leaf + stale todo" pair. No getter (todo
  // disabled / child session) ⇒ field absent, byte-equal to the pre-feature shape.
  if (todo !== undefined) {
    const projected = projectTodo(todo());
    if (projected !== undefined) status.todo = projected;
  }
  // worktree-web plan §4.4 (W3): sampled in the same call, same overwrite-only-slot
  // rationale as todo above — no getter (session cwd not a git repo / not sampled
  // yet / web-hub off) ⇒ the field stays absent, byte-equal to the pre-feature shape.
  if (worktrees !== undefined) {
    const wire = worktrees();
    if (wire !== undefined) status.worktrees = wire;
  }
  return status;
}

export function projectFleet(
  snaps: readonly RunSnapshot[],
  now: number,
  typeOf?: (id: string) => string | undefined,
): FleetProjection {
  const vm = buildFleetViewModel(snaps, {
    now,
    maxActiveRows: WEB_MAX_ACTIVE_ROWS,
    recentTerminal: WEB_RECENT_TERMINAL,
    ...(typeOf !== undefined ? { typeOf } : {}),
  });
  const byId = new Map(snaps.map((s) => [s.runId, s]));
  const rows = vm.rows.map((r) => {
    const row: FleetRowWire = {
      runId: r.runId,
      status: r.status,
      // Static label (no animated thinking frame): the browser animates itself,
      // and a per-second frame would defeat the fingerprint.
      phaseLabel: phaseLabel(r.phase, byId.get(r.runId)?.diag),
      elapsedMs: r.elapsedMs,
      phaseMs: r.phaseMs,
      highlight: r.highlight,
      terminal: r.terminal,
    };
    if (r.label !== undefined) row.label = r.label;
    if (r.type !== undefined) row.type = r.type;
    if (r.model !== undefined) row.model = r.model;
    if (r.parentRunId !== undefined) row.parentRunId = r.parentRunId;
    if (r.usage !== undefined) row.costUsd = r.usage.costUsd;
    if (r.toolTrail !== undefined) row.toolTrail = r.toolTrail;
    if (r.streamLine !== undefined) row.streamLine = r.streamLine;
    return row;
  }) as FleetProjection;
  // fleet-drawer §4.4/#12: rows the 64-active/8-terminal caps dropped, so the browser can
  // render "N more not listed". Absent when nothing was omitted.
  const omittedActive = vm.activeCount - vm.shownActiveCount;
  const omittedTerminal = vm.totalCount - vm.activeCount - (vm.rows.length - vm.shownActiveCount);
  if (omittedActive > 0 || omittedTerminal > 0) rows.omitted = { active: omittedActive, terminal: omittedTerminal };
  return rows;
}

/** `projectFleet`'s return: the wire rows plus the optional §3.2/#12 omission counts. */
export type FleetProjection = FleetRowWire[] & { omitted?: FleetOmitted };

/** In-flight tool segment's live duration suffix (`▸bash npm test · 3s`, `· 1m05s`, `· 250ms`). */
const LIVE_DURATION_RE = / · \d+(?:ms|s|m\d{2}s|h\d{2}m)$/;

export function fleetFingerprint(rows: readonly FleetRowWire[]): string {
  // fleet-drawer §4.4: the omission counts ride the fingerprint too — a run settling into
  // or out of the truncated tail must flip it even when the visible rows are unchanged.
  const omitted = (rows as FleetProjection).omitted;
  return JSON.stringify({
    rows: rows.map((r) => {
      const { elapsedMs: _e, phaseMs: _p, toolTrail, ...rest } = r;
      return toolTrail === undefined ? rest : { ...rest, toolTrail: toolTrail.replace(LIVE_DURATION_RE, "") };
    }),
    ...(omitted !== undefined ? { omitted } : {}),
  });
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
