/**
 * web-hub `/` command argument-completion protocol (web-hub-slash-args plan §3.1/§4 — P0
 * frozen surface).
 *
 * Pure TypeScript + typebox, `node:*`- and `core/`-free (same posture as `run-transcript.ts`):
 * everything P1 (agent), P2 (hub) and P3 (UI) code against for the `/name␠` argument
 * hint/completion channel is frozen in this one module — the agent↔hub frames
 * (`complete_req` hub→agent, `complete_reply` agent→hub), the `CompleteItemWire` item shape,
 * the `CommandInfoWire.args` static-hint sub-object (`CommandInfoArgs`; `messages.ts` folds
 * its schema into `CommandInfoSchema`), the budget block `CMD_ARGS`, and the frozen reply
 * error vocabulary `CMD_ARGS_REPLY_CODES`. `protocol/messages.ts` folds the frame schemas
 * into its two decode tables; `protocol/http-contract.ts` owns the browser-facing endpoint
 * path + request/result shapes (kept THERE on purpose — this module carries runtime typebox
 * schemas, and `ui/src/logic/contract.js` must be able to import the path without dragging
 * `@sinclair/typebox` into the browser bundle; P3 hand-mirrors the few budget numbers it
 * needs, pinned by logic tests, same rule as RUN_TX in `run-transcript.ts`).
 *
 * PROTO: NOT bumped. r1 评审 #2 (2026-10-21, 优先于 plan §11-D4 的 bump 半边) — new
 * optional frames are cap-gated via `cmd.args.v1`, exactly the `fsb_req`/`lan_req`/`tfa_req`
 * precedent (version.ts's 只加帧不改 rule). The PROTO assertion tests stay untouched.
 *
 * Audit posture (§4.2, r1 #6): the hub's completion audit whitelist records ONLY `listener`,
 * `name`, `plen` (prefix byte length), `hits`, `ms`, `code`, `source` — NEVER the prefix or
 * item text. `CMD_ARGS_AUDIT_CODE_ABORTED` is the audit-only `code` value for a request whose
 * browser connection (res-close) went away mid-flight (r1 #6: release the in-flight slot,
 * settle pending early) — it is never a reply code.
 */
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// §4.1/§4.2/§6 frozen budget block (single source for P1/P2/P3; P3 mirrors the UI-side
// entries by hand in ui/src/logic — pinned by tests, never imported across the bundle line)
// ---------------------------------------------------------------------------

export const CMD_ARGS = {
  // --- static usage hints (§3.1) ---
  /** r1 #3: `args.usage` hard cap in CHARACTERS (single line, pre-sanitized). Over-long
   *  source text is truncated at the last whitespace before the cap + "…" (P1's builder);
   *  the wire schema enforces the same cap defensively. */
  usageMaxChars: 200,
  // --- request shape (§4.2) ---
  /** `prefix` hard cap. The hub route validates BYTES (≤1 KiB, no \r\n / control chars);
   *  the frame schema re-checks a chars-based bound (chars ≤ bytes for UTF-8, so this never
   *  rejects what the byte check admitted). */
  prefixMaxBytes: 1024,
  // --- item caps (§4.1/§4.3 #6; agent-side authoritative, hub re-trims defensively) ---
  itemMax: 50,
  itemValueMaxBytes: 512,
  itemLabelMaxChars: 120,
  itemDescMaxChars: 200,
  itemsTotalMaxBytes: 16 << 10,
  // --- hub route budget (§4.2) ---
  /** Total per-request deadline for `POST /api/command/complete`. */
  routeDeadlineMs: 4_000,
  /** Frame `deadlineMs` = min(remaining − deadlineMarginMs, frameDeadlineMaxMs). */
  frameDeadlineMaxMs: 2_000,
  deadlineMarginMs: 300,
  /** Registry request deadline = route deadline + this ack slack (§4.2). */
  ackSlackMs: 500,
  // --- agent side (§4.3 #4) ---
  /** Single completion-call hard timeout (Promise.race, late result dropped; S-tui additionally
   *  gets an AbortSignal). NOTE (r1 #4, accepted residual): a completer that hangs SYNCHRONOUSLY
   *  blocks the JS thread before the race can fire — timeouts/in-flight caps cannot save it;
   *  the settings description states this honestly and `toolkit`/`off` are the escape hatch. */
  agentCallTimeoutMs: 1_500,
  /** Agent-global in-flight completion calls; beyond ⇒ `E_RATE` (retryable). */
  agentInflightMax: 2,
  // --- hub limits (§4.2; INDEPENDENT CmdLimit instance, §7-D14 — never shares the
  //     /api/cmd, upload or preview buckets) ---
  hubRate: {
    /** Per-principal `cpre` (pre-dispatch) bucket: 20 per 1s. */
    cprePerSecond: 20,
    /** `complete` token bucket: capacity 8, refill one token / 200ms. */
    completeCapacity: 8,
    completeRefillMs: 200,
    /** LAN per-IP bucket: 20 per 2s. */
    lanIpPer2s: 20,
    /** Per-target-agent bucket: 15 per 1s. */
    agentPerSecond: 15,
  },
  hubInflight: {
    /** Hub-global concurrent `complete_req`s; beyond ⇒ 503 `E_BUSY`. */
    globalMax: 8,
    /** Per-principal concurrent; beyond ⇒ 429 `E_RATE`. */
    perPrincipalMax: 3,
  },
  // --- UI cadence (§6.3; P3 mirrors these) ---
  /** Client-side fetch timeout. */
  clientTimeoutMs: 3_000,
  /** Debounce after the first (immediate, prefix="") query. */
  debounceMs: 150,
  /** Delay before the loading hint shows when there are no stale rows to keep visible. */
  loadingHintDelayMs: 250,
  /** Backstep-only result cache (never used for local filtering): TTL + LRU cap. */
  cacheTtlMs: 30_000,
  cacheMax: 64,
  /** After `E_RATE`, pause querying for `Retry-After` (server-supplied) — this is the floor. */
  ratePauseFloorMs: 1_000,
} as const;

// ---------------------------------------------------------------------------
// §4.1 frozen reply error vocabulary
// ---------------------------------------------------------------------------

/**
 * `complete_reply{ok:false}.code` — the closed set the agent may answer with, and (for the
 * branch codes that cross to HTTP) the body `error` of `POST /api/command/complete` refusals.
 * `E_UNKNOWN_COMMAND` / `E_COMMAND_DENIED` also exist in http-contract.ts's `API_ERRORS`
 * (reused, not re-declared there); deny never leaks completion items (§4.3 #2).
 */
export const CMD_ARGS_REPLY_CODES = [
  "E_UNKNOWN_COMMAND",
  "E_COMMAND_DENIED",
  "E_UNSUPPORTED",
  "E_RATE",
  "E_DEADLINE",
  "E_BAD_REQUEST",
] as const;
export type CmdArgsReplyCode = (typeof CMD_ARGS_REPLY_CODES)[number];

/** r1 #6: audit-only `code` when the browser connection closed mid-request (res-close). */
export const CMD_ARGS_AUDIT_CODE_ABORTED = "aborted";

// ---------------------------------------------------------------------------
// §3.1 static hint sub-object (`CommandInfoWire.args`)
// ---------------------------------------------------------------------------

/**
 * Append-only `CommandInfoWire.args`. Present ⇒ BOTH sides support the feature (the agent
 * only emits it while hello_ack.caps ∋ `cmd.args.v1`; an un-upgraded hub's closed
 * `CommandInfoSchema` would silently drop the whole `commands` frame otherwise — §7 matrix).
 * The UI needs no extra features token: `row.args !== undefined` is the positive signal.
 *
 * - `usage`: single-line, sanitized static argument hint (≤ `CMD_ARGS.usageMaxChars`), from
 *   toolkit table > pi builtin table > description heuristic (§3.2). Never invented.
 * - `complete: true`: the agent will ATTEMPT dynamic completion (S-own hit, or S-tui available
 *   and the command is an extension command). S-tui is probe-only for third parties — an
 *   optimistically true `complete` with empty results is the normal state, never an error.
 */
export interface CommandInfoArgs {
  usage?: string;
  complete?: true;
}

// ---------------------------------------------------------------------------
// frames — hub→agent (§4.1)
// ---------------------------------------------------------------------------

/**
 * Completion request. `origin.listener` is for POLICY only and deliberately carries NO
 * ip/user — the audit lives on the hub side, and the agent never needs (nor may log) more.
 */
export interface CompleteReqFrame {
  t: "complete_req";
  rid: string;
  name: string;
  prefix: string;
  deadlineMs: number;
  origin: { listener: "loopback" | "lan" };
}

// ---------------------------------------------------------------------------
// frames — agent→hub (§4.1) + item shape
// ---------------------------------------------------------------------------

/**
 * One completion item. `value` REPLACES the whole argument prefix (pi-tui `applyCompletion`
 * semantics — multi-token completions must embed the already-typed tokens; §2 table). The
 * per-item policy pass (§4.3 #7) drops `deny` items entirely; a `confirm` item carries
 * `policy:"confirm"` so the UI can draw the same chip as the command palette.
 */
export interface CompleteItemWire {
  value: string;
  label: string;
  description?: string;
  policy?: "confirm";
}

/**
 * Reply, `run_tx_reply`-style two-branch union (each branch strict + disjoint via
 * `additionalProperties:false`). Success carries the items (+ `truncated:true` when the
 * agent-side caps clipped) and the `source` that answered; failure carries one frozen code
 * and a `retryable` hint. `ok:true, items:[]` is a NORMAL answer (no completions available).
 */
export type CompleteReplyFrame =
  | {
      t: "complete_reply";
      rid: string;
      ok: true;
      items: CompleteItemWire[];
      truncated?: true;
      source: "own" | "tui";
    }
  | {
      t: "complete_reply";
      rid: string;
      ok: false;
      code: CmdArgsReplyCode;
      retryable: boolean;
    };

// ---------------------------------------------------------------------------
// schemas (runtime validation; the interfaces above are the authoritative shapes —
// accept/reject parity is pinned by tests/web-hub/protocol/command-args.test.ts)
// ---------------------------------------------------------------------------

/**
 * Command-name grammar — MIRRORS `hub/http.ts`'s `COMMAND_NAME_RE` (`^[A-Za-z0-9:_.-]{1,64}$`,
 * the same shape `webCommandPolicy` keys already use). This module must stay hub-free; the
 * hub's own route check remains authoritative, the frame schema re-checks defensively.
 */
export const COMMAND_NAME_PATTERN = "^[A-Za-z0-9:_.-]{1,64}$";

/** `CommandInfoWire.args` — closed, all-optional (§3.1 wire). */
export const CommandInfoArgsSchema = Type.Object(
  {
    usage: Type.Optional(Type.String({ maxLength: CMD_ARGS.usageMaxChars })),
    complete: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);

const nameSchema = Type.String({ pattern: COMMAND_NAME_PATTERN });

export const CompleteReqSchema = Type.Object(
  {
    t: Type.Literal("complete_req"),
    rid: Type.String(),
    name: nameSchema,
    prefix: Type.String({ maxLength: CMD_ARGS.prefixMaxBytes }),
    deadlineMs: Type.Number(),
    origin: Type.Object(
      { listener: Type.Union([Type.Literal("loopback"), Type.Literal("lan")]) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const CompleteItemSchema = Type.Object(
  {
    // maxLength is CHARS: always ≥ the byte-trimmed agent output (UTF-8 bytes ≥ chars), so
    // this defensive bound never rejects an agent-side-legal item.
    value: Type.String({ maxLength: CMD_ARGS.itemValueMaxBytes }),
    label: Type.String({ maxLength: CMD_ARGS.itemLabelMaxChars }),
    description: Type.Optional(Type.String({ maxLength: CMD_ARGS.itemDescMaxChars })),
    policy: Type.Optional(Type.Literal("confirm")),
  },
  { additionalProperties: false },
);

const CompleteReplyOkSchema = Type.Object(
  {
    t: Type.Literal("complete_reply"),
    rid: Type.String(),
    ok: Type.Literal(true),
    items: Type.Array(CompleteItemSchema, { maxItems: CMD_ARGS.itemMax }),
    truncated: Type.Optional(Type.Literal(true)),
    source: Type.Union([Type.Literal("own"), Type.Literal("tui")]),
  },
  { additionalProperties: false },
);

const CompleteReplyErrSchema = Type.Object(
  {
    t: Type.Literal("complete_reply"),
    rid: Type.String(),
    ok: Type.Literal(false),
    code: Type.Union(CMD_ARGS_REPLY_CODES.map((c) => Type.Literal(c))),
    retryable: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CompleteReplySchema = Type.Union([CompleteReplyOkSchema, CompleteReplyErrSchema]);
