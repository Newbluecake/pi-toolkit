/**
 * alias-force-default plan §5.1/§5.4 (AF3, #72): the agent-side alias v2 bridge over a REAL `Connection`
 * on the fake socket (no hub process) —
 *  - the `xs.alias.v2` cap immediately after v1; intent ops (`auto`/`forcePreview`/`handoff`) framed only
 *    toward a v2 hub (a v1 hub gets ZERO intent frames and a local `E_XS_OFF{hub-v2}`);
 *  - the cwd-basename auto-claim engine at the end of a reconcile: only after an APPLIED `none` get,
 *    one attempt per `(connGen, sessionId, membershipEpoch)`, join re-arms, BUSY{queue|io} gets exactly
 *    one 1–5s retry (unref'd timer), skip reasons recorded for `/fabric status`;
 *  - the one-shot auto notice in its OWN process set (`pi-subagent:xs-alias-auto-noticed`, ≤32 — never
 *    shares the lost set's 64);
 *  - `xs_alias_evt` ⇒ reconcile for the CURRENT sid only; a forced `lost` notifies once with the §7
 *    forced wording.
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
  XS_ALIAS_HUB_CAP,
  XS_ALIAS_V2_HUB_CAP,
  XS_HUB_CAP,
  type XsMemberLimitsWire,
} from "../../../src/web-hub/protocol/xs.js";
import { P2_HUB_CAPS, VERSION_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import { ackFrame, fakeNet, pathsIn, resetGlobals, SETTINGS, tmpDir, type FakeSocket } from "./helpers.js";

const AUTO_NOTICED_KEY = Symbol.for("pi-subagent:xs-alias-auto-noticed");
const LOST_KEY = Symbol.for("pi-subagent:xs-alias-lost");

let tmp: ReturnType<typeof tmpDir>;
beforeEach(() => {
  tmp = tmpDir();
  resetGlobals();
  delete (globalThis as Record<symbol, unknown>)[LOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[AUTO_NOTICED_KEY];
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
const WITH_ALIAS_V1 = [...BASE, XS_ALIAS_HUB_CAP];
const WITH_ALIAS_V2 = [...BASE, XS_ALIAS_HUB_CAP, XS_ALIAS_V2_HUB_CAP];

interface AutoState {
  enabled: boolean;
  cwd: string | undefined;
  decided: Set<string>;
  handoffPending: boolean;
}

interface Rig {
  conn: HubConnection;
  net: ReturnType<typeof fakeNet>;
  bridge: XsAgentBridge;
  state: { sessionId: string; epoch: number; joined: boolean };
  gen: { n: number };
  auto: AutoState;
  lostNotices: string[];
  autoNotices: string[];
}

function rig(opt: { caps?: string[]; auto?: Partial<AutoState>; aliasOn?: boolean } = {}): Rig {
  const n = fakeNet();
  const conn = acquireConnection(opts({ netConnect: n.netConnect }));
  const state = { sessionId: "sess-aaaaaaaaaaaa", epoch: 3, joined: true };
  const gen = { n: 7 };
  const auto: AutoState = {
    enabled: true,
    cwd: "/tmp/wa",
    decided: new Set<string>(),
    handoffPending: false,
    ...opt.auto,
  };
  const lostNotices: string[] = [];
  const autoNotices: string[] = [];
  const stack = {
    sessionId: () => state.sessionId,
    member: () => ({ epoch: state.epoch, joined: state.joined, receive: "wake" as const }),
    deliver: () => ({ effect: "none" as const, reason: "rejected" as const, woke: false }),
    status: () => ({ joined: state.joined, receive: "wake" as const, blocked: 0 }),
  };
  const port: XsAgentPort = {
    stack: () => stack,
    memberLimits: () => ({ ...LIMITS }),
    hubSendsPerMin: () => 60,
    ...(opt.aliasOn === false ? {} : { aliasEnabled: () => true }),
    aliasAuto: () => ({
      enabled: auto.enabled,
      cwd: auto.cwd,
      home: "/home/u",
      tmpdir: "/tmp",
      decided: (sid) => auto.decided.has(sid),
      handoffPending: () => auto.handoffPending,
    }),
    notifyAliasLost: (t) => lostNotices.push(t),
    notifyAliasAuto: (t) => autoNotices.push(t),
  };
  const bridge = createXsAgentBridge({
    port,
    conn: () => conn,
    connGen: () => gen.n,
    random: () => 0, // deterministic 1000ms BUSY retry
  });
  const binding: BindingPort = {
    onStateChange: () => undefined,
    onSnapshotReq: () => undefined,
    onBranchReq: () => undefined,
    onHubCaps: () => {
      bridge.publishMember();
      bridge.onHubCapsAlias();
    },
    onXsAliasEvt: (frame) => bridge.onAliasEvt(frame),
  };
  conn.attach(binding, SESSION as never);
  const s = n.sockets[0]!;
  s.emit("connect");
  s.hub(ackFrame("k", 4242, opt.caps ?? WITH_ALIAS_V2));
  return { conn, net: n, bridge, state, gen, auto, lostNotices, autoNotices };
}

const aliasReqs = (s: FakeSocket): Array<Record<string, unknown>> =>
  s.frames().filter((f) => f.t === "xs_req" && f.op === "alias");
const reply = (s: FakeSocket, req: Record<string, unknown>, alias: unknown): void =>
  s.hub({ t: "xs_res", rid: String(req.rid), ok: true, alias } as never);
const fail = (s: FakeSocket, req: Record<string, unknown>, code: string): void =>
  s.hub({ t: "xs_res", rid: String(req.rid), ok: false, code } as never);
const flush = async (): Promise<void> => void (await vi.advanceTimersByTimeAsync(0));

/** Drive the attach reconcile: get ⇒ `none`, then let the auto tail run. Returns the requests so far. */
async function reconcileNone(r: Rig): Promise<Array<Record<string, unknown>>> {
  const s = r.net.sockets[0]!;
  await flush(); // hello_ack reconcile get
  const reqs = aliasReqs(s);
  expect(reqs).toHaveLength(1);
  expect(reqs[0]!.alias).toBeUndefined(); // a bare get
  reply(s, reqs[0]!, { state: "none" });
  await flush();
  return aliasReqs(s);
}

describe("v2 intent frames (§3.2)", () => {
  it("auto / forcePreview / handoff carry intent (+prevSessionId) toward a v2 hub", async () => {
    const r = rig();
    const s = r.net.sockets[0]!;
    await flush();
    reply(s, aliasReqs(s)[0]!, { alias: "wa", state: "held" }); // held ⇒ no auto tail
    await flush();

    const pAuto = r.bridge.aliasBridge().auto("wa");
    await flush();
    expect(aliasReqs(s)[1]).toMatchObject({ op: "alias", alias: "wa", intent: "auto" });
    reply(s, aliasReqs(s)[1]!, { alias: "wa", state: "held", origin: "auto" });
    expect(await pAuto).toEqual({ ok: true, res: { alias: "wa", state: "held", origin: "auto" } });

    const pForce = r.bridge.aliasBridge().forcePreview("web");
    await flush();
    expect(aliasReqs(s)[2]).toMatchObject({ alias: "web", take: "preview", intent: "force" });
    reply(s, aliasReqs(s)[2]!, {
      take: { cwdLabel: "~/x", offlineForS: 0, online: true, token: "k0123456789abcdef", expiresAt: 5 },
    });
    expect((await pForce).ok).toBe(true);

    const pHand = r.bridge.aliasBridge().handoff("wa", "sess-000000000000");
    await flush();
    expect(aliasReqs(s)[3]).toMatchObject({ alias: "wa", intent: "handoff", prevSessionId: "sess-000000000000" });
    reply(s, aliasReqs(s)[3]!, { alias: "wa", state: "held" });
    expect((await pHand).ok).toBe(true);
  });

  it("v1 hub ⇒ intent ops send NOTHING and answer E_XS_OFF{hub-v2}; reconcile never autos (skip hub-cap)", async () => {
    const r = rig({ caps: WITH_ALIAS_V1 });
    const s = r.net.sockets[0]!;
    await flush();
    reply(s, aliasReqs(s)[0]!, { state: "none" });
    await flush();
    expect(aliasReqs(s)).toHaveLength(1); // the bare get only — no auto frame
    expect(aliasReqs(s)[0]!.intent).toBeUndefined();
    expect(r.bridge.aliasAutoSkip()).toBe("hub-cap");

    expect(await r.bridge.aliasBridge().auto("wa")).toEqual({ ok: false, code: "E_XS_OFF", reason: "hub-v2" });
    expect(await r.bridge.aliasBridge().forcePreview("wa")).toEqual({ ok: false, code: "E_XS_OFF", reason: "hub-v2" });
    expect(await r.bridge.aliasBridge().handoff("wa", "sess-000000000000")).toEqual({
      ok: false,
      code: "E_XS_OFF",
      reason: "hub-v2",
    });
    expect(aliasReqs(s)).toHaveLength(1); // still zero intent frames on the wire
  });
});

describe("auto-claim engine (§5.1)", () => {
  it("applied none ⇒ one auto attempt with the derived basename; success caches + notifies once", async () => {
    const r = rig();
    const s = r.net.sockets[0]!;
    const reqs = await reconcileNone(r);
    expect(reqs).toHaveLength(2);
    expect(reqs[1]).toMatchObject({ alias: "wa", intent: "auto" });
    reply(s, reqs[1]!, { alias: "wa", state: "held", origin: "auto" });
    await flush();
    expect(r.bridge.aliasCache().current()).toEqual({ alias: "wa", origin: "auto" });
    expect(r.bridge.statusProjection()).toMatchObject({ alias: "wa" });
    expect(r.autoNotices).toEqual([
      "已按目录名自动设置别名 @wa；/fabric alias <名> 可改名，/fabric alias --clear 可取消（之后不再自动设置）",
    ]);
    expect(r.bridge.aliasAutoSkip()).toBeUndefined();

    // /fabric status-style reconcile: the tried key skips — a bare get only, no second auto
    void r.bridge.aliasCache().reconcile();
    await flush();
    expect(aliasReqs(s)).toHaveLength(3);
    reply(s, aliasReqs(s)[2]!, { alias: "wa", state: "held", origin: "auto" });
    await flush();
    expect(aliasReqs(s)).toHaveLength(3);
    expect(r.autoNotices).toHaveLength(1);
  });

  it("the auto notice set is process-wide (a rebuilt bridge does not re-notify) and INDEPENDENT of the lost set", async () => {
    const r1 = rig();
    const s1 = r1.net.sockets[0]!;
    const reqs = await reconcileNone(r1);
    reply(s1, reqs[1]!, { alias: "wa", state: "held", origin: "auto" });
    await flush();
    expect(r1.autoNotices).toHaveLength(1);
    const gbag = globalThis as unknown as Record<symbol, Set<string> | undefined>;
    expect(gbag[AUTO_NOTICED_KEY]?.has("sess-aaaaaaaaaaaa")).toBe(true);
    expect(gbag[LOST_KEY]).toBeUndefined(); // lost set untouched

    // /reload: new bridge + new connection, same process sets. The hub still answers held ⇒ no auto, no notice.
    resetGlobals(); // releases the process-global connection (the alias sets are NOT touched)
    const r2 = rig();
    const s2 = r2.net.sockets[0]!;
    await flush();
    reply(s2, aliasReqs(s2)[0]!, { alias: "wa", state: "held", origin: "auto" });
    await flush();
    expect(aliasReqs(s2)).toHaveLength(1);
    expect(r2.autoNotices).toHaveLength(0);
  });

  it("BUSY{queue} ⇒ exactly ONE unref'd retry after the clamped 1s; a second BUSY records skip busy", async () => {
    const unrefSeen: Array<{ ms: number | undefined; hasRef: boolean | undefined }> = [];
    const realFakeSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const t = realFakeSetTimeout(fn, ms) as NodeJS.Timeout & { hasRef?(): boolean };
      const origUnref = t.unref?.bind(t);
      if (origUnref !== undefined) {
        t.unref = () => {
          const out = origUnref();
          unrefSeen.push({ ms, hasRef: typeof t.hasRef === "function" ? t.hasRef() : undefined });
          return out;
        };
      }
      return t;
    }) as typeof setTimeout);

    const r = rig();
    const s = r.net.sockets[0]!;
    const reqs = await reconcileNone(r);
    expect(reqs).toHaveLength(2);
    fail(s, reqs[1]!, "E_XS_ALIAS_BUSY{queue}");
    await flush();
    expect(aliasReqs(s)).toHaveLength(2); // no immediate retry
    await vi.advanceTimersByTimeAsync(999);
    expect(aliasReqs(s)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2); // 1001ms ≥ the 1000ms retry (random=0)
    expect(aliasReqs(s)).toHaveLength(3);
    expect(aliasReqs(s)[2]).toMatchObject({ alias: "wa", intent: "auto" });
    // the retry timer is unref'd (I5) — the 5s request-deadline timers are a different ms
    expect(unrefSeen.some((e) => e.ms === 1_000 && e.hasRef === false)).toBe(true);

    fail(s, aliasReqs(s)[2]!, "E_XS_ALIAS_BUSY{queue}");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(aliasReqs(s)).toHaveLength(3); // exactly one retry
    expect(r.bridge.aliasAutoSkip()).toBe("busy");
  });

  it("a membership epoch bump before the retry fires cancels it (the fresh key gets its own attempt)", async () => {
    const r = rig();
    const s = r.net.sockets[0]!;
    const reqs = await reconcileNone(r);
    fail(s, reqs[1]!, "E_XS_ALIAS_BUSY{io}");
    await flush();
    r.state.epoch = 4; // join/leave lands inside the 1s window
    await vi.advanceTimersByTimeAsync(10_000);
    expect(aliasReqs(s)).toHaveLength(2); // the scheduled retry was dropped, nothing sent
    // …and the new key can attempt on the next reconcile
    void r.bridge.aliasCache().reconcile();
    await flush();
    reply(s, aliasReqs(s)[2]!, { state: "none" });
    await flush();
    expect(aliasReqs(s)).toHaveLength(4);
    expect(aliasReqs(s)[3]).toMatchObject({ alias: "wa", intent: "auto" });
  });

  it("a membership epoch bump (join) re-arms exactly one new attempt", async () => {
    const r = rig();
    const s = r.net.sockets[0]!;
    let reqs = await reconcileNone(r);
    fail(s, reqs[1]!, "E_XS_ALIAS_TAKEN{taken}");
    await flush();
    expect(r.bridge.aliasAutoSkip()).toBe("taken");

    // same key: no new attempt
    void r.bridge.aliasCache().reconcile();
    await flush();
    reply(s, aliasReqs(s)[2]!, { state: "none" });
    await flush();
    expect(aliasReqs(s)).toHaveLength(3);

    // join: epoch 3 → 4 re-arms
    r.state.epoch = 4;
    void r.bridge.aliasCache().reconcile();
    await flush();
    reply(s, aliasReqs(s)[3]!, { state: "none" });
    await flush();
    reqs = aliasReqs(s);
    expect(reqs).toHaveLength(5);
    expect(reqs[4]).toMatchObject({ alias: "wa", intent: "auto" });
  });

  it("a discarded (stale) get never starts an auto write", async () => {
    const r = rig();
    const s = r.net.sockets[0]!;
    await flush();
    reply(s, aliasReqs(s)[0]!, { state: "none" });
    await flush();
    expect(aliasReqs(s)).toHaveLength(2); // auto attempted once

    // reconcile for sid A, switch session before the reply lands ⇒ not applied ⇒ no auto for the new sid
    r.state.sessionId = "sess-bbbbbbbbbbbb";
    const p = r.bridge.aliasCache().reconcile();
    await flush();
    const getReq = aliasReqs(s)[2]!;
    expect(getReq.origin).toMatchObject({ sessionId: "sess-bbbbbbbbbbbb" });
    // hub answers AFTER a further switch: the reply is stale for the now-current sid
    r.state.sessionId = "sess-cccccccccccc";
    reply(s, getReq, { state: "none" });
    await p;
    await flush();
    expect(aliasReqs(s)).toHaveLength(3); // no auto frame for either sid
  });

  it("skip reasons: decided / not-joined / dir; autoFromCwd=false records NO suffix (§7)", async () => {
    const r = rig({ auto: { decided: new Set(["sess-aaaaaaaaaaaa"]) } });
    await reconcileNone(r);
    expect(aliasReqs(r.net.sockets[0]!)).toHaveLength(1);
    expect(r.bridge.aliasAutoSkip()).toBe("decided");

    resetGlobals();
    const r2 = rig();
    r2.state.joined = false;
    // the attach get is still answered; auto gates on joined
    const s2 = r2.net.sockets[0]!;
    await flush();
    reply(s2, aliasReqs(s2)[0]!, { state: "none" });
    await flush();
    expect(aliasReqs(s2)).toHaveLength(1);
    expect(r2.bridge.aliasAutoSkip()).toBe("not-joined");

    resetGlobals();
    const r3 = rig({ auto: { cwd: "/" } });
    await reconcileNone(r3);
    expect(aliasReqs(r3.net.sockets[0]!)).toHaveLength(1);
    expect(r3.bridge.aliasAutoSkip()).toBe("dir");

    resetGlobals();
    const r4 = rig({ auto: { enabled: false } });
    await reconcileNone(r4);
    expect(aliasReqs(r4.net.sockets[0]!)).toHaveLength(1);
    expect(r4.bridge.aliasAutoSkip()).toBeUndefined();
  });

  it("handoff-pending gates the auto and is NOT recorded as a status skip token", async () => {
    const r = rig({ auto: { handoffPending: true } });
    await reconcileNone(r);
    expect(aliasReqs(r.net.sockets[0]!)).toHaveLength(1);
    expect(r.bridge.aliasAutoSkip()).toBeUndefined();
  });

  it("no aliasAuto port hook (pre-AFW wiring) ⇒ the engine is fully inert", async () => {
    const n = fakeNet();
    const conn = acquireConnection(opts({ netConnect: n.netConnect }));
    const stack = {
      sessionId: () => "sess-aaaaaaaaaaaa",
      member: () => ({ epoch: 3, joined: true, receive: "wake" as const }),
      deliver: () => ({ effect: "none" as const, reason: "rejected" as const, woke: false }),
      status: () => ({ joined: true, receive: "wake" as const, blocked: 0 }),
    };
    const bridge = createXsAgentBridge({
      port: {
        stack: () => stack,
        memberLimits: () => ({ ...LIMITS }),
        hubSendsPerMin: () => 60,
        aliasEnabled: () => true,
      },
      conn: () => conn,
    });
    conn.attach(
      {
        onStateChange: () => undefined,
        onSnapshotReq: () => undefined,
        onBranchReq: () => undefined,
        onHubCaps: () => {
          bridge.publishMember();
          bridge.onHubCapsAlias();
        },
      },
      SESSION as never,
    );
    const s = n.sockets[0]!;
    s.emit("connect");
    s.hub(ackFrame("k", 4242, WITH_ALIAS_V2));
    await flush();
    reply(s, aliasReqs(s)[0]!, { state: "none" });
    await flush();
    expect(aliasReqs(s)).toHaveLength(1); // bare get only
    expect(bridge.aliasAutoSkip()).toBeUndefined();
  });
});

describe("xs_alias_evt (§5.4)", () => {
  it("a nudge for the CURRENT sid reconciles; a forced lost notifies once with the §7 forced wording", async () => {
    const r = rig();
    const s = r.net.sockets[0]!;
    const reqs = await reconcileNone(r);
    reply(s, reqs[1]!, { alias: "wa", state: "held", origin: "auto" });
    await flush();
    expect(r.bridge.aliasCache().current()).toEqual({ alias: "wa", origin: "auto" });
    const before = aliasReqs(s).length;

    s.hub({ t: "xs_alias_evt", sessionId: "sess-aaaaaaaaaaaa", at: 900 } as never);
    await flush();
    expect(aliasReqs(s)).toHaveLength(before + 1); // the reconcile get
    reply(s, aliasReqs(s).at(-1)!, { state: "none", lost: { alias: "wa", reason: "taken", forced: true, at: 900 } });
    await flush();
    expect(r.lostNotices).toEqual(["别名「wa」已被其他会话强制抢占（对方已人工确认），可以用 /fabric alias 重新设置"]);
    expect(r.bridge.aliasCache().current()).toEqual({ lostAt: 900 });
    expect(r.bridge.statusProjection()).not.toHaveProperty("alias");

    // a second nudge with the same tombstone ⇒ the one-shot notice stays single
    s.hub({ t: "xs_alias_evt", sessionId: "sess-aaaaaaaaaaaa", at: 901 } as never);
    await flush();
    reply(s, aliasReqs(s).at(-1)!, { state: "none", lost: { alias: "wa", reason: "taken", forced: true, at: 900 } });
    await flush();
    expect(r.lostNotices).toHaveLength(1);
  });

  it("a nudge for another sid is ignored (zero frames)", async () => {
    const r = rig();
    const s = r.net.sockets[0]!;
    const reqs = await reconcileNone(r);
    reply(s, reqs[1]!, { alias: "wa", state: "held" });
    await flush();
    const before = aliasReqs(s).length;
    s.hub({ t: "xs_alias_evt", sessionId: "sess-zzzzzzzzzzzz", at: 1 } as never);
    await flush();
    expect(aliasReqs(s)).toHaveLength(before);
  });

  it("cache mirrors wire origin on human-vs-auto grants and drops it with the alias", async () => {
    const r = rig();
    const s = r.net.sockets[0]!;
    await flush();
    reply(s, aliasReqs(s)[0]!, { alias: "web", state: "held" }); // human grant: no origin key
    await flush();
    expect(r.bridge.aliasCache().current()).toEqual({ alias: "web" });
    const p = r.bridge.aliasBridge().clear();
    await flush();
    reply(s, aliasReqs(s).at(-1)!, { state: "none" });
    await p;
    expect(r.bridge.aliasCache().current()).toEqual({});
  });
});
