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

// ---------------------------------------------------------------------------
// P2 control plane (control-plan.md v2.1 §9.3, §12.3 C6)
// ---------------------------------------------------------------------------

import { DEV_HUB_LATE_SETTLE_MS, type DevHubControlRequest } from "../../../scripts/web-hub/dev-hub.js";
import {
  CONTROL_SELECTORS,
  CONTROL_SCENARIOS,
  isControlActionCell,
  isControlApiPath,
  isControlAxeCell,
  isControlScenario,
} from "../../../scripts/web-hub/visual/checks-control.js";

/** Deterministic 20-char ids satisfying dev-hub's `/^[A-Za-z0-9_-]{16,64}$/` rule. */
let cmdIdSeq = 0;
function cmdId(): string {
  return `testcmd_${String(++cmdIdSeq).padStart(12, "0")}`;
}

async function loginToken(hub: DevHubHandle): Promise<string> {
  const login = await fetch(hub.url + "/api/login", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ token: hub.token }),
  });
  expect(login.status).toBe(200);
  return cookieFrom(login.headers.get("set-cookie"));
}

/** Control writes go through `postRaw` (never `fetch`) so the `Origin` header is explicit —
 * §6.3's strict write CSRF makes it required, and undici would never send one on its own. */
async function postControl(
  hub: DevHubHandle,
  path: "/api/cmd" | "/api/dialog",
  cookie: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const { status, body: b } = await postRaw(hub.port, path, body, {
    ...JSON_HEADERS,
    Cookie: cookie,
    Origin: `http://127.0.0.1:${hub.port}`,
    ...headers,
  });
  return { status, body: b };
}

async function loginPassword(hub: DevHubHandle): Promise<string> {
  const { status, setCookie } = await postRaw(
    hub.port,
    "/api/login",
    { username: "admin", password: "admin" },
    { ...JSON_HEADERS, Origin: `http://127.0.0.1:${hub.port}` },
  );
  expect(status).toBe(200);
  return cookieFrom(setCookie);
}

/** Polls `fn` until it returns non-undefined (bounded — a missing condition is a test failure,
 * never a hang). */
async function waitFor<T>(fn: () => T | undefined, ms = 4_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = fn();
    if (hit !== undefined) return hit;
    if (Date.now() > deadline) throw new Error("waitFor: condition never became true");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("dev-hub control plane — fixtures (C6)", () => {
  it("all four new scenario fixtures validate", async () => {
    for (const name of CONTROL_SCENARIOS) {
      const fixture = await loadFixture(name, FIXTURES_DIR);
      expect(Array.isArray(fixture.agents)).toBe(true);
    }
  });

  it("control.json: busy agent with a 3-item queue (web×2 + terminal×1), old agent without control, stale agent", async () => {
    const fixture = await loadFixture("control", FIXTURES_DIR);
    const alpha = fixture.agents.find((a) => a.agentKey === "agent-alpha")!;
    expect(alpha.control).toBe(true);
    expect(alpha.status?.busy).toBe(true);
    const queue = (alpha.status as { queue?: Array<{ source: string; cmdId?: string }> }).queue!;
    expect(queue).toHaveLength(3);
    expect(queue.filter((q) => q.source === "web")).toHaveLength(2);
    expect(queue.filter((q) => q.source === "web").every((q) => typeof q.cmdId === "string")).toBe(true);
    expect(queue.some((q) => q.source === "tui")).toBe(true);
    const old = fixture.agents.find((a) => a.agentKey === "agent-old")!;
    expect(old.control).toBeUndefined();
    expect(fixture.agents.some((a) => a.state === "stale")).toBe(true);
    const ctlItems = (fixture.ctl?.["agent-alpha"]?.items ?? []) as Array<{ state: string }>;
    for (const state of ["queued", "consumed", "unconfirmed", "late_ok"]) {
      expect(ctlItems.some((i) => i.state === state)).toBe(true);
    }
  });

  it("ask-user.json: open single- and multi-question dialogs plus dual-channel race demo data", async () => {
    const fixture = await loadFixture("ask-user", FIXTURES_DIR);
    const single = fixture.dialogs?.["agent-alpha"]?.open[0]!;
    expect(single.questions).toHaveLength(1);
    expect(single.allowCancel).toBe(true);
    const multi = fixture.dialogs?.["agent-beta"]?.open[0]!;
    expect(multi.questions).toHaveLength(3);
    expect(multi.questions.some((q) => q.multiSelect === true)).toBe(true);
    expect(multi.questions.some((q) => q.allowOther === true && typeof q.context === "string")).toBe(true);
    const gamma = fixture.dialogs?.["agent-gamma"]!;
    expect(gamma.closed.some((c) => c.by === "web" && typeof c.cmdId === "string")).toBe(true);
    const race = fixture.script?.find((s) => s.event === "dialogs" && s.agentKey === "agent-gamma");
    expect(race).toBeDefined();
    const raceClosed = (race!.data as { closed: Array<{ by: string }> }).closed;
    expect(raceClosed.some((c) => c.by === "tui")).toBe(true);
  });

  it("commands.json: kinds × policies × output badges matrix", async () => {
    const fixture = await loadFixture("commands", FIXTURES_DIR);
    const items = fixture.commands?.["agent-alpha"]?.items ?? [];
    for (const kind of ["builtin", "extension", "template", "skill"]) {
      expect(items.some((i) => i.kind === kind)).toBe(true);
    }
    for (const policy of ["allow", "confirm", "deny"]) {
      expect(items.some((i) => i.policy === policy)).toBe(true);
    }
    expect(items.some((i) => i.policyBusy === "confirm")).toBe(true);
    expect(items.some((i) => i.output === "captured")).toBe(true);
    expect(items.some((i) => i.output === "terminal")).toBe(true);
  });

  it("hub-states.json: supersedePending relative countdown + forced/stopping script steps", async () => {
    const fixture = await loadFixture("hub-states", FIXTURES_DIR);
    expect(fixture.hubState?.supersedePending).toBe(true);
    expect(fixture.hubState?.supersedeDeadlineInMs).toBeGreaterThan(0);
    const hubEvents = (fixture.script ?? []).filter((s) => s.event === "hub");
    expect(
      hubEvents.some(
        (s) =>
          (s.data as { state?: string }).state === "restarting" && (s.data as { forced?: boolean }).forced === true,
      ),
    ).toBe(true);
    expect(hubEvents.some((s) => (s.data as { state?: string }).state === "stopping")).toBe(true);
  });
});

describe("dev-hub control plane — POST /api/cmd", () => {
  it("prompt on a busy agent: observed + steer behavior, recorded request with Origin header, ctl SSE pushed", async () => {
    const hub = await start({ mode: "token", scenario: "control" });
    const cookie = await loginToken(hub);
    const sse = await openSse(hub.port, cookie);
    await sse.waitFor("agents");
    const id = cmdId();
    const { status, body } = await postControl(hub, "/api/cmd", cookie, {
      agentKey: "agent-alpha",
      id,
      op: "prompt",
      text: "steer the busy turn",
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, id, data: { op: "prompt", delivery: "observed", behavior: "steer" } });
    const ctl = await sse.waitFor("ctl");
    const ctlData = ctl.data as { agentKey: string; items: Array<{ cmdId: string; state: string }> };
    expect(ctlData.agentKey).toBe("agent-alpha");
    expect(ctlData.items[0]).toMatchObject({ cmdId: id, state: "queued" });
    const rec = hub.controlRequests().find((r: DevHubControlRequest) => r.id === id)!;
    expect(rec.origin).toBe(`http://127.0.0.1:${hub.port}`);
    expect(rec.responseStatus).toBe(200);
    sse.close();
  });

  it("prompt on an idle agent starts a new turn (behavior idle); matching expect.sessionId passes", async () => {
    const hub = await start({ mode: "token", scenario: "control" });
    const cookie = await loginToken(hub);
    const { status, body } = await postControl(hub, "/api/cmd", cookie, {
      agentKey: "agent-beta",
      id: cmdId(),
      op: "prompt",
      text: "new turn",
      expect: { sessionId: "sess-beta-1" },
    });
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ op: "prompt", delivery: "observed", behavior: "idle" });
  });

  it("expect.sessionId mismatch → 409 E_SESSION_CHANGED (not retryable, effect none), cached for replay", async () => {
    const hub = await start({ mode: "token", scenario: "control" });
    const cookie = await loginToken(hub);
    const id = cmdId();
    const req = {
      agentKey: "agent-beta",
      id,
      op: "prompt",
      text: "stale session",
      expect: { sessionId: "sess-WRONG" },
    };
    const first = await postControl(hub, "/api/cmd", cookie, req);
    expect(first.status).toBe(409);
    expect(first.body).toMatchObject({ error: "E_SESSION_CHANGED", retryable: false, effect: "none" });
    const replay = await postControl(hub, "/api/cmd", cookie, req);
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe("E_SESSION_CHANGED");
  });

  it("[compacting] and [stale-ctx] markers → 409 retryable (effect none), never cached", async () => {
    const hub = await start({ mode: "token", scenario: "control" });
    const cookie = await loginToken(hub);
    for (const [marker, code] of [
      ["[compacting]", "E_BUSY_COMPACTING"],
      ["[stale-ctx]", "E_STALE_CTX"],
    ] as const) {
      const id = cmdId();
      const req = { agentKey: "agent-beta", id, op: "prompt", text: `${marker} body` };
      const first = await postControl(hub, "/api/cmd", cookie, req);
      expect(first.status).toBe(409);
      expect(first.body).toMatchObject({ error: code, retryable: true, effect: "none" });
      // Retryable effect-none failures are NOT cached — the same id may execute again (§3.4).
      const retry = await postControl(hub, "/api/cmd", cookie, { ...req, text: "clean body" });
      expect(retry.status).toBe(200);
    }
  });

  it("unknown → queryOnly: [timeout] 504s with effect unknown, ledger settles late, cmd_late broadcasts", async () => {
    const hub = await start({ mode: "token", scenario: "control" });
    const cookie = await loginToken(hub);
    const sse = await openSse(hub.port, cookie);
    await sse.waitFor("agents");
    const id = cmdId();
    const req = { agentKey: "agent-alpha", id, op: "prompt", text: "[timeout] slow prompt" };
    const first = await postControl(hub, "/api/cmd", cookie, req);
    expect(first.status).toBe(504);
    expect(first.body).toMatchObject({ error: "E_DEADLINE", retryable: true, effect: "unknown" });

    const running = await postControl(hub, "/api/cmd", cookie, { ...req, queryOnly: true });
    expect(running.status).toBe(200);
    expect(running.body.data).toMatchObject({ op: "query", state: "running" });

    const late = await sse.waitFor("cmd_late", DEV_HUB_LATE_SETTLE_MS + 3_000);
    expect(late.data).toMatchObject({ agentKey: "agent-alpha", id, op: "prompt", ok: true });

    const settled = await postControl(hub, "/api/cmd", cookie, { ...req, queryOnly: true });
    expect(settled.status).toBe(200);
    expect(settled.body).toMatchObject({
      ok: true,
      id,
      dup: true,
      data: { op: "query", state: "ok", result: { ok: true } },
    });
    sse.close();
  });

  it("queryOnly for a never-seen id → 404 E_UNKNOWN_ID (provably never executed)", async () => {
    const hub = await start({ mode: "token", scenario: "control" });
    const cookie = await loginToken(hub);
    const { status, body } = await postControl(hub, "/api/cmd", cookie, {
      agentKey: "agent-alpha",
      id: cmdId(),
      op: "prompt",
      text: "never sent",
      queryOnly: true,
    });
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: "E_UNKNOWN_ID", retryable: false, effect: "none" });
  });

  it("same id + same payload replays as dup without re-executing; same id + different payload → 409", async () => {
    const hub = await start({ mode: "token", scenario: "control" });
    const cookie = await loginToken(hub);
    const id = cmdId();
    const req = { agentKey: "agent-beta", id, op: "prompt", text: "exactly once" };
    const first = await postControl(hub, "/api/cmd", cookie, req);
    expect(first.status).toBe(200);
    const dup = await postControl(hub, "/api/cmd", cookie, req);
    expect(dup.status).toBe(200);
    expect(dup.body).toMatchObject({ ok: true, id, dup: true });
    const reused = await postControl(hub, "/api/cmd", cookie, { ...req, text: "different payload" });
    expect(reused.status).toBe(409);
    expect(reused.body.error).toBe("E_BAD_REQUEST");
    expect(reused.body.message).toMatch(/id reused/);
  });

  it("agent routing: unknown agent 404, old agent (no control) 409 E_UNSUPPORTED, stale agent 503 E_AGENT_GONE", async () => {
    const hub = await start({ mode: "token", scenario: "control" });
    const cookie = await loginToken(hub);
    const base = { id: cmdId(), op: "prompt", text: "hi" };
    expect((await postControl(hub, "/api/cmd", cookie, { ...base, agentKey: "agent-nope" })).status).toBe(404);
    const old = await postControl(hub, "/api/cmd", cookie, { ...base, agentKey: "agent-old", id: cmdId() });
    expect(old.status).toBe(409);
    expect(old.body.error).toBe("E_UNSUPPORTED");
    const stale = await postControl(hub, "/api/cmd", cookie, { ...base, agentKey: "agent-stale", id: cmdId() });
    expect(stale.status).toBe(503);
    expect(stale.body.error).toBe("E_AGENT_GONE");
  });

  it("abort echoes wasBusy from the agent card", async () => {
    const hub = await start({ mode: "token", scenario: "control" });
    const cookie = await loginToken(hub);
    const busy = await postControl(hub, "/api/cmd", cookie, { agentKey: "agent-alpha", id: cmdId(), op: "abort" });
    expect(busy.body.data).toMatchObject({ op: "abort", wasBusy: true });
    const idle = await postControl(hub, "/api/cmd", cookie, { agentKey: "agent-beta", id: cmdId(), op: "abort" });
    expect(idle.body.data).toMatchObject({ op: "abort", wasBusy: false });
  });

  it("steer/stop subagent paths: ok, E_NOT_FOUND, E_NOT_RUNNING, alreadyTerminal, escalatedTo", async () => {
    const hub = await start({ mode: "token", scenario: "control" });
    const cookie = await loginToken(hub);
    const okSteer = await postControl(hub, "/api/cmd", cookie, {
      agentKey: "agent-alpha",
      id: cmdId(),
      op: "steer_subagent",
      runId: "r_ABC123",
      text: "hurry up",
    });
    expect(okSteer.status).toBe(200);
    expect(
      (
        await postControl(hub, "/api/cmd", cookie, {
          agentKey: "agent-alpha",
          id: cmdId(),
          op: "steer_subagent",
          runId: "r_missing_1",
          text: "hello?",
        })
      ).status,
    ).toBe(404);
    const notRunning = await postControl(hub, "/api/cmd", cookie, {
      agentKey: "agent-alpha",
      id: cmdId(),
      op: "steer_subagent",
      runId: "r_OLD_done",
      text: "too late",
    });
    expect(notRunning.status).toBe(409);
    expect(notRunning.body.error).toBe("E_NOT_RUNNING");
    const already = await postControl(hub, "/api/cmd", cookie, {
      agentKey: "agent-alpha",
      id: cmdId(),
      op: "abort_subagent",
      runId: "r_OLD_done",
    });
    expect(already.body.data).toMatchObject({ op: "abort_subagent", alreadyTerminal: true });
    const stopped = await postControl(hub, "/api/cmd", cookie, {
      agentKey: "agent-alpha",
      id: cmdId(),
      op: "abort_subagent",
      runId: "r_ABC123",
    });
    expect(stopped.body.data).toMatchObject({ op: "abort_subagent", escalatedTo: "L2" });
  });

  it("command op: unknown command 404, deny 409, confirm two-step, never falls through to text", async () => {
    const hub = await start({ mode: "token", scenario: "commands" });
    const cookie = await loginToken(hub);
    const unknown = await postControl(hub, "/api/cmd", cookie, {
      agentKey: "agent-alpha",
      id: cmdId(),
      op: "command",
      name: "nosuchcmd",
      args: "",
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe("E_UNKNOWN_COMMAND");
    const denied = await postControl(hub, "/api/cmd", cookie, {
      agentKey: "agent-alpha",
      id: cmdId(),
      op: "command",
      name: "quit",
      args: "",
    });
    expect(denied.status).toBe(409);
    expect(denied.body.error).toBe("E_COMMAND_DENIED");
    const needsConfirm = await postControl(hub, "/api/cmd", cookie, {
      agentKey: "agent-alpha",
      id: cmdId(),
      op: "command",
      name: "thirdparty-thing",
      args: "--force",
    });
    expect(needsConfirm.status).toBe(409);
    expect(needsConfirm.body.error).toBe("E_CONFIRM_REQUIRED");
    const confirmed = await postControl(hub, "/api/cmd", cookie, {
      agentKey: "agent-alpha",
      id: cmdId(),
      op: "command",
      name: "thirdparty-thing",
      args: "--force",
      confirm: true,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data).toMatchObject({ kind: "extension", completion: "unknown", captured: false });
  });

  it("command op: builtin /session sync output, busy /compact async + cmd_late, captured /agent status output", async () => {
    const hub = await start({ mode: "token", scenario: "commands" });
    const cookie = await loginToken(hub);
    const sse = await openSse(hub.port, cookie);
    await sse.waitFor("agents");

    const session = await postControl(hub, "/api/cmd", cookie, {
      agentKey: "agent-alpha",
      id: cmdId(),
      op: "command",
      name: "session",
      args: "",
    });
    expect(session.status).toBe(200);
    expect(session.body.data).toMatchObject({ kind: "builtin", completion: "sync" });
    const output = session.body.data.output as { entries: Array<{ kind: string; text: string }> };
    expect(output.entries[0]).toMatchObject({ kind: "text" });
    expect(output.entries[0]!.text).toContain("sess-alpha-1");

    // The agent is busy ⇒ /compact's policyBusy flips to confirm (§4.6 table).
    const compactBlocked = await postControl(hub, "/api/cmd", cookie, {
      agentKey: "agent-alpha",
      id: cmdId(),
      op: "command",
      name: "compact",
      args: "",
    });
    expect(compactBlocked.status).toBe(409);
    expect(compactBlocked.body.error).toBe("E_CONFIRM_REQUIRED");
    const compact = await postControl(hub, "/api/cmd", cookie, {
      agentKey: "agent-alpha",
      id: cmdId(),
      op: "command",
      name: "compact",
      args: "",
      confirm: true,
    });
    expect(compact.status).toBe(200);
    expect(compact.body.data).toMatchObject({ kind: "builtin", completion: "async" });
    const late = await sse.waitFor("cmd_late", DEV_HUB_LATE_SETTLE_MS + 3_000);
    expect(late.data).toMatchObject({ agentKey: "agent-alpha", op: "command", ok: true });

    const captured = await postControl(hub, "/api/cmd", cookie, {
      agentKey: "agent-alpha",
      id: cmdId(),
      op: "command",
      name: "agent",
      args: "status",
    });
    expect(captured.status).toBe(200);
    expect(captured.body.data).toMatchObject({ kind: "extension", completion: "sync", captured: true });
    const capOut = captured.body.data.output as { entries: Array<{ kind: string }> };
    expect(capOut.entries.some((e) => e.kind === "notify")).toBe(true);

    const template = await postControl(hub, "/api/cmd", cookie, {
      agentKey: "agent-alpha",
      id: cmdId(),
      op: "command",
      name: "daily-standup",
      args: "",
    });
    expect(template.body.data).toMatchObject({ kind: "template", completion: "unknown" });
    sse.close();
  });

  it("strict write CSRF (§6.3 D8): missing/wrong Origin or cross-site Sec-Fetch-Site → 403 E_CSRF", async () => {
    const hub = await start({ mode: "token", scenario: "control" });
    const cookie = await loginToken(hub);
    const req = { agentKey: "agent-alpha", id: cmdId(), op: "abort" };
    const noOrigin = await postRaw(hub.port, "/api/cmd", req, { ...JSON_HEADERS, Cookie: cookie });
    expect(noOrigin.status).toBe(403);
    const wrongOrigin = await postControl(
      hub,
      "/api/cmd",
      cookie,
      { ...req, id: cmdId() },
      { Origin: "http://evil.example" },
    );
    expect(wrongOrigin.status).toBe(403);
    const crossSite = await postControl(
      hub,
      "/api/cmd",
      cookie,
      { ...req, id: cmdId() },
      { "Sec-Fetch-Site": "cross-site" },
    );
    expect(crossSite.status).toBe(403);
    const sameSite = await postControl(
      hub,
      "/api/cmd",
      cookie,
      { ...req, id: cmdId() },
      { "Sec-Fetch-Site": "same-origin" },
    );
    expect(sameSite.status).toBe(200);
    const unauthed = await postControl(hub, "/api/cmd", "", { ...req, id: cmdId() });
    expect(unauthed.status).toBe(401);
  });
});

describe("dev-hub control plane — POST /api/dialog", () => {
  const single = { agentKey: "agent-alpha", dialogId: "ask:tc-single-1", epoch: "epoch-alpha-1" };

  it("first answer wins the race: 200 + dialogs SSE closed by web with the winning cmdId; second answer → 409", async () => {
    const hub = await start({ mode: "token", scenario: "ask-user" });
    const cookie = await loginToken(hub);
    const sse = await openSse(hub.port, cookie);
    await sse.waitFor("agents");
    const id = cmdId();
    const win = await postControl(hub, "/api/dialog", cookie, {
      ...single,
      id,
      action: "answer",
      answers: [{ selected: ["Plan A — rewrite"], other: null }],
    });
    expect(win.status).toBe(200);
    expect(win.body).toMatchObject({ ok: true, id });
    const frame = await sse.waitFor("dialogs");
    const data = frame.data as {
      agentKey: string;
      open: unknown[];
      closed: Array<{ dialogId: string; by: string; cmdId?: string }>;
    };
    expect(data.agentKey).toBe("agent-alpha");
    expect(data.open).toHaveLength(0);
    expect(data.closed[0]).toMatchObject({ dialogId: "ask:tc-single-1", by: "web", cmdId: id });
    const lose = await postControl(hub, "/api/dialog", cookie, {
      ...single,
      id: cmdId(),
      action: "answer",
      answers: [{ selected: ["Plan B — patch"], other: null }],
    });
    expect(lose.status).toBe(409);
    expect(lose.body).toMatchObject({ error: "E_DIALOG_CLOSED", retryable: false, effect: "none" });
    sse.close();
  });

  it("stale epoch → 409 E_DIALOG_CLOSED{stale}", async () => {
    const hub = await start({ mode: "token", scenario: "ask-user" });
    const cookie = await loginToken(hub);
    const { status, body } = await postControl(hub, "/api/dialog", cookie, {
      ...single,
      epoch: "epoch-OLD",
      id: cmdId(),
      action: "answer",
      answers: [{ selected: ["Plan A — rewrite"], other: null }],
    });
    expect(status).toBe(409);
    expect(body).toMatchObject({ error: "E_DIALOG_CLOSED", message: "stale" });
  });

  it("E_BAD_ANSWER: wrong count, unknown label, multi-value on single-select, Other when disallowed — dialog stays open", async () => {
    const hub = await start({ mode: "token", scenario: "ask-user" });
    const cookie = await loginToken(hub);
    const answer = (answers: unknown) =>
      postControl(hub, "/api/dialog", cookie, { ...single, id: cmdId(), action: "answer", answers });
    expect((await answer([])).body.error).toBe("E_BAD_ANSWER");
    expect((await answer([{ selected: ["Plan C"], other: null }])).body.error).toBe("E_BAD_ANSWER");
    expect((await answer([{ selected: ["Plan A — rewrite", "Plan B — patch"], other: null }])).body.error).toBe(
      "E_BAD_ANSWER",
    );
    const noOther = await postControl(hub, "/api/dialog", cookie, {
      agentKey: "agent-gamma",
      dialogId: "ask:tc-race-1",
      epoch: "epoch-gamma-1",
      id: cmdId(),
      action: "answer",
      answers: [{ selected: ["answer from the web"], other: "sneaky free text" }],
    });
    // gamma's race dialog may have been closed by the script (700ms) — accept either the
    // answer-validation 400 (dialog still open) or the race-lost 409, but never a 200.
    expect([400, 409]).toContain(noOther.status);
    if (noOther.status === 400) expect(noOther.body.error).toBe("E_BAD_ANSWER");
    // The single-question dialog is still open after all those failures.
    const stillOpen = await answer([{ selected: ["Plan B — patch"], other: null }]);
    expect(stillOpen.status).toBe(200);
  });

  it("multi-question dialog: full valid answer (multiSelect + Other) → 200", async () => {
    const hub = await start({ mode: "token", scenario: "ask-user" });
    const cookie = await loginToken(hub);
    const { status } = await postControl(hub, "/api/dialog", cookie, {
      agentKey: "agent-beta",
      dialogId: "ask:tc-multi-1",
      epoch: "epoch-beta-1",
      id: cmdId(),
      action: "answer",
      answers: [
        { selected: ["staging"], other: null },
        { selected: ["unit + integration green", "visual matrix green"], other: null },
        { selected: ["nothing — proceed"], other: "ship it Friday" },
      ],
    });
    expect(status).toBe(200);
  });

  it("cancel: allowed → 200 outcome cancelled; allowCancel:false → 400", async () => {
    const hub = await start({ mode: "token", scenario: "ask-user" });
    const cookie = await loginToken(hub);
    const cancel = await postControl(hub, "/api/dialog", cookie, { ...single, id: cmdId(), action: "cancel" });
    expect(cancel.status).toBe(200);
    const denied = await postControl(hub, "/api/dialog", cookie, {
      agentKey: "agent-gamma",
      dialogId: "ask:tc-race-1",
      epoch: "epoch-gamma-1",
      id: cmdId(),
      action: "cancel",
    });
    // Same script-race caveat as above: 400 (still open, cancel not allowed) or 409 (tui won).
    expect([400, 409]).toContain(denied.status);
    if (denied.status === 400) expect(denied.body.error).toBe("E_BAD_REQUEST");
  });
});

describe("dev-hub control plane — hub states + slots", () => {
  it("the hub frame carries fixture hubState: caps, supersedePending and an absolute future deadline", async () => {
    const hub = await start({ mode: "token", scenario: "hub-states" });
    const cookie = await loginToken(hub);
    const sse = await openSse(hub.port, cookie);
    const frame = await sse.waitFor("hub");
    const data = frame.data as {
      caps?: string[];
      state?: string;
      supersedePending?: boolean;
      supersedeDeadlineAt?: number;
      nextVersion?: string;
    };
    expect(data.caps).toContain("cmd.v1");
    expect(data.caps).toContain("ctl.v2");
    expect(data.state).toBe("running");
    expect(data.supersedePending).toBe(true);
    expect(data.nextVersion).toBe("1.6.0");
    expect(data.supersedeDeadlineAt).toBeGreaterThan(Date.now());
    sse.close();
  });

  it("a script hub event rebroadcasts the forced-restarting state (merged, countdown preserved)", async () => {
    const hub = await start({ mode: "token", scenario: "hub-states" });
    const cookie = await loginToken(hub);
    const sse = await openSse(hub.port, cookie);
    await sse.waitFor("hub");
    const forced = await waitFor(() =>
      sse.events.find((e) => e.event === "hub" && (e.data as { state?: string }).state === "restarting"),
    );
    const data = forced.data as { forced?: boolean; draining?: boolean; supersedeDeadlineAt?: number };
    expect(data.forced).toBe(true);
    expect(data.draining).toBe(true);
    expect(data.supersedeDeadlineAt).toBeGreaterThan(Date.now());
    sse.close();
  });

  it("subscribe delivers the fixture's dialogs/ctl/commands slots right after the history snapshot", async () => {
    const hub = await start({ mode: "token", scenario: "control" });
    const cookie = await loginToken(hub);
    const sse = await openSse(hub.port, cookie);
    const agentsFrame = await sse.waitFor("agents");
    const cards = (agentsFrame.data as { agents: Array<{ agentKey: string; dialogs?: { open: unknown[] } }> }).agents;
    expect(cards.find((c) => c.agentKey === "agent-alpha")?.dialogs).toBeUndefined(); // no dialogs in control.json
    const clientId = (sse.events.find((e) => e.event === "hello")?.data as { clientId: string }).clientId;
    await postRaw(
      hub.port,
      "/api/subscribe",
      { clientId, agentKey: "agent-alpha" },
      { ...JSON_HEADERS, Cookie: cookie },
    );
    await sse.waitFor("history");
    const ctl = await sse.waitFor("ctl");
    expect(ctl.data).toMatchObject({ agentKey: "agent-alpha", sessionId: "sess-alpha-1" });
    expect((ctl.data as { items: unknown[] }).items.length).toBeGreaterThan(0);
    sse.close();
  });

  it("the agents frame carries the dialogs slot on cards (ask-user fixture)", async () => {
    const hub = await start({ mode: "token", scenario: "ask-user" });
    const cookie = await loginToken(hub);
    const sse = await openSse(hub.port, cookie);
    const agentsFrame = await sse.waitFor("agents");
    const cards = (
      agentsFrame.data as { agents: Array<{ agentKey: string; dialogs?: { open: Array<{ dialogId: string }> } }> }
    ).agents;
    const alpha = cards.find((c) => c.agentKey === "agent-alpha");
    expect(alpha?.dialogs?.open[0]?.dialogId).toBe("ask:tc-single-1");
    sse.close();
  });
});

describe("dev-hub control plane — password mode", () => {
  it("/api/cmd works with the LAN write gate: Origin required, 200 with it, 403 without", async () => {
    const hub = await start({ mode: "password", scenario: "control" });
    const cookie = await loginPassword(hub);
    const ok = await postControl(hub, "/api/cmd", cookie, { agentKey: "agent-alpha", id: cmdId(), op: "abort" });
    expect(ok.status).toBe(200);
    const noOrigin = await postRaw(
      hub.port,
      "/api/cmd",
      { agentKey: "agent-alpha", id: cmdId(), op: "abort" },
      { ...JSON_HEADERS, Cookie: cookie },
    );
    expect(noOrigin.status).toBe(403);
    const crossSite = await postControl(
      hub,
      "/api/cmd",
      cookie,
      { agentKey: "agent-alpha", id: cmdId(), op: "abort" },
      { "Sec-Fetch-Site": "cross-site" },
    );
    expect(crossSite.status).toBe(403);
  });
});

describe("checks-control.ts framework — pure helpers", () => {
  it("isControlScenario gates exactly the four C6 scenarios", () => {
    for (const s of ["control", "ask-user", "commands", "hub-states"]) expect(isControlScenario(s)).toBe(true);
    for (const s of ["dashboard", "detail", "login", "states", "long", ""]) expect(isControlScenario(s)).toBe(false);
    expect([...CONTROL_SCENARIOS].sort()).toEqual(["ask-user", "commands", "control", "hub-states"]);
  });

  it("isControlApiPath matches only the two write endpoints", () => {
    expect(isControlApiPath("http://127.0.0.1:1/api/cmd")).toBe(true);
    expect(isControlApiPath("http://127.0.0.1:1/api/dialog")).toBe(true);
    expect(isControlApiPath("http://127.0.0.1:1/api/cmd/extra")).toBe(false);
    expect(isControlApiPath("http://127.0.0.1:1/api/events")).toBe(false);
    expect(isControlApiPath("not a url")).toBe(false);
  });

  it("action/axe cell gating picks one representative cell per theme rule", () => {
    expect(isControlActionCell("control", 1024, false, "light")).toBe(true);
    expect(isControlActionCell("control", 1024, true, "light")).toBe(false);
    expect(isControlActionCell("control", 1024, false, "dark")).toBe(false);
    expect(isControlActionCell("control", 375, false, "light")).toBe(false);
    expect(isControlActionCell("dashboard", 1024, false, "light")).toBe(false);
    expect(isControlAxeCell("ask-user", 375, true)).toBe(true);
    expect(isControlAxeCell("ask-user", 1024, false)).toBe(true);
    expect(isControlAxeCell("ask-user", 1024, true)).toBe(false);
    expect(isControlAxeCell("ask-user", 768, false)).toBe(false);
    expect(isControlAxeCell("dashboard", 375, true)).toBe(false);
  });

  it("the selector contract names every component family C5 must render", () => {
    for (const key of [
      "composer",
      "stopButton",
      "queueList",
      "controlNotice",
      "topbarControlChip",
      "topbarReadonlyChip",
      "askUserForm",
      "askUserTab",
      "askUserOther",
      "askUserSubmit",
      "hubStateBanner",
      "commandPalette",
      "commandResult",
      "dock",
      "transcriptItem",
    ] as const) {
      expect(typeof CONTROL_SELECTORS[key]).toBe("string");
      expect(CONTROL_SELECTORS[key].length).toBeGreaterThan(0);
    }
  });
});
