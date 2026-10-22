/**
 * Session alias port types (alias-plan r4 §3/§4/§10, AL0b) — TYPES ONLY, no behaviour.
 *
 * Imported by the hub binding table (AL1), router (AL2), agent bridge/cache (AL3), the command layer (AL4),
 * the sender/tools (AL5a) and mention (AL5b); implementations live in those packages. Value imports are
 * deliberately absent so this module stays erasable.
 */
import type { XsAliasRejectReason } from "../../web-hub/protocol/xs-alias.js";
import type { XsAliasResWire, XsAliasStateWire, XsAliasTakePreviewWire } from "../../web-hub/protocol/xs.js";

// ----------------------------------------------------------------- hub side (§3)

/** Persisted binding record (§3.1). Presence/offline state is NEVER part of it. */
export interface XsAliasRecord {
  alias: string;
  skeleton: string;
  sessionId: string;
  state: "held" | "cooling";
  coolUntil?: number;
  rev: number;
  cwdLabel: string;
}
export interface XsAliasTombstone {
  sessionId: string;
  alias: string;
  reason: "taken" | "expired";
  at: number;
}

/** Binding-table IO/load state (§3.3 matrix). `degraded` + `wedged`/`disabled` are the externally visible ones. */
export type XsAliasStoreState = "loading" | "ready" | "wedged" | "disabled" | "degraded";
export type XsAliasDegradedReason = "corrupt" | "unreadable" | "timeout";
export interface XsAliasStoreStatus {
  state: XsAliasStoreState;
  /** Set iff `state === "degraded"`. */
  degradedReason?: XsAliasDegradedReason;
  /** Absolute path shown by `/webhub status` when degraded (local/token callers only). */
  path?: string;
  records: number;
}

/** Hub-side parameters (§3.6, `HubConfig.crossSession.alias`; missing ⇒ these defaults, never "off"). */
export interface XsAliasHubParams {
  offlineLeaseH: number;
  coolMin: number;
  takeMinOfflineMin: number;
}

/** Why a take was refused / a write failed — codes carry the detail in the brace suffix on the wire. */
export type XsAliasWriteFailure =
  | { code: "E_XS_ALIAS_INVALID"; detail: XsAliasRejectReason }
  | { code: "E_XS_ALIAS_TAKEN"; detail: "taken" | "confusable" }
  | { code: "E_XS_ALIAS_TAKE"; detail: "online" | "recent" | "stale" | "not_held" }
  | { code: "E_XS_ALIAS_FULL" }
  | { code: "E_XS_ALIAS_BUSY"; detail: "queue" | "io" | "tokens" }
  | { code: "E_XS_ALIAS_UNKNOWN" };

/** Requester identity a write is bound to (rename-before re-check, §3.3-4). */
export interface XsAliasRequester {
  sessionId: string;
  epoch: number;
}

export type XsAliasWriteResult = { ok: true; res: XsAliasStateWire } | { ok: false; failure: XsAliasWriteFailure };
export type XsAliasPreviewResult =
  { ok: true; res: XsAliasTakePreviewWire } | { ok: false; failure: XsAliasWriteFailure };

/** Hub binding table port (AL1 implements, AL2 consumes). Reads are lock-free over the in-memory table. */
export interface XsAliasStorePort {
  status(): XsAliasStoreStatus;
  /** `aliasAdvertised`: fixed for the run, true iff the initial load was `ready`. */
  readonly advertised: boolean;
  /** §5.1 layer 3: the live record for a canonical alias (held, or coolingLive), else undefined. */
  lookup(canonicalAlias: string): XsAliasRecord | undefined;
  /** held alias of a session (for rows/target/from stamping), else undefined. */
  heldBy(sessionId: string): string | undefined;
  /** get: held alias + one-shot `lost` notice (does not consume it). */
  get(requester: XsAliasRequester): XsAliasStateWire;
  set(requester: XsAliasRequester, rawAlias: string, cwdLabel: string): Promise<XsAliasWriteResult>;
  clear(requester: XsAliasRequester): Promise<XsAliasWriteResult>;
  takePreview(requester: XsAliasRequester, rawAlias: string): XsAliasPreviewResult;
  /** Any outcome consumes the token (§3.5). */
  take(requester: XsAliasRequester, rawAlias: string, token: string, cwdLabel: string): Promise<XsAliasWriteResult>;
}

// ----------------------------------------------------------------- agent side (§4)

/** One cache entry; the cache is per stack, keyed by sessionId, ≤8 entries FIFO, never persisted. */
export interface XsAliasCacheEntry {
  alias?: string;
  lostAt?: number;
}

/** Outcome of a bounded (5s) alias op over the xs bridge (`op:"alias"`). */
export type XsAliasBridgeResult = { ok: true; res: XsAliasResWire } | { ok: false; code: string; reason?: string };

/** Agent-side bridge for `op:"alias"`; undefined/unsupported when the hub lacks the cap ⇒ `/fabric alias` refuses locally. */
export interface XsAliasBridgePort {
  readonly supported: boolean;
  get(): Promise<XsAliasBridgeResult>;
  set(rawAlias: string): Promise<XsAliasBridgeResult>;
  clear(): Promise<XsAliasBridgeResult>;
  takePreview(rawAlias: string): Promise<XsAliasBridgeResult>;
  take(rawAlias: string, token: string): Promise<XsAliasBridgeResult>;
}

/** Agent-side alias cache port (reconcile-on-attach/hello_ack/status; last-arrival-wins on the current connection). */
export interface XsAliasCachePort {
  /** Local cached alias for the CURRENT sessionId (display only). */
  current(): XsAliasCacheEntry | undefined;
  /** Reconcile with the hub (bounded get). Never throws; failure waits for the next trigger. */
  reconcile(): Promise<void>;
  /** True iff alias mode is on: local `alias.enabled` ∧ hub advertised `xs.alias.v1` (symmetric with hub `aliasUsable`). */
  readonly usable: boolean;
}
