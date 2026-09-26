import { describe, expect, it } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import { buildContext } from "../../../src/web-hub/hub/http.js";

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
