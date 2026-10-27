/**
 * fabric phase-2 X1 (phase2-plan §8.3): the hub cross-session relay router.
 *
 * Dispatched by `agent-server.ts` BEFORE the registry (an `xs_req` never enters the bus, the
 * registry's `onFrame` or the per-frame logging); everything reaches the agent through `reply`.
 *
 *   info     → the hub's frozen-at-start global limits
 *   list     → effective ∧ joined ∧ receive≠off members, not self, optional cwd filter, ≤20 rows
 *   resolve  → sessionId exact → prefix(≥8) → name exact → name case-insensitive; ambiguity ⇒ ≤5
 *              candidates; nothing ⇒ E_XS_NO_TARGET (indistinguishable from "not joined", XI5)
 *   send     → ① origin bind (socket's effective member ∧ joined ∧ sessionId/epoch equal) ② the
 *              target resolves to exactly one effective joined member (two holders of one
 *              sessionId ⇒ E_XS_AMBIGUOUS) ③ `receive:"off"` early reject ④ limits reserve ⑤ stamp
 *              `from`/`xid`/`expiresAt`/`to.epoch` — from the HUB's records only, never the frame ⑥
 *              `registry.request(xs_deliver)` ⑦ settle on `xs_ack` or the hub deadline
 *
 * Channel-plan §4.1 (CH1): every list/resolve/send/broadcast is SAME-CHANNEL enforced — a peer is
 * visible iff it shares ≥1 channel with the requester (a not-joined requester sees nobody). The
 * unique-holder judgement (XR5) runs on the FULL effective-joined table before visibility is
 * applied (M3): a sessionId with two holders anywhere is ambiguous even if only one is visible;
 * the candidates expose only the visible holder. Channel fields (`rows/candidates[].channels`,
 * `xs_deliver.via`) follow the §3.2 write rules: never written for a shared set of exactly
 * `[default]` or towards a peer without `xs.channel.v1` — default-only traffic is byte-identical to
 * v0.7.1 (`tests/web-hub/hub/xs-router-v071-diff.test.ts`). `channels` lists the hub's channels
 * (names + session counts, Q7); `broadcast` lives in `./broadcast.ts`.
 *
 * Alias-plan r4 (AL2, §3.6/§5/§6): when the hub was handed a LOADED alias binding table
 * (`deps.aliases`, built only when `HubConfig.crossSession.alias` exists — key absence IS off) and the
 * table loaded `ready` (`advertised`, fixed for the run), a requester declaring `xs.alias.v1` is
 * `aliasUsable`: its resolve gets an alias tier after the sid prefix tier (hit ⇒ that tier only, an
 * unreachable alias is NO_TARGET — NQ2), its list rows/candidates/targets carry `alias`, rows with an
 * alias sort first (Q11), the target always carries the full `sessionId`, and its plain send is
 * EXACT-only on that full sessionId (§R3 M1 — no prefix/alias/name fallback, every miss is
 * NO_TARGET). A `degraded` table (not advertised) only guards alias-capable requesters: an
 * alias-shaped name ⇒ `E_XS_ALIAS_UNAVAILABLE`, never the name tiers. `xs_deliver.from.alias` is
 * stamped per RECIPIENT (`aliasUsable(recipient)`). A requester without the cap gets the exact
 * pre-alias behaviour and bytes in every table state (NQ3, `xs-router-v071-diff.test.ts`).
 *
 * r3 M2 (hub side): once ⑥ was issued, NO outcome may be reported as `none` unless the receiver
 * itself said so — deadline / disconnect / hub teardown / ack mismatch / handler exception are all
 * `unknown`. Provable `none` only comes from steps ①–④ (before anything left the hub) or from the
 * receiver's own ack.
 *
 * Logs/audit never carry the body (XI6): refusals/exceptions log `{code, op, textLen}` only;
 * `reason`/`wakeDowngraded` echoed from a peer's ack are token-shape filtered before they are
 * forwarded or logged. pi-free; the only timers are `registry.request`'s (unref'd).
 */
import { randomBytes } from "node:crypto";
import type { AgentFrame, HubFrame } from "../../protocol/messages.js";
import {
  XS_EXPIRES_MS,
  XS_HUB_DELIVER_MS,
  XS_LIST_MAX_ROWS,
  XS_RESOLVE_MAX_CANDIDATES,
  XS_RESOLVE_PREFIX_MIN,
  XS_REPLY_REQUEST_ID_RE,
  XS_ALIAS_TAKE_PREVIEW,
  xsFrameBytesOk,
  type XsAckFrame,
  type XsDeliverFrame,
  XS_CHANNEL_RESULT_MAX_ROWS,
  type XsChannelInfoWire,
  type XsReqFrame,
  type XsResFrame,
  type XsResolveCandidateWire,
  type XsSessionRowWire,
  type XsWakeDowngraded,
} from "../../protocol/xs.js";
import { XS_ALIAS_TAKE_TOKEN_RE } from "../../protocol/xs-alias.js";
import { auditXs, type XsAuditRecord } from "../audit.js";
import type { HubLog } from "../ports.js";
import type { Registry } from "../registry.js";
import {
  createXsAliasStore,
  isAliasShaped,
  xsAliasFailureWire,
  XS_ALIAS_DEFAULT_PARAMS,
  type XsAliasFs,
  type XsAliasHubParams,
  type XsAliasRequester,
  type XsAliasStore,
  type XsAliasTimer,
  type XsAliasWriteFailure,
  type XsAliasWriteResult,
} from "./aliases.js";
import { runXsBroadcast } from "./broadcast.js";
import { emitQuiet, quietVerdict, type XsQuietObserver } from "./mirror.js";
import {
  createXsLimits,
  hubChannelsParams,
  type XsLimits,
  type HubCrossSessionConfig,
  type HubXsChannelsConfig,
} from "./limits.js";
import {
  abbreviateHome,
  createXsMembers,
  hubChannelSet,
  hubIntersect,
  hubNormalizeChannel,
  hubSharedField,
  XS_HUB_DEFAULT_CHANNEL,
  XS_NAME_MAX,
  XS_REF_LEN,
  xsToken,
  type XsEffectiveMember,
  type XsMembers,
  type XsRegistryObserver,
} from "./members.js";

const REF_LEN = XS_REF_LEN;
const NAME_MAX = XS_NAME_MAX;
const RESERVED_EXACT = new Set(["root", "system", "main"]);
const RESERVED_PREFIXES = ["r_", "@", "wf_"] as const;

export interface XsRouter {
  /** Never throws. `reply` is called at most once per request (and may be called after an await). */
  handle(agentKey: string, frame: XsReqFrame, reply: (res: XsResFrame) => void): void;
  /** An oversize (>16 KiB) xs_req the decoder refused: answer `E_XS_TOO_LARGE` iff `rid` is sane. */
  rejectTooLarge(agentKey: string, raw: unknown, reply: (res: XsResFrame) => void): void;
  /** `xs_late_ack` counter (acks that arrived after the hub already settled/timed out). */
  lateAcks(): number;
  onLateAck(agentKey: string): void;
  /** Abort in-flight deliveries (they settle as unknown) and ignore further requests. */
  dispose(): void;
}

export interface XsRouterDeps {
  registry: Registry;
  members: XsMembers;
  limits: XsLimits;
  log: HubLog;
  now: () => number;
  /** For the `~` cwd label. */
  home: string;
  hubSendsPerMin: number;
  replyEnabled?: boolean;
  /** Channel-plan §3.1: hub-global broadcast params; absent ⇒ defaults (never "off"). */
  channels?: HubXsChannelsConfig;
  /** Alias-plan §3.6 (AL2): the LOADED binding table; absent ⇒ alias off (pre-alias bytes for
   *  everyone, no guard — ≡ an old hub). */
  aliases?: XsAliasStore;
  /** feishu-xs-mirror P2: advisory observer of quiet (not-woken) deliveries; called on a microtask
   *  AFTER the sender's reply + audit + limits settle. Absent ⇒ behaviour/bytes unchanged. */
  onQuietDelivered?: XsQuietObserver;
}

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** cwd relation for `scope:"cwd"`: equal or ancestor/descendant on a path boundary. */
function cwdRelated(a: string, b: string): boolean {
  const x = trimSlash(a);
  const y = trimSlash(b);
  if (x === y) return true;
  const xs = x === "/" ? "/" : `${x}/`;
  const ys = y === "/" ? "/" : `${y}/`;
  return y.startsWith(xs) || x.startsWith(ys);
}

/** `channelSet` order (default first, then code-unit order). */
function cmpChannel(a: string, b: string): number {
  if (a === b) return 0;
  if (a === XS_HUB_DEFAULT_CHANNEL) return -1;
  if (b === XS_HUB_DEFAULT_CHANNEL) return 1;
  return a < b ? -1 : 1;
}

function reservedAddress(to: string): boolean {
  const t = to.trim();
  if (t.length === 0 || t.length > 128) return true;
  if (RESERVED_EXACT.has(t)) return true;
  return RESERVED_PREFIXES.some((p) => t.startsWith(p));
}

/** Audit `reason` / dispatch key of an `op:"alias"` request (alias-force-default adds the last three). */
type AliasSub = "get" | "set" | "clear" | "preview" | "take" | "auto" | "force-preview" | "handoff";

type Resolved =
  | { kind: "one"; member: XsEffectiveMember }
  | { kind: "unavailable" }
  | { kind: "many"; candidates: XsResolveCandidateWire[] }
  | { kind: "dup"; candidates: XsResolveCandidateWire[] }
  | { kind: "none" }
  | { kind: "bad" };

export function createXsRouter(deps: XsRouterDeps): XsRouter {
  const { registry, members, limits, log, now } = deps;
  const ac = new AbortController();
  let closed = false;
  let lateAckCount = 0;

  const refOf = (sessionId: string): string => sessionId.slice(0, REF_LEN);
  const aliasStore = deps.aliases;
  /** §3.6: `aliasUsable(m) = aliasAdvertised ∧ m.aliasCapable` (ready/wedged/disabled alike). */
  const aliasUsable = (m: XsEffectiveMember): boolean =>
    aliasStore !== undefined && aliasStore.advertised && m.aliasCapable;
  /** Alias-force-default (#72): `aliasUsable ∧ caps ∋ xs.alias.v2` — the only requesters that may send `intent` and be
   *  written the v2 reply keys (`origin`, `lost.forced`, preview `online`/`auto`). */
  const aliasV2Usable = (m: XsEffectiveMember): boolean => aliasUsable(m) && m.aliasV2Capable;
  /** §5.1 degraded guard: a table exists but is not trusted (never advertised) ∧ the requester is
   *  alias-capable. A hub without a table (key absent) never guards. */
  const aliasGuarded = (m: XsEffectiveMember): boolean =>
    aliasStore !== undefined && !aliasStore.advertised && m.aliasCapable;
  /** `m`'s held alias as shown to `self` (only an `aliasUsable` requester ever sees one). */
  const aliasShownTo = (self: XsEffectiveMember, m: XsEffectiveMember): string | undefined =>
    aliasUsable(self) ? aliasStore!.heldBy(m.sessionId) : undefined;
  const candOf = (m: XsEffectiveMember, alias?: string): XsResolveCandidateWire => ({
    ref: refOf(m.sessionId),
    ...(alias !== undefined ? { alias } : {}),
    ...(m.name !== undefined ? { name: m.name.slice(0, NAME_MAX) } : {}),
  });
  /** §3.2: the shared-channel field towards a REQUESTER (`rows/candidates[].channels`). */
  const sharedFor = (self: XsEffectiveMember, m: XsEffectiveMember): string[] | undefined =>
    hubSharedField(hubIntersect(self.channels, m.channels), self.channelCapable);
  const visibleTo = (self: XsEffectiveMember, m: XsEffectiveMember): boolean =>
    m.channels.some((c) => self.channels.includes(c));

  /**
   * `mode`: `tiers` — the resolve ladder; `exactReply` — a reply-shaped send (full sessionId, with
   * the legacy BAD_FRAME diagnostics); `exactAlias` — an `aliasUsable` plain send (§R3 M1: the same
   * exact tier, every miss is NO_TARGET).
   */
  function resolveTarget(
    query: string,
    self: XsEffectiveMember,
    selfKey: string,
    mode: "tiers" | "exactReply" | "exactAlias" = "tiers",
  ): Resolved {
    const exact = mode !== "tiers";
    const selfSessionId = self.sessionId;
    const q = query.trim();
    if (!exact && reservedAddress(q)) return { kind: "bad" };
    // M3: holders(sid) is judged on EVERY effective joined member (no channel/receive/cap filter);
    // visibility only shrinks the pool the tiers search in.
    const joinedAll = members.effectiveAll().filter((m) => m.joined);
    const holders = (sid: string): number => joinedAll.reduce((n, m) => (m.sessionId === sid ? n + 1 : n), 0);
    const candFor = (m: XsEffectiveMember): XsResolveCandidateWire => {
      const ch = sharedFor(self, m);
      return { ...candOf(m, aliasShownTo(self, m)), ...(ch === undefined ? {} : { channels: ch }) };
    };
    const pool = joinedAll.filter((m) => m.agentKey !== selfKey && m.sessionId !== selfSessionId && visibleTo(self, m));
    const lower = q.toLowerCase();
    // §5.1: the alias tier ("alias") / the degraded guard ("guard") sit between prefix and name.
    const aliasTier: Array<"alias" | "guard"> = aliasUsable(self) ? ["alias"] : aliasGuarded(self) ? ["guard"] : [];
    const tiers: Array<((m: XsEffectiveMember) => boolean) | "alias" | "guard"> = exact
      ? [(m) => m.sessionId === query]
      : [
          (m) => m.sessionId === q,
          (m) => q.length >= XS_RESOLVE_PREFIX_MIN && m.sessionId.startsWith(q),
          ...aliasTier,
          (m) => m.name !== undefined && m.name === q,
          (m) => m.name !== undefined && m.name.toLowerCase() === lower,
        ];
    for (const tier of tiers) {
      let hits: XsEffectiveMember[];
      if (tier === "guard") {
        if (isAliasShaped(q)) return { kind: "unavailable" }; // no name fallback (§5.1)
        continue;
      } else if (tier === "alias") {
        const hit = aliasStore!.resolveQuery(q);
        if (hit.kind === "miss") continue;
        // A record exists (held or live cooling) ⇒ THIS tier decides (NQ2): only a held alias whose
        // holder is in the visible pool is a hit; everything else is NO_TARGET, never the name tiers.
        if (hit.record.state !== "held") return { kind: "none" };
        const holder = hit.record.sessionId;
        hits = pool.filter((m) => m.sessionId === holder);
        if (hits.length === 0) return { kind: "none" };
      } else {
        hits = pool.filter(tier);
      }
      if (hits.length === 0) continue;
      const bySession = new Map<string, XsEffectiveMember[]>();
      for (const m of hits) {
        const g = bySession.get(m.sessionId);
        if (g === undefined) bySession.set(m.sessionId, [m]);
        else g.push(m);
      }
      if (bySession.size > 1) {
        const firsts = [...bySession.values()].map((g) => g[0]!).sort((a, b) => b.activityAt - a.activityAt);
        return { kind: "many", candidates: firsts.slice(0, XS_RESOLVE_MAX_CANDIDATES).map(candFor) };
      }
      const group = [...bySession.values()][0]!;
      // XR5 + M3: two holders ANYWHERE on the table ⇒ ambiguous; only the visible holder is exposed.
      if (group.length > 1 || holders(group[0]!.sessionId) > 1)
        return { kind: "dup", candidates: [candFor(group[0]!)] };
      return { kind: "one", member: group[0]! };
    }
    // Never route a reply-shaped send through a name/prefix. Diagnostic-only distinction:
    // a departed full id is NO_TARGET; a known alias/ref or invalid id shape is BAD_FRAME.
    if (
      mode === "exactReply" &&
      (query !== q ||
        !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(query) ||
        pool.some(
          (m) =>
            m.name?.toLowerCase() === q.toLowerCase() ||
            (q.length >= XS_RESOLVE_PREFIX_MIN && m.sessionId.startsWith(q)),
        ))
    ) {
      return { kind: "bad" };
    }
    return { kind: "none" };
  }

  /**
   * §3.3/§3.4/§3.5 `op:"alias"` (the requester is origin-bound and `aliasUsable`). Sub-op from the
   * frame: neither `alias` nor `clear` ⇒ get; `clear:true` ⇒ clear; `alias` ⇒ set; `alias` + `take:
   * "preview"` ⇒ take preview; `alias` + `take:<token>` ⇒ take. get and preview count against
   * `listPerMin`; writes are bounded by the store's own queue/budget. Audit lines carry the sub-op
   * and the code only — never the alias text, the token or the cwd label.
   *
   * Alias-force-default (#72, AF2): a requester that declared `xs.alias.v2` may add `intent`:
   * `{alias, intent:"auto"}` ⇒ auto-claim (requires `joined`); `{alias, take:"preview", intent:"force"}` ⇒
   * force preview; `{alias, take:<token>[, intent:"force"]}` ⇒ execute (the token's `mode` decides, a
   * present `intent:"force"` is ignored); `{alias, intent:"handoff", prevSessionId}` ⇒ `/new` handoff (AF7, I10: the store
   * only moves the record when this hub itself saw THIS socket go prevSessionId → the requester's sid; every refusal is
   * `E_XS_ALIAS_TAKE{stale}`, and a success consumes the succession edge). Every other combination — `intent`/`prevSessionId` from
   * a requester without v2, `intent` with `clear`, `prevSessionId` without `handoff`, `intent:"auto"` with
   * `take` — is `E_XS_BAD_FRAME`, before anything reaches the store.
   */
  function handleAlias(
    agentKey: string,
    self: XsEffectiveMember,
    frame: XsReqFrame,
    started: number,
    res: (body: Omit<XsResFrame, "t" | "rid">) => void,
    audit: (record: XsAuditRecord) => void,
  ): void {
    const store = aliasStore!;
    const from = self.sessionId;
    const take = frame.take;
    const v2 = aliasV2Usable(self);
    const intent = frame.intent;
    // Sub-op: `intent` (v2) refines the legacy field-derived choice. `handoff` is the AF7 `/new` handoff.
    const legacySub: "get" | "set" | "clear" | "preview" | "take" =
      take !== undefined
        ? take === XS_ALIAS_TAKE_PREVIEW
          ? "preview"
          : "take"
        : frame.clear !== undefined
          ? "clear"
          : frame.alias !== undefined
            ? "set"
            : "get";
    const sub: AliasSub =
      intent === "auto"
        ? "auto"
        : intent === "handoff"
          ? "handoff"
          : intent === "force" && legacySub === "preview"
            ? "force-preview"
            : legacySub;
    const intentMalformed =
      (intent !== undefined || frame.prevSessionId !== undefined) &&
      (!v2 ||
        frame.clear !== undefined ||
        (frame.prevSessionId !== undefined && intent !== "handoff") ||
        (intent === "handoff" &&
          (frame.alias === undefined || frame.prevSessionId === undefined || take !== undefined)) ||
        (intent === "auto" && (frame.alias === undefined || take !== undefined || !self.joined)) ||
        (intent === "force" && (frame.alias === undefined || take === undefined)));
    const malformed =
      intentMalformed ||
      (frame.clear !== undefined && (frame.clear !== true || frame.alias !== undefined || take !== undefined)) ||
      ((sub === "preview" || sub === "take" || sub === "force-preview") && frame.alias === undefined) ||
      (sub === "take" && !XS_ALIAS_TAKE_TOKEN_RE.test(take!));
    const fail = (code: string, effect: "none" | "unknown"): void => {
      res({ ok: false, code, effect });
      audit({
        op: "alias",
        fromSession: from,
        outcome: effect === "unknown" ? "unknown" : "error",
        reason: sub,
        code,
        ms: now() - started,
      });
    };
    if (malformed) return fail("E_XS_BAD_FRAME", "none");
    const okLine = (): void =>
      audit({ op: "alias", fromSession: from, outcome: "ok", reason: sub, ms: now() - started });
    const failure = (f: XsAliasWriteFailure): void => {
      const w = xsAliasFailureWire(f);
      fail(w.code, w.effect);
    };
    const requester: XsAliasRequester = {
      sessionId: self.sessionId,
      epoch: self.epoch,
      agentKey,
      ...(v2 ? { v2: true } : {}),
    };
    if (sub === "get" || sub === "preview" || sub === "force-preview") {
      if (!limits.admitList(agentKey, self.limits)) return fail("E_XS_RATE_LIMITED", "none");
      if (sub === "get") {
        res({ ok: true, alias: store.get(requester) });
        return okLine();
      }
      const p =
        sub === "force-preview"
          ? store.forcePreview(requester, frame.alias!)
          : store.takePreview(requester, frame.alias!);
      if (!p.ok) return failure(p.failure);
      res({ ok: true, alias: p.res });
      return okLine();
    }
    // cwdLabel: the requester's own `~` label (only ever shown in a later take preview).
    const cwdLabel = abbreviateHome(self.cwd, deps.home);
    const pending: Promise<XsAliasWriteResult> =
      sub === "set"
        ? store.set(requester, frame.alias!, cwdLabel)
        : sub === "auto"
          ? store.autoClaim(requester, frame.alias!, cwdLabel)
          : sub === "handoff"
            ? store.handoff(requester, frame.alias!, frame.prevSessionId!, cwdLabel)
            : sub === "clear"
              ? store.clear(requester)
              : store.take(requester, frame.alias!, take!, cwdLabel);
    pending
      .then((out) => {
        if (!out.ok) return failure(out.failure);
        if (sub === "handoff") members.clearPredecessor(agentKey); // the edge is single-use
        res({ ok: true, alias: out.res });
        okLine();
      })
      .catch(() => {
        // The store never rejects by contract; a write may have been attempted ⇒ unknown.
        res({ ok: false, code: "E_XS_INTERNAL", effect: "unknown" });
        log.warn("xs handler failed", { code: "E_XS_INTERNAL", op: "alias" });
      });
  }

  function dispatch(agentKey: string, frame: XsReqFrame, reply: (res: XsResFrame) => void, started: number): void {
    const textLen = typeof frame.text === "string" ? Buffer.byteLength(frame.text, "utf8") : 0;
    const replyKind = frame.expect !== undefined ? "expect" : frame.replyTo !== undefined ? "reply" : undefined;
    const audit = (record: XsAuditRecord): void => {
      auditXs(log, { ...record, ...(replyKind === undefined ? {} : { reply: replyKind }) });
    };
    const res = (body: Omit<XsResFrame, "t" | "rid">): void => {
      try {
        reply({ t: "xs_res", rid: frame.rid, ...body });
      } catch {
        /* the socket is gone — nothing to tell */
      }
    };
    const refuse = (
      code: string,
      extra: Omit<XsResFrame, "t" | "rid" | "ok" | "code" | "effect"> = {},
      from?: string,
    ): void => {
      res({ ok: false, code, effect: "none", ...extra });
      audit({
        op: frame.op,
        code,
        textLen,
        outcome: "error",
        ...(from === undefined ? {} : { fromSession: from }),
      });
    };

    // ① origin bind (§8.1): the socket's effective member must match the claimed origin.
    const self = members.effective(agentKey);
    if (
      self === undefined ||
      frame.origin.sessionId !== self.sessionId ||
      frame.origin.epoch !== self.epoch ||
      ((frame.op === "send" || frame.op === "broadcast") && !self.joined)
    ) {
      refuse("E_XS_STALE_ORIGIN");
      return;
    }
    // Channel-plan §3.3: the channel ops/field exist only for a channel-capable requester, and
    // `channel` is meaningful only on list (filter) / broadcast (target).
    if (
      ((frame.op === "broadcast" || frame.op === "channels") && !self.channelCapable) ||
      (frame.channel !== undefined && frame.op !== "list" && frame.op !== "broadcast")
    ) {
      refuse("E_XS_BAD_FRAME", {}, self.sessionId);
      return;
    }

    const hasReplyFields = frame.expect !== undefined || frame.replyTo !== undefined;
    const isReply = frame.replyTo !== undefined;
    if (
      hasReplyFields &&
      (frame.op !== "send" ||
        (frame.expect !== undefined && isReply) ||
        (isReply && !XS_REPLY_REQUEST_ID_RE.test(frame.replyTo!)) ||
        (frame.expect !== undefined &&
          (!XS_REPLY_REQUEST_ID_RE.test(frame.expect.requestId) ||
            !Number.isInteger(frame.expect.timeoutMs) ||
            frame.expect.timeoutMs < 60_000 ||
            frame.expect.timeoutMs > 86_400_000)))
    ) {
      refuse("E_XS_BAD_FRAME", {}, self.sessionId);
      return;
    }
    if (hasReplyFields && (deps.replyEnabled === false || !self.replyCapable)) {
      refuse("E_XS_REPLY_UNSUPPORTED", {}, self.sessionId);
      return;
    }
    const targetOf = (m: XsEffectiveMember): NonNullable<XsResFrame["target"]> => ({
      ...candOf(m, aliasShownTo(self, m)),
      // §5.2: an `aliasUsable` requester always gets the full sessionId (it pins the send on it).
      ...((deps.replyEnabled !== false && self.replyCapable && m.replyCapable) || aliasUsable(self)
        ? { sessionId: m.sessionId }
        : {}),
    });

    if (frame.op === "alias") {
      // §3.3/§3.6: the op exists only for an `aliasUsable` requester (a hub without a ready table
      // answers exactly what the pre-alias hub answered for an unknown-shaped send: BAD_FRAME).
      if (!aliasUsable(self)) {
        refuse("E_XS_BAD_FRAME", {}, self.sessionId);
        return;
      }
      handleAlias(agentKey, self, frame, started, res, audit);
      return;
    }

    if (frame.op === "info") {
      res({
        ok: true,
        hubLimits: { hubSendsPerMin: deps.hubSendsPerMin, expiresMs: XS_EXPIRES_MS, deliverMs: XS_HUB_DELIVER_MS },
      });
      audit({ op: "info", fromSession: self.sessionId, outcome: "ok" });
      return;
    }

    if (frame.op === "broadcast") {
      runXsBroadcast(
        {
          registry,
          members,
          limits,
          log,
          now,
          home: deps.home,
          channels: hubChannelsParams(deps.channels),
          signal: ac.signal,
          ...(deps.onQuietDelivered === undefined ? {} : { onQuietDelivered: deps.onQuietDelivered }),
          // §6: `from.alias` per recipient — only towards an `aliasUsable` one.
          ...(aliasStore === undefined
            ? {}
            : {
                fromAliasFor: (m: XsEffectiveMember) =>
                  aliasUsable(m) ? aliasStore.heldBy(self.sessionId) : undefined,
              }),
        },
        { agentKey, self, frame, started, textLen, res, refuse },
      );
      return;
    }

    if (frame.op === "list" || frame.op === "resolve" || frame.op === "channels") {
      // `channel` filter validity is judged BEFORE the budget (a malformed request is free).
      let listChannel: string | undefined;
      if (frame.op === "list" && frame.channel !== undefined) {
        const c = hubNormalizeChannel(frame.channel);
        if (c === null || !self.channels.includes(c)) {
          refuse("E_XS_BAD_TARGET", { reason: "channel" }, self.sessionId);
          return;
        }
        listChannel = c;
      }
      if (!limits.admitList(agentKey, self.limits)) {
        refuse("E_XS_RATE_LIMITED", {}, self.sessionId);
        return;
      }
      if (frame.op === "channels") {
        // Q7: every effective joined member's channel names + logical-session counts.
        const sessionsBy = new Map<string, Set<string>>();
        for (const m of members.effectiveAll()) {
          if (!m.joined) continue;
          for (const c of m.channels) {
            let set = sessionsBy.get(c);
            if (set === undefined) sessionsBy.set(c, (set = new Set()));
            set.add(m.sessionId);
          }
        }
        const channels: XsChannelInfoWire[] = hubChannelSet(sessionsBy.keys())
          .map((name) => ({ name, members: sessionsBy.get(name)!.size, joined: self.channels.includes(name) }))
          .sort((a, b) => Number(b.joined) - Number(a.joined) || b.members - a.members || cmpChannel(a.name, b.name))
          .slice(0, XS_CHANNEL_RESULT_MAX_ROWS);
        res({ ok: true, channels });
        audit({ op: "channels", fromSession: self.sessionId, outcome: "ok", ms: now() - started });
        return;
      }
      if (frame.op === "list") {
        const rawQ = (frame.query ?? "").trim();
        const q = rawQ.toLowerCase();
        const withAlias = aliasUsable(self);
        // §5.3: alias prefix match on the NFKC + ASCII-lower-cased query (the canonical form's rules).
        const aq = withAlias ? rawQ.normalize("NFKC").replace(/[A-Z]/g, (c) => c.toLowerCase()) : "";
        const aliasRow = (m: XsEffectiveMember): string | undefined =>
          withAlias ? aliasStore!.heldBy(m.sessionId) : undefined;
        const rows: XsSessionRowWire[] = members
          .effectiveAll()
          .filter(
            (m) =>
              m.joined &&
              m.receive !== "off" &&
              m.receive !== "replies" &&
              m.agentKey !== agentKey &&
              m.sessionId !== self.sessionId &&
              visibleTo(self, m) &&
              (listChannel === undefined || m.channels.includes(listChannel)),
          )
          .filter((m) => frame.scope !== "cwd" || cwdRelated(self.cwd, m.cwd))
          .map((m) => ({ m, alias: aliasRow(m) }))
          .filter(
            ({ m, alias }) =>
              q === "" ||
              (m.name !== undefined && m.name.toLowerCase().startsWith(q)) ||
              (q.length >= XS_RESOLVE_PREFIX_MIN && m.sessionId.toLowerCase().startsWith(q)) ||
              (alias !== undefined && aq !== "" && alias.startsWith(aq)),
          )
          // Q11: an aliasUsable requester sees rows with an alias first (each group by activity).
          .sort(
            (a, b) =>
              (withAlias ? Number(b.alias !== undefined) - Number(a.alias !== undefined) : 0) ||
              b.m.activityAt - a.m.activityAt,
          )
          .slice(0, XS_LIST_MAX_ROWS)
          .map(({ m, alias }) => ({
            ref: refOf(m.sessionId),
            ...(alias !== undefined ? { alias } : {}),
            ...(m.name !== undefined ? { name: m.name.slice(0, NAME_MAX) } : {}),
            cwdLabel: abbreviateHome(m.cwd, deps.home).slice(0, NAME_MAX),
            kind: m.kind,
            receive: m.receive === "wake" ? ("wake" as const) : ("deliver" as const),
            busy: m.busy,
            lastActiveAgoS: Math.max(0, Math.floor((now() - m.activityAt) / 1000)),
            ...((ch) => (ch === undefined ? {} : { channels: ch }))(sharedFor(self, m)),
          }));
        res({ ok: true, rows });
        audit({ op: "list", fromSession: self.sessionId, outcome: "ok", ms: now() - started });
        return;
      }
      const r = resolveTarget(frame.query ?? frame.to ?? "", self, agentKey);
      switch (r.kind) {
        case "bad":
          refuse("E_XS_BAD_TARGET", {}, self.sessionId);
          return;
        case "unavailable":
          refuse("E_XS_ALIAS_UNAVAILABLE", {}, self.sessionId);
          return;
        case "none":
          refuse("E_XS_NO_TARGET", {}, self.sessionId);
          return;
        case "dup":
          refuse("E_XS_AMBIGUOUS", { candidates: r.candidates }, self.sessionId);
          return;
        case "many":
          res({ ok: true, candidates: r.candidates });
          audit({ op: "resolve", fromSession: self.sessionId, outcome: "ok", reason: "ambiguous" });
          return;
        case "one":
          res({ ok: true, target: targetOf(r.member) });
          audit({
            op: "resolve",
            fromSession: self.sessionId,
            toSession: r.member.sessionId,
            outcome: "ok",
          });
          return;
      }
    }

    // ---- send ----
    if (typeof frame.to !== "string" || frame.to.trim() === "" || typeof frame.text !== "string" || frame.text === "") {
      refuse("E_XS_BAD_FRAME", {}, self.sessionId);
      return;
    }
    // ② exactly one effective joined holder of the target sessionId
    // §R3 M1: an aliasUsable plain send is exact-only on the full sessionId resolve returned.
    const r = resolveTarget(
      frame.to,
      self,
      agentKey,
      hasReplyFields ? "exactReply" : aliasUsable(self) ? "exactAlias" : "tiers",
    );
    if (r.kind === "bad") return refuse(hasReplyFields ? "E_XS_BAD_FRAME" : "E_XS_BAD_TARGET", {}, self.sessionId);
    if (r.kind === "none") return refuse("E_XS_NO_TARGET", {}, self.sessionId);
    if (r.kind === "unavailable") return refuse("E_XS_ALIAS_UNAVAILABLE", {}, self.sessionId);
    if (r.kind === "dup" || r.kind === "many") {
      return refuse("E_XS_AMBIGUOUS", { candidates: r.candidates }, self.sessionId);
    }
    const target = r.member;
    const targetWire = targetOf(target);
    if (hasReplyFields && !target.replyCapable) {
      refuse("E_XS_REPLY_UNSUPPORTED", { target: targetWire }, self.sessionId);
      return;
    }
    // ③ receiver `off` early reject (an optimisation — the receiver re-judges everything)
    if (target.receive === "off" || (target.receive === "replies" && !isReply)) {
      res({ ok: true, effect: "none", reason: "rejected", target: targetWire });
      audit({
        op: "send",
        fromSession: self.sessionId,
        toSession: target.sessionId,
        textLen,
        wake: frame.wake === true,
        outcome: "none",
        reason: "rejected",
      });
      return;
    }
    // The stamped frame must itself fit the 16 KiB xs cap or the receiver's decoder would drop it
    // silently (no ack ⇒ a 5 s unknown) — refuse up front, before any reservation.
    const xid = `x${randomBytes(9).toString("hex")}`;
    const fromName = self.name?.slice(0, NAME_MAX);
    const via = hubSharedField(hubIntersect(self.channels, target.channels), target.channelCapable);
    // §6: the sender's hub-verified alias, stamped only towards an aliasUsable recipient.
    const fromAlias = aliasUsable(target) ? aliasStore!.heldBy(self.sessionId) : undefined;
    const build = (wake: boolean, rid: string): XsDeliverFrame => ({
      t: "xs_deliver",
      rid,
      xid,
      to: { sessionId: target.sessionId, epoch: target.epoch },
      from: {
        sessionId: self.sessionId,
        ref: refOf(self.sessionId),
        ...(fromName !== undefined ? { name: fromName } : {}),
        cwdLabel: abbreviateHome(self.cwd, deps.home).slice(0, NAME_MAX),
        agentId: agentKey.slice(0, 128),
        ...(fromAlias !== undefined ? { alias: fromAlias } : {}),
      },
      text: frame.text!,
      wake: isReply ? false : wake,
      ...(!isReply && frame.level !== undefined ? { level: frame.level } : {}),
      ...(frame.expect !== undefined
        ? { reply: { requestId: frame.expect.requestId, dueAt: now() + frame.expect.timeoutMs } }
        : {}),
      ...(isReply ? { inReplyTo: frame.replyTo! } : {}),
      expiresAt: now() + XS_EXPIRES_MS,
      ...(via === undefined ? {} : { via }),
    });
    // §3.2: `via` = the shared set, written only towards a channel-capable target and never for [default].
    const worst = build(true, "r".repeat(16));
    if (worst.reply !== undefined) worst.reply.dueAt = Number.MAX_SAFE_INTEGER;
    if (!xsFrameBytesOk(worst)) {
      refuse("E_XS_TOO_LARGE", { target: targetWire }, self.sessionId);
      return;
    }
    // ④ reserve
    const admit = limits.admitSend({
      agentKey,
      pairKey: `${self.sessionId}>${target.sessionId}`,
      limits: self.limits,
      wantWake: !isReply && frame.wake === true,
      ...(isReply ? { isReply: true } : {}),
    });
    if (!admit.ok) {
      res({ ok: true, effect: "none", reason: admit.reason, target: targetWire });
      audit({
        op: "send",
        fromSession: self.sessionId,
        toSession: target.sessionId,
        textLen,
        wake: frame.wake === true,
        outcome: "none",
        reason: admit.reason,
      });
      return;
    }
    // ⑤⑥ stamp + deliver (from here on NOTHING is `none` unless the receiver says so — r3 M2)
    const ticket = admit.ticket;
    const deliver = build(admit.wake, "pending");
    const settleOut = (
      effect: "applied" | "none" | "unknown",
      reason: string | undefined,
      wakeDowngraded: string | undefined,
    ): void => {
      res({
        ok: true,
        effect,
        ...(reason !== undefined ? { reason } : {}),
        ...(wakeDowngraded !== undefined ? { wakeDowngraded: wakeDowngraded as XsWakeDowngraded } : {}),
        target: targetWire,
      });
      audit({
        op: "send",
        xid,
        fromSession: self.sessionId,
        toSession: target.sessionId,
        textLen,
        wake: deliver.wake,
        outcome: effect,
        ...(reason !== undefined ? { reason } : {}),
        ms: now() - started,
      });
    };
    let pendingAck: Promise<XsAckFrame & AgentFrame>;
    try {
      pendingAck = registry.request<XsAckFrame & AgentFrame>(
        target.agentKey,
        deliver as HubFrame & { rid: string },
        XS_HUB_DELIVER_MS,
        ac.signal,
      );
    } catch (err) {
      limits.settle(ticket, { acked: false }); // never leak an in-flight slot; handle() answers unknown
      throw err;
    }
    pendingAck
      .then(
        (ack) => {
          if (ack.xid !== xid) {
            limits.settle(ticket, { acked: false });
            settleOut("unknown", "ack_mismatch", admit.wakeDowngraded);
            return;
          }
          limits.settle(ticket, { acked: true, woke: ack.woke, effect: ack.effect });
          const wakeDowngraded = xsToken(ack.wakeDowngraded) ?? admit.wakeDowngraded;
          settleOut(
            ack.effect,
            xsToken(ack.reason) ?? (ack.reason === undefined ? undefined : "unverified"),
            wakeDowngraded,
          );
          // feishu-xs-mirror P2: strictly after settleOut (res + audit); microtask-deferred.
          if (deps.onQuietDelivered !== undefined) {
            const v = quietVerdict(ack);
            if (v !== undefined) {
              emitQuiet(
                deps.onQuietDelivered,
                [
                  {
                    sessionId: target.sessionId,
                    agentKey: target.agentKey,
                    xid,
                    kind: isReply ? "reply" : "message",
                    from: {
                      ref: deliver.from.ref,
                      ...(deliver.from.name !== undefined ? { name: deliver.from.name } : {}),
                      ...(deliver.from.alias !== undefined ? { alias: deliver.from.alias } : {}),
                    },
                    ...(v.late ? { late: true as const } : {}),
                    ...(v.queued ? { queued: true as const } : {}),
                    ...(wakeDowngraded !== undefined ? { wakeDowngraded } : {}),
                    text: frame.text!,
                  },
                ],
                log,
              );
            }
          }
        },
        (err: unknown) => {
          limits.settle(ticket, { acked: false });
          const code = (err as { code?: unknown } | null)?.code;
          settleOut("unknown", code === "E_DEADLINE" ? "deliver_deadline" : "link_lost", admit.wakeDowngraded);
        },
      )
      .catch(() => {
        // settleOut/auditing itself failed: still answer, with the only honest verdict.
        res({ ok: false, code: "E_XS_INTERNAL", effect: "unknown" });
        log.warn("xs handler failed", { code: "E_XS_INTERNAL", op: "send", textLen });
      });
  }

  return {
    handle(agentKey, frame, reply) {
      if (closed) return;
      const started = now();
      try {
        dispatch(agentKey, frame, reply, started);
      } catch {
        // Exception text may embed anything — log only the code, op and body length.
        const textLen = typeof frame.text === "string" ? Buffer.byteLength(frame.text, "utf8") : 0;
        log.warn("xs handler failed", { code: "E_XS_INTERNAL", op: frame.op, textLen });
        try {
          reply({ t: "xs_res", rid: frame.rid, ok: false, code: "E_XS_INTERNAL", effect: "unknown" });
        } catch {
          /* socket gone */
        }
      }
    },

    rejectTooLarge(_agentKey, raw, reply) {
      if (closed) return;
      const rid = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>)["rid"] : undefined;
      if (typeof rid !== "string" || rid.length < 1 || rid.length > 64) return;
      log.warn("xs frame too large", { code: "E_XS_TOO_LARGE" });
      try {
        reply({ t: "xs_res", rid, ok: false, code: "E_XS_TOO_LARGE", effect: "none" });
      } catch {
        /* socket gone */
      }
    },

    lateAcks: () => lateAckCount,
    onLateAck() {
      lateAckCount++;
    },

    dispose() {
      if (closed) return;
      closed = true;
      ac.abort();
    },
  };
}

// ----------------------------------------------------------------- alias assembly (alias-plan §3.6, AL2)

/** `HubConfig.crossSession` as the hub reads it: the agent nests `alias` (AL3) — `limits.ts`'s
 *  normalizer drops unknown keys, so `hub/main.ts` re-validates and merges it back. */
export type HubCrossSessionConfigWithAlias = HubCrossSessionConfig & { alias?: XsAliasHubParams };

/** Acceptance bounds of `crossSession.alias` (mirror of `config/settings.ts` FABRIC_XS_ALIAS_*). */
export const XS_HUB_ALIAS_BOUNDS = {
  offlineLeaseH: { min: 1, max: 720 },
  coolMin: { min: 1, max: 1_440 },
  takeMinOfflineMin: { min: 10, max: 1_440 }, // floor = NQ1
} as const;

/**
 * `crossSession.alias` re-validation (key-absent convention, AL2 deviation from §3.6's wording):
 * `undefined` ⇒ alias OFF (no table, no file IO, no cap — the hub stays byte-identical); a
 * non-object or any present leaf that is not an integer within `XS_HUB_ALIAS_BOUNDS` ⇒ `undefined`
 * too (the caller drops the key and logs — fails closed to old-hub behaviour); missing leaves take
 * the defaults (168 / 10 / 10). Never throws.
 */
export function normalizeHubXsAliasConfig(raw: unknown): XsAliasHubParams | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: XsAliasHubParams = { ...XS_ALIAS_DEFAULT_PARAMS };
  for (const key of ["offlineLeaseH", "coolMin", "takeMinOfflineMin"] as const) {
    const v = r[key];
    if (v === undefined) continue;
    const { min, max } = XS_HUB_ALIAS_BOUNDS[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return undefined;
    out[key] = v;
  }
  return out;
}

/** `hub/main.ts`'s merge step: `normalized` is `normalizeHubCrossSessionConfig(raw)` (which drops
 *  `alias`); the alias sub-key is re-validated from `raw` and merged back. Raw alias absent ⇒
 *  `merged === normalized` (same object — byte-identical config); malformed ⇒ dropped alone. */
export function mergeHubXsAliasConfig(
  raw: unknown,
  normalized: HubCrossSessionConfig,
): { merged: HubCrossSessionConfigWithAlias; aliasDropped: boolean } {
  const rawAlias =
    raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as { alias?: unknown }).alias : undefined;
  if (rawAlias === undefined) return { merged: normalized, aliasDropped: false };
  const alias = normalizeHubXsAliasConfig(rawAlias);
  return alias === undefined
    ? { merged: normalized, aliasDropped: true }
    : { merged: { ...normalized, alias }, aliasDropped: false };
}

/** The validated alias params carried by a (possibly un-normalized) `crossSession`, else undefined. */
export function hubXsAliasParamsOf(crossSession: HubCrossSessionConfig | undefined): XsAliasHubParams | undefined {
  if (crossSession === undefined) return undefined;
  return normalizeHubXsAliasConfig((crossSession as { alias?: unknown }).alias);
}

/** The binding table + its late-bound presence/liveness ports (members are built by the relay). */
export interface XsAliasBinding {
  readonly store: XsAliasStore;
  /** Called once by {@link createXsRelay}. Before it, nobody is online and no requester is live. `registry` (alias-force-default,
   *  #72) feeds `isLinked` and the `xs_alias_evt` push; absent ⇒ nobody is `linked` and nothing is pushed. */
  attach(members: XsMembers, registry?: Pick<Registry, "list" | "xsView" | "send">): void;
}

/** Built by `hub.ts` BEFORE the cap array (load must decide `xs.alias.v1`), and loaded there. */
export function createXsAliasBinding(deps: {
  stateDir: string;
  params: XsAliasHubParams;
  log?: { warn(msg: string, data?: object): void };
  now?: () => number;
  fs?: XsAliasFs;
  timer?: XsAliasTimer;
  randomHex?: (bytes: number) => string;
}): XsAliasBinding {
  let members: XsMembers | undefined;
  let registry: Pick<Registry, "list" | "xsView" | "send"> | undefined;
  const store = createXsAliasStore({
    stateDir: deps.stateDir,
    params: deps.params,
    isOnline: (sid) => members?.effectiveAll().some((m) => m.sessionId === sid) ?? false,
    isRequesterLive: (r) => {
      if (members === undefined || r.agentKey === undefined) return false;
      const e = members.effective(r.agentKey);
      return e !== undefined && e.sessionId === r.sessionId && e.epoch === r.epoch && e.aliasCapable;
    },
    // §2 `linked`: a live-ish registry record carrying this sessionId that is NOT an effective xs member
    // (the store only asks after `isOnline` said no). Read-only, bounded by the registry size.
    isLinked: (sid) => {
      if (registry === undefined) return false;
      for (const v of registry.list()) {
        const x = registry.xsView(v.agentKey);
        if (x !== undefined && x.connected && x.phase !== "stale" && x.sessionId === sid) return true;
      }
      return false;
    },
    // I10 (AF7): the succession edge the member table recorded for THIS requester's socket — never the frame's word.
    isSuccessor: (r, prev) => {
      if (members === undefined || r.agentKey === undefined) return false;
      const e = members.predecessorOf(r.agentKey);
      return e !== undefined && e.from === prev && members.sessionOf(r.agentKey) === r.sessionId;
    },
    allMembersV2: (sid) => members?.effectiveAll().every((m) => m.sessionId !== sid || m.aliasV2Capable) ?? false,
    // I9: after a force committed, nudge every v2 effective member of the holder session. Best effort — a failed
    // `send` is not rolled back (the tombstone is the safety net, R23).
    onForcedCommit: (e) => {
      if (members === undefined || registry === undefined) return;
      for (const m of members.effectiveAll()) {
        if (m.sessionId !== e.holderSessionId || !m.aliasV2Capable) continue;
        registry.send(m.agentKey, { t: "xs_alias_evt", sessionId: e.holderSessionId, at: e.at });
      }
    },
    ...(deps.log === undefined ? {} : { log: deps.log }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.fs === undefined ? {} : { fs: deps.fs }),
    ...(deps.timer === undefined ? {} : { timer: deps.timer }),
    ...(deps.randomHex === undefined ? {} : { randomHex: deps.randomHex }),
  });
  return {
    store,
    attach(m, r) {
      members = m;
      registry = r;
    },
  };
}

/** §3.1: the presence feed — after the member table applied an event, re-evaluate every sid it may
 *  have taken on/offline (`touchPresence` never writes; it only stamps `offlineSince`). */
function withPresenceFeed(members: XsMembers, store: XsAliasStore): XsRegistryObserver {
  const base = members.observer;
  const touch = (sid: string | undefined): void => {
    if (sid === undefined) return;
    try {
      store.touchPresence(sid);
    } catch {
      /* presence is a hint; reads re-judge it anyway */
    }
  };
  return {
    onMember(agentKey, frame) {
      const prev = members.sessionOf(agentKey);
      base.onMember(agentKey, frame);
      if (prev !== frame.sessionId) touch(prev);
      touch(frame.sessionId);
    },
    onSession(agentKey, sessionId) {
      const prev = members.sessionOf(agentKey);
      base.onSession(agentKey, sessionId);
      touch(prev);
    },
    onInvalidate(agentKey, reason) {
      const prev = members.sessionOf(agentKey);
      base.onInvalidate(agentKey, reason);
      touch(prev);
    },
    onActivity: (agentKey) => base.onActivity(agentKey),
    onLateAck: (agentKey) => base.onLateAck(agentKey),
  };
}

// ----------------------------------------------------------------- assembly (hub.ts only calls this)

export interface XsRelay {
  router: XsRouter;
  members: XsMembers;
  limits: XsLimits;
  /** Alias-plan AL2: the loaded binding table, iff one was handed in. */
  aliases?: XsAliasStore;
  dispose(): void;
}

/** Builds members + limits + router and installs the registry observer. Called by `hub.ts` only
 *  when `config.crossSession` exists (key absence IS off). `aliases` (alias-plan AL2): an already
 *  LOADED binding (`createXsAliasBinding` + `await store.load()`); absent ⇒ alias off. The relay
 *  takes ownership — `dispose()` closes the store. */
export function createXsRelay(deps: {
  registry: Registry;
  config: { home: string; crossSession: HubCrossSessionConfig };
  log: HubLog;
  now: () => number;
  aliases?: XsAliasBinding;
  /** feishu-xs-mirror P2: forwarded to the router (see {@link XsRouterDeps.onQuietDelivered}). */
  onQuietDelivered?: XsQuietObserver;
}): XsRelay {
  const hubSendsPerMin = deps.config.crossSession.limits.hubSendsPerMin;
  let router: XsRouter | undefined;
  const members = createXsMembers({
    now: deps.now,
    view: (key) => deps.registry.xsView(key),
    onLateAck: (key) => router?.onLateAck(key),
  });
  const limits = createXsLimits({ now: deps.now, hubSendsPerMin });
  const aliasStore = deps.aliases?.store;
  deps.aliases?.attach(members, deps.registry);
  router = createXsRouter({
    registry: deps.registry,
    members,
    limits,
    log: deps.log,
    now: deps.now,
    home: deps.config.home,
    hubSendsPerMin,
    replyEnabled: deps.config.crossSession.reply !== false,
    ...(deps.config.crossSession.channels === undefined ? {} : { channels: deps.config.crossSession.channels }),
    ...(aliasStore === undefined ? {} : { aliases: aliasStore }),
    ...(deps.onQuietDelivered === undefined ? {} : { onQuietDelivered: deps.onQuietDelivered }),
  });
  deps.registry.setXsObserver(aliasStore === undefined ? members.observer : withPresenceFeed(members, aliasStore));
  const r = router;
  return {
    router: r,
    members,
    limits,
    ...(aliasStore === undefined ? {} : { aliases: aliasStore }),
    dispose() {
      r.dispose();
      deps.registry.setXsObserver(undefined);
      aliasStore?.close();
    },
  };
}
