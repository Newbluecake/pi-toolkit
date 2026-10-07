/**
 * web-hub-spawn plan §SP9 (arch v2 §6.4, #8 硬门槛): supervisor records → wire projections.
 *
 * The ONE place every `/api/headless*` response and every `spawns` SSE snapshot is shaped from.
 * Field-visibility rules (arch §6.4's matrix, column by column):
 *
 *   - `toPublic`   — the SSE/broadcast shape. Owner-only fields (`cwd`, `origin.user`,
 *                    `hintDetail`, `stderrTail`, `uiCancelled[].title`, `firstPrompt.textLen`)
 *                    are NEVER copied here, so a global broadcast can't leak them even by
 *                    accident — every field is an explicit whitelist copy, never a spread.
 *   - `toViewer`   — the per-principal GET shape. Owner (or any loopback principal, arch §6.0:
 *                    "loopback 主体对所有记录都是 owner") gets the full `SpawnRecordOwner`;
 *                    a non-owner gets `toPublic` PLUS `cwd` only while the record is bound to a
 *                    live card (`agentKey` set and state `live`) — the AgentCard itself already
 *                    publicizes that cwd (§6.4's "仅当已绑定 live 卡片" row).
 *   - `toPublicPayload` — the SSE snapshot: `toPublic` for every record + active/max counters.
 *
 * First-prompt visibility: the wire never carries the BODY at any layer. The forwarder (SP8)
 * holds the authoritative `{state, code?, textLen, attempts}` view; the record's persisted slice
 * (`StoredFirstPrompt`, written once at accept) is the fallback when no view is supplied — e.g.
 * a resumed hub whose forwarder Map was never repopulated.
 *
 * Zero-`as` module (`hub/spawn/**` contract, `tests/web-hub/hub/spawn/source-scan.test.ts`).
 */
import { basename } from "node:path";
import {
  type SpawnEndReason,
  type SpawnHint,
  type SpawnRecordOwner,
  type SpawnRecordPublic,
  type SpawnState,
  type SpawnsPayload,
} from "../../protocol/spawn.js";
import type { FirstPromptStateView } from "./first-prompt.js";
import { hidesIdentityOnWire, restoreWireOf } from "./restore-plan.js";
import { isTerminalSpawnState, type StoredOwner } from "./store.js";
import type { InternalRecord } from "./supervisor.js";

/** arch §6.4: dialog titles may carry sensitive text — owner view truncates to 120 chars. */
const UI_CANCELLED_TITLE_MAX = 120;

/**
 * Resolves a spawnId to the forwarder's authoritative first-prompt view (undefined ⇒ fall back
 * to the record's persisted slice). Routes pass `(id) => firstPrompt.state(id)`.
 */
export type FirstPromptViewOf = (spawnId: string) => FirstPromptStateView | undefined;

/** Wire state of an internal record (`launching` exists only inside start()'s sync stretch). */
export function wireSpawnState(rec: InternalRecord): SpawnState {
  return rec.state === "launching" ? "starting" : rec.state;
}

/** `principal` in `spawnPrincipal` form (`${listener}:${user ?? "token"}`). */
function isOwner(rec: InternalRecord, principal: string, isLoopback: boolean): boolean {
  if (isLoopback) return true; // arch §6.0: loopback owns every record
  return ownerPrincipal(rec.owner) === principal;
}

function ownerPrincipal(owner: StoredOwner): string {
  return `${owner.listener}:${owner.user ?? "token"}`;
}

/** §6.4 first-prompt slice for a PUBLIC item: `{state, code?}` — never textLen/attempts/text. */
function publicFirstPrompt(rec: InternalRecord, fpOf: FirstPromptViewOf | undefined): SpawnRecordPublic["firstPrompt"] {
  if (rec.firstPrompt === undefined) return undefined;
  const view = fpOf?.(rec.spawnId);
  if (view !== undefined) {
    return { state: view.state, ...(view.code !== undefined ? { code: view.code } : {}) };
  }
  return { state: rec.firstPrompt.state };
}

/**
 * The Public projection (§6.4's "SSE 广播" column) — every field an explicit copy.
 * `fpOf` (optional) overlays the forwarder's authoritative first-prompt state/code.
 */
export function toPublic(rec: InternalRecord, fpOf?: FirstPromptViewOf): SpawnRecordPublic {
  const item: SpawnRecordPublic = {
    spawnId: rec.spawnId,
    state: wireSpawnState(rec),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    cwdLabel: basename(rec.cwd),
    origin: { listener: rec.owner.listener, reqId: rec.owner.reqId },
  };
  // web-hub-spawn-restore §9.1: while reaping, pid/exit still describe the OLD process — hidden.
  const hideOld = hidesIdentityOnWire(rec.restore);
  if (rec.pid !== undefined && !hideOld) item.pid = rec.pid;
  if (rec.agentKey !== undefined) {
    item.agentKey = rec.agentKey;
    item.linked = rec.linked;
  }
  // default-model plan D3: non-sensitive by design — public so SpawnRow can badge it and a
  // faithful retry can replay `rec.model ?? ""`.
  if (rec.model !== undefined) item.model = rec.model;
  if (rec.state === "live" && rec.control !== undefined) item.control = rec.control;
  const endReason: SpawnEndReason | null | undefined = rec.endReason;
  if (endReason !== undefined && endReason !== null) item.endReason = endReason;
  const exit = rec.exit;
  if (exit !== undefined && exit !== null && !hideOld) {
    item.exit = {
      code: exit.code,
      signal: exit.signal,
      ...(exit.unconfirmed === true ? { unconfirmed: true as const } : {}),
    };
  }
  const hint: SpawnHint | null | undefined = rec.hint;
  if (hint !== undefined && hint !== null) item.hint = hint;
  if (rec.uiCancelled.length > 0) item.uiCancelledCount = rec.uiCancelled.length;
  const fp = publicFirstPrompt(rec, fpOf);
  if (fp !== undefined) item.firstPrompt = fp;
  if (rec.removePending) item.removing = true;
  // web-hub-spawn-restore §9.2: public to every principal; sessionId/sessionFile NEVER copied.
  const restore = restoreWireOf(rec.restore);
  if (restore !== undefined) item.restore = restore;
  return item;
}

/** True when the record is bound to a card whose own AgentCard already publicizes the cwd. */
function cwdPublicViaCard(rec: InternalRecord): boolean {
  return rec.agentKey !== undefined && rec.state === "live";
}

/**
 * The per-principal GET projection (§6.4's GET columns): owner (or loopback) sees the full
 * `SpawnRecordOwner`; a non-owner sees Public plus — only for live-bound records — the cwd the
 * AgentCard itself already exposes.
 */
export function toViewer(
  rec: InternalRecord,
  principal: string,
  isLoopback: boolean,
  fpOf?: FirstPromptViewOf,
): SpawnRecordOwner | SpawnRecordPublic {
  if (!isOwner(rec, principal, isLoopback)) {
    const pub = toPublic(rec, fpOf);
    if (isLoopback || !cwdPublicViaCard(rec)) return pub;
    // §6.4's non-owner exception row: the bound live card publicizes this cwd already.
    return { ...pub, cwd: rec.cwd };
  }
  // Owner view — copied field-by-field off the Public whitelist item (single source for the
  // shared fields; `cwd`/`origin.user`/owner-extras added on top, firstPrompt widened).
  const view = fpOf?.(rec.spawnId);
  const pub = toPublic(rec, fpOf);
  const owner: SpawnRecordOwner = {
    spawnId: pub.spawnId,
    state: pub.state,
    createdAt: pub.createdAt,
    updatedAt: pub.updatedAt,
    cwdLabel: pub.cwdLabel,
    ...(pub.pid !== undefined ? { pid: pub.pid } : {}),
    ...(pub.model !== undefined ? { model: pub.model } : {}),
    ...(pub.agentKey !== undefined ? { agentKey: pub.agentKey, linked: pub.linked } : {}),
    ...(pub.control !== undefined ? { control: pub.control } : {}),
    ...(pub.endReason !== undefined ? { endReason: pub.endReason } : {}),
    ...(pub.exit !== undefined ? { exit: pub.exit } : {}),
    ...(pub.hint !== undefined ? { hint: pub.hint } : {}),
    ...(pub.uiCancelledCount !== undefined ? { uiCancelledCount: pub.uiCancelledCount } : {}),
    ...(pub.removing !== undefined ? { removing: pub.removing } : {}),
    ...(pub.restore !== undefined ? { restore: pub.restore } : {}),
    ...(pub.firstPrompt !== undefined
      ? {
          firstPrompt:
            view !== undefined
              ? {
                  state: view.state,
                  ...(view.code !== undefined ? { code: view.code } : {}),
                  textLen: view.textLen,
                  attempts: view.attempts,
                }
              : {
                  state: rec.firstPrompt?.state ?? pub.firstPrompt.state,
                  textLen: rec.firstPrompt?.textLen ?? 0,
                  attempts: rec.firstPrompt?.attempts ?? 0,
                },
        }
      : {}),
    cwd: rec.cwd,
    origin: {
      listener: rec.owner.listener,
      reqId: rec.owner.reqId,
      ...(rec.owner.user !== undefined && rec.owner.user !== null ? { user: rec.owner.user } : {}),
    },
  };
  if (rec.hintDetail !== undefined) owner.hintDetail = rec.hintDetail;
  // §6.4: stderrTail is owner-only AND failed-only (it exists to explain a dead spawn);
  // the sink's own tail() already caps at STDERR_TAIL_BYTES.
  if (rec.state === "failed") {
    const tail = rec.stderrTail();
    if (tail !== undefined) owner.stderrTail = tail;
  }
  if (rec.uiCancelled.length > 0) {
    owner.uiCancelled = rec.uiCancelled.map((e) => ({
      method: e.method,
      at: e.at,
      ...(e.title !== undefined ? { title: e.title.slice(0, UI_CANCELLED_TITLE_MAX) } : {}),
    }));
  }
  return owner;
}

/**
 * The `spawns` SSE snapshot (arch §6.4: Public projection ONLY, D6) — loopback and LAN
 * listeners render the identical payload; owner detail never rides the bus.
 */
export function toPublicPayload(
  records: readonly InternalRecord[],
  max: number,
  fpOf?: FirstPromptViewOf,
): SpawnsPayload {
  let active = 0;
  const items: SpawnRecordPublic[] = [];
  for (const rec of records) {
    if (!isTerminalSpawnState(rec.state)) active += 1;
    items.push(toPublic(rec, fpOf));
  }
  return { items, active, max };
}
