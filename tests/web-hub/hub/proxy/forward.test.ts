import { afterEach, describe, expect, it } from "vitest";
import { createServer, request, type IncomingMessage, type IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import { once } from "node:events";
import { createProxyAdmission, createProxyForwarder } from "../../../../src/web-hub/hub/proxy/forward.js";
import {
  PROXY_QUEUE_WAIT_MS,
  PROXY_HEAD_TIMEOUT_MS,
  PROXY_REQUEST_BODY_MAX_BYTES,
  PROXY_STREAM_HWM_BYTES,
  PROXY_SOCKET_TIMEOUT_MS,
  PROXY_STRICT_CSP_BASE,
} from "../../../../src/web-hub/protocol/proxy.js";
import { engine, identity, listen, waitFor } from "./engine-helpers.js";
import { manualClock } from "./helpers.js";
import { resolveProxyTarget } from "../../../../src/web-hub/hub/proxy/dns-gate.js";
import { createProxySessionStore } from "../../../../src/web-hub/hub/proxy/sessions.js";
import { sendProxyResponse } from "../../../../src/web-hub/hub/proxy/listener.js";

let env: Awaited<ReturnType<typeof engine>>;
afterEach(async () => {
  await env?.close();
});
describe("T-H4 HTTP budgets", () => {
  it("admission bounds 32/128 active and 64/256 queued, FIFO, deadlines/removal and idempotent release", () => {
    const clock = manualClock();
    const admission = createProxyAdmission(clock.timer);
    const releases: Array<() => void> = [];
    const started: string[] = [];
    let refused = 0;
    const submit = (key: string, tag: string) =>
      admission.submit(
        key,
        (release) => {
          started.push(tag);
          releases.push(release);
        },
        () => refused++,
      );
    for (const key of ["a", "b", "c", "d"]) for (let i = 0; i < 32; i++) submit(key, `${key}${i}`);
    expect(admission.stats()).toEqual({ active: 128, queued: 0 });
    const cancels: Array<() => void> = [];
    for (const key of ["a", "b", "c", "d"]) for (let i = 0; i < 64; i++) cancels.push(submit(key, `${key}q${i}`));
    submit("e", "global-over");
    submit("a", "per-over");
    expect(admission.stats()).toEqual({ active: 128, queued: 256 });
    expect(refused).toBe(2);
    cancels[0]!();
    expect(admission.stats().queued).toBe(255);
    releases[0]!();
    releases[0]!();
    expect(started.at(-1)).toBe("aq1");
    expect(admission.stats()).toEqual({ active: 128, queued: 254 });
    clock.advance(PROXY_QUEUE_WAIT_MS - 1);
    expect(refused).toBe(2);
    clock.advance(1);
    expect(refused).toBe(256);
    expect(admission.stats().queued).toBe(0);
    for (const release of releases) release();
    expect(admission.stats()).toEqual({ active: 0, queued: 0 });
    expect(clock.pending()).toBe(0);
  });
  it("300 pipelined real requests never dial >32; 64 waiters and 204 refusals with Retry-After; queue deadline is 10s", async () => {
    const clock = manualClock();
    env = await engine({ now: clock.now, timer: clock.timer });
    const opened = await env.open();
    const { cookie } = await env.enter(opened);
    const socket = await env.raw(Number(new URL(opened.origin).port));
    let text = "";
    socket.on("data", (b) => {
      text += b.toString();
    });
    socket.write(
      Array.from(
        { length: 300 },
        () => `GET /hang HTTP/1.1\r\nHost: ${new URL(opened.origin).host}\r\nCookie: ${cookie}\r\n\r\n`,
      ).join(""),
    );
    await waitFor(() => env.up.held === 32);
    // Wait until the parser has admitted/rejected all requests before advancing the queue clock.
    await waitFor(() => clock.pending() >= 32 * 2 + 64 * 2);
    clock.advance(PROXY_QUEUE_WAIT_MS);
    env.up.release();
    await waitFor(() => (text.match(/HTTP\/1.1/g) ?? []).length === 300);
    expect(env.up.peakHeld).toBe(32);
    expect(env.up.requests).toHaveLength(32);
    expect((text.match(/HTTP\/1.1 200/g) ?? []).length).toBe(32);
    expect((text.match(/HTTP\/1.1 503/g) ?? []).length).toBe(268);
    expect((text.match(/Retry-After: 1/gi) ?? []).length).toBe(268);
    const refusals = text.split("HTTP/1.1 ").filter((part) => part.startsWith("503"));
    for (const part of refusals) {
      const head = part.split("\r\n\r\n")[0]!;
      expect(head).toContain(
        `Content-Security-Policy: ${PROXY_STRICT_CSP_BASE}; frame-ancestors 'self' http://127.0.0.1:1\r\n`,
      );
      expect(head.toLowerCase()).not.toContain("x-frame-options");
    }
    socket.destroy();
  });
  it("queued abort removes the waiter, in-flight abort cancels upstream without a later hidden dial", async () => {
    const clock = manualClock();
    env = await engine({ now: clock.now, timer: clock.timer });
    const opened = await env.open();
    const { cookie } = await env.enter(opened);
    const piped = await env.raw(Number(new URL(opened.origin).port));
    piped.on("data", () => {});
    piped.write(
      Array.from(
        { length: 32 },
        () => `GET /hang HTTP/1.1\r\nHost: ${new URL(opened.origin).host}\r\nCookie: ${cookie}\r\n\r\n`,
      ).join(""),
    );
    await waitFor(() => env.up.held === 32);
    const queued = await env.raw(Number(new URL(opened.origin).port));
    queued.write(`GET /should-not-dial HTTP/1.1\r\nHost: ${new URL(opened.origin).host}\r\nCookie: ${cookie}\r\n\r\n`);
    await waitFor(() => env.service.activeConnections() === 2);
    queued.destroy();
    await waitFor(() => env.service.activeConnections() === 1);
    piped.destroy();
    await waitFor(() => env.up.held === 0);
    expect(env.up.requests).toHaveLength(32);
    expect(env.up.requests.some((r) => r.path === "/should-not-dial")).toBe(false);
  });
  it("header size >16KiB ⇒ 431 and half headers destroyed by 10s/1s checker", async () => {
    env = await engine();
    const opened = await env.open();
    const socket = await env.raw(Number(new URL(opened.origin).port));
    let response = "";
    socket.on("data", (b) => {
      response += b.toString();
    });
    const closed = once(socket, "close");
    socket.write(`GET / HTTP/1.1\r\nHost: ${new URL(opened.origin).host}\r\nX-Large: ${"a".repeat(17000)}\r\n\r\n`);
    await closed;
    expect(response).toContain("431");
    expect(env.up.connections).toBe(0);
    const half = await env.raw(Number(new URL(opened.origin).port));
    half.on("data", () => {});
    const at = Date.now();
    const end = once(half, "close");
    half.write("GET / HTTP/1.1\r\nHost: ");
    await end;
    expect(Date.now() - at).toBeLessThan(11500);
    expect(Date.now() - at).toBeGreaterThanOrEqual(9900);
    expect(env.servers[0]!.headersTimeout).toBe(10000);
    expect(env.servers[0]!.requestTimeout).toBe(300000);
    expect(env.servers[0]!.maxRequestsPerSocket).toBe(1000);
  }, 15000);
  it("connection refused ⇒ 502 and slow head ⇒ 504 at head deadline", async () => {
    const clock = manualClock();
    env = await engine({ now: clock.now, timer: clock.timer });
    // Reserve and release a kernel port using a real server; no guessed privileged port.
    const unused = env.range[1] + 1;
    const no = await env.open(`127.0.0.1:${unused}`);
    const auth = await env.enter(no);
    const refused = await env.http(no.origin, { headers: { Cookie: auth.cookie } });
    expect(refused.status).toBe(502);
    expect(refused.headers["content-security-policy"]).toBe(
      `${PROXY_STRICT_CSP_BASE}; frame-ancestors 'self' http://127.0.0.1:1`,
    );
    expect(refused.headers["x-frame-options"]).toBeUndefined();
    const slow = await env.open();
    const { cookie } = await env.enter(slow);
    const response = env.http(slow.origin + "/slow-head", { headers: { Cookie: cookie } });
    await waitFor(() => env.up.held === 1);
    clock.advance(PROXY_HEAD_TIMEOUT_MS);
    const timeout = await response;
    expect(timeout.status).toBe(504);
    expect(timeout.headers["content-security-policy"]).toBe(
      `${PROXY_STRICT_CSP_BASE}; frame-ancestors 'self' http://127.0.0.1:1`,
    );
    expect(timeout.headers["x-frame-options"]).toBeUndefined();
    await waitFor(() => env.up.held === 0);
  });
  it("streams a huge response without buffering it whole, and stops a paused-reader stream on disconnect", async () => {
    env = await engine();
    const opened = await env.open();
    const { cookie } = await env.enter(opened);
    const huge = await env.http(opened.origin + "/huge", { headers: { Cookie: cookie } });
    expect(huge.body.length).toBe(4 * 1024 * 1024);
    const socket = await env.raw(Number(new URL(opened.origin).port));
    socket.write(`GET /flood HTTP/1.1\r\nHost: ${new URL(opened.origin).host}\r\nCookie: ${cookie}\r\n\r\n`);
    socket.pause();
    await waitFor(() => [...env.accepted].some((s) => s.writableNeedDrain));
    const proxy = [...env.accepted].find((s) => s.writableNeedDrain)!;
    expect(proxy.writableLength).toBeLessThanOrEqual(PROXY_STREAM_HWM_BYTES * 2 + 1024);
    expect(proxy.readableLength).toBeLessThanOrEqual(PROXY_STREAM_HWM_BYTES * 2);
    socket.destroy();
    await waitFor(() => env.up.sockets.size === 0);
  });
  it("real >256MiB request is cut at the counting Transform and answered 413 before response head", async () => {
    env = await engine();
    const opened = await env.open();
    const { cookie } = await env.enter(opened);
    const u = new URL(opened.origin);
    const result = new Promise<{ status: number; headers: IncomingHttpHeaders }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: Number(u.port),
          path: "/sink",
          method: "POST",
          agent: false,
          headers: { Cookie: cookie, "Content-Length": String(PROXY_REQUEST_BODY_MAX_BYTES + PROXY_STREAM_HWM_BYTES) },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers }));
        },
      );
      req.on("socket", (s) => {
        env.clients.add(s);
        s.unref();
        s.on("close", () => env.clients.delete(s));
      });
      req.on("error", reject);
      let sent = 0;
      const chunk = Buffer.alloc(PROXY_STREAM_HWM_BYTES, 0x61);
      const pump = () => {
        while (!req.destroyed && sent <= PROXY_REQUEST_BODY_MAX_BYTES) {
          sent += chunk.length;
          if (!req.write(chunk)) {
            req.once("drain", pump);
            return;
          }
        }
        if (!req.destroyed) req.end();
      };
      pump();
    });
    const tooLarge = await result;
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.headers["content-security-policy"]).toBe(
      `${PROXY_STRICT_CSP_BASE}; frame-ancestors 'self' http://127.0.0.1:1`,
    );
    expect(tooLarge.headers["x-frame-options"]).toBeUndefined();
    expect(env.up.requests[0]!.bytes).toBeLessThanOrEqual(PROXY_REQUEST_BODY_MAX_BYTES);
    await waitFor(() => env.up.sockets.size === 0);
  }, 15000);
  it("follow-up rework: live 40MiB upload survives a 3s upstream read pause and delivers every byte", async () => {
    env = await engine();
    const opened = await env.open();
    const { cookie } = await env.enter(opened);
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    let paused = false,
      resumed = false;
    let pausedAt = 0;
    env.up.server.on("request", (req) => {
      if (req.url !== "/sink") return;
      req.pause();
      paused = true;
      pausedAt = Date.now();
      resumeTimer = setTimeout(() => {
        resumed = true;
        req.resume();
      }, 3000);
      resumeTimer.unref();
    });
    const total = 40 * 1024 * 1024;
    const u = new URL(opened.origin);
    let upload: ReturnType<typeof request> | undefined;
    try {
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        upload = request(
          {
            host: "127.0.0.1",
            port: Number(u.port),
            path: "/sink",
            method: "POST",
            agent: false,
            headers: { Cookie: cookie, "Content-Length": String(total) },
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => {
              body += chunk.toString();
            });
            res.on("error", reject);
            res.on("end", () => resolve({ status: res.statusCode!, body }));
          },
        );
        const req = upload;
        req.on("socket", (socket) => {
          env.clients.add(socket);
          socket.unref();
          socket.on("close", () => env.clients.delete(socket));
        });
        req.on("error", reject);
        let sent = 0;
        const chunk = Buffer.alloc(PROXY_STREAM_HWM_BYTES, 0x61);
        const pump = () => {
          while (!req.destroyed && sent < total) {
            sent += chunk.length;
            if (!req.write(chunk)) {
              req.once("drain", pump);
              return;
            }
          }
          if (!req.destroyed) req.end();
        };
        pump();
      });
      expect(paused).toBe(true);
      expect(resumed).toBe(true);
      expect(Date.now() - pausedAt).toBeGreaterThanOrEqual(2900);
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body).bytes).toBe(total);
      expect(env.up.requests).toHaveLength(1);
      expect(env.up.requests[0]!.bytes).toBe(total);
    } finally {
      if (resumeTimer) clearTimeout(resumeTimer);
      upload?.destroy();
    }
  }, 15000);
  it("follow-up rework: hidden client FIN releases the paused upload via the existing socket idle path", async () => {
    env = await engine();
    // Extend the real fixture in this test only; no read stubs or fake requests.
    env.up.server.on("request", (req) => {
      if (req.url === "/hang") req.pause();
    });
    const sessions = createProxySessionStore({ now: Date.now });
    const minted = sessions.mintCode(0, identity(), {
      instanceId: "paused-upload",
      origin: "http://local",
      nextPath: "/",
    });
    if (!minted.ok) throw new Error("mint failed");
    const exchanged = sessions.exchange(minted.code, "paused-upload", "http://local");
    if (!exchanged.ok) throw new Error("exchange failed");
    const pinned = await resolveProxyTarget(
      `127.0.0.1:${env.up.port}`,
      {
        inflight: false,
        resolve: async () => {
          throw new Error("unexpected DNS");
        },
      },
      { hubPort: 1, proxyRange: env.range, localAddresses: [] },
    );
    if (!pinned.ok) throw new Error("pin failed");
    const admission = createProxyAdmission();
    const traffic = { reqs: 0, bytesUp: 0, bytesDown: 0, ws: 0 };
    const forward = createProxyForwarder({
      instanceId: "paused-upload",
      pinned: pinned.pinned,
      sessions,
      sessionTraffic: () => traffic,
      admission,
      traffic,
      reply: (res, status, headers, policy) => sendProxyResponse(res, status, headers, undefined, policy),
      now: Date.now,
    });
    let incoming: IncomingMessage | undefined;
    const server = createServer((req, res) => {
      incoming = req;
      forward.handle(req, res, {
        origin: "http://local",
        browserHost: "local",
        frameAncestors: "'self' http://local:7878",
        session: exchanged.rec,
        traffic: { reqs: 0, bytesUp: 0, bytesDown: 0, ws: 0 },
      });
    });
    const sockets = new Set<Socket>();
    let idleFired = false;
    server.on("connection", (s) => {
      sockets.add(s);
      s.unref();
      // Same existing HTTP idle fallback as the real proxy listener, not a new upload
      // timeout; shorten only this socket later so the regression needn't wait 120s.
      s.setTimeout(PROXY_SOCKET_TIMEOUT_MS, () => {
        idleFired = true;
        s.destroy();
      });
      s.on("close", () => sockets.delete(s));
    });
    let client: Socket | undefined;
    try {
      await listen(server, 0, "127.0.0.1");
      client = await env.raw((server.address() as { port: number }).port);
      client.write("POST /hang HTTP/1.1\r\nHost: local\r\nContent-Length: 1073741824\r\n\r\n");
      // Leave the large write pending rather than waiting for drain: a stopped upstream
      // intentionally cannot accept the entire declared body (the real failure scenario).
      client.write(Buffer.alloc(17 * 1024 * 1024, 0x61));
      await waitFor(() => incoming?.socket.isPaused() === true && admission.stats().active === 1 && env.up.held === 1);
      expect(incoming!.complete).toBe(false);
      const upstreamSockets = Object.values(forward.agent.sockets).flat();
      expect(upstreamSockets).toHaveLength(1);
      expect(incoming!.socket.timeout).toBe(120000);
      const at = Date.now();
      client.destroy();
      expect(admission.stats().active).toBe(1); // FIN is hidden behind unread upload bytes.
      incoming!.socket.setTimeout(100); // injected short value for the existing idle path
      await waitFor(() => admission.stats().active === 0 && incoming!.socket.destroyed, 1250);
      expect(idleFired).toBe(true);
      expect(Date.now() - at).toBeGreaterThanOrEqual(80);
      expect(Date.now() - at).toBeLessThan(1250);
      expect(upstreamSockets.every((s) => s!.destroyed)).toBe(true);
      expect(admission.stats()).toEqual({ active: 0, queued: 0 });
      expect(Object.values(forward.agent.sockets).flat()).toHaveLength(0);
      // A forwarder closed before handle() must still use this request gate's policy.
      forward.close();
      const closed = await env.http(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
      expect(closed.status).toBe(503);
      expect(closed.headers["content-security-policy"]).toBe(
        `${PROXY_STRICT_CSP_BASE}; frame-ancestors 'self' http://local:7878`,
      );
      expect(closed.headers["x-frame-options"]).toBeUndefined();
    } finally {
      client?.destroy();
      forward.close();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      await closed;
    }
  }, 5000);
});

it("LP1 upstream framing headers pass through verbatim, never replaced by the request's policy", async () => {
  env = await engine({ hubPort: 7878, lanPort: 7879 });
  const framing = { "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" };
  env.up.server.on("request", (req, res) => {
    if (req.url === "/framing") {
      res.setHeader("X-Frame-Options", framing["x-frame-options"]);
      res.setHeader("Content-Security-Policy", framing["content-security-policy"]);
    }
  });
  const opened = await env.open();
  const { cookie } = await env.enter(opened);
  const response = await env.http(opened.origin + "/framing", { headers: { Cookie: cookie } });
  expect(response.status).toBe(200);
  expect({
    "x-frame-options": response.headers["x-frame-options"],
    "content-security-policy": response.headers["content-security-policy"],
  }).toEqual(framing);
});
