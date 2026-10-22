/**
 * AL2 (alias-plan r4 §3.3 load / §3.6 cap, key-absent convention): the hub assembly of the alias
 * binding table over a REAL `startHub` + agent-server socket.
 *
 *   crossSession absent / crossSession.alias absent ⇒ no table, no file IO, no `xs.alias.v1`
 *   crossSession.alias present ∧ load ready        ⇒ `xs.alias.v1` tail-appended on BOTH surfaces
 *   crossSession.alias present ∧ load degraded     ⇒ no cap, the file is never touched
 * plus a real-socket set → restart → still held round trip.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FrontendFactory, HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { startHub, type RunningHub } from "../../../src/web-hub/hub/hub.js";
import { XS_ALIAS_FILE } from "../../../src/web-hub/hub/xs/aliases.js";
import {
  XS_ALIAS_HUB_CAP,
  XS_CHANNEL_HUB_CAP,
  XS_HUB_CAP,
  XS_REPLY_HUB_CAP,
} from "../../../src/web-hub/protocol/xs.js";
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
  listen: async () => ({ port: 43212 }),
  close: async () => {},
  clientCount: () => 0,
  ui: {
    serve: async () => false,
    refresh: async () => ({ state: "unbuilt", candidates: [] }),
    status: () => ({ state: "unbuilt", candidates: [] }),
  },
});

type Mode = "none" | "xs" | "alias";
async function start(home: string, mode: Mode): Promise<RunningHub> {
  const r = await startHub(
    config({
      home,
      ...(mode === "none"
        ? {}
        : {
            crossSession: {
              limits: { hubSendsPerMin: 60 },
              ...(mode === "alias" ? { alias: { offlineLeaseH: 168, coolMin: 10, takeMinOfflineMin: 10 } } : {}),
            } as never,
          }),
    }),
    fakeFrontend,
    { uid: process.getuid?.() ?? 0 },
  );
  if ("exists" in r) throw new Error("unexpected exists");
  hubs.push(r);
  return r;
}

async function ackCaps(hub: RunningHub): Promise<string[]> {
  const c = await connectClient(hub.paths.socketPath);
  clients.push(c);
  c.send(hello());
  const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
  return [...(ack["caps"] as string[])];
}

let nextNonce = 1;
async function aliasAgent(hub: RunningHub, sessionId: string): Promise<TestClient> {
  const c = await connectClient(hub.paths.socketPath);
  clients.push(c);
  const nonce = `al${nextNonce++}`.padEnd(20, "0");
  c.send(hello({ agentId: { pid: process.pid, nonce }, caps: ["ev.v1", "xs.v1", "xs.alias.v1"] }));
  await c.waitFrame((f) => f["t"] === "hello_ack");
  c.send({ t: "session", sessionId, cwd: "/tmp/work", reason: "startup", leafId: null, mode: "tui" });
  c.send({ t: "xs_member", sessionId, epoch: 1, joined: true, receive: "wake", limits: { ...LIMITS } });
  for (let i = 0; i < 40; i++) {
    const rid = `probe${i}-${nonce}`;
    c.send({ t: "xs_req", rid, op: "info", origin: { sessionId, epoch: 1 } });
    const res = await c.waitFrame((f) => f["rid"] === rid, 150).catch(() => undefined);
    if (res !== undefined && res["ok"] === true) break;
    await sleepReal(10);
  }
  return c;
}

describe("hub assembly of the alias binding table", () => {
  it("cap matrix: xs.alias.v1 only with the alias key AND a ready load; both surfaces equal; tail-appended", async () => {
    const none = await start(tmp.make("wh-al-none-"), "none");
    const xs = await start(tmp.make("wh-al-xs-"), "xs");
    const alias = await start(tmp.make("wh-al-on-"), "alias");
    const capsNone = await ackCaps(none);
    const capsXs = await ackCaps(xs);
    const capsAlias = await ackCaps(alias);
    expect(capsNone).toEqual(none.info.caps);
    expect(capsXs).toEqual(xs.info.caps);
    expect(capsAlias).toEqual(alias.info.caps);
    expect(capsNone).not.toContain(XS_ALIAS_HUB_CAP);
    expect(capsXs).not.toContain(XS_ALIAS_HUB_CAP);
    expect(capsXs.slice(-3)).toEqual([XS_HUB_CAP, XS_REPLY_HUB_CAP, XS_CHANNEL_HUB_CAP]);
    expect(capsAlias.slice(-4)).toEqual([XS_HUB_CAP, XS_REPLY_HUB_CAP, XS_CHANNEL_HUB_CAP, XS_ALIAS_HUB_CAP]);
    // alias on = xs caps + exactly one tail cap; key absent ⇒ byte-identical caps
    expect(capsAlias.slice(0, -1)).toEqual(capsXs);
    // a fresh table never creates the file (§3.3: missing ⇒ ready, no write); key absent ⇒ zero IO
    for (const h of [xs, alias]) expect(existsSync(join(h.paths.stateDir, XS_ALIAS_FILE))).toBe(false);
  });

  it("degraded (corrupt file): no cap, the file bytes are left untouched, a restart is still degraded", async () => {
    const home = tmp.make("wh-al-bad-");
    let hub = await start(home, "alias");
    const file = join(hub.paths.stateDir, XS_ALIAS_FILE);
    await hub.close("test");
    hubs.splice(hubs.indexOf(hub), 1);
    writeFileSync(file, "{corrupt", { mode: 0o600 });
    const before = readFileSync(file);
    for (let round = 0; round < 2; round++) {
      hub = await start(home, "alias");
      const caps = await ackCaps(hub);
      expect(caps).not.toContain(XS_ALIAS_HUB_CAP);
      expect(caps).toContain(XS_CHANNEL_HUB_CAP);
      expect(readFileSync(file).equals(before)).toBe(true);
      expect(readdirSync(hub.paths.stateDir).filter((n) => n.startsWith(XS_ALIAS_FILE))).toEqual([XS_ALIAS_FILE]);
      await hub.close("test");
      hubs.splice(hubs.indexOf(hub), 1);
    }
  });

  it("real socket: op alias set → 0600 file → hub restart → the same session still holds it", async () => {
    const home = tmp.make("wh-al-rt-");
    let hub = await start(home, "alias");
    let a = await aliasAgent(hub, "sess-ALIAS-0001");
    a.send({ t: "xs_req", rid: "S1", op: "alias", alias: "前端", origin: { sessionId: "sess-ALIAS-0001", epoch: 1 } });
    expect(await a.waitFrame((f) => f["rid"] === "S1")).toMatchObject({
      t: "xs_res",
      ok: true,
      alias: { alias: "前端", state: "held" },
    });
    const file = join(hub.paths.stateDir, XS_ALIAS_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("前端");
    a.sock.destroy();
    await hub.close("test");
    hubs.splice(hubs.indexOf(hub), 1);

    hub = await start(home, "alias");
    expect(hub.info.caps).toContain(XS_ALIAS_HUB_CAP);
    a = await aliasAgent(hub, "sess-ALIAS-0001");
    a.send({ t: "xs_req", rid: "G1", op: "alias", origin: { sessionId: "sess-ALIAS-0001", epoch: 1 } });
    expect(await a.waitFrame((f) => f["rid"] === "G1")).toMatchObject({
      ok: true,
      alias: { alias: "前端", state: "held" },
    });
    const b = await aliasAgent(hub, "sess-OTHER-0002");
    b.send({
      t: "xs_req",
      rid: "R1",
      op: "resolve",
      query: "前端",
      origin: { sessionId: "sess-OTHER-0002", epoch: 1 },
    });
    expect(await b.waitFrame((f) => f["rid"] === "R1")).toMatchObject({
      ok: true,
      target: { alias: "前端", sessionId: "sess-ALIAS-0001" },
    });
  });
});
