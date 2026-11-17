/** Real node:http sockets: SSE burst regression, incremental gzip, negotiation and slow peers. */
import { createServer, get, type IncomingMessage, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSseHub, formatSseFrame, type SseClient, type SseHub } from "../../src/web-hub/hub/sse.js";
import { startHub } from "../../src/web-hub/hub/hub.js";
import { decodeAgentFrame } from "../../src/web-hub/protocol/messages.js";
import { resolveHubPaths } from "../../src/web-hub/protocol/paths.js";
import {
  TERMINAL_LOCAL_DIR,
  createLocalAuthority,
  localProcess,
  processNamespaces,
} from "../../src/web-hub/protocol/terminal-local.js";
import { TERMINAL_HTTP_PATHS } from "../../src/web-hub/protocol/terminal-paths.js";
import { TERMINAL_UI_CAP } from "../../src/web-hub/protocol/version.js";
import { config, connectClient, hello } from "../web-hub/hub/helpers.js";
import { freePort } from "../helpers/free-port.js";
import { createSseOutput } from "../../src/web-hub/hub/sse-output.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { fakeDeps, login, makeAgent, postJson } from "../web-hub/http/helpers.js";
import { startLan, seedLanUser, lanPostJson } from "../web-hub/http/lan-helpers.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(handler: Parameters<typeof createServer>[0]): Promise<number> {
  const server: Server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise<void>((r) => server.close(() => r()));
  });
  return (server.address() as { port: number }).port;
}

async function open(port: number, headers: Record<string, string> = {}) {
  const start = performance.now();
  return new Promise<{
    res: IncomingMessage;
    text(): string;
    rawBytes(): number;
    firstMs(): number | undefined;
    wait(text: string): Promise<void>;
    end(): Promise<void>;
    close(): void;
  }>((resolve, reject) => {
    const req = get({ host: "127.0.0.1", port, path: "/api/events", headers, agent: false }, (res) => {
      let text = "",
        bytes = 0,
        first: number | undefined;
      const decoder = res.headers["content-encoding"] === "gzip" ? createGunzip() : undefined;
      const stream = decoder ?? res;
      let failure: Error | undefined;
      res.on("error", (err) => {
        failure = err;
      });
      decoder?.on("error", (err) => {
        failure = err;
      });
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
      });
      stream.on("data", (chunk: Buffer) => {
        first ??= performance.now() - start;
        text += chunk.toString();
      });
      if (decoder !== undefined) res.pipe(decoder);
      const close = () => {
        req.destroy();
        decoder?.destroy();
      };
      cleanups.push(close);
      resolve({
        res,
        text: () => text,
        rawBytes: () => bytes,
        firstMs: () => first,
        async wait(fragment) {
          await vi.waitFor(
            () => {
              if (failure !== undefined) throw failure;
              expect(text).toContain(fragment);
            },
            { timeout: 5_000, interval: 5 },
          );
        },
        async end() {
          await vi.waitFor(
            () => {
              if (failure !== undefined) throw failure;
              expect(stream.readableEnded).toBe(true);
            },
            { timeout: 5_000, interval: 5 },
          );
        },
        close,
      });
    });
    req.on("error", reject);
    req.setTimeout(8_000, () => req.destroy(new Error("SSE test socket deadline")));
  });
}

function synthetic(n: number, large: boolean) {
  const cards = Array.from({ length: n }, (_, i) => ({
    agentKey: `a${i}`,
    commands: Array.from({ length: 60 }, (_, j) => ({ name: `cmd${j}`, description: "d".repeat(200) })),
    status: { queue: Array.from({ length: 8 }, () => ({ text: "q".repeat(256) })) },
  }));
  const fleets = cards.map((card, i) => ({
    agentKey: card.agentKey,
    runs: Array.from({ length: large ? 128 : 64 }, (_, j) => ({
      runId: `r${i}-${j}`,
      status: "completed",
      toolTrail: "t".repeat(large ? 1600 : 256),
      streamLine: "s".repeat(large ? 1600 : 256),
    })),
  }));
  return { cards, fleets };
}

function hub(opts: Partial<Parameters<typeof createSseHub>[0]> = {}): SseHub {
  const h = createSseHub({ now: () => 0, ...opts });
  cleanups.push(() => h.closeAll());
  return h;
}

describe("SSE transport over real sockets", () => {
  it("identity and gzip decode to the exact same UTF-8 bytes, with each frame visible before the next is sent", async () => {
    const frames = [
      formatSseFrame("hello", { clientId: "fixed" }),
      formatSseFrame("hub", { caps: [] }),
      formatSseFrame("status", { replay: "回放🙂" }, 7),
      formatSseFrame("agents", { agents: [] }),
      formatSseFrame("history", { entries: [{ text: "正文\nline" }] }),
      formatSseFrame("ctl", { items: [] }),
      formatSseFrame("ping", { ts: 123 }),
    ];
    const received: Buffer[] = [];
    for (const compressed of [false, true]) {
      let output: ReturnType<typeof createSseOutput> | undefined;
      const port = await listen((req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          ...(compressed ? { "Content-Encoding": "gzip" } : {}),
        });
        output = createSseOutput(req, res, { gzip: compressed, maxBufferedBytes: 2 ** 21, stallMs: 500, onClose() {} });
        output.send(frames[0]!);
      });
      const conn = await open(port);
      let expected = frames[0]!;
      await conn.wait(expected);
      for (const frame of frames.slice(1)) {
        expect(output!.send(frame)).toBe(true);
        expected += frame;
        await conn.wait(expected); // no next write/end/ping can rescue a missing Z_SYNC_FLUSH
        expect(conn.text()).toBe(expected);
      }
      output!.finish();
      await conn.end();
      received.push(Buffer.from(conn.text()));
    }
    expect(received[0]).toEqual(Buffer.from(frames.join("")));
    expect(received[1]).toEqual(received[0]);
  });

  it("hello → Last-Event-ID replay → direct send → publish → ping share gzip ordering and flush", async () => {
    const h = hub({ pingMs: 50 });
    h.publish("status", { replay: 1 });
    h.publish("status", { replay: 2 });
    let client: SseClient | undefined;
    const port = await listen((req, res) => {
      client = h.attach(req, res, 0);
      client.send("agents", { agents: [] });
    });
    const conn = await open(port, { "Accept-Encoding": "gzip" });
    await conn.wait(formatSseFrame("agents", { agents: [] }));
    const prefix =
      formatSseFrame("hello", { clientId: client!.id }) +
      formatSseFrame("status", { replay: 1 }, 1) +
      formatSseFrame("status", { replay: 2 }, 2) +
      formatSseFrame("agents", { agents: [] });
    expect(conn.text().startsWith(prefix)).toBe(true);
    h.publish("fleet", { runs: [] });
    await conn.wait(formatSseFrame("fleet", { runs: [] }, 3));
    await conn.wait(formatSseFrame("ping", { ts: 0 }));
    expect(conn.text().indexOf("event: fleet")).toBeLessThan(conn.text().lastIndexOf("event: ping"));
    expect(conn.res.headers).toMatchObject({
      "content-encoding": "gzip",
      vary: "Accept-Encoding",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    h.revoke(() => true, "revoked");
    await conn.end();
    expect(conn.text().endsWith(formatSseFrame("auth", { reason: "revoked" }))).toBe(true);
  });

  it.each([
    [40, false],
    [10, true],
  ] as const)("%i agents large=%s bootstrap >2 MiB is fully delivered in order (identity + gzip)", async (n, large) => {
    const { cards, fleets } = synthetic(n, large);
    const payloads = [
      ["hub", {}],
      ["privacy", { locked: [] }],
      ["agents", { agents: cards }],
      ["spawns", { items: [] }],
      ["load", { level: "ok" }],
      ["schedules", { sessions: [] }],
      ...fleets.map((fleet) => ["fleet", fleet]),
    ] as Array<[Parameters<SseClient["send"]>[0], unknown]>;
    for (const compressed of [false, true]) {
      const h = hub();
      let client: SseClient | undefined;
      const port = await listen((req, res) => {
        client = h.attach(req, res, undefined);
        for (const [name, payload] of payloads) expect(client.send(name, payload)).toBe(true);
        client.close();
      });
      const conn = await open(port, compressed ? { "Accept-Encoding": "gzip" } : {});
      await conn.end();
      const expected =
        formatSseFrame("hello", { clientId: client!.id }) +
        payloads.map(([name, data]) => formatSseFrame(name, data)).join("");
      expect(Buffer.byteLength(expected)).toBeGreaterThan(2 ** 21);
      expect(Buffer.from(conn.text()).equals(Buffer.from(expected))).toBe(true);
      expect(conn.firstMs()).toBeDefined();
      if (compressed) expect(conn.rawBytes()).toBeLessThan(Buffer.byteLength(expected) / 2);
    }
  });

  it.each([false, true])(
    "real openEvents + runSnapshot near-2 MiB history → status → ctl → buffered events stays ordered (gzip=%s)",
    async (compressed) => {
      const dir = mkdtempSync(join(tmpdir(), "sse-snapshot-"));
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      const deps = fakeDeps(dir);
      deps.agents.set("a1", makeAgent("a1", { status: { queue: [{ text: "q".repeat(4096) }] } }));
      const payload = {
        agentKey: "a1",
        entries: [
          {
            id: "e1",
            parentId: null,
            type: "message" as const,
            timestamp: "2026-01-01",
            message: { role: "user", content: "x".repeat(2_095_000) },
          },
        ],
        tailMessages: [],
        fromSeq: 1,
        hasMore: false,
        source: "file" as const,
      };
      expect(Buffer.byteLength(formatSseFrame("history", payload))).toBeLessThan(2 ** 21);
      let resolveSnapshot: ((p: typeof payload) => void) | undefined;
      deps.setSnapshot(
        () =>
          new Promise((resolve) => {
            resolveSnapshot = resolve;
          }),
      );
      const fe = createHttpFrontend(deps);
      cleanups.push(() => fe.close());
      const port = (await fe.listen()).port;
      const cookie = await login(port, deps.paths.tokenFile);
      const conn = await open(port, { Cookie: cookie, ...(compressed ? { "Accept-Encoding": "gzip" } : {}) });
      await conn.wait("event: agents\n");
      const clientId = JSON.parse(/event: hello\ndata: ([^\n]+)/.exec(conn.text())![1]!).clientId;
      deps.emit({
        type: "ctl",
        agentKey: "a1",
        epoch: "e",
        sessionId: "s",
        items: [{ cmdId: "cmd1", op: "prompt", state: "running", at: 0, updatedAt: 0 }],
      });
      expect((await postJson(port, "/api/subscribe", { clientId, agentKey: "a1" }, { Cookie: cookie })).status).toBe(
        202,
      );
      await vi.waitFor(() => expect(resolveSnapshot).toBeDefined());
      deps.emit({ type: "ev", agentKey: "a1", seq: 2, e: { type: "turn_start" } });
      resolveSnapshot!(payload);
      await conn.wait('"type":"turn_start"');
      const after = conn.text().slice(conn.text().indexOf("event: history\n"));
      expect(after.startsWith(formatSseFrame("history", payload))).toBe(true);
      expect([...after.matchAll(/event: ([^\n]+)/g)].map((m) => m[1])).toEqual(["history", "status", "ctl", "ev"]);
    },
  );

  it.each([false, true])(
    "a genuinely non-reading socket is disconnected within a bounded grace (gzip=%s)",
    async (compressed) => {
      const h = hub({ maxBufferedBytes: 64 * 1024, stallMs: 150 });
      let client: SseClient | undefined;
      const port = await listen((req, res) => {
        client = h.attach(req, res, undefined);
      });
      const conn = await open(port, compressed ? { "Accept-Encoding": "gzip" } : {});
      await conn.wait("event: hello\n");
      conn.res.pause();
      const pad = randomBytes(128 * 1024).toString("base64"); // incompressible enough to fill kernel buffers even in gzip mode
      for (let i = 0; i < 200; i++) client!.send("fleet", { i, pad });
      await vi.waitFor(() => expect(h.count()).toBe(0), { timeout: 3_000, interval: 10 });
      expect(client!.send("ping", {})).toBe(false);
    },
  );

  it("LAN /api/events negotiates gzip after authentication and gzip;q=0 stays identity", async () => {
    const lan = await startLan();
    cleanups.push(() => lan.cleanup());
    seedLanUser(lan.store, { username: "alice", password: "correct-horse-battery" });
    const loggedIn = await lanPostJson(lan.port, "/api/login", {
      username: "alice",
      password: "correct-horse-battery",
    });
    const cookie = loggedIn.headers["set-cookie"]![0]!.split(";")[0]!;
    for (const encoding of ["gzip", "gzip;q=0", "br", "*"]) {
      const conn = await open(lan.port, { Cookie: cookie, "Accept-Encoding": encoding });
      await conn.wait("event: agents\n");
      expect(conn.res.headers["content-encoding"]).toBe(encoding === "gzip" ? "gzip" : undefined);
      expect(conn.res.headers.vary).toBe("Accept-Encoding");
      conn.close();
    }
  });
});

describe.each(["identity", "gzip"] as const)("early terminal unavailable over real %s HTTP", (encoding) => {
  it.each([
    ["missing-journal", "loopback"],
    ["degraded-privacy", "loopback"],
    ["stale-pid", "loopback"],
    ["stale-boot", "loopback"],
    ["stale-pid", "lan"],
    ["stale-boot", "lan"],
    ["degraded-privacy", "lan"],
  ] as const)(
    "keeps public SSE/subscriptions alive, exposes unavailable, denies terminal: %s / %s",
    async (reason, listener) => {
      const home = mkdtempSync(join(tmpdir(), "sse-unavailable-"));
      cleanups.push(() => rmSync(home, { recursive: true, force: true }));
      const paths = resolveHubPaths({ home, uid: process.getuid!() });
      mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(home, ".pi", "agent", "pi-toolkit.json"),
        JSON.stringify({ webHub: { terminal: { enabled: true } } }),
        { mode: 0o600 },
      );
      const previousSource = process.env.PI_WEBHUB_TERMINAL_SOURCE;
      process.env.PI_WEBHUB_TERMINAL_SOURCE = "plain";
      cleanups.push(() => {
        if (previousSource === undefined) delete process.env.PI_WEBHUB_TERMINAL_SOURCE;
        else process.env.PI_WEBHUB_TERMINAL_SOURCE = previousSource;
      });
      if (reason === "missing-journal") mkdirSync(join(paths.stateDir, TERMINAL_LOCAL_DIR), { mode: 0o700 });
      else if (reason === "degraded-privacy")
        writeFileSync(join(paths.stateDir, "privacy.json"), "corrupt", { mode: 0o600 });
      else {
        // Real initialized store + valid-shaped authority from an obsolete process/boot.
        // No production state, no bypass of cold-start residue validation.
        await createLocalAuthority(
          paths.stateDir,
          {
            agentNonce: "old-agent",
            sessionId: "old-session",
            epoch: "old-epoch",
            ownerInstance: "old-owner",
            process: {
              ...localProcess(process.pid),
              ...(reason === "stale-pid" ? { pid: 2147483647 } : { bootId: "previous-boot" }),
            },
            namespaces: processNamespaces(process.pid),
            domain: "plain",
            main: true,
            active: true,
          },
          () => true,
        );
      }
      const hub = await startHub(
        config({
          home,
          privacy: true,
          control: true,
          ...(listener === "lan"
            ? { lan: { port: await freePort(), extraHosts: [], trustProxyFrom: [], externalOrigins: [] } }
            : {}),
          terminal: {
            maxPerSession: 2,
            maxPerPrincipal: 2,
            maxTotal: 8,
            inputIdleMs: 3600000,
            maxLifetimeMs: 28800000,
          },
        }),
        createHttpFrontend,
      );
      if ("exists" in hub) throw new Error("unexpected singleton");
      cleanups.push(() => hub.close("test"));
      const peer = await connectClient(hub.paths.socketPath);
      cleanups.push(() => {
        peer.sock.destroy();
      });
      peer.send(hello({ agentId: { pid: process.pid, nonce: "unavailable-test-peer" } }));
      const ack = await peer.waitFrame((f) => f.t === "hello_ack");
      let port = hub.httpPort;
      let cookie: string;
      if (listener === "lan") {
        await vi.waitFor(() => expect(hub.lanStatus()?.state).toBe("on"));
        const status = hub.lanStatus();
        if (status?.state !== "on") throw new Error("LAN not listening");
        port = status.port;
        peer.send({ t: "lan_req", rid: "login-info", op: "info" });
        const result = await peer.waitFrame((f) => f.t === "lan_res" && f.rid === "login-info");
        const info = result.info as { username: string; initialPassword: string };
        expect(result.ok).toBe(true);
        const loggedIn = await lanPostJson(port, "/api/login", {
          username: info.username,
          password: info.initialPassword,
        });
        expect(loggedIn.status).toBe(200);
        cookie = loggedIn.headers["set-cookie"]![0]!.split(";")[0]!;
      } else cookie = await login(port, hub.paths.tokenFile);
      const conn = await open(port, { Cookie: cookie, "Accept-Encoding": encoding });
      await conn.wait("event: agents\n");
      expect(conn.res.statusCode).toBe(200);
      expect(conn.res.complete).toBe(false);
      expect(conn.res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
      expect(conn.res.headers["content-encoding"]).toBe(encoding === "gzip" ? "gzip" : undefined);
      const frames = conn
        .text()
        .trimEnd()
        .split("\n\n")
        .map((block) => {
          const lines = block.split("\n");
          return {
            event: lines.find((line) => line.startsWith("event: "))?.slice(7),
            data: JSON.parse(lines.find((line) => line.startsWith("data: "))!.slice(6)),
          };
        });
      expect(frames[0]?.event).toBe("hello");
      expect(frames.find((frame) => frame.event === "hub")?.data.caps).toContain(TERMINAL_UI_CAP);
      const terminal = frames.find((frame) => frame.event === "hub")?.data.terminal;
      expect(terminal).toMatchObject({ state: "unavailable", reason: expect.any(String) });
      if (reason === "stale-pid") expect(terminal.reason).toBe("stale-authority-same-boot");
      if (reason === "stale-boot") expect(terminal.reason).toBe("authority-corrupt");
      if (reason === "degraded-privacy") expect(terminal.reason).toBe("privacy-unavailable");
      expect(frames.some((frame) => frame.event === "agents")).toBe(true);
      const headers = { Cookie: cookie, Origin: `http://127.0.0.1:${port}` };
      const subscription = { clientId: frames[0]!.data.clientId, agentKey: ack.agentKey };
      const subscribed = await postJson(port, "/api/subscribe", subscription, headers);
      expect(subscribed.status, subscribed.body).toBe(202);
      for (const path of Object.values(TERMINAL_HTTP_PATHS)) {
        const denied = await postJson(
          port,
          path,
          {
            ...subscription,
            connectionInstance: "forged",
            connectionToken: "forged",
            expect: { sessionId: "old-session", epoch: "old-epoch" },
          },
          headers,
        );
        expect(denied.status, path).toBe(503);
        expect(JSON.parse(denied.body)).toEqual({ ok: false, code: "E_UNAVAILABLE", effect: "none" });
      }
      // After real HTTP round trips the ORIGINAL public stream/clientId is still usable.
      expect((await postJson(port, "/api/subscribe", subscription, headers)).status).toBe(202);
      expect(conn.res.readableEnded).toBe(false);
      expect(conn.res.destroyed).toBe(false);
      expect(conn.res.complete).toBe(false);
      expect(frames.some((frame) => frame.event === "terminal_connection" || frame.event === "terminal")).toBe(false);
      expect(conn.text()).not.toMatch(/connectionToken|connectionInstance|event: terminal(?:_connection)?\n/);
    },
  );
});

describe.each(["identity", "gzip"] as const)("ready terminal large public bootstrap / %s", (encoding) => {
  it.each([
    ["loopback", false],
    ["lan", false],
    ["loopback", true],
    ["lan", true],
  ] as const)(
    "keeps public stream after real logout/relogin / %s / lost drain notification=%s",
    async (listener, lostDrain) => {
      const home = mkdtempSync(join(tmpdir(), "sse-ready-"));
      cleanups.push(() => rmSync(home, { recursive: true, force: true }));
      const paths = resolveHubPaths({ home, uid: process.getuid!() });
      mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(home, ".pi/agent/pi-toolkit.json"),
        JSON.stringify({ webHub: { terminal: { enabled: true } } }),
        { mode: 0o600 },
      );
      const previous = process.env.PI_WEBHUB_TERMINAL_SOURCE;
      process.env.PI_WEBHUB_TERMINAL_SOURCE = "plain";
      cleanups.push(() => {
        if (previous === undefined) delete process.env.PI_WEBHUB_TERMINAL_SOURCE;
        else process.env.PI_WEBHUB_TERMINAL_SOURCE = previous;
      });
      let fleetSeen = false;
      const pending: number[] = [];
      const h = await startHub(
        config({
          home,
          control: true,
          privacy: true,
          ...(listener === "lan"
            ? { lan: { port: await freePort(), extraHosts: [], trustProxyFrom: [], externalOrigins: [] } }
            : {}),
        }),
        (deps) => {
          cleanups.push(
            deps.bus.subscribe((event) => {
              if (event.type === "fleet") fleetSeen = true;
            }),
          );
          const terminal = deps.terminal;
          return createHttpFrontend({
            ...deps,
            ...(terminal && "openSse" in terminal
              ? {
                  terminal: {
                    ...terminal,
                    openSse(
                      ...args: Parameters<
                        import("../../src/web-hub/hub/terminal/routes.js").TerminalFrontendPort["openSse"]
                      >
                    ) {
                      pending.push(args[5].pendingBytes());
                      // Fault injection: encoder still drains normally, but its one-shot notification is lost.
                      // This exercises the REAL admission deadline and the HTTP negative-HubInfo projection.
                      if (lostDrain) args[5] = { ...args[5], onIdle: () => () => {} };
                      (terminal as import("../../src/web-hub/hub/terminal/routes.js").TerminalFrontendPort).openSse(
                        ...args,
                      );
                    },
                  },
                }
              : {}),
          });
        },
      );
      if ("exists" in h) throw new Error("unexpected singleton");
      cleanups.push(() => h.close("test"));
      const peer = await connectClient(h.paths.socketPath);
      cleanups.push(() => {
        peer.sock.destroy();
      });
      peer.send(hello({ agentId: { pid: process.pid, nonce: "ready-bootstrap-test-peer" } }));
      const ack = await peer.waitFrame((f) => f.t === "hello_ack");
      let port = h.httpPort;
      let realLogin: () => Promise<string>;
      if (listener === "lan") {
        await vi.waitFor(() => expect(h.lanStatus()?.state).toBe("on"));
        const status = h.lanStatus();
        if (status?.state !== "on") throw new Error("LAN not listening");
        port = status.port;
        peer.send({ t: "lan_req", rid: "bootstrap-login", op: "info" });
        const result = await peer.waitFrame((f) => f.t === "lan_res" && f.rid === "bootstrap-login");
        expect(result.ok).toBe(true);
        const info = result.info as { username: string; initialPassword: string };
        realLogin = async () => {
          const result = await lanPostJson(port, "/api/login", {
            username: info.username,
            password: info.initialPassword,
          });
          expect(result.status).toBe(200);
          return result.headers["set-cookie"]![0]!.split(";")[0]!;
        };
      } else realLogin = () => login(port, h.paths.tokenFile);
      const originalCookie = await realLogin();
      expect(
        (await postJson(port, "/api/logout", {}, { Cookie: originalCookie, Origin: `http://127.0.0.1:${port}` }))
          .status,
      ).toBe(200);
      const cookie = await realLogin();
      const runs = Array.from({ length: 64 }, (_, i) => ({
        runId: `large-${i}`,
        status: "completed",
        phaseLabel: "done",
        elapsedMs: 100,
        phaseMs: 100,
        highlight: "none",
        terminal: true,
        toolTrail: "t".repeat(1200),
        streamLine: "s".repeat(1200),
      }));
      const frame = { t: "fleet", runs };
      expect(decodeAgentFrame(frame)).toBeDefined();
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeGreaterThan(65_536);
      peer.send(frame);
      await vi.waitFor(() => expect(fleetSeen).toBe(true));
      const conn = await open(port, { Cookie: cookie, "Accept-Encoding": encoding });
      await conn.wait(lostDrain ? '"reason":"sse-admission-timeout"' : "event: terminal_connection\n");
      expect(pending).toHaveLength(1);
      expect(pending[0]).toBeGreaterThan(65_536);
      expect(conn.res.statusCode).toBe(200);
      expect(conn.res.headers["content-encoding"]).toBe(encoding === "gzip" ? "gzip" : undefined);
      const blocks = conn
        .text()
        .trimEnd()
        .split("\n\n")
        .map((block) => ({
          event: /^event: (.+)$/m.exec(block)?.[1],
          data: JSON.parse(/^data: (.+)$/m.exec(block)![1]!),
        }));
      expect(blocks.map((b) => b.event)).toEqual([
        "hello",
        "hub",
        "privacy",
        "agents",
        "fleet",
        lostDrain ? "hub" : "terminal_connection",
      ]);
      expect(blocks.find((b) => b.event === "fleet")!.data.runs).toEqual(runs);
      expect(blocks.find((b) => b.event === "hub")!.data.terminal).toBeUndefined();
      if (lostDrain) {
        const hint = blocks.at(-1)!.data;
        expect(hint.terminal).toEqual({ state: "unavailable", reason: "sse-admission-timeout" });
        expect(hint.caps).toContain(TERMINAL_UI_CAP);
        expect(hint.port).toBe(port);
        expect(conn.text()).not.toMatch(/connectionToken|terminal_connection/);
      } else {
        const connection = blocks.at(-1)!.data;
        expect(connection.connectionToken).toEqual(expect.any(String));
        expect(connection.connectionInstance).toEqual(expect.any(String));
        expect(connection.expiresAt).toBeGreaterThan(Date.now());
      }
      const clientId = blocks[0]!.data.clientId;
      const headers = { Cookie: cookie, Origin: `http://127.0.0.1:${port}` };
      expect((await postJson(port, "/api/subscribe", { clientId, agentKey: ack.agentKey }, headers)).status).toBe(202);
      if (lostDrain) {
        const denied = await postJson(
          port,
          TERMINAL_HTTP_PATHS.list,
          {
            clientId,
            agentKey: ack.agentKey,
            connectionInstance: "forged",
            connectionToken: "forged",
            expect: { sessionId: "session", epoch: "epoch" },
          },
          headers,
        );
        expect(denied.status).toBe(401);
        expect(JSON.parse(denied.body)).toEqual({ ok: false, code: "E_AUTH", effect: "none" });
      }
      // A subsequent real producer frame proves this same public stream is still live.
      peer.send({ t: "fleet", runs: [] });
      await conn.wait(formatSseFrame("fleet", { agentKey: ack.agentKey, runs: [] }).trimEnd());
      expect(conn.res.destroyed).toBe(false);
      expect(conn.res.readableEnded).toBe(false);
      expect(conn.res.complete).toBe(false);
    },
  );
});
