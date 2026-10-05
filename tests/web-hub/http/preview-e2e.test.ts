/**
 * web-hub content-preview — PV7 end-to-end integration tests (plan v3 §6 PV7).
 *
 * Everything is real except the agent: a REAL `startHub` (hub.ts composes its own upload
 * store, preview routes and BOTH listeners; the frontend is the real `createHttpFrontend`), a
 * REAL tmpdir filesystem, and REAL upload deposition through the `/api/upload/*` HTTP API —
 * the fake agent is only the unix-socket hello/session peer. Coverage per the PV7 paragraph:
 * the full upload→preview chain (magic number / dims / `X-PWH-Preview-*` head gates), cwd-class
 * text with the 256 KiB UTF-8 truncation cap, tamper semantics against really-deposited files
 * (size-change ⇒ 409, mid-stream same-size flip ⇒ destroyed body), the legacy-layout recovery
 * (v3 revision 3: `<id>/<safeName>` + meta without `diskName`), U3 session-visible sharing for a
 * second LAN user in the same session, session-switch 409/404 semantics, hub-restart recovery
 * of BOTH upload layouts, and close destroying an in-flight stream. The §4.7 auth/CSRF matrix,
 * rate limiting and HP8's full tamper matrix are PV3's (`api-preview.test.ts` /
 * `lan-preview.test.ts`) and are deliberately not duplicated here.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PREVIEW_PATH, PREVIEW_TEXT_MAX_BYTES } from "../../../src/web-hub/protocol/preview.js";
import { webHubUploadsDir } from "../../../src/web-hub/protocol/paths.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { startHub, type RunningHub } from "../../../src/web-hub/hub/hub.js";
import type { UploadMetaV1 } from "../../../src/web-hub/hub/uploads.js";
import { createHostsPort } from "../../../src/web-hub/hub/net-hosts.js";
import { createKdfAdmission } from "../../../src/web-hub/hub/kdf-admission.js";
import { createLoginLimiter } from "../../../src/web-hub/hub/ratelimit.js";
import type { FrontendDeps, FrontendFactory, LanAssembly, LanFrontendDeps } from "../../../src/web-hub/hub/ports.js";
import { fakeKdf, fakeLanStore, type FakeLanStore } from "../contract/fakes.js";
import { config, connectClient, hello, type TestClient } from "../hub/helpers.js";
import { login, postJson, rawRequest, type RawResponse } from "./helpers.js";
import { seedLanUser } from "./lan-helpers.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Fixed fake-agent identity so the registry's derived key (`a<pid>-<nonce6>`) is knowable
 * BEFORE the hub starts — the legacy craft needs it for its meta's agentKey field. */
const AGENT_PID = 424242;
const AGENT_NONCE = "e2enonce0000000000";
const AGENT_KEY = `a${AGENT_PID}-${AGENT_NONCE.slice(0, 6)}`;
const AGENT_CAPS = ["ev.v1", "cmd.v1", "upload.v1", "upload.lan.v1"];
const SESSION1 = "e2e-sess-one";
const SESSION2 = "e2e-sess-two";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const sha256 = (b: Buffer | Uint8Array): string => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const nid = (): string => randomBytes(12).toString("hex");

function pngBytes(w: number, h: number, pad = 0): Buffer {
  const head = Buffer.alloc(24);
  PNG_MAGIC.copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "ascii");
  head.writeUInt32BE(w, 16);
  head.writeUInt32BE(h, 20);
  return Buffer.concat([head, Buffer.alloc(pad)]);
}

/** A committed upload in the PRE-rework layout (v3 revision 3): `<bucket>/<id>/<safeName>` with a
 * meta.json that has NO `diskName` — must go through `recover()`'s legacy branch. Crafted
 * before the hub starts so the hub-built store's startup scan indexes it. */
function craftLegacy(root: string, bytes: Buffer, sessionId: string): string {
  const bucket = `s-${sessionId}`;
  const id = `uple${randomBytes(6).toString("hex")}`;
  const dir = join(root, bucket, id);
  mkdirSync(dir, { recursive: true });
  const safeName = "legacy-report.txt";
  writeFileSync(join(dir, safeName), bytes);
  const meta: UploadMetaV1 = {
    v: 1,
    id,
    // a stranger's principal: a loopback reader passes §4.2's visibility check through the
    // LISTENER exemption, not ownership — exactly the production shape of "hub restart
    // recovered someone else's old upload, the machine owner previews it".
    principal: "lan:u9",
    agentKey: AGENT_KEY,
    bucket,
    safeName,
    size: bytes.length,
    mime: null,
    sha256: sha256(bytes),
    committedAt: Date.now(),
    referencedAt: null,
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  return join(dir, safeName);
}

// ---------------------------------------------------------------------------
// raw HTTP collectors (binary-safe, truncation-aware)
// ---------------------------------------------------------------------------

interface CollectResult {
  status: number;
  headers: IncomingMessage["headers"];
  bytes: Buffer;
  cleanEnd: boolean;
}

/** Collect a response that may end truncated (tamper/destroy cases): resolves on end OR socket
 * error, reporting exactly how many body bytes arrived and whether the stream completed.
 * `throttleMs` models a slow consumer: after every chunk the stream pauses and resumes only
 * after `throttleMs` — consumed slower than the server reads, so its writes hit backpressure
 * (a permanently-paused stream would never emit `end`/`error` at all). */
function collect(
  port: number,
  opts: {
    path: string;
    headers?: Record<string, string>;
    onData?: (n: number) => void;
    pauseAfterFirstChunk?: boolean;
    throttleMs?: number;
    timeoutMs?: number;
  },
): Promise<CollectResult> {
  return new Promise((resolve, reject) => {
    let done = false;
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: opts.path,
        headers: { Host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        const finish = (cleanEnd: boolean): void => {
          if (done) return;
          done = true;
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            bytes: Buffer.concat(chunks),
            cleanEnd,
          });
        };
        res.on("data", (c: Buffer) => {
          chunks.push(c);
          opts.onData?.(c.length);
          if (opts.pauseAfterFirstChunk === true) res.pause();
          else if (opts.throttleMs !== undefined) {
            res.pause();
            const t = setTimeout(() => res.resume(), opts.throttleMs);
            t.unref?.();
          }
        });
        res.on("end", () => finish(true));
        res.on("aborted", () => finish(false));
        res.on("error", () => finish(false));
      },
    );
    req.setTimeout(opts.timeoutMs ?? 20_000, () => req.destroy(new Error("request timeout")));
    req.on("error", (err) => {
      if (!done) reject(err);
    });
    req.end();
  });
}

/** Raw binary POST (the chunk tier) — works against either listener; `extraHeaders` carries the
 * per-listener auth (Cookie) and CSRF (Origin) pair. */
function postBinary(
  port: number,
  path: string,
  bytes: Buffer,
  extraHeaders: Record<string, string>,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: {
          Host: `127.0.0.1:${port}`,
          "Content-Type": "application/octet-stream",
          "X-PWH": "1",
          "Content-Length": String(bytes.length),
          ...extraHeaders,
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(15_000, () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.write(bytes);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// harness — real startHub + real createHttpFrontend + socket fake agent
// ---------------------------------------------------------------------------

interface Live {
  hub: RunningHub;
  deps: FrontendDeps;
  agent: TestClient;
  port: number;
  cookie: string;
}

interface Kit {
  home: string;
  cwd: string;
  uploadsRoot: string;
  legacyPath: string | undefined;
  sessionId: string;
  live(): Live;
  lan: undefined | { store: FakeLanStore; port(): Promise<number> };
  file(rel: string, content: string | Buffer): string;
  /** begin → chunk(s) → commit over real HTTP on either listener; returns the committed path. */
  upload(content: Buffer, over?: { name?: string; lanCookie?: string }): Promise<{ id: string; path: string }>;
  preview(
    p: string,
    over?: { sessionId?: string; agentKey?: string; headers?: Record<string, string> },
  ): Promise<RawResponse>;
  previewCollect(
    p: string,
    over?: {
      sessionId?: string;
      headers?: Record<string, string>;
      onData?: (n: number) => void;
      pauseAfterFirstChunk?: boolean;
      throttleMs?: number;
    },
  ): Promise<CollectResult>;
  /** Agent switches to a new session (a second `session` frame) — resolves once the registry
   * reflects it (probe preview with the new sessionId serves 200). */
  setSession(sessionId: string): Promise<void>;
  lanCookie(user: { id: number; username: string }): Promise<string>;
  restart(): Promise<void>;
  destroyAgent(): void;
  close(): Promise<void>;
}

const kits: Kit[] = [];

/** The LAN host allow-list keys on the CONFIGURED port (`127.0.0.1:<cfg.port>`), so port 0
 * (kernel-assigned) would 421 every request — pick a free port up front, exactly like
 * `lan-helpers.ts`'s harness. */
async function freeLanPort(): Promise<number> {
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

async function startKit(opts: { lan?: boolean; legacy?: Buffer } = {}): Promise<Kit> {
  const home = mkdtempSync(join(tmpdir(), "pwh-preview-e2e-"));
  const cwd = join(home, "work");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "probe.txt"), "probe");
  const uploadsRoot = webHubUploadsDir(home);
  const legacyPath = opts.legacy === undefined ? undefined : craftLegacy(uploadsRoot, opts.legacy, SESSION1);
  const lanCfgPort = opts.lan === true ? await freeLanPort() : undefined;

  // The LAN seam `startHub` itself exposes for tests (`StartHubDeps.lanAssembly`): the HUB and
  // both listeners stay real; only the store/KDF are the W1 fakes (same pairing every
  // `lan-*.test.ts` harness uses). Real-time clock — login/backoff windows must tick.
  let lanStore: FakeLanStore | undefined;
  const lanAssembly: LanAssembly | undefined =
    opts.lan === true
      ? {
          async build(args): Promise<LanFrontendDeps> {
            lanStore = fakeLanStore();
            const limiter = createLoginLimiter({ now: args.now });
            return {
              cfg: args.cfg,
              store: lanStore,
              kdf: fakeKdf(),
              limiter,
              admission: createKdfAdmission({ now: args.now, isTightened: () => limiter.isTightened() }),
              hosts: createHostsPort(),
              scope: args.scope,
              onStatus: args.onStatus,
            };
          },
        }
      : undefined;

  const kit: Kit = {
    home,
    cwd,
    uploadsRoot,
    legacyPath,
    sessionId: SESSION1,
    live(): Live {
      if (current === undefined) throw new Error("kit not booted");
      return current;
    },
    lan:
      opts.lan === true
        ? {
            get store(): FakeLanStore {
              if (lanStore === undefined) throw new Error("LAN assembly never built");
              return lanStore;
            },
            async port(): Promise<number> {
              const hub = kit.live().hub;
              const deadline = Date.now() + 5_000;
              for (;;) {
                const st = hub.lanStatus();
                if (st !== undefined && st.state === "on") return st.port;
                if (Date.now() > deadline) throw new Error(`LAN listener never came up: ${JSON.stringify(st)}`);
                await sleep(20);
              }
            },
          }
        : undefined,
    file(rel: string, content: string | Buffer): string {
      const p = join(cwd, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content);
      return p;
    },
    async upload(content: Buffer, over: { name?: string; lanCookie?: string } = {}) {
      const { port, cookie } = kit.live();
      const isLan = over.lanCookie !== undefined;
      const target = isLan ? await kit.lan!.port() : port;
      const auth = {
        Cookie: over.lanCookie ?? cookie,
        Origin: `http://127.0.0.1:${target}`,
      };
      const id = nid();
      const begin = await postJson(
        target,
        "/api/upload/begin",
        { agentKey: AGENT_KEY, id, name: over.name ?? "file.bin", size: content.length },
        auth,
      );
      expect(begin.status).toBe(200);
      const chunkBytes = (JSON.parse(begin.body) as { chunkBytes: number }).chunkBytes;
      for (let offset = 0; offset < content.length; offset += chunkBytes) {
        const part = content.subarray(offset, Math.min(content.length, offset + chunkBytes));
        const res = await postBinary(target, `/api/upload/chunk?id=${id}&offset=${offset}`, Buffer.from(part), auth);
        expect(res.status).toBe(200);
      }
      const commit = await postJson(target, "/api/upload/commit", { id }, auth);
      expect(commit.status).toBe(200);
      return { id, path: (JSON.parse(commit.body) as { path: string }).path };
    },
    preview(
      p: string,
      over: { sessionId?: string; agentKey?: string; headers?: Record<string, string> } = {},
    ): Promise<RawResponse> {
      const { port, cookie } = kit.live();
      return rawRequest(port, {
        method: "GET",
        path: `${PREVIEW_PATH}?agentKey=${encodeURIComponent(over.agentKey ?? AGENT_KEY)}&sessionId=${encodeURIComponent(over.sessionId ?? kit.sessionId)}&path=${encodeURIComponent(p)}`,
        headers: { "X-PWH": "1", Cookie: cookie, ...(over.headers ?? {}) },
      });
    },
    previewCollect(
      p: string,
      over: {
        sessionId?: string;
        headers?: Record<string, string>;
        onData?: (n: number) => void;
        pauseAfterFirstChunk?: boolean;
        throttleMs?: number;
      } = {},
    ): Promise<CollectResult> {
      const { port, cookie } = kit.live();
      return collect(port, {
        path: `${PREVIEW_PATH}?agentKey=${encodeURIComponent(AGENT_KEY)}&sessionId=${encodeURIComponent(over.sessionId ?? kit.sessionId)}&path=${encodeURIComponent(p)}`,
        headers: { "X-PWH": "1", Cookie: cookie, ...(over.headers ?? {}) },
        ...(over.onData === undefined ? {} : { onData: over.onData }),
        ...(over.pauseAfterFirstChunk === undefined ? {} : { pauseAfterFirstChunk: over.pauseAfterFirstChunk }),
        ...(over.throttleMs === undefined ? {} : { throttleMs: over.throttleMs }),
      });
    },
    async setSession(sessionId: string): Promise<void> {
      kit.sessionId = sessionId;
      const { agent } = kit.live();
      agent.send({ t: "session", sessionId, cwd, reason: "e2e", leafId: null, mode: "tui" });
      const probe = join(cwd, "probe.txt");
      const deadline = Date.now() + 4_000;
      for (;;) {
        const r = await kit.preview(probe);
        if (r.status === 200) return;
        if (Date.now() > deadline) throw new Error(`session never became visible: ${r.status} ${r.body}`);
        await sleep(15);
      }
    },
    async lanCookie(user: { id: number; username: string }): Promise<string> {
      const store = kit.lan!.store;
      seedLanUser(store, { ...user, password: "correct-horse-battery" });
      const port = await kit.lan!.port();
      const r = await postJson(
        port,
        "/api/login",
        { username: user.username, password: "correct-horse-battery" },
        { Origin: `http://127.0.0.1:${port}` },
      );
      if (r.status !== 200) throw new Error(`lan login failed: ${r.status} ${r.body}`);
      return (r.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
    },
    async restart(): Promise<void> {
      kit.destroyAgent();
      await current!.hub.close("e2e-restart");
      current = undefined;
      current = await boot();
      // the SAME fake agent reconnects over the new socket — same agentId reclaims the key.
    },
    destroyAgent(): void {
      current?.agent.sock.destroy();
    },
    async close(): Promise<void> {
      kit.destroyAgent();
      if (current !== undefined) await current.hub.close("test");
      current = undefined;
      rmSync(home, { recursive: true, force: true });
    },
  };

  let current: Live | undefined;

  /** Boots (or re-boots, after `restart()`) the hub + fake agent + session, and settles the
   * store's startup scan before returning (`recover()` is hub.ts's own one-shot scan promise). */
  async function boot(): Promise<Live> {
    let captured: FrontendDeps | undefined;
    const factory: FrontendFactory = (d) => {
      captured = d;
      return createHttpFrontend(d);
    };
    const hub = await startHub(
      config({
        home,
        port: 0,
        preview: "on",
        ...(lanAssembly === undefined
          ? {}
          : { lan: { port: lanCfgPort!, extraHosts: [], trustProxyFrom: [], externalOrigins: [] } }),
      }),
      factory,
      { uid: process.getuid?.() ?? 0, ...(lanAssembly === undefined ? {} : { lanAssembly }) },
    );
    if ("exists" in hub) throw new Error("unexpected exists");
    if (captured === undefined) throw new Error("frontend factory never called");
    expect(captured.uploads).toBeDefined();
    const agent = await connectClient(hub.paths.socketPath);
    agent.send(hello({ agentId: { pid: AGENT_PID, nonce: AGENT_NONCE }, cwd, caps: [...AGENT_CAPS] }));
    const ack = await agent.waitFrame((f) => f["t"] === "hello_ack");
    expect(ack["agentKey"]).toBe(AGENT_KEY); // pins the legacy craft's meta agentKey
    await captured.uploads!.recover();
    const port = hub.httpPort;
    const cookie = await login(port, hub.paths.tokenFile);
    const live: Live = { hub, deps: captured, agent, port, cookie };
    current = live;
    await kit.setSession(kit.sessionId);
    return live;
  }

  await boot();
  kits.push(kit);
  return kit;
}

async function kit(opts: Parameters<typeof startKit>[0] = {}): Promise<Kit> {
  return startKit(opts);
}

afterEach(async () => {
  for (const k of kits.splice(0)) await k.close();
});

function previewOk(r: RawResponse | CollectResult): void {
  expect(r.status).toBe(200);
}

// ---------------------------------------------------------------------------
// PV7 — the four plan cases end-to-end (cwd class, generated upload, legacy recovery,
// U3 second-user LAN read), each 200 with an exact sha256
// ---------------------------------------------------------------------------

describe("PV7 e2e — upload→preview full chain (real hub, generated layout)", () => {
  it(
    "a small PNG uploaded through the real /api/upload API previews back byte-exact: " +
      "magic number, dims header, X-PWH-Preview-* gates, sha256",
    async () => {
      const k = await kit();
      const png = pngBytes(320, 200, 4096);
      const { id, path } = await k.upload(png, { name: "shot.png" });
      // generated layout on disk: `<id>.<ext>` inside the session bucket directory
      expect(path.startsWith(`${k.uploadsRoot}/s-${SESSION1}/`)).toBe(true);
      expect(path.endsWith(`${id}.png`)).toBe(true);

      const r = await k.previewCollect(path);
      previewOk(r);
      expect(r.headers["content-type"]).toBe("image/png");
      expect(r.headers["x-pwh-preview-kind"]).toBe("image");
      expect(r.headers["x-pwh-preview-dims"]).toBe("320x200");
      expect(r.headers["x-pwh-preview-size"]).toBe(String(png.length));
      expect(r.headers["x-pwh-preview-truncated"]).toBe("0");
      expect(r.headers["content-length"]).toBe(String(png.length));
      expect(r.headers["cross-origin-resource-policy"]).toBe("same-origin");
      expect(r.headers["content-disposition"]).toBe('attachment; filename="preview"');
      expect(r.headers["cache-control"]).toBe("no-store");
      // magic-number head gate from the client side: the body opens with the PNG signature
      expect(r.bytes.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
      expect(sha256(r.bytes)).toBe(sha256(png));
      expect(r.cleanEnd).toBe(true);
    },
    30_000,
  );
});

describe("PV7 e2e — cwd class (text, truncation cap)", () => {
  it("a small cwd text file serves its exact bytes (sha256)", async () => {
    const k = await kit();
    const body = "line1\n中文行\nline3\n";
    const p = k.file("notes.md", body);
    const r = await k.preview(p);
    previewOk(r);
    expect(r.headers["x-pwh-preview-kind"]).toBe("text");
    expect(r.headers["x-pwh-preview-truncated"]).toBe("0");
    expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(Buffer.from(r.body)).toEqual(Buffer.from(body));
    expect(sha256(Buffer.from(r.body))).toBe(sha256(Buffer.from(body)));
  });

  it(`oversized cwd text truncates at a UTF-8 character boundary (cap ${PREVIEW_TEXT_MAX_BYTES} bytes)`, async () => {
    const k = await kit();
    // 256 KiB of ASCII, then multi-byte chars straddling the cap: the cut must land BEFORE the
    // first 3-byte char, not split it.
    const content = `${"a".repeat(PREVIEW_TEXT_MAX_BYTES - 1)}中文中文中文`;
    const p = k.file("big.md", content);
    const r = await k.preview(p);
    previewOk(r);
    expect(r.headers["x-pwh-preview-kind"]).toBe("text");
    expect(r.headers["x-pwh-preview-truncated"]).toBe("1");
    const served = Buffer.from(r.body);
    expect(served.length).toBe(PREVIEW_TEXT_MAX_BYTES - 1);
    expect(served.equals(Buffer.alloc(PREVIEW_TEXT_MAX_BYTES - 1, 0x61))).toBe(true);
  });
});

describe("PV7 e2e — tamper semantics against really-deposited uploads", () => {
  it("text upload rewritten with a different size ⇒ 409 E_PREVIEW_CHANGED (head never sent)", async () => {
    const k = await kit();
    const { path } = await k.upload(Buffer.from("original committed payload"), { name: "note.txt" });
    previewOk(await k.preview(path)); // sanity: untampered read serves 200

    writeFileSync(path, "tampered replacement content that is longer than the original");
    const r = await k.preview(path);
    expect(r.status).toBe(409);
    expect(r.body).toBe('{"error":"E_PREVIEW_CHANGED"}');
  });

  it("same-size content flip mid-stream on an image ⇒ 200 head but the body never completes (destroy)", async () => {
    const k = await kit();
    const png = pngBytes(64, 64, 2 * 1024 * 1024);
    const { path } = await k.upload(png, { name: "photo.png" });
    const flipped = Buffer.from(png);
    flipped[flipped.length - 10] ^= 0xff;
    let rewrote = false;
    const r = await k.previewCollect(path, {
      onData: () => {
        if (rewrote) return;
        rewrote = true;
        writeFileSync(path, flipped); // same size — passes the recorded-size re-check
      },
    });
    expect(r.status).toBe(200); // the head went out with the recorded size...
    const declared = Number(r.headers["content-length"]);
    expect(r.bytes.length).toBeLessThan(declared); // ...but the streamed sha256 mismatch destroys it
    expect(r.cleanEnd).toBe(false);
  });
});

describe("PV7 e2e — legacy layout recovery + hub restart (v3 revision 3)", () => {
  it("a pre-rework <id>/<safeName> upload crafted before startHub previews 200 after recover()", async () => {
    const bytes = Buffer.from("legacy e2e body — recovered by the hub-built store");
    const k = await kit({ legacy: bytes });
    const r = await k.preview(k.legacyPath!);
    previewOk(r);
    expect(r.headers["x-pwh-preview-kind"]).toBe("text");
    expect(r.body).toBe(bytes.toString("utf8"));
    expect(sha256(Buffer.from(r.body))).toBe(sha256(bytes));
  }, 30_000);

  it(
    "close + startHub over the same home: BOTH the API-uploaded (generated) and the crafted " +
      "(legacy) attachments still preview 200 sha256-equal after the restart",
    async () => {
      const legacyBytes = Buffer.from("old legacy attachment that outlived a hub restart");
      const k = await kit({ legacy: legacyBytes });
      const png = pngBytes(96, 48, 2048);
      const { path: generatedPath } = await k.upload(png, { name: "restart.png" });
      previewOk(await k.preview(generatedPath)); // sanity pre-restart
      previewOk(await k.preview(k.legacyPath!));

      await k.restart(); // new hub, new store (recover() re-indexes disk), re-helloed agent

      const g = await k.previewCollect(generatedPath);
      previewOk(g);
      expect(g.headers["x-pwh-preview-kind"]).toBe("image");
      expect(sha256(g.bytes)).toBe(sha256(png));
      expect(g.cleanEnd).toBe(true);

      const l = await k.preview(k.legacyPath!);
      previewOk(l);
      expect(l.body).toBe(legacyBytes.toString("utf8"));
      expect(sha256(Buffer.from(l.body))).toBe(sha256(legacyBytes));
    },
    45_000,
  );
});

describe("PV7 e2e — U3: a second LAN user reads the attachment in the same session", () => {
  it(
    "the four plan cases on one real hub: cwd text, generated upload, legacy recovery, bob's " +
      "LAN read of alice's upload — all 200 with exact sha256",
    async () => {
      const legacyBytes = Buffer.from("legacy body on the lan kit");
      const k = await kit({ lan: true, legacy: legacyBytes });
      const alice = await k.lanCookie({ id: 1, username: "alice" });
      const bob = await k.lanCookie({ id: 2, username: "bob" });
      const lanPort = await k.lan!.port();

      // (1) cwd class
      const text = "cwd text over the real hub";
      const p = k.file("readme.txt", text);
      const t = await k.preview(p);
      previewOk(t);
      expect(sha256(Buffer.from(t.body))).toBe(sha256(Buffer.from(text)));

      // (2) generated layout — alice uploads via LAN, the loopback owner previews it back
      const png = pngBytes(128, 96, 8192);
      const { path } = await k.upload(png, { name: "alice-shot.png", lanCookie: alice });
      const loopbackRead = await k.previewCollect(path);
      previewOk(loopbackRead);
      expect(loopbackRead.headers["x-pwh-preview-kind"]).toBe("image");
      expect(loopbackRead.headers["x-pwh-preview-dims"]).toBe("128x96");
      expect(sha256(loopbackRead.bytes)).toBe(sha256(png));

      // (3) legacy recovery
      const l = await k.preview(k.legacyPath!);
      previewOk(l);
      expect(sha256(Buffer.from(l.body))).toBe(sha256(legacyBytes));

      // (4) U3: bob — a DIFFERENT authenticated principal — reads alice's attachment in the
      // same session over the LAN listener, byte-exact
      const bobRead = await collect(lanPort, {
        path: `${PREVIEW_PATH}?agentKey=${encodeURIComponent(AGENT_KEY)}&sessionId=${encodeURIComponent(SESSION1)}&path=${encodeURIComponent(path)}`,
        headers: { "X-PWH": "1", Cookie: bob },
      });
      previewOk(bobRead);
      expect(bobRead.headers["x-pwh-preview-kind"]).toBe("image");
      expect(sha256(bobRead.bytes)).toBe(sha256(png));
      expect(bobRead.cleanEnd).toBe(true);
    },
    45_000,
  );

  it(
    "session switch: old-session requests ⇒ 409; bob via the new session ⇒ 404; the uploader " +
      "herself still reads her own attachment ⇒ 200 (§4.2 step 4)",
    async () => {
      const k = await kit({ lan: true });
      const alice = await k.lanCookie({ id: 1, username: "alice" });
      const bob = await k.lanCookie({ id: 2, username: "bob" });
      const lanPort = await k.lan!.port();
      const png = pngBytes(24, 24, 256);
      const { path } = await k.upload(png, { name: "switch.png", lanCookie: alice });

      const lanGet = (cookie: string, sessionId: string, p: string): Promise<RawResponse> =>
        rawRequest(lanPort, {
          method: "GET",
          path: `${PREVIEW_PATH}?agentKey=${encodeURIComponent(AGENT_KEY)}&sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(p)}`,
          headers: { "X-PWH": "1", Cookie: cookie },
        });
      previewOk(await lanGet(bob, SESSION1, path)); // same session: bob reads alice's upload

      await k.setSession(SESSION2); // the agent moved on (e.g. /new)

      // any request naming the OLD session is 409 — both listeners, both classes
      expect(await k.preview(path, { sessionId: SESSION1 })).toMatchObject({ status: 409 });
      const oldLan = await lanGet(bob, SESSION1, path);
      expect(oldLan.status).toBe(409);
      expect(oldLan.body).toBe('{"error":"E_SESSION_CHANGED"}');
      const cwdFile = k.file("after-switch.txt", "new session file");
      expect((await k.preview(cwdFile, { sessionId: SESSION1 })).status).toBe(409);

      // naming the NEW session: a non-owner (bob) hitting the OLD bucket ⇒ 404, no existence
      // leak; the uploader herself (alice) stays able to read her own attachment
      expect(await lanGet(bob, SESSION2, path)).toMatchObject({ status: 404 });
      const aliceStill = await collect(lanPort, {
        path: `${PREVIEW_PATH}?agentKey=${encodeURIComponent(AGENT_KEY)}&sessionId=${encodeURIComponent(SESSION2)}&path=${encodeURIComponent(path)}`,
        headers: { "X-PWH": "1", Cookie: alice },
      });
      previewOk(aliceStill);
      expect(sha256(aliceStill.bytes)).toBe(sha256(png));
    },
    45_000,
  );
});

describe("PV7 e2e — close destroys an in-flight stream", () => {
  it("hub.close() mid-stream ⇒ the slow client's body ends incomplete; close stays bounded", async () => {
    const k = await kit();
    // ~15 MiB cwd image (under the 16 MiB loopback cap) + a throttled consumer: the client
    // reads one chunk per 25ms — far slower than the server reads from disk — so the server
    // reliably parks in waitDrain (backpressure) while the head is already out.
    const big = k.file("big-cwd.png", pngBytes(1024, 1024, 15 * 1024 * 1024 - 24));
    const pending = k.previewCollect(big, { throttleMs: 25 });
    await sleep(400); // let the stream settle into its parked mid-flight state
    const t0 = Date.now();
    await k.live().hub.close("test"); // preview dispose aborts the active stream ⇒ destroy
    expect(Date.now() - t0).toBeLessThan(10_000); // HUB_CLOSE_DEADLINE_MS bound
    const r = await pending;
    expect(r.status).toBe(200); // the head had been sent...
    expect(r.bytes.length).toBeLessThan(Number(r.headers["content-length"])); // ...body destroyed
    expect(r.cleanEnd).toBe(false);
  }, 30_000);
});
