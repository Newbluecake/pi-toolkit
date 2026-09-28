/**
 * `dev-hub.ts` (vue-plan.md v2.1 §4.5, §5.2 — P2). Real HTTP + SSE requests against a real
 * `createDevHub()` instance — no mocked transport — proving the fake hub actually speaks the
 * `src/web-hub/protocol/` wire shapes closely enough for P1/P3/P4 frontend work and for
 * `visual.ts` to drive with a headless browser.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDevHub,
  FIXTURES_DIR,
  loadFixture,
  validateFixture,
  type DevHubHandle,
} from "../../../scripts/web-hub/dev-hub.js";
import { isSameOrigin } from "../../../scripts/web-hub/visual.js";
import { readPackageVersion } from "../../../src/web-hub/ui/build-info-plugin.js";
import { PROTO } from "../../../src/web-hub/protocol/version.js";

const JSON_HEADERS = { "Content-Type": "application/json", "X-PWH": "1" } as const;

function makeUiRoot(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pwh-devhub-ui-"));
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><html data-auth-mode="__AUTH_MODE__"><body><div id="root"></div></body></html>',
  );
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeFixturesDir(files: Record<string, unknown>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pwh-devhub-fixtures-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(content));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

interface SseEvent {
  event: string;
  data: unknown;
}

function parseFrames(chunk: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const block of chunk.split("\n\n")) {
    if (block.trim().length === 0) continue;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    }
    if (dataLines.length > 0) out.push({ event, data: JSON.parse(dataLines.join("\n")) });
  }
  return out;
}

/** Raw `node:http` SSE reader (same technique as `tests/web-hub/http/lan-helpers.ts`'s
 * `openSse`, re-implemented locally so this exclusive test file has no import-time coupling to
 * another package's helper). */
async function openSse(
  port: number,
  cookie: string,
): Promise<{ events: SseEvent[]; waitFor(event: string, ms?: number): Promise<SseEvent>; close(): void }> {
  return new Promise((resolveP, rejectP) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/api/events",
      headers: { Host: `127.0.0.1:${port}`, Cookie: cookie, Accept: "text/event-stream" },
    });
    req.on("error", rejectP);
    req.end();
    req.on("response", (res) => {
      const events: SseEvent[] = [];
      const waiters: Array<() => void> = [];
      let buf = "";
      res.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const p of parts) events.push(...parseFrames(p + "\n\n"));
        for (const w of [...waiters]) w();
      });
      resolveP({
        events,
        close: () => req.destroy(),
        waitFor(eventName, ms = 3_000) {
          return new Promise((res2, rej2) => {
            const check = (): boolean => {
              const hit = events.find((e) => e.event === eventName);
              if (hit !== undefined) {
                cleanup();
                res2(hit);
                return true;
              }
              return false;
            };
            const timer = setTimeout(() => {
              cleanup();
              rej2(new Error(`waitFor(${eventName}) timeout; got ${events.map((e) => e.event).join(",")}`));
            }, ms);
            const cleanup = (): void => {
              clearTimeout(timer);
              const i = waiters.indexOf(onEv);
              if (i >= 0) waiters.splice(i, 1);
            };
            const onEv = (): void => check();
            if (!check()) waiters.push(onEv);
          });
        },
      });
    });
  });
}

function cookieFrom(setCookieHeader: string | null): string {
  return (setCookieHeader ?? "").split(";")[0] ?? "";
}

async function fetchJson(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined, headers: res.headers };
}

/** Raw `node:http` POST, for cases (unlike `fetch`) where a test needs to omit or set a specific
 * `Origin` header verbatim — `fetch`/undici never sends one for a same-process request. */
async function postRaw(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown; setCookie: string | null }> {
  return new Promise((resolveP, rejectP) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: { Host: `127.0.0.1:${port}`, "Content-Length": Buffer.byteLength(text), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolveP({
            status: res.statusCode ?? 0,
            body: raw.length > 0 ? JSON.parse(raw) : undefined,
            setCookie: (res.headers["set-cookie"] ?? [])[0] ?? null,
          });
        });
      },
    );
    req.on("error", rejectP);
    req.end(text);
  });
}

let uiRoot: ReturnType<typeof makeUiRoot> | undefined;
let handles: DevHubHandle[] = [];

afterEach(async () => {
  for (const h of handles) await h.close();
  handles = [];
  uiRoot?.cleanup();
  uiRoot = undefined;
});

function ui(): string {
  if (uiRoot === undefined) uiRoot = makeUiRoot();
  return uiRoot.dir;
}

async function start(opts: Parameters<typeof createDevHub>[0]): Promise<DevHubHandle> {
  const h = await createDevHub({ ...opts, root: opts.root ?? ui(), log: () => {} });
  handles.push(h);
  return h;
}

describe("dev-hub fixtures", () => {
  it("validateFixture accepts every checked-in scenario fixture", async () => {
    for (const name of ["dashboard", "states", "empty", "long", "streaming"]) {
      const fixture = await loadFixture(name, FIXTURES_DIR);
      expect(Array.isArray(fixture.agents)).toBe(true);
    }
  });

  it("dashboard.json has 6 agents covering running/waiting/idle/outdated/stale/(scripted)offline", async () => {
    const fixture = await loadFixture("dashboard", FIXTURES_DIR);
    expect(fixture.agents.length).toBe(6);
    expect(fixture.agents.some((a) => a.status?.busy === true)).toBe(true); // running
    expect(fixture.agents.some((a) => a.status?.pending === true)).toBe(true); // waiting
    expect(fixture.agents.some((a) => a.outdated === true)).toBe(true); // outdated
    expect(fixture.agents.some((a) => a.state === "stale")).toBe(true); // stale
    expect(fixture.script?.some((s) => s.event === "agent_down")).toBe(true); // offline-via-script
    // nested subagent tree, depth >= 3 (parentRunId chains)
    const fleetEvent = fixture.script?.find((s) => s.event === "fleet");
    const runs = (fleetEvent?.data as { runs: Array<{ runId: string; parentRunId?: string }> }).runs;
    const depthOf = (id: string): number => {
      const row = runs.find((r) => r.runId === id);
      if (row === undefined || row.parentRunId === undefined) return 0;
      return 1 + depthOf(row.parentRunId);
    };
    expect(Math.max(...runs.map((r) => depthOf(r.runId)))).toBeGreaterThanOrEqual(2);
  });

  it("long.json synthesizes 1000 deterministic entries via historyGenerate", async () => {
    const fixture = await loadFixture("long", FIXTURES_DIR);
    expect(fixture.historyGenerate).toEqual({ agentKey: "agent-long", count: 1000 });
  });

  it("rejects a fixture missing required fields", () => {
    expect(() => validateFixture({ agents: [{}] }, "bad.json")).toThrow(/AgentCard/);
    expect(() => validateFixture({ agents: [], history: { a: {} } }, "bad2.json")).toThrow(/HistoryPayload/);
    expect(() => validateFixture({ agents: [], history: {}, script: [{ atMs: 1 }] }, "bad3.json")).toThrow(/script/);
    expect(() => validateFixture(null, "bad4.json")).toThrow(/object/);
    expect(() => validateFixture({}, "bad5.json")).toThrow(/agents/);
  });
});

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** A manifest-carrying root (`build-info.json` present) — P5b 打回点 2: proves `createDevHub`
 * routes through the real production `createUiServer` (not the raw `devServeStatic` fallback)
 * whenever `--root` looks like an actual build, by asserting on behavior only `createUiServer`
 * has: the immutable `assets/*-<hash>.*` cache header and manifest-only serving (an unlisted path
 * 404s even though its extension is otherwise servable). */
async function makeManifestUiRoot(): Promise<{ dir: string; cleanup: () => void }> {
  const base = mkdtempSync(join(tmpdir(), "pwh-devhub-manifest-"));
  const parent = join(base, "dist");
  mkdirSync(parent, { mode: 0o755 });
  const dir = join(parent, "web-hub-ui");
  mkdirSync(join(dir, "assets"), { recursive: true, mode: 0o755 });
  const indexHtml = '<!doctype html><html data-auth-mode="__AUTH_MODE__"><body><div id="root"></div></body></html>';
  const assetJs = "console.log('asset')";
  writeFileSync(join(dir, "index.html"), indexHtml, { mode: 0o644 });
  writeFileSync(join(dir, "assets", "index-abcd1234.js"), assetJs, { mode: 0o644 });
  const info = {
    v: 1,
    version: await readPackageVersion(),
    proto: { major: PROTO.major },
    builtAt: "2026-01-01T00:00:00.000Z",
    commit: "abcdefabcdef",
    files: [
      { path: "index.html", bytes: Buffer.byteLength(indexHtml), sha256: sha256(Buffer.from(indexHtml)) },
      {
        path: "assets/index-abcd1234.js",
        bytes: Buffer.byteLength(assetJs),
        sha256: sha256(Buffer.from(assetJs)),
      },
    ],
  };
  writeFileSync(join(dir, "build-info.json"), JSON.stringify(info), { mode: 0o644 });
  return { dir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe("dev-hub static serving — manifest root routes through createUiServer (P5b 打回点 2)", () => {
  it("a build-info.json-carrying root gets the immutable hashed-asset cache header createUiServer sets (devServeStatic never sends this)", async () => {
    const { dir, cleanup } = await makeManifestUiRoot();
    try {
      const hub = await start({ mode: "token", root: dir, scenario: "empty" });
      const res = await fetch(hub.url + "/assets/index-abcd1234.js");
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      const index = await fetch(hub.url + "/");
      expect(index.headers.get("cache-control")).toBe("no-cache");
    } finally {
      cleanup();
    }
  });

  it("a path not present in the manifest 404s even with an otherwise-servable extension (manifest-only serving, no raw filesystem fallback)", async () => {
    const { dir, cleanup } = await makeManifestUiRoot();
    try {
      writeFileSync(join(dir, "stray.js"), "console.log('not in manifest')", { mode: 0o644 });
      const hub = await start({ mode: "token", root: dir, scenario: "empty" });
      const res = await fetch(hub.url + "/stray.js");
      expect(res.status).toBe(404);
    } finally {
      cleanup();
    }
  });
});

describe("dev-hub server — token mode", () => {
  it("serves the index page with the token auth-mode substituted", async () => {
    const hub = await start({ mode: "token", scenario: "empty" });
    const res = await fetch(hub.url + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toMatch(/default-src 'self'/);
    const html = await res.text();
    expect(html).toContain('data-auth-mode="token"');
  });

  it("rejects a request with a spoofed Host header (421)", async () => {
    const hub = await start({ mode: "token", scenario: "empty" });
    // `fetch` (undici) always sends the real connection Host, ignoring a caller-supplied
    // override — a raw `node:http` request is the only way to actually spoof it.
    const { status, body } = await new Promise<{ status: number; body: unknown }>((resolveP, rejectP) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: hub.port,
          path: "/api/history?agent=x&before=y",
          headers: { Host: "evil.example:1" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolveP({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }),
          );
        },
      );
      req.on("error", rejectP);
      req.end();
    });
    expect(status).toBe(421);
    expect((body as { error: string }).error).toBe("E_HOST");
  });

  it("rejects an unauthenticated /api/history and logs in with the real bearer token", async () => {
    const hub = await start({ mode: "token", scenario: "dashboard" });
    expect(hub.token).toBeDefined();

    const unauth = await fetchJson(hub.url + "/api/history?agent=agent-alpha&before=e-alpha-6");
    expect(unauth.status).toBe(401);

    const wrong = await fetchJson(hub.url + "/api/login", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: "not-the-token" }),
    });
    expect(wrong.status).toBe(401);

    const login = await fetch(hub.url + "/api/login", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: hub.token }),
    });
    expect(login.status).toBe(200);
    const cookie = cookieFrom(login.headers.get("set-cookie"));
    expect(cookie).toContain("pwh_sid=");

    // Token mode has no /api/session route at all (matches the real loopback handler).
    const session = await fetchJson(hub.url + "/api/session", { headers: { Cookie: cookie } });
    expect(session.status).toBe(404);

    const history = await fetchJson(hub.url + "/api/history?agent=agent-alpha&before=e-alpha-2&limit=1", {
      headers: { Cookie: cookie },
    });
    expect(history.status).toBe(200);
  });

  it("rejects a POST without the CSRF header (X-PWH)", async () => {
    const hub = await start({ mode: "token", scenario: "empty" });
    const res = await fetch(hub.url + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("subscribe delivers the fixture's HistoryPayload over SSE, unsubscribe stops updates", async () => {
    const hub = await start({ mode: "token", scenario: "dashboard" });
    const login = await fetch(hub.url + "/api/login", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: hub.token }),
    });
    const cookie = cookieFrom(login.headers.get("set-cookie"));

    const sse = await openSse(hub.port, cookie);
    await sse.waitFor("hub");
    const agentsFrame = await sse.waitFor("agents");
    expect((agentsFrame.data as { agents: Array<{ agentKey: string }> }).agents.map((a) => a.agentKey)).toContain(
      "agent-alpha",
    );

    const clientId = (sse.events.find((e) => e.event === "hello")?.data as { clientId: string }).clientId;
    const sub = await fetchJson(hub.url + "/api/subscribe", {
      method: "POST",
      headers: { ...JSON_HEADERS, Cookie: cookie },
      body: JSON.stringify({ clientId, agentKey: "agent-alpha" }),
    });
    expect(sub.status).toBe(202);

    const history = await sse.waitFor("history");
    const payload = history.data as { agentKey: string; entries: unknown[]; inflight?: { tools: unknown[] } };
    expect(payload.agentKey).toBe("agent-alpha");
    expect(payload.entries.length).toBeGreaterThan(0);
    expect(payload.inflight?.tools.length).toBeGreaterThan(0);

    const unsub = await fetchJson(hub.url + "/api/unsubscribe", {
      method: "POST",
      headers: { ...JSON_HEADERS, Cookie: cookie },
      body: JSON.stringify({ clientId, agentKey: "agent-alpha" }),
    });
    expect(unsub.status).toBe(200);
    sse.close();
  });

  it("subscribing to an unknown agentKey is 404", async () => {
    const hub = await start({ mode: "token", scenario: "dashboard" });
    const login = await fetch(hub.url + "/api/login", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: hub.token }),
    });
    const cookie = cookieFrom(login.headers.get("set-cookie"));
    const sse = await openSse(hub.port, cookie);
    await sse.waitFor("agents");
    const clientId = (sse.events.find((e) => e.event === "hello")?.data as { clientId: string }).clientId;
    const res = await fetchJson(hub.url + "/api/subscribe", {
      method: "POST",
      headers: { ...JSON_HEADERS, Cookie: cookie },
      body: JSON.stringify({ clientId, agentKey: "does-not-exist" }),
    });
    expect(res.status).toBe(404);
    sse.close();
  });

  it("a scripted agent_down removes the agent from a later client's initial `agents` snapshot", async () => {
    const fx = makeFixturesDir({
      mini: {
        agents: [
          {
            agentKey: "a1",
            kind: "tui",
            pid: 1,
            cwd: "/x",
            state: "live",
            pluginVersion: "1.0.0",
            outdated: false,
            prompts: [],
          },
        ],
        history: {},
        script: [{ atMs: 20, event: "agent_down", data: { agentKey: "a1", reason: "quit" } }],
      },
    });
    try {
      const hub = await start({ mode: "token", scenario: "mini", fixturesDir: fx.dir });
      const login = await fetch(hub.url + "/api/login", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ token: hub.token }),
      });
      const cookie = cookieFrom(login.headers.get("set-cookie"));

      // P1 fix (todo #26 W3 打回点 A, `dev-hub.ts`'s `openEvents`): script events now fire
      // `atMs` after a CLIENT connects (as `DevHubScriptEvent`'s own doc comment always promised),
      // not once at hub startup — a visual-harness matrix run reuses one hub across dozens of
      // cells, and the old "once at hub boot" behavior meant only whichever cell happened to
      // connect before that one global timer fired ever saw the scripted frame. So the first
      // client here has to actually connect (starting its own `atMs:20` timer) before the
      // `agent_down` can apply; a second, later-connecting client then sees the post-effect
      // snapshot, same as before.
      const firstSse = await openSse(hub.port, cookie);
      await firstSse.waitFor("agent_down");
      firstSse.close();

      const sse = await openSse(hub.port, cookie);
      const agentsFrame = await sse.waitFor("agents");
      expect((agentsFrame.data as { agents: unknown[] }).agents).toEqual([]);
      sse.close();
    } finally {
      fx.cleanup();
    }
  });

  it("P1 fix (todo #26 W3): a script event replays for EVERY client connection, not just whichever one connected first", async () => {
    const fx = makeFixturesDir({
      mini: {
        agents: [
          {
            agentKey: "a1",
            kind: "tui",
            pid: 1,
            cwd: "/x",
            state: "live",
            pluginVersion: "1.0.0",
            outdated: false,
            prompts: [],
          },
        ],
        history: {},
        script: [{ atMs: 15, event: "agent_down", data: { agentKey: "a1", reason: "quit" } }],
      },
    });
    try {
      const hub = await start({ mode: "token", scenario: "mini", fixturesDir: fx.dir });
      const login = await fetch(hub.url + "/api/login", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ token: hub.token }),
      });
      const cookie = cookieFrom(login.headers.get("set-cookie"));

      // First client: connects, sees the scripted agent_down.
      const sse1 = await openSse(hub.port, cookie);
      await sse1.waitFor("agent_down");
      sse1.close();

      // A second client connecting well after the first one's atMs window has already elapsed
      // (simulating a later matrix cell reusing the same long-lived hub) must STILL see its own
      // agent_down \u2014 the old "fire once at hub startup" behavior would have silently dropped
      // this for every client past the first.
      await new Promise((r) => setTimeout(r, 100));
      const sse2 = await openSse(hub.port, cookie);
      const down2 = await sse2.waitFor("agent_down");
      expect((down2.data as { agentKey: string }).agentKey).toBe("a1");
      sse2.close();

      // A third client, later still, also sees it.
      await new Promise((r) => setTimeout(r, 50));
      const sse3 = await openSse(hub.port, cookie);
      const down3 = await sse3.waitFor("agent_down");
      expect((down3.data as { agentKey: string }).agentKey).toBe("a1");
      sse3.close();
    } finally {
      fx.cleanup();
    }
  });

  it("history pagination against the synthesized 'long' fixture is deterministic and hasMore-correct", async () => {
    const hub = await start({ mode: "token", scenario: "long" });
    const login = await fetch(hub.url + "/api/login", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: hub.token }),
    });
    const cookie = cookieFrom(login.headers.get("set-cookie"));

    const page1 = await fetchJson(hub.url + "/api/history?agent=agent-long&before=e-1001&limit=400", {
      headers: { Cookie: cookie },
    });
    expect(page1.status).toBe(200);
    const p1 = page1.body as { entries: Array<{ id: string }>; hasMore: boolean; fromSeq: number };
    expect(p1.entries.length).toBe(400);
    expect(p1.entries[0]?.id).toBe("e-601");
    expect(p1.entries[p1.entries.length - 1]?.id).toBe("e-1000");
    expect(p1.hasMore).toBe(true);

    const page2 = await fetchJson(hub.url + "/api/history?agent=agent-long&before=e-601&limit=400", {
      headers: { Cookie: cookie },
    });
    const p2 = page2.body as { entries: Array<{ id: string }>; hasMore: boolean };
    expect(p2.entries.length).toBe(400);
    expect(p2.entries[0]?.id).toBe("e-201");
    expect(p2.hasMore).toBe(true);

    const page3 = await fetchJson(hub.url + "/api/history?agent=agent-long&before=e-201&limit=400", {
      headers: { Cookie: cookie },
    });
    const p3 = page3.body as { entries: Array<{ id: string }>; hasMore: boolean };
    expect(p3.entries.length).toBe(200);
    expect(p3.entries[0]?.id).toBe("e-1");
    expect(p3.hasMore).toBe(false);
  });
});

describe("dev-hub server — password mode", () => {
  it("logs in with the fixed dev credential and reports initialPasswordInUse", async () => {
    const hub = await start({ mode: "password", scenario: "empty", initialPassword: true });
    const origin = `http://127.0.0.1:${hub.port}`;
    const bad = await postRaw(
      hub.port,
      "/api/login",
      { username: "admin", password: "wrong" },
      { "Content-Type": "application/json", "X-PWH": "1", Origin: origin },
    );
    expect(bad.status).toBe(401);

    const ok = await postRaw(
      hub.port,
      "/api/login",
      { username: "admin", password: "admin" },
      { "Content-Type": "application/json", "X-PWH": "1", Origin: origin },
    );
    expect(ok.status).toBe(200);
    const cookie = cookieFrom(ok.setCookie);

    const session = await fetchJson(hub.url + "/api/session", { headers: { Cookie: cookie } });
    expect(session.status).toBe(200);
    expect((session.body as { initialPasswordInUse: boolean }).initialPasswordInUse).toBe(true);

    const logout = await postRaw(hub.port, "/api/logout", undefined, {
      "Content-Type": "application/json",
      "X-PWH": "1",
      Origin: origin,
      Cookie: cookie,
    });
    expect(logout.status).toBe(200);
    const after = await fetchJson(hub.url + "/api/session", { headers: { Cookie: cookie } });
    expect(after.status).toBe(401);
  });

  it.each([
    ["invalid", 401, "E_AUTH"],
    ["throttled", 429, "E_RATE"],
    ["saturated", 429, "E_RATE"],
    ["not-allowed", 429, "E_LOCKED"],
    ["busy-exhausted", 503, "E_BUSY"],
  ] as const)("--login-error %s forces %d %s", async (kind, status, code) => {
    const hub = await start({ mode: "password", scenario: "empty", loginError: kind });
    const res = await postRaw(
      hub.port,
      "/api/login",
      { username: "admin", password: "admin" },
      { "Content-Type": "application/json", "X-PWH": "1", Origin: `http://127.0.0.1:${hub.port}` },
    );
    expect(res.status).toBe(status);
    expect((res.body as { error: string }).error).toBe(code);
  });

  it("--login-error network drops the connection instead of answering", async () => {
    const hub = await start({ mode: "password", scenario: "empty", loginError: "network" });
    await expect(
      postRaw(
        hub.port,
        "/api/login",
        { username: "admin", password: "admin" },
        { "Content-Type": "application/json", "X-PWH": "1", Origin: `http://127.0.0.1:${hub.port}` },
      ),
    ).rejects.toThrow();
  });
});

describe("dev-hub server — protocol drift regressions (verifier fixes)", () => {
  it("global frames (fleet/status) reach an UNSUBSCRIBED client; scoped frames (ev) do not", async () => {
    const fx = makeFixturesDir({
      bcast: {
        agents: [
          {
            agentKey: "a1",
            kind: "tui",
            pid: 1,
            cwd: "/x",
            state: "live",
            pluginVersion: "1.0.0",
            outdated: false,
            prompts: [],
          },
        ],
        history: {},
        script: [
          {
            atMs: 20,
            event: "status",
            agentKey: "a1",
            data: { agentKey: "a1", status: { leafId: "e-1", busy: true, pending: false, costUsd: 0 } },
          },
          { atMs: 20, event: "fleet", agentKey: "a1", data: { agentKey: "a1", runs: [] } },
          {
            atMs: 20,
            event: "ev",
            agentKey: "a1",
            data: { agentKey: "a1", seq: 1, e: { type: "message_start", role: "assistant" } },
          },
        ],
      },
    });
    try {
      const hub = await start({ mode: "token", scenario: "bcast", fixturesDir: fx.dir });
      const login = await fetch(hub.url + "/api/login", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ token: hub.token }),
      });
      const cookie = cookieFrom(login.headers.get("set-cookie"));

      // Connects but never subscribes to "a1".
      const sse = await openSse(hub.port, cookie);
      await sse.waitFor("agents");
      // Real hub's onHubEvent: agent_up/agent_down/agent_stale/session/status/fleet/prompt are
      // global sse.publish(event, data) — no agentKey filter — so an unsubscribed client still
      // gets them.
      await sse.waitFor("status");
      await sse.waitFor("fleet");
      // Real hub's "ev"/"gap"/"append" go through scoped() (sse.publish(event, data, agentKey))
      // — only a subscribed client's socket receives it. Wait past atMs:20 and confirm "ev"
      // never arrives.
      await new Promise((r) => setTimeout(r, 150));
      expect(sse.events.some((e) => e.event === "ev")).toBe(false);
      sse.close();
    } finally {
      fx.cleanup();
    }
  });

  it("GET /api/history with a non-numeric limit is 400 (real hub never silently falls back)", async () => {
    const hub = await start({ mode: "token", scenario: "long" });
    const login = await fetch(hub.url + "/api/login", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: hub.token }),
    });
    const cookie = cookieFrom(login.headers.get("set-cookie"));

    const bad = await fetchJson(hub.url + "/api/history?agent=agent-long&before=e-1001&limit=abc", {
      headers: { Cookie: cookie },
    });
    expect(bad.status).toBe(400);
    expect((bad.body as { error: string }).error).toBe("E_BAD_REQUEST");

    // A present-but-absent limit still defaults to 400 (unchanged behavior).
    const ok = await fetchJson(hub.url + "/api/history?agent=agent-long&before=e-1001", {
      headers: { Cookie: cookie },
    });
    expect(ok.status).toBe(200);
    expect((ok.body as { entries: unknown[] }).entries.length).toBe(400);
  });

  it("password mode sets the real LAN session cookie name (pwh_lan, not pwh_sid)", async () => {
    const hub = await start({ mode: "password", scenario: "empty" });
    const login = await postRaw(
      hub.port,
      "/api/login",
      { username: "admin", password: "admin" },
      { "Content-Type": "application/json", "X-PWH": "1", Origin: `http://127.0.0.1:${hub.port}` },
    );
    expect(login.status).toBe(200);
    expect(login.setCookie ?? "").toContain("pwh_lan=");
    expect(login.setCookie ?? "").not.toContain("pwh_sid=");
  });

  it("password mode POST without an Origin header is rejected 403 (csrfOkLan requires Origin)", async () => {
    const hub = await start({ mode: "password", scenario: "empty" });
    const res = await postRaw(
      hub.port,
      "/api/login",
      { username: "admin", password: "admin" },
      { "Content-Type": "application/json", "X-PWH": "1" },
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe("E_CSRF");
  });

  it("password mode POST with a foreign Origin is rejected 403", async () => {
    const hub = await start({ mode: "password", scenario: "empty" });
    const res = await postRaw(
      hub.port,
      "/api/login",
      { username: "admin", password: "admin" },
      { "Content-Type": "application/json", "X-PWH": "1", Origin: "http://evil.example" },
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe("E_CSRF");
  });

  it("token mode POST still accepts a missing Origin (loopback csrfOk, unchanged)", async () => {
    const hub = await start({ mode: "token", scenario: "empty" });
    const res = await postRaw(hub.port, "/api/login", { token: "not-the-token" }, JSON_HEADERS);
    // 401 (wrong token) rather than 403 proves the CSRF gate itself passed without an Origin.
    expect(res.status).toBe(401);
  });

  it("subscribe with a missing agentKey field is 400 (real subscribe() throws E_BAD_REQUEST)", async () => {
    const hub = await start({ mode: "token", scenario: "dashboard" });
    const login = await fetch(hub.url + "/api/login", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: hub.token }),
    });
    const cookie = cookieFrom(login.headers.get("set-cookie"));
    const sse = await openSse(hub.port, cookie);
    await sse.waitFor("agents");
    const clientId = (sse.events.find((e) => e.event === "hello")?.data as { clientId: string }).clientId;
    const res = await fetchJson(hub.url + "/api/subscribe", {
      method: "POST",
      headers: { ...JSON_HEADERS, Cookie: cookie },
      body: JSON.stringify({ clientId }),
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("E_BAD_REQUEST");
    // Mirrors hub/http.ts stringField: empty or >256-char fields are rejected too.
    for (const agentKey of ["", "k".repeat(257)]) {
      const bad = await fetchJson(hub.url + "/api/subscribe", {
        method: "POST",
        headers: { ...JSON_HEADERS, Cookie: cookie },
        body: JSON.stringify({ clientId, agentKey }),
      });
      expect(bad.status).toBe(400);
      expect((bad.body as { error: string }).error).toBe("E_BAD_REQUEST");
    }
    sse.close();
  });

  it("/api/events honors Last-Event-ID: an unreachable id resyncs (real hub previously ignored the header)", async () => {
    const hub = await start({ mode: "token", scenario: "empty" });
    const login = await fetch(hub.url + "/api/login", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: hub.token }),
    });
    const cookie = cookieFrom(login.headers.get("set-cookie"));

    const events: SseEvent[] = [];
    await new Promise<void>((resolveP, rejectP) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: hub.port,
        path: "/api/events",
        headers: {
          Host: `127.0.0.1:${hub.port}`,
          Cookie: cookie,
          Accept: "text/event-stream",
          "Last-Event-ID": "0",
        },
      });
      req.on("error", rejectP);
      req.end();
      req.on("response", (res) => {
        let buf = "";
        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf8");
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const p of parts) events.push(...parseFrames(p + "\n\n"));
          if (events.some((e) => e.event === "resync")) {
            req.destroy();
            resolveP();
          }
        });
        setTimeout(() => {
          req.destroy();
          resolveP();
        }, 2_000);
      });
    });
    expect(events.some((e) => e.event === "resync")).toBe(true);
  });

  it("subscribe still delivers history + live scoped ev frames end-to-end after the pending-buffer rewrite", async () => {
    const hub = await start({ mode: "token", scenario: "streaming" });
    const login = await fetch(hub.url + "/api/login", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: hub.token }),
    });
    const cookie = cookieFrom(login.headers.get("set-cookie"));
    const sse = await openSse(hub.port, cookie);
    await sse.waitFor("agents");
    const clientId = (sse.events.find((e) => e.event === "hello")?.data as { clientId: string }).clientId;
    const sub = await fetchJson(hub.url + "/api/subscribe", {
      method: "POST",
      headers: { ...JSON_HEADERS, Cookie: cookie },
      body: JSON.stringify({ clientId, agentKey: "agent-stream" }),
    });
    expect(sub.status).toBe(202);
    await sse.waitFor("history");
    const ev = await sse.waitFor("ev", 3_000);
    expect((ev.data as { e: { type: string } }).e.type).toBe("message_start");
    sse.close();
  });
});

describe("visual.ts — isSameOrigin (strict Origin comparison, verifier fix)", () => {
  const origin = "http://127.0.0.1:5173";

  it("same origin, different path", () => {
    expect(isSameOrigin("http://127.0.0.1:5173/x/y", origin)).toBe(true);
  });

  it("data:/about: URLs are always treated as same-origin", () => {
    expect(isSameOrigin("data:text/plain,hello", origin)).toBe(true);
    expect(isSameOrigin("about:blank", origin)).toBe(true);
  });

  it("a naive startsWith(origin) prefix match on a foreign host is rejected", () => {
    // The exact drift bug: "http://127.0.0.1:5173.evil.example" is a `startsWith(origin)` hit
    // but a completely different host once actually parsed.
    expect(isSameOrigin("http://127.0.0.1:5173.evil.example/x", origin)).toBe(false);
  });

  it("a genuinely foreign origin is rejected", () => {
    expect(isSameOrigin("http://evil.example/", origin)).toBe(false);
  });

  it("an unparseable URL is rejected, not thrown", () => {
    expect(isSameOrigin("not a url", origin)).toBe(false);
  });
});
