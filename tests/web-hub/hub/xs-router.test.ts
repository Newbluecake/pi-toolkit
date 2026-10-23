import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { XsAckFrame, XsDeliverFrame, XsReqFrame, XsResFrame } from "../../../src/web-hub/protocol/xs.js";
import { auditXs, type XsAuditRecord } from "../../../src/web-hub/hub/audit.js";
import { createXsRouter } from "../../../src/web-hub/hub/xs/router.js";
import { memberFrame, rig, type Rig } from "./xs-fixtures.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

let seq = 0;
function req(over: Partial<XsReqFrame> & Pick<XsReqFrame, "op">, sessionId = "sess-A", epoch = 1): XsReqFrame {
  return { t: "xs_req", rid: `q${++seq}`, origin: { sessionId, epoch }, ...over };
}

function call(r: Rig, key: string, frame: XsReqFrame): XsResFrame[] {
  const out: XsResFrame[] = [];
  r.relay.router.handle(key, frame, (res) => out.push(res));
  return out;
}

const lastDeliver = (conn: { sent: unknown[] }): XsDeliverFrame => {
  const f = [...conn.sent].reverse().find((x) => (x as { t?: string }).t === "xs_deliver");
  if (f === undefined) throw new Error("no xs_deliver sent");
  return f as XsDeliverFrame;
};

/** Deliver an xs_ack to the registry, then let the router's promise continuations run. */
async function ack(r: Rig, key: string, d: XsDeliverFrame, over: Partial<XsAckFrame> = {}): Promise<void> {
  r.registry.onFrame(key, { t: "xs_ack", rid: d.rid, xid: d.xid, effect: "applied", woke: false, ...over });
  await vi.advanceTimersByTimeAsync(0);
}

/** A (sender, joined) + B (receiver, joined, wake). */
function pair(extra: Parameters<Rig["agent"]>[0] extends infer _ ? Record<string, never> : never = {}) {
  void extra;
  const r = rig();
  const a = r.agent({ pid: 1, sessionId: "sess-A", name: "alpha", cwd: "/home/u/proj" });
  const b = r.agent({ pid: 2, sessionId: "sess-BBBBBBBBBBBB-long", name: "beta", cwd: "/home/u/proj/sub" });
  return { r, a, b };
}

describe("xs router: origin bind (§8.1)", () => {
  it("rejects a request whose origin sessionId/epoch does not match the socket's member (E_XS_STALE_ORIGIN, none)", () => {
    const { r, a } = pair();
    for (const frame of [
      req({ op: "list" }, "sess-OTHER", 1),
      req({ op: "list" }, "sess-A", 2),
      req({ op: "info" }, "sess-A", 0),
    ]) {
      expect(call(r, a.key, frame)[0]).toMatchObject({ ok: false, code: "E_XS_STALE_ORIGIN", effect: "none" });
    }
  });

  it("an agent with no xs_member / not an effective member gets E_XS_STALE_ORIGIN for every op", () => {
    const r = rig();
    const x = r.agent({ pid: 9, sessionId: "sess-X", skipMember: true });
    for (const op of ["list", "resolve", "send", "info"] as const) {
      expect(call(r, x.key, req({ op, query: "q", to: "t", text: "hi" }, "sess-X"))[0]).toMatchObject({
        code: "E_XS_STALE_ORIGIN",
      });
    }
  });

  it("send additionally requires member.joined; a not-joined member's list/resolve see nobody (channel-plan §4.1)", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A", joined: false });
    r.agent({ pid: 2, sessionId: "sess-B", name: "beta" });
    expect(call(r, a.key, req({ op: "send", to: "sess-B", text: "x" }))[0]).toMatchObject({
      code: "E_XS_STALE_ORIGIN",
    });
    expect(call(r, a.key, req({ op: "info" }))[0]?.ok).toBe(true);
    // v0.7.1 answered every joined member here; visibility now needs a shared channel (C4 closed).
    expect(call(r, a.key, req({ op: "list" }))[0]).toMatchObject({ ok: true, rows: [] });
    expect(call(r, a.key, req({ op: "resolve", query: "beta" }))[0]).toMatchObject({
      ok: false,
      code: "E_XS_NO_TARGET",
    });
  });

  it("an epoch bump (leave/join) invalidates the old epoch immediately; the new epoch works", () => {
    const { r, a } = pair();
    r.registry.onFrame(a.key, memberFrame({ sessionId: "sess-A", epoch: 2 }));
    expect(call(r, a.key, req({ op: "list" }, "sess-A", 1))[0]).toMatchObject({ code: "E_XS_STALE_ORIGIN" });
    expect(call(r, a.key, req({ op: "list" }, "sess-A", 2))[0]?.ok).toBe(true);
  });

  it("another socket cannot borrow a member's identity: origin is checked against THAT socket's record", () => {
    const { r, b } = pair();
    expect(call(r, b.key, req({ op: "list" }, "sess-A", 1))[0]).toMatchObject({ code: "E_XS_STALE_ORIGIN" });
  });
});

describe("xs router: info", () => {
  it("returns the hub's frozen limits and constants", () => {
    const { r, a } = pair();
    expect(call(r, a.key, req({ op: "info" }))[0]).toMatchObject({
      ok: true,
      hubLimits: { hubSendsPerMin: 60, expiresMs: 5_000, deliverMs: 5_000 },
    });
  });
});

describe("xs router: list (§5.1)", () => {
  it("lists only joined, receive≠off, not-self, effective members; no agentKey/pid/tools/model", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A" });
    r.agent({ pid: 2, sessionId: "sess-B", name: "beta", cwd: "/home/u/p", receive: "deliver" });
    r.agent({ pid: 3, sessionId: "sess-C", name: "gamma", joined: false });
    r.agent({ pid: 4, sessionId: "sess-D", name: "delta", receive: "off" });
    r.agent({ pid: 5, sessionId: "sess-E", name: "eps", caps: ["ev.v1"] }); // no xs.v1
    r.agent({ pid: 6, sessionId: "sess-F", name: "zeta", skipMember: true });
    const res = call(r, a.key, req({ op: "list" }))[0]!;
    expect(res.ok).toBe(true);
    expect(res.rows).toEqual([
      {
        ref: "sess-B",
        name: "beta",
        cwdLabel: "~/p",
        kind: "tui",
        receive: "deliver",
        busy: false,
        lastActiveAgoS: 0,
      },
    ]);
    expect(JSON.stringify(res)).not.toMatch(/agentKey|pid|a\d+-nonce/);
  });

  it("a not-joined member is invisible and a send to it equals a send to nobody (XI5)", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A" });
    r.agent({ pid: 2, sessionId: "sess-hidden-1234", joined: false, name: "ghost" });
    const toHidden = call(r, a.key, req({ op: "send", to: "sess-hidden-1234", text: "x" }))[0]!;
    const toNobody = call(r, a.key, req({ op: "send", to: "sess-nonexistent", text: "x" }))[0]!;
    const strip = ({ rid: _r, ...rest }: XsResFrame) => rest;
    expect(strip(toHidden)).toEqual(strip(toNobody));
    expect(toHidden).toMatchObject({ ok: false, code: "E_XS_NO_TARGET", effect: "none" });
  });

  it("scope:cwd keeps same/ancestor/descendant dirs only (boundary-aware); hub scope lists all; send is NOT scoped", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A", cwd: "/w/proj" });
    r.agent({ pid: 2, sessionId: "sess-same", name: "same", cwd: "/w/proj" });
    r.agent({ pid: 3, sessionId: "sess-child", name: "child", cwd: "/w/proj/sub" });
    r.agent({ pid: 4, sessionId: "sess-parent", name: "parent", cwd: "/w" });
    r.agent({ pid: 5, sessionId: "sess-sibling", name: "sibling", cwd: "/w/proj2" });
    const far = r.agent({ pid: 6, sessionId: "sess-far", name: "far", cwd: "/elsewhere" });
    const names = (scope?: "hub" | "cwd") =>
      (call(r, a.key, req({ op: "list", ...(scope ? { scope } : {}) }))[0]!.rows ?? []).map((x) => x.name).sort();
    expect(names("cwd")).toEqual(["child", "parent", "same"]);
    expect(names("hub")).toEqual(["child", "far", "parent", "same", "sibling"]);
    expect(names()).toEqual(names("hub"));
    expect(call(r, a.key, req({ op: "send", to: "sess-far", text: "x" }))).toEqual([]); // admitted, pending
    expect(lastDeliver(far.conn).text).toBe("x");
  });

  it("query filters by name prefix (case-insensitive) or sessionId prefix ≥ 8; short id prefixes never match", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A" });
    r.agent({ pid: 2, sessionId: "abcdef123456-x", name: "Builder" });
    r.agent({ pid: 3, sessionId: "zzzzzzzz99", name: "other" });
    const q = (query: string) => (call(r, a.key, req({ op: "list", query }))[0]!.rows ?? []).map((x) => x.name).sort();
    expect(q("build")).toEqual(["Builder"]);
    expect(q("abcdef12")).toEqual(["Builder"]);
    expect(q("abcdef1")).toEqual([]); // 7 chars: anti-enumeration
    expect(q("uilder")).toEqual([]); // prefix only, not substring
  });

  it("caps at 20 rows, most recently active first", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A" });
    for (let i = 0; i < 25; i++) {
      r.clock.t += 1_000;
      r.agent({ pid: 100 + i, sessionId: `sess-peer-${String(i).padStart(2, "0")}`, name: `p${i}` });
    }
    const rows = call(r, a.key, req({ op: "list" }))[0]!.rows!;
    expect(rows).toHaveLength(20);
    expect(rows[0]!.name).toBe("p24");
    expect(rows.every((x) => x.name !== "p0")).toBe(true);
  });

  it("busy and lastActiveAgoS reflect status/ev activity", () => {
    const { r, a, b } = pair();
    r.clock.t += 42_000;
    r.registry.onFrame(b.key, { t: "status", leafId: null, busy: true, pending: false });
    r.clock.t += 7_000;
    const row = call(r, a.key, req({ op: "list" }))[0]!.rows![0]!;
    expect(row).toMatchObject({ busy: true, lastActiveAgoS: 7 });
  });

  it("listPerMin: the 7th list inside a minute is refused (E_XS_RATE_LIMITED, none); resolve shares the budget", () => {
    const { r, a } = pair();
    for (let i = 0; i < 4; i++) expect(call(r, a.key, req({ op: "list" }))[0]?.ok).toBe(true);
    expect(call(r, a.key, req({ op: "resolve", query: "beta" }))[0]?.ok).toBe(true);
    expect(call(r, a.key, req({ op: "resolve", query: "beta" }))[0]?.ok).toBe(true);
    expect(call(r, a.key, req({ op: "list" }))[0]).toMatchObject({
      ok: false,
      code: "E_XS_RATE_LIMITED",
      effect: "none",
    });
    r.clock.t += 60_000;
    expect(call(r, a.key, req({ op: "list" }))[0]?.ok).toBe(true);
  });
});

describe("xs router: resolve (§5.1)", () => {
  function many() {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A" });
    r.agent({ pid: 2, sessionId: "abcd1234-one", name: "Alpha" });
    r.agent({ pid: 3, sessionId: "abcd1234-two", name: "alpha" });
    r.agent({ pid: 4, sessionId: "uniqueid-xyz-0001", name: "solo" });
    return { r, a };
  }
  const res = (r: Rig, key: string, query: string) => call(r, key, req({ op: "resolve", query }))[0]!;

  it("exact sessionId → target (ref = first 12 chars)", () => {
    const { r, a } = many();
    expect(res(r, a.key, "uniqueid-xyz-0001")).toMatchObject({
      ok: true,
      target: { ref: "uniqueid-xyz", name: "solo" },
    });
  });

  it("prefix ≥ 8 resolves; a shorter prefix is never matched", () => {
    const { r, a } = many();
    expect(res(r, a.key, "uniqueid")).toMatchObject({ ok: true, target: { name: "solo" } });
    expect(res(r, a.key, "uniquei")).toMatchObject({ ok: false, code: "E_XS_NO_TARGET" });
  });

  it("ambiguous prefix ⇒ ok:true with ≤5 candidates (ref+name only), nothing chosen", () => {
    const { r, a } = many();
    const out = res(r, a.key, "abcd1234");
    expect(out.ok).toBe(true);
    expect(out.target).toBeUndefined();
    expect(out.candidates).toEqual(expect.arrayContaining([{ ref: "abcd1234-one", name: "Alpha" }]));
    expect(out.candidates).toHaveLength(2);
  });

  it("name: exact wins over case-insensitive; case-insensitive only when no exact; ties ⇒ candidates", () => {
    const { r, a } = many();
    expect(res(r, a.key, "Alpha")).toMatchObject({ ok: true, target: { ref: "abcd1234-one" } });
    expect(res(r, a.key, "alpha")).toMatchObject({ ok: true, target: { ref: "abcd1234-two" } });
    expect(res(r, a.key, "ALPHA").candidates).toHaveLength(2);
    expect(res(r, a.key, "SOLO")).toMatchObject({ ok: true, target: { name: "solo" } });
  });

  it("candidates are capped at 5", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A" });
    for (let i = 0; i < 8; i++) r.agent({ pid: 10 + i, sessionId: `same-prefix-${i}`, name: `n${i}` });
    // list budget is 6/min: stay under it
    expect(res(r, a.key, "same-pre").candidates).toHaveLength(5);
  });

  it("two effective members holding the SAME sessionId ⇒ E_XS_AMBIGUOUS (XR5), one candidate", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A" });
    r.agent({ pid: 2, sessionId: "dup-session-xxxx", name: "d1" });
    r.agent({ pid: 3, sessionId: "dup-session-xxxx", name: "d2" });
    expect(res(r, a.key, "dup-session-xxxx")).toMatchObject({ ok: false, code: "E_XS_AMBIGUOUS", effect: "none" });
  });

  it("reserved address forms ⇒ E_XS_BAD_TARGET; unknown ⇒ E_XS_NO_TARGET; self is never a target", () => {
    const { r, a } = many();
    for (const q of ["root", "system", "main", "r_abc123", "@worker", "wf_x1"]) {
      expect(res(r, a.key, q)).toMatchObject({ ok: false, code: "E_XS_BAD_TARGET" });
      r.clock.t += 60_000;
    }
    expect(res(r, a.key, "nobody")).toMatchObject({ ok: false, code: "E_XS_NO_TARGET" });
    expect(res(r, a.key, "sess-A")).toMatchObject({ ok: false, code: "E_XS_NO_TARGET" });
  });
});

describe("xs router: send (§8.3)", () => {
  it("delivers a hub-stamped xs_deliver and settles on the receiver's xs_ack (applied)", async () => {
    const { r, a, b } = pair();
    r.clock.t += 123;
    const out = call(r, a.key, req({ op: "send", to: "beta", text: "hello B", wake: true, level: 1 }));
    expect(out).toEqual([]); // pending until the ack
    const d = lastDeliver(b.conn);
    expect(d).toMatchObject({
      t: "xs_deliver",
      to: { sessionId: "sess-BBBBBBBBBBBB-long", epoch: 1 },
      from: { sessionId: "sess-A", ref: "sess-A", name: "alpha", cwdLabel: "~/proj", agentId: a.key },
      text: "hello B",
      wake: true,
      level: 1,
      expiresAt: r.clock.t + 5_000,
    });
    expect(d.xid).toMatch(/^x[0-9a-f]{18}$/);
    await ack(r, b.key, d, { effect: "applied", woke: true });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      ok: true,
      effect: "applied",
      target: { ref: "sess-BBBBBBB", name: "beta" },
    });
    expect(out[0]!.wakeDowngraded).toBeUndefined();
  });

  it("`from` is derived ONLY from the hub's records — a frame cannot choose its sender identity", () => {
    const { r, a, b } = pair();
    const forged = { ...req({ op: "send", to: "beta", text: "x" }), from: { sessionId: "sess-EVIL" } } as XsReqFrame;
    call(r, a.key, forged);
    expect(lastDeliver(b.conn).from.sessionId).toBe("sess-A");
  });

  it("relays the receiver's verdict verbatim: none{rejected}, unknown{queued}, wakeDowngraded", async () => {
    const { r, a, b } = pair();
    const out1 = call(r, a.key, req({ op: "send", to: "beta", text: "1", wake: true }));
    await ack(r, b.key, lastDeliver(b.conn), { effect: "none", reason: "rejected", woke: false });
    expect(out1[0]).toMatchObject({ ok: true, effect: "none", reason: "rejected" });
    r.clock.t += 5_000;
    const out2 = call(r, a.key, req({ op: "send", to: "beta", text: "2", wake: true }));
    await ack(r, b.key, lastDeliver(b.conn), {
      effect: "unknown",
      reason: "queued",
      wakeDowngraded: "busy",
      woke: false,
    });
    expect(out2[0]).toMatchObject({ effect: "unknown", reason: "queued", wakeDowngraded: "busy" });
  });

  it("deadline: no ack within 5s ⇒ unknown{deliver_deadline} (NEVER none, r3 M2); the late ack is only counted", async () => {
    const { r, a, b } = pair();
    const out = call(r, a.key, req({ op: "send", to: "beta", text: "x" }));
    const d = lastDeliver(b.conn);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(out[0]).toMatchObject({ ok: true, effect: "unknown", reason: "deliver_deadline" });
    expect(r.relay.router.lateAcks()).toBe(0);
    await ack(r, b.key, d);
    expect(r.relay.router.lateAcks()).toBe(1);
    expect(out).toHaveLength(1); // no second reply
  });

  it("receiver disconnects after the deliver was written ⇒ unknown{link_lost}", async () => {
    const { r, a, b } = pair();
    const out = call(r, a.key, req({ op: "send", to: "beta", text: "x" }));
    r.registry.onClose(b.key, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(out[0]).toMatchObject({ ok: true, effect: "unknown", reason: "link_lost" });
  });

  it("ack with the wrong xid ⇒ unknown{ack_mismatch}", async () => {
    const { r, a, b } = pair();
    const out = call(r, a.key, req({ op: "send", to: "beta", text: "x" }));
    const d = lastDeliver(b.conn);
    await ack(r, b.key, { ...d, xid: "x-not-the-one" });
    expect(out[0]).toMatchObject({ effect: "unknown", reason: "ack_mismatch" });
  });

  it("an ack from a DIFFERENT agent (same rid) does not settle the pending", async () => {
    const { r, a, b } = pair();
    const c = r.agent({ pid: 3, sessionId: "sess-C", name: "gamma" });
    const out = call(r, a.key, req({ op: "send", to: "beta", text: "x" }));
    const d = lastDeliver(b.conn);
    await ack(r, c.key, d);
    expect(out).toEqual([]);
    expect(r.relay.router.lateAcks()).toBe(1);
    await ack(r, b.key, d);
    expect(out).toHaveLength(1);
  });

  it("peer-supplied reason/wakeDowngraded are token-filtered before they are forwarded", async () => {
    const { r, a, b } = pair();
    const out = call(r, a.key, req({ op: "send", to: "beta", text: "x", wake: true }));
    await ack(r, b.key, lastDeliver(b.conn), {
      effect: "none",
      reason: "free text with spaces and secrets",
      wakeDowngraded: "also bad!!" as never,
      woke: false,
    });
    expect(out[0]).toMatchObject({ effect: "none", reason: "unverified" });
    expect(out[0]!.wakeDowngraded).toBeUndefined();
  });

  it("receive:off target ⇒ early none{rejected} with NOTHING sent and nothing reserved", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A" });
    const off = r.agent({ pid: 2, sessionId: "sess-off-aaaa", name: "mute", receive: "off" });
    const out = call(r, a.key, req({ op: "send", to: "mute", text: "x" }));
    expect(out[0]).toMatchObject({ ok: true, effect: "none", reason: "rejected" });
    expect(off.conn.sent).toEqual([]);
    expect(r.relay.limits.snapshot().hubLastMin).toBe(0);
  });

  it("ambiguous name/prefix ⇒ E_XS_AMBIGUOUS + candidates and nothing is delivered", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A" });
    const b1 = r.agent({ pid: 2, sessionId: "pfx-12345678-1", name: "w" });
    const b2 = r.agent({ pid: 3, sessionId: "pfx-12345678-2", name: "x" });
    const out = call(r, a.key, req({ op: "send", to: "pfx-12345678", text: "x" }));
    expect(out[0]).toMatchObject({ ok: false, code: "E_XS_AMBIGUOUS", effect: "none" });
    expect(out[0]!.candidates).toHaveLength(2);
    expect(b1.conn.sent).toEqual([]);
    expect(b2.conn.sent).toEqual([]);
  });

  it("two effective holders of one sessionId ⇒ E_XS_AMBIGUOUS, no delivery to either", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A" });
    const d1 = r.agent({ pid: 2, sessionId: "dup-session-xxxx" });
    const d2 = r.agent({ pid: 3, sessionId: "dup-session-xxxx" });
    expect(call(r, a.key, req({ op: "send", to: "dup-session-xxxx", text: "x" }))[0]).toMatchObject({
      code: "E_XS_AMBIGUOUS",
    });
    expect(d1.conn.sent).toEqual([]);
    expect(d2.conn.sent).toEqual([]);
  });

  it("missing/empty to or text ⇒ E_XS_BAD_FRAME; reserved target ⇒ E_XS_BAD_TARGET", () => {
    const { r, a } = pair();
    expect(call(r, a.key, req({ op: "send", text: "x" }))[0]).toMatchObject({ code: "E_XS_BAD_FRAME" });
    expect(call(r, a.key, req({ op: "send", to: "beta" }))[0]).toMatchObject({ code: "E_XS_BAD_FRAME" });
    expect(call(r, a.key, req({ op: "send", to: "beta", text: "" }))[0]).toMatchObject({ code: "E_XS_BAD_FRAME" });
    expect(call(r, a.key, req({ op: "send", to: "root", text: "x" }))[0]).toMatchObject({ code: "E_XS_BAD_TARGET" });
  });

  it("a frame near 16 KiB whose stamped deliver would overflow is refused up front (E_XS_TOO_LARGE, nothing reserved)", () => {
    const { r, a, b } = pair();
    const text = "x".repeat(16_200);
    const out = call(r, a.key, req({ op: "send", to: "beta", text }));
    expect(out[0]).toMatchObject({ ok: false, code: "E_XS_TOO_LARGE", effect: "none" });
    expect(b.conn.sent).toEqual([]);
    expect(r.relay.limits.snapshot().hubLastMin).toBe(0);
  });

  it("limit refusals are none{rate_*} (nothing sent) — pair interval and in-flight", async () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A", limits: { inFlightPerSession: 1 } });
    const b = r.agent({ pid: 2, sessionId: "sess-B", name: "beta" });
    const c = r.agent({ pid: 3, sessionId: "sess-C", name: "gamma" });
    call(r, a.key, req({ op: "send", to: "beta", text: "1" })); // stays in flight
    const second = call(r, a.key, req({ op: "send", to: "sess-C", text: "2" }));
    expect(second[0]).toMatchObject({ ok: true, effect: "none", reason: "rate_in_flight" });
    expect(c.conn.sent).toEqual([]);
    await ack(r, b.key, lastDeliver(b.conn)); // frees the slot
    const same = call(r, a.key, req({ op: "send", to: "beta", text: "3" })); // same pair within 5s
    expect(same[0]).toMatchObject({ effect: "none", reason: "rate_pair_interval" });
  });

  it("hub wake reservation exhausted ⇒ the message still goes, deliver-only, wakeDowngraded:outbound_wake_rate", async () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A", limits: { wakesOutPerHour: 0 } });
    const b = r.agent({ pid: 2, sessionId: "sess-B", name: "beta" });
    const out = call(r, a.key, req({ op: "send", to: "beta", text: "x", wake: true }));
    const d = lastDeliver(b.conn);
    expect(d.wake).toBe(false);
    await ack(r, b.key, d, { effect: "applied", woke: false });
    expect(out[0]).toMatchObject({ effect: "applied", wakeDowngraded: "outbound_wake_rate" });
  });

  it("the sender's own limits come from ITS xs_member (limits are per-session, not global)", async () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A", limits: { sendsOutPerMin: 1, pairMinIntervalMs: 5_000 } });
    const x = r.agent({ pid: 2, sessionId: "sess-X", name: "xx" });
    const y = r.agent({ pid: 3, sessionId: "sess-Y", name: "yy" });
    call(r, a.key, req({ op: "send", to: "xx", text: "1" }));
    await ack(r, x.key, lastDeliver(x.conn));
    expect(call(r, a.key, req({ op: "send", to: "yy", text: "2" }))[0]).toMatchObject({ reason: "rate_sends_min" });
    expect(y.conn.sent).toEqual([]);
  });

  it("send settles limits on the ack: applied+woke:false refunds only the wake reservation", async () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A", limits: { wakesOutPerHour: 1, pairWakesPerHour: 20 } });
    const b = r.agent({ pid: 2, sessionId: "sess-B", name: "beta" });
    call(r, a.key, req({ op: "send", to: "beta", text: "1", wake: true }));
    await ack(r, b.key, lastDeliver(b.conn), { effect: "applied", wakeDowngraded: "busy", woke: false });
    r.clock.t += 5_000;
    call(r, a.key, req({ op: "send", to: "beta", text: "2", wake: true }));
    expect(lastDeliver(b.conn).wake).toBe(true); // refunded ⇒ a wake slot was available again
  });

  it("channel-plan NQ2: an UNKNOWN ack with woke:false never refunds the wake reservation", async () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: "sess-A", limits: { wakesOutPerHour: 1, pairWakesPerHour: 20 } });
    const b = r.agent({ pid: 2, sessionId: "sess-B", name: "beta" });
    call(r, a.key, req({ op: "send", to: "beta", text: "1", wake: true }));
    await ack(r, b.key, lastDeliver(b.conn), { effect: "unknown", reason: "accept_unverified", woke: false });
    r.clock.t += 5_000;
    const out = call(r, a.key, req({ op: "send", to: "beta", text: "2", wake: true }));
    expect(lastDeliver(b.conn).wake).toBe(false); // still spent ⇒ deliver-only
    await ack(r, b.key, lastDeliver(b.conn));
    expect(out[0]).toMatchObject({ ok: true, effect: "applied", wakeDowngraded: "outbound_wake_rate" });
  });

  it("an exception inside the handler answers E_XS_INTERNAL (unknown) and logs only code/op/textLen", () => {
    const { r, a } = pair();
    const secret = "TOP-SECRET-BODY-XYZ";
    vi.spyOn(r.registry, "request").mockImplementation(() => {
      throw new Error(`boom ${secret}`);
    });
    const out = call(r, a.key, req({ op: "send", to: "beta", text: secret }));
    expect(out[0]).toMatchObject({ ok: false, code: "E_XS_INTERNAL", effect: "unknown" });
    expect(JSON.stringify(r.log.lines)).not.toContain(secret);
    expect(r.log.lines.find((l) => l.msg === "xs handler failed")?.data).toEqual({
      code: "E_XS_INTERNAL",
      op: "send",
      textLen: secret.length,
    });
    // the in-flight reservation was released: a fresh send is still admitted
    r.clock.t += 5_000;
    vi.restoreAllMocks();
    call(r, a.key, req({ op: "send", to: "beta", text: "ok" }));
  });

  it("dispose settles in-flight deliveries as unknown and ignores later requests", async () => {
    const { r, a } = pair();
    const out = call(r, a.key, req({ op: "send", to: "beta", text: "x" }));
    r.relay.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(out[0]).toMatchObject({ ok: true, effect: "unknown", reason: "deliver_deadline" });
    expect(call(r, a.key, req({ op: "list" }))).toEqual([]);
  });

  it("audit lines carry no body/hash; only prefixes, lengths and codes", async () => {
    const { r, a, b } = pair();
    const body = "SENSITIVE-PAYLOAD-123";
    call(r, a.key, req({ op: "send", to: "beta", text: body }));
    await ack(r, b.key, lastDeliver(b.conn), { effect: "applied", woke: false });
    const audits = r.log.lines.filter((l) => (l.data as { audit?: string } | undefined)?.audit === "xs");
    expect(audits.length).toBeGreaterThan(0);
    const line = audits.find((l) => (l.data as { op?: string }).op === "send")!;
    expect(line.data).toMatchObject({
      audit: "xs",
      op: "send",
      fromSession: "sess-A",
      toSession: "sess-BBB",
      textLen: body.length,
      wake: false,
      outcome: "applied",
    });
    expect(JSON.stringify(r.log.lines)).not.toContain(body);
  });
});

describe("xs router: oversize xs_req", () => {
  it("rejectTooLarge answers E_XS_TOO_LARGE only for a sane rid", () => {
    const { r, a } = pair();
    const out: XsResFrame[] = [];
    r.relay.router.rejectTooLarge(a.key, { t: "xs_req", rid: "big1" }, (x) => out.push(x));
    r.relay.router.rejectTooLarge(a.key, { t: "xs_req", rid: 5 }, (x) => out.push(x));
    r.relay.router.rejectTooLarge(a.key, { t: "xs_req", rid: "x".repeat(65) }, (x) => out.push(x));
    expect(out).toEqual([{ t: "xs_res", rid: "big1", ok: false, code: "E_XS_TOO_LARGE", effect: "none" }]);
  });
});

// RX2: the old fixture deliberately advertises only xs.v1; opt in per peer here.
const REPLY_CAPS = ["ev.v1", "xs.v1", "xs.reply.v1"];
const REQUEST_ID = "q0123456789abcdef01";
const EXPECT = { requestId: REQUEST_ID, timeoutMs: 60_000 };
const B_ID = "sess-BBBBBBBBBBBB-long";
function replyPair(senderCap = true, targetCap = true, replyEnabled = true) {
  const r = rig();
  if (!replyEnabled) {
    r.relay.router = createXsRouter({
      registry: r.registry,
      members: r.relay.members,
      limits: r.relay.limits,
      log: r.log,
      now: () => r.clock.t,
      home: "/home/u",
      hubSendsPerMin: 60,
      replyEnabled,
    });
  }
  const a = r.agent({ pid: 1, sessionId: "sess-A", caps: senderCap ? REPLY_CAPS : ["xs.v1"] });
  const b = r.agent({ pid: 2, sessionId: B_ID, name: "beta", caps: targetCap ? REPLY_CAPS : ["xs.v1"] });
  return { r, a, b };
}

describe("xs router: reply association (RX2)", () => {
  it.each([
    [false, false, false],
    [false, false, true],
    [false, true, false],
    [false, true, true],
    [true, false, false],
    [true, false, true],
    [true, true, false],
    [true, true, true],
  ])(
    "hub=%s sender=%s target=%s: resolve AND ordinary send backfill only with all caps",
    async (hub, sender, target) => {
      const { r, a, b } = replyPair(sender, target, hub);
      const resolved = call(r, a.key, req({ op: "resolve", query: "beta" }))[0]!;
      const out = call(r, a.key, req({ op: "send", to: "beta", text: "ordinary" }));
      const d = lastDeliver(b.conn);
      expect(d).not.toHaveProperty("reply");
      expect(d).not.toHaveProperty("inReplyTo");
      await ack(r, b.key, d);
      const expected = {
        ref: B_ID.slice(0, 12),
        name: "beta",
        ...(hub && sender && target ? { sessionId: B_ID } : {}),
      };
      expect(resolved.target).toEqual(expected);
      expect(out[0]?.target).toEqual(expected);
    },
  );

  it.each(["expect", "replyTo"] as const)("%s requires an exact full sessionId, never a name/ref/prefix", (field) => {
    const { r, a, b } = replyPair();
    const extra = field === "expect" ? { expect: EXPECT } : { replyTo: REQUEST_ID };
    for (const to of ["beta", B_ID.slice(0, 12), B_ID.slice(0, 8), ` ${B_ID}`, "bad/id"]) {
      expect(call(r, a.key, req({ op: "send", to, text: "x", ...extra }))[0]).toMatchObject({
        code: "E_XS_BAD_FRAME",
        effect: "none",
      });
    }
    expect(b.conn.sent).toEqual([]);
    expect(r.relay.limits.snapshot().hubLastMin).toBe(0);
    r.registry.onClose(b.key, false);
    expect(call(r, a.key, req({ op: "send", to: B_ID, text: "x", ...extra }))[0]).toMatchObject({
      code: "E_XS_NO_TARGET",
    });
  });

  it.each(["expect", "replyTo"] as const)("%s still refuses duplicate effective holders", (field) => {
    const { r, a, b } = replyPair();
    const c = r.agent({ pid: 3, sessionId: B_ID, caps: REPLY_CAPS });
    const extra = field === "expect" ? { expect: EXPECT } : { replyTo: REQUEST_ID };
    expect(call(r, a.key, req({ op: "send", to: B_ID, text: "x", ...extra }))[0]).toMatchObject({
      code: "E_XS_AMBIGUOUS",
    });
    expect(b.conn.sent).toEqual([]);
    expect(c.conn.sent).toEqual([]);
    expect(r.relay.limits.snapshot().hubLastMin).toBe(0);
  });

  it.each([
    [false, true, true],
    [true, false, true],
    [true, true, false],
  ])("hub=%s sender=%s target=%s: reply fields fail unsupported before reservation", (hub, sender, target) => {
    const { r, a, b } = replyPair(sender, target, hub);
    for (const extra of [{ expect: EXPECT }, { replyTo: REQUEST_ID }]) {
      expect(call(r, a.key, req({ op: "send", to: B_ID, text: "x", ...extra }))[0]).toMatchObject({
        code: "E_XS_REPLY_UNSUPPORTED",
        effect: "none",
      });
    }
    expect(b.conn.sent).toEqual([]);
    expect(r.relay.limits.snapshot().hubLastMin).toBe(0);
  });

  it("validates op, exclusivity, requestId and timeout (inclusive 60s..24h) before reservation", async () => {
    const { r, a, b } = replyPair();
    const invalid: Partial<XsReqFrame>[] = [
      { op: "resolve", query: "beta", expect: EXPECT },
      { expect: EXPECT, replyTo: REQUEST_ID },
      { replyTo: "not-a-request" },
      { expect: { ...EXPECT, requestId: "wrong" } },
      ...[59_999, 86_400_001, 60_000.5, Number.NaN, Infinity].map((timeoutMs) => ({
        expect: { ...EXPECT, timeoutMs },
      })),
    ];
    for (const over of invalid) {
      expect(call(r, a.key, req({ op: "send", to: B_ID, text: "x", ...over }))[0]).toMatchObject({
        code: "E_XS_BAD_FRAME",
      });
    }
    expect(r.relay.limits.snapshot().hubLastMin).toBe(0);
    for (const timeoutMs of [60_000, 86_400_000]) {
      const out = call(
        r,
        a.key,
        req({ op: "send", to: B_ID, text: "request", expect: { ...EXPECT, timeoutMs }, wake: true, level: 2 }),
      );
      const d = lastDeliver(b.conn);
      expect(d.reply).toEqual({ requestId: REQUEST_ID, dueAt: r.clock.t + timeoutMs });
      expect(d).toMatchObject({ wake: true, level: 2 });
      expect(d).not.toHaveProperty("inReplyTo");
      await ack(r, b.key, d);
      expect(out[0]?.effect).toBe("applied");
      expect(r.log.lines.some((line) => (line.data as { reply?: string })?.reply === "expect")).toBe(true);
      expect(JSON.stringify(r.log.lines)).not.toContain(REQUEST_ID);
      r.clock.t += 5_000;
    }
  });

  it("replies mode hides list rows but remains resolvable; rejects unsolicited sends and expect without reserving", () => {
    const { r, a, b } = replyPair();
    r.registry.onFrame(b.key, memberFrame({ sessionId: B_ID, receive: "replies" }));
    expect(call(r, a.key, req({ op: "list" }))[0]?.rows).toEqual([]);
    expect(call(r, a.key, req({ op: "resolve", query: "beta" }))[0]?.target?.sessionId).toBe(B_ID);
    for (const extra of [{}, { expect: EXPECT }]) {
      expect(call(r, a.key, req({ op: "send", to: B_ID, text: "x", ...extra }))[0]).toMatchObject({
        effect: "none",
        reason: "rejected",
      });
    }
    expect(b.conn.sent).toEqual([]);
    expect(r.relay.limits.snapshot().hubLastMin).toBe(0);
  });

  it("replies pass replies mode, force wake=false and omit level even on a forged wake; pair interval is bypassed", async () => {
    const { r, a, b } = replyPair();
    r.registry.onFrame(b.key, memberFrame({ sessionId: B_ID, receive: "replies" }));
    for (let i = 0; i < 2; i++) {
      const out = call(
        r,
        a.key,
        req({ op: "send", to: B_ID, text: "answer", replyTo: REQUEST_ID, wake: true, level: 31 }),
      );
      const d = lastDeliver(b.conn);
      expect(d).toMatchObject({ wake: false, inReplyTo: REQUEST_ID });
      expect(d).not.toHaveProperty("level");
      expect(d).not.toHaveProperty("reply");
      await ack(r, b.key, d, { reason: "reply_late" });
      expect(out[0]).toMatchObject({ effect: "applied", reason: "reply_late", target: { sessionId: B_ID } });
    }
    expect(b.conn.sent.filter((f) => (f as { t?: string }).t === "xs_deliver")).toHaveLength(2);
    expect(r.relay.limits.snapshot().hubLastMin).toBe(2);
    expect(JSON.stringify(r.log.lines)).not.toContain("answer");
    expect(r.log.lines.some((line) => (line.data as { reply?: string })?.reply === "reply")).toBe(true);
  });

  it("off still rejects replies without reserving; target sessionId gate also applies to early rejects", () => {
    const { r, a, b } = replyPair();
    r.registry.onFrame(b.key, memberFrame({ sessionId: B_ID, receive: "off" }));
    expect(call(r, a.key, req({ op: "send", to: B_ID, text: "x", replyTo: REQUEST_ID }))[0]).toMatchObject({
      effect: "none",
      reason: "rejected",
      target: { sessionId: B_ID },
    });
    expect(b.conn.sent).toEqual([]);
    expect(r.relay.limits.snapshot().hubLastMin).toBe(0);
  });

  it("reply stamp counts towards the worst-case 16 KiB delivery budget", async () => {
    const { r, a, b } = replyPair();
    call(r, a.key, req({ op: "send", to: B_ID, text: "probe" }));
    const d = lastDeliver(b.conn);
    await ack(r, b.key, d);
    r.clock.t += 5_000;
    b.conn.sent.length = 0;
    // Fill the actual legacy worst-shape envelope exactly: adding reply must overflow.
    const envelope = JSON.stringify({ ...d, rid: "r".repeat(16), text: "", wake: true });
    const text = "x".repeat(16_384 - envelope.length);
    expect(call(r, a.key, req({ op: "send", to: B_ID, text, expect: EXPECT }))[0]).toMatchObject({
      code: "E_XS_TOO_LARGE",
    });
    expect(b.conn.sent).toEqual([]);
    expect(r.relay.limits.snapshot().hubLastMin).toBe(1);
    const ordinary = call(r, a.key, req({ op: "send", to: B_ID, text }));
    expect(lastDeliver(b.conn).text).toBe(text);
    await ack(r, b.key, lastDeliver(b.conn));
    expect(ordinary[0]?.effect).toBe("applied");
  });
});

describe("RX2: reply audit whitelist", () => {
  it("accepts only the fixed association enum and never logs body/requestId or forged metadata", () => {
    const r = rig();
    for (const reply of ["expect", "reply", "secret-body", REQUEST_ID]) {
      auditXs(r.log, {
        op: "send",
        textLen: 17,
        reply,
        text: "secret-body",
        requestId: REQUEST_ID,
      } as unknown as XsAuditRecord);
    }
    expect(r.log.lines.map((line) => line.data)).toEqual([
      { audit: "xs", op: "send", reply: "expect", textLen: 17 },
      { audit: "xs", op: "send", reply: "reply", textLen: 17 },
      { audit: "xs", op: "send", textLen: 17 },
      { audit: "xs", op: "send", textLen: 17 },
    ]);
    expect(JSON.stringify(r.log.lines)).not.toContain(REQUEST_ID);
    expect(JSON.stringify(r.log.lines)).not.toContain("secret-body");
  });
});
