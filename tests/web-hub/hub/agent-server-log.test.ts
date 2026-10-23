/**
 * fabric phase-2 X1 (§8.5/XI6/§10.4): hub.log hygiene on the agent socket — a message body must
 * never reach the log, through ANY path: bad JSON, a rejected xs frame, a handler exception, an
 * oversize frame, a frame the decoder ignores. Real unix socket + the real agent-server/registry/
 * relay (only the registry handed to the relay is wrapped for the exception case).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import net from "node:net";
import { join } from "node:path";
import { createAgentServer, type AgentServer } from "../../../src/web-hub/hub/agent-server.js";
import { createRegistry, type Registry } from "../../../src/web-hub/hub/registry.js";
import { createXsRelay, type XsRelay } from "../../../src/web-hub/hub/xs/router.js";
import { config, connectClient, hello, memLog, sleepReal, tmpDirs, type MemLog, type TestClient } from "./helpers.js";
import { LIMITS } from "./xs-fixtures.js";

const SECRET = "TOP-SECRET-PAYLOAD-d34db33f";
const tmp = tmpDirs();
let server: net.Server;
let agentServer: AgentServer;
let registry: Registry;
let relay: XsRelay | undefined;
let log: MemLog;
let sockPath: string;
const clients: TestClient[] = [];

async function setup(opts: { xs: boolean; throwInView?: boolean }): Promise<void> {
  sockPath = join(tmp.make("wh-asl-"), "hub.sock");
  log = memLog();
  registry = createRegistry({ now: () => Date.now(), log, pidAlive: () => true });
  relay = undefined;
  if (opts.xs) {
    const reg: Registry =
      opts.throwInView === true
        ? ({
            ...registry,
            setXsObserver: registry.setXsObserver,
            request: registry.request,
            xsView: () => {
              throw new Error(`explode ${SECRET}`);
            },
          } as Registry)
        : registry;
    relay = createXsRelay({
      registry: reg,
      config: { home: "/home/u", crossSession: { limits: { hubSendsPerMin: 60 } } },
      log,
      now: () => Date.now(),
    });
    // the wrapped registry only feeds members.view; the observer must land on the REAL registry
    registry.setXsObserver(relay.members.observer);
  }
  server = net.createServer();
  await new Promise<void>((r) => server.listen(sockPath, () => r()));
  agentServer = createAgentServer(server, {
    registry,
    config: config(),
    log,
    now: () => Date.now(),
    httpPort: () => 1,
    ...(relay === undefined ? {} : { xs: relay.router }),
  });
}

async function agent(withMember: boolean): Promise<TestClient> {
  const c = await connectClient(sockPath);
  clients.push(c);
  c.send(hello({ caps: ["ev.v1", "xs.v1"] }));
  await c.waitFrame((f) => f["t"] === "hello_ack");
  c.send({ t: "session", sessionId: "sess-A", cwd: "/tmp/work", reason: "startup", leafId: null, mode: "tui" });
  if (withMember) {
    c.send({ t: "xs_member", sessionId: "sess-A", epoch: 1, joined: true, receive: "wake", limits: { ...LIMITS } });
  }
  await sleepReal(30);
  return c;
}

const logText = (): string => JSON.stringify(log.lines);

afterEach(async () => {
  for (const c of clients.splice(0)) c.sock.destroy();
  relay?.dispose();
  await agentServer.close();
  await new Promise<void>((r) => server.close(() => r()));
  tmp.cleanup();
});

describe("agent-server log hygiene (xs on)", () => {
  beforeEach(() => setup({ xs: true }));

  it("bad JSON containing a body logs only {agentKey, bytes} — never the sample", async () => {
    const c = await agent(true);
    c.raw(`{"t":"xs_req","text":"${SECRET}" oops-not-json\n`);
    await sleepReal(40);
    const line = log.lines.find((l) => l.msg === "agent sent bad json");
    expect(line).toBeDefined();
    expect(Object.keys(line!.data as object).sort()).toEqual(["agentKey", "bytes"]);
    expect(typeof (line!.data as { bytes: unknown }).bytes).toBe("number");
    expect(logText()).not.toContain(SECRET);
  });

  it("a rejected xs frame (stale origin) answers E_XS_STALE_ORIGIN; log and audit hold no body", async () => {
    const c = await agent(true);
    c.send({
      t: "xs_req",
      rid: "q1",
      op: "send",
      origin: { sessionId: "sess-A", epoch: 99 },
      to: "anyone",
      text: SECRET,
    });
    const res = await c.waitFrame((f) => f["t"] === "xs_res" && f["rid"] === "q1");
    expect(res).toMatchObject({ ok: false, code: "E_XS_STALE_ORIGIN", effect: "none" });
    const audit = log.lines.find((l) => (l.data as { audit?: string } | undefined)?.audit === "xs");
    expect(audit?.data).toMatchObject({ op: "send", code: "E_XS_STALE_ORIGIN", textLen: SECRET.length });
    expect(logText()).not.toContain(SECRET);
  });

  it("a rejected target (E_XS_NO_TARGET) likewise logs lengths and codes only", async () => {
    const c = await agent(true);
    c.send({
      t: "xs_req",
      rid: "q2",
      op: "send",
      origin: { sessionId: "sess-A", epoch: 1 },
      to: "nobody",
      text: SECRET,
    });
    const res = await c.waitFrame((f) => f["rid"] === "q2");
    expect(res).toMatchObject({ code: "E_XS_NO_TARGET" });
    expect(logText()).not.toContain(SECRET);
  });

  it("an oversize xs_req (>16 KiB) is answered E_XS_TOO_LARGE; the log has no body", async () => {
    const c = await agent(true);
    c.send({
      t: "xs_req",
      rid: "big",
      op: "send",
      origin: { sessionId: "sess-A", epoch: 1 },
      to: "x",
      text: `${SECRET}${"y".repeat(17_000)}`,
    });
    const res = await c.waitFrame((f) => f["rid"] === "big");
    expect(res).toMatchObject({ ok: false, code: "E_XS_TOO_LARGE", effect: "none" });
    expect(logText()).not.toContain(SECRET);
  });

  it("an oversize xs_req with an unusable rid is silently ignored (no response, no log of the body)", async () => {
    const c = await agent(true);
    c.send({ t: "xs_req", rid: 12345, op: "send", text: `${SECRET}${"y".repeat(17_000)}` });
    await sleepReal(50);
    expect(c.frames.filter((f) => (f as { t?: string }).t === "xs_res")).toEqual([]);
    expect(logText()).not.toContain(SECRET);
  });

  it("a schema-invalid xs frame (extra `from.run`-style field) is ignored: no reply, no log line", async () => {
    const c = await agent(true);
    const before = log.lines.length;
    c.send({
      t: "xs_req",
      rid: "q3",
      op: "send",
      origin: { sessionId: "sess-A", epoch: 1 },
      to: "x",
      text: SECRET,
      from: { sessionId: "evil", run: "r_1" },
    });
    await sleepReal(50);
    expect(c.frames.filter((f) => (f as { t?: string }).t === "xs_res")).toEqual([]);
    expect(log.lines.length).toBe(before);
    expect(logText()).not.toContain(SECRET);
  });

  it("xs_req never reaches the registry bus (no event, no per-frame log)", async () => {
    const events: string[] = [];
    registry.bus.subscribe((e) => events.push(e.type));
    const c = await agent(true);
    const base = events.length;
    c.send({ t: "xs_req", rid: "q4", op: "info", origin: { sessionId: "sess-A", epoch: 1 } });
    await c.waitFrame((f) => f["rid"] === "q4");
    expect(events.length).toBe(base);
  });
});

describe("agent-server log hygiene (handler exception)", () => {
  beforeEach(() => setup({ xs: true, throwInView: true }));

  it("a throwing handler answers E_XS_INTERNAL and logs only {code, op, textLen}", async () => {
    const c = await agent(true);
    c.send({ t: "xs_req", rid: "boom", op: "send", origin: { sessionId: "sess-A", epoch: 1 }, to: "x", text: SECRET });
    const res = await c.waitFrame((f) => f["rid"] === "boom");
    expect(res).toMatchObject({ ok: false, code: "E_XS_INTERNAL", effect: "unknown" });
    const line = log.lines.find((l) => l.msg === "xs handler failed");
    expect(line?.data).toEqual({ code: "E_XS_INTERNAL", op: "send", textLen: SECRET.length });
    expect(logText()).not.toContain(SECRET);
    expect(logText()).not.toContain("explode");
  });
});

describe("agent-server log hygiene (xs off — no relay)", () => {
  beforeEach(() => setup({ xs: false }));

  it("bad JSON is hygienic regardless of xs", async () => {
    const c = await agent(false);
    c.raw(`{"text":"${SECRET}" nope\n`);
    await sleepReal(40);
    expect(log.lines.find((l) => l.msg === "agent sent bad json")?.data).toMatchObject({ bytes: expect.any(Number) });
    expect(logText()).not.toContain(SECRET);
  });

  it("xs_req is ignored exactly like before: no reply, nothing logged", async () => {
    const c = await agent(false);
    const before = log.lines.length;
    c.send({ t: "xs_req", rid: "q9", op: "info", origin: { sessionId: "sess-A", epoch: 1 } });
    c.send({ t: "xs_req", rid: "q9b", op: "send", text: `${SECRET}${"y".repeat(17_000)}` });
    await sleepReal(60);
    expect(c.frames.filter((f) => (f as { t?: string }).t === "xs_res")).toEqual([]);
    expect(log.lines.length).toBe(before);
  });

  it("an xs_ack with no pending is silently counted nowhere (no log)", async () => {
    const c = await agent(false);
    const before = log.lines.length;
    c.send({ t: "xs_ack", rid: "r1", xid: "x1", effect: "applied", woke: false });
    await sleepReal(40);
    expect(log.lines.length).toBe(before);
  });
});
