import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFeishuConnector,
  type FeishuConnectorDeps,
  type FeishuConnectorView,
} from "../../../../src/web-hub/hub/feishu/connector.js";
import { createFeishuApi } from "../../../../src/web-hub/hub/feishu/api.js";
import { createFeishuHttp, systemFeishuClock } from "../../../../src/web-hub/hub/feishu/http.js";
import { createTokenManager } from "../../../../src/web-hub/hub/feishu/token.js";
import {
  ackFrame,
  decodeFrame,
  encodeFrame,
  header,
  pingFrame,
  pongFrame,
  type Frame,
} from "../../../../src/web-hub/hub/feishu/frame.js";
import { FEISHU_TIMERS, FEISHU_ACK, FEISHU_CAPS } from "../../../../src/web-hub/protocol/feishu.js";
import { createFakeClock, createFakeFeishu, settle } from "../../../fixtures/feishu/fake-http.js";
import {
  createFakeWebSockets,
  createFakeWsServer,
  type ScriptedSocket,
} from "../../../fixtures/feishu/fake-ws-server.js";
import { cleanupF6, f6Rig, messageEnvelope, NOW } from "../../../fixtures/feishu/f6.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  await cleanupF6();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function eventFrame(raw: unknown = messageEnvelope(), options: Partial<Frame> = {}): Frame {
  return {
    seqId: 9_007_199_254_740_999n,
    logId: (1n << 64n) - 1n,
    service: 33,
    method: 1,
    headers: [
      { key: "type", value: "event" },
      { key: "message_id", value: "transport-1" },
      { key: "sum", value: "1" },
      { key: "seq", value: "0" },
    ],
    payloadEncoding: "",
    payloadType: "application/json",
    logIdNew: "new-log",
    payload: Buffer.from(JSON.stringify(raw)),
    ...options,
  };
}
const dataSent = (socket: ScriptedSocket) => socket.sent.filter((bytes) => decodeFrame(bytes).method !== 0);
const acks = (socket: ScriptedSocket) => socket.sent.map(decodeFrame).filter((f) => header(f, "biz_rt") !== undefined);
async function rig(
  options: {
    autoOpen?: boolean;
    stallClose?: boolean;
    terminable?: boolean;
    random?: number;
    config?: Record<string, unknown>;
    handleEvent?: FeishuConnectorDeps["handleEvent"];
    state?: FeishuConnectorDeps["state"];
    api?: FeishuConnectorDeps["api"];
  } = {},
) {
  const clock = createFakeClock(NOW);
  const fake = createFakeFeishu();
  let endpointSeq = 0;
  fake.on("POST", "/callback/ws/endpoint", () => ({
    json: {
      code: 0,
      data: {
        URL: `wss://msg-frontier.feishu.cn/ws?service_id=33&device_id=device&ticket=${++endpointSeq}`,
        ClientConfig: options.config ?? { PingInterval: 10, ReconnectInterval: 2, ReconnectNonce: 1 },
      },
    },
  }));
  const http = createFeishuHttp({ apiBase: "https://open.feishu.cn", fetch: fake.fetch, clock });
  const token = createTokenManager({
    http,
    credentials: () => ({ appId: fake.appId, appSecret: fake.appSecret, gen: 1 }),
    clock,
  });
  const api = createFeishuApi({ http, token });
  const ws = createFakeWebSockets(clock, options);
  const statuses: FeishuConnectorView[] = [];
  let noticeAt: number | undefined;
  const state =
    options.state ??
    ({
      connectorMayStart: vi.fn(() => true),
      commit: vi.fn(async () => true),
      undecodable: {
        record: vi.fn(),
        snapshot: vi.fn(() => ({ count: 0, ring: [] })),
        noticeDue: vi.fn(() => noticeAt === undefined || clock.now() - noticeAt >= 3_600_000),
        markNotice: vi.fn(() => {
          noticeAt = clock.now();
        }),
      },
    } as FeishuConnectorDeps["state"]);
  const handleEvent = vi.fn(options.handleEvent ?? (async () => ({ ack: true, reason: "received" })));
  const bootstrap = vi.fn((options.api ?? api).bootstrap);
  const onUndecodable = vi.fn();
  const connector = createFeishuConnector({
    credentials: { appId: fake.appId, appSecret: fake.appSecret },
    api: { bootstrap },
    state,
    handleEvent,
    clock,
    monotonicNow: clock.now,
    random: () => options.random ?? 0.5,
    webSocket: ws.create,
    onStatus: (view) => statuses.push(view),
    onUndecodable,
  });
  cleanup.push(async () => {
    const p = connector.dispose();
    for (let i = 0; i < 3; i++) {
      clock.advance(6_000);
      await settle();
    }
    await p;
    for (const s of ws.sockets) s.finishClose();
    token.dispose();
  });
  async function advance(ms = 0) {
    clock.advance(ms);
    await settle();
  }
  async function start() {
    connector.start();
    await settle();
    await advance();
    return ws.sockets.at(-1)!;
  }
  async function reconnect(socket = ws.sockets.at(-1)!) {
    socket.finishClose(1006);
    await settle();
    await advance(1_000);
    await advance();
    return ws.sockets.at(-1)!;
  }
  return {
    clock,
    fake,
    api,
    ws,
    state,
    handleEvent,
    bootstrap,
    onUndecodable,
    connector,
    statuses,
    start,
    advance,
    reconnect,
  };
}

describe("F3 bootstrap and lifecycle", () => {
  it("is inert until start; reuses F2 bootstrap per dial, sets binary mode, and never overlaps normal sockets", async () => {
    const r = await rig();
    expect(r.bootstrap).not.toHaveBeenCalled();
    expect(r.clock.pending()).toBe(0);
    const first = await r.start();
    r.connector.start();
    await settle();
    expect(r.bootstrap).toHaveBeenCalledTimes(1);
    expect(first.binaryType).toBe("arraybuffer");
    expect(r.connector.snapshot()).toMatchObject({ status: "open", gen: 1, reconnects: 0 });
    const call = r.fake.callsTo("POST", "/callback/ws/endpoint")[0]!;
    expect(call.json).toEqual({ AppID: r.fake.appId, AppSecret: r.fake.appSecret });
    expect(call.headers["locale"]).toBe("zh");
    const second = await r.reconnect(first);
    expect(second).not.toBe(first);
    expect(second.url).not.toBe(first.url);
    expect(r.bootstrap).toHaveBeenCalledTimes(2);
    expect(r.ws.peak()).toBe(1);
    expect(r.connector.snapshot()).toMatchObject({ status: "open", gen: 2, reconnects: 1 });
  });
  it("remote close reports connecting immediately throughout the nonce backoff", async () => {
    const r = await rig({ random: 1, config: { PingInterval: 90, ReconnectNonce: 60 } });
    const old = await r.start();
    old.finishClose(1006); // remote close arrives with readyState already CLOSED
    expect(r.connector.snapshot()).toMatchObject({
      status: "connecting",
      lastClose: { reason: "ws-close", code: 1006 },
    });
    await r.advance(59_999);
    expect(r.connector.snapshot().status).toBe("connecting");
    expect(r.bootstrap).toHaveBeenCalledTimes(1);
    await r.advance(1);
    await r.advance();
    expect(r.connector.snapshot().status).toBe("open");
    expect(r.bootstrap).toHaveBeenCalledTimes(2);
  });
  it("does not bootstrap when durable state is unavailable; resume retries after repair", async () => {
    const r = await rig();
    vi.mocked(r.state.connectorMayStart).mockReturnValue(false);
    r.connector.start();
    await settle();
    expect(r.bootstrap).not.toHaveBeenCalled();
    expect(r.connector.snapshot().status).toBe("degraded");
    vi.mocked(r.state.connectorMayStart).mockReturnValue(true);
    r.connector.resume();
    await r.advance();
    await r.advance();
    expect(r.bootstrap).toHaveBeenCalledTimes(1);
    expect(r.connector.snapshot().status).toBe("open");
  });
  it.each([514, 403, 10003, 10014, 1000040345, 999999])(
    "auth code %i cools down 10min, no socket/hot loop",
    async (code) => {
      const r = await rig();
      r.fake.script("POST", "/callback/ws/endpoint", { json: { code, msg: "bad credentials" } });
      r.connector.start();
      await settle();
      expect(r.connector.snapshot()).toMatchObject({ status: "auth_failed", code });
      expect(r.ws.sockets).toHaveLength(0);
      await r.advance(FEISHU_TIMERS.authFailedRetryMs - 1);
      expect(r.bootstrap).toHaveBeenCalledTimes(1);
      await r.advance(1);
      await r.advance();
      expect(r.bootstrap).toHaveBeenCalledTimes(2);
      expect(r.connector.snapshot().status).toBe("open");
    },
  );
  it("connection limit uses 5min cooldown", async () => {
    const r = await rig();
    r.fake.script("POST", "/callback/ws/endpoint", { json: { code: 1000040350 } });
    r.connector.start();
    await settle();
    expect(r.connector.snapshot().status).toBe("conn_limit");
    await r.advance(299_999);
    expect(r.bootstrap).toHaveBeenCalledTimes(1);
    await r.advance(1);
    await r.advance();
    expect(r.bootstrap).toHaveBeenCalledTimes(2);
  });
  it.each([
    [1000040345, "auth_failed", FEISHU_TIMERS.authFailedRetryMs],
    [1000040350, "conn_limit", FEISHU_TIMERS.connLimitRetryMs],
  ] as const)("resume preserves %s cooldown status until the actual retry", async (code, status, delay) => {
    const r = await rig();
    r.fake.script("POST", "/callback/ws/endpoint", { json: { code } });
    r.connector.start();
    await settle();
    r.connector.resume();
    expect(r.connector.snapshot()).toMatchObject({ status, code });
    await r.advance(delay - 1);
    expect(r.bootstrap).toHaveBeenCalledTimes(1);
    expect(r.connector.snapshot()).toMatchObject({ status, code });
    r.connector.resume();
    expect(r.connector.snapshot().status).toBe(status);
    await r.advance(1);
    await r.advance();
    expect(r.bootstrap).toHaveBeenCalledTimes(2);
    expect(r.connector.snapshot().status).toBe("open");
  });
  it.each([1, 1000040343])("transient code %i uses nonce then exponential full jitter", async (code) => {
    const r = await rig();
    r.fake.script("POST", "/callback/ws/endpoint", ...Array.from({ length: 4 }, () => ({ json: { code } })));
    r.connector.start();
    await settle();
    await r.advance(14_999);
    expect(r.bootstrap).toHaveBeenCalledTimes(1);
    await r.advance(1);
    expect(r.bootstrap).toHaveBeenCalledTimes(2); // initial default nonce/2 = 15,000 (no config until bootstrap succeeds)
    await r.advance(499);
    expect(r.bootstrap).toHaveBeenCalledTimes(2);
    await r.advance(1);
    expect(r.bootstrap).toHaveBeenCalledTimes(3); // 2^0/2 = 500
    await r.advance(999);
    expect(r.bootstrap).toHaveBeenCalledTimes(3);
    await r.advance(1);
    expect(r.bootstrap).toHaveBeenCalledTimes(4); // 2^1/2 = 1000
    await r.advance(1_999);
    expect(r.bootstrap).toHaveBeenCalledTimes(4);
    await r.advance(1);
    await r.advance();
    expect(r.connector.snapshot().status).toBe("open");
  });
  it("caps backoff at 60s and resets to nonce only after 60s stable", async () => {
    const r = await rig({ random: 1, config: { PingInterval: 300, ReconnectNonce: 2 } });
    r.fake.script("POST", "/callback/ws/endpoint", ...Array.from({ length: 10 }, () => ({ networkError: true })));
    r.connector.start();
    await settle();
    for (const delay of [30000, 1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]) await r.advance(delay);
    await r.advance();
    expect(r.connector.snapshot().status).toBe("open");
    expect(r.bootstrap).toHaveBeenCalledTimes(11);
    r.ws.sockets[0]!.message(encodeFrame(pongFrame(33)));
    await r.advance(60_000);
    r.ws.sockets[0]!.finishClose();
    await settle();
    await r.advance(1999);
    expect(r.bootstrap).toHaveBeenCalledTimes(11);
    await r.advance(1);
    expect(r.bootstrap).toHaveBeenCalledTimes(12);
  });
  it("refuses a nonallowlisted WS URL even from an injected bootstrap", async () => {
    const bootstrap = vi.fn(async () => ({
      ok: true as const,
      data: {
        url: "ws://127.0.0.1:1/",
        serviceId: 33,
        deviceId: "d",
        config: { pingIntervalMs: 10000, reconnectIntervalMs: 1000, reconnectNonceMs: 0 },
      },
    }));
    const r = await rig({ api: { bootstrap } });
    r.connector.start();
    await settle();
    expect(r.ws.sockets).toHaveLength(0);
    expect(r.connector.snapshot()).toMatchObject({ status: "degraded", reason: "ws-unavailable" });
    await r.advance(600_000);
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });
  it("bounds bootstrap even if the API ignores abort; late completion after stop is discarded", async () => {
    const d = deferred<Awaited<ReturnType<FeishuConnectorDeps["api"]["bootstrap"]>>>();
    const bootstrap = vi.fn(() => d.promise);
    const r = await rig({ api: { bootstrap } });
    r.connector.start();
    await settle();
    await r.advance(8_000);
    expect(r.connector.snapshot().counters["bootstrap-timeout"]).toBe(1);
    await r.connector.stop();
    d.resolve(await r.api.bootstrap({ appId: r.fake.appId, appSecret: r.fake.appSecret }));
    await settle();
    await r.advance(600_000);
    expect(r.ws.sockets).toHaveLength(0);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(r.clock.pending()).toBe(0);
  });
  it("late bootstrap from a previous start cannot replace the new connection", async () => {
    const d = deferred<Awaited<ReturnType<FeishuConnectorDeps["api"]["bootstrap"]>>>();
    const r = await rig();
    r.bootstrap.mockImplementationOnce(() => d.promise);
    r.connector.start();
    await settle();
    await r.connector.stop();
    const current = await r.start();
    d.resolve(await r.api.bootstrap({ appId: r.fake.appId, appSecret: r.fake.appSecret }));
    await settle();
    await r.advance();
    expect(r.ws.sockets).toEqual([current]);
    expect(r.connector.snapshot()).toMatchObject({ status: "open", gen: 1 });
  });
  it("all production clock timers are unref'd and stop clears them", async () => {
    const r = await rig();
    const owned = new Set<ReturnType<typeof setTimeout>>();
    const clock = {
      now: systemFeishuClock.now,
      setTimeout(fn: () => void, ms: number) {
        const handle = systemFeishuClock.setTimeout(fn, ms) as ReturnType<typeof setTimeout>;
        expect(handle.hasRef()).toBe(false);
        owned.add(handle);
        return handle;
      },
      clearTimeout(handle: unknown) {
        owned.delete(handle as ReturnType<typeof setTimeout>);
        systemFeishuClock.clearTimeout(handle);
      },
    };
    const ws = createFakeWebSockets(clock, { autoOpen: false, stallClose: true });
    const c = createFeishuConnector({
      credentials: { appId: r.fake.appId, appSecret: r.fake.appSecret },
      api: r.api,
      state: r.state,
      handleEvent: r.handleEvent,
      clock,
      webSocket: ws.create,
    });
    c.start();
    await settle();
    ws.sockets[0]!.open();
    expect(owned.size).toBe(2); // ping + immediate-ping liveness; handshake cleared
    const stopped = c.stop();
    ws.sockets[0]!.finishClose();
    await stopped;
    expect(owned.size).toBe(0);
    await c.dispose();
  });
  it("missing platform WebSocket degrades without network or retry timers", async () => {
    const r = await rig();
    const c = createFeishuConnector({
      credentials: { appId: r.fake.appId, appSecret: r.fake.appSecret },
      api: { bootstrap: r.bootstrap },
      state: r.state,
      handleEvent: r.handleEvent,
      clock: r.clock,
    });
    vi.stubGlobal("WebSocket", undefined);
    c.start();
    await settle();
    expect(c.snapshot()).toMatchObject({ status: "degraded", reason: "ws-unavailable" });
    expect(r.bootstrap).not.toHaveBeenCalled();
    expect(r.clock.pending()).toBe(0);
    await c.dispose();
  });
  it("dispose mid-connect aborts bootstrap and removes its retry", async () => {
    const r = await rig();
    r.fake.script("POST", "/callback/ws/endpoint", { hang: true });
    r.connector.start();
    await settle();
    const signal = r.fake.calls[0]!.signal!;
    const p = r.connector.dispose();
    await p;
    await settle();
    expect(signal.aborted).toBe(true);
    await r.advance(600_000);
    expect(r.bootstrap).toHaveBeenCalledTimes(1);
    expect(r.ws.sockets).toHaveLength(0);
    expect(r.clock.pending()).toBe(0);
  });
  it("bounds handshake; dispose during handshake prevents a late open", async () => {
    const r = await rig({ autoOpen: false });
    const s = await r.start();
    await r.advance(9_999);
    expect(s.closeCalls).toBe(0);
    await r.advance(1);
    expect(s.closeCalls).toBe(1);
    const p = r.connector.dispose();
    await r.advance();
    await p;
    s.open();
    await r.advance(600_000);
    expect(r.connector.snapshot().status).toBe("stopped");
    expect(r.ws.sockets).toHaveLength(1);
    expect(dataSent(s)).toHaveLength(0);
  });
  it("dispose mid-backoff is final and idempotent", async () => {
    const r = await rig();
    const s = await r.start();
    s.finishClose();
    await settle();
    const p = r.connector.dispose();
    expect(r.connector.dispose()).toBe(p);
    await p;
    r.connector.start();
    await r.advance(600_000);
    expect(r.ws.sockets).toHaveLength(1);
    expect(r.clock.pending()).toBe(0);
  });
  it("start during stop queues exactly one restart after physical handover", async () => {
    const r = await rig({ stallClose: true });
    const old = await r.start();
    const queuedOpen = [...old.listeners.get("open")!][0]!;
    const stopped = r.connector.stop();
    r.connector.start();
    r.connector.start();
    expect(r.bootstrap).toHaveBeenCalledTimes(1);
    await r.advance(4999);
    expect(r.bootstrap).toHaveBeenCalledTimes(1);
    old.finishClose();
    await stopped;
    await settle();
    await r.advance();
    expect(r.bootstrap).toHaveBeenCalledTimes(2);
    expect(r.connector.snapshot()).toMatchObject({ status: "open", gen: 2 });
    expect(r.ws.peak()).toBe(1);
    queuedOpen({});
    old.message(encodeFrame(eventFrame()));
    expect(r.connector.snapshot().gen).toBe(2);
    expect(r.handleEvent).not.toHaveBeenCalled();
  });
  it("dispose cancels a start queued during stop", async () => {
    const r = await rig({ stallClose: true });
    await r.start();
    const stopped = r.connector.stop();
    r.connector.start();
    const disposed = r.connector.dispose();
    await r.advance(5000);
    await stopped;
    await disposed;
    await r.advance(600_000);
    expect(r.bootstrap).toHaveBeenCalledTimes(1);
    expect(r.connector.snapshot().status).toBe("stopped");
  });
  it("repeated stop/start serializes physical handover and fences old handlers", async () => {
    const r = await rig();
    for (let i = 0; i < 4; i++) {
      const s = await r.start();
      const queuedOpen = [...s.listeners.get("open")!][0]!;
      const p = r.connector.stop();
      expect(r.connector.stop()).toBe(p);
      await r.advance();
      await p;
      queuedOpen({});
      s.message(encodeFrame(eventFrame()));
      expect(r.connector.snapshot().status).toBe("stopped");
      expect(r.clock.pending()).toBe(0);
    }
    expect(r.ws.peak()).toBe(1);
    expect(r.ws.sockets).toHaveLength(4);
    expect(r.handleEvent).not.toHaveBeenCalled();
  });
});

describe("ping, pong and server ClientConfig", () => {
  it("sends F1 binary pings and reconnects on no inbound for 30s even with 10s ping interval", async () => {
    const r = await rig();
    const s = await r.start();
    expect(s.sent).toEqual([encodeFrame(pingFrame(33))]);
    expect(s.sentAt).toEqual([NOW]); // first ping is synchronous with open
    await r.advance(9_999);
    expect(s.sent).toHaveLength(1);
    await r.advance(1);
    expect(s.sent).toEqual([encodeFrame(pingFrame(33)), encodeFrame(pingFrame(33))]);
    expect(s.sentAt).toEqual([NOW, NOW + 10_000]);
    await r.advance(19_999);
    expect(s.closeCalls).toBe(0);
    await r.advance(1);
    expect(s.closeCalls).toBe(1);
    expect(r.connector.snapshot().lastClose?.reason).toBe("pong-timeout");
    await r.advance(500);
    await r.advance();
    expect(r.ws.sockets).toHaveLength(2);
    expect(r.ws.peak()).toBe(1);
  });
  it("any inbound cancels liveness, ignores server ping and unknown control, accepts pong config", async () => {
    const r = await rig();
    const s = await r.start();
    await r.advance(10_000);
    s.message(encodeFrame(pingFrame(33)));
    expect(s.sent).toHaveLength(2);
    s.message(encodeFrame({ ...pingFrame(33), headers: [{ key: "type", value: "surprise" }] }));
    s.message(
      encodeFrame(pongFrame(33, { PingInterval: 300, ReconnectInterval: 900, ReconnectNonce: -5, ReconnectCount: 0 })),
    );
    expect(r.connector.snapshot().config).toEqual({
      pingIntervalMs: 300_000,
      reconnectIntervalMs: 600_000,
      reconnectNonceMs: 0,
    });
    await r.advance(299_999);
    expect(s.sent).toHaveLength(2);
    expect(s.closeCalls).toBe(0);
    await r.advance(1);
    expect(s.sent).toHaveLength(3);
  });
  it.each([
    [{ PingInterval: 1 }, { pingIntervalMs: 10_000, reconnectIntervalMs: 70_000, reconnectNonceMs: 20_000 }],
    [{ ReconnectInterval: 999 }, { pingIntervalMs: 45_000, reconnectIntervalMs: 600_000, reconnectNonceMs: 20_000 }],
    [{ ReconnectNonce: 999 }, { pingIntervalMs: 45_000, reconnectIntervalMs: 70_000, reconnectNonceMs: 60_000 }],
  ])("partial pong config merges with the current config and clamps supplied fields: %j", async (patch, expected) => {
    const r = await rig({ config: { PingInterval: 45, ReconnectInterval: 70, ReconnectNonce: 20 } });
    const s = await r.start();
    s.message(encodeFrame(pongFrame(33, patch)));
    expect(r.connector.snapshot().config).toEqual(expected);
    s.message(encodeFrame(pongFrame(33, { PingInterval: 90 })));
    expect(r.connector.snapshot().config).toEqual({ ...expected, pingIntervalMs: 90_000 });
  });
  it("clamps initial bootstrap config and chooses control type first-wins", async () => {
    const r = await rig({ config: { PingInterval: -1, ReconnectInterval: -1, ReconnectNonce: 999 } });
    const s = await r.start();
    expect(r.connector.snapshot().config).toEqual({
      pingIntervalMs: 10000,
      reconnectIntervalMs: 1000,
      reconnectNonceMs: 60000,
    });
    const f = pongFrame(33, { PingInterval: 300 });
    f.headers.unshift({ key: "type", value: "ping" });
    s.message(encodeFrame(f));
    expect(r.connector.snapshot().config.pingIntervalMs).toBe(10_000);
  });
  it.each(["bad-json", "[]", "{}", '{"PingInterval":"soon"}', '{"ReconnectCount":0}'])(
    "ignores malformed pong config %s",
    async (text) => {
      const r = await rig();
      const s = await r.start();
      const f = pongFrame(33);
      f.payload = Buffer.from(text);
      s.message(encodeFrame(f));
      expect(r.connector.snapshot().config.pingIntervalMs).toBe(10000);
      expect(r.connector.snapshot().counters["pong-config-invalid"]).toBe(1);
      await r.advance(10000);
      expect(s.sent).toHaveLength(2);
    },
  );
  it("write backpressure retires instead of sending; send exception also reconnects", async () => {
    const r = await rig();
    const s = await r.start();
    s.bufferedAmount = FEISHU_TIMERS.writeBackpressureBytes + 1;
    await r.advance(10_000);
    expect(dataSent(s)).toHaveLength(0);
    expect(s.closeCalls).toBe(1);
    await r.advance(500);
    await r.advance();
    const s2 = r.ws.sockets[1]!;
    s2.throwSend = true;
    s2.message(encodeFrame(eventFrame()));
    await settle();
    expect(s2.closeCalls).toBe(1);
    expect(r.connector.snapshot().counters["write-failed"]).toBe(1);
  });
});

describe("durable ACK, arrival-socket fencing and F1 reassembly", () => {
  it("never ACKs before durability and echoes exact IDs/headers/optional fields via F1", async () => {
    const durable = deferred<{ ack: boolean; reason: string }>();
    const r = await rig({ handleEvent: () => durable.promise });
    const s = await r.start(),
      f = eventFrame();
    s.message(encodeFrame(f));
    await settle();
    expect(r.handleEvent).toHaveBeenCalledTimes(1);
    expect(acks(s)).toHaveLength(0);
    await r.advance(123);
    durable.resolve({ ack: true, reason: "received" });
    await settle();
    expect(dataSent(s)[0]).toEqual(encodeFrame(ackFrame(f, 123)));
    expect(acks(s)[0]).toMatchObject({
      seqId: f.seqId,
      logId: f.logId,
      logIdNew: "new-log",
      payloadEncoding: "",
      payloadType: "application/json",
    });
    expect(Buffer.from(acks(s)[0]!.payload!).toString()).toBe('{"code":200}');
  });
  it("ack:false is not a NACK; successful resolution without ack permission sends nothing", async () => {
    const r = await rig({ handleEvent: async () => ({ ack: false, reason: "dedup-full" }) });
    const s = await r.start();
    s.message(encodeFrame(eventFrame()));
    await settle();
    expect(dataSent(s)).toHaveLength(0);
    expect(r.connector.snapshot().counters["receive-refused"]).toBe(1);
  });
  it("ACK never migrates to a new socket when durable receipt completes after arrival socket is gone", async () => {
    const d = deferred<{ ack: boolean; reason: string }>();
    const r = await rig({ handleEvent: () => d.promise });
    const old = await r.start();
    old.message(encodeFrame(eventFrame()));
    await settle();
    const fresh = await r.reconnect(old);
    d.resolve({ ack: true, reason: "received" });
    await settle();
    expect(acks(old)).toHaveLength(0);
    expect(acks(fresh)).toHaveLength(0);
    expect(r.connector.snapshot().counters["ack-socket-gone"]).toBe(1);
  });
  it("late failed persistence from a retired generation cannot pause the new socket", async () => {
    const d = deferred<{ ack: boolean; reason: string }>();
    const r = await rig();
    r.handleEvent.mockImplementationOnce(() => d.promise);
    const old = await r.start();
    old.message(encodeFrame(eventFrame()));
    await settle();
    const fresh = await r.reconnect(old);
    d.resolve({ ack: false, reason: "persist-failed" });
    await settle();
    expect(r.connector.snapshot()).toMatchObject({ status: "open", paused: false });
    fresh.message(encodeFrame(eventFrame()));
    await settle();
    expect(acks(fresh)).toHaveLength(1);
    expect(acks(old)).toHaveLength(0);
  });
  it("F6 real received + dedup gates ACK; reconnect redelivery invokes durable handler but dispatches only once", async () => {
    const f6 = await f6Rig({ debounceMs: 0 });
    const r = await rig({ handleEvent: (raw) => f6.inbound.handle(raw), state: f6.state });
    const old = await r.start();
    const f = eventFrame(messageEnvelope("redelivery"));
    old.message(encodeFrame(f));
    await eventually(() => acks(old).length === 1);
    expect(acks(old)).toHaveLength(1);
    expect(f6.state.requests.list()).toHaveLength(1);
    expect(f6.state.dedup.size).toBe(2);
    f6.clock.advance(0);
    await eventually(() => f6.request.mock.calls.length === 1);
    expect(f6.request).toHaveBeenCalledTimes(1);
    const next = await r.reconnect(old);
    next.message(encodeFrame(f));
    await settle();
    f6.clock.advance(0);
    await settle();
    await eventually(() => acks(next).length === 1);
    expect(acks(next)).toHaveLength(1);
    expect(f6.request).toHaveBeenCalledTimes(1);
    expect(r.connector.snapshot().counters["duplicate"]).toBe(1);
  });
  it("received durable but arrival socket lost before ACK: redelivery dedups against the SAME commit barrier", async () => {
    const f6 = await f6Rig({ debounceMs: 0 });
    const gate = deferred<boolean>();
    const originalCommit = f6.state.commit.bind(f6.state);
    let blocked = true;
    const commit = vi.spyOn(f6.state, "commit").mockImplementation(async () => {
      const done = await originalCommit();
      if (blocked) await gate.promise;
      return done;
    });
    const r = await rig({ state: f6.state, handleEvent: (raw) => f6.inbound.handle(raw) });
    const old = await r.start();
    old.message(encodeFrame(eventFrame(messageEnvelope("crash-gap"))));
    await settle();
    expect(acks(old)).toHaveLength(0);
    expect(f6.state.requests.list()).toHaveLength(1);
    const next = await r.reconnect(old);
    next.message(encodeFrame(eventFrame(messageEnvelope("crash-gap"))));
    await settle();
    expect(commit).toHaveBeenCalledTimes(1); // F6 coalesces copies onto the first durable commit
    expect(acks(next)).toHaveLength(0);
    blocked = false;
    gate.resolve(true);
    await settle();
    f6.clock.advance(0);
    await settle();
    expect(acks(old)).toHaveLength(0);
    await eventually(() => acks(next).length === 1);
    expect(acks(next)).toHaveLength(1);
    f6.clock.advance(0);
    await eventually(() => f6.request.mock.calls.length === 1);
    expect(f6.request).toHaveBeenCalledTimes(1);
  });
  it("F6 applies V10 millisecond/microsecond stale rules, not transport receipt time", async () => {
    const f6 = await f6Rig();
    const r = await rig({ state: f6.state, handleEvent: (raw) => f6.inbound.handle(raw) });
    const s = await r.start();
    s.message(encodeFrame(eventFrame(messageEnvelope("stale", "must-not-run", { createdAt: String(NOW - 301_000) }))));
    await settle();
    await eventually(() => acks(s).length === 1);
    expect(acks(s)).toHaveLength(1);
    expect(f6.state.requests.list()).toHaveLength(0);
    expect(f6.inboundIntents).toContainEqual(expect.objectContaining({ code: "stale" }));
    expect(f6.request).not.toHaveBeenCalled();
  });
  it("out-of-order fragments reassemble before UTF8 decoding and ACK only the completing arrival", async () => {
    const r = await rig();
    const s = await r.start();
    const payload = Buffer.from(JSON.stringify(messageEnvelope("fragments", "你好")));
    const split = payload.indexOf(Buffer.from("你")) + 1;
    const part = (seq: number, bytes: Uint8Array) =>
      eventFrame(
        {},
        {
          seqId: BigInt(seq + 10),
          payload: bytes,
          headers: [
            { key: "type", value: "card" },
            { key: "type", value: "event" },
            { key: "message_id", value: "fragments" },
            { key: "sum", value: "2" },
            { key: "seq", value: String(seq) },
          ],
        },
      );
    s.message(encodeFrame(part(1, payload.subarray(split))));
    await settle();
    expect(r.handleEvent).not.toHaveBeenCalled();
    expect(dataSent(s)).toHaveLength(0);
    s.message(encodeFrame(part(0, payload.subarray(0, split))));
    await settle();
    expect(r.handleEvent.mock.calls[0]![0]).toEqual(messageEnvelope("fragments", "你好"));
    expect(acks(s)).toHaveLength(1);
    expect(acks(s)[0]!.seqId).toBe(10n);
  });
  it("fragment caches do not cross generations and expire at F1's 10s TTL", async () => {
    const r = await rig();
    const s = await r.start();
    const f = eventFrame();
    f.headers.find((h) => h.key === "sum")!.value = "2";
    s.message(encodeFrame(f));
    const next = await r.reconnect(s);
    f.headers.find((h) => h.key === "seq")!.value = "1";
    next.message(encodeFrame(f));
    await settle();
    expect(r.handleEvent).not.toHaveBeenCalled();
    await r.advance(10_000);
    f.headers.find((h) => h.key === "seq")!.value = "0";
    next.message(encodeFrame(f));
    await settle();
    expect(r.handleEvent).not.toHaveBeenCalled();
    expect(acks(next)).toHaveLength(0);
  });
  it("handler deadline is bounded, aborts staging, and refuses late ACK", async () => {
    const d = deferred<{ ack: boolean; reason: string }>();
    const r = await rig({ handleEvent: () => d.promise });
    const s = await r.start();
    s.message(encodeFrame(eventFrame()));
    await settle();
    const signal = r.handleEvent.mock.calls[0]![1].signal;
    await r.advance(3000);
    expect(signal.aborted).toBe(true);
    expect(dataSent(s)).toHaveLength(0);
    expect(r.connector.snapshot().pending).toBe(1);
    d.resolve({ ack: true, reason: "received" });
    await settle();
    expect(dataSent(s)).toHaveLength(0);
    expect(r.connector.snapshot().pending).toBe(0);
  });
  it("noncooperative timed-out handlers retain capacity instead of accumulating unbounded I/O", async () => {
    const r = await rig({ handleEvent: () => new Promise(() => {}) });
    const s = await r.start();
    for (let i = 0; i <= FEISHU_CAPS.requestsNonTerminal; i++) s.message(encodeFrame(eventFrame()));
    await settle();
    await r.advance(3000);
    s.message(encodeFrame(eventFrame()));
    await settle();
    expect(r.handleEvent).toHaveBeenCalledTimes(FEISHU_CAPS.requestsNonTerminal);
    expect(r.connector.snapshot().counters["receive-capacity"]).toBe(2);
    expect(dataSent(s)).toHaveLength(0);
  });
  it("persist failure pauses event handling, keeps ping live, resumes only on health recovery", async () => {
    const r = await rig({ handleEvent: async () => ({ ack: false, reason: "persist-failed" }) });
    const s = await r.start();
    s.message(encodeFrame(eventFrame()));
    await settle();
    expect(r.connector.snapshot()).toMatchObject({ status: "degraded", reason: "persist-failed", paused: true });
    s.message(encodeFrame(eventFrame()));
    await settle();
    expect(r.handleEvent).toHaveBeenCalledTimes(1);
    await r.advance(10000);
    expect(s.sent).toEqual([encodeFrame(pingFrame(33)), encodeFrame(pingFrame(33))]);
    r.handleEvent.mockResolvedValue({ ack: true, reason: "duplicate" });
    r.connector.resume();
    s.message(encodeFrame(eventFrame()));
    await settle();
    expect(acks(s)).toHaveLength(1);
    expect(r.connector.snapshot().status).toBe("open");
  });
  it("dispose mid-ACK immediately fences even a later successful handler", async () => {
    const d = deferred<{ ack: boolean; reason: string }>();
    const r = await rig({ handleEvent: () => d.promise });
    const s = await r.start();
    s.message(encodeFrame(eventFrame()));
    await settle();
    const p = r.connector.dispose();
    d.resolve({ ack: true, reason: "received" });
    await r.advance();
    await p;
    expect(dataSent(s)).toHaveLength(0);
    expect(r.clock.pending()).toBe(0);
    expect(r.handleEvent.mock.calls[0]![1].signal.aborted).toBe(true);
  });
  it("stop drains existing durable receipts for at most 1s and ignores newly received frames", async () => {
    const d = deferred<{ ack: boolean; reason: string }>();
    const r = await rig({ handleEvent: () => d.promise });
    const s = await r.start();
    s.message(encodeFrame(eventFrame()));
    await settle();
    const p = r.connector.stop();
    s.message(encodeFrame(eventFrame(messageEnvelope("too-late"))));
    await r.advance(999);
    expect(s.closeCalls).toBe(0);
    d.resolve({ ack: true, reason: "received" });
    await settle();
    await r.advance();
    await p;
    expect(acks(s)).toHaveLength(1);
    expect(r.handleEvent).toHaveBeenCalledTimes(1);
    expect(r.clock.pending()).toBe(0);
  });
  it("stop aborts a stuck ACK drain at 1s; no ref timers or reconnect survive", async () => {
    const r = await rig({ handleEvent: () => new Promise(() => {}) });
    const s = await r.start();
    s.message(encodeFrame(eventFrame()));
    await settle();
    const p = r.connector.stop();
    await r.advance(1000);
    await r.advance();
    await p;
    expect(s.closeCalls).toBe(1);
    expect(dataSent(s)).toHaveLength(0);
    expect(r.clock.pending()).toBe(0);
  });
});

describe("malformed table and durable undecodable policy", () => {
  it.each([
    ["non-binary", "text"],
    ["non-binary", new Blob(["binary blob is not our arraybuffer mode"])],
    ["frame-too-large", new Uint8Array(1_048_577)],
    ["truncated-varint", Uint8Array.of(128)],
  ])("drops %s with no ACK or business handler", async (reason, data) => {
    const r = await rig();
    const s = await r.start();
    s.message(data);
    await settle();
    expect(r.handleEvent).not.toHaveBeenCalled();
    expect(dataSent(s)).toHaveLength(0);
    expect(r.connector.snapshot().counters[reason as string]).toBe(1);
  });
  it("codec header-count admission stays strict at the connector boundary", async () => {
    const r = await rig();
    const s = await r.start();
    const f = eventFrame();
    while (f.headers.length < 64) f.headers.push({ key: "extra", value: "ok" });
    // F1 deliberately permits a 65-header OUTGOING ACK, never such an inbound frame.
    s.message(encodeFrame(ackFrame(f)));
    await settle();
    expect(dataSent(s)).toHaveLength(0);
    expect(r.handleEvent).not.toHaveBeenCalled();
    expect(r.connector.snapshot().counters["too-many-headers"]).toBe(1);
  });
  it("legacy card data is NOT ACKed (R2-i overrides earlier table)", async () => {
    const r = await rig();
    const s = await r.start();
    const f = eventFrame();
    f.headers[0]!.value = "card";
    s.message(encodeFrame(f));
    await settle();
    expect(dataSent(s)).toHaveLength(0);
    expect(r.handleEvent).not.toHaveBeenCalled();
    expect(r.connector.snapshot().counters["ignored-type"]).toBe(1);
  });
  it.each(["0", "65", "NaN"])("invalid fragment sum %s no ACK", async (sum) => {
    const r = await rig();
    const s = await r.start();
    const f = eventFrame();
    f.headers.find((h) => h.key === "sum")!.value = sum;
    s.message(encodeFrame(f));
    await settle();
    expect(dataSent(s)).toHaveLength(0);
    expect(r.handleEvent).not.toHaveBeenCalled();
    expect(r.connector.snapshot().counters["fragment-meta"]).toBe(1);
  });
  it.each([
    ["payload-encoding", { payloadEncoding: "gzip" }],
    ["payload-json", { payload: Uint8Array.of(0xff, 0xfe) }],
    ["payload-json", { payload: Buffer.from("{") }],
    ["envelope-invalid", { payload: Buffer.from('{"schema":"3.0"}') }],
  ] as const)("%s records durable diagnostic before ACK then degraded + hourly notice", async (why, fields) => {
    const gate = deferred<boolean>();
    const r = await rig();
    vi.mocked(r.state.commit).mockReturnValue(gate.promise);
    const s = await r.start();
    const f = eventFrame({}, fields);
    s.message(encodeFrame(f));
    await settle();
    expect(r.state.undecodable.record).toHaveBeenCalledWith({ reason: why });
    expect(dataSent(s)).toHaveLength(0);
    expect(r.onUndecodable).not.toHaveBeenCalled();
    gate.resolve(true);
    await settle();
    expect(acks(s)).toHaveLength(1);
    expect(r.connector.snapshot()).toMatchObject({ status: "degraded", reason: "undecodable-events" });
    expect(r.onUndecodable).toHaveBeenCalledTimes(1);
    expect(r.handleEvent).not.toHaveBeenCalled();
    s.message(encodeFrame(f));
    await settle();
    expect(acks(s)).toHaveLength(2);
    expect(r.onUndecodable).toHaveBeenCalledTimes(1);
  });
  it("a lost socket does not consume the redelivery's hourly undecodable notice", async () => {
    const gate = deferred<boolean>();
    const r = await rig();
    vi.mocked(r.state.commit).mockReturnValue(gate.promise);
    const old = await r.start();
    const f = eventFrame({}, { payloadEncoding: "unsupported" });
    old.message(encodeFrame(f));
    await settle();
    const fresh = await r.reconnect(old);
    gate.resolve(true);
    await settle();
    expect(acks(old)).toHaveLength(0);
    expect(r.onUndecodable).not.toHaveBeenCalled();
    expect(r.state.undecodable.markNotice).not.toHaveBeenCalled();
    fresh.message(encodeFrame(f));
    await settle();
    expect(acks(fresh)).toHaveLength(1);
    expect(r.onUndecodable).toHaveBeenCalledTimes(1);
  });
  it("never ACKs an undecodable record that failed/hung fsync; pauses at 1.5s", async () => {
    const r = await rig();
    vi.mocked(r.state.commit).mockReturnValue(new Promise(() => {}));
    const s = await r.start();
    s.message(encodeFrame(eventFrame({}, { payloadEncoding: "unknown" })));
    await settle();
    await r.advance(1499);
    expect(r.connector.snapshot().paused).toBe(false);
    await r.advance(1);
    expect(r.connector.snapshot()).toMatchObject({ status: "degraded", reason: "persist-failed", paused: true });
    expect(dataSent(s)).toHaveLength(0);
    expect(r.onUndecodable).not.toHaveBeenCalled();
  });
  it("throwing handler cannot authorize ACK or expose exception contents", async () => {
    const r = await rig({
      handleEvent: async () => {
        throw new Error("SECRET body /private/path");
      },
    });
    const s = await r.start();
    s.message(encodeFrame(eventFrame()));
    await settle();
    expect(dataSent(s)).toHaveLength(0);
    expect(r.connector.snapshot().counters["receive-failed"]).toBe(1);
    expect(JSON.stringify(r.statuses)).not.toMatch(/SECRET|private|ticket|app-secret/);
  });
});

describe("V7 single receiver and bounded native stalled-close handover", () => {
  it("waits for close (up to 5s), then abandons native socket and resumes backoff; zombies never dispatch/ACK", async () => {
    const r = await rig({ stallClose: true });
    const old = await r.start();
    old.emit("error");
    await r.advance(4999);
    expect(r.bootstrap).toHaveBeenCalledTimes(1);
    old.message(encodeFrame(eventFrame()));
    expect(r.handleEvent).not.toHaveBeenCalled();
    await r.advance(1);
    expect(r.connector.snapshot().zombies).toBe(1);
    await r.advance(500);
    await r.advance();
    expect(r.ws.sockets).toHaveLength(2);
    const live = r.ws.sockets[1]!;
    // Retirement retains neutralized message/error/close handlers, not business handlers.
    expect(old.listeners.get("open")?.size).toBe(0);
    expect(old.listeners.get("message")?.size).toBe(1);
    expect(old.listeners.get("error")?.size).toBe(1);
    expect(old.listeners.get("close")?.size).toBe(1);
    old.message(encodeFrame(eventFrame()));
    live.message(encodeFrame(eventFrame()));
    await settle();
    expect(r.handleEvent).toHaveBeenCalledTimes(1);
    expect(acks(old)).toHaveLength(0);
    expect(acks(live)).toHaveLength(1);
    expect(r.connector.snapshot().counters["zombie-frame"]).toBe(1);
    old.finishClose();
    expect(r.connector.snapshot().zombies).toBe(0);
    expect([...old.listeners.values()].every((set) => set.size === 0)).toBe(true);
  });
  it("uses injected terminate after 5s instead of abandoning", async () => {
    const r = await rig({ stallClose: true, terminable: true });
    const s = await r.start();
    s.emit("error");
    await r.advance(5000);
    expect(s.terminateCalls).toBe(1);
    expect(s.readyState).toBe(3);
    expect(r.connector.snapshot().zombies).toBe(0);
    await r.advance(500);
    await r.advance();
    expect(r.ws.peak()).toBe(1);
  });
  it("three stalls block further dials with degraded(close-timeout); zombie close automatically resumes", async () => {
    const r = await rig({ stallClose: true });
    await r.start();
    for (let i = 0; i < 3; i++) {
      r.ws.sockets[i]!.emit("error");
      await r.advance(5000);
      await r.advance(1000);
      await r.advance();
    }
    expect(r.ws.sockets).toHaveLength(3);
    expect(r.connector.snapshot()).toMatchObject({ status: "degraded", reason: "close-timeout", zombies: 2 });
    await r.advance(600_000);
    expect(r.ws.sockets).toHaveLength(3);
    r.ws.sockets[0]!.finishClose();
    await r.advance(2000);
    await r.advance();
    expect(r.ws.sockets).toHaveLength(4);
    expect(r.connector.snapshot()).toMatchObject({ status: "open", zombies: 2 });
    expect(r.ws.peak()).toBe(3);
  });
  it("start after stop with the third stalled close reports degraded and resumes when a zombie closes", async () => {
    const r = await rig({ stallClose: true });
    await r.start();
    for (let i = 0; i < 3; i++) {
      r.ws.sockets[i]!.emit("error");
      await r.advance(5000);
      await r.advance(1000);
      await r.advance();
    }
    await r.connector.stop();
    expect(r.connector.snapshot().status).toBe("stopped");
    r.connector.start();
    expect(r.connector.snapshot()).toMatchObject({ status: "degraded", reason: "close-timeout", zombies: 2 });
    await r.advance(600_000);
    expect(r.ws.sockets).toHaveLength(3);
    r.ws.sockets[0]!.finishClose();
    await r.advance(2000);
    await r.advance();
    expect(r.connector.snapshot()).toMatchObject({ status: "open", gen: 4, zombies: 2 });
    expect(r.ws.peak()).toBe(3);
  });
  it("a zombie error also frees the bounded handover slot, never resurrects a stopped connector", async () => {
    const r = await rig({ stallClose: true });
    const s = await r.start();
    s.emit("error");
    await r.advance(5000);
    await r.connector.stop();
    s.emit("error");
    await r.advance(600_000);
    expect(r.connector.snapshot()).toMatchObject({ status: "stopped", zombies: 0 });
    expect(r.ws.sockets).toHaveLength(1);
    expect(r.clock.pending()).toBe(0);
  });
  it("late open and queued handlers of an abandoned handshake cannot resurrect it", async () => {
    const r = await rig({ autoOpen: false, stallClose: true });
    const old = await r.start();
    const lateOpen = [...old.listeners.get("open")!][0]!;
    await r.advance(10_000);
    await r.advance(5000);
    await r.advance(500);
    await r.advance();
    expect(r.ws.sockets).toHaveLength(2);
    const fresh = r.ws.sockets[1]!;
    fresh.open();
    lateOpen({});
    old.open();
    old.message(encodeFrame(eventFrame()));
    expect(r.connector.snapshot()).toMatchObject({ status: "open", gen: 2 });
    expect(r.handleEvent).not.toHaveBeenCalled();
    expect(dataSent(old)).toHaveLength(0);
  });
  it("dispose during a stalled close is bounded and never starts a successor", async () => {
    const r = await rig({ stallClose: true });
    const s = await r.start();
    const p = r.connector.dispose();
    await r.advance(5000);
    await p;
    await r.advance(600_000);
    expect(r.ws.sockets).toHaveLength(1);
    expect(r.connector.snapshot()).toMatchObject({ status: "stopped", zombies: 1 });
    s.message(encodeFrame(eventFrame()));
    expect(r.handleEvent).not.toHaveBeenCalled();
    expect(dataSent(s)).toHaveLength(0);
    expect(r.clock.pending()).toBe(0);
  });
});

// Real RFC6455 framing exercises Node22's built-in client, independent of the scripted seam.
async function eventually(predicate: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("fake-ws-observation-timeout");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5);
      timer.unref();
    });
  }
}
describe("real global WebSocket against RFC6455 fake server", () => {
  it("boots with F2, receives binary pbbp2, ACKs exactly, and drops/reconnects without overlap", async () => {
    const server = await createFakeWsServer();
    cleanup.push(() => server.dispose());
    const fake = createFakeFeishu();
    const http = createFeishuHttp({ apiBase: "https://open.feishu.cn", fetch: fake.fetch });
    const token = createTokenManager({
      http,
      credentials: () => ({ appId: fake.appId, appSecret: fake.appSecret, gen: 1 }),
    });
    const api = createFeishuApi({ http, token });
    const receive = vi.fn(async () => ({ ack: true, reason: "received" }));
    const NativeWebSocket = globalThis.WebSocket;
    vi.stubGlobal(
      "WebSocket",
      class extends NativeWebSocket {
        constructor(_url: string) {
          super(server.url);
        }
      },
    );
    const c = createFeishuConnector({
      credentials: { appId: fake.appId, appSecret: fake.appSecret },
      api,
      state: {
        connectorMayStart: () => true,
        commit: async () => true,
        undecodable: { record() {}, snapshot: () => ({ count: 0, ring: [] }), noticeDue: () => false, markNotice() {} },
      } as FeishuConnectorDeps["state"],
      handleEvent: receive,
      random: () => 0,
    });
    cleanup.push(async () => {
      await c.dispose();
      token.dispose();
    });
    c.start();
    await eventually(() => c.snapshot().status === "open");
    const f = eventFrame();
    server.peers[0]!.send(encodeFrame(f));
    await eventually(() => server.peers[0]!.received.length === 2);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(Uint8Array.from(server.peers[0]!.received[0]!)).toEqual(encodeFrame(pingFrame(33)));
    const ack = decodeFrame(server.peers[0]!.received[1]);
    expect(ack.seqId).toBe(f.seqId);
    expect(ack.payload).toEqual(new TextEncoder().encode(FEISHU_ACK.payload));
    server.peers[0]!.drop();
    await eventually(() => server.peers.length === 2 && c.snapshot().status === "open");
    expect(server.peak()).toBe(1);
    expect(fake.callsTo("POST", "/callback/ws/endpoint")).toHaveLength(2);
    const stopped = c.stop();
    await stopped;
    expect(c.snapshot().status).toBe("stopped");
  });
});
