import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import type { HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { safeRelativePath, serveStatic, webRoot } from "../../../src/web-hub/hub/static.js";
import { fakeDeps, makeTmp, rawRequest } from "./helpers.js";

let tmp: ReturnType<typeof makeTmp>;
let root: string;
let server: Server;
let port: number;

beforeEach(async () => {
  tmp = makeTmp("pwh-static-");
  root = join(tmp.dir, "web");
  mkdirSync(join(root, "render"), { recursive: true });
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><title>hub</title>");
  writeFileSync(join(root, "app.js"), "export const app = 1;");
  writeFileSync(join(root, "style.css"), "body{}");
  writeFileSync(join(root, "render", "agents.js"), "export const agents = 1;");
  writeFileSync(join(root, "assets", "logo.svg"), "<svg/>");
  writeFileSync(join(root, "secret.txt"), "nope");
  writeFileSync(join(root, "data.json"), "{}");
  writeFileSync(join(root, ".hidden.js"), "hidden");
  writeFileSync(join(tmp.dir, "outside.js"), "outside");
  writeFileSync(join(tmp.dir, "package.json"), "{}");
  symlinkSync(join(tmp.dir, "outside.js"), join(root, "escape.js"));
  server = createServer((req, res) => {
    void serveStatic(root, req.url ?? "/", res).then((ok) => {
      if (!ok) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  tmp.cleanup();
});

const get = (path: string) => rawRequest(port, { path });

describe("serveStatic", () => {
  it("serves / as index.html and whitelisted assets with content types", async () => {
    const idx = await get("/");
    expect(idx.status).toBe(200);
    expect(idx.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(idx.body).toContain("<title>hub</title>");
    const cases: Array<[string, string]> = [
      ["/assets/app.js", "text/javascript; charset=utf-8"],
      ["/app.js", "text/javascript; charset=utf-8"],
      ["/assets/render/agents.js", "text/javascript; charset=utf-8"],
      ["/render/agents.js", "text/javascript; charset=utf-8"],
      ["/assets/style.css", "text/css; charset=utf-8"],
      ["/assets/logo.svg", "image/svg+xml"],
      ["/index.html", "text/html; charset=utf-8"],
    ];
    for (const [path, ct] of cases) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers["content-type"], path).toBe(ct);
    }
  });

  it("rejects traversal, encoded traversal, NUL and backslash ⇒ 404", async () => {
    const bad = [
      "/assets/../../package.json",
      "/assets/../outside.js",
      "/../outside.js",
      "/assets/%2e%2e/outside.js",
      "/assets/%2e%2e%2f%2e%2e%2fpackage.json",
      "/assets/..%2f..%2fpackage.json",
      "/assets/..%2foutside.js",
      "/%2e%2e/outside.js",
      "/assets/app.js%00",
      "/assets/app%00.js",
      "/assets/..%5coutside.js",
      "/assets\\app.js",
      "/assets/%5capp.js",
      "//outside.js",
      "/assets/%E0%A4%A.js", // malformed percent-encoding
    ];
    for (const path of bad) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.body, path).not.toContain("outside");
    }
  });

  it("rejects non-whitelisted extensions, dotfiles, directories and symlink escapes ⇒ 404", async () => {
    for (const path of [
      "/assets/secret.txt",
      "/secret.txt",
      "/data.json",
      "/assets/.hidden.js",
      "/render",
      "/render/",
      "/assets/",
      "/escape.js",
      "/assets/escape.js",
      "/missing.js",
    ]) {
      expect((await get(path)).status, path).toBe(404);
    }
  });

  it("safeRelativePath unit cases", () => {
    expect(safeRelativePath("/")).toBe("index.html");
    expect(safeRelativePath("/assets/app.js?v=1")).toBe("assets/app.js");
    expect(safeRelativePath("/a/../b.js")).toBeUndefined();
    expect(safeRelativePath("/%2e%2e/b.js")).toBeUndefined();
    expect(safeRelativePath("/b.JS")).toBe("b.JS");
    expect(safeRelativePath("relative.js")).toBeUndefined();
  });

  it("webRoot points at src/web-hub/web/", () => {
    expect(webRoot().replace(/\\/g, "/")).toMatch(/\/src\/web-hub\/web\/$/);
  });
});

describe("static through the frontend", () => {
  let fe: HttpFrontend | undefined;
  afterEach(async () => {
    await fe?.close();
    fe = undefined;
  });

  it("traversal against the real web root is 404 without auth", async () => {
    const deps = fakeDeps(tmp.dir);
    fe = createHttpFrontend(deps);
    const p = (await fe.listen()).port;
    for (const path of ["/assets/../../package.json", "/assets/..%2f..%2fpackage.json", "/assets/%2e%2e/%2e%2e/x.js"]) {
      const res = await rawRequest(p, { path });
      expect(res.status, path).toBe(404);
      expect(res.headers["x-frame-options"]).toBe("DENY");
    }
  });
});
