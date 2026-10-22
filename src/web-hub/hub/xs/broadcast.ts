/**
 * Channel-plan §5.2 (CH1): the hub-side channel BROADCAST fan-out (`xs_req{op:"broadcast"}`).
 *
 *   1. pre-checks (the router already did origin bind ∧ self.joined ∧ self.channelCapable):
 *      non-empty text; `channel` canonical ∧ ≠ `default` (Q2, `E_XS_BAD_TARGET` + `reason:"default"`) ∧ ∈
 *      self.channels (`E_XS_BAD_TARGET` + `reason:"channel"`)
 *   2. recipient set S = DISTINCT sessionIds of effective ∧ joined ∧ channels ∋ channel ∧
 *      channelCapable ∧ receive ∉ {off, replies} members, never the sender's own sessionId or
 *      agentKey (no loop-back). A sid with >1 holders on the FULL effective-joined table (M3) is a
 *      `none{ambiguous}` row — not delivered, but counted in N and in the quota.
 *   3. N = 0 ⇒ `none{no_recipients}`; N > maxRecipients ⇒ `E_XS_FANOUT_TOO_LARGE` (none)
 *   4. worst-shape 16 KiB pre-check per stamped deliver, then `limits.admitBroadcast` —
 *      all-or-nothing, a refusal consumes nothing (`none{<reason>}`)
 *   5. wake (only for `wake:true`): 5.1 here (`level` absent ⇒ `sender_wake_disabled`, ≠0 ⇒
 *      `level_limit`), 5.2–5.5 in `admitBroadcast` (fanout ≤ wakeMaxRecipients hard 4 /
 *      broadcast-wake rate hard 2/h / outbound wakes ≥ N / per-row pair wakes)
 *   6. one `registry.request(xs_deliver{bc, via})` per deliverable row, each with its own xid; the
 *      hub never re-sends (at-most-once per (broadcast, recipient), §5.4)
 *   7. each row settles on its ack or the 5 s deadline — deadline / disconnect / ack mismatch /
 *      dispose ⇒ `unknown` (r3 M2). NOTHING is refunded (CR5); the in-flight slot is released once,
 *      after the last row settled.
 *   8. aggregate: all applied ⇒ applied; all none ⇒ none; all unknown ⇒ unknown; mixed ⇒
 *      `unknown{partial}`. `fanout` + per-row `results` (≤32). Audit: one `op:"broadcast"` line plus
 *      one `op:"send", bcast:true` line per recipient — never the body.
 *
 * pi-free (hub boundary); the only timers are `registry.request`'s (unref'd).
 */
import { randomBytes } from "node:crypto";
import type { AgentFrame, HubFrame } from "../../protocol/messages.js";
import {
  XS_EXPIRES_MS,
  XS_HUB_DELIVER_MS,
  xsFrameBytesOk,
  type XsAckFrame,
  type XsBroadcastRowWire,
  type XsDeliverFrame,
  type XsEffect,
  type XsFanoutWire,
  type XsReqFrame,
  type XsResFrame,
  type XsWakeDowngraded,
} from "../../protocol/xs.js";
import { auditXs } from "../audit.js";
import type { HubLog } from "../ports.js";
import type { Registry } from "../registry.js";
import type { HubXsChannelsConfig, XsBroadcastWakeDowngrade, XsLimits } from "./limits.js";
import {
  abbreviateHome,
  hubIntersect,
  hubNormalizeChannel,
  hubSharedField,
  XS_HUB_DEFAULT_CHANNEL,
  XS_NAME_MAX,
  XS_REF_LEN,
  xsToken,
  type XsEffectiveMember,
  type XsMembers,
} from "./members.js";

export interface XsBroadcastDeps {
  registry: Registry;
  members: XsMembers;
  limits: XsLimits;
  log: HubLog;
  now: () => number;
  home: string;
  /** Effective hub-global params (`hubChannelsParams`). */
  channels: HubXsChannelsConfig;
  /** The router's dispose signal — in-flight rows settle as unknown. */
  signal: AbortSignal;
}

export interface XsBroadcastRequest {
  agentKey: string;
  /** The origin-bound, joined, channel-capable requester. */
  self: XsEffectiveMember;
  frame: XsReqFrame;
  started: number;
  textLen: number;
  /** Router reply helper (never throws). */
  res(body: Omit<XsResFrame, "t" | "rid">): void;
  /** Router refusal helper (`ok:false, effect:"none"` + audit). */
  refuse(code: string, extra?: Omit<XsResFrame, "t" | "rid" | "ok" | "code" | "effect">, from?: string): void;
}

interface Row {
  sessionId: string;
  /** The representative (most recently active) visible holder. */
  member: XsEffectiveMember;
  ambiguous: boolean;
}

interface RowResult {
  effect: XsEffect;
  reason?: string;
  wakeDowngraded?: string;
  woke: boolean;
}

/** Never throws past the router's own catch; `req.res` is called exactly once. */
export function runXsBroadcast(deps: XsBroadcastDeps, req: XsBroadcastRequest): void {
  const { registry, members, limits, log, now } = deps;
  const { agentKey, self, frame, started, textLen } = req;
  const from = self.sessionId;

  // ① pre-checks
  if (typeof frame.text !== "string" || frame.text === "") {
    req.refuse("E_XS_BAD_FRAME", {}, from);
    return;
  }
  const channel = hubNormalizeChannel(frame.channel);
  if (channel === null) return req.refuse("E_XS_BAD_TARGET", { reason: "channel" }, from);
  if (channel === XS_HUB_DEFAULT_CHANNEL) return req.refuse("E_XS_BAD_TARGET", { reason: "default" }, from); // Q2
  if (!self.channels.includes(channel)) return req.refuse("E_XS_BAD_TARGET", { reason: "channel" }, from);

  const auditLine = (outcome: XsEffect | "error", extra: { reason?: string; recipients: number; wake?: boolean }) =>
    auditXs(log, {
      op: "broadcast",
      fromSession: from,
      textLen,
      wake: extra.wake ?? false,
      outcome,
      recipients: extra.recipients,
      ...(extra.reason === undefined ? {} : { reason: extra.reason }),
      ms: now() - started,
    });

  // ② recipient set S (unit = logical session); holders judged on the full joined table (M3)
  const joinedAll = members.effectiveAll().filter((m) => m.joined);
  const holders = new Map<string, number>();
  for (const m of joinedAll) holders.set(m.sessionId, (holders.get(m.sessionId) ?? 0) + 1);
  const bySession = new Map<string, XsEffectiveMember>();
  for (const m of joinedAll) {
    if (m.sessionId === self.sessionId || m.agentKey === agentKey) continue; // no loop-back
    if (!m.channelCapable || !m.channels.includes(channel)) continue;
    if (m.receive === "off" || m.receive === "replies") continue;
    const prev = bySession.get(m.sessionId);
    if (prev === undefined || m.activityAt > prev.activityAt) bySession.set(m.sessionId, m);
  }
  const rows: Row[] = [...bySession.entries()]
    .map(([sessionId, member]) => ({ sessionId, member, ambiguous: (holders.get(sessionId) ?? 0) > 1 }))
    .sort(
      (a, b) =>
        b.member.activityAt - a.member.activityAt ||
        (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
    );
  const n = rows.length;

  // ③ size
  if (n === 0) {
    req.res({ ok: true, effect: "none", reason: "no_recipients" });
    auditLine("none", { reason: "no_recipients", recipients: 0 });
    return;
  }
  if (n > deps.channels.maxRecipients) {
    req.refuse("E_XS_FANOUT_TOO_LARGE", {}, from);
    return;
  }

  // stamping (shared by the worst-shape check and the real deliveries)
  const fromName = self.name?.slice(0, XS_NAME_MAX);
  const stampFrom: XsDeliverFrame["from"] = {
    sessionId: self.sessionId,
    ref: self.sessionId.slice(0, XS_REF_LEN),
    ...(fromName !== undefined ? { name: fromName } : {}),
    cwdLabel: abbreviateHome(self.cwd, deps.home).slice(0, XS_NAME_MAX),
    agentId: agentKey.slice(0, 128),
  };
  const build = (m: XsEffectiveMember, xid: string, wake: boolean, rid: string): XsDeliverFrame => {
    const via = hubSharedField(hubIntersect(self.channels, m.channels), m.channelCapable);
    return {
      t: "xs_deliver",
      rid,
      xid,
      to: { sessionId: m.sessionId, epoch: m.epoch },
      from: stampFrom,
      text: frame.text!,
      wake,
      ...(frame.level !== undefined ? { level: frame.level } : {}),
      expiresAt: now() + XS_EXPIRES_MS,
      ...(via === undefined ? {} : { via }),
      bc: { channel },
    };
  };
  // ④a worst shape: every stamped deliver must fit the 16 KiB xs cap (refuse before any reservation)
  for (const r of rows) {
    if (r.ambiguous) continue;
    if (!xsFrameBytesOk(build(r.member, `x${"0".repeat(18)}`, true, "r".repeat(16)))) {
      req.refuse("E_XS_TOO_LARGE", {}, from);
      return;
    }
  }

  // ⑤.1 wake gate at the hub (the sender also judged hopAllowed ∧ level 0 locally)
  const wantWake = frame.wake === true;
  let step1Downgrade: XsBroadcastWakeDowngrade | undefined;
  if (wantWake) {
    if (frame.level === undefined) step1Downgrade = "sender_wake_disabled";
    else if (frame.level !== 0) step1Downgrade = "level_limit";
  }
  // ④b all-or-nothing admission (+ ⑤.2–⑤.5)
  const admit = limits.admitBroadcast({
    agentKey,
    recipients: rows.map((r) => ({ pairKey: `${self.sessionId}>${r.sessionId}` })),
    limits: self.limits,
    wantWake: wantWake && step1Downgrade === undefined,
    wakeMaxRecipients: deps.channels.wakeMaxRecipients,
  });
  if (!admit.ok) {
    req.res({ ok: true, effect: "none", reason: admit.reason });
    auditLine("none", { reason: admit.reason, recipients: n, wake: wantWake });
    return;
  }
  const wholeDowngrade: XsBroadcastWakeDowngrade | undefined = step1Downgrade ?? admit.wakeDowngraded;

  // ⑥ fan-out. From here on nothing is `none` unless the receiver (or ambiguity) says so.
  let settledOnce = false;
  const releaseSlot = (): void => {
    if (settledOnce) return;
    settledOnce = true;
    limits.settleBroadcast(admit.ticket);
  };
  const auditRow = (r: Row, xid: string | undefined, wake: boolean, out: RowResult): void =>
    auditXs(log, {
      op: "send",
      bcast: true,
      ...(xid === undefined ? {} : { xid }),
      fromSession: from,
      toSession: r.sessionId,
      textLen,
      wake,
      outcome: out.effect,
      ...(out.reason === undefined ? {} : { reason: out.reason }),
      ms: now() - started,
    });

  const pending: Array<Promise<RowResult>> = rows.map((r, i) => {
    const slot = admit.rows[i];
    if (r.ambiguous) {
      const out: RowResult = { effect: "none", reason: "ambiguous", woke: false };
      auditRow(r, undefined, false, out);
      return Promise.resolve(out);
    }
    const rowWake = slot?.wake === true;
    const rowDowngrade: string | undefined = slot?.wakeDowngraded;
    const xid = `x${randomBytes(9).toString("hex")}`;
    const finish = (out: RowResult): RowResult => {
      auditRow(r, xid, rowWake, out);
      return out;
    };
    const withDg = (out: RowResult, dg: string | undefined): RowResult =>
      dg === undefined ? out : { ...out, wakeDowngraded: dg };
    let p: Promise<XsAckFrame & AgentFrame>;
    try {
      p = registry.request<XsAckFrame & AgentFrame>(
        r.member.agentKey,
        build(r.member, xid, rowWake, "pending") as HubFrame & { rid: string },
        XS_HUB_DELIVER_MS,
        deps.signal,
      );
    } catch {
      return Promise.resolve(finish(withDg({ effect: "unknown", reason: "link_lost", woke: false }, rowDowngrade)));
    }
    return p.then(
      (ack) => {
        if (ack.xid !== xid) {
          return finish(withDg({ effect: "unknown", reason: "ack_mismatch", woke: false }, rowDowngrade));
        }
        const reason = xsToken(ack.reason) ?? (ack.reason === undefined ? undefined : "unverified");
        return finish(
          withDg(
            { effect: ack.effect, ...(reason === undefined ? {} : { reason }), woke: ack.woke === true },
            xsToken(ack.wakeDowngraded) ?? rowDowngrade,
          ),
        );
      },
      (err: unknown) => {
        const code = (err as { code?: unknown } | null)?.code;
        return finish(
          withDg(
            { effect: "unknown", reason: code === "E_DEADLINE" ? "deliver_deadline" : "link_lost", woke: false },
            rowDowngrade,
          ),
        );
      },
    );
  });

  // ⑦⑧ settle + aggregate
  void Promise.all(pending)
    .then((outs) => {
      releaseSlot();
      const fanout: XsFanoutWire = { total: n, applied: 0, none: 0, unknown: 0, woke: 0 };
      const results: XsBroadcastRowWire[] = outs.map((out, i) => {
        const m = rows[i]!.member;
        fanout[out.effect]++;
        if (out.woke) fanout.woke++;
        return {
          ref: m.sessionId.slice(0, XS_REF_LEN),
          ...(m.name !== undefined ? { name: m.name.slice(0, XS_NAME_MAX) } : {}),
          effect: out.effect,
          ...(out.reason === undefined ? {} : { reason: out.reason }),
          ...(out.wakeDowngraded === undefined ? {} : { wakeDowngraded: out.wakeDowngraded as XsWakeDowngraded }),
          woke: out.woke,
        };
      });
      const effect: XsEffect = fanout.applied === n ? "applied" : fanout.none === n ? "none" : "unknown";
      const reason = effect === "unknown" && fanout.unknown !== n ? "partial" : undefined;
      req.res({
        ok: true,
        effect,
        ...(reason === undefined ? {} : { reason }),
        ...(wholeDowngrade === undefined ? {} : { wakeDowngraded: wholeDowngrade }),
        fanout,
        results,
      });
      auditLine(effect, { ...(reason === undefined ? {} : { reason }), recipients: n, wake: admit.wake });
    })
    .catch(() => {
      // aggregation/auditing itself failed: still release and answer with the only honest verdict.
      releaseSlot();
      req.res({ ok: false, code: "E_XS_INTERNAL", effect: "unknown" });
      log.warn("xs handler failed", { code: "E_XS_INTERNAL", op: "broadcast", textLen });
    });
}
