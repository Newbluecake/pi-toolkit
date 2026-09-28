/**
 * Production UI dist integration (vue-plan.md v2.1 §4.2, §5.2 — P5b). Serves the *real*
 * `dist/web-hub-ui/` (produced by `npm run build:web`, not a hand-written fixture) through the
 * real `createHttpFrontend` + `createUiServer` and asserts every static-serving contract holds
 * against production output: placeholder substitution, asset caching, and traversal safety.
 *
 * CI always builds `dist/web-hub-ui/` before running tests (`.github/workflows/ci.yml`'s "Build
 * web UI" step, `PWH_REQUIRE_UI_DIST=1`), so there this test always runs for real. Locally, a
 * missing `dist/web-hub-ui/` (no `npm run build:web` yet) skips instead of failing — unless
 * `PWH_REQUIRE_UI_DIST` is set, matching CI's own env var.
 *
 * `fakeDeps()`'s `home` is always a fresh tmp dir (never the repo root itself) — `createAuth()`
 * writes a real token file under `<home>/state/`, which would otherwise pollute the checkout.
 * `packageUiDistDir()` (the "package" candidate) resolves off `ui-root.ts`'s own `import.meta.url`
 * regardless of `home`, so it always finds this checkout's real `dist/web-hub-ui/` either way.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import type { HttpFrontend } from "../../src/web-hub/hub/ports.js";
import { parseUiBuildInfo } from "../../src/web-hub/protocol/ui-manifest.js";
import { fakeDeps, rawRequest } from "../web-hub/http/helpers.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIST_DIR = join(REPO_ROOT, "dist/web-hub-ui");
const hasDist = existsSync(join(DIST_DIR, "build-info.json"));
const requireDist = process.env["PWH_REQUIRE_UI_DIST"] === "1";

async function withFrontend<T>(fn: (fe: HttpFrontend, port: number) => Promise<T>): Promise<T> {
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
  const home = mkdtempSync(join(tmpdir(), "pwh-ui-dist-"));
  const deps = fakeDeps(home);
  deps.config.pluginVersion = pkg.version;
  const fe = createHttpFrontend(deps);
  try {
    const { port } = await fe.listen();
    return await fn(fe, port);
  } finally {
    await fe.close();
    rmSync(home, { recursive: true, force: true });
  }
}

const runIf = hasDist || requireDist ? describe : describe.skip;

runIf("production dist/web-hub-ui/ served through createHttpFrontend (vue-plan.md v2.1 §4.2)", () => {
  it("dist/web-hub-ui/build-info.json exists and parses (guard for the rest of this file)", async () => {
    if (!hasDist) throw new Error(`${DIST_DIR}/build-info.json missing — run "npm run build:web" first`);
    const raw = JSON.parse(await readFile(join(DIST_DIR, "build-info.json"), "utf8"));
    const parsed = parseUiBuildInfo(raw);
    expect(parsed.ok).toBe(true);
  });

  it("GET / is 200, CSP header present, __AUTH_MODE__ substituted, and ui.status() reports 'ok'", async () => {
    await withFrontend(async (fe, port) => {
      const res = await rawRequest(port, { path: "/" });
      expect(res.status).toBe(200);
      expect(res.headers["content-security-policy"]).toMatch(/default-src 'self'/);
      expect(res.body).toContain('data-auth-mode="token"');
      expect(res.body).not.toContain("__AUTH_MODE__");
      const status = fe.ui.status();
      // a version mismatch between this checkout's package.json and the already-built dist would
      // make this an "unbuilt" 200 placeholder instead — this assertion pins that down explicitly
      // rather than letting a passing GET / mask it.
      expect(status.state, JSON.stringify(status)).toBe("ok");
    });
  });

  it("every /assets/* file referenced by index.html is 200 with the immutable cache header", async () => {
    await withFrontend(async (_fe, port) => {
      const indexRes = await rawRequest(port, { path: "/" });
      const assetPaths = [...indexRes.body.matchAll(/\/assets\/[A-Za-z0-9._-]+\.(?:js|css|svg)/g)].map((m) => m[0]);
      expect(assetPaths.length).toBeGreaterThan(0);
      for (const path of assetPaths) {
        const res = await rawRequest(port, { path });
        expect(res.status, path).toBe(200);
        expect(res.headers["cache-control"], path).toBe("public, max-age=31536000, immutable");
      }
    });
  });

  it("/theme-init.js is no-cache (bootstrap script, not content-hashed)", async () => {
    await withFrontend(async (_fe, port) => {
      const res = await rawRequest(port, { path: "/theme-init.js" });
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-cache");
    });
  });

  it("traversal-shaped paths against the real dist never fall back to a filesystem read — 404", async () => {
    await withFrontend(async (_fe, port) => {
      for (const path of ["/assets/../../package.json", "/assets/..%2f..%2fpackage.json", "/../package.json"]) {
        const res = await rawRequest(port, { path });
        expect(res.status, path).toBe(404);
      }
    });
  });
});

describe.skipIf(hasDist || requireDist)("production dist/web-hub-ui/ (skipped: not built locally)", () => {
  it("run `npm run build:web` to exercise this file's coverage", () => {
    expect(true).toBe(true);
  });
});
