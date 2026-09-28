/**
 * `createUiServer`'s `authMode` substitution through the LAN listener's own auth mode
 * (vue-plan.md v2.1 §2.1/§2.4, §7 — P5b). Pre-P5b this pinned `serveIndex`/`serveStatic`
 * directly; those functions are gone (replaced by `createUiServer`, see `static.test.ts` for the
 * unit-level coverage of substitution/caching/cache-headers) — this file now only proves the
 * mechanics through a real `createUiServer` instance, independent of any HTTP server.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUiServer } from "../../../src/web-hub/hub/static.js";
import type { UiCandidatePlan } from "../../../src/web-hub/hub/ui-root.js";

let base: string;
afterEach(() => {
  if (base !== undefined) rmSync(base, { recursive: true, force: true });
});

function rootDir(): string {
  base = realpathSync(mkdtempSync(join(tmpdir(), "pwh-lan-static-")));
  const parent = join(base, "dist");
  mkdirSync(parent, { mode: 0o755 });
  return join(parent, "web-hub-ui");
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function writeRoot(dir: string, indexHtml: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const info = {
    v: 1,
    version: "1.2.3",
    proto: { major: 1 },
    builtAt: "t1",
    commit: "abcdefabcdef",
    files: [{ path: "index.html", bytes: Buffer.byteLength(indexHtml), sha256: sha256(Buffer.from(indexHtml)) }],
  };
  writeFileSync(join(dir, "index.html"), indexHtml, { mode: 0o644 });
  writeFileSync(join(dir, "build-info.json"), JSON.stringify(info), { mode: 0o644 });
}

function candidates(dir: string): UiCandidatePlan[] {
  return [{ ok: true, spec: { kind: "package", dir } }];
}

async function withResponse<T>(
  fn: (res: import("node:http").ServerResponse) => Promise<T>,
): Promise<{ status: number; body: string }> {
  const server: Server = createServer((_req, res) => {
    void fn(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = addr !== null && typeof addr === "object" ? addr.port : 0;
  const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
  await new Promise<void>((r) => server.close(() => r()));
  return result;
}

describe("createUiServer authMode substitution (plan §2.1/§2.4)", () => {
  it("replaces the single data-auth-mode placeholder with the literal mode (password)", async () => {
    const dir = rootDir();
    writeRoot(dir, '<!doctype html><html data-auth-mode="__AUTH_MODE__"><body></body></html>');
    const ui = createUiServer({
      candidates: candidates(dir),
      hubVersion: "1.2.3",
      log: { info() {}, warn() {}, error() {} },
    });
    const { status, body } = await withResponse((res) => ui.serve("/", res, { authMode: "password" }));
    expect(status).toBe(200);
    expect(body).toContain('data-auth-mode="password"');
    expect(body).not.toContain("__AUTH_MODE__");
  });

  it("token mode substitutes the same placeholder with 'token'", async () => {
    const dir = rootDir();
    writeRoot(dir, '<html data-auth-mode="__AUTH_MODE__"></html>');
    const ui = createUiServer({
      candidates: candidates(dir),
      hubVersion: "1.2.3",
      log: { info() {}, warn() {}, error() {} },
    });
    const { body } = await withResponse((res) => ui.serve("/", res, { authMode: "token" }));
    expect(body).toContain('data-auth-mode="token"');
  });

  it("a template without the placeholder is served byte-unchanged (no error, no partial match)", async () => {
    const original = "<!doctype html><title>hub</title>";
    const dir = rootDir();
    writeRoot(dir, original);
    const ui = createUiServer({
      candidates: candidates(dir),
      hubVersion: "1.2.3",
      log: { info() {}, warn() {}, error() {} },
    });
    const { body } = await withResponse((res) => ui.serve("/", res, { authMode: "password" }));
    expect(body).toBe(original);
  });

  it("Content-Length reflects the post-substitution byte length", async () => {
    const dir = rootDir();
    writeRoot(dir, '<html data-auth-mode="__AUTH_MODE__"></html>');
    const ui = createUiServer({
      candidates: candidates(dir),
      hubVersion: "1.2.3",
      log: { info() {}, warn() {}, error() {} },
    });
    const server: Server = createServer((_req, res) => {
      void ui.serve("/", res, { authMode: "password" });
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
