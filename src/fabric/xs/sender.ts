import { XS_MAX_FRAME_BYTES, xsFrameBytesOk } from "../../web-hub/protocol/xs.js";
import type {
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
}

/** X3's whole view of the hub connection. X2's adapter builds the `xs_req` frame (adding `t`,
 *  `rid`, `origin` as given) and settles it into one `XsPortReply`; X3 owns every effect
 *  decision, so the mapping below is the single seam tests pin. */
export interface XsHubPort {
  list(args: XsPortListArgs): Promise<XsPortReply>;
  resolve(args: XsPortResolveArgs): Promise<XsPortReply>;
  send(args: XsPortSendArgs): Promise<XsPortReply>;
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
  status: "ok" | "origin_changed" | "off" | "error";
  rows?: XsSessionRowWire[];
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
  });
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

/**
 * §4.3/#12: detect another source already registering a same-named tool at `session_start`.
 * `existing === undefined` (e.g. `pi.getAllTools()` unreadable) counts as NO conflict — the
 * caller warns once and surfaces `tool collision: <name>` in `/fabric status`; pi's own
 * duplicate-name arbitration is recorded by conformance C-X7, not relied on here.
 */
export function detectXsToolCollisions(existing: readonly string[] | undefined): string[] {
  if (!existing) return [];
  const have = new Set(existing);
  return XS_MAIN_TOOL_NAMES.filter((n) => have.has(n));
}

// ----------------------------------------------------------------- sender

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
}

export interface XsSender {
  list(args: { query?: string; scope?: "hub" | "cwd"; signal?: AbortSignal }): Promise<XsListOutcome>;
  message(args: { to: string; text: string; wake?: boolean; signal?: AbortSignal }): Promise<XsSendOutcome>;
}

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
      const reply = await deps.port.list({
        origin: snapshot,
        ...(query !== undefined ? { query } : {}),
        ...(args.scope !== undefined ? { scope: args.scope } : {}),
      });
      // Read-only: a post-reply identity change does not invalidate the rows — return them.
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
      if (xsTargetFormallyRejected(to)) {
        return { status: "bad_target", effect: "none", reason: "bad_target" };
      }
      const snapshot = deps.origin.current();
      if (!snapshot || !guardOk(snapshot, args.signal)) {
        return { status: "origin_changed", effect: "none", reason: "origin_changed" };
      }

      // ---- resolve round trip (fail fast; consumes no send quota) ----
      const resolveReply = await deps.port.resolve({ origin: snapshot, query: to });
      // r3 M2 + §11.2 X3 anchor: `/new` (or leave, or abort) DURING the resolve round trip ⇒ the
      // send frame is never issued and the verdict is a provable `none`.
      if (!guardOk(snapshot, args.signal)) {
        return { status: "origin_changed", effect: "none", reason: "origin_changed" };
      }
      let resolvedTarget: { ref: string; name?: string } | undefined;
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

      // ---- sender-side pre-checks (§4.5/§6.6/§5.2) — all local, no await ----
      let wake: true | undefined;
      let localDowngrade: XsWakeDowngraded | undefined;
      const wantWake = args.wake === true;
      const wakeUsable = deps.wakeOn === true && deps.level !== undefined;
      if (wantWake) {
        if (!wakeUsable) localDowngrade = "sender_wake_disabled";
        else if (!deps.level!.hopAllowed(deps.level!.levelOfRoot())) localDowngrade = "level_limit";
        else wake = true;
      }
      const level = wakeUsable ? deps.level!.levelOfRoot() : undefined; // §6.6: carried iff sender wake on

      const text = truncate(args.text ?? "", maxChars);
      const truncated = text !== args.text;
      if (!sendFrameBytesOk(snapshot, to, text, wake === true, level)) {
        return { status: "too_large", effect: "none", reason: "too_large", ...(truncated ? { truncated: true } : {}) };
      }

      // ---- exactly one send; no resend path (§3, NQ3) ----
      const sendReply = await deps.port.send({
        origin: snapshot,
        to,
        text,
        ...(wake !== undefined ? { wake } : {}),
        ...(level !== undefined ? { level } : {}),
      });

      // ---- r3 M2 post-send guard: origin changed AFTER the send ----
      const stillCurrent = guardOk(snapshot, args.signal);
      if (!stillCurrent && (sendReply.kind === "deadline" || sendReply.kind === "link_lost")) {
        // No verdict arrived; the message may have taken effect ⇒ unknown, NEVER none.
        return { status: "unanswered", effect: "unknown", reason: "origin_changed_after_send" };
      }
      // Any received verdict (ok or provable rejection) survives the identity change; `off`
      // proves nothing was sent. Map below, then return as-is.

      if (sendReply.kind === "off") return { status: "off", effect: "none", code: "E_XS_OFF" };
      if (sendReply.kind === "deadline") {
        return { status: "unanswered", effect: "unknown", reason: "client_deadline" };
      }
      if (sendReply.kind === "link_lost") {
        return { status: "unanswered", effect: "unknown", reason: "link_lost" };
      }
      const res = sendReply.res;
      const target = res.target ?? resolvedTarget;
      if (res.ok) {
        const effect: XsEffect = res.effect ?? "unknown"; // XI11: no evidence field ⇒ unknown
        const wakeDowngraded = res.wakeDowngraded ?? localDowngrade;
        const woke = wantWake && wakeDowngraded === undefined && effect === "applied";
        const reason = resReason(res);
        return {
          status: "sent",
          effect,
          ...(reason !== undefined ? { reason } : {}),
          ...(target !== undefined ? { to: target } : {}),
          ...(wakeDowngraded !== undefined ? { wakeDowngraded } : {}),
          ...(truncated ? { truncated: true } : {}),
          ...(woke ? { woke: true } : {}),
        };
      }
      const status = statusForCode(res.code);
      const provablyNone = res.code !== undefined && PROVABLE_NONE_CODES.has(res.code);
      return {
        status,
        effect: provablyNone ? "none" : "unknown",
        ...(res.code !== undefined ? { code: res.code } : {}),
        ...(res.reason !== undefined || !provablyNone ? { reason: res.reason ?? "unverified" } : {}),
        ...(target !== undefined ? { to: target } : {}),
        ...(status === "ambiguous" && res.candidates ? { candidates: res.candidates } : {}),
        ...(truncated ? { truncated: true } : {}),
      };
    },
  };
}

/** Re-export the byte cap constant so tests/X2 can assert against the same number XS0 froze. */
export { XS_MAX_FRAME_BYTES };
