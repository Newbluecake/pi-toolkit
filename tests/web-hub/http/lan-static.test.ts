/**
 * `serveIndex`/`serveStatic`'s `authMode` substitution (plan §1.4.5, §7 —
 * LC's `hub/static.ts` addition). Uses a temp static root, not the real
 * `src/web-hub/web/` tree (LF, S1-W2, has not injected the
 * `data-auth-mode="__AUTH_MODE__"` placeholder into the shipped
 * `index.html` yet — this pins the substitution mechanics on their own).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serveIndex, serveStatic } from "../../../src/web-hub/hub/static.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pwh-static-authmode-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function withResponse<T>(
  fn: (res: import("node:http").ServerResponse) => Promise<T> | T,
): Promise<{ status: number; body: string; result: T }> {
  let result!: T;
  const server: Server = createServer((_req, res) => {
    void (async () => {
      result = await fn(res);
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = addr !== null && typeof addr === "object" ? addr.port : 0;
  const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
  await new Promise<void>((r) => server.close(() => r()));
  return { status, body, result };
}

describe("serveIndex (plan §1.4.5)", () => {
  it("replaces the single data-auth-mode placeholder with the literal mode", async () => {
    writeFileSync(join(dir, "index.html"), '<!doctype html><html data-auth-mode="__AUTH_MODE__"><body></body></html>');
    const { status, body } = await withResponse((res) => serveIndex(dir, res, "password"));
    expect(status).toBe(200);
    expect(body).toContain('data-auth-mode="password"');
    expect(body).not.toContain("__AUTH_MODE__");
  });

  it("token mode substitutes the same placeholder with 'token'", async () => {
    writeFileSync(join(dir, "index.html"), '<html data-auth-mode="__AUTH_MODE__"></html>');
    const { body } = await withResponse((res) => serveIndex(dir, res, "token"));
    expect(body).toContain('data-auth-mode="token"');
  });

  it("a template without the placeholder is served byte-unchanged (no error, no partial match)", async () => {
    const original = "<!doctype html><title>hub</title>";
    writeFileSync(join(dir, "index.html"), original);
    const { body } = await withResponse((res) => serveIndex(dir, res, "password"));
    expect(body).toBe(original);
  });

  it("serveStatic('/', ...) with opts.authMode routes through serveIndex", async () => {
    writeFileSync(join(dir, "index.html"), '<html data-auth-mode="__AUTH_MODE__"></html>');
    const { body } = await withResponse((res) => serveStatic(dir, "/", res, { authMode: "password" }));
    expect(body).toContain('data-auth-mode="password"');
  });

  it("serveStatic('/', ...) without opts (P1 call shape) does not substitute anything", async () => {
    writeFileSync(join(dir, "index.html"), '<html data-auth-mode="__AUTH_MODE__"></html>');
    const { body } = await withResponse((res) => serveStatic(dir, "/", res));
    expect(body).toContain("__AUTH_MODE__");
  });

  it("Content-Length reflects the post-substitution byte length", async () => {
    writeFileSync(join(dir, "index.html"), '<html data-auth-mode="__AUTH_MODE__"></html>');
    const server: Server = createServer((_req, res) => {
      void serveIndex(dir, res, "password");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = addr !== null && typeof addr === "object" ? addr.port : 0;
    const headers = await new Promise<Record<string, string | string[] | undefined>>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/" }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.headers));
      });
      req.on("error", reject);
      req.end();
    });
    await new Promise<void>((r) => server.close(() => r()));
    const expectedBody = '<html data-auth-mode="password"></html>';
    expect(headers["content-length"]).toBe(String(Buffer.byteLength(expectedBody)));
  });
});
