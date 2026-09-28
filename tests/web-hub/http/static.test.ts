/**
 * hub UI serving (vue-plan.md v2.1 §2.1/§2.4, §5.2 — P5b). Replaces the pre-P5b `serveStatic`/
 * `serveIndex`/`webRoot` unit tests with coverage of `createUiServer`'s tightened URL mapping,
 * cache headers, and the unbuilt-page fallback — through the real filesystem (mirrors
 * `tests/web-hub/hub/ui-root.test.ts`'s fixture-building style; `verifyUiRoot`/
 * `createUiRootService` themselves stay P5a's own test file).
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import type { HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { createUiServer, uiRelPath, type UiServer } from "../../../src/web-hub/hub/static.js";
import type { UiCandidatePlan } from "../../../src/web-hub/hub/ui-root.js";
import { fakeDeps, makeTmp, rawRequest } from "./helpers.js";

const HUB_VERSION = "1.2.3";
const DEFAULT_INDEX = '<!doctype html><html data-auth-mode="__AUTH_MODE__"><body>hub</body></html>';
const DEFAULT_ASSET = "console.log('asset')";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** A tmp dir whose *parent* is trustworthy (owned by us, not group/other-writable) — `/tmp`
 * itself is 1777 and would fail `verifyUiRoot`'s parent-trust check for unrelated reasons. */
function rootDir(): { root: string; cleanup: () => void } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pwh-uiserver-")));
  const parent = join(base, "dist");
  mkdirSync(parent, { mode: 0o755 });
  const root = join(parent, "web-hub-ui");
  return { root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

interface FixtureFile {
  readonly path: string;
  readonly content: string;
}

function writeValidRoot(
  dir: string,
  opts?: { readonly version?: string; readonly files?: readonly FixtureFile[] },
): void {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  mkdirSync(join(dir, "assets"), { recursive: true, mode: 0o755 });
  const files: FixtureFile[] = opts?.files ?? [
    { path: "index.html", content: DEFAULT_INDEX },
    { path: "assets/index-abcd1234.js", content: DEFAULT_ASSET },
    { path: "theme-init.js", content: "try{}catch{}" },
  ];
  const manifestEntries = files.map((f) => {
    writeFileSync(join(dir, f.path), f.content, { mode: 0o644 });
    return { path: f.path, bytes: Buffer.byteLength(f.content), sha256: sha256(Buffer.from(f.content)) };
  });
  const info = {
    v: 1,
    version: opts?.version ?? HUB_VERSION,
    proto: { major: 1 },
    builtAt: "2026-01-01T00:00:00.000Z",
    commit: "abcdefabcdef",
    files: manifestEntries,
  };
  writeFileSync(join(dir, "build-info.json"), JSON.stringify(info), { mode: 0o644 });
}

function onlyCandidate(dir: string): UiCandidatePlan[] {
  return [{ ok: true, spec: { kind: "package", dir } }];
}

describe("uiRelPath", () => {
  it("/, /index.html, and plain asset paths decode to a manifest-relative lookup key", () => {
    expect(uiRelPath("/")).toBe("index.html");
    expect(uiRelPath("/index.html")).toBe("index.html");
    expect(uiRelPath("/assets/index-abcd1234.js?v=1")).toBe("assets/index-abcd1234.js");
    expect(uiRelPath("/theme-init.js")).toBe("theme-init.js");
  });

  it("rejects traversal, NUL, backslash and malformed percent-encoding", () => {
    for (const bad of [
      "/assets/../../package.json",
      "/assets/..%2f..%2fpackage.json",
      "/assets/%2e%2e/%2e%2e/x.js",
      "/assets/app.js%00",
      "/assets\\app.js",
      "/%E0%A4%A.js",
    ]) {
      expect(uiRelPath(bad), bad).toBeUndefined();
    }
  });
});

describe("createUiServer: unbuilt (no valid candidate)", () => {
  it("serves the unbuilt page at / with 200, X-PWH-UI: unbuilt, no-store — never a 404 fallback", async () => {
    const { root, cleanup } = rootDir(); // never written — package candidate stays "missing"
    try {
      const ui = createUiServer({ candidates: onlyCandidate(root), hubVersion: HUB_VERSION, log: noopLog() });
      await withResponse(async (res) => {
        const served = await ui.serve("/", res, { authMode: "token" });
        expect(served).toBe(true);
      });
      const status = ui.status();
      expect(status.state).toBe("unbuilt");
    } finally {
      cleanup();
    }
  });

  it("everything except / and /index.html 404s while unbuilt (no filesystem fallback)", async () => {
    const { root, cleanup } = rootDir();
    try {
      const ui = createUiServer({ candidates: onlyCandidate(root), hubVersion: HUB_VERSION, log: noopLog() });
      for (const path of ["/assets/index-abcd1234.js", "/theme-init.js", "/favicon.svg"]) {
        const served = await withResponse(async (res) => ui.serve(path, res, { authMode: "token" }));
        expect(served, path).toBe(false);
      }
    } finally {
      cleanup();
    }
  });

  it("token mode shows the package directory and per-candidate reasons; password mode shows neither", async () => {
    const { root, cleanup } = rootDir();
    try {
      const ui = createUiServer({ candidates: onlyCandidate(root), hubVersion: HUB_VERSION, log: noopLog() });
      const tokenBody = await bodyOf(async (res) => ui.serve("/", res, { authMode: "token" }));
      const pwBody = await bodyOf(async (res) => ui.serve("/", res, { authMode: "password" }));
      expect(tokenBody).toContain(root);
      expect(tokenBody).toContain("missing");
      expect(pwBody).not.toContain(root);
      expect(pwBody).not.toContain("missing");
    } finally {
      cleanup();
    }
  });

  it("token mode's cd command targets the real package root (two levels above the dist candidate), never a placeholder; password mode carries no absolute path at all", async () => {
    const { root, cleanup } = rootDir(); // never written — package candidate stays "missing"
    try {
      const ui = createUiServer({ candidates: onlyCandidate(root), hubVersion: HUB_VERSION, log: noopLog() });
      const pkgRoot = dirname(dirname(root)); // root === "<pkgRoot>/dist/web-hub-ui"
      const tokenBody = await bodyOf(async (res) => ui.serve("/", res, { authMode: "token" }));
      const pwBody = await bodyOf(async (res) => ui.serve("/", res, { authMode: "password" }));
      expect(tokenBody).toContain(`cd ${pkgRoot} &amp;&amp; npm install`);
      expect(tokenBody).toContain("npm run build:web");
      // never absolute (tmp-rooted) paths anywhere in the password-mode page
      expect(pwBody).not.toContain(tmpdir());
      expect(pwBody).not.toContain(pkgRoot);
      expect(pwBody).not.toContain(root);
    } finally {
      cleanup();
    }
  });

  it("Accept-Language: zh* renders the Chinese copy, anything else falls back to English", async () => {
    const { root, cleanup } = rootDir();
    try {
      const ui = createUiServer({ candidates: onlyCandidate(root), hubVersion: HUB_VERSION, log: noopLog() });
      const zh = await bodyOf(async (res) => ui.serve("/", res, { authMode: "token", acceptLanguage: "zh-CN,en" }));
      const en = await bodyOf(async (res) => ui.serve("/", res, { authMode: "token", acceptLanguage: "en-US" }));
      expect(zh).toContain("尚未构建");
      expect(en).toContain("not built yet");
    } finally {
      cleanup();
    }
  });
});

describe("createUiServer: a verified root", () => {
  let root: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ root, cleanup } = rootDir());
    writeValidRoot(root);
  });
  afterEach(() => cleanup());

  it("serves / and /index.html with the authMode placeholder substituted, no-cache", async () => {
    const ui = createUiServer({ candidates: onlyCandidate(root), hubVersion: HUB_VERSION, log: noopLog() });
    for (const path of ["/", "/index.html"]) {
      const { body, headers } = await responseOf(async (res) => ui.serve(path, res, { authMode: "password" }));
      expect(body).toContain('data-auth-mode="password"');
      expect(body).not.toContain("__AUTH_MODE__");
      expect(headers["cache-control"]).toBe("no-cache");
    }
  });

  it("token mode substitutes token, password mode substitutes password — same cached bytes, no disk re-read", async () => {
    const ui = createUiServer({ candidates: onlyCandidate(root), hubVersion: HUB_VERSION, log: noopLog() });
    const token = await responseOf(async (res) => ui.serve("/", res, { authMode: "token" }));
    const pw = await responseOf(async (res) => ui.serve("/", res, { authMode: "password" }));
    expect(token.body).toContain('data-auth-mode="token"');
    expect(pw.body).toContain('data-auth-mode="password"');
  });

  it("hashed assets get the immutable cache header; theme-init.js / favicon.svg / index.html get no-cache", async () => {
    const ui = createUiServer({ candidates: onlyCandidate(root), hubVersion: HUB_VERSION, log: noopLog() });
    const asset = await responseOf(async (res) => ui.serve("/assets/index-abcd1234.js", res, { authMode: "token" }));
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    const theme = await responseOf(async (res) => ui.serve("/theme-init.js", res, { authMode: "token" }));
    expect(theme.headers["cache-control"]).toBe("no-cache");
  });

  it("a path not in the manifest 404s — no /assets/<p> \u2192 <root>/<p> fallback, no arbitrary top-level .js", async () => {
    for (const path of ["/assets/not-in-manifest.js", "/render/agents.js", "/app.js", "/style.css"]) {
      const ui = createUiServer({ candidates: onlyCandidate(root), hubVersion: HUB_VERSION, log: noopLog() });
      const served = await withResponse(async (res) => ui.serve(path, res, { authMode: "token" }));
      expect(served, path).toBe(false);
    }
  });

  it("refresh() and status() report state:'ok' with the manifest's source/version/commit", async () => {
    const ui = createUiServer({ candidates: onlyCandidate(root), hubVersion: HUB_VERSION, log: noopLog() });
    const status = await ui.refresh();
    expect(status).toMatchObject({ state: "ok", source: "package", version: HUB_VERSION, commit: "abcdefabcdef" });
    expect(ui.status()).toEqual(status);
  });

  it("version/proto mismatch against a different hubVersion falls back to unbuilt", async () => {
    const ui = createUiServer({ candidates: onlyCandidate(root), hubVersion: "9.9.9", log: noopLog() });
    const status = await ui.refresh();
    expect(status.state).toBe("unbuilt");
  });

  it("a same-commit rebuild (builtAt-only change) still fires onStatus \u2014 hub.json's ui field must not go stale (P5b \u6253\u56de\u70b9 3)", async () => {
    const statuses: unknown[] = [];
    const ui = createUiServer({
      candidates: onlyCandidate(root),
      hubVersion: HUB_VERSION,
      log: noopLog(),
      onStatus: (s) => statuses.push(s),
    });
    const first = await ui.refresh();
    expect(first).toMatchObject({ state: "ok", builtAt: "2026-01-01T00:00:00.000Z" });
    expect(statuses.length).toBe(1);

    // Rebuild in place: same version/commit/files, only builtAt changes \u2014 exactly what a
    // `pi update`-free rebuild at the same commit produces.
    const infoPath = join(root, "build-info.json");
    const info = JSON.parse(readFileSync(infoPath, "utf8")) as { builtAt: string };
    info.builtAt = "2026-02-02T00:00:00.000Z";
    writeFileSync(infoPath, JSON.stringify(info), { mode: 0o644 });

    const second = await ui.refresh();
    expect(second).toMatchObject({ state: "ok", commit: "abcdefabcdef", builtAt: "2026-02-02T00:00:00.000Z" });
    expect(statuses.length).toBe(2); // onStatus must fire again so hub.json's ui field is rewritten
    expect(statuses[1]).toMatchObject({ builtAt: "2026-02-02T00:00:00.000Z" });
  });
});

describe("static serving through the frontend (createHttpFrontend's default UI server)", () => {
  let fe: HttpFrontend | undefined;
  let tmp: ReturnType<typeof makeTmp>;
  afterEach(async () => {
    await fe?.close();
    fe = undefined;
    tmp?.cleanup();
  });

  it("unbuilt (no real dist/web-hub-ui in this fake home) still answers 200 at / — never a 404 fallback", async () => {
    tmp = makeTmp("pwh-static-fe-");
    const deps = fakeDeps(tmp.dir);
    fe = createHttpFrontend(deps);
    const p = (await fe.listen()).port;
    const res = await rawRequest(p, { path: "/" });
    expect(res.status).toBe(200);
    expect(res.headers["x-pwh-ui"]).toBe("unbuilt");
  });

  it("traversal-shaped paths never fall back to a filesystem read \u2014 always 404", async () => {
    tmp = makeTmp("pwh-static-fe-");
    const deps = fakeDeps(tmp.dir);
    fe = createHttpFrontend(deps);
    const p = (await fe.listen()).port;
    for (const path of ["/assets/../../package.json", "/assets/..%2f..%2fpackage.json", "/assets/%2e%2e/%2e%2e/x.js"]) {
      const res = await rawRequest(p, { path });
      expect(res.status, path).toBe(404);
      expect(res.headers["x-frame-options"]).toBe("DENY");
    }
  });

  it("a real, injected UiServer (deps.ui) is what the loopback listener actually serves through", async () => {
    tmp = makeTmp("pwh-static-fe-inject-");
    const { root, cleanup } = rootDir();
    writeValidRoot(root, { version: "0.0.0-test" }); // matches fakeDeps' config.pluginVersion
    try {
      const injected: UiServer = createUiServer({
        candidates: onlyCandidate(root),
        hubVersion: "0.0.0-test",
        log: noopLog(),
      });
      const deps = fakeDeps(tmp.dir);
      fe = createHttpFrontend({ ...deps, ui: injected });
      expect(fe.ui).toBe(injected);
      const p = (await fe.listen()).port;
      const res = await rawRequest(p, { path: "/" });
      expect(res.status).toBe(200);
      expect(res.body).toContain('data-auth-mode="token"');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// tiny local test helpers (no shared fixture module \u2014 mirrors ui-root.test.ts's own style)
// ---------------------------------------------------------------------------

function noopLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

async function withResponse(fn: (res: import("node:http").ServerResponse) => Promise<unknown>): Promise<boolean> {
  let served = false;
  const server: Server = createServer((_req, res) => {
    void fn(res).then((r) => {
      served = r === true;
      if (!res.headersSent) res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = addr !== null && typeof addr === "object" ? addr.port : 0;
  await rawGet(port);
  await new Promise<void>((r) => server.close(() => r()));
  return served;
}

async function bodyOf(fn: (res: import("node:http").ServerResponse) => Promise<unknown>): Promise<string> {
  const { body } = await responseOf(fn);
  return body;
}

async function responseOf(
  fn: (res: import("node:http").ServerResponse) => Promise<unknown>,
): Promise<{ body: string; headers: Record<string, string | string[] | undefined> }> {
  let out: { body: string; headers: Record<string, string | string[] | undefined> } = { body: "", headers: {} };
  const server: Server = createServer((_req, res) => {
    void fn(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = addr !== null && typeof addr === "object" ? addr.port : 0;
  out = await rawGet(port);
  await new Promise<void>((r) => server.close(() => r()));
  return out;
}

function rawGet(port: number): Promise<{ body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}
