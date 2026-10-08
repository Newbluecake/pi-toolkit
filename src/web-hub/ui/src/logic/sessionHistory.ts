/**
 * Session-history pure logic (session-history plan §4.7.1 — P-ui). No DOM, no I/O, no Vue:
 * every export here runs unchanged under vitest (node) and in the browser, the same
 * discipline as `./spawn.js` / `./sessionKeepAlive.ts`. The wire shapes come from the frozen
 * protocol module (`@protocol/session-history.js` — pure TS, no typebox/node imports, so
 * importing its RUNTIME constants here is as safe as `spawn.js` importing `version.ts`).
 *
 * Exports (plan §4.7.1):
 * - `toRowModel` — `HistoryItemWire` → the dialog's row model (badges are English tokens per
 *   AGENTS.md's UI-text split; the ONLY interpolated trust is via textContent downstream).
 * - `historyListReducer` — the list state machine. Events: `query` / `more` / `page` /
 *   `error` / `expired` (a 409 `cursor-expired` resets and restarts the SAME query from the
 *   beginning — at most ONE auto-restart per query, then it surfaces as an error).
 *   Rows are deduped BY KEY across pages (§4.5.3: the same file can appear in an old gen's
 *   page and in the new gen's pages after an `expired` restart). The UI NEVER sorts across
 *   pages — the server orders each page (PD23); the cross-page approximation is copy, not code.
 * - `nextRequest` — whether to continue scanning: auto ONLY while
 *   `partial.reason ∈ {budget, enum, io}` OR `stats.enum.complete === false`, at most
 *   `AUTO_CONTINUE_MAX` (3) auto rounds per input; `zombie` never auto-continues (F22).
 * - `historyErrorKey` / `sessionErrKey` — i18n key mappers for the error surfaces.
 * - `forkConfirmKey(reason, by, gap)` / `historyGapKey` — the HistoryForkConfirm copy pickers
 *   (six texts: open/card, open/managed, maybe/proc, subagent, manual, unverified).
 * - `incompleteNotice(stats, incomplete)` — the banner notice list (enumerating / skipped /
 *   dirsSkipped / changed / truncated, combinable).
 * - `narrowHistoryPage` — the structural narrowing both logic clients apply to a 200 body
 *   (non-conforming items are dropped; a missing `stats.enum` counts as complete — §4.7.1).
 */

import type {
  ForkReason,
  HistoryBlocked,
  HistoryItemWire,
  HistoryLiveWire,
  HistoryPage,
  ProofGap,
} from "@protocol/session-history.js";

/** The dialog's kind filter (§3.6: `kind=main` default, `all` includes subagent sessions). */
export type HistoryKindFilter = "main" | "all";

/** `localStorage["pwh_history_kind"]` — the persisted kind preference (§4.7.2). */
export const HISTORY_KIND_STORAGE_KEY = "pwh_history_kind";

/** Auto-continue rounds per input (§7.3 arch / §4.7.1: 每次输入最多 3 轮). */
export const AUTO_CONTINUE_MAX = 3;

/** Search debounce (§7.2 arch: 防抖 250ms). Exported for tests; the component owns the timer. */
export const SEARCH_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// row model
// ---------------------------------------------------------------------------

/** English-token badges (AGENTS.md UI-text split — inline markers never mix Chinese). */
export type HistoryRowBadge = "live" | "maybe" | "sub" | "forked" | "gone" | "moved" | "no-access" | "not-dir";

/** What the row's primary/secondary actions are (arch §5.5: `startable === false` ⇒ `[]`). */
export type HistoryRowAction = "resume" | "fork" | "goto";

export interface HistoryRowModel {
  readonly key: string;
  readonly id: string;
  /** `item.title` when present; `""` when absent — the component composes the 「（无标题）· id8」 fallback. */
  readonly title: string;
  readonly titleIsFallback: boolean;
  readonly cwd: string;
  readonly cwdLabel: string;
  /** Compact English relative time from `mtimeMs` (`5m ago` style — an inline marker). */
  readonly relTime: string;
  readonly mtimeMs: number;
  readonly badges: readonly HistoryRowBadge[];
  /** `[]` unless startable — `resume` only when no advisory forkOnly, `fork` always, `goto` last. */
  readonly actions: readonly HistoryRowAction[];
  readonly startable: boolean;
  readonly forkOnly?: ForkReason;
  readonly proofGap?: ProofGap;
  readonly live?: HistoryLiveWire;
  /** `live.agentKey` for the 「转到」 link — only while that agent is in the local list (arch §7.2). */
  readonly gotoAgentKey?: string;
  /** i18n key of the greyed-row reason (startable === false only). */
  readonly blockedKey?: string;
}

const BLOCKED_KEYS: Record<string, string> = {
  gone: "history.blockedGone",
  "no-access": "history.blockedNoAccess",
  "not-dir": "history.blockedNotDir",
  moved: "history.blockedMoved",
  invalid: "history.blockedInvalid",
};

/** Compact relative time — English tokens in BOTH languages (inline marker, AGENTS.md split). */
export function formatRelTime(now: number, at: number): string {
  const delta = now - at;
  if (!Number.isFinite(delta) || delta < 60_000) return "just now";
  const m = Math.floor(delta / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** arch §5.5's `toRowModel`. `knownCards` gates the 「转到」 action (the agent must be listed locally). */
export function toRowModel(
  item: HistoryItemWire,
  ctx: { now: number; knownCards: ReadonlySet<string> },
): HistoryRowModel {
  const badges: HistoryRowBadge[] = [];
  if (item.live !== undefined) badges.push(item.live.state === "open" ? "live" : "maybe");
  if (item.kind === "sub") badges.push("sub");
  if (item.forked === true) badges.push("forked");
  const cwdState = typeof item.cwdState === "string" ? item.cwdState : "unknown";
  if (cwdState === "gone" || cwdState === "moved" || cwdState === "no-access" || cwdState === "not-dir") {
    badges.push(cwdState);
  }
  const blocked = typeof item.blocked === "string" ? item.blocked : undefined;
  const blockedKey = blocked !== undefined ? BLOCKED_KEYS[blocked] : BLOCKED_KEYS[cwdState];
  const live = item.live;
  const agentKey = live !== undefined && typeof live.agentKey === "string" ? live.agentKey : undefined;
  const gotoAgentKey =
    agentKey !== undefined &&
    live !== undefined &&
    (live.by === "card" || live.by === "managed") &&
    ctx.knownCards.has(agentKey)
      ? agentKey
      : undefined;
  const startable = item.startable === true;
  const forkOnly = typeof item.forkOnly === "string" ? item.forkOnly : undefined;
  const actions: HistoryRowAction[] = [];
  if (startable) {
    if (forkOnly === undefined) actions.push("resume");
    actions.push("fork");
    if (gotoAgentKey !== undefined) actions.push("goto");
  }
  const title = typeof item.title === "string" && item.title.trim() !== "" ? item.title : "";
  return {
    key: item.key,
    id: item.id,
    title,
    titleIsFallback: title === "",
    cwd: item.cwd,
    cwdLabel: item.cwdLabel,
    relTime: formatRelTime(ctx.now, typeof item.mtimeMs === "number" ? item.mtimeMs : ctx.now),
    mtimeMs: typeof item.mtimeMs === "number" ? item.mtimeMs : ctx.now,
    badges,
    actions,
    startable,
    ...(forkOnly !== undefined ? { forkOnly } : {}),
    ...(item.proofGap !== undefined ? { proofGap: item.proofGap } : {}),
    ...(live !== undefined ? { live } : {}),
    ...(gotoAgentKey !== undefined ? { gotoAgentKey } : {}),
    ...(blockedKey !== undefined ? { blockedKey } : {}),
  };
}

// ---------------------------------------------------------------------------
// list state machine
// ---------------------------------------------------------------------------

export type HistoryListPhase = "idle" | "loading" | "ready" | "error";

export interface HistoryListError {
  readonly status: number;
  readonly error: string;
  readonly reason?: string;
}

export interface HistoryListState {
  readonly phase: HistoryListPhase;
  /** The committed query (already debounced by the component). */
  readonly q: string;
  readonly kind: HistoryKindFilter;
  readonly rows: readonly HistoryRowModel[];
  /** Keys already shown — the cross-page/cross-gen dedupe set (§4.5.3). */
  readonly seen: ReadonlySet<string>;
  readonly cursor?: string;
  readonly stats?: HistoryPage["stats"];
  readonly partial?: { readonly reason: "budget" | "enum" | "zombie" | "io" };
  readonly liveness?: "partial" | "no-proc";
  /** The latest page's `incomplete` flag (feeds `incompleteNotice`'s defensive generic line). */
  readonly incomplete?: true;
  /** Auto-continue rounds consumed by the current input (manual 「加载更多」 never counts). */
  readonly autoRounds: number;
  /** The single `cursor-expired` auto-restart of the current query (F16 / plan §4.7.1). */
  readonly expiredUsed: boolean;
  readonly error?: HistoryListError;
}

export const HISTORY_LIST_IDLE: HistoryListState = Object.freeze({
  phase: "idle",
  q: "",
  kind: "main",
  rows: [],
  seen: new Set<string>(),
  autoRounds: 0,
  expiredUsed: false,
}) as HistoryListState;

export type HistoryListEvent =
  | { readonly type: "query"; readonly q: string; readonly kind: HistoryKindFilter }
  | { readonly type: "more" }
  | {
      readonly type: "page";
      readonly page: HistoryPage;
      readonly now: number;
      readonly knownCards: ReadonlySet<string>;
      /** True when this page was an AUTO-continue round (counts against AUTO_CONTINUE_MAX). */
      readonly auto?: boolean;
    }
  | { readonly type: "error"; readonly status: number; readonly error: string; readonly reason?: string }
  | { readonly type: "expired" };

function resetFor(state: HistoryListState, q: string, kind: HistoryKindFilter, expiredUsed: boolean): HistoryListState {
  return {
    phase: "loading",
    q,
    kind,
    rows: [],
    seen: new Set<string>(),
    autoRounds: 0,
    expiredUsed,
  };
}

export function historyListReducer(state: HistoryListState, ev: HistoryListEvent): HistoryListState {
  switch (ev.type) {
    case "query":
      // A query change (or explicit refresh) drops everything — a NEW server generation will
      // start; the expired-restart budget resets with it.
      return resetFor(state, ev.q, ev.kind, false);
    case "more":
      if (state.phase !== "ready" || state.cursor === undefined) return state;
      return { ...state, phase: "loading" };
    case "page": {
      const seen = new Set(state.seen);
      const rows = [...state.rows];
      for (const item of ev.page.items) {
        // Dedupe BY KEY: the same file can ride an old gen's page and a new gen's page after
        // an `expired` restart — the second copy must not double the row (§4.5.3).
        if (typeof item?.key !== "string" || seen.has(item.key)) continue;
        seen.add(item.key);
        rows.push(toRowModel(item, { now: ev.now, knownCards: ev.knownCards }));
      }
      const partial =
        ev.page.partial !== undefined && typeof ev.page.partial.reason === "string"
          ? { reason: ev.page.partial.reason }
          : undefined;
      const next: HistoryListState = {
        phase: "ready",
        q: state.q,
        kind: state.kind,
        rows,
        seen,
        autoRounds: ev.auto === true ? state.autoRounds + 1 : state.autoRounds,
        expiredUsed: state.expiredUsed,
        ...(ev.page.next !== undefined && typeof ev.page.next === "string" ? { cursor: ev.page.next } : {}),
        ...(ev.page.stats !== undefined ? { stats: ev.page.stats } : {}),
        ...(partial !== undefined ? { partial } : {}),
        ...(ev.page.liveness !== undefined ? { liveness: ev.page.liveness } : {}),
        ...(ev.page.incomplete === true ? { incomplete: true } : {}),
      };
      return next;
    }
    case "error":
      // Rows are kept: an appended-page error still shows what the query gathered so far.
      return {
        ...state,
        phase: "error",
        error: { status: ev.status, error: ev.error, ...(ev.reason !== undefined ? { reason: ev.reason } : {}) },
      };
    case "expired":
      // 409 cursor-expired (F16): restart the SAME query from the beginning — but at most
      // once per query; a second expiry within one query surfaces as an error instead.
      if (state.expiredUsed) {
        return {
          ...state,
          phase: "error",
          error: { status: 409, error: "E_BAD_REQUEST", reason: "cursor-expired" },
        };
      }
      return resetFor(state, state.q, state.kind, true);
  }
}

/** `nextRequest`'s product — `auto:true` means the reducer's auto-continue rule fired. */
export interface HistoryNextRequest {
  readonly q: string;
  readonly kind: HistoryKindFilter;
  readonly cursor?: string;
  readonly auto: boolean;
}

/**
 * §4.7.1: auto-continue ONLY while `partial.reason ∈ {budget, enum, io}` OR
 * `stats.enum.complete === false`, at most `AUTO_CONTINUE_MAX` auto rounds per input;
 * `zombie` never auto-continues (F22 — the breaker means hub IO is wedged). A non-auto
 * answer is still returned while a cursor exists: the dialog renders 「加载更多」 for it.
 */
export function nextRequest(state: HistoryListState): HistoryNextRequest | null {
  if (state.phase !== "ready" || state.cursor === undefined) return null;
  const reason = state.partial?.reason;
  const enumIncomplete = state.stats?.enum.complete === false;
  const wantsAuto = reason === "budget" || reason === "enum" || reason === "io" || enumIncomplete;
  const auto = wantsAuto && reason !== "zombie" && state.autoRounds < AUTO_CONTINUE_MAX;
  return { q: state.q, kind: state.kind, cursor: state.cursor, auto };
}

// ---------------------------------------------------------------------------
// key mappers
// ---------------------------------------------------------------------------

/** GET /api/headless/history error → i18n key. 503 is the retryable "busy" state (plan v3.2
 * V2 / dispatch note: dispose & fd-ledger refusals must render as busy, never as generic). */
export function historyErrorKey(error: string, status: number): string {
  if (status === 503 || error === "E_BUSY") return "history.errBusy";
  if (status === 429 || error === "E_RATE") return "history.errRate";
  if (error === "E_DEADLINE") return "history.errDeadline";
  if (error === "E_AUTH") return "history.errAuth";
  if (status === 404) return "spawn.errUnsupported";
  if (status === 409) return "history.errCursor";
  return "history.errNetwork";
}

/** `SessionSpawnRejectReason` → `history.err*` (the failed{kind:"session"} inline line). */
const SESSION_ERR_KEYS: Record<string, string> = {
  "session-ref": "history.errSessionRef",
  "model-with-session": "history.errModelWithSession",
  "session-missing": "history.errSessionMissing",
  "session-mismatch": "history.errSessionMismatch",
  "session-invalid": "history.errSessionInvalid",
  "session-too-large": "history.errSessionTooLarge",
  moved: "history.errMoved",
  "session-changed": "history.errSessionChanged",
  unsupported: "history.errSessionUnsupported",
};

/** Keys of {@link SESSION_ERR_KEYS} — a test anchor against protocol drift. */
export const SESSION_ERR_CODES = Object.freeze(Object.keys(SESSION_ERR_KEYS));

export function sessionErrKey(code: string | undefined): string {
  if (typeof code !== "string") return "history.errSessionInvalid";
  return SESSION_ERR_KEYS[code] ?? "history.errSessionInvalid";
}

/** The HistoryForkConfirm body key — the six texts (plan §4.7.2 / arch §7.4). `gap` is part
 * of the frozen signature but never selects the key: it only fills the unverified body's
 * `{gap}` placeholder (`historyGapKey`). */
export function forkConfirmKey(reason: ForkReason | "manual", by?: HistoryLiveWire["by"], _gap?: ProofGap): string {
  switch (reason) {
    case "open":
      if (by === "card") return "history.forkOpenCard";
      if (by === "managed") return "history.forkOpenManaged";
      return "history.forkUnverified"; // open/proc is not a hub-produced combo — degrade to the generic
    case "maybe":
      return "history.forkMaybeProc";
    case "subagent":
      return "history.forkSubagent";
    case "manual":
      return "history.forkManual";
    default:
      return "history.forkUnverified";
  }
}

/** `ProofGap` → the `{gap}` text of the unverified body (§4.7.2's five mappings). */
export function historyGapKey(gap: ProofGap | undefined): string | undefined {
  if (gap === undefined) return undefined;
  switch (gap) {
    case "kind":
      return "history.gapKind";
    case "unconnected-pi":
      return "history.gapUnconnectedPi";
    case "card-unproven":
      return "history.gapCardUnproven";
    case "proc-partial":
      return "history.gapProcPartial";
    case "new-process":
      return "history.gapNewProcess";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// incomplete notices
// ---------------------------------------------------------------------------

/** One banner/notice entry — `n` carries the count when the key has an `{n}` placeholder. */
export interface HistoryNotice {
  readonly key: string;
  readonly n?: number;
  readonly dirsDone?: number;
  readonly dirsTotal?: number;
}

/**
 * §4.7.2's notice list (combinable, fixed order): enumerating / skipped / dirsSkipped /
 * changed / truncated. The `incomplete` flag covers the derivable-but-defensive case: a page
 * that SAYS incomplete without any specific detectable cause still surfaces one generic line.
 */
export function incompleteNotice(stats: HistoryPage["stats"] | undefined, incomplete?: true): readonly HistoryNotice[] {
  const out: HistoryNotice[] = [];
  const enumStats = stats?.enum;
  if (enumStats !== undefined && enumStats.complete !== true) {
    out.push({
      key: "history.noticeEnumRunning",
      ...(typeof enumStats.dirsDone === "number" ? { dirsDone: enumStats.dirsDone } : { dirsDone: 0 }),
      ...(typeof enumStats.dirsTotal === "number" ? { dirsTotal: enumStats.dirsTotal } : { dirsTotal: 0 }),
    });
  }
  const skipped = stats?.skipped;
  if (typeof skipped === "number" && skipped > 0) out.push({ key: "history.noticeSkipped", n: skipped });
  const dirsSkipped = enumStats?.dirsSkipped;
  if (typeof dirsSkipped === "number" && dirsSkipped > 0) {
    out.push({ key: "history.noticeDirsSkipped", n: dirsSkipped });
  }
  const changed = stats?.changed;
  if (typeof changed === "number" && changed > 0) out.push({ key: "history.noticeChanged", n: changed });
  if (enumStats?.dirsTruncated === true || enumStats?.filesTruncated === true) {
    out.push({ key: "history.noticeTruncated" });
  }
  if (out.length === 0 && incomplete === true) out.push({ key: "history.noticeIncomplete" });
  return out;
}

// ---------------------------------------------------------------------------
// wire narrowing (shared by both logic clients — §4.7.1: 丢弃不合规的项)
// ---------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function narrowItem(raw: unknown): HistoryItemWire | null {
  if (raw === null || typeof raw !== "object") return null;
  const it = raw as Record<string, unknown>;
  const key = str(it["key"]);
  const id = str(it["id"]);
  const cwd = str(it["cwd"]);
  const cwdLabel = str(it["cwdLabel"]);
  const startedAt = str(it["startedAt"]);
  const mtimeMs = num(it["mtimeMs"]);
  const size = num(it["size"]);
  const kind = str(it["kind"]);
  const cwdState = str(it["cwdState"]);
  const titleSource = str(it["titleSource"]);
  if (
    key === undefined ||
    id === undefined ||
    cwd === undefined ||
    cwdLabel === undefined ||
    startedAt === undefined ||
    mtimeMs === undefined ||
    size === undefined ||
    (kind !== "main" && kind !== "sub" && kind !== "unknown") ||
    (cwdState !== "ok" &&
      cwdState !== "gone" &&
      cwdState !== "not-dir" &&
      cwdState !== "no-access" &&
      cwdState !== "moved" &&
      cwdState !== "unknown") ||
    (titleSource !== "name" && titleSource !== "first" && titleSource !== "none")
  ) {
    return null;
  }
  const live = it["live"];
  let liveWire: HistoryLiveWire | undefined;
  if (live !== null && typeof live === "object") {
    const l = live as Record<string, unknown>;
    const state = str(l["state"]);
    const by = str(l["by"]);
    if ((state === "open" || state === "maybe") && (by === "card" || by === "managed" || by === "proc")) {
      const agentKey = str(l["agentKey"]);
      const pid = num(l["pid"]);
      liveWire = {
        state,
        by,
        ...(agentKey !== undefined ? { agentKey } : {}),
        ...(pid !== undefined ? { pid } : {}),
      };
    }
  }
  const forkOnly = str(it["forkOnly"]);
  const proofGap = str(it["proofGap"]);
  const blocked = str(it["blocked"]);
  const title = str(it["title"]);
  return {
    key,
    id,
    cwd,
    cwdLabel,
    startedAt,
    mtimeMs,
    size,
    indexed: true,
    kind,
    cwdState,
    titleSource,
    ...(title !== undefined ? { title } : {}),
    ...(it["forked"] === true ? { forked: true } : {}),
    startable: it["startable"] === true,
    ...(blocked !== undefined ? { blocked: blocked as HistoryBlocked } : {}),
    ...(liveWire !== undefined ? { live: liveWire } : {}),
    ...(forkOnly === "open" || forkOnly === "maybe" || forkOnly === "subagent" || forkOnly === "unverified"
      ? { forkOnly }
      : {}),
    ...(proofGap !== undefined ? { proofGap: proofGap as ProofGap } : {}),
  };
}

/**
 * Structural narrowing of a 200 body into `HistoryPage`. Non-conforming ITEMS are dropped
 * (never the whole page); `stats.enum` missing ⇒ `{complete:true, dirsDone:0, dirsTotal:0}`;
 * unknown `partial.reason` / `liveness` values are omitted. `null` only for a body that is
 * not an object at all — the caller turns that into an `E_BAD_RESPONSE` outcome.
 */
export function narrowHistoryPage(body: unknown): HistoryPage | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const d = body as Record<string, unknown>;
  const rawItems = Array.isArray(d["items"]) ? (d["items"] as unknown[]) : [];
  const items: HistoryItemWire[] = [];
  for (const raw of rawItems) {
    const item = narrowItem(raw);
    if (item !== null) items.push(item);
  }
  const rawStats = d["stats"];
  const statsObj = rawStats !== null && typeof rawStats === "object" ? (rawStats as Record<string, unknown>) : {};
  const rawEnum = statsObj["enum"];
  const enumObj = rawEnum !== null && typeof rawEnum === "object" ? (rawEnum as Record<string, unknown>) : undefined;
  const stats: HistoryPage["stats"] = {
    files: num(statsObj["files"]) ?? items.length,
    indexed: num(statsObj["indexed"]) ?? items.length,
    enum: {
      // A missing/garbage `enum` counts as COMPLETE (§4.7.1) — the enumeration finished as
      // far as this client can tell; nothing here may resurrect an "enumerating" UI state.
      complete: enumObj === undefined || enumObj["complete"] === true,
      dirsDone: num(enumObj?.["dirsDone"]) ?? 0,
      dirsTotal: num(enumObj?.["dirsTotal"]) ?? 0,
      ...(num(enumObj?.["dirsSkipped"]) !== undefined ? { dirsSkipped: num(enumObj?.["dirsSkipped"])! } : {}),
      ...(enumObj?.["dirsTruncated"] === true ? { dirsTruncated: true } : {}),
      ...(enumObj?.["filesTruncated"] === true ? { filesTruncated: true } : {}),
    },
    ...(num(statsObj["invalid"]) !== undefined ? { invalid: num(statsObj["invalid"])! } : {}),
    ...(num(statsObj["vanished"]) !== undefined ? { vanished: num(statsObj["vanished"])! } : {}),
    ...(num(statsObj["skipped"]) !== undefined ? { skipped: num(statsObj["skipped"])! } : {}),
    ...(num(statsObj["changed"]) !== undefined ? { changed: num(statsObj["changed"])! } : {}),
  };
  const partialReason = str((d["partial"] as Record<string, unknown> | undefined)?.["reason"]);
  const liveness = str(d["liveness"]);
  return {
    items,
    stats,
    ...(str(d["next"]) !== undefined ? { next: str(d["next"])! } : {}),
    ...(partialReason === "budget" || partialReason === "enum" || partialReason === "zombie" || partialReason === "io"
      ? { partial: { reason: partialReason } }
      : {}),
    ...(d["incomplete"] === true ? { incomplete: true } : {}),
    ...(liveness === "partial" || liveness === "no-proc" ? { liveness } : {}),
  };
}

// ---------------------------------------------------------------------------
// kind preference (pure halves; the component owns the try/catch storage access)
// ---------------------------------------------------------------------------

/** Read the persisted kind preference; junk / failures fail open to `"main"` (the default). */
export function readHistoryKindPref(storage: { getItem(key: string): string | null } | null): HistoryKindFilter {
  try {
    return storage?.getItem(HISTORY_KIND_STORAGE_KEY) === "all" ? "all" : "main";
  } catch {
    return "main";
  }
}

/** Persist the kind preference; best-effort by design (storage failures are ignored). */
export function writeHistoryKindPref(
  storage: { setItem(k: string, v: string): void } | null,
  kind: HistoryKindFilter,
): void {
  try {
    storage?.setItem(HISTORY_KIND_STORAGE_KEY, kind);
  } catch {
    /* best-effort only */
  }
}

// ---------------------------------------------------------------------------
// response mapping (shared by both logic clients — §4.7.1's narrowing + error halves)
// ---------------------------------------------------------------------------

/** The minimal response surface both clients' `request`/`postRaw` return (r.json() read once). */
interface HistoryResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/**
 * `GET /api/headless/history` response → `SpawnHistoryOutcome`. 200 ⇒ `narrowHistoryPage`
 * (a non-object body maps to `E_BAD_RESPONSE` with the 200 status); errors keep the wire
 * `reason` (409 `cursor-expired`) and map 401 to `E_AUTH` the same way `spawnFromResponse`
 * does in both clients. Total — never throws.
 */
export async function historyOutcomeFromResponse(
  r: HistoryResponseLike,
): Promise<{ ok: true; page: HistoryPage } | { ok: false; error: string; status: number; reason?: string }> {
  let body: unknown;
  try {
    body = await r.json();
  } catch {
    body = undefined;
  }
  if (r.ok) {
    const page = narrowHistoryPage(body);
    if (page === null) return { ok: false, error: "E_BAD_RESPONSE", status: r.status };
    return { ok: true, page };
  }
  const b = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const reason = typeof b["reason"] === "string" ? (b["reason"] as string) : undefined;
  return {
    ok: false,
    error: typeof b["error"] === "string" ? (b["error"] as string) : r.status === 401 ? "E_AUTH" : `HTTP ${r.status}`,
    status: r.status,
    ...(reason !== undefined ? { reason } : {}),
  };
}
