import { describe, expect, it } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import { buildContext } from "../../../src/web-hub/hub/http.js";
import type { HostSnapshot } from "../../../src/web-hub/hub/ports.js";

async function withServer(
  handler: Parameters<typeof createServer>[0],
): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = addr !== null && typeof addr === "object" ? addr.port : 0;
  return {
    port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('buildContext(req, "loopback") (plan §1.4.4)', () => {
  it("builds a loopback RequestContext from headers.host / socket.remoteAddress", async () => {
    let captured: ReturnType<typeof buildContext> | undefined;
    const { port, close } = await withServer((req, res) => {
      captured = buildContext(req, "loopback");
      res.end("ok");
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const r = httpRequest({ host: "127.0.0.1", port, path: "/", headers: { Host: `127.0.0.1:${port}` } }, (res) => {
          res.resume();
          res.on("end", resolve);
        });
        r.on("error", reject);
        r.end();
      });
    } finally {
      await close();
    }
    expect(captured).toMatchObject({
      kind: "loopback",
      viaTrustedProxy: false,
      scheme: "http",
      hostKey: `127.0.0.1:${port}`,
      externalOrigin: `http://127.0.0.1:${port}`,
    });
    expect(typeof (captured as { peerIp: string }).peerIp).toBe("string");
    expect((captured as { clientIp: string }).clientIp).toBe((captured as { peerIp: string }).peerIp);
  });

  it("lower-cases the host header into hostKey/externalOrigin", async () => {
    let captured: ReturnType<typeof buildContext> | undefined;
    const { port, close } = await withServer((req, res) => {
      captured = buildContext(req, "loopback");
      res.end("ok");
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const r = httpRequest({ host: "127.0.0.1", port, path: "/", headers: { Host: `LOCALHOST:${port}` } }, (res) => {
          res.resume();
          res.on("end", resolve);
        });
        r.on("error", reject);
        r.end();
      });
    } finally {
      await close();
    }
    expect(captured).toMatchObject({ hostKey: `localhost:${port}`, externalOrigin: `http://localhost:${port}` });
  });
});

// LC review fix (lan-plan.md §15.9 #4, P2): a repeated `X-Forwarded-Host` delivered to `req.headers`
// as the array form `IncomingHttpHeaders` allows (real duplicate wire headers get joined into a
// single comma string by node:http itself before this ever runs, so the array form can only be
// exercised by mutating `req.headers` directly — exactly what a non-node:http transport, or a
// future refactor, could still hand this function).
describe('buildContext(req, "lan") multi-value X-Forwarded-Host (plan §2.4; lan-plan.md §15.9 #4)', () => {
  it("an array-form X-Forwarded-Host (two entries) is rejected 400 E_BAD_REQUEST/proxy-host, not silently collapsed to the last entry", async () => {
    const snapshot: HostSnapshot = {
      gen: 1,
      hostKeys: new Set(),
      externalOrigins: new Set(["https://hub.example.com"]),
      trustProxyFrom: new Set(["127.0.0.1"]),
      omitted: [],
      computedAt: 0,
    };
    let captured: ReturnType<typeof buildContext> | undefined;
    const { port, close } = await withServer((req, res) => {
      req.headers["x-forwarded-host"] = ["legit.example.com", "evil.example.com"];
      captured = buildContext(req, "lan", { snapshot, trust: snapshot.trustProxyFrom });
      res.end("ok");
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const r = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/",
            headers: { Host: `127.0.0.1:${port}`, "X-Forwarded-Proto": "https" },
          },
          (res) => {
            res.resume();
            res.on("end", resolve);
          },
        );
        r.on("error", reject);
        r.end();
      });
    } finally {
      await close();
    }
    expect(captured).toEqual({ reject: 400, code: "E_BAD_REQUEST", detail: "proxy-host" });
  });

  it("a single-element array X-Forwarded-Host still resolves normally (not flagged multi)", async () => {
    const snapshot: HostSnapshot = {
      gen: 1,
      hostKeys: new Set(),
      externalOrigins: new Set(["https://hub.example.com"]),
      trustProxyFrom: new Set(["127.0.0.1"]),
      omitted: [],
      computedAt: 0,
    };
    let captured: ReturnType<typeof buildContext> | undefined;
    const { port, close } = await withServer((req, res) => {
      req.headers["x-forwarded-host"] = ["hub.example.com"];
      captured = buildContext(req, "lan", { snapshot, trust: snapshot.trustProxyFrom });
      res.end("ok");
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const r = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/",
            headers: { Host: `127.0.0.1:${port}`, "X-Forwarded-Proto": "https" },
          },
          (res) => {
            res.resume();
            res.on("end", resolve);
          },
        );
        r.on("error", reject);
        r.end();
      });
    } finally {
      await close();
    }
    expect(captured).toMatchObject({ kind: "lan", externalOrigin: "https://hub.example.com" });
  });
});
