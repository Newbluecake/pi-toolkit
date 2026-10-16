/**
 * web-hub-version plan §3.6/§3.9/§3.11 + §R2 (#2/#5/#8): the served-UI identity pipeline
 * (`refreshFor → logStatus/onStatus` + independent `onServed` dedup), `probe()`'s cross-request
 * single-flight, and `GET /api/version` driving it end to end over real HTTP.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import type { HttpFrontend, VersionInfoPort } from "../../src/web-hub/hub/ports.js";
import { createUiServer, PROBE_WAITERS } from "../../src/web-hub/hub/static.js";
import type { UiRootFsDeps, UiStatus } from "../../src/web-hub/hub/ui-root.js";
import { webHubUiDir } from "../../src/web-hub/protocol/paths.js";
import type { HubUiBuildWire } from "../../src/web-hub/protocol/version-info.js";
import { VERSION_INFO_PATH } from "../../src/web-hub/protocol/version-info.js";
import { fakeDeps, login, rawRequest } from "../web-hub/http/helpers.js";

const HUB_VERSION = "0.0.0-test";
const bases: string[] = [];
afterEach(() => {
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

interface RootSpec {
  js: string; // asset file name
  css: string;
  commit?: string;
  builtAt?: string;
}
/** (Re)writes a valid UI root at `dir`; same version/commit/builtAt unless the spec says otherwise. */
function writeRoot(dir: string, spec: RootSpec): void {
  mkdirSync(join(dir, "assets"), { recursive: true, mode: 0o755 });
  const index = `<!doctype html><html data-auth-mode="__AUTH_MODE__"><head><script type="module" src="/assets/${spec.js}"></script><link rel="stylesheet" href="/assets/${spec.css}"></head><body></body></html>`;
  const files = [
    { path: "index.html", content: index },
    { path: `assets/${spec.js}`, content: `console.log(${JSON.stringify(spec.js)})` },
    { path: `assets/${spec.css}`, content: "body{}" },
  ];
  const entries = files.map((f) => {
    writeFileSync(join(dir, f.path), f.content, { mode: 0o644 });
    return { path: f.path, bytes: Buffer.byteLength(f.content), sha256: sha(f.content) };
  });
  writeFileSync(
    join(dir, "build-info.json"),
    JSON.stringify({
      v: 1,
      version: HUB_VERSION,
      proto: { major: 1 },
      builtAt: spec.builtAt ?? "2026-01-01T00:00:00.000Z",
      commit: spec.commit ?? "abcdefabcdef",
      files: entries,
    }),
    { mode: 0o644 },
  );
}

const noLog = { info() {}, warn() {}, error() {}, debug() {}, close() {} } as never;

function bareRoot(): { base: string; dir: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pwh-vui-")));
  bases.push(base);
  const parent = join(base, "dist");
  mkdirSync(parent, { mode: 0o755 });
  return { base, dir: join(parent, "web-hub-ui") };
}

describe("onServed — independent rootGeneration+assets dedup (R2 #2/#5)", () => {
  it("fires once on first resolve, never on an unchanged probe, and exactly once for an assets-only rebuild (commit/builtAt unchanged ⇒ onStatus stays silent)", async () => {
    const { dir } = bareRoot();
    writeRoot(dir, { js: "index-aaaaaaaa.js", css: "style-aaaaaaaa.css" });
    const served: Array<HubUiBuildWire | undefined> = [];
    const statuses: UiStatus[] = [];
    const ui = createUiServer({
      candidates: [{ ok: true, spec: { kind: "package", dir } }],
      hubVersion: HUB_VERSION,
      log: noLog,
      probeThrottleMs: 0,
      onServed: (u) => served.push(u),
      onStatus: (s) => statuses.push(s),
    });
    await ui.refresh();
    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({
      source: "package",
      version: HUB_VERSION,
      commit: "abcdefabcdef",
      builtAt: "2026-01-01T00:00:00.000Z",
      assets: ["/assets/index-aaaaaaaa.js", "/assets/style-aaaaaaaa.css"],
    });
    await ui.probe();
    await ui.probe();
    expect(served).toHaveLength(1); // no change ⇒ zero

    // rebuild: SAME version/commit/builtAt, different content hashes
    await new Promise((r) => setTimeout(r, 15));
    writeRoot(dir, { js: "index-bbbbbbbb.js", css: "style-aaaaaaaa.css" });
    const statusesBefore = statuses.length;
    await ui.probe();
    expect(served).toHaveLength(2);
    expect(served[1]!.assets).toEqual(["/assets/index-bbbbbbbb.js", "/assets/style-aaaaaaaa.css"]);
    expect(statuses.length).toBe(statusesBefore); // statusSignature dedup still swallows it
    await ui.probe();
    expect(served).toHaveLength(2);
  });

  it("a commit change fires BOTH onStatus and onServed once; losing the root fires onServed(undefined)", async () => {
    const { dir } = bareRoot();
    writeRoot(dir, { js: "index-aaaaaaaa.js", css: "style-aaaaaaaa.css" });
    const served: Array<HubUiBuildWire | undefined> = [];
    let statusCount = 0;
    const ui = createUiServer({
      candidates: [{ ok: true, spec: { kind: "package", dir } }],
      hubVersion: HUB_VERSION,
      log: noLog,
      probeThrottleMs: 0,
      onServed: (u) => served.push(u),
      onStatus: () => statusCount++,
    });
    await ui.refresh();
    expect([served.length, statusCount]).toEqual([1, 1]);
    await new Promise((r) => setTimeout(r, 15));
    writeRoot(dir, { js: "index-aaaaaaaa.js", css: "style-aaaaaaaa.css", commit: "123456123456" });
    await ui.probe();
    expect([served.length, statusCount]).toEqual([2, 2]);
    expect(served[1]!.commit).toBe("123456123456");
    rmSync(join(dir, "build-info.json"));
    await ui.probe();
    expect(served[2]).toBeUndefined();
    expect(served).toHaveLength(3);
  });

  it("assets are limited to /assets/* references that exist in the verified manifest (≤4, sorted)", async () => {
    const { dir } = bareRoot();
    writeRoot(dir, { js: "index-aaaaaaaa.js", css: "style-aaaaaaaa.css" });
    let seen: HubUiBuildWire | undefined;
    const ui = createUiServer({
      candidates: [{ ok: true, spec: { kind: "package", dir } }],
      hubVersion: HUB_VERSION,
      log: noLog,
      onServed: (u) => (seen = u),
    });
    await ui.refresh();
    expect(seen!.assets.every((a) => a.startsWith("/assets/"))).toBe(true);
    expect(JSON.stringify(seen)).not.toContain(dir);
  });
});

describe("probe() cross-request single-flight (R2 #8)", () => {
  it("a hanging underlying IO does not stack: repeated probes share one lstat/resolve and waiters >8 get E_BUSY until it settles", async () => {
    const { dir } = bareRoot();
    writeRoot(dir, { js: "index-aaaaaaaa.js", css: "style-aaaaaaaa.css" });
    let hang = false;
    let lstats = 0;
    const releases: Array<() => void> = [];
    const deps: Partial<UiRootFsDeps> = {
      lstat: (async (p: string) => {
        if (hang && p.endsWith("build-info.json")) {
          lstats++;
          await new Promise<void>((r) => releases.push(r));
        }
        return (await import("node:fs/promises")).lstat(p);
      }) as UiRootFsDeps["lstat"],
    };
    const ui = createUiServer({
      candidates: [{ ok: true, spec: { kind: "package", dir } }],
      hubVersion: HUB_VERSION,
      log: noLog,
      probeThrottleMs: 0,
      deps,
    });
    await ui.refresh();
    hang = true;
    const joined = Array.from({ length: PROBE_WAITERS }, () => ui.probe());
    await expect(ui.probe()).rejects.toThrow("E_BUSY");
    await new Promise((r) => setTimeout(r, 20));
    expect(lstats).toBe(1); // one underlying IO for all nine callers
    // a caller that "gave up waiting" does not free the slot
    await expect(ui.probe()).rejects.toThrow("E_BUSY");
    hang = false;
    for (const r of releases) r();
    const settled = await Promise.all(joined);
    expect(settled.every((s) => s.state === "ok")).toBe(true);
    await expect(ui.probe()).resolves.toMatchObject({ state: "ok" });
  });
});

describe("GET /api/version drives the probe chain (real HTTP)", () => {
  async function start(): Promise<{
    fe: HttpFrontend;
    port: number;
    cookie: string;
    dir: string;
    served: Array<HubUiBuildWire | undefined>;
    statuses: UiStatus[];
    version: VersionInfoPort & { calls: number };
  }> {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "pwh-vhub-")));
    bases.push(base);
    const deps = fakeDeps(base);
    mkdirSync(deps.paths.stateDir, { recursive: true });
    // the EXTERNAL candidate (<home>/.pi/agent/web-hub-ui/<hubVersion>/); the package-bundled
    // dist/ never matches this fake hub's pluginVersion so it is rejected first.
    const dir = join(webHubUiDir(base), HUB_VERSION);
    mkdirSync(webHubUiDir(base), { recursive: true, mode: 0o755 });
    writeRoot(dir, { js: "index-aaaaaaaa.js", css: "style-aaaaaaaa.css" });
    const served: Array<HubUiBuildWire | undefined> = [];
    const statuses: UiStatus[] = [];
    deps.onUiServed = (u) => served.push(u);
    deps.onUiStatus = (s) => statuses.push(s);
    const version = {
      calls: 0,
      snapshot: async () => (
        version.calls++,
        { ok: true as const, data: { v: 1 as const, checkedAt: 1, hub: { pid: 1, startedAt: 1 } } }
      ),
    };
    deps.version = version;
    const fe = createHttpFrontend(deps);
    await fe.ui.refresh();
    const port = (await fe.listen()).port;
    const cookie = await login(port, deps.paths.tokenFile);
    return { fe, port, cookie, dir, served, statuses, version };
  }

  it("a redeploy is picked up by requesting ONLY /api/version: one new onStatus + one onServed; unchanged ⇒ zero", async () => {
    const h = await start();
    try {
      expect(h.served).toHaveLength(1);
      expect(h.served[0]).toMatchObject({ source: "external", commit: "abcdefabcdef" });
      const headers = { Cookie: h.cookie, "X-PWH": "1" };
      await new Promise((r) => setTimeout(r, 1100)); // probe throttle
      const r0 = await rawRequest(h.port, { path: VERSION_INFO_PATH, headers });
      expect(r0.status).toBe(200);
      expect([h.served.length, h.statuses.length]).toEqual([1, 1]); // unchanged ⇒ zero

      writeRoot(h.dir, { js: "index-bbbbbbbb.js", css: "style-aaaaaaaa.css", commit: "fedcbafedcba" });
      await new Promise((r) => setTimeout(r, 1100));
      const r1 = await rawRequest(h.port, { path: VERSION_INFO_PATH, headers });
      expect(r1.status).toBe(200);
      expect(h.served).toHaveLength(2);
      expect(h.statuses).toHaveLength(2); // hub.json's patchUi source
      expect(h.served[1]).toMatchObject({ commit: "fedcbafedcba" });
      expect(h.served[1]!.assets).toContain("/assets/index-bbbbbbbb.js");
      // the broadcast (onServed) happened before the response; a repeat changes nothing
      await rawRequest(h.port, { path: VERSION_INFO_PATH, headers });
      expect(h.served).toHaveLength(2);
    } finally {
      await h.fe.close();
    }
  }, 20_000);
});
