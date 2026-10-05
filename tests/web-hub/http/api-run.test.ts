/**
 * fleet-drawer plan §9 F4 acceptance (loopback half): the G-subscription-generation matrix,
 * the L-gating matrix's loopback rows, and the three F4 hard contracts —
 *
 * 1. replay watermark strictness (drop `seq <= watermark`; a first-frame hole ⇒ one resync;
 *    terminal history discards every buffered frame),
 * 2. SSE three-path card delivery is pinned end-to-end in `sse.test.ts` (this file pins the
 *    run frames' direct-send shape),
 * 3. listener gating (missing `runtx.v1` ⇒ 409 E_UNSUPPORTED on both subscribe and page).
 *
 * Two harnesses: a REAL service (real registry + real F3b service + fake agent conn answering
 * `run_tx_req`) for end-to-end HTTP/SSE behavior, and a STUB service whose snapshot promises
 * and sink are hand-driven for the timing/generation cases (G1–G4, G9, contract 1).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AgentFrame, HubFrame } from "../../../src/web-hub/protocol/messages.js";
import type { RunHistoryPayload } from "../../../src/web-hub/protocol/run-transcript.js";
import type { HttpFrontend, RunSink, RunTranscriptService } from "../../../src/web-hub/hub/ports.js";
import { HubError, createRegistry } from "../../../src/web-hub/hub/registry.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { createRunFileReader } from "../../../src/web-hub/hub/run-file-reader.js";
import { createRunTranscriptService } from "../../../src/web-hub/hub/run-transcript.js";
import {
  fakeDeps,
  login,
  makeAgent,
  makeTmp,
  openSse,
  postJson,
  rawRequest,
  type FakeDeps,
  type SseConn,
} from "./helpers.js";
import { fakeConn, hello, memLog, type FakeConn } from "../hub/helpers.js";

const RUN = "r_ABCDEFGH";
const RUN2 = "r_JKMNPQRT";
const RUN3 = "r_PQRSTVWX";
const TAP = "tapAAAAAAAAAAAA";

const ALL_CAPS = ["ev.v1", "runtx.v1", "runtx.lan.v1"];
const LO_CAPS = ["ev.v1", "runtx.v1"];

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

// ---------------------------------------------------------------------------
// real-service harness
// ---------------------------------------------------------------------------

interface RealHub {
  fe: HttpFrontend;
  port: number;
  cookie: string;
  agentKey: string;
  conn: FakeConn;
  svc: RunTranscriptService;
  deps: FakeDeps;
  close(): Promise<void>;
}

const liveConns: SseConn[] = [];
const hubs: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const c of liveConns.splice(0)) c.close();
  for (const close of hubs.splice(0)) await close();
});

/** Real registry + real F3b service + fake agent conn that answers every `run_tx_req`
 * synchronously (scriptable via `opts.replies`; `opts.hold` keeps them in flight instead). */
async function startRealHub(
  opts: { caps?: string[]; replies?: ReplyBuilder[]; hold?: boolean } = {},
): Promise<RealHub & { answerHeld(b: ReplyBuilder): void; holdOn(): void }> {
  const tmp = makeTmp("pwh-runapi-");
  const deps = fakeDeps(tmp.dir);
  const t = 1_000_000;
  const reg = createRegistry({ now: () => t, log: memLog(), pidAlive: () => true });
  const base = fakeConn();
  const replies = [...(opts.replies ?? [])];
  const held: ReqFrame[] = [];
  const hold = { on: opts.hold === true };
  let agentKey = "";
  const conn: FakeConn = {
    sent: base.sent,
    closedWith: base.closedWith,
    send: (f: HubFrame) => {
      base.send(f);
      if (f.t === "run_tx_req") {
        if (hold.on) {
          held.push(f);
          return;
        }
        const next = replies.shift() ?? liveReply();
        reg.onFrame(agentKey, next(f));
      }
    },
    close: base.close,
  };
  agentKey = reg.register(hello({ caps: opts.caps ?? LO_CAPS }), conn).agentKey;
  const svc = createRunTranscriptService({
    registry: reg,
    reader: createRunFileReader({ now: () => t }),
    log: memLog(),
    now: () => t,
  });
  const fe = createHttpFrontend({ ...deps, registry: reg, bus: reg.bus, runTx: svc });
  const { port } = await fe.listen();
  const cookie = await login(port, deps.paths.tokenFile);
  const h = {
    fe,
    port,
    cookie,
    agentKey,
    conn,
    svc,
    deps,
    async close() {
      await fe.close();
      tmp.cleanup();
    },
    answerHeld(b: ReplyBuilder) {
      const req = held.shift();
      if (req === undefined) throw new Error("test bug: no held run_tx_req");
      hold.on = false;
      reg.onFrame(agentKey, b(req));
    },
    holdOn() {
      hold.on = true;
    },
  };
  hubs.push(h.close);
  return h;
}

async function sseClient(port: number, cookie: string): Promise<{ conn: SseConn; clientId: string }> {
  const conn = await openSse(port, { cookie });
  liveConns.push(conn);
  const helloEv = await conn.waitFor((e) => e.event === "hello");
  return { conn, clientId: helloEv.data.clientId as string };
}

const watchFrames = (conn: FakeConn): Array<{ runId: string; on: boolean }> =>
  conn.sent
    .filter((f): f is Extract<HubFrame, { t: "run_watch" }> => f.t === "run_watch")
    .map((f) => ({ runId: f.runId, on: f.on }));

// ---------------------------------------------------------------------------
// stub-service harness (hand-driven snapshot promises + captured sink)
// ---------------------------------------------------------------------------

interface StubRec {
  watches: Array<{ agentKey: string; runId: string; ref: string }>;
  unwatches: Array<{ agentKey: string; runId: string; ref: string }>;
  snapshots: number;
  sink: RunSink | undefined;
  pending: Array<{ resolve(p: RunHistoryPayload): void; reject(e: unknown): void }>;
  svc: RunTranscriptService;
}

function stubRunTx(): StubRec {
  const rec: StubRec = {
    watches: [],
    unwatches: [],
    snapshots: 0,
    sink: undefined,
    pending: [],
    svc: undefined as unknown as RunTranscriptService,
  };
  rec.svc = {
    snapshot(agentKey, runId, _listener) {
      rec.snapshots++;
      return new Promise<RunHistoryPayload>((resolve, reject) => rec.pending.push({ resolve, reject }));
    },
    page(agentKey, runId, before, _limit, _listener) {
      return Promise.reject(new HubError("E_BUSY", `page:${agentKey}:${runId}:${before}`));
    },
    watch(agentKey, runId, ref) {
      rec.watches.push({ agentKey, runId, ref });
    },
    unwatch(agentKey, runId, ref) {
      rec.unwatches.push({ agentKey, runId, ref });
    },
    onFrame() {},
    setSink(s) {
      rec.sink = s;
    },
    dispose() {},
  };
  return rec;
}

async function startStubHub(): Promise<{ port: number; cookie: string; rec: StubRec; close(): Promise<void> }> {
  const tmp = makeTmp("pwh-runstub-");
  const deps = fakeDeps(tmp.dir);
  deps.agents.set("a1", makeAgent("a1"));
  const rec = stubRunTx();
  const fe = createHttpFrontend({ ...deps, runTx: rec.svc });
  const { port } = await fe.listen();
  const cookie = await login(port, deps.paths.tokenFile);
  const close = async (): Promise<void> => {
    await fe.close();
    tmp.cleanup();
  };
  hubs.push(close);
  return { port, cookie, rec, close };
}

const payload = (over: Partial<RunHistoryPayload> = {}): RunHistoryPayload => ({
  agentKey: "a1",
  runId: RUN,
  entries: [],
  tailMessages: [],
  fromSeq: 1,
  hasMore: false,
  source: "live",
  terminal: false,
  status: "running",
  live: true,
  ...over,
});

const evPayload = (seq: number): { agentKey: string; runId: string; tapId: string; seq: number; e: object } => ({
  agentKey: "a1",
  runId: RUN,
  tapId: TAP,
  seq,
  e: { type: "turn_start" },
});

async function stubSubscribe(
  h: { port: number; cookie: string },
  clientId: string,
  runId: string = RUN,
): Promise<number> {
  const r = await postJson(h.port, "/api/run/subscribe", { clientId, agentKey: "a1", runId }, { Cookie: h.cookie });
  return r.status;
}

// ---------------------------------------------------------------------------

describe("run routes over the real service (loopback)", () => {
  it("subscribe with runtx.v1 (no lan cap needed) ⇒ 202; run_watch precedes run_tx_req; run_history delivered (L3)", async () => {
    const h = await startRealHub(); // caps: ev.v1 + runtx.v1
    const c = await sseClient(h.port, h.cookie);
    const r = await postJson(
      h.port,
      "/api/run/subscribe",
      { clientId: c.clientId, agentKey: h.agentKey, runId: RUN },
      { Cookie: h.cookie },
    );
    expect(r.status).toBe(202);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
    const hist = await c.conn.waitFor((e) => e.event === "run_history");
    expect(hist.data.runId).toBe(RUN);
    expect(hist.data.source).toBe("live");
    expect(hist.data.live).toBe(true);
    expect(hist.id).toBeUndefined(); // directed: never consumes an event id
    const kinds = h.conn.sent.map((f) => f.t);
    expect(kinds.indexOf("run_watch")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("run_watch")).toBeLessThan(kinds.indexOf("run_tx_req"));
    expect(watchFrames(h.conn)).toEqual([{ runId: RUN, on: true }]);
  });

  it("missing runtx caps ⇒ 409 E_UNSUPPORTED on subscribe AND page; no watch ever armed (L5/L7 loopback)", async () => {
    const h = await startRealHub({ caps: ["ev.v1"] });
    const c = await sseClient(h.port, h.cookie);
    const r = await postJson(
      h.port,
      "/api/run/subscribe",
      { clientId: c.clientId, agentKey: h.agentKey, runId: RUN },
      { Cookie: h.cookie },
    );
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body)).toEqual({ error: "E_UNSUPPORTED", message: "unsupported" });
    const g = await rawRequest(h.port, {
      method: "GET",
      path: `/api/run/history?agent=${h.agentKey}&run=${RUN}&before=e1`,
      headers: { Cookie: h.cookie },
    });
    expect(g.status).toBe(409);
    expect(JSON.parse(g.body)).toEqual({ error: "E_UNSUPPORTED", message: "unsupported" });
    expect(watchFrames(h.conn)).toEqual([]);
  });

  it("G5: two clients on one run ⇒ one watch, own snapshots each, run_ev fans out to both", async () => {
    const h = await startRealHub();
    const a = await sseClient(h.port, h.cookie);
    const b = await sseClient(h.port, h.cookie);
    expect(await stubSubscribeReal(h, a.clientId)).toBe(202);
    expect(await stubSubscribeReal(h, b.clientId)).toBe(202);
    await a.conn.waitFor((e) => e.event === "run_history");
    await b.conn.waitFor((e) => e.event === "run_history");
    expect(watchFrames(h.conn)).toEqual([{ runId: RUN, on: true }]); // refcount: exactly one on
    expect(h.conn.sent.filter((f) => f.t === "run_tx_req").length).toBe(2); // own snapshot each
    h.svc.onFrame(h.agentKey, { t: "run_ev", runId: RUN, tapId: TAP, seq: 1, e: { type: "turn_start" } });
    const ea = await a.conn.waitFor((e) => e.event === "run_ev");
    const eb = await b.conn.waitFor((e) => e.event === "run_ev");
    expect(ea.data.seq).toBe(1);
    expect(eb.data.seq).toBe(1);
  });

  it("G6: A unsubscribes ⇒ B unaffected; watch off only after the last unsubscribe", async () => {
    const h = await startRealHub();
    const a = await sseClient(h.port, h.cookie);
    const b = await sseClient(h.port, h.cookie);
    await stubSubscribeReal(h, a.clientId);
    await stubSubscribeReal(h, b.clientId);
    await a.conn.waitFor((e) => e.event === "run_history");
    await b.conn.waitFor((e) => e.event === "run_history");
    const un = await postJson(
      h.port,
      "/api/run/unsubscribe",
      { clientId: a.clientId, agentKey: h.agentKey, runId: RUN },
      { Cookie: h.cookie },
    );
    expect(un.status).toBe(200);
    expect(watchFrames(h.conn)).toEqual([{ runId: RUN, on: true }]); // B still holds a ref
    h.svc.onFrame(h.agentKey, { t: "run_ev", runId: RUN, tapId: TAP, seq: 1, e: { type: "turn_start" } });
    await b.conn.waitFor((e) => e.event === "run_ev");
    await settle();
    expect(a.conn.events.filter((e) => e.event === "run_ev").length).toBe(0); // A is out
    const un2 = await postJson(
      h.port,
      "/api/run/unsubscribe",
      { clientId: b.clientId, agentKey: h.agentKey, runId: RUN },
      { Cookie: h.cookie },
    );
    expect(un2.status).toBe(200);
    expect(watchFrames(h.conn)).toEqual([
      { runId: RUN, on: true },
      { runId: RUN, on: false },
    ]);
  });

  it("G8: run_ev + run_end buffered during a pending window ⇒ replayed in order after the history", async () => {
    const h = await startRealHub();
    const c = await sseClient(h.port, h.cookie);
    expect(await stubSubscribeReal(h, c.clientId)).toBe(202);
    await c.conn.waitFor((e) => e.event === "run_history"); // establishes the watch's tapId
    h.holdOn();
    expect(await stubSubscribeReal(h, c.clientId)).toBe(202); // re-subscribe: fresh pending sub
    h.svc.onFrame(h.agentKey, { t: "run_ev", runId: RUN, tapId: TAP, seq: 1, e: { type: "turn_start" } });
    h.svc.onFrame(h.agentKey, { t: "run_end", runId: RUN, tapId: TAP, lastSeq: 1, status: "completed" });
    await settle();
    expect(c.conn.events.filter((e) => e.event.startsWith("run_")).length).toBe(1); // only the first history — the rest is buffered
    h.answerHeld(liveReply()); // watermark seq 0
    const hist = await c.conn.waitFor(
      (e, all) => e.event === "run_history" && all.filter((x) => x.event === "run_history").indexOf(e) === 1,
    );
    const ev1 = await c.conn.waitFor((e) => e.event === "run_ev");
    const end = await c.conn.waitFor((e) => e.event === "run_end");
    const idx = (ev: { event: string }): number => c.conn.events.indexOf(ev);
    expect(idx(hist)).toBeLessThan(idx(ev1));
    expect(idx(ev1)).toBeLessThan(idx(end));
    expect(end.data).toMatchObject({ runId: RUN, lastSeq: 1, status: "completed" });
  });

  it("G7: third distinct run for one client ⇒ 503 E_BUSY; re-subscribing an existing run is not counted", async () => {
    const h = await startRealHub();
    const c = await sseClient(h.port, h.cookie);
    expect(await stubSubscribeReal(h, c.clientId, RUN)).toBe(202);
    expect(await stubSubscribeReal(h, c.clientId, RUN2)).toBe(202);
    await c.conn.waitFor((e) => e.event === "run_history");
    const third = await postJson(
      h.port,
      "/api/run/subscribe",
      { clientId: c.clientId, agentKey: h.agentKey, runId: RUN3 },
      { Cookie: h.cookie },
    );
    expect(third.status).toBe(503);
    expect(JSON.parse(third.body)).toEqual({ error: "E_BUSY", message: "busy" });
    expect(await stubSubscribeReal(h, c.clientId, RUN)).toBe(202); // existing runKey: not a new one
  });

  it("G7 rollback jitter (real service): the rejected third run arms and rolls back EXACTLY one watch on/off pair; the two held taps are untouched", async () => {
    const h = await startRealHub();
    const c = await sseClient(h.port, h.cookie);
    expect(await stubSubscribeReal(h, c.clientId, RUN)).toBe(202);
    expect(await stubSubscribeReal(h, c.clientId, RUN2)).toBe(202);
    await c.conn.waitFor((e, all) => all.filter((x) => x.event === "run_history").length === 2);
    const third = await postJson(
      h.port,
      "/api/run/subscribe",
      { clientId: c.clientId, agentKey: h.agentKey, runId: RUN3 },
      { Cookie: h.cookie },
    );
    expect(third.status).toBe(503);
    expect(JSON.parse(third.body)).toEqual({ error: "E_BUSY", message: "busy" });
    expect(watchFrames(h.conn)).toEqual([
      { runId: RUN, on: true },
      { runId: RUN2, on: true },
      { runId: RUN3, on: true }, // cap probe passed ⇒ tap armed …
      { runId: RUN3, on: false }, // … then the busy rollback released it: exactly one pair
    ]);
    // the two held subscriptions keep streaming — their taps were never cycled
    h.svc.onFrame(h.agentKey, { t: "run_ev", runId: RUN, tapId: TAP, seq: 1, e: { type: "turn_start" } });
    await c.conn.waitFor((e) => e.event === "run_ev");
    h.svc.onFrame(h.agentKey, { t: "run_ev", runId: RUN2, tapId: TAP, seq: 1, e: { type: "turn_start" } });
    await c.conn.waitFor((e, all) => all.filter((x) => x.event === "run_ev").length === 2);
    expect(watchFrames(h.conn).filter((w) => w.runId !== RUN3)).toEqual([
      { runId: RUN, on: true },
      { runId: RUN2, on: true },
    ]);
  });

  it("G1 (watch half): quick double subscribe on the real service arms exactly one watch; one unsubscribe already turns it off (ref counted once)", async () => {
    const h = await startRealHub();
    const c = await sseClient(h.port, h.cookie);
    expect(await stubSubscribeReal(h, c.clientId)).toBe(202);
    expect(await stubSubscribeReal(h, c.clientId)).toBe(202);
    await c.conn.waitFor((e) => e.event === "run_history");
    await settle();
    expect(watchFrames(h.conn)).toEqual([{ runId: RUN, on: true }]); // wire: exactly one run_watch
    const un = await postJson(
      h.port,
      "/api/run/unsubscribe",
      { clientId: c.clientId, agentKey: h.agentKey, runId: RUN },
      { Cookie: h.cookie },
    );
    expect(un.status).toBe(200);
    expect(watchFrames(h.conn)).toEqual([
      { runId: RUN, on: true },
      { runId: RUN, on: false }, // refcount never grew: a single unsubscribe fully releases
    ]);
  });

  it("validation: unknown clientId/agentKey ⇒ 404, malformed runId ⇒ 400, unsubscribe idempotent 200", async () => {
    const h = await startRealHub();
    const c = await sseClient(h.port, h.cookie);
    const badClient = await postJson(
      h.port,
      "/api/run/subscribe",
      { clientId: "c_nope", agentKey: h.agentKey, runId: RUN },
      { Cookie: h.cookie },
    );
    expect(badClient.status).toBe(404);
    expect(JSON.parse(badClient.body)).toEqual({ error: "E_NOT_FOUND", message: "unknown clientId" });
    const badAgent = await postJson(
      h.port,
      "/api/run/subscribe",
      { clientId: c.clientId, agentKey: "ghost", runId: RUN },
      { Cookie: h.cookie },
    );
    expect(badAgent.status).toBe(404);
    expect(JSON.parse(badAgent.body)).toEqual({ error: "E_NOT_FOUND", message: "unknown agentKey" });
    const badRun = await postJson(
      h.port,
      "/api/run/subscribe",
      { clientId: c.clientId, agentKey: h.agentKey, runId: "not-a-run-id" },
      { Cookie: h.cookie },
    );
    expect(badRun.status).toBe(400);
    const unknown = await postJson(
      h.port,
      "/api/run/unsubscribe",
      { clientId: "c_nope", agentKey: h.agentKey, runId: RUN },
      { Cookie: h.cookie },
    );
    expect(unknown.status).toBe(200);
    expect(JSON.parse(unknown.body)).toEqual({ ok: true });
  });

  it("GET /api/run/history: 200 with live:false (§3.4), 400/404 shapes", async () => {
    const h = await startRealHub();
    const ok = await rawRequest(h.port, {
      method: "GET",
      path: `/api/run/history?agent=${h.agentKey}&run=${RUN}&before=e1&limit=50`,
      headers: { Cookie: h.cookie },
    });
    expect(ok.status).toBe(200);
    const body = JSON.parse(ok.body) as RunHistoryPayload;
    expect(body.agentKey).toBe(h.agentKey);
    expect(body.runId).toBe(RUN);
    expect(body.live).toBe(false); // GET page never claims live
    const missingBefore = await rawRequest(h.port, {
      method: "GET",
      path: `/api/run/history?agent=${h.agentKey}&run=${RUN}`,
      headers: { Cookie: h.cookie },
    });
    expect(missingBefore.status).toBe(400);
    const badLimit = await rawRequest(h.port, {
      method: "GET",
      path: `/api/run/history?agent=${h.agentKey}&run=${RUN}&before=e1&limit=abc`,
      headers: { Cookie: h.cookie },
    });
    expect(badLimit.status).toBe(400);
    const unknownAgent = await rawRequest(h.port, {
      method: "GET",
      path: `/api/run/history?agent=ghost&run=${RUN}&before=e1`,
      headers: { Cookie: h.cookie },
    });
    expect(unknownAgent.status).toBe(404);
  });
});

async function stubSubscribeReal(
  h: { port: number; cookie: string; agentKey: string },
  clientId: string,
  runId: string = RUN,
): Promise<number> {
  const r = await postJson(
    h.port,
    "/api/run/subscribe",
    { clientId, agentKey: h.agentKey, runId },
    { Cookie: h.cookie },
  );
  return r.status;
}

// ---------------------------------------------------------------------------

describe("run routes with a stub service (generation & replay rules)", () => {
  it("G1: re-subscribe replaces the sub and NEVER re-watches (§5.4) — only the SECOND snapshot is delivered", async () => {
    const h = await startStubHub();
    const c = await sseClient(h.port, h.cookie);
    expect(await stubSubscribe(h, c.clientId)).toBe(202);
    expect(await stubSubscribe(h, c.clientId)).toBe(202);
    expect(h.rec.pending.length).toBe(2);
    expect(h.rec.watches).toEqual([{ agentKey: "a1", runId: RUN, ref: `loopback:${c.clientId}` }]); // 恰一次：重复订阅不再调 watch
    h.rec.pending[0]!.resolve(payload()); // superseded: must be discarded by identity
    await settle();
    expect(c.conn.events.filter((e) => e.event === "run_history").length).toBe(0);
    h.rec.pending[1]!.resolve(payload());
    const hist = await c.conn.waitFor((e) => e.event === "run_history");
    expect(hist.data.runId).toBe(RUN);
    await settle();
    expect(c.conn.events.filter((e) => e.event === "run_history").length).toBe(1);
    expect(h.rec.unwatches).toEqual([]); // replacement never unwatches
  });

  it("G2: unsubscribe during pending ⇒ late reply discarded, exactly one unwatch", async () => {
    const h = await startStubHub();
    const c = await sseClient(h.port, h.cookie);
    await stubSubscribe(h, c.clientId);
    const un = await postJson(
      h.port,
      "/api/run/unsubscribe",
      { clientId: c.clientId, agentKey: "a1", runId: RUN },
      { Cookie: h.cookie },
    );
    expect(un.status).toBe(200);
    h.rec.pending[0]!.resolve(payload());
    await settle();
    expect(c.conn.events.filter((e) => e.event === "run_history").length).toBe(0);
    expect(h.rec.unwatches).toEqual([{ agentKey: "a1", runId: RUN, ref: `loopback:${c.clientId}` }]);
  });

  it("G3: SSE close during pending ⇒ sub swept on close, late reply discarded, no errors", async () => {
    const h = await startStubHub();
    const c = await sseClient(h.port, h.cookie);
    await stubSubscribe(h, c.clientId);
    c.conn.close();
    await settle();
    h.rec.pending[0]!.resolve(payload());
    await settle();
    expect(h.rec.unwatches).toEqual([{ agentKey: "a1", runId: RUN, ref: `loopback:${c.clientId}` }]);
    expect(h.rec.sink).toBeDefined(); // no throw anywhere is the assert
  });

  it("G4: agent_down during pending ⇒ run_history{E_AGENT_GONE}; route never unwatches (service owns refs)", async () => {
    const h = await startStubHub();
    const c = await sseClient(h.port, h.cookie);
    await stubSubscribe(h, c.clientId);
    h.rec.sink!.dropped("a1", RUN, { agentKey: "a1", runId: RUN, error: "E_AGENT_GONE" });
    const err = await c.conn.waitFor((e) => e.event === "run_history");
    expect(err.data).toEqual({ agentKey: "a1", runId: RUN, error: "E_AGENT_GONE" });
    expect(h.rec.unwatches).toEqual([]);
    h.rec.pending[0]!.resolve(payload()); // sub is gone: discarded
    await settle();
    expect(c.conn.events.filter((e) => e.event === "run_history").length).toBe(1);
  });

  it("G9: pending buffer overflow ⇒ history + buffered frames first, then exactly one re-snapshot", async () => {
    const h = await startStubHub();
    const c = await sseClient(h.port, h.cookie);
    await stubSubscribe(h, c.clientId);
    for (let seq = 1; seq <= 4100; seq++) h.rec.sink!.ev("a1", RUN, evPayload(seq));
    h.rec.pending[0]!.resolve(payload({ fromSeq: 1 })); // watermark 0
    await settle(); // the re-snapshot registers its pending promise synchronously with delivery
    expect(h.rec.snapshots).toBe(2);
    h.rec.pending[1]!.resolve(payload({ fromSeq: 4101 })); // the heal
    const second = await c.conn.waitFor(
      (e, all) => e.event === "run_history" && all.filter((x) => x.event === "run_history").indexOf(e) === 1,
    );
    const events = c.conn.events;
    const first = events.findIndex((e) => e.event === "run_history");
    const between = events.slice(first + 1, events.indexOf(second));
    expect(between.filter((e) => e.event === "run_ev").length).toBe(4096); // head kept, tail lost
    await settle();
    expect(h.rec.snapshots).toBe(2); // bounded: the heal itself never re-triggers
    expect(c.conn.events.filter((e) => e.event === "run_history").length).toBe(2);
  });

  it("contract 1a: replay drops seq <= watermark strictly", async () => {
    const h = await startStubHub();
    const c = await sseClient(h.port, h.cookie);
    await stubSubscribe(h, c.clientId);
    for (let seq = 1; seq <= 3; seq++) h.rec.sink!.ev("a1", RUN, evPayload(seq));
    h.rec.pending[0]!.resolve(payload({ fromSeq: 3 })); // watermark 2
    await c.conn.waitFor((e) => e.event === "run_ev");
    await settle();
    const evs = c.conn.events.filter((e) => e.event === "run_ev");
    expect(evs.map((e) => e.data.seq)).toEqual([3]);
    expect(c.conn.events.filter((e) => e.event === "run_history").length).toBe(1); // no hole ⇒ no re-snapshot
  });

  it("contract 1b: first replayable frame beyond watermark+1 (hole) ⇒ treated as overflow, one re-snapshot", async () => {
    const h = await startStubHub();
    const c = await sseClient(h.port, h.cookie);
    await stubSubscribe(h, c.clientId);
    h.rec.sink!.ev("a1", RUN, evPayload(3));
    h.rec.sink!.ev("a1", RUN, evPayload(4));
    h.rec.pending[0]!.resolve(payload({ fromSeq: 1 })); // watermark 0; first frame seq 3 ⇒ hole
    await settle();
    expect(h.rec.snapshots).toBe(2); // 视同 overflow ⇒ exactly one re-snapshot
    h.rec.pending[1]!.resolve(payload({ fromSeq: 5 })); // the heal
    await c.conn.waitFor(
      (e, all) => e.event === "run_history" && all.filter((x) => x.event === "run_history").indexOf(e) === 1,
    );
    const events = c.conn.events;
    const first = events.findIndex((e) => e.event === "run_history");
    expect(
      events
        .slice(first + 1)
        .filter((e) => e.event === "run_ev")
        .map((e) => e.data.seq),
    ).toEqual([3, 4]);
    await settle();
    expect(h.rec.snapshots).toBe(2);
  });

  it("contract 1c: terminal history is authoritative — every buffered frame (incl. run_end) is discarded", async () => {
    const h = await startStubHub();
    const c = await sseClient(h.port, h.cookie);
    await stubSubscribe(h, c.clientId);
    h.rec.sink!.ev("a1", RUN, evPayload(1));
    h.rec.sink!.end("a1", RUN, { agentKey: "a1", runId: RUN, tapId: TAP, lastSeq: 1, status: "completed" });
    h.rec.pending[0]!.resolve(
      payload({ source: "file", terminal: true, live: false, fromSeq: 0, status: "completed" }),
    );
    const hist = await c.conn.waitFor((e) => e.event === "run_history");
    expect(hist.data.terminal).toBe(true);
    await settle();
    expect(c.conn.events.filter((e) => e.event === "run_ev").length).toBe(0);
    expect(c.conn.events.filter((e) => e.event === "run_end").length).toBe(0);
  });

  it("sink.resyncStart swaps a live sub for a fresh pending one; the round's history replays its buffered frames", async () => {
    const h = await startStubHub();
    const c = await sseClient(h.port, h.cookie);
    await stubSubscribe(h, c.clientId);
    h.rec.pending[0]!.resolve(payload());
    await c.conn.waitFor((e) => e.event === "run_history");
    h.rec.sink!.resyncStart("a1", RUN);
    h.rec.sink!.ev("a1", RUN, evPayload(1)); // buffered on the FRESH pending object
    h.rec.sink!.history("a1", RUN, payload({ resync: true }));
    const round = await c.conn.waitFor((e) => e.event === "run_history" && e.data.resync === true);
    const ev1 = await c.conn.waitFor((e) => e.event === "run_ev");
    expect(c.conn.events.indexOf(round)).toBeLessThan(c.conn.events.indexOf(ev1));
    expect(h.rec.snapshots).toBe(1); // the round's sub never starts an own snapshot
    expect(h.rec.unwatches).toEqual([]);
  });

  it("resync-race: a subscribe-time snapshot arriving AFTER resyncStart is discarded; only the round's history is delivered", async () => {
    const h = await startStubHub();
    const c = await sseClient(h.port, h.cookie);
    await stubSubscribe(h, c.clientId);
    expect(h.rec.pending.length).toBe(1); // the subscribe's own snapshot, still in flight
    h.rec.sink!.resyncStart("a1", RUN); // swaps the pending sub for a fresh round-served one
    h.rec.pending[0]!.resolve(payload({ fromSeq: 99 })); // STALE: predates the resync cause
    await settle();
    expect(c.conn.events.filter((e) => e.event === "run_history").length).toBe(0); // identity discard: no state regression
    h.rec.sink!.history("a1", RUN, payload({ resync: true }));
    const round = await c.conn.waitFor((e) => e.event === "run_history");
    expect(round.data.resync).toBe(true);
    await settle();
    expect(c.conn.events.filter((e) => e.event === "run_history").length).toBe(1); // exactly the round's
    expect(h.rec.snapshots).toBe(1); // the round-served sub never starts an own snapshot
    expect(h.rec.unwatches).toEqual([]);
  });

  it("sink.history error ⇒ error frame + sub dropped + ref released (browser watchdog resubscribes)", async () => {
    const h = await startStubHub();
    const c = await sseClient(h.port, h.cookie);
    await stubSubscribe(h, c.clientId);
    h.rec.sink!.history("a1", RUN, { agentKey: "a1", runId: RUN, error: "E_DEADLINE" });
    const err = await c.conn.waitFor((e) => e.event === "run_history");
    expect(err.data).toEqual({ agentKey: "a1", runId: RUN, error: "E_DEADLINE" });
    expect(h.rec.unwatches).toEqual([{ agentKey: "a1", runId: RUN, ref: `loopback:${c.clientId}` }]);
    h.rec.pending[0]!.resolve(payload()); // gone: discarded
    await settle();
    expect(c.conn.events.filter((e) => e.event === "run_history").length).toBe(1);
  });

  it("sink.dropped with another listener's refs never touches this listener's subs (prefix routing)", async () => {
    const h = await startStubHub();
    const c = await sseClient(h.port, h.cookie);
    await stubSubscribe(h, c.clientId);
    h.rec.pending[0]!.resolve(payload());
    await c.conn.waitFor((e) => e.event === "run_history");
    h.rec.sink!.dropped("a1", RUN, { agentKey: "a1", runId: RUN, error: "E_UNSUPPORTED", reason: "unsupported" }, [
      `lan:${c.clientId}`, // same bare clientId on the OTHER listener's SseHub id space
    ]);
    await settle();
    expect(c.conn.events.filter((e) => e.event === "run_history").length).toBe(1); // untouched
    expect(h.rec.unwatches).toEqual([]);
    h.rec.sink!.ev("a1", RUN, evPayload(1)); // still live
    await c.conn.waitFor((e) => e.event === "run_ev");
    // and the all-refs form (agent_down / storm) does drop it:
    h.rec.sink!.dropped("a1", RUN, { agentKey: "a1", runId: RUN, error: "E_BUSY", reason: "resync_storm" });
    const err = await c.conn.waitFor((e) => e.event === "run_history" && e.data.error === "E_BUSY");
    expect(err.data.reason).toBe("resync_storm");
    expect(h.rec.unwatches).toEqual([]); // dropped never unwatches (service reclaimed the refs)
  });

  it("page errors map through RUN_HTTP_STATUS (503 E_BUSY), never statusFor", async () => {
    const h = await startStubHub();
    const g = await rawRequest(h.port, {
      method: "GET",
      path: `/api/run/history?agent=a1&run=${RUN}&before=e1`,
      headers: { Cookie: h.cookie },
    });
    expect(g.status).toBe(503);
    expect(JSON.parse(g.body)).toEqual({ error: "E_BUSY", message: `page:a1:${RUN}:e1` });
  });
});
