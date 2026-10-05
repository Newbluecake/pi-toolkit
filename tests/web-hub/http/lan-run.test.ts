/**
 * fleet-drawer plan §9 F4 acceptance (LAN half): the L-gating matrix's LAN rows at the HTTP
 * layer — L1 (all caps ⇒ usable), L4/L6 (missing `runtx.lan.v1` / no caps ⇒ 409 E_UNSUPPORTED),
 * L9 (caps change mid-subscription ⇒ `unsupported` error frame + cleanup), L10 (direct
 * subscribe AND page both 409 — bypassing any UI), plus the LAN session/CSRF gates.
 *
 * Local harness: `lan-helpers.ts`'s `startLan` cannot be modified (F4's file domain) and takes
 * no `runTx`, so this file assembles its own frontend from the same building blocks (fake
 * store/KDF from `tests/web-hub/contract/fakes.ts`, real hosts/ratelimit/kdf-admission/scope,
 * real registry + real F3b service + fake agent conn).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentFrame, HubFrame } from "../../../src/web-hub/protocol/messages.js";
import { PROTO } from "../../../src/web-hub/protocol/version.js";
import type { HttpFrontend, RunTranscriptService } from "../../../src/web-hub/hub/ports.js";
import { createRegistry } from "../../../src/web-hub/hub/registry.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { createRunFileReader } from "../../../src/web-hub/hub/run-file-reader.js";
import { createRunTranscriptService } from "../../../src/web-hub/hub/run-transcript.js";
import { createScope } from "../../../src/web-hub/hub/lifecycle.js";
import { createHostsPort } from "../../../src/web-hub/hub/net-hosts.js";
import { createKdfAdmission } from "../../../src/web-hub/hub/kdf-admission.js";
import { createLoginLimiter } from "../../../src/web-hub/hub/ratelimit.js";
import { fakeKdf, fakeLanStore } from "../contract/fakes.js";
import { testHubPaths } from "../helpers/paths.js";
import { fakeConn, hello, memLog, type FakeConn, type Hello } from "../hub/helpers.js";
import { captureLog } from "./helpers.js";
import { LAN_JSON_HEADERS, lanPostJson, lanRequest, openSse, seedLanUser } from "./lan-helpers.js";

const RUN = "r_ABCDEFGH";
const TAP = "tapAAAAAAAAAAAA";
const ALL_CAPS = ["ev.v1", "runtx.v1", "runtx.lan.v1"];

type ReqFrame = Extract<HubFrame, { t: "run_tx_req" }>;
type ReplyBuilder = (req: ReqFrame) => AgentFrame;

const liveReply =
  (over: Partial<Extract<AgentFrame, { t: "run_tx_reply"; ok: true; source: "live" }>> = {}): ReplyBuilder =>
  (req) => ({
    t: "run_tx_reply",
    rid: req.rid,
    runId: req.runId,
    ok: true,
    source: "live",
    status: "running",
    tapId: TAP,
    seq: 0,
    watching: true,
    entries: [],
    truncated: false,
    hasMore: false,
    ...over,
  });

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

interface LanRunHub {
  port: number;
  cookie: string;
  agentKey: string;
  conn: FakeConn;
  svc: RunTranscriptService;
  /** Re-hello the SAME agent with different caps (registry reclaim path). */
  rehello(caps: string[]): void;
  close(): Promise<void>;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr !== null && typeof addr === "object" ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function startLanRun(opts: { caps?: string[] } = {}): Promise<LanRunHub> {
  const dir = mkdtempSync(join(tmpdir(), "pwh-lanrun-"));
  const paths = testHubPaths(join(dir, "state"));
  const log = captureLog();
  const store = fakeLanStore();
  const kdf = fakeKdf();
  const clockT = 1_700_000_000_000;
  const now = (): number => clockT;
  const limiter = createLoginLimiter({ now });
  const admission = createKdfAdmission({ now, isTightened: limiter.isTightened });
  const hosts = createHostsPort();
  const scope = createScope({ log, now });

  const reg = createRegistry({ now, log: memLog(), pidAlive: () => true });
  const base = fakeConn();
  let agentKey = "";
  const conn: FakeConn = {
    sent: base.sent,
    closedWith: base.closedWith,
    send: (f: HubFrame) => {
      base.send(f);
      if (f.t === "run_tx_req") reg.onFrame(agentKey, liveReply()(f));
    },
    close: base.close,
  };
  const helloFrame = (caps: string[]): Hello => hello({ caps, agentId: { pid: 4242, nonce: "nonceAAAAAAAAAAAAAAA" } });
  agentKey = reg.register(helloFrame(opts.caps ?? ALL_CAPS), conn).agentKey;
  const svc = createRunTranscriptService({ registry: reg, reader: createRunFileReader({ now }), log: memLog(), now });

  const fe: HttpFrontend = createHttpFrontend({
    config: { v: 1, home: dir, port: 0, idleExitMinutes: 10, pluginVersion: "0.0.0-test", buildId: "b1" },
    paths,
    registry: reg,
    bus: reg.bus,
    history: {
      snapshot: async (agentKey2) => ({
        agentKey: agentKey2,
        entries: [],
        tailMessages: [],
        fromSeq: 1,
        hasMore: false,
        source: "file",
      }),
      page: async (agentKey2) => ({
        agentKey: agentKey2,
        entries: [],
        tailMessages: [],
        fromSeq: 1,
        hasMore: false,
        source: "file",
      }),
      onLeafChanged: () => {},
    },
    log,
    info: () => ({ version: "9.9.9-test", buildId: "b1", pid: process.pid, startedAt: now(), proto: PROTO }),
    now,
    lan: {
      cfg: { port: await freePort(), extraHosts: [], trustProxyFrom: [], externalOrigins: [] },
      store,
      kdf,
      limiter,
      admission,
      hosts,
      scope,
      onStatus: () => {},
    },
    runTx: svc,
  });
  if (fe.lan === undefined) throw new Error("test bug: fe.lan not constructed");
  const status = await fe.lan.start();
  if (status.state !== "on") throw new Error(`test bug: lan start failed: ${JSON.stringify(status)}`);

  seedLanUser(store, { username: "alice", password: "correct-horse-battery" });
  const loginRes = await lanPostJson(status.port, "/api/login", {
    username: "alice",
    password: "correct-horse-battery",
  });
  if (loginRes.status !== 200) throw new Error(`test bug: lan login failed: ${loginRes.status}`);
  const cookie = (loginRes.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;

  const close = async (): Promise<void> => {
    await fe.close();
    await scope.dispose();
    rmSync(dir, { recursive: true, force: true });
  };
  closers.push(close);
  return {
    port: status.port,
    cookie,
    agentKey,
    conn,
    svc,
    rehello: (caps: string[]) => {
      reg.register(helloFrame(caps), conn);
    },
    close,
  };
}

const watchFrames = (conn: FakeConn): Array<{ runId: string; on: boolean }> =>
  conn.sent
    .filter((f): f is Extract<HubFrame, { t: "run_watch" }> => f.t === "run_watch")
    .map((f) => ({ runId: f.runId, on: f.on }));

async function lanSse(h: LanRunHub): Promise<{
  events: { event: string; data: any }[];
  waitFor(name: string, ms?: number): Promise<{ event: string; data: any }>;
  close(): void;
  clientId(): string;
}> {
  const conn = await openSse(h.port, h.cookie);
  const helloEv = await conn.waitFor("hello");
  return {
    events: conn.events as { event: string; data: any }[],
    waitFor: (name, ms) => conn.waitFor(name, ms),
    close: () => conn.close(),
    clientId: () => helloEv.data.clientId as string,
  };
}

async function lanSubscribe(h: LanRunHub, clientId: string): Promise<{ status: number; body: string }> {
  return lanPostJson(
    h.port,
    "/api/run/subscribe",
    { clientId, agentKey: h.agentKey, runId: RUN },
    { Cookie: h.cookie },
  );
}

// `openSse`/`seedLanUser`/`lanPostJson`/`lanRequest` above keep helper parity with the other
// LAN suites; the harness itself is local because `startLan` (out of F4's file domain) takes
// no `runTx` dep.

describe("run routes on the LAN listener (L matrix, F4 layer)", () => {
  it("L1: all caps ⇒ subscribe 202, run_history over LAN SSE, GET page 200 with live:false", async () => {
    const h = await startLanRun(); // ALL_CAPS
    const c = await lanSse(h);
    try {
      const r = await lanSubscribe(h, c.clientId());
      expect(r.status).toBe(202);
      expect(JSON.parse(r.body)).toEqual({ ok: true });
      const err = await c.waitFor("run_history");
      expect(err.data.runId).toBe(RUN);
      expect(err.data.live).toBe(true);
      const g = await lanRequest(h.port, {
        method: "GET",
        path: `/api/run/history?agent=${h.agentKey}&run=${RUN}&before=e1`,
        headers: { Cookie: h.cookie },
      });
      expect(g.status).toBe(200);
      expect((JSON.parse(g.body) as { live: boolean }).live).toBe(false);
    } finally {
      c.close();
    }
  });

  it("L4: runtx.v1 without runtx.lan.v1 ⇒ LAN 409 E_UNSUPPORTED on subscribe and page (loopback stays fine)", async () => {
    const h = await startLanRun({ caps: ["ev.v1", "runtx.v1"] });
    const c = await lanSse(h);
    try {
      const r = await lanSubscribe(h, c.clientId());
      expect(r.status).toBe(409);
      expect(JSON.parse(r.body)).toEqual({ error: "E_UNSUPPORTED", message: "unsupported" });
      const g = await lanRequest(h.port, {
        method: "GET",
        path: `/api/run/history?agent=${h.agentKey}&run=${RUN}&before=e1`,
        headers: { Cookie: h.cookie },
      });
      expect(g.status).toBe(409);
      expect(JSON.parse(g.body)).toEqual({ error: "E_UNSUPPORTED", message: "unsupported" });
      expect(watchFrames(h.conn)).toEqual([]); // no tap ever armed
    } finally {
      c.close();
    }
  });

  it("L6: no runtx caps at all ⇒ LAN 409 on both endpoints", async () => {
    const h = await startLanRun({ caps: ["ev.v1"] });
    const c = await lanSse(h);
    try {
      expect((await lanSubscribe(h, c.clientId())).status).toBe(409);
      const g = await lanRequest(h.port, {
        method: "GET",
        path: `/api/run/history?agent=${h.agentKey}&run=${RUN}&before=e1`,
        headers: { Cookie: h.cookie },
      });
      expect(g.status).toBe(409);
    } finally {
      c.close();
    }
  });

  it("L9: caps change (all → loopback) mid-subscription ⇒ existing LAN sub gets `unsupported` and is cleaned up", async () => {
    const h = await startLanRun(); // all caps
    const c = await lanSse(h);
    try {
      expect((await lanSubscribe(h, c.clientId())).status).toBe(202);
      await c.waitFor("run_history");
      expect(watchFrames(h.conn)).toEqual([{ runId: RUN, on: true }]);
      h.rehello(["ev.v1", "runtx.v1"]); // drop runtx.lan.v1: the LAN ref no longer qualifies
      await settle();
      // the service's caps re-validation fires sink.dropped(E_UNSUPPORTED, ["lan:<id>"]) — the
      // LAN route's prefix filter matches its own sub and delivers the error frame.
      const errFrame = c.events.find(
        (e) => e.event === "run_history" && e.data?.error === "E_UNSUPPORTED" && e.data?.reason === "unsupported",
      );
      expect(errFrame).toBeDefined();
      expect(watchFrames(h.conn)).toEqual([
        { runId: RUN, on: true },
        { runId: RUN, on: false }, // service reclaimed the watch (its last ref died)
      ]);
      // and the sub is gone: a later unsubscribe is an idempotent 200, not a double-release
      const un = await lanPostJson(
        h.port,
        "/api/run/unsubscribe",
        { clientId: c.clientId(), agentKey: h.agentKey, runId: RUN },
        { Cookie: h.cookie },
      );
      expect(un.status).toBe(200);
      expect(watchFrames(h.conn).filter((w) => w.on === false).length).toBe(1);
    } finally {
      c.close();
    }
  });

  it("L10: loopback-only caps ⇒ BOTH direct LAN calls (subscribe, GET page) answer 409", async () => {
    const h = await startLanRun({ caps: ["ev.v1", "runtx.v1"] });
    const c = await lanSse(h);
    try {
      expect((await lanSubscribe(h, c.clientId())).status).toBe(409);
      const g = await lanRequest(h.port, {
        method: "GET",
        path: `/api/run/history?agent=${h.agentKey}&run=${RUN}&before=e1`,
        headers: { Cookie: h.cookie },
      });
      expect(g.status).toBe(409);
      expect(JSON.parse(g.body)).toEqual({ error: "E_UNSUPPORTED", message: "unsupported" });
    } finally {
      c.close();
    }
  });

  it("session/CSRF gates: POST without session ⇒ 401, POST without Origin ⇒ 403 E_CSRF, GET without session ⇒ 401", async () => {
    const h = await startLanRun();
    const noCookie = await lanRequest(h.port, {
      method: "POST",
      path: "/api/run/subscribe",
      headers: { ...LAN_JSON_HEADERS, Origin: `http://127.0.0.1:${h.port}` },
      body: JSON.stringify({ clientId: "c_x", agentKey: h.agentKey, runId: RUN }),
    });
    expect(noCookie.status).toBe(401);
    const noOrigin = await lanRequest(h.port, {
      method: "POST",
      path: "/api/run/subscribe",
      headers: { ...LAN_JSON_HEADERS, Cookie: h.cookie }, // csrfOkLan requires Origin
      body: JSON.stringify({ clientId: "c_x", agentKey: h.agentKey, runId: RUN }),
    });
    expect(noOrigin.status).toBe(403);
    expect(JSON.parse(noOrigin.body)).toEqual({ error: "E_CSRF" });
    const getNoCookie = await lanRequest(h.port, {
      method: "GET",
      path: `/api/run/history?agent=${h.agentKey}&run=${RUN}&before=e1`,
    });
    expect(getNoCookie.status).toBe(401);
  });
});
