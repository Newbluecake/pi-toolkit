/**
 * Status + fleet projection (plan §包 D — status.ts).
 *
 * `readStatus` samples the live ctx (every call guarded: a stale ctx after a
 * session replacement throws, and that must stay silent). `projectFleet` reuses
 * the fleet widget's view-model (`buildFleetViewModel`) and keeps the wire
 * subset; `fleetFingerprint` strips per-second jitter (elapsed/phase ages and
 * the in-flight tool's live duration) so the 1Hz tick only sends on real change.
 */
import { Buffer } from "node:buffer";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunArchiveDisplayView } from "../../archive/control.js";
import { isTerminalStatus } from "../../core/status.js";
import type { RunSnapshot } from "../../core/types.js";
import { buildFleetViewModel, phaseLabel } from "../../ui/fleet-panel.js";
import type {
  ArchiveWire,
  BashJobsWire,
  FleetOmitted,
  FleetRowWire,
  HeldItemWire,
  QuotaWire,
  CacheKeepaliveWire,
  StatusInfo,
  ThreadStatusSlotWire,
  WorktreesWire,
} from "../protocol/messages.js";
import { STATUS_FEATURES_MAX_CHARS, STATUS_FEATURES_MAX_ITEMS } from "../protocol/messages.js";
import type { EventTap } from "./event-tap.js";
import type { QueueMirror } from "./queue-mirror.js";
import type { TodoWire } from "../protocol/messages.js";
import { projectLoadGate } from "../../sysload/wire.js";
import type { LoadPort } from "../../sysload/types.js";

/** Max length of a fleet row's thinking-level token (pi levels are short enum words). */
export const FLEET_THINKING_MAX = 32;

/** Web rows: more than the TUI widget, still bounded. */
const WEB_MAX_ACTIVE_ROWS = 64;
const WEB_RECENT_TERMINAL = 8;
const WEB_ARCHIVED_TERMINAL = 256;

/** Exact UTF-8 budgets for `{t:"fleet",runs,omitted?}` + LF and each serialized row. */
export const WEB_FLEET_FRAME_BYTES = 512 * 1024;
export const WEB_FLEET_ROW_BYTES = 4 * 1024;
const FLEET_OMITTED_RESERVE_BYTES = 256;
const FLEET_DISPLAY_FIELD_BYTES = 512;

export function readStatus(
  ctx: ExtensionContext,
  tap: EventTap,
  fleet: readonly RunSnapshot[],
  queueMirror?: QueueMirror,
  todo?: () => TodoWire | undefined,
  worktrees?: () => WorktreesWire | undefined,
  bashJobs?: () => BashJobsWire | undefined,
  quota?: () => QuotaWire | undefined,
  held?: () => { items: HeldItemWire[]; rev: number; epoch: string } | undefined,
  load?: () => LoadPort | undefined,
  cacheKeepalive?: () => CacheKeepaliveWire | undefined,
  features?: () => string[] | undefined,
  archived?: () => ArchiveWire | undefined,
  threads?: () => ThreadStatusSlotWire[] | undefined,
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
  // todo-web plan §3.3 (T3) + todo-archive v2.1 §2: the seam is now a PROJECTION closure
  // (same shape as worktrees/bashJobs/quota below) — the cap-gated folding lives in
  // agent/index.ts's `todoProjection`. Sampled in the same call as busy/leafId/queue so the
  // browser never sees a torn "new leaf + stale todo" pair. No getter (todo disabled / child
  // session) or undefined result (no visible tasks) ⇒ field absent, byte-equal to the
  // pre-feature shape.
  if (todo !== undefined) {
    const projected = todo();
    if (projected !== undefined) status.todo = projected;
  }
  // worktree-web plan §4.4 (W3): sampled in the same call, same overwrite-only-slot
  // rationale as todo above — no getter (session cwd not a git repo / not sampled
  // yet / web-hub off) ⇒ the field stays absent, byte-equal to the pre-feature shape.
  if (worktrees !== undefined) {
    const wire = worktrees();
    if (wire !== undefined) status.worktrees = wire;
  }
  // bash-jobs-panel plan §3.6 (包 A): same overwrite-only-slot rationale as todo/worktrees —
  // no getter (bash-jobs disabled / no background jobs / source manager missing) ⇒ the field
  // stays absent, byte-equal to the pre-feature status shape (D5).
  if (bashJobs !== undefined) {
    const wire = bashJobs();
    if (wire !== undefined) status.bashJobs = wire;
  }
  // quota-web plan §2/D4: same overwrite-only-slot rationale as todo/worktrees/bashJobs above —
  // no getter (quota disabled / webHub.quota off / no verdicts yet) ⇒ the field stays absent,
  // byte-equal to the pre-feature status shape.
  if (quota !== undefined) {
    const wire = quota();
    if (wire !== undefined) status.quota = wire;
  }
  // cache-keepalive-web plan §3.3: same overwrite-only-slot rationale — no getter / silent
  // projection ⇒ the field stays absent, byte-equal to the pre-feature status shape.
  if (cacheKeepalive !== undefined) {
    const wire = cacheKeepalive();
    if (wire !== undefined) status.cacheKeepalive = wire;
  }
  // web-hub-steer-recall plan §4.6 (A5): held web steer/followUp rows riding the same open
  // StatusInfoSchema slot pattern as todo/worktrees/bashJobs/quota. Gated ONLY on the wiring
  // (`webHub.steerRecall`, i.e. `holdWired`) — deliberately NOT on `holdCap()` (plan D3: an
  // open schema never drops the frame, and the full projection stored in the slot during a
  // disconnect replays correctly to whatever hub comes next). Non-empty items ⇒ all three
  // fields (`held`/`heldRev`/`heldEpoch` = MODULE_INSTANCE of the publishing activate(), R-C/Y2
  // merge scope); empty ⇒ all three absent, byte-equal to the pre-feature shape.
  if (held !== undefined) {
    const h = held();
    if (h !== undefined && h.items.length > 0) {
      status.held = h.items;
      status.heldRev = h.rev;
      status.heldEpoch = h.epoch;
    }
  }
  // sysload: project the session gate only after a known sample exists; unknown/stale is fail-open
  // and stays absent so the pre-feature status shape remains byte-identical before sampling.
  if (load !== undefined) {
    const port = load();
    if (port !== undefined) {
      const verdict = port.verdict();
      if (verdict.level !== "unknown") {
        const since = verdict.gatingSinceMono;
        status.loadGate = projectLoadGate(verdict, since === undefined ? undefined : Math.max(0, verdict.mono - since));
      }
    }
  }
  // web-resume plan §2.7: positive capability tokens (`resume.v1`) — absent ⇔ the caller wired
  // no features closure (feature off in every gated condition), or it returned nothing for the
  // current session. Bounded ≤32 × ≤64 chars, clipped here as a defensive backstop on top of the
  // schema. Sampled in the same call as busy/leafId so a stale gate can never advertise a token.
  if (features !== undefined) {
    const tokens = safe(() => features(), undefined);
    if (tokens !== undefined && tokens.length > 0) {
      status.features = tokens
        .filter((t) => typeof t === "string" && t.length >= 1)
        .slice(0, STATUS_FEATURES_MAX_ITEMS)
        .map((t) => t.slice(0, STATUS_FEATURES_MAX_CHARS));
    }
  }
  // web-hub archive plan: same overwrite-only-slot rationale as the siblings above — no getter
  // (web-hub off / no live stack) or an empty archive set ⇒ the field stays absent, byte-equal
  // to the pre-feature status shape. The slot is display-only hiding; /agent status,
  // get_run_result, notifications and the runs themselves never read it.
  if (archived !== undefined) {
    const wire = archived();
    if (wire !== undefined && wire.entries.length > 0) status.archived = wire;
  }
  // fabric-thread arch r3 §7.3 (P3): `status.threads` — the session's live thread subscriptions
  // for `/cur` display. The caller threads the getter ONLY while threads are on, and the getter
  // itself checks the LIVE link's `thr.v1` cap (§7.3 只在 hub cap 存在时发送) — either way off,
  // the field stays absent, byte-equal to the pre-feature shape (G2a/G2b).
  if (threads !== undefined) {
    const slots = threads();
    if (slots !== undefined && slots.length > 0) status.threads = slots;
  }
  return status;
}

export function projectFleet(
  snaps: readonly RunSnapshot[],
  now: number,
  typeOf?: (id: string) => string | undefined,
  archiveView?: RunArchiveDisplayView,
): FleetProjection {
  const terminal = snaps.filter((s) => isTerminalStatus(s.status)).sort((a, b) => b.updatedAt - a.updatedAt);
  let retained: Set<string> | undefined;
  let terminalPriority: readonly RunSnapshot[] | undefined;
  if (archiveView !== undefined) {
    const ordinary: RunSnapshot[] = [];
    const archived: RunSnapshot[] = [];
    const horizon = archiveView.horizon ?? -Infinity;
    for (const snap of terminal) {
      // Explicit metadata wins; a hold beats the horizon. Non-terminal rows never enter
      // either list, even if stale/corrupt metadata happens to name their runId.
      if (archiveView.archived.has(snap.runId)) archived.push(snap);
      else if (archiveView.held.has(snap.runId)) ordinary.push(snap);
      else if ((snap.diag.settledAt ?? snap.updatedAt) <= horizon)
        continue; // implicit H
      else ordinary.push(snap);
    }
    const ordinaryKept = ordinary.slice(0, WEB_RECENT_TERMINAL);
    const archivedKept = archived.slice(0, WEB_ARCHIVED_TERMINAL);
    terminalPriority = [...ordinaryKept, ...archivedKept];
    retained = new Set(terminalPriority.map((s) => s.runId));
  }
  const vm = buildFleetViewModel(snaps, {
    now,
    maxActiveRows: WEB_MAX_ACTIVE_ROWS,
    // Archive mode keeps the independent U8 ∪ E256 set through the shared VM's
    // retain hook. Legacy mode deliberately keeps the original recent-8 call.
    recentTerminal: archiveView === undefined ? WEB_RECENT_TERMINAL : 0,
    ...(archiveView !== undefined ? { retainTerminal: (s: RunSnapshot) => retained?.has(s.runId) === true } : {}),
    ...(typeOf !== undefined ? { typeOf } : {}),
  });
  const byId = new Map(snaps.map((s) => [s.runId, s]));
  const projected = vm.rows.map((r) => {
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
    // Start/end wall-clock stamps (append-only optional wire fields): the same instants
    // `elapsedMs` is measured between (fleet-panel `toRow`), so the browser can show
    // `start → end`. Non-finite stamps are dropped field-only; endedAt only on terminal rows.
    const src = byId.get(r.runId);
    if (src !== undefined && Number.isFinite(src.diag.createdAt)) {
      row.startedAt = src.diag.createdAt;
      if (r.terminal) {
        const end = src.diag.settledAt ?? src.updatedAt;
        if (Number.isFinite(end)) row.endedAt = end;
      }
    }
    if (r.label !== undefined) row.label = r.label;
    // Display-only raw title: rides the same append-only slot style as `label`
    // (empty values dropped field-only, never the row).
    if (r.title !== undefined && r.title !== "" && r.title !== r.label) row.title = r.title;
    if (r.type !== undefined) row.type = r.type;
    if (r.model !== undefined) row.model = r.model;
    // M-B2 (thinking-level visibility): rides the same append-only slot style as
    // `model`. Empty or oversized (> FLEET_THINKING_MAX chars) values are dropped
    // field-only here, so a weird level can never hide the run row itself.
    if (r.thinking !== undefined && r.thinking !== "" && r.thinking.length <= FLEET_THINKING_MAX) {
      row.thinking = r.thinking;
    }
    if (r.parentRunId !== undefined) row.parentRunId = r.parentRunId;
    if (r.usage !== undefined) row.costUsd = r.usage.costUsd;
    if (r.toolTrail !== undefined) row.toolTrail = r.toolTrail;
    if (r.streamLine !== undefined) row.streamLine = r.streamLine;
    // Per-run context usage: rides the same open slot style as `thinking`/`cacheMark`.
    // The view-model row already carries diag.contextUsage (fleet-panel `toRow`); null
    // tokens/percent (pi reported no usage yet) drop the field, never the row. The value
    // only changes on a fresh sample (message_end/compaction_end/context_switch), so it
    // flips the fingerprint only on real changes — no per-second churn.
    const ctxUsage = r.contextUsage;
    if (ctxUsage !== undefined && ctxUsage.tokens !== null && ctxUsage.percent !== null) {
      row.ctx = { tokens: ctxUsage.tokens, contextWindow: ctxUsage.contextWindow, percent: ctxUsage.percent };
    }
    return row;
  });
  return boundFleetProjection(projected, vm.activeCount, vm.totalCount - vm.activeCount, terminalPriority);
}

const FLEET_TRUNCATE_FIELDS = ["title", "label", "toolTrail", "streamLine", "model", "type"] as const;
const FLEET_REMOVE_FIELDS = [
  "streamLine",
  "toolTrail",
  "title",
  "label",
  "model",
  "type",
  "thinking",
  "cacheMark",
  "consultCache",
  "consult",
  "ctx",
  "costUsd",
  "startedAt",
  "endedAt",
] as const;

/** Keep normal rows byte-identical. Only an over-4-KiB row pays for a display-only clone;
 * runId/parentRunId are never truncated or removed, so an oversized identity skips the row. */
function fitFleetRow(row: FleetRowWire): FleetRowWire | undefined {
  if (Buffer.byteLength(JSON.stringify(row)) <= WEB_FLEET_ROW_BYTES) return row;
  const degraded: FleetRowWire = { ...row };
  for (const field of FLEET_TRUNCATE_FIELDS) {
    const value = degraded[field];
    if (typeof value === "string" && Buffer.byteLength(value) > FLEET_DISPLAY_FIELD_BYTES) {
      degraded[field] = truncateUtf8(value, FLEET_DISPLAY_FIELD_BYTES);
    }
  }
  for (const field of FLEET_REMOVE_FIELDS) {
    if (Buffer.byteLength(JSON.stringify(degraded)) <= WEB_FLEET_ROW_BYTES) return degraded;
    delete degraded[field];
  }
  return Buffer.byteLength(JSON.stringify(degraded)) <= WEB_FLEET_ROW_BYTES ? degraded : undefined;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const contentBudget = maxBytes - Buffer.byteLength("…");
  let out = "";
  let bytes = 0;
  for (const char of value) {
    const next = Buffer.byteLength(char);
    if (bytes + next > contentBudget) break;
    out += char;
    bytes += next;
  }
  return `${out}…`;
}

/** Priority admission is active → ordinary U8 → explicit archive newest-first. A row that
 * cannot fit is skipped without blocking smaller later rows; final output returns to VM order.
 * Every omission is recomputed AFTER row and frame clipping, including implicit-horizon rows. */
function boundFleetProjection(
  rows: readonly FleetRowWire[],
  originalActive: number,
  originalTerminal: number,
  terminalPriority: readonly RunSnapshot[] | undefined,
): FleetProjection {
  const fitted = new Map<FleetRowWire, FleetRowWire | undefined>();
  for (const row of rows) fitted.set(row, fitFleetRow(row));
  const byId = new Map(rows.map((row) => [row.runId, row]));
  const priority: FleetRowWire[] = rows.filter((row) => !row.terminal);
  if (terminalPriority === undefined) priority.push(...rows.filter((row) => row.terminal));
  else {
    for (const snap of terminalPriority) {
      const row = byId.get(snap.runId);
      if (row !== undefined) priority.push(row);
    }
  }
  // Defensive only (duplicate runIds are outside QueryService's contract): never lose a
  // projected row merely because the id-keyed priority list could not name it uniquely.
  for (const row of rows) if (!priority.includes(row)) priority.push(row);

  const emptyBytes = Buffer.byteLength('{"t":"fleet","runs":[]}\n');
  let used = emptyBytes + FLEET_OMITTED_RESERVE_BYTES;
  const admitted = new Set<FleetRowWire>();
  const admittedPriority: FleetRowWire[] = [];
  for (const original of priority) {
    const row = fitted.get(original);
    if (row === undefined) continue;
    const rowBytes = Buffer.byteLength(JSON.stringify(row));
    const next = used + (admittedPriority.length === 0 ? 0 : 1) + rowBytes;
    if (next > WEB_FLEET_FRAME_BYTES) continue;
    used = next;
    admitted.add(row);
    admittedPriority.push(row);
  }

  const finalize = (): FleetProjection => {
    const out = rows.flatMap((original) => {
      const row = fitted.get(original);
      return row !== undefined && admitted.has(row) ? [row] : [];
    }) as FleetProjection;
    let emittedActive = 0;
    for (const row of out) if (!row.terminal) emittedActive += 1;
    const omitted = {
      active: Math.max(0, originalActive - emittedActive),
      terminal: Math.max(0, originalTerminal - (out.length - emittedActive)),
    };
    if (omitted.active > 0 || omitted.terminal > 0) out.omitted = omitted;
    return out;
  };

  let out = finalize();
  // The 256-byte omitted reserve makes this exceptionally rare (normally impossible),
  // but the exact final serialized frame remains the authority at every digit boundary.
  while (fleetFrameBytes(out) > WEB_FLEET_FRAME_BYTES && admittedPriority.length > 0) {
    const victim = admittedPriority.pop();
    if (victim !== undefined) admitted.delete(victim);
    out = finalize();
  }
  return out;
}

function fleetFrameBytes(rows: FleetProjection): number {
  const frame = { t: "fleet", runs: rows, ...(rows.omitted !== undefined ? { omitted: rows.omitted } : {}) };
  return Buffer.byteLength(`${JSON.stringify(frame)}\n`);
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
