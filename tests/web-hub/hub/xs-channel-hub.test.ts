import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as agentChannel from "../../../src/fabric/xs/channel.js";
import { auditXs } from "../../../src/web-hub/hub/audit.js";
import { normalizeHubCrossSessionConfig } from "../../../src/web-hub/hub/xs/limits.js";
import {
  hubChannelSet,
  hubIntersect,
  hubNormalizeChannel,
  hubSharedField,
  memberChannelsOf,
} from "../../../src/web-hub/hub/xs/members.js";
import type { XsAckFrame, XsDeliverFrame, XsReqFrame, XsResFrame } from "../../../src/web-hub/protocol/xs.js";
import { BCAST_LIMITS, CHANNEL_CAPS, rig, type Rig } from "./xs-fixtures.js";

/**
 * Channel-plan CH1 (§2.5/§3.2/§4.1): hub-side same-channel enforcement for list / resolve / send,
 * the unique-holder judgement on the FULL table before visibility (M3), the §3.2 no-write rules,
 * the `channels` op (Q7) and the `crossSession.channels` config re-check.
 */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

let seq = 0;
function req(over: Partial<XsReqFrame> & Pick<XsReqFrame, "op">, sessionId: string, epoch = 1): XsReqFrame {
  return { t: "xs_req", rid: `c${++seq}`, origin: { sessionId, epoch }, ...over };
}
function call(r: Rig, key: string, frame: XsReqFrame): XsResFrame[] {
  const out: XsResFrame[] = [];
  r.relay.router.handle(key, frame, (res) => out.push(res));
  return out;
}
const delivers = (conn: { sent: unknown[] }): XsDeliverFrame[] =>
  conn.sent.filter((x) => (x as { t?: string }).t === "xs_deliver") as XsDeliverFrame[];
async function ack(r: Rig, key: string, d: XsDeliverFrame, over: Partial<XsAckFrame> = {}): Promise<void> {
  r.registry.onFrame(key, { t: "xs_ack", rid: d.rid, xid: d.xid, effect: "applied", woke: false, ...over });
  await vi.advanceTimersByTimeAsync(0);
}

/** New (channel-capable) agent. */
function chAgent(r: Rig, pid: number, sessionId: string, channels: string[] | undefined, extra = {}) {
  return r.agent({
    pid,
    sessionId,
    name: sessionId.toLowerCase(),
    caps: CHANNEL_CAPS,
    limits: BCAST_LIMITS,
    ...(channels === undefined ? {} : { channels }),
    ...extra,
  });
}

describe("hub channel helpers mirror src/fabric/xs/channel.ts", () => {
  const corpus: unknown[] = [
    "team",
    "#team",
    "TEAM",
    "#Team_1",
    "default",
    "#default",
    "a-b",
    "-bad",
    "",
    "#",
    "##x",
    "x".repeat(32),
    "x".repeat(33),
    "\u212Aelvin",
    "ｔｅａｍ",
    "a b",
    "pi-x",
    "all",
    7,
    null,
    undefined,
  ];
  it("normalize is identical on a corpus (incl. homoglyphs, reserved names stay syntax-only)", () => {
    for (const c of corpus) expect(hubNormalizeChannel(c), String(c)).toBe(agentChannel.normalizeChannel(c));
  });
  it("set / intersect / shared-field rules are identical", () => {
    const sets = [[], ["default"], ["b", "default", "a"], ["a"], ["a", "b", "a"], ["z", "default"]];
    for (const a of sets) {
      expect(hubChannelSet(a)).toEqual(agentChannel.channelSet(a));
      for (const b of sets) {
        expect(hubIntersect(a, b)).toEqual(agentChannel.intersect(a, b));
        for (const cap of [true, false]) {
          expect(hubSharedField(hubIntersect(a, b), cap)).toEqual(
            agentChannel.sharedFieldToWrite(agentChannel.intersect(a, b), cap),
          );
        }
      }
    }
  });
  it("member channel derivation (§2.5): absent ⇒ joined?[default]:[]; joined:false wins; all-invalid ⇒ []", () => {
    expect(memberChannelsOf({ joined: true })).toEqual(["default"]);
    expect(memberChannelsOf({ joined: false })).toEqual([]);
    expect(memberChannelsOf({ joined: false, channels: ["a"] })).toEqual([]);
    expect(memberChannelsOf({ joined: true, channels: ["#B", "a", "default", "a"] })).toEqual(["default", "a", "b"]);
    expect(memberChannelsOf({ joined: true, channels: ["ｔｅａｍ", "-x"] })).toEqual([]);
    expect(memberChannelsOf({ joined: true, channels: [] })).toEqual([]);
    expect(memberChannelsOf({ joined: true, channels: ["a", "b", "c", "d", "e"] })).toEqual(["a", "b", "c", "d"]);
  });
  it("an xs_member whose channels are all invalid is NOT joined (fail closed, never widened to default)", () => {
    const r = rig();
    const a = chAgent(r, 1, "sess-AAAAAAAA", ["ＢＡＤ"]);
    expect(r.relay.members.effective(a.key)).toMatchObject({ joined: false, channels: [] });
  });
});

describe("§4.1 list: visibility = shared channel (union)", () => {
  it("A[a,b] sees B[a] and D[b]; B sees neither D nor C[default]; C sees only default peers", () => {
    const r = rig();
    const a = chAgent(r, 1, "sess-AAAAAAAA", ["a", "b"]);
    const b = chAgent(r, 2, "sess-BBBBBBBB", ["a"]);
    const c = chAgent(r, 3, "sess-CCCCCCCC", undefined); // default-only (new agent)
    chAgent(r, 4, "sess-DDDDDDDD", ["b"]);
    const old = r.agent({ pid: 5, sessionId: "sess-OOOOOOOO", name: "old" }); // old agent ⇒ [default]
    const refs = (key: string, sid: string) =>
      (call(r, key, req({ op: "list" }, sid))[0]!.rows ?? []).map((row) => row.ref).sort();
    expect(refs(a.key, "sess-AAAAAAAA")).toEqual(["sess-BBBBBBB", "sess-DDDDDDD"]);
    expect(refs(b.key, "sess-BBBBBBBB")).toEqual(["sess-AAAAAAA"]);
    expect(refs(c.key, "sess-CCCCCCCC")).toEqual(["sess-OOOOOOO"]);
    expect(refs(old.key, "sess-OOOOOOOO")).toEqual(["sess-CCCCCCC"]);
  });

  it("rows[].channels = shared set, written only for a channel-capable requester and never for [default]", () => {
    const r = rig();
    const a = chAgent(r, 1, "sess-AAAAAAAA", ["default", "a", "b"]);
    chAgent(r, 2, "sess-BBBBBBBB", ["a", "default"]);
    chAgent(r, 3, "sess-CCCCCCCC", undefined);
    const old = r.agent({ pid: 4, sessionId: "sess-OOOOOOOO", name: "old" });
    const rows = call(r, a.key, req({ op: "list" }, "sess-AAAAAAAA"))[0]!.rows!;
    const byRef = Object.fromEntries(rows.map((row) => [row.ref, row]));
    expect(byRef["sess-BBBBBBB"]!.channels).toEqual(["default", "a"]);
    expect("channels" in byRef["sess-CCCCCCC"]!).toBe(false); // shared = [default]
    expect("channels" in byRef["sess-OOOOOOO"]!).toBe(false);
    // the old (non-channel-capable) requester never sees the key, even for a [default,a] peer
    const oldRows = call(r, old.key, req({ op: "list" }, "sess-OOOOOOOO"))[0]!.rows!;
    expect(oldRows.map((row) => row.ref).sort()).toEqual(["sess-AAAAAAA", "sess-BBBBBBB", "sess-CCCCCCC"]);
    for (const row of oldRows) expect("channels" in row).toBe(false);
  });

  it("list channel filter: must be one of MY channels (else E_XS_BAD_TARGET reason:channel)", () => {
    const r = rig();
    const a = chAgent(r, 1, "sess-AAAAAAAA", ["default", "a"]);
    chAgent(r, 2, "sess-BBBBBBBB", ["a"]);
    chAgent(r, 3, "sess-CCCCCCCC", undefined);
    const rows = call(r, a.key, req({ op: "list", channel: "#A" }, "sess-AAAAAAAA"))[0]!.rows!;
    expect(rows.map((row) => row.ref)).toEqual(["sess-BBBBBBB"]);
    for (const bad of ["zz", "ｔｅａｍ", "-x"]) {
      expect(call(r, a.key, req({ op: "list", channel: bad }, "sess-AAAAAAAA"))[0]).toMatchObject({
        ok: false,
        code: "E_XS_BAD_TARGET",
        reason: "channel",
        effect: "none",
      });
    }
  });

  it("a not-joined requester (no channel) sees nobody", () => {
    const r = rig();
    const a = chAgent(r, 1, "sess-AAAAAAAA", undefined, { joined: false });
    chAgent(r, 2, "sess-BBBBBBBB", undefined);
    expect(call(r, a.key, req({ op: "list" }, "sess-AAAAAAAA"))[0]).toMatchObject({ ok: true, rows: [] });
  });
});

describe("§4.1 resolve / send: same-channel + M3 unique holder on the full table", () => {
  it("a target sharing no channel is NO_TARGET for resolve and send (indistinguishable from absent)", () => {
    const r = rig();
    const a = chAgent(r, 1, "sess-AAAAAAAA", ["a"]);
    const c = chAgent(r, 2, "sess-CCCCCCCC", undefined);
    for (const [key, sid, to] of [
      [a.key, "sess-AAAAAAAA", "sess-CCCCCCCC"],
      [c.key, "sess-CCCCCCCC", "sess-AAAAAAAA"],
    ] as const) {
      expect(call(r, key, req({ op: "resolve", query: to }, sid))[0]).toMatchObject({ code: "E_XS_NO_TARGET" });
      expect(call(r, key, req({ op: "send", to, text: "x" }, sid))[0]).toMatchObject({ code: "E_XS_NO_TARGET" });
    }
    expect(delivers(c.conn)).toHaveLength(0);
  });

  it("reply exact-id branch: an invisible full sessionId is NO_TARGET (Q4)", () => {
    const r = rig();
    const a = chAgent(r, 1, "sess-AAAAAAAA", ["a"]);
    chAgent(r, 2, "sess-CCCCCCCC", undefined);
    expect(
      call(
        r,
        a.key,
        req({ op: "send", to: "sess-CCCCCCCC", text: "ans", replyTo: "q0123456789abcdef01" }, "sess-AAAAAAAA"),
      )[0],
    ).toMatchObject({ ok: false, code: "E_XS_NO_TARGET", effect: "none" });
  });

  it.each([
    ["other channel", { channels: ["b"] }],
    ["receive off", { channels: ["a"], receive: "off" }],
    ["receive replies", { channels: ["a"], receive: "replies" }],
    ["no channel cap (old agent, default-only)", { caps: ["ev.v1", "xs.v1"] }],
  ] as const)(
    "cross-table double holder (%s) ⇒ E_XS_AMBIGUOUS, candidates expose only the visible holder",
    (_l, other) => {
      const r = rig();
      const a = chAgent(r, 1, "sess-AAAAAAAA", ["default", "a"]);
      chAgent(r, 2, "sess-TTTTTTTT", ["a"]);
      // the second socket holding the same sessionId — invisible or not receivable for A
      // (the old-agent variant reads as [default] ⇒ visible to A; still ambiguous by the table)
      const o = other as { channels?: readonly string[]; receive?: "off" | "replies"; caps?: readonly string[] };
      r.agent({
        pid: 3,
        sessionId: "sess-TTTTTTTT",
        name: "shadow",
        caps: [...(o.caps ?? CHANNEL_CAPS)],
        ...(o.channels === undefined ? {} : { channels: [...o.channels] }),
        ...(o.receive === undefined ? {} : { receive: o.receive }),
      });
      for (const op of ["resolve", "send"] as const) {
        const out = call(
          r,
          a.key,
          req({ op, query: "sess-TTTTTTTT", to: "sess-TTTTTTTT", text: "x" }, "sess-AAAAAAAA"),
        )[0]!;
        expect(out).toMatchObject({ ok: false, code: "E_XS_AMBIGUOUS", effect: "none" });
        expect(out.candidates).toHaveLength(1);
        expect(out.candidates![0]!.ref).toBe("sess-TTTTTTT");
        expect(JSON.stringify(out)).not.toContain("shadow");
      }
    },
  );

  it("send stamps via = shared set only towards a channel-capable target, never for [default]", async () => {
    const r = rig();
    const a = chAgent(r, 1, "sess-AAAAAAAA", ["default", "a"]);
    const b = chAgent(r, 2, "sess-BBBBBBBB", ["a"]);
    const c = chAgent(r, 3, "sess-CCCCCCCC", ["default", "a"]);
    const d = chAgent(r, 4, "sess-DDDDDDDD", undefined);
    const old = r.agent({ pid: 5, sessionId: "sess-OOOOOOOO", name: "old" });
    for (const [t, conn] of [
      ["sess-BBBBBBBB", b.conn],
      ["sess-CCCCCCCC", c.conn],
      ["sess-DDDDDDDD", d.conn],
      ["sess-OOOOOOOO", old.conn],
    ] as const) {
      r.clock.t += 6_000;
      call(r, a.key, req({ op: "send", to: t, text: "hi" }, "sess-AAAAAAAA"));
      const f = delivers(conn).at(-1)!;
      await ack(
        r,
        t === "sess-OOOOOOOO" ? old.key : t === "sess-DDDDDDDD" ? d.key : t === "sess-CCCCCCCC" ? c.key : b.key,
        f,
      );
    }
    expect(delivers(b.conn)[0]!.via).toEqual(["a"]);
    expect(delivers(c.conn)[0]!.via).toEqual(["default", "a"]);
    expect("via" in delivers(d.conn)[0]!).toBe(false);
    expect("via" in delivers(old.conn)[0]!).toBe(false);
    for (const conn of [b.conn, c.conn, d.conn, old.conn]) expect("bc" in delivers(conn)[0]!).toBe(false);
  });

  it("the channel field on resolve/send/info/channels and the new ops from an old agent are BAD_FRAME", () => {
    const r = rig();
    const a = chAgent(r, 1, "sess-AAAAAAAA", ["a"]);
    const old = r.agent({ pid: 2, sessionId: "sess-OOOOOOOO" });
    for (const op of ["resolve", "send", "info", "channels"] as const) {
      expect(
        call(r, a.key, req({ op, channel: "a", to: "x", query: "x", text: "t" }, "sess-AAAAAAAA"))[0],
      ).toMatchObject({
        code: "E_XS_BAD_FRAME",
      });
    }
    for (const op of ["broadcast", "channels"] as const) {
      expect(call(r, old.key, req({ op, channel: "a", text: "t" }, "sess-OOOOOOOO"))[0]).toMatchObject({
        code: "E_XS_BAD_FRAME",
        effect: "none",
      });
    }
  });
});

describe("§4.1 op:channels (Q7)", () => {
  it("names + logical-session counts of every effective joined member, mine flagged; costs listPerMin", () => {
    const r = rig();
    const a = chAgent(r, 1, "sess-AAAAAAAA", ["default", "a"], { limits: { ...BCAST_LIMITS, listPerMin: 2 } });
    chAgent(r, 2, "sess-BBBBBBBB", ["a", "b"]);
    chAgent(r, 3, "sess-CCCCCCCC", undefined);
    r.agent({ pid: 4, sessionId: "sess-OOOOOOOO" }); // old ⇒ default
    r.agent({ pid: 5, sessionId: "sess-OOOOOOOO" }); // second holder of the same session: counted once
    chAgent(r, 6, "sess-XXXXXXXX", undefined, { joined: false });
    const out = call(r, a.key, req({ op: "channels" }, "sess-AAAAAAAA"))[0]!;
    expect(out).toEqual({
      t: "xs_res",
      rid: expect.any(String),
      ok: true,
      channels: [
        { name: "default", members: 3, joined: true },
        { name: "a", members: 2, joined: true },
        { name: "b", members: 1, joined: false },
      ],
    });
    call(r, a.key, req({ op: "list" }, "sess-AAAAAAAA"));
    expect(call(r, a.key, req({ op: "channels" }, "sess-AAAAAAAA"))[0]).toMatchObject({ code: "E_XS_RATE_LIMITED" });
  });

  it("a not-joined (but effective, channel-capable) member may list channels", () => {
    const r = rig();
    const x = chAgent(r, 1, "sess-XXXXXXXX", undefined, { joined: false });
    chAgent(r, 2, "sess-BBBBBBBB", ["a"]);
    expect(call(r, x.key, req({ op: "channels" }, "sess-XXXXXXXX"))[0]!.channels).toEqual([
      { name: "a", members: 1, joined: false },
    ]);
  });
});

describe("HubConfig.crossSession.channels re-check (§3.1)", () => {
  it("valid params are kept; any invalid value drops the sub-key alone; absence stays absent", () => {
    const base = { limits: { hubSendsPerMin: 60 } };
    expect(normalizeHubCrossSessionConfig(base)).toEqual(base);
    expect(normalizeHubCrossSessionConfig({ ...base, channels: { maxRecipients: 16, wakeMaxRecipients: 4 } })).toEqual({
      ...base,
      channels: { maxRecipients: 16, wakeMaxRecipients: 4 },
    });
    for (const bad of [
      null,
      [],
      "x",
      { maxRecipients: 16 },
      { maxRecipients: 0, wakeMaxRecipients: 4 },
      { maxRecipients: 33, wakeMaxRecipients: 4 },
      { maxRecipients: 16, wakeMaxRecipients: 5 },
      { maxRecipients: 16, wakeMaxRecipients: 1.5 },
      { maxRecipients: "16", wakeMaxRecipients: 4 },
    ]) {
      expect(normalizeHubCrossSessionConfig({ ...base, reply: false, channels: bad })).toEqual({
        ...base,
        reply: false,
      });
    }
    expect(
      normalizeHubCrossSessionConfig({ ...base, channels: { maxRecipients: 2, wakeMaxRecipients: 0, x: 1 } }),
    ).toEqual({
      ...base,
      channels: { maxRecipients: 2, wakeMaxRecipients: 0 },
    });
  });
});

describe("audit (§5.2 step 8): new keys are whitelisted, tail-appended", () => {
  it("bcast / recipients survive the filter, everything else unchanged", () => {
    const lines: unknown[] = [];
    auditXs({ info: (_m, d) => lines.push(d) }, { op: "broadcast", recipients: 3, bcast: true, outcome: "applied" });
    auditXs(
      { info: (_m, d) => lines.push(d) },
      {
        op: "send",
        recipients: Number.NaN,
        bcast: "yes" as unknown as boolean,
      },
    );
    expect(lines).toEqual([
      { audit: "xs", op: "broadcast", outcome: "applied", bcast: true, recipients: 3 },
      { audit: "xs", op: "send" },
    ]);
  });
});
