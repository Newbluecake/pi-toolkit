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
  xsFrameBytesOk,
  type XsAckFrame,
  type XsDeliverFrame,
  type XsReqFrame,
  type XsResFrame,
  type XsResolveCandidateWire,
  type XsSessionRowWire,
  type XsWakeDowngraded,
} from "../../protocol/xs.js";
import { auditXs, type XsAuditRecord } from "../audit.js";
import type { HubLog } from "../ports.js";
import type { Registry } from "../registry.js";
import { createXsLimits, type XsLimits, type HubCrossSessionConfig } from "./limits.js";
import { createXsMembers, type XsEffectiveMember, type XsMembers } from "./members.js";

const REF_LEN = 12;
const NAME_MAX = 120;
/** Strict token shape for anything echoed from a peer (a free-form string could carry text). */
const TOKEN_RE = /^[A-Za-z0-9_:.{}-]{1,64}$/;
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
}

function abbreviateHome(path: string, home: string): string {
  if (home.length === 0) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
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

function reservedAddress(to: string): boolean {
  const t = to.trim();
  if (t.length === 0 || t.length > 128) return true;
  if (RESERVED_EXACT.has(t)) return true;
  return RESERVED_PREFIXES.some((p) => t.startsWith(p));
}

function token(v: unknown): string | undefined {
  return typeof v === "string" && TOKEN_RE.test(v) ? v : undefined;
}

type Resolved =
  | { kind: "one"; member: XsEffectiveMember }
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
  const candOf = (m: XsEffectiveMember): XsResolveCandidateWire => ({
    ref: refOf(m.sessionId),
    ...(m.name !== undefined ? { name: m.name.slice(0, NAME_MAX) } : {}),
  });

  function resolveTarget(query: string, selfKey: string, selfSessionId: string, exact = false): Resolved {
    const q = query.trim();
    if (!exact && reservedAddress(q)) return { kind: "bad" };
    const pool = members
      .effectiveAll()
      .filter((m) => m.joined && m.agentKey !== selfKey && m.sessionId !== selfSessionId);
    const lower = q.toLowerCase();
    const tiers: Array<(m: XsEffectiveMember) => boolean> = exact
      ? [(m) => m.sessionId === query]
      : [
          (m) => m.sessionId === q,
          (m) => q.length >= XS_RESOLVE_PREFIX_MIN && m.sessionId.startsWith(q),
          (m) => m.name !== undefined && m.name === q,
          (m) => m.name !== undefined && m.name.toLowerCase() === lower,
        ];
    for (const tier of tiers) {
      const hits = pool.filter(tier);
      if (hits.length === 0) continue;
      const bySession = new Map<string, XsEffectiveMember[]>();
      for (const m of hits) {
        const g = bySession.get(m.sessionId);
        if (g === undefined) bySession.set(m.sessionId, [m]);
        else g.push(m);
      }
      if (bySession.size > 1) {
        const firsts = [...bySession.values()].map((g) => g[0]!).sort((a, b) => b.activityAt - a.activityAt);
        return { kind: "many", candidates: firsts.slice(0, XS_RESOLVE_MAX_CANDIDATES).map(candOf) };
      }
      const group = [...bySession.values()][0]!;
      if (group.length > 1) return { kind: "dup", candidates: [candOf(group[0]!)] }; // XR5
      return { kind: "one", member: group[0]! };
    }
    // Never route a reply-shaped send through a name/prefix. Diagnostic-only distinction:
    // a departed full id is NO_TARGET; a known alias/ref or invalid id shape is BAD_FRAME.
    if (
      exact &&
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
      (frame.op === "send" && !self.joined)
    ) {
      refuse("E_XS_STALE_ORIGIN");
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
      ...candOf(m),
      ...(deps.replyEnabled !== false && self.replyCapable && m.replyCapable ? { sessionId: m.sessionId } : {}),
    });

    if (frame.op === "info") {
      res({
        ok: true,
        hubLimits: { hubSendsPerMin: deps.hubSendsPerMin, expiresMs: XS_EXPIRES_MS, deliverMs: XS_HUB_DELIVER_MS },
      });
      audit({ op: "info", fromSession: self.sessionId, outcome: "ok" });
      return;
    }

    if (frame.op === "list" || frame.op === "resolve") {
      if (!limits.admitList(agentKey, self.limits)) {
        refuse("E_XS_RATE_LIMITED", {}, self.sessionId);
        return;
      }
      if (frame.op === "list") {
        const q = (frame.query ?? "").trim().toLowerCase();
        const rows: XsSessionRowWire[] = members
          .effectiveAll()
          .filter(
            (m) =>
              m.joined &&
              m.receive !== "off" &&
              m.receive !== "replies" &&
              m.agentKey !== agentKey &&
              m.sessionId !== self.sessionId,
          )
          .filter((m) => frame.scope !== "cwd" || cwdRelated(self.cwd, m.cwd))
          .filter(
            (m) =>
              q === "" ||
              (m.name !== undefined && m.name.toLowerCase().startsWith(q)) ||
              (q.length >= XS_RESOLVE_PREFIX_MIN && m.sessionId.toLowerCase().startsWith(q)),
          )
          .sort((a, b) => b.activityAt - a.activityAt)
          .slice(0, XS_LIST_MAX_ROWS)
          .map((m) => ({
            ref: refOf(m.sessionId),
            ...(m.name !== undefined ? { name: m.name.slice(0, NAME_MAX) } : {}),
            cwdLabel: abbreviateHome(m.cwd, deps.home).slice(0, NAME_MAX),
            kind: m.kind,
            receive: m.receive === "wake" ? ("wake" as const) : ("deliver" as const),
            busy: m.busy,
            lastActiveAgoS: Math.max(0, Math.floor((now() - m.activityAt) / 1000)),
          }));
        res({ ok: true, rows });
        audit({ op: "list", fromSession: self.sessionId, outcome: "ok", ms: now() - started });
        return;
      }
      const r = resolveTarget(frame.query ?? frame.to ?? "", agentKey, self.sessionId);
      switch (r.kind) {
        case "bad":
          refuse("E_XS_BAD_TARGET", {}, self.sessionId);
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
    const r = resolveTarget(frame.to, agentKey, self.sessionId, hasReplyFields);
    if (r.kind === "bad") return refuse(hasReplyFields ? "E_XS_BAD_FRAME" : "E_XS_BAD_TARGET", {}, self.sessionId);
    if (r.kind === "none") return refuse("E_XS_NO_TARGET", {}, self.sessionId);
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
      },
      text: frame.text!,
      wake: isReply ? false : wake,
      ...(!isReply && frame.level !== undefined ? { level: frame.level } : {}),
      ...(frame.expect !== undefined
        ? { reply: { requestId: frame.expect.requestId, dueAt: now() + frame.expect.timeoutMs } }
        : {}),
      ...(isReply ? { inReplyTo: frame.replyTo! } : {}),
      expiresAt: now() + XS_EXPIRES_MS,
    });
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
          limits.settle(ticket, { acked: true, woke: ack.woke });
          settleOut(
            ack.effect,
            token(ack.reason) ?? (ack.reason === undefined ? undefined : "unverified"),
            token(ack.wakeDowngraded) ?? admit.wakeDowngraded,
          );
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

// ----------------------------------------------------------------- assembly (hub.ts only calls this)

export interface XsRelay {
  router: XsRouter;
  members: XsMembers;
  limits: XsLimits;
  dispose(): void;
}

/** Builds members + limits + router and installs the registry observer. Called by `hub.ts` only
 *  when `config.crossSession` exists (key absence IS off). */
export function createXsRelay(deps: {
  registry: Registry;
  config: { home: string; crossSession: HubCrossSessionConfig };
  log: HubLog;
  now: () => number;
}): XsRelay {
  const hubSendsPerMin = deps.config.crossSession.limits.hubSendsPerMin;
  let router: XsRouter | undefined;
  const members = createXsMembers({
    now: deps.now,
    view: (key) => deps.registry.xsView(key),
    onLateAck: (key) => router?.onLateAck(key),
  });
  const limits = createXsLimits({ now: deps.now, hubSendsPerMin });
  router = createXsRouter({
    registry: deps.registry,
    members,
    limits,
    log: deps.log,
    now: deps.now,
    home: deps.config.home,
    hubSendsPerMin,
    replyEnabled: deps.config.crossSession.reply !== false,
  });
  deps.registry.setXsObserver(members.observer);
  const r = router;
  return {
    router: r,
    members,
    limits,
    dispose() {
      r.dispose();
      deps.registry.setXsObserver(undefined);
    },
  };
}
