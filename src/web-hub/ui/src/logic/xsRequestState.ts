/**
 * fabric-xs-activation plan §3 P4 (arch §4.1/§4.7/§4.8/§4.9): the browser-side merge of the
 * cross-session request-progress axis. Pure, DOM-free; Vue appears only in the small reactive
 * seed store at the bottom (the `useCmdHistory` module-store precedent).
 *
 * Inputs (all cap-gated — `xs.state.v1` on the CURRENT hub frame):
 *  - `StatusInfo.xsRequests` (SSE `status` frames, P1's source-mirror projection): the
 *    authoritative rows, `{sessionId, revision, rows≤256, omitted?}` per the FROZEN P0 wire
 *    contract (`protocol/xs-activation.ts`). A slot whose `sessionId` is not the card's CURRENT
 *    session is dropped wholesale ("错 session 丢弃").
 *  - `cmd_result.mention.session` (P2's two mention branches — the sync web path and the
 *    `onSessionRouted` port settle the SAME `data.mention` shape): an optional
 *    `{track:{messageId, activationKey?}, progress?}` seed, merged as GENERIC UNCONFIRMED —
 *    it fills identity fields (messageId/activationKey/requestId) adopt-if-absent and carries
 *    no phase claim of its own unless the sender outcome's `progress` row supplied one; a
 *    seed never overrides remotely proven evidence.
 *
 * Merge rules per messageId (arch §4.1/§4.9, mirroring `fabric/xs/progress.ts`'s own bag
 * semantics — reimplemented here because the UI bundle must not import `src/fabric/**`):
 * phases are monotone (offline/miss/stale-revision never regress; furthest proven fact wins;
 * direct `delivered` is legal; `replied` may skip without back-filling `startedAt`);
 * `deliveryEffect` only ever rises (`unknown`→`applied`; a timeout NEVER rewrites it to
 * `none`); identity/timestamp fields are adopt-if-absent; the wake view keeps the FIRST real
 * stopper (a later downgrade reason never overwrites one already recorded) and `requested` is
 * sticky (OR — a remote receiver-side `requested:false` never erases a proven source intent);
 * `defaulted` is source-private and never clears. Snapshot acceptance is gated by `revision`:
 * a lower-revision snapshot (a stale replay across the HTTP/ctl/SSE transports) contributes
 * adopt-if-absent identity fields only.
 *
 * The activate/query actions are gated HARD (plan §3 P4: "`xs.activate.v1` 未宣告时不得显示/
 * 可点"): the hub frame must carry BOTH caps (`xs.state.v1` + `xs.activate.v1` — the wire cap
 * negotiation the browser can see; the server revalidates the real three-end negotiation on
 * every request), the control handle must offer the (optional) transport surface, the card
 * must be online, and the row must be delivered-not-started with a live key inside its
 * window. No session-side status field is consulted (`XsStatus` is a closed schema — the UI
 * must not invent a producer for it). P3b adapters reuse the existing authenticated command
 * transport; old/off agents and hubs still fail closed at the server gate. Nothing here ever auto-executes: no lifecycle event (status
 * frame, SSE reconnect, reply timeout, quota expiry) calls the action surface — only a user
 * click does.
 */

/** UI mirror of `XS_STATE_HUB_CAP` (protocol/xs-activation.ts) — the hub frame's cap token. */
export const XS_STATE_CAP = "xs.state.v1";
/** UI mirror of `XS_ACTIVATE_HUB_CAP`; actual agent capability is server-validated,
 * never inferred from a fabricated status.xs activation field. */
export const XS_ACTIVATE_CAP = "xs.activate.v1";

/** UI mirror of `XS_REQUESTS_MAX_ROWS` (the wire row cap) — the display list never exceeds the
 *  slot it projects; the visible window is smaller (see {@link XS_REQUEST_LIST_MAX}). */
export const XS_REQUESTS_MAX_ROWS = 256;
/** Visible rows in the light request area (newest first); the tail collapses into a "+N" note. */
export const XS_REQUEST_LIST_MAX = 8;

import type { XsEvidence, XsObservation, XsPhase, XsReplyState, XsWakeStage } from "@protocol/xs-activation.js";
import { computed, reactive, type ComputedRef, type InjectionKey } from "vue";

/** The received-card badge index DetailBody provides / TxCustom injects (fabric-xs-activation
 *  P4): entryId → merged row. `null` (no provider — drawer transcripts, standalone mounts)
 *  or a miss ⇒ NO badge DOM, byte-identical to the pre-feature card. */
export interface XsRxProgressCtx {
  readonly rows: ComputedRef<ReadonlyMap<string, XsRowView>>;
}
export const XS_RX_PROGRESS: InjectionKey<XsRxProgressCtx> = Symbol("web-hub-xs-rx-progress");

// ----------------------------------------------------------------- wire narrowing (tolerant)

/** The frozen wake-view row (arch §4.1), narrowed tolerantly from unknown wire data. */
export interface XsWakeViewWire {
  readonly requested: boolean;
  readonly defaulted?: boolean;
  readonly stage?: XsWakeStage;
  readonly decision: "deliver_only" | "downgraded" | "dispatch_accepted" | "unknown";
  readonly reason?: string;
  readonly authorizedAt?: number;
  readonly ended?: "settled" | "aborted" | "deadline" | "stuck";
  readonly retryAfterAt?: number;
}

/** One merged request row (the view model the components render). */
export interface XsRowView {
  readonly messageId: string;
  /** Furthest proven phase (absent while there is no phase evidence at all). */
  readonly phase?: XsPhase;
  readonly deliveryEffect: XsEvidence;
  readonly observation: XsObservation;
  readonly revision: number;
  readonly queuedAt?: number;
  readonly deliveredAt?: number;
  readonly startedAt?: number;
  readonly repliedAt?: number;
  readonly requestId?: string;
  readonly replyState?: XsReplyState;
  /** Body/observation reason — independent of the wake reason. */
  readonly reason?: string;
  readonly wake: XsWakeViewWire;
  readonly activationKey?: string;
  /** Local CONTROL-attempt outcome, distinct from original body/wake evidence; never authorization. */
  readonly activationStatus?: "accepted" | "already_active" | "unknown" | "refused" | "unsupported";
  readonly activationUntil?: number;
  /** The receiver branch entry a real xid match found (display-only; attaches a card badge). */
  readonly entryId?: string;
  /** True while the row exists ONLY as a local generic-unconfirmed seed (no remote proof yet). */
  readonly seeded?: true;
}

const PHASE_ORDER: Readonly<Record<XsPhase, number>> = { queued: 0, delivered: 1, started: 2, replied: 3 };
const EVIDENCE_ORDER: Readonly<Record<XsEvidence, number>> = { none: 0, unknown: 1, applied: 2 };

function record(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}
function token<T extends string>(v: unknown, allowed: ReadonlySet<T>): T | undefined {
  return typeof v === "string" && allowed.has(v as T) ? (v as T) : undefined;
}

const PHASES = new Set<XsPhase>(["queued", "delivered", "started", "replied"]);
const EVIDENCES = new Set<XsEvidence>(["none", "unknown", "applied"]);
const OBSERVATIONS = new Set<XsObservation>(["live", "offline", "expired", "unavailable"]);
const REPLY_STATES = new Set<XsReplyState>(["pending", "timed_out", "late", "invalidated"]);
const DECISIONS = new Set(["deliver_only", "downgraded", "dispatch_accepted", "unknown"] as const);
const STAGES = new Set<XsWakeStage>(["sender", "hub", "receiver", "host"]);
const ENDINGS = new Set(["settled", "aborted", "deadline", "stuck"] as const);

function narrowWake(v: unknown): XsWakeViewWire | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const w = v as Record<string, unknown>;
  if (typeof w["requested"] !== "boolean") return undefined;
  const decision = token(w["decision"], DECISIONS);
  if (decision === undefined) return undefined;
  const stage = token(w["stage"], STAGES);
  const ended = token(w["ended"], ENDINGS);
  const reason = str(w["reason"]);
  const authorizedAt = num(w["authorizedAt"]);
  const retryAfterAt = num(w["retryAfterAt"]);
  return {
    requested: w["requested"],
    ...(w["defaulted"] === true ? { defaulted: true } : {}),
    ...(stage !== undefined ? { stage } : {}),
    decision,
    ...(reason !== undefined ? { reason } : {}),
    ...(authorizedAt !== undefined ? { authorizedAt } : {}),
    ...(ended !== undefined ? { ended } : {}),
    ...(retryAfterAt !== undefined ? { retryAfterAt } : {}),
  };
}

/** Narrow ONE wire row (`XsProgress`); malformed ⇒ undefined (a bad row never drops its
 *  siblings — the same wholesale-drop discipline as every other slot). */
export function narrowXsRow(v: unknown): XsRowView | undefined {
  const r = record(v);
  const messageId = str(r["messageId"]);
  const effect = token(r["deliveryEffect"], EVIDENCES);
  const observation = token(r["observation"], OBSERVATIONS);
  if (messageId === undefined || effect === undefined || observation === undefined) return undefined;
  const wake = narrowWake(r["wake"]);
  if (wake === undefined) return undefined;
  const phase = token(r["phase"], PHASES);
  const replyState = token(r["replyState"], REPLY_STATES);
  const queuedAt = num(r["queuedAt"]);
  const deliveredAt = num(r["deliveredAt"]);
  const startedAt = num(r["startedAt"]);
  const repliedAt = num(r["repliedAt"]);
  const requestId = str(r["requestId"]);
  const reason = str(r["reason"]);
  const activationKey = str(r["activationKey"]);
  const activationUntil = num(r["activationUntil"]);
  const entryId = str(r["entryId"]);
  return {
    messageId,
    revision: num(r["revision"]) ?? 0,
    deliveryEffect: effect,
    observation,
    ...(phase !== undefined ? { phase } : {}),
    ...(queuedAt !== undefined ? { queuedAt } : {}),
    ...(deliveredAt !== undefined ? { deliveredAt } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(repliedAt !== undefined ? { repliedAt } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(replyState !== undefined ? { replyState } : {}),
    ...(reason !== undefined ? { reason } : {}),
    wake,
    ...(activationKey !== undefined ? { activationKey } : {}),
    ...(activationUntil !== undefined ? { activationUntil } : {}),
    ...(entryId !== undefined ? { entryId } : {}),
  };
}

/** The narrowed `StatusInfo.xsRequests` slot. */
export interface XsRequestsSnapshot {
  readonly sessionId: string;
  readonly revision: number;
  readonly rows: readonly XsRowView[];
  readonly omitted?: number;
}

/** Cap-gated tolerant narrow of the status slot. `hubCaps` MUST already carry
 *  {@link XS_STATE_CAP} (an old hub / feature-off hub never shows the area at all — not even an
 *  empty container, byte-identical legacy DOM). */
export function narrowXsRequests(status: unknown, hubCaps: unknown): XsRequestsSnapshot | undefined {
  if (!Array.isArray(hubCaps) || !hubCaps.includes(XS_STATE_CAP)) return undefined;
  const raw = record(record(status)["xsRequests"]);
  const sessionId = str(raw["sessionId"]);
  const revision = num(raw["revision"]);
  const rowsWire = raw["rows"];
  if (sessionId === undefined || revision === undefined || !Array.isArray(rowsWire)) return undefined;
  const rows: XsRowView[] = [];
  for (const w of rowsWire) {
    const row = narrowXsRow(w);
    if (row !== undefined) rows.push(row);
  }
  if (rows.length === 0) return undefined; // absent-equivalent: nothing renders
  const omitted = num(raw["omitted"]);
  return {
    sessionId,
    revision,
    rows: rows.slice(0, XS_REQUESTS_MAX_ROWS),
    ...(omitted !== undefined ? { omitted } : {}),
  };
}

// ----------------------------------------------------------------- the monotone merge

/** A generic-unconfirmed seed (the mention `cmd_result` projection, P2's frozen port shape). */
export interface XsMentionSeed {
  readonly messageId: string;
  readonly activationKey?: string;
  readonly requestId?: string;
  readonly row?: XsRowView;
}

/** Narrow P2's `cmd_result.data.mention` when `action === "session"` (BOTH mention branches —
 *  the sync web path and the `onSessionRouted` port — settle the SAME shape; the narrowing is
 *  deliberately branch-agnostic: `delivery`/`behavior` carry no progress meaning here). */
export function narrowMentionSession(data: unknown): XsMentionSeed | undefined {
  const m = record(record(data)["mention"]);
  if (m["action"] !== "session") return undefined;
  const track = record(m["track"]);
  const progress = narrowXsRow(m["progress"]);
  const messageId = str(track["messageId"]) ?? progress?.messageId;
  if (messageId === undefined) return undefined;
  const activationKey = str(track["activationKey"]);
  return {
    messageId,
    ...(activationKey !== undefined ? { activationKey } : {}),
    ...(progress?.requestId !== undefined ? { requestId: progress.requestId } : {}),
    ...(progress !== undefined ? { row: progress } : {}),
  };
}

const IDENTITY_FIELDS = ["activationKey", "activationUntil", "requestId", "entryId"] as const;

/** Adopt-if-absent identity fields (`activationKey`/`activationUntil`/`requestId`/`entryId`):
 *  once a value is known a later snapshot never clears or replaces it. */
function adoptIdentity(prev: XsRowView, next: XsRowView): XsRowView {
  let out = prev;
  for (const k of IDENTITY_FIELDS) {
    if (
      (prev[k] as string | number | undefined) === undefined &&
      (next[k] as string | number | undefined) !== undefined
    ) {
      out = { ...out, [k]: next[k] } as XsRowView;
    }
  }
  return out;
}

/** Terminal reply states (`mergeReplyState` port — a terminal state never re-pends). */
const REPLY_TERMINAL = new Set<XsReplyState>(["timed_out", "late", "invalidated"]);

/** `fabric/xs/progress.ts`'s mergeReplyState, ported verbatim: an absent incoming keeps the
 *  stored state; a terminal stored state is never overwritten by `pending`; `pending` MAY
 *  advance to `timed_out`/`late`/`invalidated`, and a later terminal replaces an earlier one
 *  (timed_out → late stays possible). */
export function mergeReplyState(
  stored: XsReplyState | undefined,
  incoming: XsReplyState | undefined,
): XsReplyState | undefined {
  if (incoming === undefined) return stored;
  if (stored !== undefined && REPLY_TERMINAL.has(stored) && incoming === "pending") return stored;
  return incoming;
}

/** `fabric/xs/progress.ts`'s mergeWakeFields, ported (arch §4.8): the FIRST real stopper is
 *  sticky — once the view carries a stop `reason` OR the dispatch was ACCEPTED
 *  (`dispatch_accepted` is itself a story worth keeping), later attempts' downgrades never
 *  rewrite it. `requested` is monotone-OR; `defaulted` is source-private (a remote merge can
 *  neither set nor clear it — only the local seed path sets it); `authorizedAt`/`ended` are
 *  adopt-if-absent (one wake run ends once); `retryAfterAt` is overwrite-if-present (only an
 *  authoritative quota source fills it, so an omitted one never clears the floor). */
function mergeWakeFields(stored: XsWakeViewWire, incoming: XsWakeViewWire, local: boolean): XsWakeViewWire {
  const sticky = stored.reason !== undefined || stored.decision === "dispatch_accepted";
  const decision = sticky ? stored.decision : incoming.decision;
  const stage = sticky ? stored.stage : (incoming.stage ?? stored.stage);
  const reason = sticky ? stored.reason : (incoming.reason ?? stored.reason);
  const defaulted = stored.defaulted === true || (local && incoming.defaulted === true) ? true : undefined;
  const authorizedAt = stored.authorizedAt ?? incoming.authorizedAt;
  const ended = stored.ended ?? incoming.ended;
  // `retryAfterAt` is overwrite-if-present: only an authoritative quota source fills it, so a
  // statement that omits it must never clear the floor.
  const retryAfterAt = incoming.retryAfterAt ?? stored.retryAfterAt;
  return {
    requested: stored.requested || incoming.requested === true,
    ...(defaulted !== undefined ? { defaulted } : {}),
    ...(stage !== undefined ? { stage } : {}),
    decision,
    ...(reason !== undefined ? { reason } : {}),
    ...(authorizedAt !== undefined ? { authorizedAt } : {}),
    ...(ended !== undefined ? { ended } : {}),
    ...(retryAfterAt !== undefined ? { retryAfterAt } : {}),
  };
}

/**
 * Merge `next` into `prev` (either may be undefined). `nextRemote` marks `next` as a remotely
 * proven snapshot row (vs. a local generic seed): a remote merge promotes a seeded row (drops
 * its `seeded` display hint) and may advance phase/evidence/observation/wake; a seed merge
 * only fills identity fields and the wake facts nothing else has claimed. A lower-revision
 * `next` (a stale replay across transports/snapshots) contributes identity only — phases
 * never regress (the bag's own gate, mirrored).
 */
export function mergeXsRow(prev: XsRowView | undefined, next: XsRowView, nextRemote: boolean): XsRowView {
  if (prev === undefined) return next;
  let out = adoptIdentity(prev, next);
  if (!nextRemote && next.activationStatus !== undefined) out = { ...out, activationStatus: next.activationStatus };
  const stale = next.revision < prev.revision;
  if (stale || !nextRemote) {
    // The seed path (local): wake facts a local observation may claim, nothing else moves.
    return { ...out, wake: mergeWakeFields(prev.wake, next.wake, true) };
  }
  // Remote, fresh (revision ≥ prev): monotone phase/evidence, latest observation,
  // overwrite-if-present reason, adopt-if-absent timestamps, the ported reply/wake lattices.
  const phase =
    prev.phase !== undefined && next.phase !== undefined
      ? PHASE_ORDER[prev.phase] >= PHASE_ORDER[next.phase]
        ? prev.phase
        : next.phase
      : (prev.phase ?? next.phase);
  const deliveryEffect =
    EVIDENCE_ORDER[prev.deliveryEffect] >= EVIDENCE_ORDER[next.deliveryEffect]
      ? prev.deliveryEffect
      : next.deliveryEffect;
  const wake = mergeWakeFields(prev.wake, next.wake, false);
  const queuedAt = out.queuedAt ?? next.queuedAt;
  const deliveredAt = out.deliveredAt ?? next.deliveredAt;
  const startedAt = out.startedAt ?? next.startedAt;
  const repliedAt = out.repliedAt ?? next.repliedAt;
  const replyState = mergeReplyState(out.replyState, next.replyState);
  const reason = next.reason ?? out.reason;
  // A remote proof promotes a seeded row — the `seeded` display hint goes (rest destructured
  // FIRST so the key is actually absent from the result, not just shadowed).
  const { seeded: _promoted, ...base } = out as XsRowView & { seeded?: true };
  return {
    ...base,
    ...(phase !== undefined ? { phase } : {}),
    deliveryEffect,
    observation: next.observation,
    revision: Math.max(prev.revision, next.revision),
    ...(queuedAt !== undefined ? { queuedAt } : {}),
    ...(deliveredAt !== undefined ? { deliveredAt } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(repliedAt !== undefined ? { repliedAt } : {}),
    ...(replyState !== undefined ? { replyState } : {}),
    ...(reason !== undefined ? { reason } : {}),
    wake,
  };
}

/** Fold `remote` rows over `seeds` into the display map (pure; newest activity first). */
function foldRemoteOver(
  seeds: ReadonlyMap<string, XsRowView>,
  remote: ReadonlyMap<string, XsRowView>,
): Map<string, XsRowView> {
  const merged = new Map<string, XsRowView>(seeds);
  for (const row of remote.values()) merged.set(row.messageId, mergeXsRow(merged.get(row.messageId), row, true));
  return merged;
}

/** The merged rows for the CURRENT session: seeds (generic unconfirmed) folded UNDER the
 *  persistent remote store's rows (remote proof), newest activity first. Pure — the store
 *  itself lives below (see {@link acceptXsStatus}). */
export function xsRequestRows(
  seeds: ReadonlyMap<string, XsRowView>,
  remote: ReadonlyMap<string, XsRowView>,
): readonly XsRowView[] {
  const rows = [...foldRemoteOver(seeds, remote).values()];
  const at = (r: XsRowView): number => r.repliedAt ?? r.startedAt ?? r.deliveredAt ?? r.queuedAt ?? 0;
  rows.sort((a, b) => at(b) - at(a) || (a.messageId < b.messageId ? -1 : 1));
  return rows;
}

// ----------------------------------------------------------------- local request-list dismissal

/** Browser-App lifetime only: hiding a row is presentation, NOT a query/activate outcome.
 * Keep tombstones independently of row caches/revisions, including while SSE is offline or
 * the detail view is unmounted. Never persist or evict a tombstone within the same session:
 * an old frame (or FIFO-evicted row returning later) must not resurrect a dismissed request.
 * Session replacement / explicit card removal discards its tombstones; a missing session
 * during reconnect is not proof of session end. Each App owns its own closure (no shared
 * module state); a browser reload starts empty. Received-card badges keep the original rows.
 */
export function createXsRequestDismissals() {
  const stores = reactive(new Map<string, { sessionId: string; ids: Set<string> }>());
  return {
    dismiss(agentKey: string, sessionId: string, messageId: string): void {
      let store = stores.get(agentKey);
      if (store === undefined || store.sessionId !== sessionId) {
        store = { sessionId, ids: new Set() };
        stores.set(agentKey, store);
        store = stores.get(agentKey)!;
      }
      store.ids.add(messageId);
    },
    rows(agentKey: string, sessionId: string, rows: readonly XsRowView[]): readonly XsRowView[] {
      const store = stores.get(agentKey);
      return store?.sessionId === sessionId ? rows.filter((row) => !store.ids.has(row.messageId)) : rows;
    },
    reconcile(sessions: ReadonlyMap<string, string>, removed: ReadonlySet<string>): void {
      for (const [key, store] of stores) {
        const sid = sessions.get(key);
        if (removed.has(key) || (sid !== undefined && sid !== store.sessionId)) stores.delete(key);
      }
    },
  };
}

export const XS_REQUEST_DISMISSALS: InjectionKey<ReturnType<typeof createXsRequestDismissals>> = Symbol(
  "web-hub-xs-request-dismissals",
);

// ----------------------------------------------------------------- view projections

/** The main-line English token (arch §4.9: four phases / unknown / not delivered). */
export function xsRowPhaseToken(row: XsRowView): string {
  if (row.deliveryEffect === "none") return "not delivered";
  if (row.phase === undefined) return "unknown";
  return row.phase;
}

/** The compact wake token — `wake↓ <reason>` (or `wake·dispatch` while accepted, `wake·<ended>`
 *  once the run ended, `wake?` when requested but undecided). Absent when the wake story adds
 *  nothing over "not requested". */
export function xsRowWakeToken(row: XsRowView): string | undefined {
  const w = row.wake;
  if (w.reason !== undefined) return `wake↓ ${w.reason}`;
  if (w.decision === "dispatch_accepted") return "wake·dispatch";
  if (w.ended !== undefined) return `wake·${w.ended}`;
  if (w.decision === "unknown" && w.requested) return "wake?";
  return undefined;
}

/** Reply-state chip token (`reply pending` / `reply timed_out` / …) — English token per the
 *  UI-text split; absent when the request carries no reply ticket. */
export function xsRowReplyToken(row: XsRowView): string | undefined {
  return row.replyState === undefined ? undefined : `reply ${row.replyState}`;
}

/** The translated evidence-note key for a row (the Chinese prose under the token line). */
export function xsRowNoteKey(row: XsRowView): string {
  if (row.deliveryEffect === "none") return "xs.noteNotDelivered";
  if (row.observation === "unavailable") return "xs.noteUnavailable";
  if (row.observation === "offline") return "xs.noteOffline";
  if (row.observation === "expired") return "xs.noteExpired";
  switch (row.phase) {
    case "queued":
      return "xs.noteQueued";
    case "delivered":
      return "xs.noteDelivered";
    case "started":
      return "xs.noteStarted";
    case "replied":
      return "xs.noteReplied";
    default:
      return "xs.noteUnknown";
  }
}

/** entryId → row index for the received-card badges (`真实 xid→entryId 才附着卡片` — never
 *  matched by body/hash/time). */
export function xsEntryIndex(rows: readonly XsRowView[]): ReadonlyMap<string, XsRowView> {
  const out = new Map<string, XsRowView>();
  for (const row of rows) if (row.entryId !== undefined && !out.has(row.entryId)) out.set(row.entryId, row);
  return out;
}

// ----------------------------------------------------------------- activate/query gates

/** Row-level activate eligibility (arch §4.4/§4.6): key present and inside its window, body
 *  confirmed delivered and NOT started/replied, observation live. */
export function xsActivateEligible(row: XsRowView, now: number): boolean {
  return (
    row.activationKey !== undefined &&
    !["accepted", "already_active", "unknown", "unsupported"].includes(row.activationStatus ?? "") &&
    (row.activationUntil === undefined || row.activationUntil > now) &&
    row.phase === "delivered" &&
    row.startedAt === undefined &&
    row.repliedAt === undefined &&
    row.deliveryEffect === "applied" &&
    row.observation === "live"
  );
}

/** The full activate-button gate — every input must hold for the button to RENDER at all:
 *  hub caps carry BOTH `xs.state.v1` + `xs.activate.v1` (the wire cap negotiation the UI can
 *  see — the server revalidates the real three-end negotiation on every request), the
 *  transport surface exists (fail closed until P3b wires the adapter), the card is online,
 *  and the row is eligible. No session-side status field is consulted: `XsStatus` is a closed
 *  schema, so the UI must not invent a producer for it. */
export interface XsActivateGateArgs {
  readonly hubCaps: unknown;
  readonly row: XsRowView;
  readonly now: number;
  /** The control handle's optional action surface (absent ⇒ no button, ever). */
  readonly hasSurface: boolean;
  /** The card is online (the server revalidates regardless — this is UX gating only). */
  readonly online: boolean;
}

export interface XsActivateGateView {
  readonly visible: boolean;
  /** Quota backoff — an authoritative retryAfterAt still in the future (displayed, never
   *  auto-executed; the button waits for it). */
  readonly retryAfterAt?: number;
}

export function xsActivateGate(args: XsActivateGateArgs): XsActivateGateView {
  const capsOk =
    Array.isArray(args.hubCaps) && args.hubCaps.includes(XS_STATE_CAP) && args.hubCaps.includes(XS_ACTIVATE_CAP);
  const visible = capsOk && args.hasSurface && args.online && xsActivateEligible(args.row, args.now);
  const retryAfterAt = args.row.wake.retryAfterAt;
  return visible && retryAfterAt !== undefined && retryAfterAt > args.now ? { visible, retryAfterAt } : { visible };
}

/** The unknown-row query affordance: read-only, state-cap only (an `unknown` row NEVER offers
 *  activate — "unknown 只 query"). */
export function xsQueryGate(hubCaps: unknown, hasSurface: boolean, row: XsRowView): boolean {
  if (!Array.isArray(hubCaps) || !hubCaps.includes(XS_STATE_CAP) || !hasSurface) return false;
  return (
    row.deliveryEffect === "unknown" ||
    ["unknown", "accepted", "already_active", "unsupported"].includes(row.activationStatus ?? "")
  );
}

// ----------------------------------------------------------------- the mention seed store

const SEED_CAP = 64;
const STORE_CAP = 32;

interface SeedStore {
  readonly sessionId: string;
  readonly rows: Map<string, XsRowView>;
}

/** Module-level reactive seed store (`useCmdHistory` precedent): DetailDock seeds on a mention
 *  cmd_result; the request list and DetailBody's badge index read the same rows. The OUTER map
 *  is reactive too — a computed that read it before a store existed must re-run when one is
 *  created (agent switch / first seed). Bounded: ≤64 seeds per agent (FIFO), ≤32 agents. */
const seedStores = reactive(new Map<string, SeedStore>());

/** Record one mention send (generic unconfirmed; never overrides remote proof). */
export function seedXsMention(agentKey: string, sessionId: string, seed: XsMentionSeed, now: number): void {
  let store = seedStores.get(agentKey);
  if (store === undefined || store.sessionId !== sessionId) {
    if (seedStores.size >= STORE_CAP && !seedStores.has(agentKey)) {
      const oldest = seedStores.keys().next().value;
      if (oldest !== undefined) seedStores.delete(oldest);
    }
    store = reactive({ sessionId, rows: new Map<string, XsRowView>() }) as SeedStore;
    seedStores.set(agentKey, store);
  }
  const base: XsRowView =
    seed.row !== undefined
      ? { ...seed.row, seeded: true }
      : {
          messageId: seed.messageId,
          revision: 0,
          deliveryEffect: "unknown",
          observation: "live",
          wake: { requested: false, decision: "unknown" },
          ...(seed.activationKey !== undefined ? { activationKey: seed.activationKey } : {}),
          ...(seed.requestId !== undefined ? { requestId: seed.requestId } : {}),
          ...(now > 0 ? { queuedAt: now } : {}),
          seeded: true,
        };
  const existing = store.rows.get(seed.messageId);
  const merged = mergeXsRow(existing, base, false);
  store.rows.delete(seed.messageId); // refresh insertion order — the freshest evicts last
  store.rows.set(seed.messageId, merged);
  while (store.rows.size > SEED_CAP) {
    const oldest = store.rows.keys().next().value;
    if (oldest === undefined) break;
    store.rows.delete(oldest);
  }
}

/** P3b a manual action's SERVER outcome. Preserve original body/revision/first wake
 * stop; unknown/accepted claims never become delivered/started evidence. Bounded by
 * the existing seed store (64 rows/32 agents), session+exact-key scoped, no persistence.
 */
export function seedXsActivationOutcome(
  agentKey: string,
  sessionId: string,
  request: { action: "activate" | "query"; messageId: string; activationKey?: string },
  outcome: unknown,
  now: number,
): void {
  const raw = obj(outcome);
  const data = obj(raw?.["data"]);
  const result = obj(data?.["xsActivation"]);
  const existing =
    xsMentionSeeds(agentKey, sessionId).get(request.messageId) ??
    xsRemoteRows(agentKey, sessionId).get(request.messageId);
  if (!existing || request.activationKey !== existing.activationKey) return;
  if (result && result["messageId"] !== request.messageId) return;
  const effect = str(raw?.["effect"]);
  let status = request.action === "activate" ? str(result?.["status"]) : undefined;
  // Only a host response marks the attempt; browser/network speculation is not evidence.
  if (
    raw?.["ok"] === false &&
    effect === "unknown" &&
    raw["message"] === "xs:query-only" &&
    request.action === "activate"
  )
    status = "unknown";
  if (!["accepted", "already_active", "unknown", "refused", "unsupported"].includes(status ?? "")) return;
  const retryAfterAt = num(result?.["retryAfterAt"]);
  const current = existing.activationStatus;
  const sticky = current === "unknown" || current === "accepted" || current === "already_active";
  const row: XsRowView = {
    ...existing,
    activationStatus: sticky ? current : (status as NonNullable<XsRowView["activationStatus"]>),
    wake: { ...existing.wake, ...(retryAfterAt !== undefined ? { retryAfterAt } : {}) },
  };
  seedXsMention(
    agentKey,
    sessionId,
    {
      messageId: request.messageId,
      ...(request.activationKey !== undefined ? { activationKey: request.activationKey } : {}),
      row,
    },
    now,
  );
}

const EMPTY_SEEDS: ReadonlyMap<string, XsRowView> = new Map();

/** The current seeds for (agentKey, sessionId) — wrong-session seeds are invisible. */
export function xsMentionSeeds(agentKey: string, sessionId: string): ReadonlyMap<string, XsRowView> {
  const store = seedStores.get(agentKey);
  if (store === undefined || store.sessionId !== sessionId) return EMPTY_SEEDS;
  return store.rows;
}

/** Drop one agent's seeds (card removal — mirrors `control.forgetAgent`). */
export function forgetXsSeeds(agentKey: string): void {
  seedStores.delete(agentKey);
}

// ----------------------------------------------------------------- the persistent remote store

const REMOTE_CAP = XS_REQUESTS_MAX_ROWS; // ≤256 rows per agent = the wire slot's own row cap

interface RemoteStore {
  readonly sessionId: string;
  readonly rows: Map<string, XsRowView>;
}

/**
 * The persistent per-agent remote-merge store (root fix #4): every accepted, session-matched
 * `status.xsRequests` snapshot folds IN here, so an older snapshot frame arriving after a
 * newer one (out-of-order SSE/HTTP/snapshot across reconnects) can never regress a row — the
 * revision gate inside `mergeXsRow` is evaluated against the STORED row, not the previous
 * frame. Rows a fresh snapshot no longer lists are RETAINED as history (the furthest known
 * fact stays displayable) and leave only by FIFO eviction at {@link REMOTE_CAP} — the same
 * bound the wire slot itself projects. A sessionId change REPLACES the store (a session
 * switch inherits nothing); a wrong-session SNAPSHOT (≠ the card's current session) never
 * reaches here (the callers pre-check). Reactive: computeds reading {@link xsRemoteRows}
 * re-run on every fold.
 */
const remoteStores = reactive(new Map<string, RemoteStore>());

/** Fold one accepted snapshot into the store (idempotent; monotone by construction). */
export function acceptXsStatus(agentKey: string, sessionId: string, snapshot: XsRequestsSnapshot): void {
  let store = remoteStores.get(agentKey);
  if (store === undefined || store.sessionId !== sessionId) {
    store = reactive({ sessionId, rows: new Map<string, XsRowView>() }) as RemoteStore;
    remoteStores.set(agentKey, store);
  }
  for (const row of snapshot.rows) {
    const merged = mergeXsRow(store.rows.get(row.messageId), row, true);
    store.rows.delete(row.messageId); // refresh insertion order — the freshest evicts last
    store.rows.set(row.messageId, merged);
  }
  while (store.rows.size > REMOTE_CAP) {
    const oldest = store.rows.keys().next().value;
    if (oldest === undefined) break;
    store.rows.delete(oldest);
  }
}

/** The stored remote rows for (agentKey, sessionId) — a wrong session reads empty. */
export function xsRemoteRows(agentKey: string, sessionId: string): ReadonlyMap<string, XsRowView> {
  const store = remoteStores.get(agentKey);
  if (store === undefined || store.sessionId !== sessionId) return EMPTY_SEEDS;
  return store.rows;
}

/** Drop one agent's remote rows (card removal / session switch cleanup). */
export function forgetXsRemote(agentKey: string): void {
  remoteStores.delete(agentKey);
}
