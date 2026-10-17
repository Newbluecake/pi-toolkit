import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import { once } from "node:events";
import { createProxyAdmission } from "../../../../src/web-hub/hub/proxy/forward.js";
import {
  PROXY_QUEUE_WAIT_MS,
  PROXY_HEAD_TIMEOUT_MS,
  PROXY_REQUEST_BODY_MAX_BYTES,
  PROXY_STREAM_HWM_BYTES,
} from "../../../../src/web-hub/protocol/proxy.js";
import { engine, waitFor } from "./engine-helpers.js";
import { manualClock } from "./helpers.js";

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
    expect((await env.http(no.origin, { headers: { Cookie: auth.cookie } })).status).toBe(502);
    const slow = await env.open();
    const { cookie } = await env.enter(slow);
    const response = env.http(slow.origin + "/slow-head", { headers: { Cookie: cookie } });
    await waitFor(() => env.up.held === 1);
    clock.advance(PROXY_HEAD_TIMEOUT_MS);
    expect((await response).status).toBe(504);
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
    const result = new Promise<number>((resolve, reject) => {
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
          res.on("end", () => resolve(res.statusCode!));
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
    expect(await result).toBe(413);
    expect(env.up.requests[0]!.bytes).toBeLessThanOrEqual(PROXY_REQUEST_BODY_MAX_BYTES);
    await waitFor(() => env.up.sockets.size === 0);
  }, 15000);
});
