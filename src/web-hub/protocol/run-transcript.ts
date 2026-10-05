/**
 * web-hub run-transcript protocol (fleet-drawer plan §3.1 — frozen interface, package F0).
 *
 * Pure TypeScript + typebox, `node:*`- and `core/`-free: everything on the wire for the
 * subagent transcript channel is frozen in this one module — the agent↔hub frames
 * (`run_tx_req`/`run_watch` hub→agent, `run_tx_reply`/`run_ev`/`run_gap`/`run_end`
 * agent→hub), the §3.4 browser endpoints (`RUN_API`) and SSE events (`RUN_SSE_EVENTS`),
 * the §3.3 seq/gap budget block (`RUN_TX`), and the §3.6 frozen denial vocabulary
 * (`RUN_TX_REASONS`). `protocol/messages.ts` folds the frame schemas into its two decode
 * tables; the agent (F2) and hub (F3b/F4) consume the types and constants; the UI (F5)
 * mirrors `RUN_API` by hand in `ui/src/logic/contract.js` (pinned by logic-contract tests —
 * importing this module from the browser bundle would drag `@sinclair/typebox` in).
 *
 * Module-boundary rule (why the loose subschemas below are LOCAL mirrors, not imports):
 * `messages.ts` imports THIS module's schemas at top level, so a reverse RUNTIME import of
 * `messages.js` (for `FORWARDED_EVENTS` / the `WireEntrySchema` / `InflightSchema` shapes)
 * would create a circular top-level evaluation — whichever module initializes second
 * dereferences the other's not-yet-initialized `const`s (TDZ). Only `import type` crosses
 * back. The mirrors are pinned against `messages.ts` by behavior tests in
 * `tests/web-hub/protocol/messages.test.ts` (accept/reject parity with `ev`/`branch_reply`/
 * `snapshot_reply` across the full literal vocabulary).
 *
 * Validation posture (§3.1): every frame schema is `additionalProperties:false`; the only
 * exceptions are `entries[]` items and `e` — the same same-user-trusted loose posture as
 * `messages.ts`'s `branch_reply`/`ev`: the whitelisted required literals are checked and
 * everything else is passed through unchecked (size is policed by the shared 4 MiB frame
 * budget in `decodeAgentFrame`/`decodeHubFrame`, not per schema).
 */
import { Type } from "@sinclair/typebox";
import type { InflightState, WireEntry, WireEvent, WireMessage } from "./messages.js";

// ---------------------------------------------------------------------------
// §3.3 constants
// ---------------------------------------------------------------------------

/**
 * Run id shape (`core/ids.ts`'s `RUN_ID_RE`, mirrored — this module must stay core-free
 * because the UI imports its constants). Equivalence with `isRunId` is pinned on 1k random
 * samples by `tests/web-hub/protocol/run-transcript.test.ts`.
 */
export const RUN_ID_PATTERN = "^r_[0-9A-HJKMNP-TV-Z]{8}$";

/** Per-tap identity: a fresh random 12-byte base64url (16 chars) on every attach (§3.3 #1). */
export const TAP_ID_PATTERN = "^[A-Za-z0-9_-]{8,32}$";

/**
 * Budget block (§3.3/§3.5/§5.1/§7.1). `maxBytes`/`reqDeadlineMs` mirror `messages.ts`'s
 * `LIMITS.branchReplyBytes` (2 MiB) and `TIMING.snapshotMs` (5s) — written as literals for
 * the same no-cycle reason as the schema mirrors above; the cross-reference is pinned by
 * `tests/web-hub/protocol/run-transcript.test.ts`.
 */
export const RUN_TX = {
  /** Snapshot tail size when the caller sends no explicit limit. */
  tailDefault: 200,
  /** Page cap for `/api/run/history?limit=` (= hub `HISTORY_PAGE_MAX` / UI `HISTORY_LIMIT_MAX`). */
  pageMax: 400,
  /** Per-reply byte cap (= `LIMITS.branchReplyBytes`, 2 MiB; the frame hard cap is 4 MiB). */
  maxBytes: 2 << 20,
  /** Live taps (watched runs) per agent; beyond it snapshots answer `watching:false`. */
  tapsPerAgent: 8,
  /** Distinct runs one browser client may subscribe to. */
  subsPerClient: 2,
  /** `run_tx_req` deadline (= `TIMING.snapshotMs`). */
  reqDeadlineMs: 5_000,
  /** Browser watchdog: no `run_history` within this long after the 202 ⇒ resubscribe. */
  clientPendingMs: 10_000,
  /** Resync circuit breaker: more than this in 10s ⇒ `E_BUSY` + `resync_storm`. */
  resyncMaxPer10s: 3,
  /** Agent-side undelivered `run_end` retry table (bounded, TTL'd). */
  endPendingMax: 32,
  endPendingTtlMs: 10 * 60_000,
  /** Hub-side terminal ledger (dedupe + forced terminal snapshot on resubscribe). */
  endLedgerMax: 256,
  endLedgerTtlMs: 15 * 60_000,
  /** run-file-reader (§5.1) reverse-scan chunk / byte budget / concurrency / cursor LRU. */
  scanChunkBytes: 1 << 20,
  maxScanBytes: 256 << 20,
  scanConcurrency: 2,
  cursorCacheMax: 16,
} as const;

/** §3.6 frozen denial reasons (`busy`/`resync_storm` also ride the `E_BUSY` HTTP body). */
export const RUN_TX_REASONS = [
  "unknown_run",
  "not_persisted",
  "file_missing",
  "leaf_unknown",
  "leaf_missing",
  "too_large",
  "parse_error",
  "unsupported",
  "busy",
  "resync_storm",
] as const;
export type RunTxReason = (typeof RUN_TX_REASONS)[number];

// ---------------------------------------------------------------------------
// §3.4 browser surface
// ---------------------------------------------------------------------------

/**
 * The three browser SSE events (§3.3/§3.4). All three are DIRECT-send only (`client.send`,
 * never `sse.publish`) — they never enter the replay ring and never consume an event id.
 * The same names are tail-folded into `protocol/http-contract.ts`'s `SSE_EVENTS` (which the
 * hub's `SseEventName` and the browser's contract mirror derive from).
 */
export const RUN_SSE_EVENTS = ["run_history", "run_ev", "run_end"] as const;

/** The three run-transcript HTTP endpoints (§3.4). */
export const RUN_API = {
  subscribe: "/api/run/subscribe",
  unsubscribe: "/api/run/unsubscribe",
  history: "/api/run/history",
} as const;

// ---------------------------------------------------------------------------
// frames — hub→agent
// ---------------------------------------------------------------------------

/** Snapshot/page request (§3.4): `before` = page backwards from this entryId. */
export interface RunTxReqFrame {
  t: "run_tx_req";
  rid: string;
  runId: string;
  before?: string;
  limit: number;
  maxBytes: number;
}

/** Live-tap on/off (no reply, idempotent — §5.2 reference-counted by the hub). */
export interface RunWatchFrame {
  t: "run_watch";
  runId: string;
  on: boolean;
}

// ---------------------------------------------------------------------------
// frames — agent→hub
// ---------------------------------------------------------------------------

/**
 * Snapshot reply — three mutually exclusive branches (LanRes-style): `ok:true` + `source`
 * discriminates live-in-memory vs file-backed; `ok:false` denies. The `source:"file"`
 * branch's `sessionFile`/`finalLeafId` are hub-internal: the hub strips both before anything
 * reaches a browser (§5.2), so they NEVER appear in `RunHistoryPayload`.
 */
export type RunTxReplyFrame =
  | {
      t: "run_tx_reply";
      rid: string;
      runId: string;
      ok: true;
      source: "live";
      status: string;
      tapId?: string;
      /** Snapshot watermark; 0 (and no tapId) when no tap is attached. */
      seq: number;
      watching: boolean;
      entries: WireEntry[];
      truncated: boolean;
      hasMore: boolean;
      inflight?: InflightState;
    }
  | {
      t: "run_tx_reply";
      rid: string;
      runId: string;
      ok: true;
      source: "file";
      status: string;
      sessionFile: string;
      finalLeafId: string;
    }
  | {
      t: "run_tx_reply";
      rid: string;
      runId: string;
      ok: false;
      code: "E_NOT_FOUND" | "E_UNSUPPORTED";
      reason: RunTxReason;
    };

/** Live delta from a tap; `seq` is allocated before send (§3.3 #1). */
export interface RunEvFrame {
  t: "run_ev";
  runId: string;
  tapId: string;
  seq: number;
  e: WireEvent;
}

/** Tail-loss report: `fromSeq` = first missing seq (never pauses subsequent sends). */
export interface RunGapFrame {
  t: "run_gap";
  runId: string;
  tapId: string;
  fromSeq: number;
}

/** Terminal marker; `lastSeq` must equal the tap's final counter value (§3.3 #4). */
export interface RunEndFrame {
  t: "run_end";
  runId: string;
  tapId: string;
  lastSeq: number;
  status: string;
}

// ---------------------------------------------------------------------------
// §3.4 browser payloads (hub→browser; the hub constructs these, so interfaces only —
// `sessionFile`/`finalLeafId` from the file reply branch never survive onto this surface)
// ---------------------------------------------------------------------------

/** `run_history` success payload; `tailMessages` is always `[]` (HistoryPayload-isomorphic). */
export interface RunHistoryPayload {
  agentKey: string;
  runId: string;
  entries: WireEntry[];
  /** Always `[]` — kept so the shape stays a drop-in for `HistoryPayload` consumers. */
  tailMessages: WireMessage[];
  inflight?: InflightState;
  tapId?: string;
  /** `fromSeq` = watermark + 1 (§3.3); `0` is the registry-epoch sentinel, never a run seq. */
  fromSeq: number;
  hasMore: boolean;
  oldestEntryId?: string;
  source: "live" | "file";
  terminal: boolean;
  status: string;
  live: boolean;
  /** Hub-initiated resync snapshot (§3.3): replaces the whole runTx state client-side. */
  resync?: true;
}

/** `run_history` error payload (codes per §3.4; `reason` per §3.6). */
export interface RunHistoryError {
  agentKey: string;
  runId: string;
  error: "E_NOT_FOUND" | "E_UNSUPPORTED" | "E_BUSY" | "E_DEADLINE" | "E_AGENT_GONE";
  reason?: RunTxReason;
}

/** `run_ev` fan-out payload (one per live/pending subscriber, direct-send). */
export interface RunEvPayload {
  agentKey: string;
  runId: string;
  tapId: string;
  seq: number;
  e: WireEvent;
}

/** `run_end` fan-out payload. */
export interface RunEndPayload {
  agentKey: string;
  runId: string;
  tapId: string;
  lastSeq: number;
  status: string;
}

// ---------------------------------------------------------------------------
// schemas (runtime validation; the interfaces above are the authoritative shapes —
// behavioral tests pin schema/interface agreement, same posture as messages.ts)
// ---------------------------------------------------------------------------

// --- local loose mirrors (see the file header for the no-cycle rationale) ---

/** Mirror of `messages.ts`'s `FORWARDED_EVENTS` (pinned dynamically by messages.test.ts). */
const RUN_EVENT_TYPES = [
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "session_compact",
  "session_compact_failed",
  "model_select",
  "thinking_level_select",
  "session_info_changed",
  "input",
  "ui_prompt_start",
  "ui_prompt_end",
] as const;

/** Mirror of `WireEntry["type"]`'s 7 literals (accept/reject parity pinned by messages.test.ts). */
const RUN_ENTRY_TYPES = [
  "message",
  "custom_message",
  "custom",
  "compaction",
  "branch_summary",
  "model_change",
  "thinking_level_change",
] as const;

const RunWireMessageSchema = Type.Object({ role: Type.String() }, { additionalProperties: true });

const RunWireEventSchema = Type.Object(
  { type: Type.Union(RUN_EVENT_TYPES.map((e) => Type.Literal(e))) },
  { additionalProperties: true },
);

const RunWireEntrySchema = Type.Object(
  {
    id: Type.String(),
    parentId: Type.Union([Type.String(), Type.Null()]),
    type: Type.Union(RUN_ENTRY_TYPES.map((e) => Type.Literal(e))),
    timestamp: Type.String(),
  },
  { additionalProperties: true },
);

const RunInflightSchema = Type.Object(
  {
    message: Type.Optional(RunWireMessageSchema),
    tools: Type.Array(
      Type.Object({
        toolCallId: Type.String(),
        toolName: Type.String(),
        args: Type.Unknown(),
        partial: Type.Optional(Type.String()),
      }),
    ),
  },
  { additionalProperties: false },
);

const runIdSchema = Type.String({ pattern: RUN_ID_PATTERN });
const tapIdSchema = Type.String({ pattern: TAP_ID_PATTERN });

// --- hub→agent ---

export const RunTxReqSchema = Type.Object(
  {
    t: Type.Literal("run_tx_req"),
    rid: Type.String(),
    runId: runIdSchema,
    before: Type.Optional(Type.String()),
    limit: Type.Integer(),
    maxBytes: Type.Number(),
  },
  { additionalProperties: false },
);

export const RunWatchSchema = Type.Object(
  { t: Type.Literal("run_watch"), runId: runIdSchema, on: Type.Boolean() },
  { additionalProperties: false },
);

// --- agent→hub (three-branch union, LanRes-style: each branch strict and disjoint —
// `additionalProperties:false` is what makes them mutually exclusive) ---

const RunTxReplyLiveSchema = Type.Object(
  {
    t: Type.Literal("run_tx_reply"),
    rid: Type.String(),
    runId: runIdSchema,
    ok: Type.Literal(true),
    source: Type.Literal("live"),
    status: Type.String(),
    tapId: Type.Optional(tapIdSchema),
    seq: Type.Integer(),
    watching: Type.Boolean(),
    entries: Type.Array(RunWireEntrySchema),
    truncated: Type.Boolean(),
    hasMore: Type.Boolean(),
    inflight: Type.Optional(RunInflightSchema),
  },
  { additionalProperties: false },
);

const RunTxReplyFileSchema = Type.Object(
  {
    t: Type.Literal("run_tx_reply"),
    rid: Type.String(),
    runId: runIdSchema,
    ok: Type.Literal(true),
    source: Type.Literal("file"),
    status: Type.String(),
    sessionFile: Type.String(),
    finalLeafId: Type.String(),
  },
  { additionalProperties: false },
);

const RunTxReplyErrSchema = Type.Object(
  {
    t: Type.Literal("run_tx_reply"),
    rid: Type.String(),
    runId: runIdSchema,
    ok: Type.Literal(false),
    code: Type.Union([Type.Literal("E_NOT_FOUND"), Type.Literal("E_UNSUPPORTED")]),
    reason: Type.Union(RUN_TX_REASONS.map((r) => Type.Literal(r))),
  },
  { additionalProperties: false },
);

export const RunTxReplySchema = Type.Union([RunTxReplyLiveSchema, RunTxReplyFileSchema, RunTxReplyErrSchema]);

export const RunEvSchema = Type.Object(
  {
    t: Type.Literal("run_ev"),
    runId: runIdSchema,
    tapId: tapIdSchema,
    seq: Type.Integer(),
    e: RunWireEventSchema,
  },
  { additionalProperties: false },
);

export const RunGapSchema = Type.Object(
  {
    t: Type.Literal("run_gap"),
    runId: runIdSchema,
    tapId: tapIdSchema,
    fromSeq: Type.Integer(),
  },
  { additionalProperties: false },
);

export const RunEndSchema = Type.Object(
  {
    t: Type.Literal("run_end"),
    runId: runIdSchema,
    tapId: tapIdSchema,
    lastSeq: Type.Integer(),
    status: Type.String(),
  },
  { additionalProperties: false },
);
