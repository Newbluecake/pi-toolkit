import { EventEmitter } from "node:events";
import { request as httpRequest, createServer, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { AVATAR_MAX_BYTES, AVATAR_PATH } from "../../../../src/web-hub/protocol/avatar.js";
import { createAvatarRoutes } from "../../../../src/web-hub/hub/avatar/routes.js";
import type { AvatarStore } from "../../../../src/web-hub/hub/avatar/store.js";

class Req extends EventEmitter {
  method = "POST";
  headers: Record<string, string> = {
    "x-pwh": "1",
    origin: "http://127.0.0.1:1",
    "content-type": "application/octet-stream",
  };
  destroyed = false;
  destroy(): void {
    this.destroyed = true;
  }
  resume(): void {}
}
class Res extends EventEmitter {
  headers: Record<string, string> = {};
  writableFinished = false;
  setHeader(k: string, v: string): void {
    this.headers[k] = v;
  }
  writeHead(): void {}
  end(): void {
    this.writableFinished = true;
    this.emit("finish");
  }
  destroy(): void {
    this.emit("close");
  }
}
class SlowRes extends Res {
  end(): void {}
}
function store(withAvatar = false): AvatarStore {
  return {
    state: "ready",
    gen: 1,
    disabledReason: undefined,
    load: async () => undefined,
    close: async () => undefined,
    put: async () => ({ info: { gen: 2, v: "a".repeat(64) }, side: 16, bytes: 100 }),
    remove: async () => ({ info: { gen: 2 } }),
    snapshot: () => ({
      state: "ready",
      info: { gen: 1, ...(withAvatar ? { v: "a".repeat(64) } : {}) },
      memory: withAvatar ? { bytes: Buffer.alloc(64 * 1024, 7), v: "a".repeat(64), side: 256 } : undefined,
    }),
  };
}
const io = (sent: Array<{ status: number; body: unknown }>, onAuth?: () => void) => ({
  listener: "loopback" as const,
  ip: "127.0.0.1",
  expectedOrigin: "http://127.0.0.1:1",
  authorize: async () => {
    onAuth?.();
    return { ip: "127.0.0.1" };
  },
  sendJson: (res: Res, status: number, body: unknown) => {
    sent.push({ status, body });
    res.end();
  },
});
const getReq = (): Req => {
  const req = new Req();
  req.method = "GET";
  return req;
};
const hub = () => ({ pid: 1, startedAt: 1 });

function serverIo(res: ServerResponse) {
  return {
    listener: "loopback" as const,
    ip: "127.0.0.1",
    expectedOrigin: "http://127.0.0.1:1",
    authorize: async () => ({ ip: "127.0.0.1" }),
    sendJson: (target: ServerResponse, status: number, body: unknown) => {
      target.writeHead(status, { "content-type": "application/json" });
      target.end(JSON.stringify(body));
    },
  };
}

async function listenRoutes(
  routes: ReturnType<typeof createAvatarRoutes>,
  slowEnd = false,
): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    if (slowEnd) {
      const originalEnd = res.end.bind(res);
      res.end = ((...args: Parameters<ServerResponse["end"]>) => {
        setTimeout(() => originalEnd(...args), 200);
        return res;
      }) as ServerResponse["end"];
    }
    void routes.handle(req, res, AVATAR_PATH, serverIo(res) as never);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return {
    port: address.port,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

describe("avatar routes", () => {
  it("maps readBody 408 to 504 E_DEADLINE and closes the connection", async () => {
    const sent: Array<{ status: number; body: unknown }> = [];
    const routes = createAvatarRoutes({
      store: store(),
      hub,
      log: { info() {}, warn() {}, error() {} },
      readBody: async () => {
        throw Object.assign(new Error(), { status: 408 });
      },
    });
    const req = new Req();
    const res = new Res();
    await routes.handle(req as never, res as never, AVATAR_PATH, io(sent) as never);
    expect(sent).toEqual([{ status: 504, body: { error: "E_DEADLINE", effect: "none" } }]);
    expect(res.headers.Connection).toBe("close");
    res.emit("finish");
    expect(req.destroyed).toBe(true);
  });

  it("rejects an oversized declared body without invoking the body reader", async () => {
    const sent: Array<{ status: number; body: unknown }> = [];
    const routes = createAvatarRoutes({
      store: store(),
      hub,
      log: { info() {}, warn() {}, error() {} },
      readBody: async () => {
        throw new Error("must not read");
      },
    });
    const req = new Req();
    req.headers["content-length"] = String(AVATAR_MAX_BYTES + 1);
    const res = new Res();
    await routes.handle(req as never, res as never, AVATAR_PATH, io(sent) as never);
    expect(sent[0]).toEqual({ status: 413, body: { error: "E_AVATAR_TOO_LARGE", max: AVATAR_MAX_BYTES } });
  });

  it("releases the GET slot once on finish, close, both, and deadline", async () => {
    for (const mode of ["finish", "close", "both", "deadline"] as const) {
      const records: Array<{ msg: string; data?: object }> = [];
      const routes = createAvatarRoutes({
        store: store(true),
        hub,
        getSendMs: 15,
        log: { info: (msg, data) => records.push({ msg, data }), warn() {}, error() {} },
      });
      const sent: Array<{ status: number; body: unknown }> = [];
      const req = getReq();
      const res = mode === "deadline" || mode === "close" ? new SlowRes() : new Res();
      const pending = routes.handle(req as never, res as never, AVATAR_PATH, io(sent) as never);
      await new Promise((resolve) => setImmediate(resolve));
      if (mode === "close") res.emit("close");
      if (mode === "both") res.emit("close");
      await pending;
      if (mode === "deadline") await new Promise((resolve) => setTimeout(resolve, 25));
      expect(records.filter((r) => r.msg === "avatar")).toHaveLength(1);
      const data = records[0]?.data as { ok?: boolean; io?: string } | undefined;
      if (mode === "deadline") expect(data).toMatchObject({ ok: false, io: "deadline" });
      if (mode === "close") expect(data).toMatchObject({ ok: false, io: "abort" });
    }
  });

  it("rejects the ninth simultaneous GET while eight stalled responses hold slots", async () => {
    const records: Array<{ msg: string; data?: object }> = [];
    const routes = createAvatarRoutes({
      store: store(true),
      hub,
      getSendMs: 500,
      log: { info: (msg, data) => records.push({ msg, data }), warn() {}, error() {} },
    });
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 8; i += 1)
      pending.push(routes.handle(getReq() as never, new SlowRes() as never, AVATAR_PATH, io([]) as never));
    await Promise.all(pending);
    const ninth: Array<{ status: number; body: unknown }> = [];
    await routes.handle(getReq() as never, new Res() as never, AVATAR_PATH, io(ninth) as never);
    expect(ninth[0]).toEqual({ status: 503, body: { error: "E_BUSY", reason: "inflight" } });
  });

  it("disposes within the caller deadline", async () => {
    const base = store();
    const stubborn: AvatarStore = {
      ...base,
      close: async () => {
        await new Promise(() => undefined);
      },
    };
    const routes = createAvatarRoutes({ store: stubborn, hub, log: { info() {}, warn() {}, error() {} } });
    const at = Date.now() + 20;
    const started = Date.now();
    await routes.dispose("close", {
      at,
      remaining: () => Math.max(0, at - Date.now()),
      expired: () => Date.now() >= at,
    });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("handles a real socket slow transfer and releases the GET slot at the deadline", async () => {
    const records: Array<{ msg: string; data?: object }> = [];
    const routes = createAvatarRoutes({
      store: store(true),
      hub,
      getSendMs: 30,
      log: { info: (msg, data) => records.push({ msg, data }), warn() {}, error() {} },
    });
    const server = await listenRoutes(routes, true);
    const req = httpRequest({ host: "127.0.0.1", port: server.port, path: AVATAR_PATH, headers: { "x-pwh": "1" } });
    req.on("socket", (socket) => socket.pause());
    req.on("error", () => undefined);
    req.end();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(records.some((r) => (r.data as { io?: string } | undefined)?.io === "deadline")).toBe(true);
    req.destroy();
    await server.close();
  });

  it("releases the GET slot immediately when a real socket aborts mid-transfer", async () => {
    const records: Array<{ msg: string; data?: object }> = [];
    const routes = createAvatarRoutes({
      store: store(true),
      hub,
      getSendMs: 500,
      log: { info: (msg, data) => records.push({ msg, data }), warn() {}, error() {} },
    });
    const server = await listenRoutes(routes, true);
    const req = httpRequest({ host: "127.0.0.1", port: server.port, path: AVATAR_PATH, headers: { "x-pwh": "1" } });
    req.on("response", (response) => {
      response.destroy();
    });
    req.on("error", () => undefined);
    req.end();
    setTimeout(() => req.destroy(), 10).unref();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(records.some((r) => (r.data as { io?: string } | undefined)?.io === "abort")).toBe(true);
    await server.close();
  });

  it("maps a real 1 B/s PUT body to 504 and releases the write slot", async () => {
    const routes = createAvatarRoutes({ store: store(), hub, log: { info() {}, warn() {}, error() {} } });
    const server = await listenRoutes(routes);
    const started = Date.now();
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: server.port,
          method: "POST",
          path: AVATAR_PATH,
          headers: {
            "x-pwh": "1",
            origin: "http://127.0.0.1:1",
            "content-type": "application/octet-stream",
            "transfer-encoding": "chunked",
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        },
      );
      req.on("error", reject);
      req.write(Buffer.from([0x89]));
      const timer = setInterval(() => req.write(Buffer.from([0])), 1_000);
      timer.unref();
      req.on("close", () => clearInterval(timer));
    });
    expect(response.status).toBe(504);
    expect(JSON.parse(response.body)).toMatchObject({ error: "E_DEADLINE", effect: "none" });
    expect(Date.now() - started).toBeLessThan(14_000);
    await server.close();
  });
});
