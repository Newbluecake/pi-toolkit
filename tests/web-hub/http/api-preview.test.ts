/**
 * web-hub content-preview — PV3 loopback HTTP tests (`/api/preview` through the REAL
 * `createHttpFrontend`, plan v3 §4.7 matrix + §6 PV3 acceptance).
 *
 * Covers: the §4.7 loopback matrix row-by-row incl. the not-enabled (off) byte-identical
 * fallback (HP5); the full 200 flow and its response headers (CSP untouched); the three CSRF
 * rejections; 400/404/409; 429 + throttled audit + cmd-bucket isolation (§7-D14); the
 * in-flight 503; and the HP8 upload-tamper hard gate over a REAL `createUploadStore` with
 * hand-crafted committed records (PV2b's `craft` pattern).
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PREVIEW_PATH, PREVIEW_TEXT_MAX_BYTES } from "../../../src/web-hub/protocol/preview.js";
import { webHubUploadsDir } from "../../../src/web-hub/protocol/paths.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { createPreviewRoutes } from "../../../src/web-hub/hub/preview/routes.js";
import { createUploadStore, type UploadMetaV1, type UploadStore } from "../../../src/web-hub/hub/uploads.js";
import { PREVIEW_AUDIT_KEYS } from "../../../src/web-hub/hub/audit.js";
import type { FrontendDeps, HttpFrontend, PreviewRoutes } from "../../../src/web-hub/hub/ports.js";
import type { CmdFrame, CmdResultFrame } from "../../../src/web-hub/protocol/messages.js";
import type { AgentView } from "../../../src/web-hub/hub/ports.js";
import {
  fakeDeps,
  login,
  makeAgent,
  makeTmp,
  postJson,
  rawRequest,
  type FakeDeps,
  type RawResponse,
} from "./helpers.js";
import { memLog } from "../hub/helpers.js";

const AGENT = "a4242-nonce12";
const SESSION = "sess123";
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function pngBytes(w: number, h: number, pad = 0): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "ascii");
  head.writeUInt32BE(w, 16);
  head.writeUInt32BE(h, 20);
  return Buffer.concat([head, Buffer.alloc(pad)]);
}

interface Crafted {
  path: string;
  meta: UploadMetaV1;
  bytes: Buffer;
}

/** PV2b's `craft` pattern: lay down a committed upload by hand (`<root>/<bucket>/<id>/<id>.<ext>` + meta.json). */
function craft(root: string, bytes: Buffer, over: { name?: string } = {}): Crafted {
  const bucket = `s-${SESSION}`;
  const id = `upid${randomBytes(6).toString("hex")}`;
  const dir = join(root, bucket, id);
  mkdirSync(dir, { recursive: true });
  const diskName = `${id}.bin`;
  writeFileSync(join(dir, diskName), bytes);
  const meta: UploadMetaV1 = {
    v: 1,
    id,
    principal: "loopback:token",
    agentKey: AGENT,
    bucket,
    safeName: over.name ?? "upload.bin",
    diskName,
    size: bytes.length,
    mime: null,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    committedAt: Date.now(),
    referencedAt: null,
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  return { path: join(dir, diskName), meta, bytes };
}

/** Collects a response that may end truncated (HP8): resolves on end OR socket error, reporting
 * exactly how many body bytes arrived and whether the stream completed cleanly. */
function rawCollect(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; onData?: (n: number) => void },
): Promise<{ status: number; headers: IncomingMessage["headers"]; bytes: Buffer; cleanEnd: boolean }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path,
        headers: opts.headers ?? {},
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => {
          chunks.push(c);
          opts.onData?.(c.length);
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes: Buffer.concat(chunks), cleanEnd: true }),
        );
        res.on("error", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes: Buffer.concat(chunks), cleanEnd: false }),
        );
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error("request timeout")));
    req.on("error", (err) => {
      if (chunksInProgress(resolve)) return;
      reject(err);
    });
    req.end();
  });

  function chunksInProgress(resolve: unknown): boolean {
    return resolve === undefined;
  }
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface Harness {
  tmp: ReturnType<typeof makeTmp>;
  deps: FakeDeps;
  fe: HttpFrontend;
  port: number;
  cookie: string;
  cwd: string;
  routes: PreviewRoutes | undefined;
  store: UploadStore | undefined;
  uploadsRoot: string;
  previewLog: ReturnType<typeof memLog>;
  file(rel: string, content: string | Buffer): string;
  get(agentKey?: string, sessionId?: string, p?: string, headers?: Record<string, string>): Promise<RawResponse>;
  cleanup(): Promise<void>;
}

function previewDeps(
  deps: FakeDeps,
  cwd: string,
  uploadsRoot: string,
  store: UploadStore | undefined,
  log: ReturnType<typeof memLog>,
): PreviewRoutes {
  return createPreviewRoutes({
    mode: "on",
    home: deps.config.home,
    uploadsRoot,
    registry: deps.registry,
    log,
    now: deps.now,
    ...(store === undefined ? {} : { uploads: { openForPreview: (p, ctx) => store.openForPreview(p, ctx) } }),
  });
}

async function setup(
  opts: {
    preview?: boolean;
    withStore?: boolean;
    commands?: boolean;
    /** runs AFTER dirs/deps/agents are prepared but BEFORE `createHttpFrontend` — the place to
     * craft upload records and build the store, so the preview routes wired into the frontend
     * see them (the frontend captures `deps.preview` once, at construction). */
    beforeFrontend?: (ctx: {
      cwd: string;
      uploadsRoot: string;
      setStore(store: UploadStore): void;
      setNoPreview(): void;
    }) => Promise<void>;
  } = {},
): Promise<Harness> {
  const tmp = makeTmp("pwh-preview-");
  const deps = fakeDeps(tmp.dir);
  const cwd = join(tmp.dir, "cwd");
  mkdirSync(cwd, { recursive: true });
  const uploadsRoot = webHubUploadsDir(tmp.dir);
  const previewLog = memLog();
  const agents = deps.agents;
  agents.set(
    AGENT,
    makeAgent(AGENT, {
      control: opts.commands === true,
      session: { sessionId: SESSION, cwd, reason: "test", leafId: null, mode: "tui" },
    } as Partial<AgentView>),
  );
  let store: UploadStore | undefined;
  if (opts.withStore !== false && opts.beforeFrontend === undefined) {
    store = createUploadStore({ root: uploadsRoot, now: deps.now, log: previewLog, audit: () => {} });
    await store.recover();
  }
  if (opts.beforeFrontend !== undefined) {
    await opts.beforeFrontend({
      cwd,
      uploadsRoot,
      setStore: (s: UploadStore): void => {
        store = s;
      },
    });
  }
  let routes: PreviewRoutes | undefined;
  if (opts.preview !== false) {
    routes = previewDeps(deps, cwd, uploadsRoot, store, previewLog);
    deps.preview = routes;
  }
  if (opts.commands === true) {
    deps.commands = {
      request: (frame: CmdFrame): Promise<CmdResultFrame> =>
        Promise.resolve({ t: "cmd_result", rid: frame.rid, id: frame.id, ok: true, data: {} }),
      drain: async () => ({ inflight: 0, timedOut: false }),
      inflight: () => 0,
    };
  }
  const fe = createHttpFrontend(deps);
  const port = (await fe.listen()).port;
  const cookie = await login(port, deps.paths.tokenFile);
  const qs = (agentKey: string, sessionId: string, p: string): string =>
    `${PREVIEW_PATH}?agentKey=${encodeURIComponent(agentKey)}&sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(p)}`;
  return {
    tmp,
    deps,
    fe,
    port,
    cookie,
    cwd,
    routes,
    store,
    uploadsRoot,
    previewLog,
    file(rel: string, content: string | Buffer): string {
      const p = join(cwd, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content);
      return p;
    },
    get(agentKey = AGENT, sessionId = SESSION, p = "/x/y", headers: Record<string, string> = {}): Promise<RawResponse> {
      return rawRequest(port, {
        method: "GET",
        path: qs(agentKey, sessionId, p),
        headers: { "X-PWH": "1", Cookie: cookie, ...headers },
      });
    },
    async cleanup(): Promise<void> {
      await fe.close();
      await store?.close();
      tmp.cleanup();
    },
  };
}

const harnesses: Harness[] = [];
async function harness(opts: Parameters<typeof setup>[0] = {}): Promise<Harness> {
  const h = await setup(opts);
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// §4.7 matrix (HP5) — loopback rows
// ---------------------------------------------------------------------------

describe("loopback /api/preview — §4.7 matrix (HP5)", () => {
  it("mode off (deps.preview absent): unauth ⇒ 401, authed ⇒ 404 — byte-identical to 现状", async () => {
    const h = await harness({ preview: false });
    const unauth = await rawRequest(h.port, { method: "GET", path: PREVIEW_PATH });
    expect(unauth.status).toBe(401);
    expect(unauth.body).toBe('{"error":"E_AUTH"}');

    const authed = await h.get();
    expect(authed.status).toBe(404);
    expect(authed.body).toBe('{"error":"E_NOT_FOUND"}');
  });

  it("mode on: no X-PWH ⇒ 403 E_CSRF regardless of auth", async () => {
    const h = await harness();
    const noHeader = await rawRequest(h.port, { method: "GET", path: PREVIEW_PATH, headers: { Cookie: h.cookie } });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body).toBe('{"error":"E_CSRF"}');
    const noHeaderUnauth = await rawRequest(h.port, { method: "GET", path: PREVIEW_PATH });
    expect(noHeaderUnauth.status).toBe(403); // CSRF gate precedes auth on both auth states
    expect(noHeaderUnauth.body).toBe('{"error":"E_CSRF"}');
  });

  it("mode on: X-PWH + unauthenticated ⇒ 401 (authorize owns the reply)", async () => {
    const h = await harness();
    const r = await rawRequest(h.port, { method: "GET", path: PREVIEW_PATH, headers: { "X-PWH": "1" } });
    expect(r.status).toBe(401);
    expect(r.body).toBe('{"error":"E_AUTH"}');
  });

  it("mode on: X-PWH + authed ⇒ dispatched (a cwd file serves 200)", async () => {
    const h = await harness();
    const p = h.file("ok.txt", "matrix");
    const r = await h.get(AGENT, SESSION, p);
    expect(r.status).toBe(200);
    expect(r.body).toBe("matrix");
  });

  it("non-GET is never dispatched: POST falls through to the original paths (= 现状)", async () => {
    const h = await harness();
    const noCsrf = await rawRequest(h.port, { method: "POST", path: PREVIEW_PATH, headers: { Cookie: h.cookie } });
    expect(noCsrf.status).toBe(403); // the generic loopback CSRF gate, unchanged
    const withCsrf = await postJson(h.port, PREVIEW_PATH, {}, { Cookie: h.cookie });
    expect(withCsrf.status).toBe(404); // POST branch: unknown path after auth
  });
});

// ---------------------------------------------------------------------------
// full flow + headers
// ---------------------------------------------------------------------------

describe("loopback /api/preview — 200 flow and headers", () => {
  it("text: exact bytes + the full header set (CSP untouched, no-store, attachment, CORP)", async () => {
    const h = await harness();
    const content = "line1\n中文行\nline3";
    const p = h.file("doc.md", content);
    const r = await h.get(AGENT, SESSION, p);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(r.headers["x-pwh-preview-kind"]).toBe("text");
    expect(r.headers["x-pwh-preview-size"]).toBe(String(Buffer.byteLength(content)));
    expect(r.headers["x-pwh-preview-truncated"]).toBe("0");
    expect(r.headers["content-length"]).toBe(String(Buffer.byteLength(content)));
    expect(r.headers["content-disposition"]).toBe('attachment; filename="preview"');
    expect(r.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(r.headers["content-security-policy"]).toBe(CSP);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toBe(content);
  });

  it("image: dims header, image Content-Type, raw bytes", async () => {
    const h = await harness();
    const bytes = pngBytes(640, 480, 1024);
    const p = h.file("pic.png", bytes);
    const r = await rawCollect(h.port, {
      path: `${PREVIEW_PATH}?agentKey=${AGENT}&sessionId=${SESSION}&path=${encodeURIComponent(p)}`,
      headers: { "X-PWH": "1", Cookie: h.cookie },
    });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.headers["x-pwh-preview-kind"]).toBe("image");
    expect(r.headers["x-pwh-preview-dims"]).toBe("640x480");
    expect(r.bytes.equals(bytes)).toBe(true);
    expect(r.cleanEnd).toBe(true);
  });

  it("oversized text serves truncated (X-PWH-Preview-Truncated: 1, exactly 256 KiB)", async () => {
    const h = await harness();
    const p = h.file("big.txt", "a".repeat(PREVIEW_TEXT_MAX_BYTES + 50));
    const r = await h.get(AGENT, SESSION, p);
    expect(r.status).toBe(200);
    expect(r.headers["x-pwh-preview-truncated"]).toBe("1");
    expect(Buffer.byteLength(r.body)).toBe(PREVIEW_TEXT_MAX_BYTES);
  });
});

// ---------------------------------------------------------------------------
// CSRF / params / session errors
// ---------------------------------------------------------------------------

describe("loopback /api/preview — CSRF, params, session", () => {
  it("CSRF: wrong Origin ⇒ 403; Sec-Fetch-Site: cross-site ⇒ 403", async () => {
    const h = await harness();
    const origin = await h.get(AGENT, SESSION, "/x/y", { Origin: "http://evil.example" });
    expect(origin.status).toBe(403);
    const sfs = await h.get(AGENT, SESSION, "/x/y", { "Sec-Fetch-Site": "cross-site" });
    expect(sfs.status).toBe(403);
  });

  it("bad params ⇒ 400; unknown agent ⇒ 404; session mismatch ⇒ 409", async () => {
    const h = await harness();
    const bad = await h.get("bad/key", SESSION, "/x/y");
    expect(bad.status).toBe(400);
    expect(bad.body).toBe('{"error":"E_BAD_REQUEST"}');

    const ghost = await h.get("ghost", SESSION, "/x/y");
    expect(ghost.status).toBe(404);

    const changed = await h.get(AGENT, "other-session", "/x/y");
    expect(changed.status).toBe(409);
    expect(changed.body).toBe('{"error":"E_SESSION_CHANGED"}');
  });
});

// ---------------------------------------------------------------------------
// ④ rate limit + in-flight + audit
// ---------------------------------------------------------------------------

describe("loopback /api/preview — ④ rate limit, in-flight, audit discipline", () => {
  it("21st burst request ⇒ 429 + Retry-After; exactly ONE E_RATE preview audit line (throttled)", async () => {
    // standalone frontend with a FROZEN routes clock: under full-suite parallel load 21 real
    // requests can exceed the 250ms refill window and hand a token back — freezing `now` makes
    // the burst deterministic (no fs is touched on this path: ④ fires before the registry 404).
    const tmp = mkdtempSync(join(tmpdir(), "pwh-preview-rate-"));
    try {
      const deps = fakeDeps(tmp);
      const log = memLog();
      const t0 = Date.now();
      const routes = createPreviewRoutes({
        mode: "on",
        home: tmp,
        uploadsRoot: webHubUploadsDir(tmp),
        registry: deps.registry,
        log,
        now: () => t0,
      });
      deps.preview = routes;
      const fe = createHttpFrontend(deps);
      const port = (await fe.listen()).port;
      const cookie = await login(port, deps.paths.tokenFile);
      const run = async (): Promise<RawResponse> =>
        rawRequest(port, {
          method: "GET",
          path: `${PREVIEW_PATH}?agentKey=ghost&sessionId=${SESSION}&path=${encodeURIComponent("/x/y")}`,
          headers: { "X-PWH": "1", Cookie: cookie },
        });
      for (let i = 0; i < 20; i++) {
        const r = await run();
        expect(r.status).toBe(404);
      }
      const rejected = await run();
      expect(rejected.status).toBe(429);
      expect(rejected.body).toBe('{"error":"E_RATE"}');
      expect(Number(rejected.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      await run();
      await run();
      const rates = log.lines.filter(
        (l) => l.msg === "preview" && (l.data as Record<string, unknown>)?.["code"] === "E_RATE",
      );
      expect(rates).toHaveLength(1);
      await fe.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a preview 429 never bleeds into the cmd line's bucket (§7-D14)", async () => {
    const h = await harness({ commands: true });
    for (let i = 0; i < 21; i++) await h.get("ghost", SESSION, "/x/y");
    const cmd = await postJson(
      h.port,
      "/api/cmd",
      { agentKey: AGENT, id: randomBytes(12).toString("hex"), op: "abort" },
      { Cookie: h.cookie, Origin: `http://127.0.0.1:${h.port}` },
    );
    expect(cmd.status).toBe(200); // admitted — preview's limiter is a private instance
  });

  it("3rd concurrent in-flight request of the principal ⇒ 503 E_BUSY", async () => {
    // a store whose openForPreview parks until released: two parked + a third ⇒ 503
    const tmp = mkdtempSync(join(tmpdir(), "pwh-preview-busy-"));
    try {
      const deps = fakeDeps(tmp);
      const cwd = join(tmp, "cwd");
      mkdirSync(cwd, { recursive: true });
      const uploadsRoot = webHubUploadsDir(tmp);
      const log = memLog();
      deps.agents.set(
        AGENT,
        makeAgent(AGENT, {
          session: { sessionId: SESSION, cwd, reason: "t", leafId: null, mode: "tui" },
        } as Partial<AgentView>),
      );
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const hanging: Pick<UploadStore, "openForPreview"> = {
        openForPreview: (_p, ctx) =>
          new Promise((resolve) => {
            const onAbort = (): void => resolve({ ok: false, code: "E_DEADLINE" });
            if (ctx.signal.aborted) return onAbort();
            ctx.signal.addEventListener("abort", onAbort, { once: true });
            void gate.then(() => resolve({ ok: false, code: "E_NOT_FOUND" }));
          }),
      };
      const routes = createPreviewRoutes({
        mode: "on",
        home: tmp,
        uploadsRoot,
        registry: deps.registry,
        log,
        now: deps.now,
        uploads: hanging,
      });
      deps.preview = routes;
      const fe = createHttpFrontend(deps);
      const port = (await fe.listen()).port;
      const cookie = await login(port, deps.paths.tokenFile);
      const path = `${PREVIEW_PATH}?agentKey=${AGENT}&sessionId=${SESSION}&path=${encodeURIComponent(`${uploadsRoot}/s/x/f`)}`;
      const start = (): Promise<RawResponse> => rawRequest(port, { path, headers: { "X-PWH": "1", Cookie: cookie } });
      const parked = [start(), start()];
      await sleep(80);
      const third = await start();
      expect(third.status).toBe(503);
      expect(third.body).toBe('{"error":"E_BUSY"}');
      release();
      for (const p of parked) await expect(p).resolves.toMatchObject({ status: 404 });
      await fe.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("audit lines are whitelisted (PREVIEW_AUDIT_KEYS) and never carry the raw path", async () => {
    const h = await harness();
    const secret = h.file("very-secret-filename.txt", "top secret content");
    const r = await h.get(AGENT, SESSION, secret);
    expect(r.status).toBe(200);
    const lines = h.previewLog.lines.filter((l) => l.msg === "preview");
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      const data = (l.data ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(data)) {
        if (key === "audit") continue;
        expect((PREVIEW_AUDIT_KEYS as readonly string[]).includes(key)).toBe(true);
      }
    }
    const dump = JSON.stringify(h.previewLog.lines);
    expect(dump.includes("very-secret-filename")).toBe(false);
    expect(dump.includes("top secret content")).toBe(false);
    expect(dump.includes(secret)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HP8 — upload tampering through the real store
// ---------------------------------------------------------------------------

describe("loopback /api/preview — HP8 upload tampering (real store)", () => {
  /**
   * Craft first, THEN build+recover a store over the root inside `beforeFrontend`: a second
   * `recover()` on a live store returns the stale scan promise (it never rescans), and the
   * frontend captures `deps.preview` once at construction — so both the records and the store
   * must exist before `createHttpFrontend` runs. `mk(harnessOpts, craftFn)` returns whatever the
   * craft callback produced.
   */
  async function mk<T>(
    craftFn: (uploadsRoot: string) => T,
    opts: Parameters<typeof setup>[0] = {},
  ): Promise<{ h: Harness; made: T }> {
    let made!: T;
    const h = await harness({
      ...opts,
      beforeFrontend: async (ctx) => {
        made = craftFn(ctx.uploadsRoot);
        const store = createUploadStore({ root: ctx.uploadsRoot, now: Date.now, log: memLog(), audit: () => {} });
        await store.recover();
        ctx.setStore(store);
      },
    });
    return { h, made };
  }

  it("cold cache: a crafted image serves a complete 200 with the exact bytes", async () => {
    const bytes = pngBytes(20, 10, 2048);
    const { h, made } = await mk((root) => craft(root, bytes));
    const r = await rawCollect(h.port, {
      path: `${PREVIEW_PATH}?agentKey=${AGENT}&sessionId=${SESSION}&path=${encodeURIComponent(made.path)}`,
      headers: { "X-PWH": "1", Cookie: h.cookie },
    });
    expect(r.status).toBe(200);
    expect(r.headers["x-pwh-preview-kind"]).toBe("image");
    expect(r.bytes.equals(bytes)).toBe(true);
    expect(r.cleanEnd).toBe(true);
  });

  it("warm identity cache + chmod ⇒ still a complete 200 — text (ctimeMs moved ⇒ cache misses, single-flight re-verifies) AND image (streamed hash unchanged)", async () => {
    // chmod moves ctimeMs, so the identity cache MISSES on the second read: the text path
    // falls through to a fresh single-flight whole-file hash (same digest ⇒ 200), the image
    // path never reads the cache at all (it hashes while streaming; pre/post stats inside the
    // one request are consistent). Both classes must still serve a COMPLETE 200.
    const txtBytes = Buffer.from("warm cache text");
    const imgBytes = pngBytes(20, 10, 512);
    let txt: Crafted | undefined;
    const { h, made } = await mk((root) => {
      txt = craft(root, txtBytes);
      return craft(root, imgBytes);
    });
    const t1 = await h.get(AGENT, SESSION, txt.path);
    expect(t1.status).toBe(200);
    chmodSync(txt.path, 0o400);
    const t2 = await h.get(AGENT, SESSION, txt.path);
    expect(t2.status).toBe(200);
    expect(t2.body).toBe("warm cache text");

    const i1 = await rawCollect(h.port, {
      path: `${PREVIEW_PATH}?agentKey=${AGENT}&sessionId=${SESSION}&path=${encodeURIComponent(made.path)}`,
      headers: { "X-PWH": "1", Cookie: h.cookie },
    });
    expect(i1.status).toBe(200);
    chmodSync(made.path, 0o400);
    const i2 = await rawCollect(h.port, {
      path: `${PREVIEW_PATH}?agentKey=${AGENT}&sessionId=${SESSION}&path=${encodeURIComponent(made.path)}`,
      headers: { "X-PWH": "1", Cookie: h.cookie },
    });
    expect(i2.status).toBe(200);
    expect(i2.bytes.equals(imgBytes)).toBe(true);
    expect(i2.cleanEnd).toBe(true);
  });

  it("content AND size changed ⇒ text 409 E_PREVIEW_CHANGED (size re-check, head never sent)", async () => {
    const { h, made } = await mk((root) => craft(root, Buffer.from("original text")));
    writeFileSync(made.path, "much longer replacement content that changes size");
    const r = await h.get(AGENT, SESSION, made.path);
    expect(r.status).toBe(409);
    expect(r.body).toBe('{"error":"E_PREVIEW_CHANGED"}');
  });

  it("same-size content flip on an image ⇒ 200 head but the body is NEVER complete (destroy)", async () => {
    const bytes = pngBytes(64, 64, 512 * 1024);
    const { h, made } = await mk((root) => craft(root, bytes));
    const flipped = Buffer.from(bytes);
    flipped[flipped.length - 10] ^= 0xff;
    let rewrote = false;
    const r = await rawCollect(h.port, {
      path: `${PREVIEW_PATH}?agentKey=${AGENT}&sessionId=${SESSION}&path=${encodeURIComponent(made.path)}`,
      headers: { "X-PWH": "1", Cookie: h.cookie },
      onData: () => {
        if (rewrote) return;
        rewrote = true;
        writeFileSync(made.path, flipped); // same size — passes the recorded-size re-check
      },
    });
    expect(r.status).toBe(200); // the head went out...
    const declared = Number(r.headers["content-length"]);
    expect(r.bytes.length).toBeLessThan(declared); // ...but the body ends short (destroy)
    expect(r.cleanEnd).toBe(false);
  });

  it("mid-stream rewrite of a big image ⇒ body incomplete", async () => {
    const bytes = pngBytes(1200, 900, 2 * 1024 * 1024); // ~2 MiB
    const { h, made } = await mk((root) => craft(root, bytes));
    const evil = Buffer.from(bytes);
    evil[24 + 12345] ^= 0x5a;
    let rewrote = false;
    const r = await rawCollect(h.port, {
      path: `${PREVIEW_PATH}?agentKey=${AGENT}&sessionId=${SESSION}&path=${encodeURIComponent(made.path)}`,
      headers: { "X-PWH": "1", Cookie: h.cookie },
      onData: () => {
        if (rewrote) return;
        rewrote = true;
        writeFileSync(made.path, evil); // same size, different digest
      },
    });
    expect(r.status).toBe(200);
    expect(r.bytes.length).toBeLessThan(bytes.length);
    expect(r.cleanEnd).toBe(false);
  });

  it("mid-stream SIZE change on an image ⇒ body incomplete (identity-changed destroy)", async () => {
    const bytes = pngBytes(32, 32, 256 * 1024);
    const { h, made } = await mk((root) => craft(root, bytes));
    const bigger = Buffer.concat([bytes, Buffer.alloc(64 * 1024, 7)]);
    let rewrote = false;
    const r = await rawCollect(h.port, {
      path: `${PREVIEW_PATH}?agentKey=${AGENT}&sessionId=${SESSION}&path=${encodeURIComponent(made.path)}`,
      headers: { "X-PWH": "1", Cookie: h.cookie },
      onData: () => {
        if (rewrote) return;
        rewrote = true;
        writeFileSync(made.path, bigger); // content AND size both changed mid-stream
      },
    });
    expect(r.status).toBe(200); // the head went out with the OLD Content-Length...
    const declared = Number(r.headers["content-length"]);
    expect(r.bytes.length).toBeLessThan(declared); // ...but the post-stat identity ends it early
    expect(r.cleanEnd).toBe(false);
  });

  it("legacy-layout upload (pre-rework meta, <id>/<safeName>) still previews after recover()", async () => {
    const bytes = Buffer.from("legacy body");
    const bucket = `s-${SESSION}`;
    const id = `upid${randomBytes(6).toString("hex")}`;
    const legacy = (root: string): Crafted => {
      const dir = join(root, bucket, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "legacy-name.txt"), bytes); // legacy: <id>/<safeName>
      const meta: UploadMetaV1 = {
        v: 1,
        id,
        principal: "loopback:token",
        agentKey: AGENT,
        bucket,
        safeName: "legacy-name.txt",
        size: bytes.length,
        mime: null,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        committedAt: Date.now(),
        referencedAt: null,
      };
      writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
      return { path: join(dir, "legacy-name.txt"), meta, bytes };
    };
    const { h, made } = await mk(legacy);
    const r = await h.get(AGENT, SESSION, made.path);
    expect(r.status).toBe(200);
    expect(r.body).toBe("legacy body");
  });
});
