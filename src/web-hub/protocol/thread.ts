/**
 * Thread 订阅直通 (docs/dev/fabric-thread/arch.md r3) — P0 FROZEN wire contract (§7) + the
 * shared window-parameter clamp (§8.2).
 *
 * What lives here (and why here, not in `src/fabric/thread/`):
 *   - the §7 frame vocabulary: `cmd.cmd.thread` (the optional prompt-variant field),
 *     `cmd_result.data.thread` (the routed result shape), `status.threads` (the open StatusInfo
 *     slot), `thr_req` (agent→hub) and `thr_res` / `thr_closed` (hub→agent) — typebox schemas
 *     (strict, `additionalProperties:false`) plus the authoritative TS interfaces, folded into
 *     `messages.ts`'s unions/decode tables;
 *   - the id/size vocabulary BOTH sides validate against (handle `h`, eventId, runId, postId,
 *     label/text/note caps);
 *   - the agent/hub SHARED window-parameter clamp (§8.2: `clampThreadWindowParams` — the ONE
 *     pure function both the agent settings parser and the hub's HubConfig normalizer call).
 *
 * The `thr.v1` CAP constants live in `protocol/version.ts` (FSB_HUB_CAP precedent). P0 ships
 * declarations + pure helpers only: nothing folds the cap into any caps array, nothing routes the
 * frames, nothing writes `cmd.thread` / `status.threads` (P2 hub / P3 agent own that). No PROTO
 * bump — new optional frames sent only under the cap (same 只加帧不改 rule as fsb_req / xs_* /
 * sched_*).
 *
 * Boundary: node:*-free, pi-free, DOM-free — typebox only. This module must never value-import
 * `messages.js` (messages.ts imports the schemas from here at top level; TDZ — schedule.ts
 * precedent). `protocol/feishu.ts` ids are MIRRORED here (protocol may not be re-imported from a
 * frozen module for one regex); parity is pinned by tests.
 */
import { Type, type TSchema } from "@sinclair/typebox";

// ----------------------------------------------------------------- ids / sizes (§3.1, §7.2, §7.3)

/** Thread handle (§3.1 D2): `fs:` + b64url(HMAC-SHA256(installSecret, bindingKey))[0:12] — the
 *  hub mints it; it never exposes chatId and survives hub restarts (a `setup --replace` secret
 *  rotation invalidates every old handle, by design). */
export const THREAD_HANDLE_RE = /^fs:[A-Za-z0-9_-]{12}$/;

/** ThreadEvent id (§3.1, review #2): the Feishu request id = cmdId = `frame.id` (`fs…`) — the id
 *  the agent received on the cmd frame. LITERAL MIRROR of feishu.ts's FEISHU_CMD_ID_RE (frozen
 *  module; parity pinned by tests/fabric/threads-settings.test.ts). */
export const THREAD_EVENT_ID_RE = /^fs[A-Za-z0-9_-]{30}$/;

/** Direct-dispatch run id — LITERAL MIRROR of core/ids.ts's RUN_ID_RE (protocol cannot import
 *  core; schedule.ts's SCHEDULE_THINKING_LEVELS precedent). */
export const THREAD_RUN_ID_RE = /^r_[0-9A-HJKMNP-TV-Z]{8}$/;

/** pi sessionId as carried on the wire — same shape as schedule.ts's SCHED_SESSION_ID_RE. */
export const THREAD_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** `thr_req{op:"post"}` postId: `<runId>:<seq>` (§7.3) — the hub's 10-minute dedup key. */
export const THREAD_POST_ID_RE = /^r_[0-9A-HJKMNP-TV-Z]{8}:[0-9]{1,10}$/;

/** Thread label cap in CODE POINTS (already `sanitizeHeaderField`-scrubbed by the hub, ≤32 cp).
 *  Enforced EXACTLY by THREAD_LABEL_CP_RE — a surrogate-pair-aware pattern that counts code
 *  points, NOT UTF-16 units: a typebox `maxLength` counts UTF-16 code units and would wrongly
 *  drop a valid 32-cp astral-heavy label (64 units) as oversized (review follow-up). */
export const THREAD_LABEL_MAX_CP = 32;
/** `^` + (one non-surrogate UTF-16 unit OR one complete surrogate pair) × 1..32 + `$` — counts
 *  code points exactly, rejects lone surrogates as a bonus (well-formedness). */
export const THREAD_LABEL_CP_RE = new RegExp(
  `^(?:[^\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]){1,${THREAD_LABEL_MAX_CP}}$`,
);
/** Worker reply body cap (§6.8): 8 KiB UTF-8 BYTES — enforced byte-precisely by `thrFrameOk`
 *  (the decodeWith-layer gate); the schema's `maxLength` is only a UTF-16-unit ENVELOPE (any
 *  string within the byte budget fits within it, so it never falsely drops; a 1-unit-per-byte
 *  count could never catch e.g. 3000 × "€" = 9000 bytes in 3000 units). */
export const THREAD_POST_TEXT_MAX_BYTES = 8 << 10;
/** UTF-16-unit envelope for `thr_req{op:"post"}.text` (schema-level): every string of ≤
 *  THREAD_POST_TEXT_MAX_BYTES UTF-8 bytes has ≤ that many UTF-16 units (UTF-8 bytes ≥ units per
 *  character), so the envelope admits every byte-legal body while bounding pathological input
 *  before `thrFrameOk` ever runs. */
export const THREAD_POST_TEXT_MAX_UTF16 = THREAD_POST_TEXT_MAX_BYTES;
/** handback `note` cap (§7.3): ≤200 CODE POINTS, enforced exactly by the same surrogate-pair-aware
 *  pattern as the label (see THREAD_LABEL_CP_RE). */
export const THREAD_HANDBACK_NOTE_MAX_CP = 200;
export const THREAD_NOTE_CP_RE = new RegExp(
  `^(?:[^\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]){0,${THREAD_HANDBACK_NOTE_MAX_CP}}$`,
);
/** `thr_*` whole-frame serialized-JSON budget (§7.3): ≤12 KiB, measured as
 *  `JSON.stringify(frame).length` in UTF-16 code units — the SAME measure as XS_MAX_FRAME_BYTES
 *  and the global MAX_FRAME_BYTES (repo-wide convention); enforced by `thrFrameOk`. STRICTER than
 *  the global ndjson budget; an oversize thr_ frame is invalid exactly like an unknown one
 *  (xs_* precedent, §8.2). */
export const THREAD_REQ_MAX_BYTES = 12 << 10;
/** Max subscribers reported per thread (`runs` in the routed result, `subs` in status.threads; §5.1
 *  per-thread ceiling is 4). */
export const THREAD_SUBS_MAX = 4;
/** Max `status.threads` slots per status frame (§7.3). */
export const THREAD_STATUS_SLOTS_MAX = 8;

// ----------------------------------------------------------------- cmd.thread (§7.2)

/**
 * The optional `thread` field on the prompt variant of `cmd.cmd`. Hub attaches it ONLY when the
 * target agent's hello caps ∋ `thr.v1` AND the hub config has the `feishuBot.threads` key AND
 * `chatType==="group"` with a threadId (§4.2) — otherwise the frame is byte-identical to today
 * (G2b). `PromptArgsSchema` is closed (`additionalProperties:false`), which is exactly why the
 * field must never ride an old agent: it would drop the whole frame. `sentAt` = the request's
 * `sourceCreatedAt` (ms); `bypass` is derived from `thb:`/`main:` synthetic member ids (§4.2).
 */
export interface ThreadMeta {
  h: string;
  label: string;
  sentAt: number;
  bypass?: true;
}
export const ThreadMetaSchema = Type.Object(
  {
    h: Type.String({ pattern: THREAD_HANDLE_RE.source }),
    label: Type.String({ pattern: THREAD_LABEL_CP_RE.source }),
    sentAt: Type.Integer({ minimum: 0 }),
    bypass: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);

// ----------------------------------------------------------------- routed result (§7.3, §8.1)

/** One subscriber of a routed event — the same `{runId,label}` pair the whole wire reuses. */
export interface ThreadRunRef {
  runId: string;
  label: string;
}
const RunRefSchema = Type.Object(
  {
    runId: Type.String({ pattern: THREAD_RUN_ID_RE.source }),
    label: Type.String({ pattern: THREAD_LABEL_CP_RE.source }),
  },
  { additionalProperties: false },
);

/**
 * `cmd_result.data.thread` (inside the existing `Type.Unknown()` data): the agent's answer for a
 * prompt whose events were routed to subscribers (§6.7 首次回复). Wire-only — never enters any
 * provider payload (G2c). Format-invalid ⇒ the hub treats the result as a plain ok (existing
 * unattributed path, conservatively); the HUB re-validates with this schema (§8.1 step 1).
 */
export interface ThreadRoutedResult {
  outcome: "routed";
  runs: ThreadRunRef[];
}
export const ThreadRoutedResultSchema = Type.Object(
  {
    outcome: Type.Literal("routed"),
    runs: Type.Array(RunRefSchema, { minItems: 1, maxItems: THREAD_SUBS_MAX }),
  },
  { additionalProperties: false },
);

// ----------------------------------------------------------------- status.threads (§7.3)

/** `StatusInfo.threads` open slot: the session's live thread subscriptions, for `/cur` display.
 *  Sent only while the live link's hello_ack.caps ∋ `thr.v1`; absent ⇒ byte-identical status
 *  frame. The open `StatusInfoSchema` forwards it through old hubs untouched (todo/xs precedent). */
export interface ThreadStatusSlotWire {
  h: string;
  subs: ThreadRunRef[];
}
export const ThreadsStatusWireSchema = Type.Array(
  Type.Object(
    {
      h: Type.String({ pattern: THREAD_HANDLE_RE.source }),
      subs: Type.Array(RunRefSchema, { maxItems: THREAD_SUBS_MAX }),
    },
    {
      additionalProperties: false,
    },
  ),
  { maxItems: THREAD_STATUS_SLOTS_MAX },
);

// ----------------------------------------------------------------- thr_closed (§7.2)

/** Thread close reasons (§5.4): unbind/rebind/setup-reset of the backing binding. */
export const THREAD_CLOSE_REASONS = ["unbound", "rebound", "reset"] as const;
export type ThreadCloseReason = (typeof THREAD_CLOSE_REASONS)[number];

/** hub→agent, best effort, no response: the binding behind `h` is gone — the agent ends the
 *  related subscriptions and steers each subscriber a 「话题已解绑」 notice (§5.4). Losing the
 *  frame is harmless: the rebound binding routes later events elsewhere anyway. */
export interface ThrClosedFrame {
  t: "thr_closed";
  h: string;
  reason: ThreadCloseReason;
}
export const ThrClosedSchema = Type.Object(
  {
    t: Type.Literal("thr_closed"),
    h: Type.String({ pattern: THREAD_HANDLE_RE.source }),
    reason: Type.Union(THREAD_CLOSE_REASONS.map((r) => Type.Literal(r))),
  },
  { additionalProperties: false },
);

// ----------------------------------------------------------------- thr_req / thr_res (§7.2, §7.3)

/** Error-code shape on the wire: the SET is open (same posture as feishu's FSB_ERROR_CODE_WIRE_RE). */
export const THREAD_ERROR_CODE_WIRE_RE = /^E_THR_[A-Z0-9_]{1,32}$/;

/** The declared error vocabulary (§5.5/§7.3) — the wire stays open to future codes. */
export const THREAD_ERROR_CODES = [
  /** post: the binding was rebound away from this session. effect none. */
  "E_THR_REBOUND",
  /** post: unknown thread / not subscribed by this run. effect none. */
  "E_THR_UNKNOWN",
  /** post: reply rate limit exceeded. effect none. */
  "E_THR_RATE",
  /** post: body over THREAD_POST_TEXT_MAX_BYTES. effect none. */
  "E_THR_TOO_LARGE",
  /** handback: source no longer retained and not re-deliverable (§5.5 degrade-to-finding). none. */
  "E_THR_HANDBACK_GONE",
  /** handback: the sender was revoked (/webhub feishu deny) — propagate no further, no finding. */
  "E_THR_REVOKED",
  /** session/install/generation mismatch or commit failure; effect none when pre-commit, unknown
   *  when the successor may already exist in memory (§8.3 persistence barrier). */
  "E_THR_STATE",
] as const;
export type ThreadErrorCode = (typeof THREAD_ERROR_CODES)[number];

const RidSchema = Type.String({ minLength: 1, maxLength: 64 });
const SessionIdSchema = Type.String({ pattern: THREAD_SESSION_ID_RE.source, maxLength: 128 });
const HandleSchema = Type.String({ pattern: THREAD_HANDLE_RE.source });
const strict = { additionalProperties: false } as const;

/** agent→hub `thr_req{op:"post"}` (§7.3): a Worker reply into its subscribed thread. Success ⇒
 *  `{queued:true}` (hub outbox, best-effort after that). `postId` is the dedup key — the agent
 *  retries the SAME id once after 5 s and reports `unknown` if still pending. */
export interface ThrPostReqFrame {
  t: "thr_req";
  rid: string;
  op: "post";
  h: string;
  sessionId: string;
  by: ThreadRunRef;
  postId: string;
  text: string;
}
/** agent→hub `thr_req{op:"handback"}` (§8.3): hand one event back to the main session (explicit
 *  Worker handback or `by:"system"` auto-return). Deterministic successor id ⇒ repeat calls all
 *  return the SAME `requestId` (dup on the second+). */
export interface ThrHandbackReqFrame {
  t: "thr_req";
  rid: string;
  op: "handback";
  eventId: string;
  sessionId: string;
  by: ThreadRunRef | "system";
  note: string;
}
export type ThrReqFrame = ThrPostReqFrame | ThrHandbackReqFrame;
export const ThrReqSchema = Type.Union([
  Type.Object(
    {
      t: Type.Literal("thr_req"),
      rid: RidSchema,
      op: Type.Literal("post"),
      h: HandleSchema,
      sessionId: SessionIdSchema,
      by: RunRefSchema,
      postId: Type.String({ pattern: THREAD_POST_ID_RE.source }),
      // UTF-16-unit ENVELOPE only — the byte-precise 8 KiB gate is thrFrameOk (see above).
      text: Type.String({ minLength: 1, maxLength: THREAD_POST_TEXT_MAX_UTF16 }),
    },
    strict,
  ),
  Type.Object(
    {
      t: Type.Literal("thr_req"),
      rid: RidSchema,
      op: Type.Literal("handback"),
      eventId: Type.String({ pattern: THREAD_EVENT_ID_RE.source }),
      sessionId: SessionIdSchema,
      by: Type.Union([RunRefSchema, Type.Literal("system")]),
      note: Type.String({ pattern: THREAD_NOTE_CP_RE.source }),
    },
    strict,
  ),
]);

/** hub→agent reply to `thr_req`, correlated by rid (fsb_res precedent; sent only under `thr.v1`).
 *  `ok:true` carries the per-op data shape; `ok:false` is `{code, effect}` EXACTLY (§7.2 — no
 *  message field in the frozen contract). */
export type ThrResFrame =
  | { t: "thr_res"; rid: string; ok: true; data: ThrResOkData }
  | { t: "thr_res"; rid: string; ok: false; code: string; effect: "none" | "unknown" };
export type ThrResOkData = { queued: true } | { requestId: string; dup?: true };
export const ThrResSchema = Type.Union([
  Type.Object(
    {
      t: Type.Literal("thr_res"),
      rid: RidSchema,
      ok: Type.Literal(true),
      data: Type.Union([
        Type.Object({ queued: Type.Literal(true) }, strict),
        Type.Object(
          { requestId: Type.String({ pattern: THREAD_EVENT_ID_RE.source }), dup: Type.Optional(Type.Literal(true)) },
          strict,
        ),
      ]),
    },
    strict,
  ),
  Type.Object(
    {
      t: Type.Literal("thr_res"),
      rid: RidSchema,
      ok: Type.Literal(false),
      code: Type.String({ pattern: THREAD_ERROR_CODE_WIRE_RE.source }),
      effect: Type.Union([Type.Literal("none"), Type.Literal("unknown")]),
    },
    strict,
  ),
]);

/** Folded into messages.ts's agent→hub decode table (append-only). */
export const THREAD_AGENT_FRAME_SCHEMAS: Readonly<Record<string, TSchema>> = {
  thr_req: ThrReqSchema,
};
/** Folded into messages.ts's hub→agent decode table (append-only). */
export const THREAD_HUB_FRAME_SCHEMAS: Readonly<Record<string, TSchema>> = {
  thr_res: ThrResSchema,
  thr_closed: ThrClosedSchema,
};

/** UTF-8 byte length WITHOUT TextEncoder (node:*-free, DOM-free, same substitution rule as
 *  src/web-hub/ui/src/components/shared/highlight-core.ts): ASCII 1, U+0080..U+07FF 2,
 *  U+0800..U+FFFF 3, a COMPLETE surrogate pair 4 (counted once, pair skipped), and a lone
 *  surrogate 3 — what a real encoder emits as the U+FFFD substitution. */
export function utf8ByteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c < 0xd800 || c > 0xdfff) n += 3;
    else if (c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        n += 4;
        i++;
        continue;
      }
      n += 3; // lone high surrogate
    } else n += 3; // lone low surrogate
  }
  return n;
}

/**
 * The decodeWith-layer semantic gate for thr_* frames — the unit-PRECISE checks that the
 * UTF-16-unit `maxLength` envelopes above cannot express (review follow-up: typebox counts
 * UTF-16 code units, not bytes/code points):
 *   (a) whole frame: serialized JSON length ≤ THREAD_REQ_MAX_BYTES (UTF-16 units — the same
 *       measure as XS_MAX_FRAME_BYTES / MAX_FRAME_BYTES, repo-wide convention);
 *   (b) `op:"post"` text: ≤ THREAD_POST_TEXT_MAX_BYTES UTF-8 BYTES — the §7.3 field budget a
 *       unit count would miss (3000 × "€" is 3000 units but 9000 bytes).
 * Code-point-exact label/note caps need no runtime pass here — their surrogate-pair-aware
 * patterns already count code points. Called by messages.ts decodeWith for every thr_ frame,
 * BEFORE the schema check; inert until P2/P3 route the frames.
 */
export function thrFrameOk(raw: unknown): boolean {
  try {
    if (JSON.stringify(raw).length > THREAD_REQ_MAX_BYTES) return false;
  } catch {
    return false; // circular / unserializable
  }
  if (
    raw !== null &&
    typeof raw === "object" &&
    (raw as Record<string, unknown>)["op"] === "post" &&
    typeof (raw as Record<string, unknown>)["text"] === "string" &&
    utf8ByteLength((raw as Record<string, unknown>)["text"] as string) > THREAD_POST_TEXT_MAX_BYTES
  )
    return false;
  return true;
}

// ----------------------------------------------------------------- window clamp (§8.2, r3-1)

/** §8.2 r3: H = handback window (1–30, default 10), S = start/flush buffer TTL (1–30, default 8),
 *  R = hub payload retention (5–60, default 15), and R ≥ max(H,S)+2 (H,S ≤ 30 ⇒ max+2 ≤ 32 ≤ 60,
 *  so the cross rule never pushes R past its own ceiling). The 2-minute margin covers: one steer
 *  (≤4 s), thr_req 5 s timeout + 2 s + 1 retry, the hub-vs-agent clock origin skew (≤ frame
 *  deadline 8 s) and event-loop jitter. */
export const THREAD_HANDBACK_WINDOW_MIN_BOUNDS = [1, 30] as const;
export const THREAD_START_TIMEOUT_MIN_BOUNDS = [1, 30] as const;
export const THREAD_RETAIN_MIN_BOUNDS = [5, 60] as const;
/** The R ≥ max(H,S) + <margin> slack from §8.2. */
export const THREAD_RETAIN_MARGIN_MIN = 2;

/** The three window parameters, in minutes. */
export interface ThreadWindowParams {
  handbackWindowMin: number;
  startTimeoutMin: number;
  retainMin: number;
}
export type ThreadWindowKey = keyof ThreadWindowParams;

/** Frozen defaults (§8.2 r3-1): (H10, S8, R15) — satisfies R ≥ max(H,S)+2 (15 ≥ 12). */
export const THREAD_WINDOW_DEFAULTS: ThreadWindowParams = {
  handbackWindowMin: 10,
  startTimeoutMin: 8,
  retainMin: 15,
};

/** One clamped field, for the caller to WARN about (`[pi-subagent] fabric.threads.<key> <from> → <to> (<reason>)` agent-side; hub log hub-side). */
export interface ThreadWindowChange {
  key: ThreadWindowKey;
  from: number;
  to: number;
  reason: string;
}

const WINDOW_BOUNDS: Record<ThreadWindowKey, readonly [number, number]> = {
  handbackWindowMin: THREAD_HANDBACK_WINDOW_MIN_BOUNDS,
  startTimeoutMin: THREAD_START_TIMEOUT_MIN_BOUNDS,
  retainMin: THREAD_RETAIN_MIN_BOUNDS,
};

/**
 * The ONE shared window clamp (§8.2 非法组合处理): each field first clamps into its own bounds
 * (a missing value falls back to its default; a present-but-invalid one — wrong type, NaN,
 * ±Infinity — too, with a recorded "invalid" change), then R is raised to max(H,S)+2 when the
 * combination is illegal. Clamp-and-warn — NEVER reject (a default-off feature must not block pi
 * startup). PURE: side-effect-free; callers own the logging (agent: one line per change; hub: log
 * only). The agent writes only clamped values into HubConfig; the hub re-clamps defensively with
 * this same function (P2) — hence "hub clamp ≡ agent clamp" is by construction. The input fields
 * are deliberately `unknown`-tolerant so the settings parser can hand raw JSON leaves straight
 * over without a pre-pass.
 */
export function clampThreadWindowParams(input: {
  handbackWindowMin?: unknown;
  startTimeoutMin?: unknown;
  retainMin?: unknown;
}): {
  value: ThreadWindowParams;
  changes: ThreadWindowChange[];
} {
  const changes: ThreadWindowChange[] = [];
  const value = {} as ThreadWindowParams;
  for (const key of Object.keys(WINDOW_BOUNDS) as ThreadWindowKey[]) {
    const raw = input[key];
    const fallback = THREAD_WINDOW_DEFAULTS[key];
    const [min, max] = WINDOW_BOUNDS[key]!;
    let v: number;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      v = fallback;
      if (raw !== undefined) changes.push({ key, from: Number(raw), to: v, reason: "invalid" });
    } else {
      v = Math.floor(raw);
      if (v !== raw) changes.push({ key, from: raw, to: v, reason: "not an integer" });
    }
    if (v < min) {
      changes.push({ key, from: v, to: min, reason: `below min ${min}` });
      v = min;
    } else if (v > max) {
      changes.push({ key, from: v, to: max, reason: `above max ${max}` });
      v = max;
    }
    value[key] = v;
  }
  const floor = Math.max(value.handbackWindowMin, value.startTimeoutMin) + THREAD_RETAIN_MARGIN_MIN;
  if (value.retainMin < floor) {
    changes.push({
      key: "retainMin",
      from: value.retainMin,
      to: floor,
      reason: `must be ≥ max(handbackWindowMin, startTimeoutMin)+${THREAD_RETAIN_MARGIN_MIN}`,
    });
    // H,S ≤ 30 ⇒ floor ≤ 32 ≤ 60 = R's own ceiling — the raise can never overflow the range.
    value.retainMin = floor;
  }
  return { value, changes };
}
