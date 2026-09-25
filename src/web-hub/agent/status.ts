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
import type { FleetRowWire, StatusInfo } from "../protocol/messages.js";
import type { EventTap } from "./event-tap.js";

/** Web rows: more than the TUI widget, still bounded. */
const WEB_MAX_ACTIVE_ROWS = 64;
const WEB_RECENT_TERMINAL = 8;

export function readStatus(ctx: ExtensionContext, tap: EventTap, fleet: readonly RunSnapshot[]): StatusInfo {
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
  return status;
}

export function projectFleet(
  snaps: readonly RunSnapshot[],
  now: number,
  typeOf?: (id: string) => string | undefined,
): FleetRowWire[] {
  const vm = buildFleetViewModel(snaps, {
    now,
    maxActiveRows: WEB_MAX_ACTIVE_ROWS,
    recentTerminal: WEB_RECENT_TERMINAL,
    ...(typeOf !== undefined ? { typeOf } : {}),
  });
  const byId = new Map(snaps.map((s) => [s.runId, s]));
  return vm.rows.map((r) => {
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
  });
}

/** In-flight tool segment's live duration suffix (`▸bash npm test · 3s`, `· 1m05s`, `· 250ms`). */
const LIVE_DURATION_RE = / · \d+(?:ms|s|m\d{2}s|h\d{2}m)$/;

export function fleetFingerprint(rows: readonly FleetRowWire[]): string {
  return JSON.stringify(
    rows.map((r) => {
      const { elapsedMs: _e, phaseMs: _p, toolTrail, ...rest } = r;
      return toolTrail === undefined ? rest : { ...rest, toolTrail: toolTrail.replace(LIVE_DURATION_RE, "") };
    }),
  );
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
