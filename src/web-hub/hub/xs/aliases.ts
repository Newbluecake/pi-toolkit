/**
 * Hub alias binding table (alias-plan r4 §3, package AL1) — pure hub module, consumed by the xs
 * router (AL2). No pi imports, no `src/fabric/**` imports (web-hub boundary): the result/record
 * types below are structurally identical to `src/fabric/xs/types-alias.ts`'s `XsAliasStorePort`
 * family, re-declared here because hub code may not reach into fabric.
 *
 * Design (plan §3.1–§3.5, §R2/§R3):
 * - **Single writer**: records + tombstones change ONLY inside a human-initiated op transaction
 *   (`set` / `clear` / `take`). Presence (online / offlineSince) lives in memory only and is never
 *   serialized; lease expiry and cooling expiry are READ-TIME predicates — nothing ever writes on a
 *   timer (I6). After `load()` every held sid counts as offline since the load instant (R8).
 * - **Bounded writes**: one transaction runs at a time; ≤4 waiters (5th ⇒ BUSY{queue}); hub-side
 *   budget 4s including queue wait. Each transaction writes its own never-reused temp file
 *   (`xs-aliases.json.<8hex>.tmp`, O_EXCL 0600, fsync'd) under a 2s cap (timeout ⇒ zombie, >2
 *   zombies ⇒ `disabled`), re-checks requester / generation / take conditions / budget, then
 *   renames. rename settled ≤1s ⇒ memory updated, reply; rename still in flight after 1s ⇒
 *   `E_XS_ALIAS_UNKNOWN` + `wedged` (writes busy, reads keep the old table) until it settles
 *   (success ⇒ apply; failure ⇒ unchanged); in flight >60s ⇒ `disabled` for the rest of the run.
 * - **Load tri-state**: missing file ⇒ `ready` (empty, nothing created); corrupt / unreadable /
 *   load timeout (2s) ⇒ `degraded` and NOT advertised. A degraded store never writes a byte — the
 *   bad file stays in place, so the next start is degraded again until a human fixes/moves it (R10).
 *   `advertised` is fixed for the run (true iff the initial load was `ready`).
 * - **Take tokens**: in-memory only, ≤32, 5 min TTL, bound to (requester sid, alias, holder sid,
 *   record rev, `mode`, holder `presenceKey`); removed from the table the moment an execute request
 *   arrives, so ANY outcome consumes it.
 *
 * Alias-force-default plan (#72, AF1) additions — all append-only, a v1 requester sees v1 bytes:
 * - **auto** (`autoClaim`, I7): creates a record only; a SYNCHRONOUS pre-check answers every "name is
 *   taken / session already settled" case without occupying a queue slot; only an auto that can succeed
 *   is enqueued, and the same predicate is re-run inside the transaction.
 * - **force** (`forcePreview` + a `mode:"force"` token, I5′): takes a held alias from a holder that is
 *   `notifiable` (offline, or xs-online with EVERY effective member declaring `xs.alias.v2`; a holder that
 *   is merely `linked` — connected to the hub but not an effective xs member — is never notifiable).
 *   The token binds `presenceKey` (`on` | `off:<offlineSince>`) and the record `rev`; execution re-checks
 *   both inside the plan and again before rename. `onForcedCommit` fires after the commit (incl. a late
 *   wedged rename success) so the router can push `xs_alias_evt`.
 * - persisted optional keys: `origin:"auto"` on a record, `forced:true` on a tombstone (never a new
 *   `reason` value — an old hub must not degrade on the file).
 *
 * Timers: only per-transaction budget timers (all unref'd via the default `timer` dep, cancelled
 * on settle). The clock (`now`) and the timer factory are injectable for deterministic tests.
 */
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  aliasSkeleton,
  normalizeAlias,
  XS_ALIAS_SKELETON_VERSION,
  XS_ALIAS_TAKE_TOKEN_RE,
  type XsAliasRejectReason,
} from "../../protocol/xs-alias.js";
import type { XsAliasStateWire, XsAliasTakePreviewWire } from "../../protocol/xs.js";

// ----------------------------------------------------------------- constants

export const XS_ALIAS_FILE = "xs-aliases.json";
/** §3.3: records cap (new records only — G / transfers never trip it). */
export const XS_ALIAS_MAX_RECORDS = 256;
/** §3.3: on-disk cap (load: larger ⇒ corrupt; write: larger after dropping oldest tombstones ⇒ FULL). */
export const XS_ALIAS_MAX_FILE_BYTES = 64 * 1024;
export const XS_ALIAS_MAX_TOMBSTONES = 256;
export const XS_ALIAS_TOMBSTONE_TTL_MS = 30 * 24 * 3600_000;
/** §3.3-1: waiting transactions (the running one excluded). */
export const XS_ALIAS_QUEUE_MAX = 4;
/** §3.3-1: hub-side transaction budget, queue wait included (client deadline 5s). */
export const XS_ALIAS_TXN_BUDGET_MS = 4_000;
/** §3.3-3: temp write + fsync cap. */
export const XS_ALIAS_WRITE_STEP_MS = 2_000;
/** §3.3-5: rename settle window before replying UNKNOWN and wedging. Reserved inside the 4s budget. */
export const XS_ALIAS_RENAME_WAIT_MS = 1_000;
/** §3.3-5: a rename still in flight after this ⇒ `disabled` until restart. */
export const XS_ALIAS_WEDGE_DISABLE_MS = 60_000;
/** §3.3-3: cumulative temp-write zombies tolerated; one more ⇒ `disabled`. */
export const XS_ALIAS_ZOMBIE_MAX = 2;
/** §3.3 load budget. */
export const XS_ALIAS_LOAD_BUDGET_MS = 2_000;
/** §3.5 token table. */
export const XS_ALIAS_TOKENS_MAX = 32;
export const XS_ALIAS_TOKEN_TTL_MS = 5 * 60_000;
/** §3.5-1: `cwdLabel` is untrusted text — `\p{C}` stripped, ≤120 code points. */
export const XS_ALIAS_CWD_LABEL_MAX = 120;
const SESSION_ID_MAX = 128;
const ALIAS_RAW_MAX = 128;

/** §3.6 defaults; a missing `HubConfig.crossSession.alias` NEVER means off. */
export const XS_ALIAS_DEFAULT_PARAMS: Readonly<XsAliasHubParams> = Object.freeze({
  offlineLeaseH: 168,
  coolMin: 10,
  takeMinOfflineMin: 10,
});
/** Clamp windows (mirror `config/settings.ts` FABRIC_XS_ALIAS_* — hub may not import config). */
const PARAM_BOUNDS = {
  offlineLeaseH: [1, 720],
  coolMin: [1, 1_440],
  takeMinOfflineMin: [10, 1_440], // floor = NQ1
} as const;

// ----------------------------------------------------------------- types (≡ src/fabric/xs/types-alias.ts)

export interface XsAliasHubParams {
  offlineLeaseH: number;
  coolMin: number;
  takeMinOfflineMin: number;
}

/** Persisted binding record (§3.1). Presence is never part of it. */
export interface XsAliasRecord {
  alias: string;
  skeleton: string;
  sessionId: string;
  state: "held" | "cooling";
  coolUntil?: number;
  rev: number;
  cwdLabel: string;
  /** `"auto"` iff auto-claimed from the cwd basename; any human grant drops it. Optional on disk. */
  origin?: "auto";
}
export interface XsAliasTombstone {
  sessionId: string;
  alias: string;
  reason: "taken" | "expired";
  at: number;
  /** `true` iff the take was a `--force`. Optional on disk (reason stays `taken`). */
  forced?: true;
}

export type XsAliasStoreState = "loading" | "ready" | "wedged" | "disabled" | "degraded";
export type XsAliasDegradedReason = "corrupt" | "unreadable" | "timeout";
export type XsAliasDisabledReason = "zombie" | "wedge-timeout";

export interface XsAliasStoreStatus {
  state: XsAliasStoreState;
  /** Set iff `state === "degraded"`. */
  degradedReason?: XsAliasDegradedReason;
  /** Set iff `state === "disabled"`. */
  disabledReason?: XsAliasDisabledReason;
  /** Absolute file path (the caller decides who may see it). */
  path: string;
  /** Fixed for the run: initial load was `ready`. */
  advertised: boolean;
  records: number;
  held: number;
  /** Live (unexpired) cooling records. */
  cooling: number;
  tombstones: number;
  tokens: number;
  /** Running + waiting transactions. */
  queue: number;
  /** Cumulative temp-write zombies this run. */
  zombies: number;
}

export type XsAliasWriteFailure =
  | { code: "E_XS_ALIAS_INVALID"; detail: XsAliasRejectReason }
  | { code: "E_XS_ALIAS_TAKEN"; detail: "taken" | "confusable" }
  | { code: "E_XS_ALIAS_TAKE"; detail: "online" | "recent" | "stale" | "not_held" | "unnotifiable" }
  | { code: "E_XS_ALIAS_FULL" }
  | { code: "E_XS_ALIAS_BUSY"; detail: "queue" | "io" | "tokens" }
  | { code: "E_XS_ALIAS_UNKNOWN" };

/** Requester identity a write is bound to; `agentKey` is opaque to the store (for the router's
 *  `isRequesterLive` closure). */
export interface XsAliasRequester {
  sessionId: string;
  epoch: number;
  agentKey?: string;
  /** The requester declared `xs.alias.v2` (set by the router): only then may `origin` / `lost.forced` /
   *  preview `online`+`auto` be written into a reply. Absent ⇒ v1 bytes. */
  v2?: boolean;
}

export type XsAliasWriteResult = { ok: true; res: XsAliasStateWire } | { ok: false; failure: XsAliasWriteFailure };
export type XsAliasPreviewResult =
  { ok: true; res: XsAliasTakePreviewWire } | { ok: false; failure: XsAliasWriteFailure };
export type XsAliasLoadResult =
  { state: "ready"; records: number; fresh: boolean } | { state: "degraded"; reason: XsAliasDegradedReason };

/** Narrow fs seam (tests inject slow / hung / failing IO). */
export interface XsAliasFs {
  /** Bounded read: `missing` on ENOENT; `toolarge` past the cap; throws on any other failure
   *  (incl. a non-regular file / symlink ⇒ unreadable). */
  read(
    path: string,
    maxBytes: number,
  ): Promise<{ kind: "missing" } | { kind: "toolarge" } | { kind: "bytes"; bytes: Uint8Array }>;
  /** Create `path` exclusively (O_EXCL|O_NOFOLLOW, 0600), write, fsync, close. */
  writeTemp(path: string, bytes: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  /** Best-effort directory fsync after a committed rename. */
  syncDir(dir: string): Promise<void>;
}

export interface XsAliasTimerHandle {
  cancel(): void;
}
export type XsAliasTimer = (fn: () => void, ms: number) => XsAliasTimerHandle;

export interface XsAliasStoreDeps {
  /** `HubPaths.stateDir` (a private 0700 dir ensured by hub startup). */
  stateDir: string;
  /** Raw `HubConfig.crossSession.alias`; clamped here, missing ⇒ defaults. */
  params?: Partial<XsAliasHubParams> | undefined;
  /** Read-time presence: the sid has ≥1 effective member right now (`members.effectiveAll()`). */
  isOnline(sessionId: string): boolean;
  /** Rename-before re-check (§3.3-4): requester is still the same sid/epoch effective member. */
  isRequesterLive(requester: XsAliasRequester): boolean;
  /** Alias-force-default §2: the sid has a registry record that is connected ∧ phase≠stale but is NOT an
   *  effective xs member (checked only after `isOnline` said no). Absent ⇒ never linked. */
  isLinked?(sessionId: string): boolean;
  /** Alias-force-default §4: EVERY effective member of the (xs-online) sid declares `xs.alias.v2`. Absent ⇒
   *  false, i.e. force is refused `unnotifiable` for any online holder. */
  allMembersV2?(sessionId: string): boolean;
  /** Alias-force-default I10 (AF7): the HUB's own evidence that `requester`'s socket moved from `prevSessionId` to
   *  `requester.sessionId` (members' succession edge, ≤120 s). Absent ⇒ no handoff ever succeeds. Read-only. */
  isSuccessor?(requester: XsAliasRequester, prevSessionId: string): boolean;
  /** Alias-force-default I9: a force committed (also a wedged rename that settled OK). Never throws into the
   *  store (exceptions are swallowed); a failed push is never rolled back. */
  onForcedCommit?(event: { holderSessionId: string; requesterSessionId: string; at: number }): void;
  fs?: XsAliasFs;
  now?: () => number;
  timer?: XsAliasTimer;
  /** Random hex source (tests pin temp names / tokens). */
  randomHex?: (bytes: number) => string;
  log?: { warn(msg: string, data?: object): void };
}

/** Hub binding table (AL1 → AL2). Reads are lock-free over the current in-memory table. */
export interface XsAliasStore {
  /** `aliasAdvertised`: false until load; then fixed for the run (true iff load was `ready`). */
  readonly advertised: boolean;
  /** Load once (idempotent). Never throws. Must complete before the router accepts xs requests. */
  load(): Promise<XsAliasLoadResult>;
  status(): XsAliasStoreStatus;
  /** §5.1 layer 3 on a CANONICAL alias: held record, or live cooling record; else undefined. */
  lookup(canonicalAlias: string): Readonly<XsAliasRecord> | undefined;
  /** §5.1 layer 3 on a raw query (no `@` stripping): `miss` ⇒ fall through to the name layers. */
  resolveQuery(query: string): { kind: "miss" } | { kind: "hit"; record: Readonly<XsAliasRecord> };
  /** Held alias of a session (rows / target / from stamping), else undefined. */
  heldBy(sessionId: string): string | undefined;
  /** get: held alias + latest `lost` tombstone (not consumed; agents dedupe by (sid, at)). */
  get(requester: XsAliasRequester): XsAliasStateWire;
  set(requester: XsAliasRequester, rawAlias: string, cwdLabel: string): Promise<XsAliasWriteResult>;
  clear(requester: XsAliasRequester): Promise<XsAliasWriteResult>;
  takePreview(requester: XsAliasRequester, rawAlias: string): XsAliasPreviewResult;
  /** Alias-force-default `intent:"auto"` (I7): new record only; "taken"-class answers are synchronous. */
  autoClaim(requester: XsAliasRequester, rawAlias: string, cwdLabel: string): Promise<XsAliasWriteResult>;
  /** Alias-force-default `intent:"force"` + `take:"preview"`: refuses `unnotifiable` / `not_held`; the
   *  issued token binds `mode:"force"` and the holder's `presenceKey`. */
  forcePreview(requester: XsAliasRequester, rawAlias: string): XsAliasPreviewResult;
  /** Alias-force-default `intent:"handoff"` (I10, AF7): moves `rawAlias` in place from `prevSessionId` to the requester
   *  iff the hub saw this very socket go prev → requester, prev is offline (neither xs-online nor linked), the record is
   *  `held(prev)` and the requester holds nothing. Keeps `origin`, writes no tombstone, leaves no cooling. EVERY refusal
   *  is `E_XS_ALIAS_TAKE{stale}` (the agent falls back to the auto path); queue/IO trouble stays BUSY/UNKNOWN. */
  handoff(
    requester: XsAliasRequester,
    rawAlias: string,
    prevSessionId: string,
    cwdLabel: string,
  ): Promise<XsAliasWriteResult>;
  /** Any outcome consumes the token (§3.5). The token's `mode` (not the caller) decides take vs force. */
  take(requester: XsAliasRequester, rawAlias: string, token: string, cwdLabel: string): Promise<XsAliasWriteResult>;
  /** Presence hint from the members observer (onMember / onSession / onInvalidate): re-evaluates
   *  `isOnline(sid)` and stamps `offlineSince` on an online→offline edge. Never writes. */
  touchPresence(sessionId: string): void;
  /** Hub dispose: waiting transactions resolve BUSY{io}, tokens dropped, further writes busy. */
  close(): void;
  /** Test/diagnostic snapshot of the persisted part. */
  inspect(): { records: XsAliasRecord[]; tombstones: XsAliasTombstone[]; seq: number };
}

// ----------------------------------------------------------------- pure helpers

/** Clamp `HubConfig.crossSession.alias` leaves; anything missing/invalid ⇒ that leaf's default. */
export function resolveXsAliasHubParams(raw: unknown): XsAliasHubParams {
  const src = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const out = { ...XS_ALIAS_DEFAULT_PARAMS };
  for (const key of Object.keys(PARAM_BOUNDS) as (keyof XsAliasHubParams)[]) {
    const v = src[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const [lo, hi] = PARAM_BOUNDS[key];
    out[key] = Math.min(hi, Math.max(lo, Math.round(v)));
  }
  return out;
}

/** §5.1 degraded guard: is `query` alias-shaped (valid under the rules, no `@` stripping)? */
export function isAliasShaped(query: string): boolean {
  return normalizeAlias(query, { stripAt: false }).ok;
}

/** Wire form of a failure: detail rides the brace suffix; only UNKNOWN is not provably none. */
export function xsAliasFailureWire(f: XsAliasWriteFailure): { code: string; effect: "none" | "unknown" } {
  const code = "detail" in f ? `${f.code}{${f.detail}}` : f.code;
  return { code, effect: f.code === "E_XS_ALIAS_UNKNOWN" ? "unknown" : "none" };
}

/** §3.5-1 / §8: strip `\p{C}`, cap at 120 code points. */
export function sanitizeAliasCwdLabel(s: string): string {
  const cleaned = typeof s === "string" ? s.replace(/\p{C}/gu, "") : "";
  const cps = Array.from(cleaned);
  return cps.length > XS_ALIAS_CWD_LABEL_MAX ? cps.slice(0, XS_ALIAS_CWD_LABEL_MAX).join("") : cleaned;
}

export const xsAliasFilePath = (stateDir: string): string => join(stateDir, XS_ALIAS_FILE);

// ----------------------------------------------------------------- persisted table

interface Table {
  seq: number;
  records: Map<string, XsAliasRecord>;
  tombs: Map<string, XsAliasTombstone>;
}

const emptyTable = (): Table => ({ seq: 0, records: new Map(), tombs: new Map() });
const cloneTable = (t: Table): Table => ({ seq: t.seq, records: new Map(t.records), tombs: new Map(t.tombs) });

function serializeTable(t: Table): Uint8Array {
  const records = [...t.records.values()]
    .sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0))
    .map((r) => ({
      alias: r.alias,
      skeleton: r.skeleton,
      sessionId: r.sessionId,
      state: r.state,
      ...(r.state === "cooling" && r.coolUntil !== undefined ? { coolUntil: r.coolUntil } : {}),
      rev: r.rev,
      cwdLabel: r.cwdLabel,
      ...(r.origin === "auto" ? { origin: "auto" } : {}),
    }));
  const tombstones = [...t.tombs.values()]
    .sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
    .map((x) => ({
      sessionId: x.sessionId,
      alias: x.alias,
      reason: x.reason,
      at: x.at,
      ...(x.forced === true ? { forced: true } : {}),
    }));
  const shape = { version: 1, skeletonVersion: XS_ALIAS_SKELETON_VERSION, seq: t.seq, records, tombstones };
  return new TextEncoder().encode(`${JSON.stringify(shape)}\n`);
}

class CorruptError extends Error {}
const corrupt = (why: string): never => {
  throw new CorruptError(why);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length >= 1 && v.length <= max;
const isInt = (v: unknown, min: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Strict v1 parse. Throws `CorruptError` on any shape / invariant (I1, I2) violation. Skeletons are
 *  recomputed with the current table (§2.2: historical conflicts survive, new claims use the new table). */
function parseTable(bytes: Uint8Array, log?: XsAliasStoreDeps["log"]): Table {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return corrupt("json");
  }
  if (!isObj(parsed)) return corrupt("shape");
  if (parsed["version"] !== 1) return corrupt("version");
  if (!isInt(parsed["skeletonVersion"], 1)) return corrupt("skeletonVersion");
  if (!isInt(parsed["seq"], 0)) return corrupt("seq");
  const rawRecords = parsed["records"];
  const rawTombs = parsed["tombstones"];
  if (!Array.isArray(rawRecords) || rawRecords.length > XS_ALIAS_MAX_RECORDS) return corrupt("records");
  if (!Array.isArray(rawTombs) || rawTombs.length > XS_ALIAS_MAX_TOMBSTONES) return corrupt("tombstones");
  const t = emptyTable();
  let seq = parsed["seq"] as number;
  const heldSids = new Set<string>();
  let reskeleton = 0;
  for (const r of rawRecords) {
    if (!isObj(r)) return corrupt("record");
    const { alias, skeleton, sessionId, state, coolUntil, rev, cwdLabel, origin } = r;
    if (!isStr(alias, ALIAS_RAW_MAX) || CONTROL_RE.test(alias)) return corrupt("record.alias");
    if (typeof skeleton !== "string") return corrupt("record.skeleton");
    if (!isStr(sessionId, SESSION_ID_MAX) || CONTROL_RE.test(sessionId)) return corrupt("record.sessionId");
    if (state !== "held" && state !== "cooling") return corrupt("record.state");
    if (state === "cooling" ? !isTime(coolUntil) : coolUntil !== undefined) return corrupt("record.coolUntil");
    if (!isInt(rev, 1)) return corrupt("record.rev");
    if (typeof cwdLabel !== "string" || cwdLabel.length > 4 * XS_ALIAS_CWD_LABEL_MAX) return corrupt("record.cwdLabel");
    if (t.records.has(alias)) return corrupt("I1"); // one record per alias
    if (state === "held") {
      if (heldSids.has(sessionId)) return corrupt("I2"); // one held per sid
      heldSids.add(sessionId);
    }
    const sk = aliasSkeleton(alias);
    if (sk !== skeleton) reskeleton++;
    t.records.set(alias, {
      alias,
      skeleton: sk,
      sessionId,
      state,
      ...(state === "cooling" ? { coolUntil: coolUntil as number } : {}),
      rev,
      cwdLabel: sanitizeAliasCwdLabel(cwdLabel),
      // optional v2 key: only the exact value counts (anything else ⇒ human-granted; never `corrupt`)
      ...(origin === "auto" ? { origin: "auto" as const } : {}),
    });
    seq = Math.max(seq, rev);
  }
  for (const x of rawTombs) {
    if (!isObj(x)) return corrupt("tombstone");
    const { sessionId, alias, reason, at, forced } = x;
    if (!isStr(sessionId, SESSION_ID_MAX) || CONTROL_RE.test(sessionId)) return corrupt("tombstone.sessionId");
    if (!isStr(alias, ALIAS_RAW_MAX) || CONTROL_RE.test(alias)) return corrupt("tombstone.alias");
    if (reason !== "taken" && reason !== "expired") return corrupt("tombstone.reason");
    if (!isTime(at)) return corrupt("tombstone.at");
    if (t.tombs.has(sessionId)) return corrupt("tombstone.dup");
    t.tombs.set(sessionId, { sessionId, alias, reason, at, ...(forced === true ? { forced: true as const } : {}) });
  }
  t.seq = seq;
  if (reskeleton > 0 || parsed["skeletonVersion"] !== XS_ALIAS_SKELETON_VERSION) {
    log?.warn("xs alias skeletons recomputed", {
      fileVersion: parsed["skeletonVersion"],
      current: XS_ALIAS_SKELETON_VERSION,
      changed: reskeleton,
    });
  }
  return t;
}

// ----------------------------------------------------------------- default fs

const READ_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOCTTY ?? 0);
const TEMP_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (fsConstants.O_NOFOLLOW ?? 0) |
  (fsConstants.O_NOCTTY ?? 0);
const DIR_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);

function errCode(err: unknown): string | undefined {
  return isObj(err) && typeof err["code"] === "string" ? err["code"] : undefined;
}

export function createXsAliasFs(): XsAliasFs {
  return {
    async read(path, maxBytes) {
      let h: Awaited<ReturnType<typeof open>>;
      try {
        h = await open(path, READ_FLAGS);
      } catch (err) {
        if (errCode(err) === "ENOENT") return { kind: "missing" };
        throw err;
      }
      try {
        const st = await h.stat();
        if (!st.isFile()) throw Object.assign(new Error("not a regular file"), { code: "EINVAL" });
        if (st.size > maxBytes) return { kind: "toolarge" };
        const buf = new Uint8Array(maxBytes + 1);
        let off = 0;
        for (;;) {
          const { bytesRead } = await h.read(buf, off, buf.length - off, off);
          if (bytesRead === 0) break;
          off += bytesRead;
          if (off > maxBytes) return { kind: "toolarge" };
        }
        return { kind: "bytes", bytes: buf.subarray(0, off) };
      } finally {
        await h.close().catch(() => undefined);
      }
    },
    async writeTemp(path, bytes) {
      const h = await open(path, TEMP_FLAGS, 0o600);
      try {
        let off = 0;
        while (off < bytes.length) {
          const { bytesWritten } = await h.write(bytes, off, bytes.length - off, off);
          if (bytesWritten <= 0) throw new Error("short write");
          off += bytesWritten;
        }
        await h.sync();
      } finally {
        await h.close().catch(() => undefined);
      }
    },
    rename: (from, to) => rename(from, to),
    unlink: (path) => unlink(path),
    async syncDir(dir) {
      const h = await open(dir, DIR_FLAGS);
      try {
        await h.sync();
      } finally {
        await h.close().catch(() => undefined);
      }
    },
  };
}

const defaultTimer: XsAliasTimer = (fn, ms) => {
  const t = setTimeout(fn, Math.max(0, ms));
  t.unref();
  return { cancel: () => clearTimeout(t) };
};

type Raced<T> = { kind: "ok"; value: T } | { kind: "err"; error: unknown } | { kind: "timeout" };

// ----------------------------------------------------------------- store

interface TokenEntry {
  requester: string;
  alias: string;
  holder: string;
  rev: number;
  /** How the token executes; bound at preview time, never taken from the execute frame. */
  mode: "take" | "force";
  /** Holder presence at preview: `on` (xs-online) | `off:<offlineSince>`. A `linked` holder never gets a token. */
  presenceKey: string;
  expiresAt: number;
}

/** Alias-force-default §2/§4: the read-time presence of a sid. `key` is absent for `linked`. */
type PresenceInfo =
  { kind: "xs-online"; key: "on" } | { kind: "linked" } | { kind: "offline"; key: string; off: number };

interface Presence {
  online: boolean;
  offlineSince: number;
}

/** A computed transaction: the next table + the rename-before re-check. */
type Plan =
  | { kind: "fail"; failure: XsAliasWriteFailure }
  | { kind: "noop"; res: XsAliasStateWire }
  | {
      kind: "write";
      next: Table;
      res: XsAliasStateWire;
      /** §3.3-4 op-specific re-check (fresh clock / presence). */
      recheck: () => XsAliasWriteFailure | undefined;
      /** The sid granted a held record (presence ⇒ online on commit). */
      grantee?: string;
      /** Runs right after the in-memory table was replaced (also on a late wedged success). Never throws out. */
      afterCommit?: () => void;
    };

interface Job {
  run: (deadlineAt: number) => Promise<XsAliasWriteResult>;
  resolve: (r: XsAliasWriteResult) => void;
  deadlineAt: number;
  timer?: XsAliasTimerHandle;
}

const fail = (failure: XsAliasWriteFailure): { ok: false; failure: XsAliasWriteFailure } => ({ ok: false, failure });
const BUSY_IO: XsAliasWriteFailure = { code: "E_XS_ALIAS_BUSY", detail: "io" };
const BUSY_QUEUE: XsAliasWriteFailure = { code: "E_XS_ALIAS_BUSY", detail: "queue" };
const TAKE_STALE: XsAliasWriteFailure = { code: "E_XS_ALIAS_TAKE", detail: "stale" };

export function createXsAliasStore(deps: XsAliasStoreDeps): XsAliasStore {
  const now = deps.now ?? (() => Date.now());
  const timer = deps.timer ?? defaultTimer;
  const fs = deps.fs ?? createXsAliasFs();
  const hex = deps.randomHex ?? ((n: number) => randomBytes(n).toString("hex"));
  const params = resolveXsAliasHubParams(deps.params);
  const leaseMs = params.offlineLeaseH * 3600_000;
  const coolMs = params.coolMin * 60_000;
  const takeMinMs = params.takeMinOfflineMin * 60_000;
  const file = xsAliasFilePath(deps.stateDir);
  const dir = dirname(file);

  let state: XsAliasStoreState = "loading";
  let degradedReason: XsAliasDegradedReason | undefined;
  let disabledReason: XsAliasDisabledReason | undefined;
  let advertised = false;
  let table: Table = emptyTable();
  /** Bumped on every commit — the generation the rename-before check pins. */
  let gen = 0;
  let heldIndex = new Map<string, string>(); // sid → held alias
  const presence = new Map<string, Presence>();
  const tokens = new Map<string, TokenEntry>();
  /** Temp names whose file may still exist (in flight, zombie, pending rename, pending unlink). A name
   *  leaves the set only once its file is provably gone (renamed onto the main file, or unlinked) — so a
   *  live temp is never reused and the set stays bounded by the outstanding IO, not by the run length. */
  const usedTemps = new Set<string>();
  const waiting: Job[] = [];
  let running = false;
  let closed = false;
  let zombies = 0;
  let wedgedAt = 0;
  let dirSyncInFlight = false;
  let loadP: Promise<XsAliasLoadResult> | undefined;

  // ----------------------------------------------------------- small utils

  function within<T>(start: () => Promise<T>, ms: number): { p: Promise<T>; raced: Promise<Raced<T>> } {
    let p: Promise<T>;
    try {
      p = start();
    } catch (err) {
      p = Promise.reject(err);
    }
    const raced = new Promise<Raced<T>>((resolve) => {
      let done = false;
      const h = timer(() => {
        if (done) return;
        done = true;
        resolve({ kind: "timeout" });
      }, ms);
      p.then(
        (value) => {
          if (done) return;
          done = true;
          h.cancel();
          resolve({ kind: "ok", value });
        },
        (error: unknown) => {
          if (done) return;
          done = true;
          h.cancel();
          resolve({ kind: "err", error });
        },
      );
    });
    return { p, raced };
  }

  function unlinkBestEffort(path: string): void {
    const forget = (): void => void usedTemps.delete(path);
    try {
      // ENOENT also means "gone"; any other failure leaves an unknown file ⇒ keep the name reserved
      void fs.unlink(path).then(forget, (err: unknown) => {
        if (errCode(err) === "ENOENT") forget();
      });
    } catch {
      /* best effort */
    }
  }

  /** Never collides with a temp that may still exist; bounded attempts (a broken random source ⇒
   *  undefined ⇒ BUSY{io}). */
  function newTempPath(): string | undefined {
    for (let i = 0; i < 8; i++) {
      const h = hex(4);
      const p = `${file}.${h}.tmp`;
      if (/^[0-9a-f]{8}$/.test(h) && !usedTemps.has(p)) {
        usedTemps.add(p);
        return p;
      }
    }
    return undefined;
  }

  function rebuildIndex(): void {
    const idx = new Map<string, string>();
    for (const r of table.records.values()) if (r.state === "held") idx.set(r.sessionId, r.alias);
    heldIndex = idx;
    for (const sid of [...presence.keys()]) if (!idx.has(sid)) presence.delete(sid);
  }

  /** Read-time presence (§3.1): undefined ⇒ online; else the offlineSince stamp. An entry recorded
   *  online but no longer online is stamped NOW (偏向持有者). */
  function offlineSinceOf(sid: string): number | undefined {
    if (deps.isOnline(sid)) {
      if (heldIndex.has(sid)) presence.set(sid, { online: true, offlineSince: 0 });
      return undefined;
    }
    let p = presence.get(sid);
    if (p === undefined || p.online) {
      p = { online: false, offlineSince: now() };
      if (heldIndex.has(sid)) presence.set(sid, p);
    }
    return p.offlineSince;
  }

  /** One read of a holder's three-state presence (alias-force-default §2). `offlineSinceOf` stamps/reads the
   *  xs-online edge exactly as take always did; `linked` only refines "not xs-online" for force. */
  function presenceOf(sid: string): PresenceInfo {
    const off = offlineSinceOf(sid);
    if (off === undefined) return { kind: "xs-online", key: "on" };
    if (deps.isLinked?.(sid) === true) return { kind: "linked" };
    return { kind: "offline", key: `off:${off}`, off };
  }

  /** §4 `notifiable`: offline, or xs-online with EVERY effective member declaring v2. `linked` never is. */
  function notifiableOf(p: PresenceInfo, sid: string): boolean {
    if (p.kind === "offline") return true;
    return p.kind === "xs-online" && deps.allMembersV2?.(sid) === true;
  }

  const coolingLive = (r: XsAliasRecord, t: number): boolean =>
    r.state === "cooling" && r.coolUntil !== undefined && t < r.coolUntil;

  function expiredHolder(r: XsAliasRecord, t: number): boolean {
    if (r.state !== "held") return false;
    const off = offlineSinceOf(r.sessionId);
    return off !== undefined && t - off > leaseMs;
  }

  /** §3.3 state matrix: refresh the read-time wedge → disabled edge. */
  function refreshState(): void {
    if (state === "wedged" && now() - wedgedAt > XS_ALIAS_WEDGE_DISABLE_MS) {
      state = "disabled";
      disabledReason = "wedge-timeout";
    }
  }

  function writeGate(): XsAliasWriteFailure | undefined {
    refreshState();
    if (closed || state !== "ready") return BUSY_IO;
    return undefined;
  }

  /** Delete expired coolings and tombstones (only ever inside a write — I6). */
  function prune(next: Table, t: number): void {
    for (const [k, r] of next.records) if (r.state === "cooling" && !coolingLive(r, t)) next.records.delete(k);
    for (const [k, x] of next.tombs) if (t - x.at > XS_ALIAS_TOMBSTONE_TTL_MS) next.tombs.delete(k);
  }

  function addTomb(next: Table, tomb: XsAliasTombstone): void {
    next.tombs.delete(tomb.sessionId);
    next.tombs.set(tomb.sessionId, tomb);
    while (next.tombs.size > XS_ALIAS_MAX_TOMBSTONES) {
      let oldest: XsAliasTombstone | undefined;
      for (const x of next.tombs.values()) if (oldest === undefined || x.at < oldest.at) oldest = x;
      if (oldest === undefined) break;
      next.tombs.delete(oldest.sessionId);
    }
  }

  /** Common step G (§3.2): S's other held ⇒ cooling(S), then S's same-skeleton coolings (incl. one just
   *  converted) deleted. Returns whether anything changed. */
  function stepG(next: Table, sid: string, alias: string, skeleton: string, t: number): boolean {
    let changed = false;
    for (const [k, r] of next.records) {
      if (r.sessionId !== sid || r.alias === alias) continue;
      if (r.skeleton === skeleton) {
        // §2.2: renaming to a same-skeleton name drops S's own old record outright (I3)
        next.records.delete(k);
        changed = true;
      } else if (r.state === "held") {
        next.records.set(k, { ...r, state: "cooling", coolUntil: t + coolMs, rev: ++next.seq });
        changed = true;
      }
    }
    return changed;
  }

  function commit(next: Table, grantee: string | undefined): void {
    table = next;
    gen++;
    rebuildIndex();
    if (grantee !== undefined && heldIndex.has(grantee)) presence.set(grantee, { online: true, offlineSince: 0 });
    if (!dirSyncInFlight) {
      dirSyncInFlight = true;
      const { raced } = within(() => fs.syncDir(dir), XS_ALIAS_WRITE_STEP_MS);
      void raced.then(() => {
        dirSyncInFlight = false;
      });
    }
  }

  // ----------------------------------------------------------- transaction engine

  function pump(): void {
    if (running) return;
    const job = waiting.shift();
    if (job === undefined) return;
    job.timer?.cancel();
    running = true;
    void (async () => {
      let r: XsAliasWriteResult;
      try {
        r = await job.run(job.deadlineAt);
      } catch (err) {
        deps.log?.warn("xs alias transaction threw", { err: String(err) });
        r = fail(BUSY_IO);
      } finally {
        running = false;
      }
      job.resolve(r);
      pump();
    })();
  }

  function enqueue(
    plan: (t: number) => Plan,
    requester: XsAliasRequester,
    isTake: boolean,
  ): Promise<XsAliasWriteResult> {
    const gate = writeGate();
    if (gate !== undefined) return Promise.resolve(fail(gate));
    if (running && waiting.length >= XS_ALIAS_QUEUE_MAX) return Promise.resolve(fail(BUSY_QUEUE));
    const deadlineAt = now() + XS_ALIAS_TXN_BUDGET_MS;
    return new Promise<XsAliasWriteResult>((resolve) => {
      const job: Job = {
        deadlineAt,
        resolve,
        run: (dl) => runTxn(plan, requester, isTake, dl),
      };
      job.timer = timer(() => {
        const i = waiting.indexOf(job);
        if (i >= 0) {
          waiting.splice(i, 1);
          resolve(fail(BUSY_QUEUE));
        }
      }, XS_ALIAS_TXN_BUDGET_MS);
      waiting.push(job);
      pump();
    });
  }

  async function runTxn(
    plan: (t: number) => Plan,
    requester: XsAliasRequester,
    isTake: boolean,
    deadlineAt: number,
  ): Promise<XsAliasWriteResult> {
    const staleFailure = isTake ? TAKE_STALE : BUSY_IO;
    const gate = writeGate();
    if (gate !== undefined) return fail(gate);
    if (now() + XS_ALIAS_RENAME_WAIT_MS >= deadlineAt) return fail(BUSY_QUEUE);
    if (!deps.isRequesterLive(requester)) return fail(staleFailure);

    // 2. validate on the CURRENT table + presence
    const baseGen = gen;
    const p = plan(now());
    if (p.kind === "fail") return fail(p.failure);
    if (p.kind === "noop") return { ok: true, res: p.res };

    // size cap: drop the oldest tombstones first (lowest-value data), then FULL
    let bytes = serializeTable(p.next);
    while (bytes.length > XS_ALIAS_MAX_FILE_BYTES && p.next.tombs.size > 0) {
      let oldest: XsAliasTombstone | undefined;
      for (const x of p.next.tombs.values()) if (oldest === undefined || x.at < oldest.at) oldest = x;
      if (oldest === undefined) break;
      p.next.tombs.delete(oldest.sessionId);
      bytes = serializeTable(p.next);
    }
    if (bytes.length > XS_ALIAS_MAX_FILE_BYTES) return fail({ code: "E_XS_ALIAS_FULL" });

    // 3. temp write (own file, never reused)
    const tmp = newTempPath();
    if (tmp === undefined) return fail(BUSY_IO);
    const writeMs = Math.min(XS_ALIAS_WRITE_STEP_MS, deadlineAt - XS_ALIAS_RENAME_WAIT_MS - now());
    if (writeMs <= 0) return fail(BUSY_QUEUE);
    const w = within(() => fs.writeTemp(tmp, bytes), writeMs);
    const wr = await w.raced;
    if (wr.kind === "timeout") {
      zombies++;
      // late result is ignored; the orphan temp is removed whenever the write settles
      void w.p.then(
        () => unlinkBestEffort(tmp),
        () => unlinkBestEffort(tmp),
      );
      if (zombies > XS_ALIAS_ZOMBIE_MAX && state === "ready") {
        state = "disabled";
        disabledReason = "zombie";
        deps.log?.warn("xs alias store disabled", { reason: "zombie", zombies });
      }
      return fail(BUSY_IO);
    }
    if (wr.kind === "err") {
      unlinkBestEffort(tmp);
      deps.log?.warn("xs alias temp write failed", { code: errCode(wr.error) });
      return fail(BUSY_IO);
    }

    // 4. rename-before re-check
    const reason = ((): XsAliasWriteFailure | undefined => {
      if (closed || state !== "ready") return BUSY_IO;
      if (gen !== baseGen) return staleFailure;
      if (!deps.isRequesterLive(requester)) return staleFailure;
      const r = p.recheck();
      if (r !== undefined) return r;
      if (now() + XS_ALIAS_RENAME_WAIT_MS > deadlineAt) return BUSY_IO;
      return undefined;
    })();
    if (reason !== undefined) {
      unlinkBestEffort(tmp);
      return fail(reason);
    }

    // 5. rename = commit point
    const rn = within(() => fs.rename(tmp, file), XS_ALIAS_RENAME_WAIT_MS);
    const rr = await rn.raced;
    if (rr.kind === "ok") {
      usedTemps.delete(tmp); // renamed onto the main file: the temp name no longer exists
      commit(p.next, p.grantee);
      runAfterCommit(p.afterCommit);
      return { ok: true, res: p.res };
    }
    if (rr.kind === "err") {
      unlinkBestEffort(tmp);
      deps.log?.warn("xs alias rename failed", { code: errCode(rr.error) });
      return fail(BUSY_IO);
    }
    // rename still in flight: UNKNOWN + wedged; settle later
    state = "wedged";
    wedgedAt = now();
    deps.log?.warn("xs alias store wedged", { reason: "rename-slow" });
    const nextTable = p.next;
    const grantee = p.grantee;
    const afterCommit = p.afterCommit;
    void rn.p.then(
      () => {
        // disk now holds nextTable: memory follows even if we already went disabled
        usedTemps.delete(tmp);
        if (gen === baseGen) {
          commit(nextTable, grantee);
          runAfterCommit(afterCommit); // I9: a late success still notifies; a late failure never does
        }
        settleWedge();
      },
      () => {
        unlinkBestEffort(tmp);
        settleWedge();
      },
    );
    return fail({ code: "E_XS_ALIAS_UNKNOWN" });
  }

  function runAfterCommit(fn: (() => void) | undefined): void {
    if (fn === undefined) return;
    try {
      fn();
    } catch (err) {
      deps.log?.warn("xs alias afterCommit threw", { err: String(err) });
    }
  }

  function settleWedge(): void {
    refreshState();
    if (state === "wedged") state = "ready";
  }

  // ----------------------------------------------------------- plans

  function planSet(sid: string, alias: string, skeleton: string, label: string, t: number): Plan {
    const next = cloneTable(table);
    prune(next, t);
    const R = next.records.get(alias);
    let kind: "new" | "reclaim" | "expire";
    let holder: string | undefined;
    if (R !== undefined && R.sessionId === sid) {
      kind = "reclaim"; // held(S) or coolingLive(S) (expired coolings were pruned)
    } else if (R !== undefined && R.state === "held") {
      if (!expiredHolder(R, t)) return { kind: "fail", failure: { code: "E_XS_ALIAS_TAKEN", detail: "taken" } };
      kind = "expire";
      holder = R.sessionId;
    } else if (R !== undefined) {
      return { kind: "fail", failure: { code: "E_XS_ALIAS_TAKEN", detail: "taken" } }; // coolingLive(H≠S)
    } else {
      kind = "new";
    }
    if (kind !== "reclaim") {
      for (const r of next.records.values()) {
        if (r.alias === alias || r.sessionId === sid || r.skeleton !== skeleton) continue;
        if (kind === "expire" && r.sessionId === holder && r.state === "cooling") continue; // dropped below
        return { kind: "fail", failure: { code: "E_XS_ALIAS_TAKEN", detail: "confusable" } };
      }
    }
    if (kind === "new" && next.records.size >= XS_ALIAS_MAX_RECORDS) {
      return { kind: "fail", failure: { code: "E_XS_ALIAS_FULL" } };
    }
    let changed = stepG(next, sid, alias, skeleton, t);
    if (kind === "new") {
      next.records.set(alias, { alias, skeleton, sessionId: sid, state: "held", rev: ++next.seq, cwdLabel: label });
      changed = true;
    } else if (kind === "reclaim") {
      const cur = R as XsAliasRecord;
      if (cur.state !== "held" || cur.cwdLabel !== label || cur.skeleton !== skeleton || cur.origin !== undefined) {
        next.records.set(alias, { alias, skeleton, sessionId: sid, state: "held", rev: ++next.seq, cwdLabel: label });
        changed = true;
      }
    } else {
      const H = holder as string;
      for (const [k, r] of next.records) {
        if (r.sessionId === H && r.state === "cooling" && r.skeleton === skeleton) next.records.delete(k);
      }
      next.records.set(alias, { alias, skeleton, sessionId: sid, state: "held", rev: ++next.seq, cwdLabel: label });
      addTomb(next, { sessionId: H, alias, reason: "expired", at: t });
      changed = true;
    }
    if (next.tombs.delete(sid)) changed = true;
    const res: XsAliasStateWire = { alias, state: "held" };
    if (!changed) return { kind: "noop", res };
    // rev pinned on the CURRENT (pre-prune) record: an expired cooling still sits in memory
    const expectRev = table.records.get(alias)?.rev;
    return {
      kind: "write",
      next,
      res,
      grantee: sid,
      recheck: () => {
        // the target record changed since validation (cannot happen while serialized; defensive)
        if (table.records.get(alias)?.rev !== expectRev) return BUSY_IO;
        if (kind === "expire") {
          const c = table.records.get(alias);
          if (c === undefined || c.state !== "held" || c.sessionId !== holder || !expiredHolder(c, now())) {
            return { code: "E_XS_ALIAS_TAKEN", detail: "taken" };
          }
        }
        return undefined;
      },
    };
  }

  function planClear(sid: string, t: number): Plan {
    const next = cloneTable(table);
    prune(next, t);
    let changed = false;
    const heldAlias = heldIndex.get(sid);
    const R = heldAlias === undefined ? undefined : next.records.get(heldAlias);
    if (R !== undefined && R.state === "held" && R.sessionId === sid) {
      next.records.set(R.alias, { ...R, state: "cooling", coolUntil: t + coolMs, rev: ++next.seq });
      changed = true;
    }
    if (next.tombs.delete(sid)) changed = true;
    const res: XsAliasStateWire = { state: "none" };
    if (!changed) return { kind: "noop", res };
    return { kind: "write", next, res, recheck: () => undefined };
  }

  function planTake(sid: string, alias: string, skeleton: string, tok: TokenEntry, label: string, t: number): Plan {
    const next = cloneTable(table);
    prune(next, t);
    const R = next.records.get(alias);
    if (
      R === undefined ||
      R.state !== "held" ||
      R.sessionId !== tok.holder ||
      R.rev !== tok.rev ||
      R.sessionId === sid
    ) {
      return { kind: "fail", failure: TAKE_STALE };
    }
    const off = offlineSinceOf(R.sessionId);
    if (off === undefined) return { kind: "fail", failure: { code: "E_XS_ALIAS_TAKE", detail: "online" } };
    if (`off:${off}` !== tok.presenceKey) return { kind: "fail", failure: TAKE_STALE };
    if (t - off < takeMinMs) return { kind: "fail", failure: { code: "E_XS_ALIAS_TAKE", detail: "recent" } };
    const H = R.sessionId;
    stepG(next, sid, alias, skeleton, t);
    for (const [k, r] of next.records) {
      if (r.sessionId === H && r.state === "cooling" && r.skeleton === skeleton) next.records.delete(k);
    }
    // a human grant: `origin` is dropped (explicit fields, never `...R`)
    next.records.set(alias, { alias, skeleton, sessionId: sid, state: "held", rev: ++next.seq, cwdLabel: label });
    addTomb(next, { sessionId: H, alias, reason: "taken", at: t });
    next.tombs.delete(sid);
    return {
      kind: "write",
      next,
      res: { alias, state: "held" },
      grantee: sid,
      recheck: () => {
        const c = table.records.get(alias);
        if (c === undefined || c.state !== "held" || c.sessionId !== H || c.rev !== tok.rev) return TAKE_STALE;
        const o = offlineSinceOf(H);
        if (o === undefined || `off:${o}` !== tok.presenceKey || now() - o < takeMinMs) return TAKE_STALE;
        return undefined;
      },
    };
  }

  /** Force conditions that must hold at plan time AND again right before rename (I5′): same holder, same
   *  record rev, unchanged presenceKey, holder still notifiable (a holder that became `linked` ⇒ stale). */
  function forceStale(c: XsAliasRecord | undefined, tok: TokenEntry): XsAliasWriteFailure | undefined {
    if (c === undefined || c.state !== "held" || c.sessionId !== tok.holder || c.rev !== tok.rev) return TAKE_STALE;
    const p = presenceOf(tok.holder);
    if (p.kind === "linked" || p.key !== tok.presenceKey || !notifiableOf(p, tok.holder)) return TAKE_STALE;
    return undefined;
  }

  function planForce(sid: string, alias: string, skeleton: string, tok: TokenEntry, label: string, t: number): Plan {
    const next = cloneTable(table);
    prune(next, t);
    const R = next.records.get(alias);
    if (R === undefined || R.sessionId === sid) return { kind: "fail", failure: TAKE_STALE };
    const stale = forceStale(R, tok);
    if (stale !== undefined) return { kind: "fail", failure: stale };
    const H = R.sessionId;
    stepG(next, sid, alias, skeleton, t);
    for (const [k, r] of next.records) {
      if (r.sessionId === H && r.state === "cooling" && r.skeleton === skeleton) next.records.delete(k);
    }
    next.records.set(alias, { alias, skeleton, sessionId: sid, state: "held", rev: ++next.seq, cwdLabel: label });
    addTomb(next, { sessionId: H, alias, reason: "taken", at: t, forced: true });
    next.tombs.delete(sid);
    return {
      kind: "write",
      next,
      res: { alias, state: "held" },
      grantee: sid,
      recheck: () => forceStale(table.records.get(alias), tok),
      afterCommit: () => deps.onForcedCommit?.({ holderSessionId: H, requesterSessionId: sid, at: now() }),
    };
  }

  /** Alias-force-default §4 `auto` predicate (I7), read-time on `tbl`: `undefined` ⇒ the claim may proceed.
   *  Expired coolings and ≥30-day tombstones do not exist; an EXPIRED held still blocks (auto never takes over). */
  function autoVerdict(
    tbl: Table,
    sid: string,
    alias: string,
    skeleton: string,
    t: number,
  ): { kind: "fail"; failure: XsAliasWriteFailure } | { kind: "noop"; res: XsAliasStateWire } | undefined {
    const taken = {
      kind: "fail" as const,
      failure: { code: "E_XS_ALIAS_TAKEN", detail: "taken" } as XsAliasWriteFailure,
    };
    let live = 0;
    for (const r of tbl.records.values()) {
      if (r.state === "held" && r.sessionId === sid) {
        return {
          kind: "noop",
          res: { alias: r.alias, state: "held", ...(r.origin === "auto" ? { origin: "auto" } : {}) },
        };
      }
    }
    for (const r of tbl.records.values()) {
      if (r.state === "cooling" && !coolingLive(r, t)) continue;
      live++;
      if (r.sessionId === sid) return taken; // S's own coolingLive
    }
    const tomb = tbl.tombs.get(sid);
    if (tomb !== undefined && t - tomb.at <= XS_ALIAS_TOMBSTONE_TTL_MS) return taken;
    const X = tbl.records.get(alias);
    if (X !== undefined && (X.state === "held" || coolingLive(X, t))) return taken;
    for (const r of tbl.records.values()) {
      if (r.alias === alias || r.skeleton !== skeleton) continue;
      if (r.state === "cooling" && !coolingLive(r, t)) continue;
      return { kind: "fail", failure: { code: "E_XS_ALIAS_TAKEN", detail: "confusable" } };
    }
    if (live >= XS_ALIAS_MAX_RECORDS) return { kind: "fail", failure: { code: "E_XS_ALIAS_FULL" } };
    return undefined;
  }

  function planAuto(sid: string, alias: string, skeleton: string, label: string, t: number): Plan {
    const next = cloneTable(table);
    prune(next, t);
    const v = autoVerdict(next, sid, alias, skeleton, t);
    if (v !== undefined) return v;
    // I7: S has no held / coolingLive / live tombstone and x has no live record ⇒ step G is a no-op, nothing is demoted
    next.records.set(alias, {
      alias,
      skeleton,
      sessionId: sid,
      state: "held",
      rev: ++next.seq,
      cwdLabel: label,
      origin: "auto",
    });
    const expectRev = table.records.get(alias)?.rev;
    return {
      kind: "write",
      next,
      res: { alias, state: "held", origin: "auto" },
      grantee: sid,
      recheck: () => (table.records.get(alias)?.rev !== expectRev ? BUSY_IO : undefined),
    };
  }

  /** I10 conditions that must hold at plan time AND again right before rename. `undefined` ⇒ the handoff may proceed. */
  function handoffStale(
    c: XsAliasRecord | undefined,
    requester: XsAliasRequester,
    prev: string,
    rev?: number,
  ): XsAliasWriteFailure | undefined {
    const sid = requester.sessionId;
    if (prev === sid || c === undefined || c.state !== "held" || c.sessionId !== prev) return TAKE_STALE;
    if (rev !== undefined && c.rev !== rev) return TAKE_STALE;
    // evidence 1: the hub itself saw this socket move prev → sid (members' succession edge); nothing the frame says
    if (deps.isSuccessor?.(requester, prev) !== true) return TAKE_STALE;
    // evidence 2: nobody is using prev any more — not another xs member, not a merely linked connection
    if (presenceOf(prev).kind !== "offline") return TAKE_STALE;
    // I10: the successor holds nothing yet (a human/auto grant already made on the new session always wins)
    if (heldIndex.has(sid)) return TAKE_STALE;
    return undefined;
  }

  function planHandoff(
    requester: XsAliasRequester,
    alias: string,
    skeleton: string,
    prev: string,
    label: string,
    t: number,
  ): Plan {
    const sid = requester.sessionId;
    const next = cloneTable(table);
    prune(next, t);
    const R = next.records.get(alias);
    const stale = handoffStale(R, requester, prev);
    if (stale !== undefined) return { kind: "fail", failure: stale };
    const held = R as XsAliasRecord;
    stepG(next, sid, alias, skeleton, t);
    // in place: same alias/skeleton, `origin` KEPT (explicit fields, never a blind spread of `held` + new owner), no
    // tombstone for prev and no cooling — the name never becomes free in between
    next.records.set(alias, {
      alias,
      skeleton: held.skeleton,
      sessionId: sid,
      state: "held",
      rev: ++next.seq,
      cwdLabel: label,
      ...(held.origin === "auto" ? { origin: "auto" as const } : {}),
    });
    next.tombs.delete(prev);
    next.tombs.delete(sid);
    const rev = held.rev;
    return {
      kind: "write",
      next,
      res: {
        alias,
        state: "held",
        ...(requester.v2 === true && held.origin === "auto" ? { origin: "auto" as const } : {}),
      },
      grantee: sid,
      recheck: () => handoffStale(table.records.get(alias), requester, prev, rev),
    };
  }

  function sweepTokens(t: number): void {
    for (const [k, v] of tokens) if (v.expiresAt <= t) tokens.delete(k);
  }

  /** Mint a preview token (≤32 live, bounded random retries) and build the reply. `v2` extras (`online`,
   *  `auto`) are written only for a v2 requester. */
  function issueToken(
    requester: XsAliasRequester,
    alias: string,
    R: XsAliasRecord,
    mode: "take" | "force",
    presenceKey: string,
    offlineForS: number,
    online: boolean,
    t: number,
  ): XsAliasPreviewResult {
    sweepTokens(t);
    if (tokens.size >= XS_ALIAS_TOKENS_MAX) return fail({ code: "E_XS_ALIAS_BUSY", detail: "tokens" });
    let token: string | undefined;
    for (let i = 0; i < 8 && token === undefined; i++) {
      const c = `k${hex(8)}`;
      if (XS_ALIAS_TAKE_TOKEN_RE.test(c) && !tokens.has(c)) token = c;
    }
    if (token === undefined) return fail({ code: "E_XS_ALIAS_BUSY", detail: "tokens" }); // bounded: never spin
    const expiresAt = t + XS_ALIAS_TOKEN_TTL_MS;
    tokens.set(token, {
      requester: requester.sessionId,
      alias,
      holder: R.sessionId,
      rev: R.rev,
      mode,
      presenceKey,
      expiresAt,
    });
    const v2 = requester.v2 === true;
    return {
      ok: true,
      res: {
        take: {
          cwdLabel: sanitizeAliasCwdLabel(R.cwdLabel),
          offlineForS,
          token,
          expiresAt,
          ...(v2 && online ? { online: true as const } : {}),
          ...(v2 && R.origin === "auto" ? { auto: true as const } : {}),
        },
      },
    };
  }

  // ----------------------------------------------------------- public API

  const store: XsAliasStore = {
    get advertised() {
      return advertised;
    },

    load() {
      if (loadP !== undefined) return loadP;
      loadP = (async (): Promise<XsAliasLoadResult> => {
        const loadAt = now();
        const degrade = (reason: XsAliasDegradedReason, data?: object): XsAliasLoadResult => {
          state = "degraded";
          degradedReason = reason;
          advertised = false;
          deps.log?.warn("xs alias store degraded", { reason, path: file, ...data });
          return { state: "degraded", reason };
        };
        const r = await within(() => fs.read(file, XS_ALIAS_MAX_FILE_BYTES), XS_ALIAS_LOAD_BUDGET_MS).raced;
        if (r.kind === "timeout") return degrade("timeout");
        if (r.kind === "err") return degrade("unreadable", { code: errCode(r.error) });
        if (r.value.kind === "toolarge") return degrade("corrupt", { why: "size" });
        let fresh = false;
        if (r.value.kind === "missing") {
          table = emptyTable();
          fresh = true;
        } else {
          try {
            table = parseTable(r.value.bytes, deps.log);
          } catch (err) {
            return degrade("corrupt", { why: err instanceof CorruptError ? err.message : "parse" });
          }
        }
        if (closed) return degrade("timeout");
        rebuildIndex();
        // §3.1 / R8: every held sid counts as offline since the load instant until it reconnects
        for (const sid of heldIndex.keys()) presence.set(sid, { online: false, offlineSince: loadAt });
        state = "ready";
        advertised = true;
        return { state: "ready", records: table.records.size, fresh };
      })();
      return loadP;
    },

    status() {
      refreshState();
      const t = now();
      let cooling = 0;
      for (const r of table.records.values()) if (coolingLive(r, t)) cooling++;
      return {
        state,
        ...(state === "degraded" && degradedReason !== undefined ? { degradedReason } : {}),
        ...(state === "disabled" && disabledReason !== undefined ? { disabledReason } : {}),
        path: file,
        advertised,
        records: table.records.size,
        held: heldIndex.size,
        cooling,
        tombstones: table.tombs.size,
        tokens: tokens.size,
        queue: waiting.length + (running ? 1 : 0),
        zombies,
      };
    },

    lookup(canonicalAlias) {
      if (state === "loading" || state === "degraded") return undefined;
      const r = table.records.get(canonicalAlias);
      if (r === undefined) return undefined;
      if (r.state === "held" || coolingLive(r, now())) return { ...r };
      return undefined;
    },

    resolveQuery(query) {
      const n = normalizeAlias(query, { stripAt: false });
      if (!n.ok) return { kind: "miss" };
      const record = store.lookup(n.alias);
      return record === undefined ? { kind: "miss" } : { kind: "hit", record };
    },

    heldBy(sessionId) {
      if (state === "loading" || state === "degraded") return undefined;
      return heldIndex.get(sessionId);
    },

    get(requester) {
      if (state === "loading" || state === "degraded") return { state: "none" };
      const sid = requester.sessionId;
      const alias = heldIndex.get(sid);
      const tomb = table.tombs.get(sid);
      const lost =
        tomb !== undefined && now() - tomb.at <= XS_ALIAS_TOMBSTONE_TTL_MS
          ? {
              alias: tomb.alias,
              reason: tomb.reason,
              at: tomb.at,
              ...(requester.v2 === true && tomb.forced === true ? { forced: true as const } : {}),
            }
          : undefined;
      const origin = requester.v2 === true && alias !== undefined ? table.records.get(alias)?.origin : undefined;
      return {
        ...(alias !== undefined ? { alias } : {}),
        state: alias !== undefined ? "held" : "none",
        ...(origin === "auto" ? { origin } : {}),
        ...(lost !== undefined ? { lost } : {}),
      };
    },

    set(requester, rawAlias, cwdLabel) {
      const n = normalizeAlias(rawAlias, { stripAt: true });
      if (!n.ok) return Promise.resolve(fail({ code: "E_XS_ALIAS_INVALID", detail: n.reason }));
      const label = sanitizeAliasCwdLabel(cwdLabel);
      return enqueue((t) => planSet(requester.sessionId, n.alias, n.skeleton, label, t), requester, false);
    },

    clear(requester) {
      return enqueue((t) => planClear(requester.sessionId, t), requester, false);
    },

    takePreview(requester, rawAlias) {
      const gate = writeGate();
      if (gate !== undefined) return fail(gate);
      const n = normalizeAlias(rawAlias, { stripAt: true });
      if (!n.ok) return fail({ code: "E_XS_ALIAS_INVALID", detail: n.reason });
      const t = now();
      const R = table.records.get(n.alias);
      if (R === undefined || R.state !== "held" || R.sessionId === requester.sessionId) {
        return fail({ code: "E_XS_ALIAS_TAKE", detail: "not_held" });
      }
      const off = offlineSinceOf(R.sessionId);
      if (off === undefined) return fail({ code: "E_XS_ALIAS_TAKE", detail: "online" });
      if (t - off < takeMinMs) return fail({ code: "E_XS_ALIAS_TAKE", detail: "recent" });
      return issueToken(
        requester,
        n.alias,
        R,
        "take",
        `off:${off}`,
        Math.max(0, Math.floor((t - off) / 1000)),
        false,
        t,
      );
    },

    forcePreview(requester, rawAlias) {
      const gate = writeGate();
      if (gate !== undefined) return fail(gate);
      const n = normalizeAlias(rawAlias, { stripAt: true });
      if (!n.ok) return fail({ code: "E_XS_ALIAS_INVALID", detail: n.reason });
      const t = now();
      const R = table.records.get(n.alias);
      if (R === undefined || R.state !== "held" || R.sessionId === requester.sessionId) {
        return fail({ code: "E_XS_ALIAS_TAKE", detail: "not_held" });
      }
      const p = presenceOf(R.sessionId);
      if (p.kind === "linked" || !notifiableOf(p, R.sessionId)) {
        return fail({ code: "E_XS_ALIAS_TAKE", detail: "unnotifiable" });
      }
      const offlineForS = p.kind === "offline" ? Math.max(0, Math.floor((t - p.off) / 1000)) : 0;
      return issueToken(requester, n.alias, R, "force", p.key, offlineForS, p.kind === "xs-online", t);
    },

    autoClaim(requester, rawAlias, cwdLabel) {
      const gate = writeGate();
      if (gate !== undefined) return Promise.resolve(fail(gate));
      const n = normalizeAlias(rawAlias, { stripAt: true });
      if (!n.ok) return Promise.resolve(fail({ code: "E_XS_ALIAS_INVALID", detail: n.reason }));
      const label = sanitizeAliasCwdLabel(cwdLabel);
      // synchronous pre-check: every "taken"-class answer is immediate and never occupies the queue (§4)
      const pre = autoVerdict(table, requester.sessionId, n.alias, n.skeleton, now());
      if (pre?.kind === "fail") return Promise.resolve(fail(pre.failure));
      if (pre?.kind === "noop") return Promise.resolve({ ok: true, res: pre.res });
      return enqueue((t) => planAuto(requester.sessionId, n.alias, n.skeleton, label, t), requester, false);
    },

    handoff(requester, rawAlias, prevSessionId, cwdLabel) {
      const n = normalizeAlias(rawAlias, { stripAt: true });
      if (!n.ok) return Promise.resolve(fail(TAKE_STALE)); // every handoff refusal looks the same (§3.2)
      const label = sanitizeAliasCwdLabel(cwdLabel);
      return enqueue((t) => planHandoff(requester, n.alias, n.skeleton, prevSessionId, label, t), requester, true);
    },

    take(requester, rawAlias, token, cwdLabel) {
      // reserved = removed the moment the execute request arrives: ANY outcome consumes it
      const tok = typeof token === "string" ? tokens.get(token) : undefined;
      if (tok !== undefined) tokens.delete(token);
      const n = normalizeAlias(rawAlias, { stripAt: true });
      if (!n.ok) return Promise.resolve(fail({ code: "E_XS_ALIAS_INVALID", detail: n.reason }));
      if (
        tok === undefined ||
        tok.expiresAt <= now() ||
        tok.requester !== requester.sessionId ||
        tok.alias !== n.alias
      ) {
        return Promise.resolve(fail(TAKE_STALE));
      }
      const label = sanitizeAliasCwdLabel(cwdLabel);
      return enqueue(
        (t) =>
          tok.mode === "force"
            ? planForce(requester.sessionId, n.alias, n.skeleton, tok, label, t)
            : planTake(requester.sessionId, n.alias, n.skeleton, tok, label, t),
        requester,
        true,
      );
    },

    touchPresence(sessionId) {
      if (state === "loading" || state === "degraded") return;
      if (heldIndex.has(sessionId)) offlineSinceOf(sessionId);
    },

    close() {
      if (closed) return;
      closed = true;
      tokens.clear();
      for (const job of waiting.splice(0)) {
        job.timer?.cancel();
        job.resolve(fail(BUSY_IO));
      }
    },

    inspect() {
      return {
        records: [...table.records.values()].map((r) => ({ ...r })),
        tombstones: [...table.tombs.values()].map((x) => ({ ...x })),
        seq: table.seq,
      };
    },
  };
  return store;
}
