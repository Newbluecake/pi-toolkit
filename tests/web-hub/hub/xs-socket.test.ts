/**
 * fabric phase-2 X1 (§11.2): the cross-session relay over a REAL agent-server socket — a full
 * `startHub` assembly (registry + agent-server + relay wired exactly as production), two
 * unix-socket "agents", and the xs_req → xs_deliver → xs_ack → xs_res round trip on the wire.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { FrontendFactory, HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { startHub, type RunningHub } from "../../../src/web-hub/hub/hub.js";
import { XS_HUB_CAP } from "../../../src/web-hub/protocol/xs.js";
import { config, connectClient, hello, sleepReal, tmpDirs, type TestClient } from "./helpers.js";
import { LIMITS } from "./xs-fixtures.js";

const tmp = tmpDirs();
const hubs: RunningHub[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.sock.destroy();
  for (const h of hubs.splice(0)) await h.close("test");
  tmp.cleanup();
});

const fakeFrontend: FrontendFactory = (): HttpFrontend => ({
  listen: async () => ({ port: 43211 }),
  close: async () => {},
  clientCount: () => 0,
  ui: {
    serve: async () => false,
    refresh: async () => ({ state: "unbuilt", candidates: [] }),
    status: () => ({ state: "unbuilt", candidates: [] }),
  },
});

async function startXsHub(withXs = true): Promise<RunningHub> {
  const r = await startHub(
    config({
      home: tmp.make("wh-xs-sock-"),
      ...(withXs ? { crossSession: { limits: { hubSendsPerMin: 60 } } } : {}),
    }),
    fakeFrontend,
    { uid: process.getuid?.() ?? 0 },
  );
  if ("exists" in r) throw new Error("unexpected exists");
  hubs.push(r);
  return r;
}

// A live pid (the hub's tick drops records whose pid is dead); the nonce keeps agents distinct.
let nextNonce = 1;
async function agent(
  hub: RunningHub,
  o: { sessionId: string; name?: string; cwd?: string; caps?: string[]; member?: boolean; epoch?: number },
): Promise<TestClient> {
  const c = await connectClient(hub.paths.socketPath);
  clients.push(c);
  const pid = process.pid;
  const nonce = `n${nextNonce++}`.padEnd(20, "0");
  c.send(hello({ agentId: { pid, nonce }, caps: o.caps ?? ["ev.v1", "xs.v1"] }));
  await c.waitFrame((f) => f["t"] === "hello_ack");
  c.send({
    t: "session",
    sessionId: o.sessionId,
    cwd: o.cwd ?? "/tmp/work",
    reason: "startup",
    leafId: null,
    mode: "tui",
    ...(o.name !== undefined ? { name: o.name } : {}),
  });
  if (o.member !== false) {
    c.send({
      t: "xs_member",
      sessionId: o.sessionId,
      epoch: o.epoch ?? 1,
      joined: true,
      receive: "wake",
      limits: { ...LIMITS },
    });
  }
  // session/xs_member are fire-and-forget slots: poll the hub with `info` until it sees us
  for (let i = 0; i < 40; i++) {
    const rid = `probe${i}-${nonce}`;
    c.send({ t: "xs_req", rid, op: "info", origin: { sessionId: o.sessionId, epoch: o.epoch ?? 1 } });
    const res = await Promise.race([c.waitFrame((f) => f["rid"] === rid, 150).catch(() => undefined)]);
    if (res !== undefined && res["ok"] === true) break;
    if (o.member === false || o.caps !== undefined) break;
    await sleepReal(10);
  }
  return c;
}

describe("xs relay over a real agent-server socket", () => {
  it("xs.v1 rides BOTH hello_ack.caps and HubInfo.caps iff config.crossSession", async () => {
    const on = await startXsHub(true);
    const off = await startXsHub(false);
    for (const [hub, expected] of [
      [on, true],
      [off, false],
    ] as const) {
      const c = await connectClient(hub.paths.socketPath);
      clients.push(c);
      c.send(hello());
      const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
      expect((ack["caps"] as string[]).includes(XS_HUB_CAP)).toBe(expected);
      expect(hub.info.caps.includes(XS_HUB_CAP)).toBe(expected);
      expect(ack["caps"]).toEqual(hub.info.caps);
    }
  });

  it("list → resolve → send → xs_deliver → xs_ack → xs_res round trip; stamped from, per-socket correlation", async () => {
    const hub = await startXsHub();
    const a = await agent(hub, { sessionId: "sess-AAAAAAAA", name: "alpha" });
    const b = await agent(hub, { sessionId: "sess-BBBBBBBB", name: "beta" });

    a.send({ t: "xs_req", rid: "L1", op: "list", origin: { sessionId: "sess-AAAAAAAA", epoch: 1 } });
    const list = await a.waitFrame((f) => f["rid"] === "L1");
    expect(list).toMatchObject({ t: "xs_res", ok: true, rows: [{ ref: "sess-BBBBBBB", name: "beta" }] });

    a.send({ t: "xs_req", rid: "R1", op: "resolve", query: "beta", origin: { sessionId: "sess-AAAAAAAA", epoch: 1 } });
    expect(await a.waitFrame((f) => f["rid"] === "R1")).toMatchObject({ ok: true, target: { name: "beta" } });

    a.send({
      t: "xs_req",
      rid: "S1",
      op: "send",
      to: "beta",
      text: "ping over the wire",
      wake: true,
      level: 0,
      origin: { sessionId: "sess-AAAAAAAA", epoch: 1 },
    });
    const deliver = await b.waitFrame((f) => f["t"] === "xs_deliver");
    expect(deliver).toMatchObject({
      to: { sessionId: "sess-BBBBBBBB", epoch: 1 },
      from: { sessionId: "sess-AAAAAAAA", ref: "sess-AAAAAAA", name: "alpha" },
      text: "ping over the wire",
      wake: true,
      level: 0,
    });
    expect(typeof deliver["rid"]).toBe("string");
    expect(typeof deliver["xid"]).toBe("string");
    expect((deliver["expiresAt"] as number) > Date.now()).toBe(true);
    // the sender has NOT been answered yet
    expect(a.frames.some((f) => (f as { rid?: string }).rid === "S1")).toBe(false);

    b.send({ t: "xs_ack", rid: deliver["rid"], xid: deliver["xid"], effect: "applied", woke: true });
    const res = await a.waitFrame((f) => f["rid"] === "S1");
    expect(res).toMatchObject({ t: "xs_res", ok: true, effect: "applied", target: { name: "beta" } });
    // the receiver never sees the sender's xs_res (replies stay on the requesting socket)
    expect(b.frames.some((f) => (f as { t?: string }).t === "xs_res" && (f as { rid?: string }).rid === "S1")).toBe(
      false,
    );
  });

  it("a late xs_ack (after the hub already settled) changes nothing and gets no reply", async () => {
    const hub = await startXsHub();
    const a = await agent(hub, { sessionId: "sess-AAAAAAAA", name: "alpha" });
    const b = await agent(hub, { sessionId: "sess-BBBBBBBB", name: "beta" });
    a.send({
      t: "xs_req",
      rid: "S1",
      op: "send",
      to: "beta",
      text: "x",
      origin: { sessionId: "sess-AAAAAAAA", epoch: 1 },
    });
    const d = await b.waitFrame((f) => f["t"] === "xs_deliver");
    const ack = { t: "xs_ack", rid: d["rid"], xid: d["xid"], effect: "applied", woke: false };
    b.send(ack);
    await a.waitFrame((f) => f["rid"] === "S1");
    const resCount = () => a.frames.filter((f) => (f as { rid?: string }).rid === "S1").length;
    expect(resCount()).toBe(1);
    b.send(ack); // duplicate/late
    await sleepReal(60);
    expect(resCount()).toBe(1);
    expect(b.frames.filter((f) => (f as { rid?: string }).rid === "S1")).toEqual([]);
  });

  it("an unacknowledged deliver settles as unknown after the hub's 5 s deadline (real timers)", async () => {
    const hub = await startXsHub();
    const a = await agent(hub, { sessionId: "sess-AAAAAAAA", name: "alpha" });
    await agent(hub, { sessionId: "sess-BBBBBBBB", name: "beta" });
    a.send({
      t: "xs_req",
      rid: "S1",
      op: "send",
      to: "beta",
      text: "x",
      origin: { sessionId: "sess-AAAAAAAA", epoch: 1 },
    });
    const res = await a.waitFrame((f) => f["rid"] === "S1", 7_000);
    expect(res).toMatchObject({ ok: true, effect: "unknown", reason: "deliver_deadline" });
  }, 12_000);

  it("receiver socket dropping mid-delivery settles the sender as unknown{link_lost}", async () => {
    const hub = await startXsHub();
    const a = await agent(hub, { sessionId: "sess-AAAAAAAA", name: "alpha" });
    const b = await agent(hub, { sessionId: "sess-BBBBBBBB", name: "beta" });
    a.send({
      t: "xs_req",
      rid: "S1",
      op: "send",
      to: "beta",
      text: "x",
      origin: { sessionId: "sess-AAAAAAAA", epoch: 1 },
    });
    await b.waitFrame((f) => f["t"] === "xs_deliver");
    b.sock.destroy();
    const res = await a.waitFrame((f) => f["rid"] === "S1");
    expect(res).toMatchObject({ ok: true, effect: "unknown", reason: "link_lost" });
  });

  it("after /new (session_detached → new session) the old identity is void: old-origin requests are refused, the old member is unlistable", async () => {
    const hub = await startXsHub();
    const a = await agent(hub, { sessionId: "sess-AAAAAAAA", name: "alpha" });
    const b = await agent(hub, { sessionId: "sess-BBBBBBBB", name: "beta" });
    b.send({ t: "session_detached", reason: "new" });
    b.send({ t: "session", sessionId: "sess-NEWNEWNEW", cwd: "/tmp/work", reason: "new", leafId: null, mode: "tui" });
    await sleepReal(40);
    a.send({ t: "xs_req", rid: "L1", op: "list", origin: { sessionId: "sess-AAAAAAAA", epoch: 1 } });
    expect(await a.waitFrame((f) => f["rid"] === "L1")).toMatchObject({ ok: true, rows: [] });
    // single-socket FIFO: the stale-epoch request from the old identity is refused
    b.send({ t: "xs_req", rid: "OLD", op: "list", origin: { sessionId: "sess-BBBBBBBB", epoch: 1 } });
    expect(await b.waitFrame((f) => f["rid"] === "OLD")).toMatchObject({ ok: false, code: "E_XS_STALE_ORIGIN" });
    // the new session joins with a fresh member frame and becomes visible
    b.send({
      t: "xs_member",
      sessionId: "sess-NEWNEWNEW",
      epoch: 2,
      joined: true,
      receive: "wake",
      limits: { ...LIMITS },
    });
    await sleepReal(40);
    a.send({ t: "xs_req", rid: "L2", op: "list", origin: { sessionId: "sess-AAAAAAAA", epoch: 1 } });
    const l2 = await a.waitFrame((f) => f["rid"] === "L2");
    expect((l2["rows"] as Array<{ ref: string }>).map((x) => x.ref)).toEqual(["sess-NEWNEWN"]);
  });

  it("an agent without xs.v1 in its hello is never a member (list-invisible, send ⇒ E_XS_NO_TARGET)", async () => {
    const hub = await startXsHub();
    const a = await agent(hub, { sessionId: "sess-AAAAAAAA", name: "alpha" });
    await agent(hub, { sessionId: "sess-OLDOLDOLD", name: "old", caps: ["ev.v1"] });
    a.send({ t: "xs_req", rid: "L1", op: "list", origin: { sessionId: "sess-AAAAAAAA", epoch: 1 } });
    expect(await a.waitFrame((f) => f["rid"] === "L1")).toMatchObject({ rows: [] });
    a.send({
      t: "xs_req",
      rid: "S1",
      op: "send",
      to: "sess-OLDOLDOLD",
      text: "x",
      origin: { sessionId: "sess-AAAAAAAA", epoch: 1 },
    });
    expect(await a.waitFrame((f) => f["rid"] === "S1")).toMatchObject({ ok: false, code: "E_XS_NO_TARGET" });
  });

  it("a hub WITHOUT config.crossSession ignores xs frames entirely (no reply)", async () => {
    const hub = await startXsHub(false);
    const c = await agent(hub, { sessionId: "sess-AAAAAAAA", member: false, caps: ["ev.v1"] });
    c.send({ t: "xs_req", rid: "Z1", op: "info", origin: { sessionId: "sess-AAAAAAAA", epoch: 1 } });
    await sleepReal(80);
    expect(c.frames.some((f) => (f as { t?: string }).t === "xs_res")).toBe(false);
  });

  it("real hub.log: bad JSON line and a rejected send leave no body behind (file on disk)", async () => {
    const hub = await startXsHub();
    const a = await agent(hub, { sessionId: "sess-AAAAAAAA", name: "alpha" });
    const secret = "FILE-LEVEL-SECRET-8c1f";
    a.raw(`{"t":"xs_req","text":"${secret}" nope\n`);
    a.send({
      t: "xs_req",
      rid: "S1",
      op: "send",
      to: "nobody",
      text: secret,
      origin: { sessionId: "sess-AAAAAAAA", epoch: 1 },
    });
    await a.waitFrame((f) => f["rid"] === "S1");
    await sleepReal(40);
    const text = readFileSync(hub.paths.logFile, "utf8");
    expect(text).toContain("agent sent bad json");
    expect(text).toContain('"audit":"xs"');
    expect(text).not.toContain(secret);
  });
});
