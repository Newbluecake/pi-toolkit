/**
 * #30 reload-result plan §3 C1 — `StatusInfo.reload` passthrough over the REAL hub stack.
 *
 * The tracked-reload slot (plan §1 D2/D6) rides the OPEN status slot, so the hub must forward
 * it untouched: a REAL agent connection over a unix socket (`createAgentServer`'s NdjsonDecoder
 * → `decodeAgentFrame`'s open StatusInfoSchema → `registry.onFrame`'s verbatim store → the
 * HTTP bus → the SSE broadcast), plus the #88 subscribe-time directed re-send of the retained
 * last status. This file drives every one of those hops for real — the frames below are sent
 * as NDJSON bytes on a real socket by a real client, and the browser side reads the raw SSE
 * wire text, never a hand-fed event.
 *
 * Assertions (plan §3 C1, verbatim):
 *  - `reload` passes through byte-for-byte (the SSE data line contains the exact serialization
 *    of the object the agent sent, key order included);
 *  - the #88 directed re-send carries the LATEST retained status (a rev-2 update wins over the
 *    rev-1 frame a client may have missed), still verbatim;
 *  - the TTL retraction (an idle agent's later status WITHOUT the slot — what `onTick`'s
 *    retraction publish looks like on the wire) replaces the retained status, so a FRESH
 *    subscriber's directed re-send shows no residual `reload` (残影) — and an old agent's
 *    field-less status stays field-less end to end;
 *  - a future agent's unknown `reload` payload (open slot, unknown `v`) is forwarded untouched
 *    too — the hub never parses the slot.
 */
import net from "node:net";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentServer, type AgentServer } from "../../../src/web-hub/hub/agent-server.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { createRegistry, type Registry } from "../../../src/web-hub/hub/registry.js";
import { PROTO } from "../../../src/web-hub/protocol/version.js";
import { config, connectClient, hello, memLog, tmpDirs, type TestClient } from "./helpers.js";
import { fakeDeps, login, makeTmp, parseSseBlock, postJson, type SseEvent } from "../http/helpers.js";

/** Fixed clock: deterministic SSE ring ids and cards. */
const T = 1_700_000_000_000;
const HUB_VERSION = "9.9.9";

/** The exact wire shape `reload-track.ts`'s `projectRec` emits (field order = byte order). */
const reloadWire = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  life: "life-c1-00000001",
  cmdIds: ["cmdw000000000000c1"],
  rev: 1,
  execId: "exec-c1-00000001",
  state: "deferred",
  open: true,
  at: T,
  waitingFor: "runs",
  activeRuns: 2,
  ...over,
});

interface Fixture {
  port: number;
  cookie: string;
  registry: Registry;
  /** Real browser-side SSE: raw wire text + parsed events. */
  openSse(): Promise<{
    clientId(): string | undefined;
    text(): string;
    events: SseEvent[];
    waitFor(pred: (e: SseEvent) => boolean, ms?: number): Promise<SseEvent>;
    close(): void;
  }>;
  agent(): Promise<TestClient>;
  cleanup(): Promise<void>;
}

const tmp = tmpDirs();
const sockPathHolder: { path: string } = { path: "" };
let server: net.Server;
let agentServer: AgentServer;
let fixture: Fixture;
const agentClients: TestClient[] = [];

beforeEach(async () => {
  const dir = makeTmp("pwh-rr-pass-");
  const sockPath = join(tmp.make("wh-rr-pass-"), "hub.sock");
  sockPathHolder.path = sockPath;
  const registry = createRegistry({ now: () => T, log: memLog(), pidAlive: () => true, hubVersion: HUB_VERSION });
  const deps = fakeDeps(dir.dir);
  const fe = createHttpFrontend({
    ...deps,
    now: () => T,
    info: () => ({ version: HUB_VERSION, buildId: "b1", pid: 1, startedAt: 1, proto: PROTO }),
    registry,
    bus: registry.bus,
  });
  const { port } = await fe.listen();
  // the REAL agent socket: same registry, same bus — hub.ts's own composition
  server = net.createServer();
  await new Promise<void>((r) => server.listen(sockPath, () => r()));
  agentServer = createAgentServer(server, {
    registry,
    config: config({ pluginVersion: HUB_VERSION, buildId: `${HUB_VERSION}@hub` }),
    log: memLog(),
    now: () => T,
    httpPort: () => port,
  });
  const cookie = await login(port, deps.paths.tokenFile);
  fixture = {
    port,
    cookie,
    registry,
    openSse: () => openRawSse(port, cookie),
    agent: async () => {
      const c = await connectClient(sockPathHolder.path);
      agentClients.push(c);
      c.send(hello({ caps: ["ev.v1", "cmd.v1", "command.v1"] }));
      await c.waitFrame((f) => f["t"] === "hello_ack");
      return c;
    },
    cleanup: async () => {
      for (const c of agentClients.splice(0)) c.sock.destroy();
      await agentServer.close();
      await new Promise<void>((r) => server.close(() => r()));
      await fe.close();
      dir.cleanup();
    },
  };
});

afterEach(async () => {
  await fixture.cleanup();
  tmp.cleanup();
});

/** Real SSE GET whose response bytes are ALSO accumulated verbatim. */
function openRawSse(
  port: number,
  cookie: string,
): Promise<ReturnType<Fixture["openSse"]> extends Promise<infer R> ? R : never> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/api/events",
        headers: { Cookie: cookie, Accept: "text/event-stream" },
        agent: false,
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`sse connect failed: ${res.statusCode}`));
          return;
        }
        let raw = "";
        let buf = "";
        const events: SseEvent[] = [];
        const waiters: Array<() => void> = [];
        const notify = (): void => {
          for (const w of [...waiters]) w();
        };
        const client = {
          clientId: () => events.find((e) => e.event === "hello")?.data?.clientId as string | undefined,
          text: () => raw,
          events,
          waitFor(pred: (e: SseEvent) => boolean, ms = 4_000): Promise<SseEvent> {
            return new Promise((res2, rej2) => {
              const check = (): boolean => {
                const hit = events.find(pred);
                if (hit !== undefined) {
                  cleanup();
                  res2(hit);
                  return true;
                }
                return false;
              };
              const timer = setTimeout(() => {
                cleanup();
                rej2(new Error(`waitFor timeout; got ${events.map((e) => e.event).join(",")}`));
              }, ms);
              const cleanup = (): void => {
                clearTimeout(timer);
                const i = waiters.indexOf(onEv);
                if (i >= 0) waiters.splice(i, 1);
              };
              const onEv = (): void => {
                check();
              };
              if (!check()) waiters.push(onEv);
            });
          },
          close: () => req.destroy(),
        };
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          raw += chunk;
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = parseSseBlock(block);
            if (ev !== undefined) events.push(ev);
          }
          notify();
        });
        res.on("error", () => undefined);
        resolve(client);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** The agent's status frame with a tracked-reload slot (the wire form `publishStatus` emits). */
const statusFrame = (reload: Record<string, unknown> | undefined, leaf = "L1"): Record<string, unknown> => ({
  t: "status",
  leafId: leaf,
  busy: false,
  pending: false,
  ...(reload === undefined ? {} : { reload }),
});

describe("#30 C1: StatusInfo.reload passthrough (agent socket → registry → HTTP/SSE)", () => {
  it("a status frame carrying `reload` reaches the SSE broadcast VERBATIM (open decoder → open slot)", async () => {
    const reload = reloadWire();
    const sse = await fixture.openSse();
    try {
      await sse.waitFor((e) => e.event === "agents"); // connect burst
      const agent = await fixture.agent();
      agent.send(statusFrame(reload));
      const ev = await sse.waitFor((e) => e.event === "status");
      expect(typeof ev.data?.agentKey).toBe("string");
      // verbatim, byte-for-byte: the SSE data line embeds the exact serialization the agent
      // wrote — key order included — because the hub stores and forwards the decoded object
      // without touching the slot.
      expect(sse.text()).toContain(`"reload":${JSON.stringify(reload)}`);
      expect(ev.data?.status?.reload).toEqual(reload);
      // the registry retained it untouched too
      const agentKey = ev.data?.agentKey as string;
      expect(fixture.registry.get(agentKey)?.status?.reload).toEqual(reload);
    } finally {
      sse.close();
    }
  });

  it("#88 directed re-send: a late subscriber gets the LATEST retained status, still verbatim", async () => {
    const rev1 = reloadWire();
    const rev2 = reloadWire({ rev: 2, state: "started", open: true });
    delete (rev2 as Record<string, string | undefined>).waitingFor;
    delete (rev2 as Record<string, number | undefined>).activeRuns;
    const sse = await fixture.openSse();
    try {
      await sse.waitFor((e) => e.event === "agents");
      const agent = await fixture.agent();
      const up = await sse.waitFor((e) => e.event === "agent_up");
      const agentKey = up.data?.agent?.agentKey as string;
      agent.send(statusFrame(rev1, "L1"));
      agent.send(statusFrame(rev2, "L2"));
      await sse.waitFor((e) => e.event === "status" && (e.data?.status?.reload as { rev?: number })?.rev === 2);
      // subscribe AFTER both frames — the directed re-send must carry the LATEST (rev 2)
      const res = await postJson(
        fixture.port,
        "/api/subscribe",
        { clientId: sse.clientId(), agentKey },
        { Cookie: fixture.cookie },
      );
      expect(res.status).toBe(202);
      const history = await sse.waitFor((e) => e.event === "history");
      expect(history.data?.agentKey).toBe(agentKey);
      // the re-sent status arrives right after history, before any buffered frame — pick the
      // FIRST status event AFTER the history event (not the earlier broadcast)
      const resent = await sse.waitFor((e) => {
        const idx = sse.events.indexOf(e);
        return e.event === "status" && idx > sse.events.indexOf(history);
      });
      expect(resent.id).toBeUndefined(); // directed sends never enter the replay ring
      expect(resent.data?.status).toEqual({ leafId: "L2", busy: false, pending: false, reload: rev2 });
      // byte-verbatim as well: this exact serialization of rev2 rode the wire again
      expect(sse.text()).toContain(`"reload":${JSON.stringify(rev2)}`);
      expect(fixture.registry.get(agentKey)?.status?.reload).toEqual(rev2);
    } finally {
      sse.close();
    }
  });

  it("TTL retraction wire shape (simulating P-A onTick 撤销后的帧形态，非端到端 TTL): a later status WITHOUT the slot replaces it — a fresh subscriber sees no residual", async () => {
    // NOTE: this simulates the WIRE SHAPE the agent's 1Hz onTick retraction publish produces
    // (a plain status frame without the slot) — it is NOT an end-to-end TTL validation (no
    // agent-side tracker/40min clock is exercised here; that lives in P-A's wiring tests).
    const sse = await fixture.openSse();
    try {
      await sse.waitFor((e) => e.event === "agents");
      const agent = await fixture.agent();
      const up = await sse.waitFor((e) => e.event === "agent_up");
      const agentKey = up.data?.agent?.agentKey as string;
      // tracked (slot present) → idle retraction (slot absent — what the 1Hz tick's retraction
      // publish looks like on the wire: a plain status frame)
      agent.send(statusFrame(reloadWire(), "L1"));
      await sse.waitFor((e) => e.event === "status" && e.data?.status?.reload !== undefined);
      agent.send(statusFrame(undefined, "L2"));
      const retracted = await sse.waitFor((e) => e.event === "status" && e.data?.status?.leafId === "L2");
      expect(retracted.data?.status?.reload).toBeUndefined();
      expect(fixture.registry.get(agentKey)?.status?.reload).toBeUndefined();
      // a FRESH browser (post-retraction): its directed re-send must show NO reload residue
      const fresh = await fixture.openSse();
      try {
        await fresh.waitFor((e) => e.event === "agents");
        const res = await postJson(
          fixture.port,
          "/api/subscribe",
          { clientId: fresh.clientId(), agentKey },
          { Cookie: fixture.cookie },
        );
        expect(res.status).toBe(202);
        const resent = await fresh.waitFor((e) => e.event === "status");
        expect(resent.data?.status?.reload).toBeUndefined();
        // and no residual bytes anywhere in this client's wire text
        expect(fresh.text()).not.toContain(`"reload":`);
      } finally {
        fresh.close();
      }
    } finally {
      sse.close();
    }
  });

  it("a future agent's unknown `reload` payload (unknown v, odd shape) is forwarded untouched", async () => {
    const future = { v: 99, life: "life-x", junk: [1, 2, { deep: true }], note: "未知版本" };
    const sse = await fixture.openSse();
    try {
      await sse.waitFor((e) => e.event === "agents");
      const agent = await fixture.agent();
      agent.send(statusFrame(future));
      const ev = await sse.waitFor((e) => e.event === "status");
      expect(ev.data?.status?.reload).toEqual(future);
      expect(sse.text()).toContain(`"reload":${JSON.stringify(future)}`);
      const agentKey = ev.data?.agentKey as string;
      expect(fixture.registry.get(agentKey)?.status?.reload).toEqual(future);
    } finally {
      sse.close();
    }
  });
});
