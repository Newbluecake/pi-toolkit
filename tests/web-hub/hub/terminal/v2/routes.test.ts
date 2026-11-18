import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../../../../../src/web-hub/hub/ports.js";
import type { TerminalRoutesPortV2 } from "../../../../../src/web-hub/hub/terminal-v2-ports.js";
import { createTerminalRoutesV2, dispatchTerminalV2 } from "../../../../../src/web-hub/hub/terminal/v2/routes.js";
import { envelope, fixture, hubInstance, signal } from "./fixture.js";
const ctx: RequestContext = {
  kind: "loopback",
  peerIp: "127.0.0.1",
  clientIp: "127.0.0.1",
  viaTrustedProxy: false,
  scheme: "http",
  hostKey: "localhost:12345",
  externalOrigin: "http://localhost:12345",
};
/** Minimal typed EventEmitter transport double. Integration companion uses real HTTP. */
function transport(op: string, payload: unknown) {
  const request = new EventEmitter();
  Object.assign(request, {
    method: "POST",
    url: `/api/terminal/v2/${op}`,
    headers: { origin: ctx.externalOrigin, "x-pwh": "1", "content-type": "application/json" },
    resume: vi.fn(),
  });
  let ended = false,
    destroyed = false,
    headersSent = false,
    status = 0;
  let headers: unknown;
  const writes: string[] = [];
  const response = new EventEmitter();
  Object.defineProperties(response, {
    destroyed: { get: () => destroyed },
    writableEnded: { get: () => ended },
    headersSent: { get: () => headersSent },
    writableLength: { get: () => 0 },
  });
  Object.assign(response, {
    writeHead: vi.fn((code: number, h: unknown) => {
      status = code;
      headers = h;
      headersSent = true;
    }),
    end: vi.fn((text: string) => {
      writes.push(text);
      ended = true;
    }),
    destroy: vi.fn(() => {
      destroyed = true;
      response.emit("close");
    }),
    flushHeaders: vi.fn(),
    write: vi.fn((text: string, callback: (error?: Error) => void) => {
      writes.push(text);
      queueMicrotask(callback);
      return true;
    }),
  });
  return {
    req: request as IncomingMessage,
    res: response as ServerResponse,
    request,
    response,
    send() {
      request.emit("data", Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)));
      request.emit("end");
    },
    result() {
      return { status, headers, body: writes.join("") };
    },
  };
}
const resources: Array<{ dispose(): void }> = [];
function setup() {
  const f = fixture();
  resources.push(f);
  const routes = createTerminalRoutesV2({
    service: f.service,
    views: f.views,
    auth: f.fence,
    notifications: f.fence,
    hubInstance,
  });
  resources.push({
    dispose: () => {
      void routes.dispose();
    },
  });
  async function call(op: string, payload: unknown) {
    const t = transport(op, payload);
    const handling = routes.handle(t.req, t.res, ctx, f.id, signal());
    t.send();
    await handling;
    return t;
  }
  return { f, routes, call };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  for (const r of resources.splice(0).reverse()) r.dispose();
  vi.useRealTimers();
});
describe("terminal v2 HTTP guards and auth-independent port faults", () => {
  it("strict POST/JSON/Origin/X-PWH/no-store rejects before body or service", async () => {
    const { f, routes } = setup();
    for (const change of [
      { method: "GET" },
      { headers: { origin: "null", "x-pwh": "1", "content-type": "application/json" } },
      { headers: { origin: ctx.externalOrigin, "content-type": "application/json" } },
      { headers: { origin: ctx.externalOrigin, "x-pwh": "1", "content-type": "text/plain" } },
    ]) {
      const t = transport("list", { scope: envelope.scope });
      Object.assign(t.req, change);
      expect(await routes.handle(t.req, t.res, ctx, f.id, signal())).toBe(true);
      expect(t.result()).toMatchObject({ status: 403, headers: { "Cache-Control": "no-store" } });
    }
    expect(f.service.list).not.toHaveBeenCalled();
    expect(f.service.create).not.toHaveBeenCalled();
  });
  it("list has no hub requirement; all remaining operations reject wrong hub before side effects", async () => {
    const { f, call } = setup();
    const list = await call("list", { scope: envelope.scope });
    expect(list.result().status).toBe(200);
    expect(JSON.parse(list.result().body)).toMatchObject({ ok: true, hubInstance });
    const create = await call("create", {
      ...envelope,
      termId: undefined,
      hubInstance: "x".repeat(24),
      requestId: "r".repeat(24),
      mode: "new",
      cols: 80,
      rows: 24,
    });
    expect(create.result().status).toBe(409);
    expect(JSON.parse(create.result().body).code).toBe("E_HUB_CHANGED");
    expect(f.service.create).not.toHaveBeenCalled();
    expect(
      (await call("input", { ...envelope, viewId: "v".repeat(24), seq: 0, queryOnly: true, bytesB64: "YQ==" })).result()
        .status,
    ).toBe(400);
  });
  it("body size/invalid UTF8/JSON shape/deadline are bounded without service calls", async () => {
    const { f, routes, call } = setup();
    expect((await call("list", "not-json")).result().status).toBe(400);
    expect((await call("list", "x".repeat(25_000))).result().status).toBe(400);
    const bad = transport("list", {});
    const handleBad = routes.handle(bad.req, bad.res, ctx, f.id, signal());
    bad.request.emit("data", Buffer.from([0xff]));
    bad.request.emit("end");
    await handleBad;
    expect(bad.result().status).toBe(400);
    const stalled = transport("list", {});
    const pending = routes.handle(stalled.req, stalled.res, ctx, f.id, signal());
    await vi.advanceTimersByTimeAsync(5001);
    await pending;
    expect(stalled.result().status).toBe(504);
    expect(f.service.list).not.toHaveBeenCalled();
    expect(stalled.req.listenerCount("data")).toBe(0);
  });
  it("independent NDJSON is identity/no-store, never depends on public SSE clientId or gzip", async () => {
    const { f, call } = setup();
    const stream = await call("view", envelope);
    await vi.advanceTimersByTimeAsync(10);
    expect(stream.result()).toMatchObject({
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson",
        "Content-Encoding": "identity",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
    const frames = stream
      .result()
      .body.trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(frames.map((frame) => frame.t)).toEqual(["attached", "replay-end", "state"]);
    expect(f.service.create).not.toHaveBeenCalled();
    stream.response.emit("close");
    expect(await f.views.open(f.id, envelope, signal())).toMatchObject({ ok: true });
  });
  it("P6 must capture revision BEFORE original authentication await, not just handle entry", async () => {
    const { f } = setup();
    let complete!: (value: { ok: true; identity: typeof f.id }) => void;
    const authenticate = vi.fn(
      () =>
        new Promise<{ ok: true; identity: typeof f.id }>((resolve) => {
          complete = resolve;
        }),
    );
    const routes: TerminalRoutesPortV2 = { handle: vi.fn(async () => true), dispose: vi.fn(async () => {}) };
    const t = transport("list", {});
    const pending = dispatchTerminalV2({ routes, auth: f.fence, authenticate }, t.req, t.res, ctx, signal());
    expect(authenticate).toHaveBeenCalledOnce();
    const revision = f.fence.invalidate({ sidTag: f.id.sidTag });
    f.fence.settle({ sidTag: f.id.sidTag }, revision, { kind: "no-change-confirmed" });
    complete({ ok: true, identity: f.id });
    await pending;
    expect(t.result().status).toBe(401);
    expect(JSON.parse(t.result().body).code).toBe("E_REVOKING");
    expect(routes.handle).not.toHaveBeenCalled();
  });
  it("A2/A3/A12 revoke→late create/cleanup cannot affect original auth commit/result", async () => {
    const { f, routes } = setup();
    let lateCreate!: (value: Awaited<ReturnType<typeof f.service.create>>) => void;
    vi.mocked(f.service.create).mockImplementation(
      () =>
        new Promise((resolve) => {
          lateCreate = resolve;
        }),
    );
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const order: string[] = [];
    const off = f.fence.subscribe(() => {
      order.push("seal-and-initiate-cleanup");
      void cleanup.then(() => order.push("cleanup-settled"));
    });
    const t = transport("create", {
      ...envelope,
      termId: undefined,
      requestId: "r".repeat(24),
      mode: "new",
      cols: 80,
      rows: 24,
    });
    const create = routes.handle(t.req, t.res, ctx, f.id, signal());
    t.send();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(f.service.create).toHaveBeenCalledOnce();
    const revision = f.fence.invalidate({ sidTag: f.id.sidTag });
    // Simulate only original auth authority's durable point, no terminal promise is awaited.
    const authCommit = vi.fn(async () => {
      order.push("auth-committed");
      return { ok: true };
    });
    expect(await authCommit()).toEqual({ ok: true });
    f.fence.settle({ sidTag: f.id.sidTag }, revision, { kind: "sid-absent", sidTag: f.id.sidTag });
    order.push("auth-responded");
    expect(order).toEqual(["seal-and-initiate-cleanup", "auth-committed", "auth-responded"]);
    await create;
    expect(t.result().status).not.toBe(200);
    const responseBefore = t.result().body;
    lateCreate({ ok: true, requestId: "r".repeat(24), termId: envelope.termId, state: "live" });
    releaseCleanup();
    await cleanup;
    await Promise.resolve();
    expect(t.result().body).toBe(responseBefore);
    expect(authCommit).toHaveBeenCalledOnce();
    expect(f.service.dispose).not.toHaveBeenCalled();
    expect(order.at(-1)).toBe("cleanup-settled");
    off();
  });
  it("A11 original auth E_DB/effect none or unknown retained, timeout never admits work", async () => {
    const { f, routes } = setup();
    for (const effect of ["none", "unknown"] as const) {
      const t = transport("list", {});
      await dispatchTerminalV2(
        { routes, auth: f.fence, authenticate: async () => ({ ok: false, code: "E_DB", effect }) },
        t.req,
        t.res,
        ctx,
        signal(),
      );
      expect(JSON.parse(t.result().body)).toEqual({ ok: false, code: "E_DB", effect });
      expect(t.result().status).toBe(503);
    }
    const t = transport("list", {});
    const pending = dispatchTerminalV2(
      { routes, auth: f.fence, authenticate: () => new Promise(() => {}) },
      t.req,
      t.res,
      ctx,
      signal(),
    );
    await vi.advanceTimersByTimeAsync(5001);
    await pending;
    expect(t.result().status).toBe(504);
    expect(f.service.list).not.toHaveBeenCalled();
  });
  it("A1 port analogue: resource failure does not poison the memory fence; dispose never owns service", async () => {
    const { f, routes, call } = setup();
    vi.mocked(f.service.list).mockResolvedValue({ ok: false, code: "E_RESOURCE_UNAVAILABLE", effect: "none" });
    expect(JSON.parse((await call("list", { scope: envelope.scope })).result().body).code).toBe(
      "E_RESOURCE_UNAVAILABLE",
    );
    const rev = f.fence.invalidate({ sidTag: f.id.sidTag });
    f.fence.settle({ sidTag: f.id.sidTag }, rev, { kind: "sid-absent", sidTag: f.id.sidTag });
    // Resource health cannot latch an auth deny or insert service disposal into this wait.
    f.fence.check(f.id, f.fence.revision);
    vi.mocked(f.service.dispose).mockImplementation(() => new Promise(() => {}));
    await routes.dispose();
    await routes.dispose();
    expect(f.service.dispose).not.toHaveBeenCalled();
    expect(f.service.create).not.toHaveBeenCalled();
  });
});
