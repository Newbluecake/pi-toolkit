/**
 * alias-plan r4 §4/§5/§9 AL3: the agent-side alias bridge + cache over a REAL `Connection` on the fake socket
 * (no hub process): zero-frame guards, op frame shapes, 5s deadline, reconcile on every hello_ack, stale-reply
 * discard (old link / switched session), FIFO ≤8, process-wide one-shot lost notice, status projection + slot flush.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireConnection,
  type AcquireOptions,
  type BindingPort,
  type HubConnection,
} from "../../../src/web-hub/agent/connection.js";
import { createXsAgentBridge, type XsAgentBridge, type XsAgentPort } from "../../../src/web-hub/agent/xs.js";
import {
  XS_AGENT_CAPS,
  XS_ALIAS_AGENT_CAP,
  XS_ALIAS_HUB_CAP,
  XS_ALIAS_V2_AGENT_CAP,
  XS_HUB_CAP,
} from "../../../src/web-hub/protocol/xs.js";
import { P2_HUB_CAPS, VERSION_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import type { XsAliasStateWire, XsMemberLimitsWire } from "../../../src/web-hub/protocol/xs.js";
import { ackFrame, fakeNet, pathsIn, resetGlobals, SETTINGS, tmpDir, type FakeSocket } from "./helpers.js";

let tmp: ReturnType<typeof tmpDir>;
beforeEach(() => {
  tmp = tmpDir();
  resetGlobals();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:xs-alias-lost")];
  vi.useFakeTimers();
});
afterEach(() => {
  resetGlobals();
  vi.useRealTimers();
  tmp.cleanup();
});

function opts(over: Partial<AcquireOptions> = {}): AcquireOptions {
  return {
    buildId: "1.0.0@abc",
    pluginVersion: "1.0.0",
    kind: "tui",
    cwd: "/tmp/wa",
    paths: pathsIn(tmp.dir),
    settings: SETTINGS,
    launcher: { error: "no loader in tests" },
    now: () => Date.now(),
    random: () => 0.5,
    ...over,
  };
}

const LIMITS: XsMemberLimitsWire = {
  sendsOutPerMin: 10,
  sendsOutPerHour: 60,
  wakesOutPerHour: 6,
  pairMinIntervalMs: 30_000,
  pairWakesPerHour: 2,
  inFlightPerSession: 4,
  listPerMin: 6,
};
const SESSION = {
  sessionId: "sess-aaaaaaaaaaaa",
  sessionFile: "/tmp/s1.jsonl",
  cwd: "/tmp/wa",
  reason: "startup",
  leafId: "e1",
  mode: "tui",
} as const;
const BASE = [...P2_HUB_CAPS, VERSION_HUB_CAP, XS_HUB_CAP];
const WITH_ALIAS = [...BASE, XS_ALIAS_HUB_CAP];

interface Rig {
  conn: HubConnection;
  net: ReturnType<typeof fakeNet>;
  bridge: XsAgentBridge;
  state: { sessionId: string };
  notices: string[];
  publishes: { n: number };
}

function rig(opt: { aliasOn?: boolean; caps?: string[]; connect?: boolean } = {}): Rig {
  const n = fakeNet();
  const conn = acquireConnection(opts({ netConnect: n.netConnect }));
  const state = { sessionId: "sess-aaaaaaaaaaaa" };
  const notices: string[] = [];
  const publishes = { n: 0 };
  const stack = {
    sessionId: () => state.sessionId,
    member: () => ({ epoch: 3, joined: true, receive: "wake" as const }),
    deliver: () => ({ effect: "none" as const, reason: "rejected" as const, woke: false }),
    status: () => ({ joined: true, receive: "wake" as const, blocked: 0 }),
  };
  const port: XsAgentPort = {
    stack: () => stack,
    memberLimits: () => ({ ...LIMITS }),
    hubSendsPerMin: () => 60,
    ...(opt.aliasOn === false ? {} : { aliasEnabled: () => true }),
    notifyAliasLost: (t) => notices.push(t),
  };
  const bridge = createXsAgentBridge({ port, conn: () => conn, publishStatus: () => void publishes.n++ });
  const binding: BindingPort = {
    onStateChange: () => undefined,
    onSnapshotReq: () => undefined,
    onBranchReq: () => undefined,
    onHubCaps: () => {
      bridge.publishMember();
      bridge.onHubCapsAlias();
    },
  };
  conn.attach(binding, SESSION as never);
  if (opt.connect !== false) {
    const s = n.sockets[0]!;
    s.emit("connect");
    s.hub(ackFrame("k", 4242, opt.caps ?? WITH_ALIAS));
  }
  return { conn, net: n, bridge, state, notices, publishes };
}

const aliasReqs = (s: FakeSocket): Array<Record<string, unknown>> =>
  s.frames().filter((f) => f.t === "xs_req" && f.op === "alias");
const reply = (s: FakeSocket, req: Record<string, unknown>, alias: unknown): void =>
  s.hub({ t: "xs_res", rid: String(req.rid), ok: true, alias } as never);
const flush = async (): Promise<void> => void (await vi.advanceTimersByTimeAsync(0));

describe("caps + zero-frame guards", () => {
  it("alias off ⇒ caps byte-equal XS_AGENT_CAPS, no frame ever, supported=false", async () => {
    const r = rig({ aliasOn: false });
    const s = r.net.sockets[0]!;
    expect(r.bridge.caps()).toEqual(XS_AGENT_CAPS);
    expect(r.bridge.aliasBridge().supported).toBe(false);
    expect(await r.bridge.aliasBridge().set("前端")).toMatchObject({ ok: false, code: "E_XS_OFF" });
    await r.bridge.aliasCache().reconcile();
    expect(aliasReqs(s)).toHaveLength(0);
    expect(r.bridge.hubCrossSessionConfig()).toEqual({ limits: { hubSendsPerMin: 60 } });
  });

  it("alias on ⇒ v1 cap appended after the frozen set, v2 immediately after v1 (alias-force-default §3.1)", () => {
    const r = rig();
    expect(r.bridge.caps()).toEqual([...XS_AGENT_CAPS, XS_ALIAS_AGENT_CAP, XS_ALIAS_V2_AGENT_CAP]);
  });

  it("hub without xs.alias.v1 ⇒ nothing sent on hello_ack nor any op", async () => {
    const r = rig({ caps: BASE });
    const s = r.net.sockets[0]!;
    const b = r.bridge.aliasBridge();
    expect(b.supported).toBe(false);
    expect(r.bridge.aliasCache().usable).toBe(false);
    expect(await b.get()).toMatchObject({ ok: false, code: "E_XS_OFF", reason: "hub" });
    expect(await b.take("x", "k0123456789abcdef")).toMatchObject({ ok: false, code: "E_XS_OFF" });
    expect(aliasReqs(s)).toHaveLength(0);
  });

  it("hubCrossSessionConfig carries clamped alias params only while alias on", () => {
    const n = fakeNet();
    const conn = acquireConnection(opts({ netConnect: n.netConnect }));
    const mk = (on: boolean) =>
      createXsAgentBridge({
        port: {
          stack: () => undefined,
          memberLimits: () => ({ ...LIMITS }),
          hubSendsPerMin: () => 60,
          aliasEnabled: () => on,
          aliasHubConfig: () => ({ offlineLeaseH: 9999, coolMin: 0, takeMinOfflineMin: 1 }),
        },
        conn: () => conn,
      });
    expect(mk(true).hubCrossSessionConfig().alias).toEqual({ offlineLeaseH: 720, coolMin: 1, takeMinOfflineMin: 10 });
    expect(mk(false).hubCrossSessionConfig().alias).toBeUndefined();
  });
});

describe("op frames (§3.4/§3.5) + deadline", () => {
  it("get / set / clear / preview / take frame shapes; set success updates the cache + status", async () => {
    const r = rig();
    const s = r.net.sockets[0]!;
    await flush(); // hello_ack reconcile get
    const before = aliasReqs(s).length;
    expect(before).toBe(1);
    reply(s, aliasReqs(s)[0]!, { state: "none" });
    await flush();

    const pSet = r.bridge.aliasBridge().set("前端");
    await flush();
    const setReq = aliasReqs(s)[1]!;
    expect(setReq).toMatchObject({
      t: "xs_req",
      op: "alias",
      alias: "前端",
      origin: { sessionId: "sess-aaaaaaaaaaaa", epoch: 3 },
    });
    expect(setReq.clear).toBeUndefined();
    reply(s, setReq, { alias: "前端", state: "held" });
    expect(await pSet).toEqual({ ok: true, res: { alias: "前端", state: "held" } });
    expect(r.bridge.aliasCache().current()).toEqual({ alias: "前端" });
    expect(r.bridge.statusProjection()).toMatchObject({ alias: "前端" });
    expect(r.publishes.n).toBeGreaterThan(0);

    const pClr = r.bridge.aliasBridge().clear();
    await flush();
    const clr = aliasReqs(s)[2]!;
    expect(clr).toMatchObject({ clear: true });
    expect(clr.alias).toBeUndefined();
    reply(s, clr, { state: "none" });
    await pClr;
    expect(r.bridge.aliasCache().current()).toEqual({});
    expect(r.bridge.statusProjection()).not.toHaveProperty("alias");

    const pPrev = r.bridge.aliasBridge().takePreview("前端");
    await flush();
    const prev = aliasReqs(s)[3]!;
    expect(prev).toMatchObject({ alias: "前端", take: "preview" });
    const preview = { take: { cwdLabel: "~/x", offlineForS: 700, token: "k0123456789abcdef", expiresAt: 5 } };
    reply(s, prev, preview);
    expect(await pPrev).toEqual({ ok: true, res: preview });
    expect(r.bridge.aliasCache().current()).toEqual({}); // preview never touches the cache

    const pTake = r.bridge.aliasBridge().take("前端", "k0123456789abcdef");
    await flush();
    expect(aliasReqs(s)[4]).toMatchObject({ alias: "前端", take: "k0123456789abcdef" });
    reply(s, aliasReqs(s)[4]!, { alias: "前端", state: "held" });
    await pTake;
    expect(r.bridge.aliasCache().current()).toEqual({ alias: "前端" });
  });

  it("hub error codes pass through verbatim (brace suffix kept)", async () => {
    const r = rig();
    const s = r.net.sockets[0]!;
    await flush();
    const p = r.bridge.aliasBridge().set("web");
    await flush();
    s.hub({ t: "xs_res", rid: String(aliasReqs(s)[1]!.rid), ok: false, code: "E_XS_ALIAS_TAKEN{confusable}" } as never);
    expect(await p).toEqual({ ok: false, code: "E_XS_ALIAS_TAKEN{confusable}" });
  });

  it("5s client deadline: read ⇒ E_XS_DEADLINE, write ⇒ E_XS_ALIAS_UNKNOWN (effect unknown)", async () => {
    const r = rig();
    await flush();
    const pr = r.bridge.aliasBridge().get();
    const pw = r.bridge.aliasBridge().set("前端");
    await vi.advanceTimersByTimeAsync(4_999);
    let settled = false;
    void pr.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await pr).toMatchObject({ ok: false, code: "E_XS_DEADLINE" });
    expect(await pw).toMatchObject({ ok: false, code: "E_XS_ALIAS_UNKNOWN", reason: "client_deadline" });
  });
});

describe("reconcile (§4/R2) — hello_ack, reconnect, stale replies", () => {
  it("every hello_ack issues one get; reconnect re-reconciles from fresh hub state", async () => {
    const r = rig();
    const s1 = r.net.sockets[0]!;
    await flush();
    expect(aliasReqs(s1)).toHaveLength(1);
    expect(aliasReqs(s1)[0]).toMatchObject({ op: "alias" });
    expect(aliasReqs(s1)[0]!.alias).toBeUndefined();
    reply(s1, aliasReqs(s1)[0]!, { alias: "前端", state: "held" });
    await flush();
    expect(r.bridge.aliasCache().current()).toEqual({ alias: "前端" });

    s1.fail("ECONNRESET");
    for (let i = 0; i < 40 && r.net.sockets.length < 2; i++) await vi.advanceTimersByTimeAsync(100);
    const s2 = r.net.sockets[1]!;
    s2.emit("connect");
    s2.hub(ackFrame("k", 4242, WITH_ALIAS)); // hub restarted: binding lost while we were away
    await flush();
    expect(aliasReqs(s2)).toHaveLength(1);
    reply(s2, aliasReqs(s2)[0]!, { state: "none", lost: { alias: "前端", reason: "taken", at: 111 } });
    await flush();
    expect(r.bridge.aliasCache().current()).toEqual({ lostAt: 111 }); // local alias cleared
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toContain("前端");
    expect(r.bridge.statusProjection()).not.toHaveProperty("alias");
  });

  it("a reply arriving after the link was replaced is discarded (old connection generation)", async () => {
    const r = rig();
    const s1 = r.net.sockets[0]!;
    await flush();
    const oldReq = aliasReqs(s1)[0]!;
    s1.fail("ECONNRESET");
    for (let i = 0; i < 40 && r.net.sockets.length < 2; i++) await vi.advanceTimersByTimeAsync(100);
    const s2 = r.net.sockets[1]!;
    s2.emit("connect");
    s2.hub(ackFrame("k", 4242, WITH_ALIAS));
    await flush();
    // a late xs_res for the dead link's rid can never resolve it (pending rejected on teardown)
    reply(s1, oldReq, { alias: "旧", state: "held" });
    reply(s2, oldReq, { alias: "旧", state: "held" });
    await flush();
    expect(r.bridge.aliasCache().current()).toBeUndefined();
    reply(s2, aliasReqs(s2)[0]!, { alias: "新", state: "held" });
    await flush();
    expect(r.bridge.aliasCache().current()).toEqual({ alias: "新" });
  });

  it("session switched mid-flight ⇒ reply not applied to either session; switching back re-reconciles by sessionId", async () => {
    const r = rig();
    const s = r.net.sockets[0]!;
    await flush();
    reply(s, aliasReqs(s)[0]!, { alias: "前端", state: "held" });
    await flush();
    expect(r.bridge.aliasCache().current()).toEqual({ alias: "前端" });

    const p = r.bridge.aliasCache().reconcile();
    await flush();
    r.state.sessionId = "sess-bbbbbbbbbbbb"; // /new or fork: new sessionId before the reply lands
    reply(s, aliasReqs(s)[1]!, { alias: "别的", state: "held" });
    await p;
    expect(r.bridge.aliasCache().current()).toBeUndefined(); // new session: nothing cached
    r.state.sessionId = "sess-aaaaaaaaaaaa"; // switch back: the old entry was never overwritten
    expect(r.bridge.aliasCache().current()).toEqual({ alias: "前端" });

    // /new: reconcile for the new id returns none
    r.state.sessionId = "sess-bbbbbbbbbbbb";
    void r.bridge.aliasCache().reconcile();
    await flush();
    reply(s, aliasReqs(s)[2]!, { state: "none" });
    await flush();
    expect(r.bridge.aliasCache().current()).toEqual({});
    expect(aliasReqs(s)[2]!.origin).toMatchObject({ sessionId: "sess-bbbbbbbbbbbb" });
  });

  it("failed reconcile (hub error / deadline) leaves the cache untouched and never throws", async () => {
    const r = rig();
    const s = r.net.sockets[0]!;
    await flush();
    reply(s, aliasReqs(s)[0]!, { alias: "前端", state: "held" });
    await flush();
    const p = r.bridge.aliasCache().reconcile();
    await flush();
    s.hub({ t: "xs_res", rid: String(aliasReqs(s)[1]!.rid), ok: false, code: "E_XS_ALIAS_BUSY{io}" } as never);
    await expect(p).resolves.toBeUndefined();
    expect(r.bridge.aliasCache().current()).toEqual({ alias: "前端" });
    const p2 = r.bridge.aliasCache().reconcile();
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(p2).resolves.toBeUndefined();
    expect(r.bridge.aliasCache().current()).toEqual({ alias: "前端" });
  });

  it("cache is FIFO-bounded at 8 sessions", async () => {
    const r = rig();
    const s = r.net.sockets[0]!;
    await flush();
    reply(s, aliasReqs(s)[0]!, { state: "none" });
    await flush();
    for (let i = 0; i < 9; i++) {
      r.state.sessionId = `sess-${String(i).padStart(12, "0")}`;
      void r.bridge.aliasCache().reconcile();
      await flush();
      reply(s, aliasReqs(s).at(-1)!, { alias: `a${i}`, state: "held" });
      await flush();
    }
    // the very first (sess-aaaa…) and sess-000…0 were evicted; the last 8 remain
    r.state.sessionId = "sess-000000000000";
    expect(r.bridge.aliasCache().current()).toBeUndefined();
    r.state.sessionId = "sess-000000000008";
    expect(r.bridge.aliasCache().current()).toEqual({ alias: "a8" });
  });
});

describe("one-shot lost notice (Q3)", () => {
  it("same (sessionId, lost.at) notifies once per process — across a rebuilt bridge (/reload); a new `at` notifies again", async () => {
    const lost = { alias: "前端", reason: "expired" as const, at: 222 };
    const r1 = rig();
    const s1 = r1.net.sockets[0]!;
    await flush();
    reply(s1, aliasReqs(s1)[0]!, { state: "none", lost });
    await flush();
    void r1.bridge.aliasCache().reconcile();
    await flush();
    reply(s1, aliasReqs(s1)[1]!, { state: "none", lost });
    await flush();
    expect(r1.notices).toHaveLength(1);
    expect(r1.notices[0]).toContain("离线");

    // /reload: new bridge, empty cache, same process-level de-dup set
    resetGlobalsKeepLost();
    const r2 = rig();
    const s2 = r2.net.sockets[0]!;
    await flush();
    reply(s2, aliasReqs(s2)[0]!, { state: "none", lost });
    await flush();
    expect(r2.notices).toHaveLength(0);
    expect(r2.bridge.aliasCache().current()).toEqual({ lostAt: 222 }); // cache itself is per bridge

    void r2.bridge.aliasCache().reconcile();
    await flush();
    reply(s2, aliasReqs(s2)[1]!, { state: "none", lost: { ...lost, at: 333 } });
    await flush();
    expect(r2.notices).toHaveLength(1);
  });

  it("dedup set is capped at 64 keys", async () => {
    const r = rig();
    const s = r.net.sockets[0]!;
    await flush();
    reply(s, aliasReqs(s)[0]!, { state: "none" });
    await flush();
    for (let i = 0; i < 70; i++) {
      void r.bridge.aliasCache().reconcile();
      await flush();
      reply(s, aliasReqs(s).at(-1)!, { state: "none", lost: { alias: "x", reason: "taken", at: 1000 + i } });
      await flush();
    }
    const set = (globalThis as Record<symbol, Set<string>>)[Symbol.for("pi-subagent:xs-alias-lost")]!;
    expect(set.size).toBe(64);
    expect(r.notices).toHaveLength(70);
  });
});

/** `resetGlobals` + a fresh tmp for a second rig, preserving ONLY the lost de-dup set. */
function resetGlobalsKeepLost(): void {
  const key = Symbol.for("pi-subagent:xs-alias-lost");
  const keep = (globalThis as Record<symbol, unknown>)[key];
  resetGlobals();
  (globalThis as Record<symbol, unknown>)[key] = keep;
}

describe("status slot (§7.2)", () => {
  it("StatusInfo.xs.alias only while usable; slotFlush strips it toward a hub without the cap (replay-safe)", async () => {
    const r = rig();
    const s = r.net.sockets[0]!;
    await flush();
    reply(s, aliasReqs(s)[0]!, { alias: "前端", state: "held" });
    await flush();
    const xs = r.bridge.statusProjection()!;
    expect(xs.alias).toBe("前端");
    const frame = { t: "status", xs } as never;
    expect((r.bridge.slotFlush(frame, WITH_ALIAS) as { xs: { alias?: string } }).xs.alias).toBe("前端");
    expect((r.bridge.slotFlush(frame, BASE) as { xs: { alias?: string } }).xs).toEqual({
      joined: true,
      receive: "wake",
      blocked: 0,
    });
    // input frame untouched (stored frame stays raw)
    expect((frame as { xs: { alias?: string } }).xs.alias).toBe("前端");
  });

  it("alias off ⇒ projection and flush are byte-identical to the pre-alias shape", () => {
    const r = rig({ aliasOn: false });
    const xs = r.bridge.statusProjection()!;
    expect(xs).toEqual({ joined: true, receive: "wake", blocked: 0 });
    const frame = { t: "status", xs } as never;
    expect(r.bridge.slotFlush(frame, WITH_ALIAS)).toBe(frame);
  });
});
