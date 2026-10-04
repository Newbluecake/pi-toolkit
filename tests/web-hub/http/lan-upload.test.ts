/**
 * web-hub-upload plan §6 U3 — LAN `/api/upload/*` routes: the 1 MiB chunk tier, the
 * `upload.lan.v1` capability gate, LAN CSRF (`uploadCsrfOk`), cross-principal isolation (#9) and
 * the v3 #8 pin rule "someone else's path in MY prompt is ignored". Harness mirrors
 * `lan-helpers.ts`'s `startLan` (real `createHttpFrontend` + fake store/kdf) but injects the
 * upload store, a command router and a mutable agent registry — `lan-helpers.ts` itself is
 * outside U3's file domain and stays untouched.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatAttachmentBlock,
  formatAttachmentSize,
  UPLOAD_CHUNK_BYTES_LAN,
} from "../../../src/web-hub/protocol/upload.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { createScope } from "../../../src/web-hub/hub/lifecycle.js";
import { createHostsPort } from "../../../src/web-hub/hub/net-hosts.js";
import { createKdfAdmission } from "../../../src/web-hub/hub/kdf-admission.js";
import { createLoginLimiter } from "../../../src/web-hub/hub/ratelimit.js";
import { createUploadStore, type UploadAuditEvent, type UploadStore } from "../../../src/web-hub/hub/uploads.js";
import type {
  AgentView,
  CommandRouter,
  HubEvent,
  HttpFrontend,
  HubLanConfig,
  LanStatus,
} from "../../../src/web-hub/hub/ports.js";
import type { CmdFrame, CmdResultFrame } from "../../../src/web-hub/protocol/messages.js";
import { PROTO } from "../../../src/web-hub/protocol/version.js";
import { fakeKdf, fakeLanStore, type FakeLanStore } from "../contract/fakes.js";
import { memLog } from "../hub/helpers.js";
import { testHubPaths } from "../helpers/paths.js";
import { makeAgent } from "./helpers.js";
import { lanPostJson, lanRequest, seedLanUser, type RawResponse } from "./lan-helpers.js";
import { createServer as createNetServer } from "node:net";

// ---------------------------------------------------------------------------
// LAN harness (startLan + uploads/commands/registry injection)
// ---------------------------------------------------------------------------

const AGENT = "a1";

interface LanUploadHarness {
  fe: HttpFrontend;
  port: number;
  store: UploadStore;
  lanStore: FakeLanStore;
  agents: Map<string, AgentView>;
  audits: UploadAuditEvent[];
  uploadsRoot: string;
  dir: string;
  cleanup(): Promise<void>;
}

interface FakeRouter extends CommandRouter {
  calls: CmdFrame[];
}

function fakeRouter(reply: (frame: CmdFrame) => CmdResultFrame): FakeRouter {
  const calls: CmdFrame[] = [];
  return {
    calls,
    async request(frame) {
      calls.push(frame);
      return reply(frame);
    },
    async drain() {
      return { inflight: 0, timedOut: false };
    },
    inflight() {
      return 0;
    },
  };
}

function okReply(frame: CmdFrame): CmdResultFrame {
  return { t: "cmd_result", rid: frame.rid, id: frame.id, ok: true, data: {} };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr !== null && typeof addr === "object" ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function startLanUpload(opts: { router?: FakeRouter } = {}): Promise<LanUploadHarness> {
  // real-time clock: the §2.4 upload token bucket refills off `now()`, so a frozen fakeClock
  // would 429 the 100-chunk tier test forever. No TTL time-travel is needed on the LAN side.
  const clock = { now: () => Date.now() };
  const dir = mkdtempSync(join(tmpdir(), "pwh-lan-upload-"));
  const lanStore = fakeLanStore();
  const kdf = fakeKdf();
  const limiter = createLoginLimiter({ now: clock.now });
  const admission = createKdfAdmission({ now: clock.now, isTightened: limiter.isTightened });
  const hosts = createHostsPort();
  const log = memLog();
  const scope = createScope({ log, now: clock.now });
  const agents = new Map<string, AgentView>();
  agents.set(AGENT, makeAgent(AGENT, { control: true, upload: true, uploadLan: true }));
  const audits: UploadAuditEvent[] = [];
  const uploadsRoot = join(dir, "uploads");
  const store = createUploadStore({ root: uploadsRoot, now: clock.now, log, audit: (e) => audits.push(e) });
  const subs = new Set<(e: HubEvent) => void>();

  const cfg: HubLanConfig = { port: await freePort(), extraHosts: [], trustProxyFrom: [], externalOrigins: [] };
  let lastStatus: LanStatus = { state: "starting" };

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
    uploads: store,
    ...(opts.router === undefined ? {} : { commands: opts.router }),
  });
  if (fe.lan === undefined) throw new Error("test bug: fe.lan not constructed");
  const status = await fe.lan.start();
  lastStatus = status;
  const port = status.state === "on" ? status.port : 0;
  await store.recover();
  return {
    fe,
    port,
    store,
    lanStore,
    agents,
    audits,
    uploadsRoot,
    dir,
    async cleanup() {
      await fe.close();
      await store.close();
      await scope.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const harnesses: LanUploadHarness[] = [];
async function harness(opts: Parameters<typeof startLanUpload>[0] = {}): Promise<LanUploadHarness> {
  const h = await startLanUpload(opts);
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

const nid = (): string => randomBytes(12).toString("hex");

async function login(h: LanUploadHarness, id: number, username: string): Promise<string> {
  seedLanUser(h.lanStore, { id, username, password: "correct-horse-battery" });
  const r = await lanPostJson(h.port, "/api/login", { username, password: "correct-horse-battery" });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.body}`);
  return (r.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
}

function lanHeaders(h: LanUploadHarness, cookie: string, over: Record<string, string> = {}): Record<string, string> {
  return { Cookie: cookie, ...over };
}

function lanUploadBegin(
  h: LanUploadHarness,
  cookie: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return lanPostJson(h.port, "/api/upload/begin", body, lanHeaders(h, cookie, headers));
}

function lanPostChunk(
  h: LanUploadHarness,
  opts: { id: string; offset: number; bytes: Buffer; cookie?: string; headers?: Record<string, string> },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Host: `127.0.0.1:${h.port}`,
      "Content-Type": "application/octet-stream",
      "X-PWH": "1",
      Origin: `http://127.0.0.1:${h.port}`,
      "Content-Length": String(opts.bytes.length),
      ...(opts.cookie === undefined ? {} : { Cookie: opts.cookie }),
      ...(opts.headers ?? {}),
    };
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: h.port,
        method: "POST",
        path: `/api/upload/chunk?id=${opts.id}&offset=${opts.offset}`,
        headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(20_000, () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.write(opts.bytes);
    req.end();
  });
}

interface UploadedFile {
  id: string;
  path: string;
  content: Buffer;
}

async function lanUploadFile(
  h: LanUploadHarness,
  cookie: string,
  content: Buffer,
  over: { name?: string; mime?: string } = {},
): Promise<UploadedFile> {
  const id = nid();
  const begin = await lanUploadBegin(h, cookie, {
    agentKey: AGENT,
    id,
    name: over.name ?? "file.bin",
    size: content.length,
    ...(over.mime === undefined ? {} : { mime: over.mime }),
  });
  expect(begin.status).toBe(200);
  const chunkBytes = (JSON.parse(begin.body) as { chunkBytes: number }).chunkBytes;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  for (let offset = 0; offset < content.length; offset += chunkBytes) {
    const part = content.subarray(offset, Math.min(content.length, offset + chunkBytes));
    // The §2.4 per-principal bucket (64 + 1/100ms) self-paces a real LAN client (1 MiB/req at
    // 10 req/s ≈ 10 MiB/s); a loopback-fast test client must pace itself / honor Retry-After the
    // way the U4 transport will.
    if (chunkBytes <= UPLOAD_CHUNK_BYTES_LAN) await sleep(40);
    let res = await lanPostChunk(h, { id, offset, bytes: Buffer.from(part), cookie });
    for (let retries = 0; res.status === 429 && retries < 10; retries++) {
      await sleep(Number(res.headers["retry-after"] ?? "1") * 1000);
      res = await lanPostChunk(h, { id, offset, bytes: Buffer.from(part), cookie });
    }
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ received: offset + part.length });
  }
  const commit = await lanPostJson(h.port, "/api/upload/commit", { id }, lanHeaders(h, cookie));
  expect(commit.status).toBe(200);
  const path = (JSON.parse(commit.body) as { path: string }).path;
  return { id, path, content };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("POST /api/upload/* (LAN) — happy path + 1 MiB tier (plan §1.2/§1.3)", () => {
  it("begin → chunk → commit over LAN with the 1 MiB chunk tier and a per-user principal", async () => {
    const h = await harness();
    const cookie = await login(h, 1, "alice");
    const content = Buffer.from("lan hello".repeat(1000));
    const id = nid();
    const begin = await lanUploadBegin(h, cookie, {
      agentKey: AGENT,
      id,
      name: "note.txt",
      size: content.length,
      mime: "text/plain",
    });
    expect(begin.status).toBe(200);
    expect(JSON.parse(begin.body)).toMatchObject({ id, chunkBytes: UPLOAD_CHUNK_BYTES_LAN, received: 0 });
    const c1 = await lanPostChunk(h, { id, offset: 0, bytes: content.subarray(0, 5), cookie });
    expect(JSON.parse(c1.body)).toEqual({ received: 5 });
    const c2 = await lanPostChunk(h, { id, offset: 5, bytes: content.subarray(5), cookie });
    expect(JSON.parse(c2.body)).toEqual({ received: content.length });
    const commit = await lanPostJson(h.port, "/api/upload/commit", { id }, lanHeaders(h, cookie));
    expect(commit.status).toBe(200);
    const reply = JSON.parse(commit.body) as { path: string; mime: string };
    expect(reply.mime).toBe("text/plain");
    expect(readFileSync(reply.path)).toEqual(content);
    // bucket is per-agent (no session on the fake card) and the upload ran under the lan:u1 principal
    const commitAudit = h.audits.find((a) => a.phase === "request" && a.op === "commit" && a.ok);
    expect(commitAudit).toMatchObject({ bucket: `a-${AGENT}`, bytes: content.length });
  });

  it("a retried LAN chunk answers dup:true", async () => {
    const h = await harness();
    const cookie = await login(h, 1, "alice");
    const id = nid();
    await lanUploadBegin(h, cookie, { agentKey: AGENT, id, size: 4 });
    await lanPostChunk(h, { id, offset: 0, bytes: Buffer.from("ab"), cookie });
    const dup = await lanPostChunk(h, { id, offset: 0, bytes: Buffer.from("ab"), cookie });
    expect(JSON.parse(dup.body)).toEqual({ received: 2, dup: true });
  });
});

describe("POST /api/upload/* (LAN) — gates", () => {
  it("no session cookie ⇒ 401 on begin/chunk/commit/abort", async () => {
    const h = await harness();
    const id = nid();
    expect((await lanUploadBegin(h, "", { agentKey: AGENT, id, size: 1 })).status).toBe(401);
    expect((await lanPostChunk(h, { id, offset: 0, bytes: Buffer.from("x") })).status).toBe(401);
    expect((await lanPostJson(h.port, "/api/upload/commit", { id })).status).toBe(401);
    expect((await lanPostJson(h.port, "/api/upload/abort", { id })).status).toBe(401);
  });

  it("missing Origin / cross-origin Origin / Sec-Fetch-Site: cross-site ⇒ 403 (chunk and json)", async () => {
    const h = await harness();
    const cookie = await login(h, 1, "alice");
    const id = nid();
    const noOrigin = await lanRequest(h.port, {
      method: "POST",
      path: `/api/upload/chunk?id=${id}&offset=0`,
      headers: { "Content-Type": "application/octet-stream", "X-PWH": "1", Cookie: cookie },
      body: "x",
    });
    expect(noOrigin.status).toBe(403);
    const crossOrigin = await lanPostChunk(h, {
      id,
      offset: 0,
      bytes: Buffer.from("x"),
      cookie,
      headers: { Origin: "http://evil.example" },
    });
    expect(crossOrigin.status).toBe(403);
    const sfs = await lanPostChunk(h, {
      id,
      offset: 0,
      bytes: Buffer.from("x"),
      cookie,
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(sfs.status).toBe(403);
    const jsonWrongCt = await lanPostJson(
      h.port,
      "/api/upload/begin",
      { agentKey: AGENT, id, size: 1 },
      lanHeaders(h, cookie, { "Content-Type": "application/octet-stream" }),
    );
    expect(jsonWrongCt.status).toBe(403);
  });

  it("agent without upload.lan.v1 ⇒ 409 E_UPLOAD_DISABLED on the LAN listener (loopback-only agent)", async () => {
    const h = await harness();
    h.agents.set(AGENT, makeAgent(AGENT, { control: true, upload: true, uploadLan: false }));
    const cookie = await login(h, 1, "alice");
    const res = await lanUploadBegin(h, cookie, { agentKey: AGENT, id: nid(), size: 1 });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_UPLOAD_DISABLED" });
  });

  it("commit agent recheck works on LAN too: agent gone ⇒ 410 E_AGENT_GONE, dir deleted", async () => {
    const h = await harness();
    const cookie = await login(h, 1, "alice");
    const id = nid();
    await lanUploadBegin(h, cookie, { agentKey: AGENT, id, name: "x.bin", size: 2 });
    await lanPostChunk(h, { id, offset: 0, bytes: Buffer.from("ab"), cookie });
    h.agents.delete(AGENT);
    const res = await lanPostJson(h.port, "/api/upload/commit", { id }, lanHeaders(h, cookie));
    expect(res.status).toBe(410);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_AGENT_GONE" });
  });
});

describe("cross-principal isolation (plan §2.5 #9 / §5.1.3)", () => {
  it("another LAN user's chunk/commit/abort on my id ⇒ 404 (no existence leak)", async () => {
    const h = await harness();
    const alice = await login(h, 1, "alice");
    const bob = await login(h, 2, "bob");
    const id = nid();
    await lanUploadBegin(h, alice, { agentKey: AGENT, id, name: "mine.bin", size: 4 });
    await lanPostChunk(h, { id, offset: 0, bytes: Buffer.from("ab"), cookie: alice });
    expect((await lanPostChunk(h, { id, offset: 2, bytes: Buffer.from("cd"), cookie: bob })).status).toBe(404);
    expect((await lanPostJson(h.port, "/api/upload/commit", { id }, lanHeaders(h, bob))).status).toBe(404);
    expect((await lanPostJson(h.port, "/api/upload/abort", { id }, lanHeaders(h, bob))).status).toBe(404);
    // and bob cannot even re-begin the same id
    expect((await lanUploadBegin(h, bob, { agentKey: AGENT, id, name: "mine.bin", size: 4 })).status).toBe(404);
  });

  it("another principal's prompt referencing MY path is NOT pinned/marked; my own prompt is", async () => {
    const router = fakeRouter(okReply);
    const h = await harness({ router });
    const alice = await login(h, 1, "alice");
    const bob = await login(h, 2, "bob");
    const f = await lanUploadFile(h, alice, Buffer.from("alice's file"), { mime: "image/png" });
    const block = formatAttachmentBlock([
      { path: f.path, mime: "image/png", sizeLabel: formatAttachmentSize(f.content.length) },
    ])!;
    const text = `look\n\n${block}`;
    // bob sends it: the path is alice's — silently ignored, prompt still forwarded
    const bobRes = await lanPostJson(
      h.port,
      "/api/cmd",
      { agentKey: AGENT, id: nid(), op: "prompt", text, deliver: "followUp" },
      lanHeaders(h, bob),
    );
    expect(bobRes.status).toBe(200);
    expect(router.calls).toHaveLength(1);
    expect(h.store.stats().referencedFiles).toBe(0);
    // alice sends it: pinned + referenced
    const aliceRes = await lanPostJson(
      h.port,
      "/api/cmd",
      { agentKey: AGENT, id: nid(), op: "prompt", text, deliver: "followUp" },
      lanHeaders(h, alice),
    );
    expect(aliceRes.status).toBe(200);
    expect(h.store.stats().referencedFiles).toBe(1);
  });
});

describe("LAN 1 MiB tier — §1.3 acceptance with a 100 MiB file", () => {
  it("100 chunks of 1 MiB commit successfully with bounded RSS growth", async () => {
    const h = await harness();
    const cookie = await login(h, 1, "alice");
    const content = Buffer.alloc(100 * 1024 * 1024, 0x62);
    const rssBefore = process.memoryUsage().rss;
    const f = await lanUploadFile(h, cookie, content, { name: "hundred.bin" });
    const rssAfter = process.memoryUsage().rss;
    expect(rssAfter - rssBefore).toBeLessThan(128 * 1024 * 1024);
    const sha = createHash("sha256").update(readFileSync(f.path)).digest("hex");
    expect(sha).toBe(createHash("sha256").update(content).digest("hex"));
    const commitAudit = h.audits.find((a) => a.phase === "request" && a.op === "commit" && a.ok);
    expect(commitAudit).toMatchObject({ chunks: 100, bytes: content.length });
  }, 120_000);
});
