/**
 * web-hub content-preview — PV3 LAN HTTP tests (plan v3 §4.7 LAN rows + §6 PV3 acceptance).
 *
 * A real LAN listener (lan-helpers' harness shape, real net-hosts/conn-guard + fake store/KDF)
 * with the preview routes wired through `deps.preview`. Covers: the default `mode:"on"` rows
 * (no X-PWH ⇒ 403, X-PWH+unauth ⇒ 401, X-PWH+authed ⇒ dispatched); HP4 (`mode:"loopback"` ⇒
 * LAN answers 404 byte-identically to not-enabled); U3 session-visible sharing (alice and bob
 * both read alice's upload in the same session — bob's audit line carries `shared:true` — while
 * bob naming a different session gets 404); the LAN 4 MiB image cap; home-as-cwd (U2: a normal
 * file serves 200, `~/.ssh/config` is denylisted 403); and a readonly agent's cwd-class read.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeKdf, fakeLanStore } from "../contract/fakes.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { createScope } from "../../../src/web-hub/hub/lifecycle.js";
import { createHostsPort } from "../../../src/web-hub/hub/net-hosts.js";
import { createKdfAdmission } from "../../../src/web-hub/hub/kdf-admission.js";
import { createLoginLimiter } from "../../../src/web-hub/hub/ratelimit.js";
import { createPreviewRoutes } from "../../../src/web-hub/hub/preview/routes.js";
import { denyCtxOf } from "../../../src/web-hub/hub/preview/admit.js";
import { createUploadStore, type UploadMetaV1 } from "../../../src/web-hub/hub/uploads.js";
import { PREVIEW_PATH, PREVIEW_IMAGE_MAX_BYTES } from "../../../src/web-hub/protocol/preview.js";
import { PROTO } from "../../../src/web-hub/protocol/version.js";
import type {
  AgentView,
  HubEvent,
  HubLanConfig,
  HttpFrontend,
  LanStatus,
  PreviewRoutes,
} from "../../../src/web-hub/hub/ports.js";
import type { UploadStore } from "../../../src/web-hub/hub/uploads.js";
import { testHubPaths } from "../helpers/paths.js";
import { captureLog, makeAgent, type LogLine } from "./helpers.js";

/** Bounded poll: the preview route's audit line is written in its request `finally` (routes.ts
 *  ① answer → ② fd close → ③/④ bookkeeping → ⑤ audit), AFTER `entry.done` (the response) has
 *  already been sent — so a client that just finished reading its response can race ahead of the
 *  server's own cleanup and audit write. Poll instead of reading the captured log immediately. */
async function waitUntil(pred: () => boolean, timeoutMs = 4_000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
import { lanPostJson, lanRequest, seedLanUser, type RawResponse } from "./lan-helpers.js";

const AGENT = "a4242-nonce12";
const SESSION = "sess123";
const OTHER_SESSION = "sess999";

function pngBytes(w: number, h: number, pad = 0): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "ascii");
  head.writeUInt32BE(w, 16);
  head.writeUInt32BE(h, 20);
  return Buffer.concat([head, Buffer.alloc(pad)]);
}

interface LanPreviewHarness {
  fe: HttpFrontend;
  port: number;
  cookieFor(id: number, username: string): Promise<string>;
  cwd: string;
  home: string;
  uploadsRoot: string;
  routes: PreviewRoutes;
  previewLines(): Array<Record<string, unknown>>;
  file(rel: string, content: string | Buffer): string;
  cleanup(): Promise<void>;
}

let dir: string;
let store: UploadStore | undefined;
let logLines: LogLine[];

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr !== null && typeof addr === "object" ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function startHarness(
  opts: {
    mode?: "on" | "loopback";
    cwdInHome?: boolean;
    withStore?: boolean;
    /** §4.7's LAN `off` row: `deps.preview` entirely absent — the exact wire state PV1 leaves
     * when `webHub.preview === "off"` (HubConfig.preview is the key's absence). */
    previewOff?: boolean;
    /** runs after the dirs exist but BEFORE the store is built+recovered and the frontend is
     * constructed — the place to craft committed uploads (they must be on disk before the
     * store's one-shot recover scan, and the store must exist before `deps.preview` is wired). */
    prepare?: (ctx: { cwd: string; uploadsRoot: string }) => void;
  } = {},
): Promise<LanPreviewHarness> {
  const mode = opts.mode ?? "on";
  const clock = { now: () => Date.now() };
  dir = mkdtempSync(join(tmpdir(), "pwh-lan-preview-"));
  const log = captureLog();
  logLines = log.lines;
  const lanStore = fakeLanStore();
  const kdf = fakeKdf();
  const limiter = createLoginLimiter({ now: clock.now });
  const admission = createKdfAdmission({ now: clock.now, isTightened: limiter.isTightened });
  const hosts = createHostsPort();
  const scope = createScope({ log, now: clock.now });
  const cwd = opts.cwdInHome === true ? dir : join(dir, "cwd");
  mkdirSync(cwd, { recursive: true });
  const agents = new Map<string, AgentView>();
  agents.set(
    AGENT,
    makeAgent(AGENT, {
      kind: "tui", // a plain (readonly-ish) agent — §5.1: preview needs no cmd.v1
      session: { sessionId: SESSION, cwd, reason: "t", leafId: null, mode: "tui" },
    }),
  );
  const uploadsRoot = join(dir, "uploads");
  opts.prepare?.({ cwd, uploadsRoot });
  if (opts.withStore === true) {
    store = createUploadStore({ root: uploadsRoot, now: clock.now, log, audit: () => {} });
    await store.recover();
  }
  const subs = new Set<(e: HubEvent) => void>();
  const cfg: HubLanConfig = { port: await freePort(), extraHosts: [], trustProxyFrom: [], externalOrigins: [] };
  let lastStatus: LanStatus = { state: "starting" };

  let routes: PreviewRoutes | undefined;
  if (opts.previewOff !== true) {
    routes = createPreviewRoutes({
      mode,
      denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
      uploadsRoot,
      registry: { list: () => [...agents.values()], get: (k) => agents.get(k) },
      ...(store === undefined ? {} : { uploads: { openForPreview: (p, ctx) => store!.openForPreview(p, ctx) } }),
      log,
      now: clock.now,
    });
  }

  const fe = createHttpFrontend({
    config: { v: 1, home: dir, port: 0, idleExitMinutes: 10, pluginVersion: "0.0.0-test", buildId: "b1" },
    paths: testHubPaths(join(dir, "state")),
    registry: { list: () => [...agents.values()], get: (k) => agents.get(k) },
    bus: {
      subscribe: (fn) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
    },
    history: {
      snapshot: async (agentKey: string) => ({
        agentKey,
        entries: [],
        tailMessages: [],
        fromSeq: 1,
        hasMore: false,
        source: "file" as const,
      }),
      page: async (agentKey: string) => ({
        agentKey,
        entries: [],
        tailMessages: [],
        fromSeq: 1,
        hasMore: false,
        source: "file" as const,
      }),
      onLeafChanged: () => {},
    },
    log,
    info: () => ({ version: "9.9.9-test", buildId: "b1", pid: process.pid, startedAt: clock.now(), proto: PROTO }),
    now: clock.now,
    lan: { cfg, store: lanStore, kdf, limiter, admission, hosts, scope, onStatus: (s) => (lastStatus = s) },
    ...(routes === undefined ? {} : { preview: routes }),
  });
  if (fe.lan === undefined) throw new Error("test bug: fe.lan not constructed");
  const status = await fe.lan.start();
  if (status.state !== "on") throw new Error(`LAN listener failed to start: ${JSON.stringify(status)}`);
  const port = status.port;

  return {
    fe,
    port,
    async cookieFor(id: number, username: string): Promise<string> {
      seedLanUser(lanStore, { id, username, password: "correct-horse-battery" });
      const r = await lanPostJson(port, "/api/login", { username, password: "correct-horse-battery" });
      if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.body}`);
      return (r.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
    },
    cwd,
    home: dir,
    uploadsRoot,
    routes: routes!,
    previewLines(): Array<Record<string, unknown>> {
      return log.lines.filter((l) => l.msg === "preview").map((l) => (l.data as Record<string, unknown>) ?? {});
    },
    file(rel: string, content: string | Buffer): string {
      const p = join(cwd, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content);
      return p;
    },
    async cleanup(): Promise<void> {
      await fe.close();
      await store?.close();
      store = undefined;
      await scope.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const harnesses: LanPreviewHarness[] = [];
async function harness(opts: Parameters<typeof startHarness>[0] = {}): Promise<LanPreviewHarness> {
  const h = await startHarness(opts);
  harnesses.push(h);
  return h;
}

/** Craft a committed upload owned by LAN user `alice` (principal lan:u1) in session SESSION. */
function craftInto(uploadsRoot: string, bytes: Buffer, sessionId = SESSION): string {
  const bucket = `s-${sessionId}`;
  const id = `upid${randomBytes(6).toString("hex")}`;
  const dirPath = join(uploadsRoot, bucket, id);
  mkdirSync(dirPath, { recursive: true });
  const diskName = `${id}.bin`;
  writeFileSync(join(dirPath, diskName), bytes);
  const meta: UploadMetaV1 = {
    v: 1,
    id,
    principal: "lan:u1",
    agentKey: AGENT,
    bucket,
    safeName: "upload.bin",
    diskName,
    size: bytes.length,
    mime: null,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    committedAt: Date.now(),
    referencedAt: null,
  };
  writeFileSync(join(dirPath, "meta.json"), JSON.stringify(meta));
  return join(dirPath, diskName);
}

function previewPath(p: string, sessionId = SESSION): string {
  return `${PREVIEW_PATH}?agentKey=${encodeURIComponent(AGENT)}&sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(p)}`;
}

beforeEach(() => {
  logLines = [];
});

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

// ---------------------------------------------------------------------------

describe("LAN /api/preview — §4.7 matrix rows", () => {
  it("mode on (default): no X-PWH ⇒ 403; X-PWH + unauth ⇒ 401; X-PWH + authed ⇒ dispatched", async () => {
    const h = await harness();
    const cookie = await h.cookieFor(1, "alice");

    const noHeader = await lanRequest(h.port, { path: previewPath("/x/y"), headers: { Cookie: cookie } });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body).toBe('{"error":"E_CSRF"}');

    const unauth = await lanRequest(h.port, { path: previewPath("/x/y"), headers: { "X-PWH": "1" } });
    expect(unauth.status).toBe(401);
    expect(unauth.body).toBe('{"error":"E_AUTH"}');

    const p = h.file("ok.txt", "lan body");
    const authed = await lanRequest(h.port, { path: previewPath(p), headers: { "X-PWH": "1", Cookie: cookie } });
    expect(authed.status).toBe(200);
    expect(authed.body).toBe("lan body");
  });

  it('HP4: mode:"loopback" ⇒ LAN answers 404 byte-identically to not-enabled (any auth/X-PWH)', async () => {
    const h = await harness({ mode: "loopback" });
    const cookie = await h.cookieFor(1, "alice");
    const p = h.file("ok.txt", "secret on lan");
    for (const headers of [{}, { "X-PWH": "1" }, { Cookie: cookie }, { "X-PWH": "1", Cookie: cookie }] as Array<
      Record<string, string>
    >) {
      const r = await lanRequest(h.port, { path: previewPath(p), headers });
      expect(r.status).toBe(404);
      expect(r.body).toBe('{"error":"E_NOT_FOUND"}');
    }
  });

  it("§4.7 LAN `off` row: deps.preview absent ⇒ 404 for every auth × X-PWH combination (= 现状)", async () => {
    // the pre-existing LAN asymmetry the plan keeps on purpose (§9): an unknown GET is NOT
    // authenticated on LAN — it 404s before any cookie check, so even X-PWH+auth gets 404.
    const h = await harness({ previewOff: true });
    const cookie = await h.cookieFor(1, "alice");
    const p = h.file("ok.txt", "off mode");
    for (const headers of [{}, { "X-PWH": "1" }, { Cookie: cookie }, { "X-PWH": "1", Cookie: cookie }] as Array<
      Record<string, string>
    >) {
      const r = await lanRequest(h.port, { path: previewPath(p), headers });
      expect(r.status).toBe(404);
      expect(r.body).toBe('{"error":"E_NOT_FOUND"}');
    }
    expect(h.routes).toBeUndefined(); // FrontendDeps.preview truly absent
  });
});

// ---------------------------------------------------------------------------
// U3 — session-visible sharing
// ---------------------------------------------------------------------------

describe("LAN /api/preview — U3 session-visible sharing", () => {
  /** Craft alice's upload BEFORE the store is built (harness `prepare`), then recover indexes it. */
  async function sharedHarness(): Promise<{ h: LanPreviewHarness; uploadPath: string; bytes: Buffer }> {
    const bytes = pngBytes(8, 8, 128);
    let uploadPath = "";
    const h = await harness({
      withStore: true,
      prepare: (ctx) => {
        uploadPath = craftInto(ctx.uploadsRoot, bytes);
      },
    });
    return { h, uploadPath, bytes };
  }

  it("alice and bob both read alice's upload in the SAME session; bob's audit carries shared:true", async () => {
    const { h, uploadPath, bytes } = await sharedHarness();
    const alice = await h.cookieFor(1, "alice");
    const bob = await h.cookieFor(2, "bob");

    const a = await lanRequest(h.port, { path: previewPath(uploadPath), headers: { "X-PWH": "1", Cookie: alice } });
    expect(a.status).toBe(200);

    const b = await lanRequest(h.port, { path: previewPath(uploadPath), headers: { "X-PWH": "1", Cookie: bob } });
    expect(b.status).toBe(200);
    expect(b.body.length).toBe(bytes.length);

    await waitUntil(() => h.previewLines().filter((l) => l["cls"] === "upload").length >= 2, 4_000, "both audit lines");
    const lines = h.previewLines().filter((l) => l["cls"] === "upload");
    const bobLine = lines.find((l) => l["user"] === "u2");
    expect(bobLine).toMatchObject({ ok: true, shared: true, listener: "lan" });
    const aliceLine = lines.find((l) => l["user"] === "u1");
    expect(aliceLine).toMatchObject({ ok: true, shared: false });
  });

  it("bob reading an OLD-session upload via the current session ⇒ 404 (no existence leak)", async () => {
    // the upload lives in the s-sess999 bucket (a previous session); the agent's CURRENT
    // session is SESSION — bob's request names the current one, so ⑤ passes and §4.2's
    // visibility check is what denies (bucket mismatch, non-owner) — without leaking existence.
    const bytes = Buffer.from("alice old-session file");
    let oldPath = "";
    const h = await harness({
      withStore: true,
      prepare: (ctx) => {
        oldPath = craftInto(ctx.uploadsRoot, bytes, OTHER_SESSION);
      },
    });
    const bob = await h.cookieFor(2, "bob");
    const r = await lanRequest(h.port, {
      path: previewPath(oldPath), // sessionId = SESSION (current)
      headers: { "X-PWH": "1", Cookie: bob },
    });
    expect(r.status).toBe(404);
    expect(r.body).toBe('{"error":"E_NOT_FOUND"}');
    // naming a session that is not even the agent's current one is E_SESSION_CHANGED (⑤)
    const r2 = await lanRequest(h.port, {
      path: previewPath(oldPath, OTHER_SESSION),
      headers: { "X-PWH": "1", Cookie: bob },
    });
    expect(r2.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// cwd class on LAN
// ---------------------------------------------------------------------------

describe("LAN /api/preview — cwd class", () => {
  it("a plain (non-control) agent's cwd file serves 200 — preview needs no cmd.v1 (§5.1)", async () => {
    const h = await harness();
    const cookie = await h.cookieFor(1, "alice");
    const p = h.file("note.txt", "readonly agent preview");
    const r = await lanRequest(h.port, { path: previewPath(p), headers: { "X-PWH": "1", Cookie: cookie } });
    expect(r.status).toBe(200);
    expect(r.body).toBe("readonly agent preview");
  });

  it(`LAN image byte cap: over ${PREVIEW_IMAGE_MAX_BYTES.lan} bytes ⇒ 413 bytes`, async () => {
    const h = await harness();
    const cookie = await h.cookieFor(1, "alice");
    const p = h.file("fat.png", pngBytes(4, 4, PREVIEW_IMAGE_MAX_BYTES.lan + 1 - 24));
    const r = await lanRequest(h.port, { path: previewPath(p), headers: { "X-PWH": "1", Cookie: cookie } });
    expect(r.status).toBe(413);
    const body = JSON.parse(r.body) as { max: number; reason: string };
    expect(body.max).toBe(PREVIEW_IMAGE_MAX_BYTES.lan);
    expect(body.reason).toBe("bytes");
  });

  it("home as cwd (U2): a normal file serves 200; ~/.ssh/config is denylisted 403", async () => {
    const h = await harness({ cwdInHome: true });
    const cookie = await h.cookieFor(1, "alice");
    const normal = h.file("readme.md", "home cwd preview");
    const ok = await lanRequest(h.port, { path: previewPath(normal), headers: { "X-PWH": "1", Cookie: cookie } });
    expect(ok.status).toBe(200);
    expect(ok.body).toBe("home cwd preview");

    const secret = h.file(".ssh/config", "Host *\n  User secret");
    const denied = await lanRequest(h.port, { path: previewPath(secret), headers: { "X-PWH": "1", Cookie: cookie } });
    expect(denied.status).toBe(403);
    const body = JSON.parse(denied.body) as { error: string; reason: string };
    expect(body.error).toBe("E_PREVIEW_DENIED");
    expect(body.reason).toBe("denylist");
  });

  it("session change ⇒ 409 E_SESSION_CHANGED", async () => {
    const h = await harness();
    const cookie = await h.cookieFor(1, "alice");
    const p = h.file("ok.txt", "x");
    const r = await lanRequest(h.port, {
      path: previewPath(p, OTHER_SESSION),
      headers: { "X-PWH": "1", Cookie: cookie },
    });
    expect(r.status).toBe(409);
    expect(r.body).toBe('{"error":"E_SESSION_CHANGED"}');
  });
});

// ---------------------------------------------------------------------------
// dir-plan v3.1 P1a: global admission on LAN (U4 + C9 — LAN and loopback widen together)
// ---------------------------------------------------------------------------

describe("LAN /api/preview — global admission (U4, dir-plan §1.4/C9)", () => {
  it('mode:"on": an authed LAN user reads a cwd-OUTSIDE file (LAN 同宽)', async () => {
    const h = await harness();
    const cookie = await h.cookieFor(1, "alice");
    const outside = join(h.home, "elsewhere", "lan-abs.txt");
    mkdirSync(join(h.home, "elsewhere"), { recursive: true });
    writeFileSync(outside, "lan absolute body\n");
    const r = await lanRequest(h.port, { path: previewPath(outside), headers: { "X-PWH": "1", Cookie: cookie } });
    expect(r.status).toBe(200);
    expect(r.body).toBe("lan absolute body\n");
  });

  it('mode:"loopback": LAN answers 404 for the SAME outside path — byte-identical to not-enabled', async () => {
    const h = await harness({ mode: "loopback" });
    const cookie = await h.cookieFor(1, "alice");
    const outside = join(h.home, "elsewhere", "lan-abs.txt");
    mkdirSync(join(h.home, "elsewhere"), { recursive: true });
    writeFileSync(outside, "never on lan\n");
    const loopback = await lanRequest(h.port, {
      path: previewPath(outside),
      headers: { "X-PWH": "1", Cookie: cookie },
    });
    expect(loopback.status).toBe(404);
    expect(loopback.body).toBe('{"error":"E_NOT_FOUND"}');
  });
});
