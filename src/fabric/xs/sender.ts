import { XS_MAX_FRAME_BYTES, xsFrameBytesOk } from "../../web-hub/protocol/xs.js";
import { checkChannelName, normalizeChannel, XS_DEFAULT_CHANNEL } from "./channel.js";
import type { XsReplyIssueInput, XsReplyIssueResult } from "./reply-ledger.js";
import type { XsBroadcastOutcome, XsChannelView, XsSenderBroadcastArgs } from "./types-channel.js";
import type {
  XsChannelInfoWire,
  XsEffect,
  XsResolveCandidateWire,
  XsResFrame,
  XsSessionRowWire,
  XsWakeDowngraded,
} from "../../web-hub/protocol/xs.js";

/**
 * fabric phase-2 X3 (phase2-plan §8.1/§8.2/§8.3/§6.6 + r3 M2/S3): the pi-free SENDER core behind
 * the two main-session tools. Owns exactly the sender-side responsibilities:
 *
 *  - origin guard — snapshot `{sessionId, epoch}` at call start, then re-check "signal not
 *    aborted ∧ same stack/session ∧ same epoch" after EVERY await: after the resolve round trip
 *    (before the send frame — r3 M2: a guard failure here is `none{origin_changed}` and NO send
 *    frame leaves) and after the send round trip (r3 M2: keep an already-received remote verdict,
 *    otherwise `unknown{origin_changed_after_send}` — NEVER `none`).
 *  - fail-fast resolve→send — one `resolve` round trip validates the address (bad target /
 *    ambiguous / not-found surface before any send-side quota is consumed), then ONE `send`;
 *    the protocol has no resend path (§3, NQ3) and neither does this module.
 *  - sender-side pre-checks — `fabric.maxChars` truncation (§5.2: the sender owns truncation),
 *    the 16 KiB frame byte pre-check (oversize is a refusal, never a silent truncate), the
 *    level pre-check (§6.6: sender's own maxLevel fails ⇒ local downgrade `level_limit`), and
 *    `sender_wake_disabled` when the sender's own `fabric.wake.enabled` is off (§4.5).
 *  - effect mapping — hub `xs_res` / transport failures map onto the §4.3 tool result triple
 *    `{status, effect, reason}` with the r3 M2 split: every provably-not-delivered case is
 *    `none`, every ambiguous case is `unknown` (with the S3 "may be queued — do not blindly
 *    resend" semantics carried by the tool text, not here).
 *
 * Boundary: pi-free like the rest of `src/fabric/xs/**` (source-scan gate). The only import is
 * the XS0 wire contract (`src/web-hub/protocol/xs.js` — itself pi-free and dependency-light);
 * the hub connection itself is the injected `XsHubPort` — X2 implements it over
 * `connection.request(frame, "xs.v1")`, tests inject a fake. Assembly (stack wiring, tool
 * registration) belongs to XW, never here.
 */

// ----------------------------------------------------------------- origin snapshot & guard

/** §8.1: the sender-side identity snapshot — hub-admission requires it to still match the
 *  socket's CURRENT member record, and this module requires it to still match across awaits. */
export interface XsOriginSnapshot {
  sessionId: string;
  epoch: number;
}

/** Late-bound identity view owned by XW: `current()` is read fresh at every guard point.
 *  `undefined` ⇒ the stack/session identity is gone (post-`/new`, post-`/reload` teardown). */
export interface XsSenderOriginPort {
  current(): XsOriginSnapshot | undefined;
}

/** §6.6: the causal-level view the sender needs — `levelOfRoot()` is what rides `xs_req.level`,
 *  `hopAllowed()` is the sender's own maxLevel pre-check. */
export interface XsSenderLevelPort {
  levelOfRoot(): number;
  hopAllowed(level: number): boolean;
}

// ----------------------------------------------------------------- hub port (X2 implements, tests fake)

/** What one port round trip resolves to. X2 maps: `res` ⇔ a decoded `xs_res`; `deadline` ⇔ the
 *  agent-side `connection.request` deadline fired (§8.2 table: list/resolve/info 3s, send 8s);
 *  `link_lost` ⇔ the agent socket tore down with the request pending; `off` ⇔ no `xs.v1` cap
 *  (nothing was sent). The port NEVER retries and never fabricates an `xs_res`. */
export type XsPortReply =
  { kind: "res"; res: XsResFrame } | { kind: "deadline" } | { kind: "link_lost" } | { kind: "off" };

export interface XsPortListArgs {
  origin: XsOriginSnapshot;
  query?: string;
  scope?: "hub" | "cwd";
  /** Channel-plan §3.3: optional list filter; only set after the local channel gate passed. */
  channel?: string;
}
/** Channel-plan §5.5: one `xs_req{op:"broadcast"}`. `wake`/`level` follow the send rules. */
export interface XsPortBroadcastArgs {
  origin: XsOriginSnapshot;
  channel: string;
  text: string;
  wake?: true;
  level?: number;
}
export interface XsPortChannelsArgs {
  origin: XsOriginSnapshot;
}
export interface XsPortResolveArgs {
  origin: XsOriginSnapshot;
  query: string;
}
export interface XsPortSendArgs {
  origin: XsOriginSnapshot;
  to: string;
  text: string;
  /** Present only when an effective wake survived the sender pre-checks (omitted ⇔ false, Q1). */
  wake?: true;
  /** Sender's root causal level — carried iff the sender's own wake is enabled (§6.6). */
  level?: number;
  /** Reply-plan §4.2 (RX4): the correlation the sender asks the hub to stamp onto the delivery.
   *  Only ever set after `replyCapable()` — the agent adapter additionally gates on hub caps. */
  expect?: { requestId: string; timeoutMs: number };
  /** Reply-plan §4.2 (RX4): answer a request; `to` is then the verified FULL sessionId. */
  replyTo?: string;
}

/** X3's whole view of the hub connection. X2's adapter builds the `xs_req` frame (adding `t`,
 *  `rid`, `origin` as given) and settles it into one `XsPortReply`; X3 owns every effect
 *  decision, so the mapping below is the single seam tests pin. */
export interface XsHubPort {
  list(args: XsPortListArgs): Promise<XsPortReply>;
  resolve(args: XsPortResolveArgs): Promise<XsPortReply>;
  send(args: XsPortSendArgs): Promise<XsPortReply>;
  /** Reply-plan §4.2 (RX4): true iff local reply is enabled AND the live hub declared
   *  `xs.reply.v1` (RX3's `hubPort().replyCapable()`). Absent ⇒ not capable (fail closed). */
  replyCapable?(): boolean;
  /** Channel-plan §5.5/§3.4: true iff the LIVE hub declared `xs.channel.v1` (and the local agent
   *  declared it too). Absent ⇒ no cap (fail closed: broadcast/channels unsupported, channel
   *  gates behave as on an old hub). */
  hubChannelCap?(): boolean;
  /** Channel-plan §5.5: absent ⇒ `channel_unsupported`. */
  broadcast?(args: XsPortBroadcastArgs): Promise<XsPortReply>;
  /** Channel-plan §4.1 `op:"channels"`; absent ⇒ unsupported. */
  channels?(args: XsPortChannelsArgs): Promise<XsPortReply>;
}

// ----------------------------------------------------------------- results (§4.3 tool triple + statuses)

/** Result classification. `sent` = the hub answered the send with a verdict; everything else is
 *  a refusal/unanswered classification with `effect` still present (r3 M2: pre-send failures are
 *  `none`, post-send ambiguity is `unknown`). */
export type XsSendStatus =
  | "sent" // hub answered the send — effect/reason/wakeDowngraded as answered
  | "unanswered" // send frame left, no verdict came back (client_deadline / link_lost / origin_changed_after_send)
  | "no_target" // E_XS_NO_TARGET — unknown and not-joined are indistinguishable (XI5)
  | "ambiguous" // address matched multiple members — candidates listed, nothing sent for it
  | "bad_target" // reserved address form (root/system/main/r_…/@…/wf_…, §4.3)
  | "stale_origin" // hub rejected the frame's origin (E_XS_STALE_ORIGIN) — provably not relayed
  | "origin_changed" // LOCAL guard failed BEFORE the send frame (r3 M2 ⇒ none, no frame)
  | "off" // E_XS_OFF — this hub lacks/lost the xs.v1 cap
  | "too_large" // sender-side 16 KiB frame pre-check (§5.2)
  | "bad_frame" // hub rejected the frame shape (E_XS_BAD_FRAME)
  | "bad_args" // reply-plan RR6: expectReply and replyTo together — rejected locally
  | "reply_unsupported" // reply-plan §4.2: no reply cap (local/hub/target) or no full sessionId — nothing sent
  | "reply_unreceivable" // expectReply but this session could not receive the reply (receive_off|blocked|not_joined)
  | "reply_quota" // ledger per-session/per-target quota
  | "reply_ledger_full" // process ledger slots exhausted
  | "reply_target_mismatch" // replyTo's request came from a different session than `to`
  | "not_joined" // channel plan §2.3/§4: local linkJoined gate — nothing sent
  | "error"; // E_XS_INTERNAL / transport / unmapped codes

export interface XsSendOutcome {
  status: XsSendStatus;
  effect: XsEffect;
  reason?: string;
  code?: string;
  to?: { ref: string; name?: string };
  wakeDowngraded?: XsWakeDowngraded;
  candidates?: XsResolveCandidateWire[];
  /** True when the sender truncated the body to `fabric.maxChars` before sending. */
  truncated?: boolean;
  /** expectReply result (reply-plan §4.2): present iff a ticket was issued. */
  reply?: { requestId: string; dueAt: string; state: "pending" | "send_failed" };
  /** replyTo result: `accepted` ⇔ the recipient confirmed delivery (effect applied). */
  replyTo?: { requestId: string; accepted: boolean };
  /** Sub-reason for `reply_unreceivable` (`receive_off|blocked|not_joined`). */
  unreceivable?: "receive_off" | "blocked" | "not_joined";
  /** Derived (XS0-report §3: `xs_res` carries no `woke`): a wake was requested, not downgraded,
   *  and the hub's evidence is `applied` — i.e. a run provably started (Fpi2). */
  woke?: boolean;
}

/** The closed reason vocabulary this module emits (`XsResFrame.reason` itself stays `string`):
 *  XS0's `XsNoneReason`/`XsUnknownReason` entries plus the sender-local spellings
 *  `bad_target` / `too_large` / `unspecified` and the resolve-stage transport notes. */
export type XsSenderReason =
  | "bad_target"
  | "too_large"
  | "origin_changed"
  | "client_deadline"
  | "link_lost"
  | "origin_changed_after_send"
  | "unspecified"
  | "ambiguous"
  | "unverified"
  | (string & {});

export interface XsListOutcome {
  status: "ok" | "origin_changed" | "off" | "error" | "not_joined" | "bad_channel" | "channel_unsupported";
  rows?: XsSessionRowWire[];
  code?: string;
  reason?: string;
}

/** Channel-plan §4.1 `op:"channels"` result (Q7: names + member counts only). */
export interface XsChannelsOutcome {
  status: "ok" | "origin_changed" | "off" | "error" | "not_joined" | "channel_unsupported";
  channels?: XsChannelInfoWire[];
  code?: string;
  reason?: string;
}

// ----------------------------------------------------------------- reserved address forms (§4.3, G2)

const RESERVED_EXACT = new Set(["root", "system", "main"]);
const RESERVED_PREFIXES = ["r_", "@", "wf_"] as const;

/** §4.3/G2: addresses that can never name a joined main session. Tree refs, mention labels and
 *  workflow ids are a different address space; rejecting them locally costs no round trip. */
export function xsTargetFormallyRejected(to: string): boolean {
  const t = to.trim();
  if (t.length === 0 || t.length > 128) return true;
  if (RESERVED_EXACT.has(t)) return true;
  return RESERVED_PREFIXES.some((p) => t.startsWith(p));
}

// ----------------------------------------------------------------- truncation (§5.2 — sender owns it)

/** Same 75/25 head+tail split as the tree router (`src/fabric/router.ts`); kept local because
 *  X3 may not touch router.ts (file ownership, §11.1). */
const truncate = (text: string, max: number): string =>
  [...text].length <= max
    ? text
    : [...text].slice(0, Math.ceil(max * 0.75)).join("") + [...text].slice(-Math.floor(max * 0.25)).join("");

/** Worst-case `xs_req` shape for the byte pre-check: a maximal rid (64), maximal ids (128) and a
 *  huge epoch keep this honest without knowing X2's actual rid. */
function sendFrameBytesOk(
  origin: XsOriginSnapshot,
  to: string,
  text: string,
  wake: boolean,
  level: number | undefined,
  reply?: { expect?: boolean; replyTo?: boolean },
): boolean {
  return xsFrameBytesOk({
    t: "xs_req",
    rid: "r".repeat(64),
    op: "send",
    origin: { sessionId: origin.sessionId.padEnd(128, "s"), epoch: Number.MAX_SAFE_INTEGER },
    to: to.padEnd(128, "t"),
    text,
    ...(wake ? { wake } : {}),
    ...(level !== undefined ? { level } : {}),
    // worst-case reply fields (reply-plan §5.2 16 KiB budget)
    ...(reply?.expect ? { expect: { requestId: "q" + "0".repeat(18), timeoutMs: 86_400_000 } } : {}),
    ...(reply?.replyTo ? { replyTo: "q" + "0".repeat(18) } : {}),
  } as Parameters<typeof xsFrameBytesOk>[0]);
}

// ----------------------------------------------------------------- hub reply mapping (§8.2/§8.3, r3 M2)

/** `ok:false` codes that PROVE nothing was relayed (admission-time rejections — §8.3 send steps
 *  ①–④ all precede `registry.request`): effect `none`. Everything else (E_XS_INTERNAL, unknown
 *  codes) is conservatively `unknown` — the handler's catch-all cannot prove where it threw. */
const PROVABLE_NONE_CODES = new Set([
  "E_XS_OFF",
  "E_XS_BAD_FRAME",
  "E_XS_BAD_TARGET",
  "E_XS_NO_TARGET",
  "E_XS_AMBIGUOUS",
  "E_XS_STALE_ORIGIN",
  "E_XS_TOO_LARGE",
  "E_XS_REPLY_UNSUPPORTED", // reply-plan §5.2: refused before any reservation
]);

function statusForCode(code: string | undefined): XsSendStatus {
  switch (code) {
    case "E_XS_NO_TARGET":
      return "no_target";
    case "E_XS_AMBIGUOUS":
      return "ambiguous";
    case "E_XS_BAD_TARGET":
      return "bad_target";
    case "E_XS_STALE_ORIGIN":
      return "stale_origin";
    case "E_XS_OFF":
      return "off";
    case "E_XS_TOO_LARGE":
      return "too_large";
    case "E_XS_BAD_FRAME":
      return "bad_frame";
    case "E_XS_REPLY_UNSUPPORTED":
      return "reply_unsupported";
    default:
      return "error";
  }
}

function resReason(res: XsResFrame): XsSenderReason | undefined {
  if (res.reason !== undefined) return res.reason;
  return res.effect === undefined && res.ok ? "unspecified" : undefined;
}

// ----------------------------------------------------------------- tool-name collision helper (§4.3)

/** The two main-session tool names this package owns (registered only by XW, only when `xsOn`). */
export const XS_MAIN_TOOL_NAMES = ["list_sessions", "message_session"] as const;
/** Channel-plan §6.1: the third main-session tool, registered by CHW only when `xsOn ∧ channels.enabled`.
 *  Kept separate from `XS_MAIN_TOOL_NAMES` so the channels-off collision set is unchanged. */
export const XS_CHANNEL_TOOL_NAME = "message_channel";

/**
 * §4.3/#12: detect another source already registering a same-named tool at `session_start`.
 * `existing === undefined` (e.g. `pi.getAllTools()` unreadable) counts as NO conflict — the
 * caller warns once and surfaces `tool collision: <name>` in `/fabric status`; pi's own
 * duplicate-name arbitration is recorded by conformance C-X7, not relied on here.
 */
export function detectXsToolCollisions(
  existing: readonly string[] | undefined,
  opts?: { channels?: boolean },
): string[] {
  if (!existing) return [];
  const have = new Set(existing);
  const names: readonly string[] =
    opts?.channels === true ? [...XS_MAIN_TOOL_NAMES, XS_CHANNEL_TOOL_NAME] : XS_MAIN_TOOL_NAMES;
  return names.filter((n) => have.has(n));
}

// ----------------------------------------------------------------- sender

/** Reply-plan §4.2 (RX4): everything the reply branches need, injected by RXW. Absent ⇒ both
 *  `expectReply` and `replyTo` answer `reply_unsupported` (nothing issued, nothing sent). */
export interface XsSenderReplyDeps {
  /** The process ledger (`getXsReplyLedger()`); only `issue` + `recordSend` are used here. */
  ledger: {
    issue(input: XsReplyIssueInput): XsReplyIssueResult;
    recordSend(requestId: string, effect: "applied" | "none" | "unknown"): void;
  };
  /** `fabric.crossSession.reply.*` leaves (already clamped by the settings parser). */
  defaultTimeoutS: number;
  maxTimeoutS: number;
  lateGraceS: number;
  maxPending: number;
  maxPendingPerTarget: number;
  /** §4.2 step 2 receivability precheck against THIS stack: joined ∧ effective receive ≠ off ∧
   *  `senderAllowed(target)`. `ok` ⇒ a reply could be accepted; anything else refuses. */
  receivable(targetSessionId: string): "ok" | "receive_off" | "blocked" | "not_joined";
  /** §4.2 replyTo step 3: look up the inbound message that carried `requestId` (newest first,
   *  ≤2000 entries). `undefined` ⇒ not found (A decides — never blocks). */
  inbound(requestId: string): { fromSessionId: string } | undefined;
  /** Clock seam (ms); defaults to Date.now. */
  now?: () => number;
}

export interface XsSenderDeps {
  port: XsHubPort;
  origin: XsSenderOriginPort;
  /** `fabric.maxChars` — the sender owns body truncation (§5.2). Default 2000. */
  maxChars?: number;
  /** `fabric.wake.enabled`, frozen per activation (§4.5 sender row). */
  wakeOn?: boolean;
  /** Causal-level view; wired iff wake is on. Absent ⇒ `wake:true` degrades
   *  (`sender_wake_disabled`) and no `level` rides the frame (§6.6). */
  level?: XsSenderLevelPort;
  /** Reply-plan §4.2 (RX4); wired iff `reply.enabled`. */
  reply?: XsSenderReplyDeps;
  /** Channel-plan §2.3/§4/§5.5 (CH4): the local channel view, wired iff `channels.enabled`.
   *  Absent ⇒ every channel gate is skipped and behavior is the pre-channel sender, byte for byte. */
  channels?: XsChannelView;
}

export interface XsSenderMessageArgs {
  to: string;
  text: string;
  wake?: boolean;
  signal?: AbortSignal;
  /** Reply-plan §4.1: ask the recipient for ONE reply (`timeoutS` default = settings default). */
  expectReply?: { timeoutS?: number };
  /** Reply-plan §4.1: answer a request (`q` + 18 hex from the header's reply_to). */
  replyTo?: string;
  /** Who initiated: `model` (default; reply wakes the requester) or `human` (@session — quiet
   *  reply, R4). Never reachable from a tool parameter. */
  origin?: "model" | "human";
  /** `0` for human-origin sends (causal level of human input, §9). */
  levelOverride?: 0;
}

export interface XsSender {
  list(args: {
    query?: string;
    scope?: "hub" | "cwd";
    /** Channel-plan §6.2: optional channel filter (gated locally; ignored-as-unsupported without a view). */
    channel?: string;
    signal?: AbortSignal;
  }): Promise<XsListOutcome>;
  message(args: XsSenderMessageArgs): Promise<XsSendOutcome>;
  /** Channel-plan §5.5. Absent on pre-channel fakes; the real sender always provides it. */
  broadcast(args: XsSenderBroadcastArgs): Promise<XsBroadcastOutcome>;
  /** Channel-plan §4.1 `op:"channels"`. */
  channels(args?: { signal?: AbortSignal }): Promise<XsChannelsOutcome>;
}

/** Worst-case broadcast `xs_req` for the byte pre-check (§5.5). */
function broadcastFrameBytesOk(origin: XsOriginSnapshot, channel: string, text: string, wake: boolean): boolean {
  return xsFrameBytesOk({
    t: "xs_req",
    rid: "r".repeat(64),
    op: "broadcast",
    origin: { sessionId: origin.sessionId.padEnd(128, "s"), epoch: Number.MAX_SAFE_INTEGER },
    channel,
    text,
    ...(wake ? { wake } : {}),
    level: 31,
  } as unknown as Parameters<typeof xsFrameBytesOk>[0]);
}

/** Broadcast `ok:false` codes that PROVE nothing was fanned out (admission precedes any delivery). */
const BROADCAST_NONE_CODES = new Set([
  "E_XS_OFF",
  "E_XS_BAD_FRAME",
  "E_XS_BAD_TARGET",
  "E_XS_STALE_ORIGIN",
  "E_XS_TOO_LARGE",
  "E_XS_FANOUT_TOO_LARGE",
  "E_XS_NO_TARGET",
]);

export function createXsSender(deps: XsSenderDeps): XsSender {
  const maxChars =
    deps.maxChars !== undefined && Number.isFinite(deps.maxChars) && deps.maxChars > 0 ? deps.maxChars : 2000;

  /** §8.1 guard: signal ∧ stack/session identity unchanged. One boolean — the reason is always
   *  `origin_changed` and the M2 split is decided by WHERE in the flow it fired. */
  const guardOk = (snapshot: XsOriginSnapshot, signal: AbortSignal | undefined): boolean => {
    if (signal?.aborted) return false;
    const cur = deps.origin.current();
    return cur !== undefined && cur.sessionId === snapshot.sessionId && cur.epoch === snapshot.epoch;
  };

  return {
    async list(args) {
      const snapshot = deps.origin.current();
      if (!snapshot || args.signal?.aborted) return { status: "origin_changed", reason: "origin_changed" };
      const query = args.query !== undefined ? args.query.slice(0, 128) : undefined; // XsReqSchema.query cap
      // Channel-plan §2.3/§6.2 local gate (only with a wired view): not joined on THIS link ⇒ nothing sent.
      let channel: string | undefined;
      if (deps.channels) {
        const hubCap = deps.port.hubChannelCap?.() === true;
        if (!deps.channels.linkJoined(hubCap)) return { status: "not_joined", reason: "not_joined" };
        if (args.channel !== undefined) {
          if (!hubCap) return { status: "channel_unsupported", reason: "channel_unsupported" };
          const c = normalizeChannel(args.channel);
          if (c === null || !deps.channels.link(true).includes(c))
            return { status: "bad_channel", reason: "bad_channel" };
          channel = c;
        }
      } else if (args.channel !== undefined) {
        return { status: "channel_unsupported", reason: "channel_unsupported" };
      }
      const reply = await deps.port.list({
        origin: snapshot,
        ...(query !== undefined ? { query } : {}),
        ...(args.scope !== undefined ? { scope: args.scope } : {}),
        ...(channel !== undefined ? { channel } : {}),
      });
      // Channel-plan §4.5/M8: re-check (sessionId, epoch) after the await — a changed origin means the
      // rows were computed for another channel set; never return them (also for default-only).
      if (!guardOk(snapshot, args.signal)) return { status: "origin_changed", reason: "origin_changed" };
      if (reply.kind === "off") return { status: "off" };
      if (reply.kind !== "res") {
        return { status: "error", reason: reply.kind === "deadline" ? "client_deadline" : "link_lost" };
      }
      if (!reply.res.ok) {
        return reply.res.code !== undefined ? { status: "error", code: reply.res.code } : { status: "error" };
      }
      return { status: "ok", rows: reply.res.rows ?? [] };
    },

    async message(args) {
      const to = (typeof args.to === "string" ? args.to : "").trim();
      if (args.expectReply !== undefined && args.replyTo !== undefined) {
        // reply-plan RR6: local refusal, nothing issued, nothing sent
        return { status: "bad_args", effect: "none", reason: "expect_and_reply_to" };
      }
      if (xsTargetFormallyRejected(to)) {
        return { status: "bad_target", effect: "none", reason: "bad_target" };
      }
      const snapshot = deps.origin.current();
      if (!snapshot || !guardOk(snapshot, args.signal)) {
        return { status: "origin_changed", effect: "none", reason: "origin_changed" };
      }
      if (deps.channels && !deps.channels.linkJoined(deps.port.hubChannelCap?.() === true)) {
        // Channel-plan §2.3: a session with no channel on this link is not joined on the hub — nothing sent.
        return { status: "not_joined", effect: "none", reason: "not_joined" };
      }
      const replyDeps = deps.reply;
      const replyCapable = (): boolean => replyDeps !== undefined && deps.port.replyCapable?.() === true;
      const replyToId = args.replyTo;
      const expectReq = args.expectReply;
      // reply-plan §4.2 replyTo step 1: capability first (before any round trip)
      if (replyToId !== undefined && !replyCapable()) {
        return { status: "reply_unsupported", effect: "none", reason: "reply_unsupported" };
      }

      // ---- resolve round trip (fail fast; consumes no send quota) ----
      const resolveReply = await deps.port.resolve({ origin: snapshot, query: to });
      // r3 M2 + §11.2 X3 anchor: `/new` (or leave, or abort) DURING the resolve round trip ⇒ the
      // send frame is never issued and the verdict is a provable `none`.
      if (!guardOk(snapshot, args.signal)) {
        return { status: "origin_changed", effect: "none", reason: "origin_changed" };
      }
      let resolvedTarget: { ref: string; name?: string; sessionId?: string } | undefined;
      if (resolveReply.kind === "off") return { status: "off", effect: "none", code: "E_XS_OFF" };
      if (resolveReply.kind !== "res") {
        // Nothing was sent yet ⇒ provably `none`; the model may retry the whole call later.
        return {
          status: "error",
          effect: "none",
          reason: resolveReply.kind === "deadline" ? "client_deadline" : "link_lost",
        };
      }
      const rres = resolveReply.res;
      if (!rres.ok) {
        const status = statusForCode(rres.code);
        return {
          status,
          effect: "none",
          ...(rres.code !== undefined ? { code: rres.code } : {}),
          ...(status === "ambiguous" && rres.candidates ? { candidates: rres.candidates } : {}),
          ...(rres.reason !== undefined ? { reason: rres.reason } : {}),
        };
      }
      if (rres.candidates !== undefined && rres.candidates.length > 0) {
        return { status: "ambiguous", effect: "none", candidates: rres.candidates, reason: "ambiguous" };
      }
      resolvedTarget = rres.target;
      /** The wire `to` never exposes the full sessionId to the model (reply-plan §4.2 返回值). */
      const publicTarget = (
        t: { ref: string; name?: string; sessionId?: string } | undefined,
      ): { ref: string; name?: string } | undefined =>
        t === undefined ? undefined : { ref: t.ref, ...(t.name !== undefined ? { name: t.name } : {}) };

      // ---- reply branches: pin the address to the verified FULL sessionId (review #3) ----
      let sendTo = to;
      let expectWire: { requestId: string; timeoutMs: number } | undefined;
      let issuedRequestId: string | undefined;
      let issuedDueAt: number | undefined;
      const isHuman = args.origin === "human";
      if (replyToId !== undefined || expectReq !== undefined) {
        // expectReply: capability check happens here, after resolve (plan step order)
        if (!replyCapable() || replyDeps === undefined) {
          return { status: "reply_unsupported", effect: "none", reason: "reply_unsupported" };
        }
        const fullId = resolvedTarget?.sessionId;
        if (fullId === undefined || fullId.length === 0) {
          return { status: "reply_unsupported", effect: "none", reason: "no_session_id" };
        }
        sendTo = fullId;
        if (replyToId !== undefined) {
          const found = replyDeps.inbound(replyToId);
          if (found !== undefined && found.fromSessionId !== fullId) {
            return { status: "reply_target_mismatch", effect: "none", reason: "reply_target_mismatch" };
          }
        } else {
          const rcv = replyDeps.receivable(fullId);
          if (rcv !== "ok") {
            return { status: "reply_unreceivable", effect: "none", reason: "reply_unreceivable", unreceivable: rcv };
          }
        }
      }

      // ---- sender-side pre-checks (§4.5/§6.6/§5.2) — all local, no await ----
      // replyTo carries neither wake nor level (reply-plan §4.2): the requester decides wake.
      let wake: true | undefined;
      let localDowngrade: XsWakeDowngraded | undefined;
      const wantWake = replyToId === undefined && args.wake === true;
      const wakeUsable = deps.wakeOn === true && deps.level !== undefined;
      const levelBase =
        args.levelOverride !== undefined ? args.levelOverride : wakeUsable ? deps.level!.levelOfRoot() : undefined;
      if (wantWake) {
        if (!wakeUsable) localDowngrade = "sender_wake_disabled";
        else if (!deps.level!.hopAllowed(levelBase ?? 0)) localDowngrade = "level_limit";
        else wake = true;
      }
      // §6.6: carried iff sender wake on; never on a reply
      const level = replyToId !== undefined ? undefined : wakeUsable ? levelBase : undefined;

      const text = truncate(args.text ?? "", maxChars);
      const truncated = text !== args.text;
      if (
        !sendFrameBytesOk(snapshot, sendTo, text, wake === true, level, {
          expect: expectReq !== undefined,
          replyTo: replyToId !== undefined,
        })
      ) {
        return { status: "too_large", effect: "none", reason: "too_large", ...(truncated ? { truncated: true } : {}) };
      }

      // ---- expectReply: issue BEFORE send, same synchronous block as the guard above ----
      if (expectReq !== undefined && replyDeps !== undefined) {
        const timeoutS = Math.min(
          replyDeps.maxTimeoutS,
          Math.max(60, Math.floor(expectReq.timeoutS ?? replyDeps.defaultTimeoutS)),
        );
        const issued = replyDeps.ledger.issue({
          requesterSessionId: snapshot.sessionId,
          replierSessionId: sendTo,
          replierRef: resolvedTarget?.ref ?? sendTo,
          ...(resolvedTarget?.name !== undefined ? { replierName: resolvedTarget.name } : {}),
          origin: isHuman ? "human" : "model",
          wakeOnReply: true, // RX7 (reply-plan §10.2): human origin no longer means display-only
          requesterLevel: isHuman ? 0 : wakeUsable ? deps.level!.levelOfRoot() : 0,
          timeoutMs: timeoutS * 1000,
          lateGraceMs: replyDeps.lateGraceS * 1000,
          maxPending: replyDeps.maxPending,
          maxPendingPerTarget: replyDeps.maxPendingPerTarget,
        });
        if (!issued.ok) {
          return {
            status: issued.code,
            effect: "none",
            reason: issued.code === "reply_quota" && issued.perTarget === true ? "per_target" : issued.code,
          };
        }
        issuedRequestId = issued.ticket.requestId;
        issuedDueAt = issued.ticket.dueAt;
        expectWire = { requestId: issued.ticket.requestId, timeoutMs: timeoutS * 1000 };
      }
      const settleTicket = (effect: XsEffect): { state: "pending" | "send_failed" } | undefined => {
        if (issuedRequestId === undefined) return undefined;
        replyDeps?.ledger.recordSend(issuedRequestId, effect);
        return { state: effect === "none" ? "send_failed" : "pending" };
      };
      const withReply = (o: XsSendOutcome): XsSendOutcome => {
        // ticket settle first (exactly once), then decorate
        const t = settleTicket(o.effect);
        if (t !== undefined && issuedRequestId !== undefined && issuedDueAt !== undefined) {
          o.reply = { requestId: issuedRequestId, dueAt: new Date(issuedDueAt).toISOString(), state: t.state };
        }
        if (replyToId !== undefined) {
          o.replyTo = { requestId: replyToId, accepted: o.status === "sent" && o.effect === "applied" };
        }
        return o;
      };

      // ---- exactly one send; no resend path (§3, NQ3) ----
      let sendReply: XsPortReply;
      try {
        sendReply = await deps.port.send({
          origin: snapshot,
          to: sendTo,
          text,
          ...(wake !== undefined ? { wake } : {}),
          ...(level !== undefined ? { level } : {}),
          ...(expectWire !== undefined ? { expect: expectWire } : {}),
          ...(replyToId !== undefined ? { replyTo: replyToId } : {}),
        });
      } catch {
        // a port that throws cannot prove non-delivery ⇒ unknown (never none), ticket stays pending
        return withReply({ status: "unanswered", effect: "unknown", reason: "link_lost" });
      }

      // ---- r3 M2 post-send guard: origin changed AFTER the send ----
      const stillCurrent = guardOk(snapshot, args.signal);
      if (!stillCurrent && (sendReply.kind === "deadline" || sendReply.kind === "link_lost")) {
        // No verdict arrived; the message may have taken effect ⇒ unknown, NEVER none.
        return withReply({ status: "unanswered", effect: "unknown", reason: "origin_changed_after_send" });
      }
      // Any received verdict (ok or provable rejection) survives the identity change; `off`
      // proves nothing was sent. Map below, then return as-is.

      if (sendReply.kind === "off") return withReply({ status: "off", effect: "none", code: "E_XS_OFF" });
      if (sendReply.kind === "deadline") {
        return withReply({ status: "unanswered", effect: "unknown", reason: "client_deadline" });
      }
      if (sendReply.kind === "link_lost") {
        return withReply({ status: "unanswered", effect: "unknown", reason: "link_lost" });
      }
      const res = sendReply.res;
      const target = publicTarget(res.target ?? resolvedTarget);
      if (res.ok) {
        const effect: XsEffect = res.effect ?? "unknown"; // XI11: no evidence field ⇒ unknown
        const wakeDowngraded = res.wakeDowngraded ?? localDowngrade;
        const woke = wantWake && wakeDowngraded === undefined && effect === "applied";
        const reason = resReason(res);
        return withReply({
          status: "sent",
          effect,
          ...(reason !== undefined ? { reason } : {}),
          ...(target !== undefined ? { to: target } : {}),
          ...(wakeDowngraded !== undefined ? { wakeDowngraded } : {}),
          ...(truncated ? { truncated: true } : {}),
          ...(woke ? { woke: true } : {}),
        });
      }
      const status = statusForCode(res.code);
      const provablyNone = res.code !== undefined && PROVABLE_NONE_CODES.has(res.code);
      return withReply({
        status,
        effect: provablyNone ? "none" : "unknown",
        ...(res.code !== undefined ? { code: res.code } : {}),
        ...(res.reason !== undefined || !provablyNone ? { reason: res.reason ?? "unverified" } : {}),
        ...(target !== undefined ? { to: target } : {}),
        ...(status === "ambiguous" && res.candidates ? { candidates: res.candidates } : {}),
        ...(truncated ? { truncated: true } : {}),
      });
    },

    async broadcast(args) {
      // CH0 contract: name syntax AND reserved names (root/system/pi-*…) are refused up front.
      const checked = checkChannelName(args.channel);
      const shown = checked.ok
        ? checked.name
        : (normalizeChannel(args.channel) ?? (typeof args.channel === "string" ? args.channel.slice(0, 64) : ""));
      const none = (status: XsBroadcastOutcome["status"], reason: string, extra?: Partial<XsBroadcastOutcome>) =>
        ({ status, effect: "none", reason, channel: shown, ...extra }) as XsBroadcastOutcome;
      if (!checked.ok) return none("bad_channel", checked.reason === "reserved" ? "reserved" : "bad_channel");
      const channel = checked.name;
      // Q2 (product limit): checked before membership so the answer never depends on local state.
      if (channel === XS_DEFAULT_CHANNEL) return none("default_channel", "default_channel");
      const view = deps.channels;
      const hubCap = deps.port.hubChannelCap?.() === true;
      if (view === undefined || !hubCap || deps.port.broadcast === undefined) {
        return none("channel_unsupported", "channel_unsupported");
      }
      if (!view.linkJoined(true)) return none("not_joined", "not_joined");
      if (!view.link(true).includes(channel)) return none("bad_channel", "channel_not_joined");
      const snapshot = deps.origin.current();
      if (!snapshot || !guardOk(snapshot, args.signal)) return none("origin_changed", "origin_changed");

      // wake: same口径 as message() PLUS level 0 (§5.5); degrade locally, never send a doomed wake.
      let wake: true | undefined;
      let localDowngrade: XsWakeDowngraded | undefined;
      const wakeUsable = deps.wakeOn === true && deps.level !== undefined;
      const rootLevel = wakeUsable ? deps.level!.levelOfRoot() : undefined;
      if (args.wake === true) {
        if (!wakeUsable) localDowngrade = "sender_wake_disabled";
        else if (!deps.level!.hopAllowed(rootLevel ?? 0) || rootLevel !== 0) localDowngrade = "level_limit";
        else wake = true;
      }
      const level = wakeUsable ? rootLevel : undefined;

      const text = truncate(args.text ?? "", maxChars);
      const truncated = text !== args.text;
      const trunc = truncated ? { truncated: true } : {};
      if (!broadcastFrameBytesOk(snapshot, channel, text, wake === true)) return none("too_large", "too_large", trunc);

      let reply: XsPortReply;
      try {
        reply = await deps.port.broadcast({
          origin: snapshot,
          channel,
          text,
          ...(wake !== undefined ? { wake } : {}),
          ...(level !== undefined ? { level } : {}),
        });
      } catch {
        return { status: "unanswered", effect: "unknown", reason: "link_lost", channel, ...trunc };
      }
      const stillCurrent = guardOk(snapshot, args.signal);
      if (!stillCurrent && (reply.kind === "deadline" || reply.kind === "link_lost")) {
        return { status: "unanswered", effect: "unknown", reason: "origin_changed_after_send", channel, ...trunc };
      }
      if (reply.kind === "off") return none("off", "off", { code: "E_XS_OFF", ...trunc });
      if (reply.kind === "deadline") {
        return { status: "unanswered", effect: "unknown", reason: "client_deadline", channel, ...trunc };
      }
      if (reply.kind === "link_lost") {
        return { status: "unanswered", effect: "unknown", reason: "link_lost", channel, ...trunc };
      }
      const res = reply.res;
      if (res.ok) {
        const reason = resReason(res);
        const wakeDowngraded = res.wakeDowngraded ?? localDowngrade;
        return {
          status: "sent",
          effect: res.effect ?? "unknown", // XI11: no evidence field ⇒ unknown
          ...(reason !== undefined ? { reason } : {}),
          channel,
          ...(res.fanout !== undefined ? { fanout: res.fanout } : {}),
          ...(res.results !== undefined ? { results: res.results } : {}),
          ...(wakeDowngraded !== undefined ? { wakeDowngraded } : {}),
          ...trunc,
        };
      }
      const provablyNone = res.code !== undefined && BROADCAST_NONE_CODES.has(res.code);
      let status: XsBroadcastOutcome["status"];
      switch (res.code) {
        case "E_XS_OFF":
          status = "off";
          break;
        case "E_XS_BAD_FRAME":
          status = "bad_frame";
          break;
        case "E_XS_STALE_ORIGIN":
          status = "stale_origin";
          break;
        case "E_XS_TOO_LARGE":
          status = "too_large";
          break;
        case "E_XS_FANOUT_TOO_LARGE":
          status = "fanout_too_large";
          break;
        case "E_XS_BAD_TARGET":
        case "E_XS_NO_TARGET":
          status = res.reason === "default" ? "default_channel" : "bad_channel";
          break;
        default:
          status = "error";
      }
      return {
        status,
        effect: provablyNone ? "none" : "unknown",
        ...(res.reason !== undefined || !provablyNone ? { reason: res.reason ?? "unverified" } : {}),
        ...(res.code !== undefined ? { code: res.code } : {}),
        channel,
        ...trunc,
      };
    },

    async channels(args) {
      const view = deps.channels;
      const hubCap = deps.port.hubChannelCap?.() === true;
      if (view === undefined || !hubCap || deps.port.channels === undefined) {
        return { status: "channel_unsupported", reason: "channel_unsupported" };
      }
      if (!view.linkJoined(true)) return { status: "not_joined", reason: "not_joined" };
      const snapshot = deps.origin.current();
      if (!snapshot || args?.signal?.aborted) return { status: "origin_changed", reason: "origin_changed" };
      let reply: XsPortReply;
      try {
        reply = await deps.port.channels({ origin: snapshot });
      } catch {
        return { status: "error", reason: "link_lost" };
      }
      // M8: never return a listing computed for another origin.
      if (!guardOk(snapshot, args?.signal)) return { status: "origin_changed", reason: "origin_changed" };
      if (reply.kind === "off") return { status: "off" };
      if (reply.kind !== "res") {
        return { status: "error", reason: reply.kind === "deadline" ? "client_deadline" : "link_lost" };
      }
      if (!reply.res.ok) {
        return reply.res.code !== undefined ? { status: "error", code: reply.res.code } : { status: "error" };
      }
      return { status: "ok", channels: reply.res.channels ?? [] };
    },
  };
}

/** Re-export the byte cap constant so tests/X2 can assert against the same number XS0 froze. */
export { XS_MAX_FRAME_BYTES };
