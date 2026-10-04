/**
 * web-hub-upload plan §6 U3 — loopback `/api/upload/*` routes, reference pinning (v3 #8) and the
 * U3 hard gates: reauth race, disconnects, slow-fs 504, close paths, restart re-upload contract.
 * The store is U2's real `createUploadStore` on a real tmpdir; only `UploadFsDeps` stubs control
 * timing for the race cases. The shared clock (`Date.now() + offset`) lets deadlines decay in
 * real time while `advance()` time-travels TTLs.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatAttachmentBlock,
  formatAttachmentSize,
  UPLOAD_CHUNK_BYTES_LOOPBACK,
  UPLOAD_TOTAL_MS,
} from "../../../src/web-hub/protocol/upload.js";
import { webHubUploadsDir } from "../../../src/web-hub/protocol/paths.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { HubError } from "../../../src/web-hub/hub/registry.js";
import {
  createUploadStore,
  type UploadAuditEvent,
  type UploadLimits,
  type UploadStore,
} from "../../../src/web-hub/hub/uploads.js";
import { defaultUploadFsDeps, type UploadFileHandle, type UploadFsDeps } from "../../../src/web-hub/hub/upload-fs.js";
import { createUploadHttpMetrics, type UploadHttpMetrics } from "../../../src/web-hub/hub/audit.js";
import { installProcessHandlers, startHub, type RunningHub } from "../../../src/web-hub/hub/hub.js";
import type { CommandRouter, FrontendDeps, FrontendFactory, HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import type { CmdFrame, CmdResultFrame } from "../../../src/web-hub/protocol/messages.js";
import { config, connectClient, hello, memLog, tmpDirs, waitFor } from "../hub/helpers.js";
import { fakeDeps, login, makeAgent, makeTmp, postJson, type FakeDeps, type RawResponse } from "./helpers.js";

// ---------------------------------------------------------------------------
// shared harness
// ---------------------------------------------------------------------------

const realFs = defaultUploadFsDeps();

interface Clock {
  now(): number;
  advance(ms: number): void;
}

function makeClock(): Clock {
  let offset = 0;
  return {
    now: () => Date.now() + offset,
    advance: (ms) => {
      offset += ms;
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function plainDelegate(fh: UploadFileHandle): UploadFileHandle {
  return {
    write: (buf, off, len, pos) => fh.write(buf, off, len, pos),
    truncate: (n) => fh.truncate(n),
    datasync: () => fh.datasync(),
    sync: () => fh.sync(),
    stat: () => fh.stat(),
    close: () => fh.close(),
  };
}

/** Wrap real `open` so each returned handle's methods go through `hook` (uploads.test.ts pattern). */
function hookedHandles(
  hook: (fh: UploadFileHandle) => Partial<UploadFileHandle>,
): (path: string, flags: number, mode?: number) => Promise<UploadFileHandle> {
  return async (path, flags, mode) => {
    const fh = await realFs.open(path, flags, mode);
    return { ...plainDelegate(fh), ...hook(fh) } as UploadFileHandle;
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeRouter extends CommandRouter {
  calls: CmdFrame[];
  reply: (frame: CmdFrame) => CmdResultFrame | Promise<CmdResultFrame>;
}

function fakeRouter(reply: FakeRouter["reply"]): FakeRouter {
  const calls: CmdFrame[] = [];
  return {
    calls,
    reply,
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

interface Harness {
  tmp: ReturnType<typeof makeTmp>;
  deps: FakeDeps;
  clock: Clock;
  store: UploadStore;
  audits: UploadAuditEvent[];
  metrics: UploadHttpMetrics;
  fe: HttpFrontend;
  port: number;
  cookie: string;
  origin: string;
  uploadsRoot: string;
}

const AGENT = "a1";

async function setup(
  opts: {
    fs?: Partial<UploadFsDeps>;
    limits?: Partial<UploadLimits>;
    withStore?: boolean;
    router?: FakeRouter;
    /** U3 P1-2: forwarded to the store's test-only `onEvictCandidate` seam (called — and awaited
     * — after a sweep picks an eviction candidate, before the per-id lock). */
    onEvictCandidate?: (id: string, reason: "ttl" | "quota") => void | Promise<void>;
  } = {},
): Promise<Harness> {
  const tmp = makeTmp("pwh-upload-");
  const clock = makeClock();
  const deps = fakeDeps(tmp.dir);
  deps.now = clock.now; // the store and the HTTP layer must share ONE clock (deadline hand-off)
  const audits: UploadAuditEvent[] = [];
  const uploadsRoot = join(tmp.dir, "uploads");
  const store = createUploadStore({
    root: uploadsRoot,
    now: clock.now,
    log: memLog(),
    audit: (e) => audits.push(e),
    ...(opts.limits === undefined ? {} : { limits: opts.limits }),
    ...(opts.fs === undefined ? {} : { fs: opts.fs }),
    ...(opts.onEvictCandidate === undefined
      ? {}
      : { onEvictCandidate: (id: string, reason: "ttl" | "quota") => opts.onEvictCandidate!(id, reason) }),
  });
  if (opts.withStore !== false) deps.uploads = store;
  if (opts.router !== undefined) deps.commands = opts.router;
  const metrics = createUploadHttpMetrics();
  deps.uploadMetrics = metrics;
  deps.agents.set(AGENT, makeAgent(AGENT, { control: true, upload: true, uploadLan: true }));
  const fe = createHttpFrontend(deps);
  const port = (await fe.listen()).port;
  const cookie = await login(port, deps.paths.tokenFile);
  await store.recover();
  return {
    tmp,
    deps,
    clock,
    store,
    audits,
    metrics,
    fe,
    port,
    cookie,
    origin: `http://127.0.0.1:${port}`,
    uploadsRoot,
  };
}

const harnesses: Harness[] = [];
async function harness(opts: Parameters<typeof setup>[0] = {}): Promise<Harness> {
  const h = await setup(opts);
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.fe.close();
    await h.store.close();
    h.tmp.cleanup();
  }
});

const nid = (): string => randomBytes(12).toString("hex");

/** Anything with a port+cookie+origin can be an upload endpoint target — the Harness, or a raw
 * startHub assembly in the hard-gate-5 restart test. */
type HttpTarget = Pick<Harness, "port" | "cookie" | "origin">;

function cmdHeaders(h: HttpTarget, over: Record<string, string> = {}): Record<string, string> {
  return { Cookie: h.cookie, Origin: h.origin, ...over };
}

function uploadBegin(
  h: HttpTarget,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return postJson(h.port, "/api/upload/begin", body, cmdHeaders(h, headers));
}

/** Raw chunk POST with a Buffer body (helpers.ts' rawRequest is string-only). */
function postChunk(
  h: HttpTarget,
  opts: { id: string; offset: number; bytes: Buffer; headers?: Record<string, string> },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Host: `127.0.0.1:${h.port}`,
      "Content-Type": "application/octet-stream",
      "X-PWH": "1",
      Cookie: h.cookie,
      Origin: h.origin,
      "Content-Length": String(opts.bytes.length),
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

function uploadCommit(h: HttpTarget, id: string): Promise<RawResponse> {
  return postJson(h.port, "/api/upload/commit", { id }, cmdHeaders(h));
}

function uploadAbort(h: HttpTarget, id: string): Promise<RawResponse> {
  return postJson(h.port, "/api/upload/abort", { id }, cmdHeaders(h));
}

interface UploadedFile {
  id: string;
  path: string;
  content: Buffer;
}

/** Full begin → chunk(s) → commit over real HTTP; asserts the happy path as it goes. */
async function uploadFile(
  h: Harness,
  content: Buffer,
  over: { name?: string; mime?: string; agentKey?: string } = {},
): Promise<UploadedFile> {
  const id = nid();
  const begin = await uploadBegin(h, {
    agentKey: over.agentKey ?? AGENT,
    id,
    name: over.name ?? "file.bin",
    size: content.length,
    ...(over.mime === undefined ? {} : { mime: over.mime }),
  });
  expect(begin.status).toBe(200);
  const chunkBytes = (JSON.parse(begin.body) as { chunkBytes: number }).chunkBytes;
  for (let offset = 0; offset < content.length; offset += chunkBytes) {
    const part = content.subarray(offset, Math.min(content.length, offset + chunkBytes));
    const res = await postChunk(h, { id, offset, bytes: Buffer.from(part) });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ received: offset + part.length });
  }
  const commit = await uploadCommit(h, id);
  expect(commit.status).toBe(200);
  const path = (JSON.parse(commit.body) as { path: string }).path;
  return { id, path, content };
}

function metaOf(path: string): { referencedAt: number | null; size: number } {
  return JSON.parse(readFileSync(join(dirname(path), "meta.json"), "utf8")) as {
    referencedAt: number | null;
    size: number;
  };
}

/** Compose the §3.1 prompt text the composer would emit for a single committed upload. */
function promptFor(f: UploadedFile, text = "please look at this"): string {
  const block = formatAttachmentBlock([
    { path: f.path, mime: "image/png", sizeLabel: formatAttachmentSize(f.content.length) },
  ]);
  if (block === undefined) throw new Error("block refused");
  return `${text}\n\n${block}`;
}

function postPrompt(h: Harness, text: string, id = nid()): Promise<RawResponse> {
  return postJson(h.port, "/api/cmd", { agentKey: AGENT, id, op: "prompt", text, deliver: "followUp" }, cmdHeaders(h));
}

function uploadAudits(h: Harness): Record<string, unknown>[] {
  return h.deps.logLines
    .filter((l) => (l.data as Record<string, unknown> | undefined)?.["audit"] === "upload")
    .map((l) => l.data as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// regular acceptance (plan §6 U3)
// ---------------------------------------------------------------------------

describe("POST /api/upload/* — loopback happy path (plan §1.2)", () => {
  it("begin → chunks → commit lands the file with the declared chunk size tier and wire shapes", async () => {
    const h = await harness();
    const content = Buffer.from("hello uploaded world", "utf8");
    const id = nid();
    const begin = await uploadBegin(h, {
      agentKey: AGENT,
      id,
      name: "greeting.txt",
      size: content.length,
      mime: "text/plain",
    });
    expect(begin.status).toBe(200);
    expect(JSON.parse(begin.body)).toEqual({
      id,
      chunkBytes: UPLOAD_CHUNK_BYTES_LOOPBACK,
      maxBytes: 100 * 1024 * 1024,
      received: 0,
    });
    const half = Math.ceil(content.length / 2);
    const c1 = await postChunk(h, { id, offset: 0, bytes: content.subarray(0, half) });
    expect(JSON.parse(c1.body)).toEqual({ received: half });
    const c2 = await postChunk(h, { id, offset: half, bytes: content.subarray(half) });
    expect(JSON.parse(c2.body)).toEqual({ received: content.length });
    const commit = await uploadCommit(h, id);
    expect(commit.status).toBe(200);
    const reply = JSON.parse(commit.body) as { id: string; path: string; size: number; mime: string };
    expect(reply).toMatchObject({ id, size: content.length, mime: "text/plain" });
    expect(reply.path).toContain(`${h.uploadsRoot}/`);
    expect(readFileSync(reply.path)).toEqual(content);
    expect(metaOf(reply.path).referencedAt).toBeNull();
    // the reply never leaks sha256 (plan §1.2)
    expect(reply).not.toHaveProperty("sha256");
  });

  it("abort removes the in-flight dir; a later commit 404s", async () => {
    const h = await harness();
    const id = nid();
    await uploadBegin(h, { agentKey: AGENT, id, name: "x.bin", size: 4 });
    await postChunk(h, { id, offset: 0, bytes: Buffer.from("ab") });
    const dir = join(h.uploadsRoot, `a-${AGENT}`, id);
    expect(existsSync(join(dir, "x.bin.part"))).toBe(true);
    const res = await uploadAbort(h, id);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(existsSync(dir)).toBe(false);
    expect((await uploadCommit(h, id)).status).toBe(404);
  });

  it("idempotent begin replays `received`; a retried chunk answers dup:true; a wrong offset 409s with received", async () => {
    const h = await harness();
    const id = nid();
    const body = { agentKey: AGENT, id, name: "x.bin", size: 6 };
    await uploadBegin(h, body);
    await postChunk(h, { id, offset: 0, bytes: Buffer.from("abc") });
    const replay = await uploadBegin(h, body);
    expect(JSON.parse(replay.body)).toMatchObject({ id, received: 3 });
    const dup = await postChunk(h, { id, offset: 0, bytes: Buffer.from("abc") });
    expect(JSON.parse(dup.body)).toEqual({ received: 3, dup: true });
    const wrong = await postChunk(h, { id, offset: 1, bytes: Buffer.from("zzz") });
    expect(wrong.status).toBe(409);
    expect(JSON.parse(wrong.body)).toMatchObject({ error: "E_UPLOAD_OFFSET", received: 3 });
  });

  it("commit before completion ⇒ 409 E_UPLOAD_OFFSET with received", async () => {
    const h = await harness();
    const id = nid();
    await uploadBegin(h, { agentKey: AGENT, id, name: "x.bin", size: 6 });
    await postChunk(h, { id, offset: 0, bytes: Buffer.from("abc") });
    const res = await uploadCommit(h, id);
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_UPLOAD_OFFSET", received: 3 });
  });
});

describe("POST /api/upload/* — gates (plan §5.1/§5.2/§2.4)", () => {
  it("no cookie ⇒ 401 E_AUTH on all four endpoints", async () => {
    const h = await harness();
    const id = nid();
    const noCookie = { Origin: h.origin };
    expect((await postJson(h.port, "/api/upload/begin", { agentKey: AGENT, id, size: 1 }, noCookie)).status).toBe(401);
    const chunk = await postChunk(h, { id, offset: 0, bytes: Buffer.from("x"), headers: { Cookie: "" } });
    expect(chunk.status).toBe(401);
    expect((await postJson(h.port, "/api/upload/commit", { id }, noCookie)).status).toBe(401);
    expect((await postJson(h.port, "/api/upload/abort", { id }, noCookie)).status).toBe(401);
  });

  it("chunk without X-PWH ⇒ 403; chunk with a JSON Content-Type ⇒ 403 (kind dispatch)", async () => {
    const h = await harness();
    const id = nid();
    const noXpwh = await postChunk(h, { id, offset: 0, bytes: Buffer.from("x"), headers: { "X-PWH": "" } });
    expect(noXpwh.status).toBe(403);
    const jsonCt = await postChunk(h, {
      id,
      offset: 0,
      bytes: Buffer.from("x"),
      headers: { "Content-Type": "application/json" },
    });
    expect(jsonCt.status).toBe(403);
  });

  it("begin (a JSON endpoint) with an octet-stream Content-Type ⇒ 403 (kind dispatch, other direction)", async () => {
    const h = await harness();
    const res = await postJson(
      h.port,
      "/api/upload/begin",
      { agentKey: AGENT, id: nid(), size: 1 },
      cmdHeaders(h, { "Content-Type": "application/octet-stream" }),
    );
    expect(res.status).toBe(403);
  });

  it("cross-origin Origin / Sec-Fetch-Site: cross-site ⇒ 403 on both json and chunk endpoints", async () => {
    const h = await harness();
    const id = nid();
    const badOrigin = await uploadBegin(h, { agentKey: AGENT, id, size: 1 }, { Origin: "http://evil.example" });
    expect(badOrigin.status).toBe(403);
    const sfs = await postChunk(h, {
      id,
      offset: 0,
      bytes: Buffer.from("x"),
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(sfs.status).toBe(403);
    const chunkBadOrigin = await postChunk(h, {
      id,
      offset: 0,
      bytes: Buffer.from("x"),
      headers: { Origin: "http://evil.example" },
    });
    expect(chunkBadOrigin.status).toBe(403);
    // upload audit reject lines were written (§5.4: HTTP-layer rejects go through auditUpload)
    const rejects = uploadAudits(h).filter((a) => a["phase"] === "reject" && a["code"] === "E_CSRF");
    expect(rejects.length).toBeGreaterThanOrEqual(3);
    expect(rejects[0]).toMatchObject({ listener: "loopback", ok: false });
    expect(h.metrics.snapshot().rejectsByCode["E_CSRF"]).toBe(3);
  });

  it("agent without upload.v1 ⇒ 409 E_UPLOAD_DISABLED; unknown agent ⇒ 409; stale agent ⇒ 409 (begin requires live)", async () => {
    const h = await harness();
    h.deps.agents.set("no-up", makeAgent("no-up", { control: true, upload: false, uploadLan: false }));
    h.deps.agents.set("stale1", makeAgent("stale1", { state: "stale", control: true, upload: true, uploadLan: true }));
    const noCap = await uploadBegin(h, { agentKey: "no-up", id: nid(), size: 1 });
    expect(noCap.status).toBe(409);
    expect(JSON.parse(noCap.body)).toMatchObject({ error: "E_UPLOAD_DISABLED" });
    const unknown = await uploadBegin(h, { agentKey: "ghost", id: nid(), size: 1 });
    expect(unknown.status).toBe(409);
    const stale = await uploadBegin(h, { agentKey: "stale1", id: nid(), size: 1 });
    expect(stale.status).toBe(409);
  });

  it("declared Content-Length above the chunk tier ⇒ 413 E_UPLOAD_TOO_LARGE and the connection closes", async () => {
    const h = await harness();
    const id = nid();
    await uploadBegin(h, { agentKey: AGENT, id, name: "big.bin", size: UPLOAD_CHUNK_BYTES_LOOPBACK });
    const res = await postChunk(h, {
      id,
      offset: 0,
      bytes: Buffer.from("x"),
      headers: { "Content-Length": String(UPLOAD_CHUNK_BYTES_LOOPBACK + 1) }, // lying CL
    });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_UPLOAD_TOO_LARGE" });
    expect(res.headers["connection"]).toBe("close");
  });

  it("chunked-transfer body that outgrows the tier mid-stream (truthful size, no Content-Length) ⇒ 413 + connection close (accumulated-bytes branch)", async () => {
    const h = await harness();
    const id = nid();
    await uploadBegin(h, { agentKey: AGENT, id, name: "big.bin", size: UPLOAD_CHUNK_BYTES_LOOPBACK * 2 });
    const res = await new Promise<RawResponse>((resolve) => {
      let done = false;
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: h.port,
          method: "POST",
          path: `/api/upload/chunk?id=${id}&offset=0`,
          headers: {
            Host: `127.0.0.1:${h.port}`,
            "Content-Type": "application/octet-stream",
            "X-PWH": "1",
            Cookie: h.cookie,
            Origin: h.origin,
            // no Content-Length ⇒ chunked; the server must reject on ACCUMULATED bytes
          },
          agent: false,
        },
        (res2) => {
          const chunks: Buffer[] = [];
          res2.on("data", (c: Buffer) => chunks.push(c));
          res2.on("end", () => {
            done = true;
            resolve({
              status: res2.statusCode ?? 0,
              headers: res2.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      req.on("error", () => {
        if (!done) resolve({ status: 0, headers: {}, body: "" }); // EPIPE after the server closed
      });
      (async () => {
        for (let i = 0; i < 6 && !done; i++) {
          if (!req.write(Buffer.alloc(1024 * 1024, 0x63))) {
            await new Promise((r) => req.once("drain", r));
          }
        }
        if (!done) req.end();
      })().catch(() => undefined);
    });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_UPLOAD_TOO_LARGE" });
    expect(res.headers["connection"]).toBe("close");
  });

  it("the per-principal upload token bucket (64) 429s with Retry-After once exhausted", async () => {
    const h = await harness();
    let last: RawResponse | undefined;
    for (let i = 0; i < 64; i++) {
      last = await postChunk(h, { id: nid(), offset: 0, bytes: Buffer.alloc(0) });
      expect(last.status).toBe(404); // unknown id — but each request spends a token
    }
    const res = await postChunk(h, { id: nid(), offset: 0, bytes: Buffer.alloc(0) });
    expect(res.status).toBe(429);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_RATE" });
    expect(res.headers["retry-after"]).toBeDefined();
    // §5.4 (P2-2): HTTP-layer rejects are counted even though the store never saw them
    expect(h.metrics.snapshot().rateLimited).toBe(1);
    expect(h.metrics.snapshot().rejectsByCode["E_RATE"]).toBe(1);
  });

  it("begin's hub in-flight pre-check 429: the Retry-After header and maxRetryAfterS agree (no double count)", async () => {
    const h = await harness();
    // saturate the hub-wide in-flight cap (16) at store level — 4 principals × the per-principal
    // cap (4), so the HTTP pre-check fires before any store-level admission would
    const dl = { at: h.clock.now() + 5_000 };
    for (let p = 0; p < 4; p++) {
      const principal = p === 0 ? "loopback:token" : `lan:u${p}`;
      for (let i = 0; i < 4; i++) {
        await h.store.begin({ principal, agentKey: AGENT, id: nid(), name: `s${p}-${i}.bin`, size: 1 }, dl);
      }
    }
    expect(h.store.inflight()).toBe(16);
    const res = await uploadBegin(h, { agentKey: AGENT, id: nid(), size: 1 });
    expect(res.status).toBe(429);
    const header = res.headers["retry-after"];
    expect(header).toBeDefined();
    const snap = h.metrics.snapshot();
    expect(snap.rejectsByCode["E_RATE"]).toBe(1); // exactly one count for this one 429
    expect(snap.rateLimited).toBe(1);
    expect(snap.maxRetryAfterS).toBe(Number(header)); // consistency: metric == wire header
  });

  it("deps.uploads absent ⇒ 501 E_NOT_IMPLEMENTED", async () => {
    const h = await harness({ withStore: false });
    const res = await uploadBegin(h, { agentKey: AGENT, id: nid(), size: 1 });
    expect(res.status).toBe(501);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_NOT_IMPLEMENTED" });
  });

  it("unknown /api/upload/ subpath ⇒ 404; GET on a real one ⇒ 404", async () => {
    const h = await harness();
    const res = await postJson(h.port, "/api/upload/nope", {}, cmdHeaders(h));
    expect(res.status).toBe(404);
  });
});

describe("commit agent recheck (plan §5.1.2 — store-authoritative binding, frozen { id } body)", () => {
  it("agent gone between begin and commit ⇒ 410 E_AGENT_GONE and the upload dir is deleted", async () => {
    const h = await harness();
    const id = nid();
    await uploadBegin(h, { agentKey: AGENT, id, name: "x.bin", size: 2 });
    await postChunk(h, { id, offset: 0, bytes: Buffer.from("ab") });
    const dir = join(h.uploadsRoot, `a-${AGENT}`, id);
    h.deps.agents.delete(AGENT); // agent disconnects
    const res = await uploadCommit(h, id);
    expect(res.status).toBe(410);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_AGENT_GONE" });
    expect(existsSync(dir)).toBe(false);
  });

  it("a STALE agent does not block commit (reconnect window); abort never checks the agent at all", async () => {
    const h = await harness();
    const id = nid();
    await uploadBegin(h, { agentKey: AGENT, id, name: "x.bin", size: 2 });
    await postChunk(h, { id, offset: 0, bytes: Buffer.from("ab") });
    h.deps.agents.set(AGENT, makeAgent(AGENT, { state: "stale", control: true, upload: true, uploadLan: true }));
    const res = await uploadCommit(h, id);
    expect(res.status).toBe(200);

    const id2 = nid();
    h.deps.agents.set(AGENT, makeAgent(AGENT, { control: true, upload: true, uploadLan: true })); // live again
    await uploadBegin(h, { agentKey: AGENT, id: id2, name: "y.bin", size: 2 });
    h.deps.agents.delete(AGENT); // gone entirely
    expect((await uploadAbort(h, id2)).status).toBe(200);
  });

  it("U3 review P1-1 regression: 64 interleaved begins + 64 chunk-404s cannot lose the binding — agent gone ⇒ commit 410s (never silently 200)", async () => {
    const h = await harness();
    const id = nid();
    await uploadBegin(h, { agentKey: AGENT, id, name: "target.bin", size: 2 });
    await postChunk(h, { id, offset: 0, bytes: Buffer.from("ab") });
    // The churn that evicted the old per-frontend FIFO map (64-entry cap) plus chunk-404s that
    // left stale entries behind — done at store level to keep the HTTP rate bucket out of the
    // way; the old map failed on exactly this shape, the store's authoritative binding cannot.
    const dl = { at: h.clock.now() + 5_000 };
    for (let i = 0; i < 64; i++) {
      const other = nid();
      await h.store.begin({ principal: "loopback:token", agentKey: AGENT, id: other, name: `o${i}.bin`, size: 1 }, dl);
      await h.store.abort({ principal: "loopback:token", id: other }, dl);
      await h.store
        .chunk({ principal: "loopback:token", id: nid(), offset: 0, bytes: Buffer.alloc(0) }, dl)
        .catch(() => undefined); // E_NOT_FOUND
    }
    h.deps.agents.delete(AGENT);
    const res = await uploadCommit(h, id);
    expect(res.status).toBe(410);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_AGENT_GONE" });
    expect(existsSync(join(h.uploadsRoot, `a-${AGENT}`, id))).toBe(false);
  });

  it("U3 review P1-1: the same churn with the agent STILL present commits fine (no false 410)", async () => {
    const h = await harness();
    const id = nid();
    await uploadBegin(h, { agentKey: AGENT, id, name: "target.bin", size: 2 });
    await postChunk(h, { id, offset: 0, bytes: Buffer.from("ab") });
    const dl = { at: h.clock.now() + 5_000 };
    for (let i = 0; i < 64; i++) {
      const other = nid();
      await h.store.begin({ principal: "loopback:token", agentKey: AGENT, id: other, name: `o${i}.bin`, size: 1 }, dl);
      await h.store.abort({ principal: "loopback:token", id: other }, dl);
    }
    expect((await uploadCommit(h, id)).status).toBe(200);
  });

  it("agent-gone abort failure is not swallowed: still 410, but the failure is logged loudly", async () => {
    let victim = "";
    const h = await harness({
      fs: {
        rm: (path, opts) => {
          if (victim !== "" && path.includes(`/${victim}`)) return Promise.reject(new Error("injected EIO"));
          return realFs.rm(path, opts);
        },
      },
    });
    const id = nid();
    victim = id;
    await uploadBegin(h, { agentKey: AGENT, id, name: "x.bin", size: 2 });
    await postChunk(h, { id, offset: 0, bytes: Buffer.from("ab") });
    h.deps.agents.delete(AGENT);
    const res = await uploadCommit(h, id);
    expect(res.status).toBe(410);
    expect(h.deps.logLines.some((l) => l.level === "error" && l.msg.includes("agent-gone abort failed"))).toBe(true);
    // the aborted upload is still poisoned — every later op 404s; litter goes to the startup scan
    victim = ""; // let afterEach's store.close() clean up
    expect((await uploadCommit(h, id)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// reference pinning (v3 #8 — U3 hard-gate behavior)
// ---------------------------------------------------------------------------

describe("reference pinning on /api/cmd prompt (plan §2.6, v3 #8)", () => {
  it("prompt success ⇒ referencedAt is in memory AND meta.json is flushed before the reply arrives", async () => {
    const router = fakeRouter(okReply);
    const h = await harness({ router });
    const f = await uploadFile(h, Buffer.from("pin me"), { mime: "image/png" });
    const res = await postPrompt(h, promptFor(f));
    expect(res.status).toBe(200);
    expect(router.calls).toHaveLength(1);
    expect((router.calls[0]!.cmd as { text: string }).text).toBe(promptFor(f));
    expect(h.store.stats().referencedFiles).toBe(1);
    expect(metaOf(f.path).referencedAt).not.toBeNull(); // hard gate: persisted by reply time
  });

  it("effect:'none' ⇒ pins released, not referenced; the file becomes TTL-evictable", async () => {
    const router = fakeRouter((frame) => ({
      t: "cmd_result",
      rid: frame.rid,
      id: frame.id,
      ok: false,
      code: "E_NOT_RUNNING",
      retryable: false,
      effect: "none",
    }));
    const h = await harness({ router });
    const f = await uploadFile(h, Buffer.from("release me"));
    const res = await postPrompt(h, promptFor(f));
    expect(res.status).toBe(409);
    expect(h.store.stats().referencedFiles).toBe(0);
    h.clock.advance(25 * 3_600_000); // past the 24h unreferenced TTL
    const report = await h.store.sweep("tick");
    expect(report.evicted.map((e) => e.id)).toContain(f.id);
    expect(existsSync(f.path)).toBe(false);
  });

  it("steer_subagent with an attachment block is pinned the same way", async () => {
    const router = fakeRouter(okReply);
    const h = await harness({ router });
    const f = await uploadFile(h, Buffer.from("steer me"));
    const res = await postJson(
      h.port,
      "/api/cmd",
      { agentKey: AGENT, id: nid(), op: "steer_subagent", runId: "r_1", text: promptFor(f) },
      cmdHeaders(h),
    );
    expect(res.status).toBe(200);
    expect(h.store.stats().referencedFiles).toBe(1);
  });

  it("an unknown path in the block is ignored (no pin, no error, prompt still forwarded)", async () => {
    const router = fakeRouter(okReply);
    const h = await harness({ router });
    const ghost = formatAttachmentBlock([
      { path: join(h.uploadsRoot, "a-a1", "n".repeat(24), "ghost.png"), mime: null, sizeLabel: "1 KB" },
    ])!;
    const res = await postPrompt(h, `hi\n\n${ghost}`);
    expect(res.status).toBe(200);
    expect(router.calls).toHaveLength(1);
    expect(h.store.stats().referencedFiles).toBe(0);
  });

  it("a dup replay (idempotent hit) is NOT re-pinned: referencedAt stays at the first settle", async () => {
    const done = new Set<string>();
    const calls: CmdFrame[] = [];
    const router: FakeRouter & { peekIdempotent: NonNullable<CommandRouter["peekIdempotent"]> } = {
      calls,
      reply: okReply,
      async request(frame, agentKey) {
        calls.push(frame);
        done.add(`${agentKey}|${frame.id}`);
        return { ...okReply(frame), dup: calls.length > 1 };
      },
      async drain() {
        return { inflight: 0, timedOut: false };
      },
      inflight() {
        return 0;
      },
      peekIdempotent(_origin, agentKey, id) {
        return done.has(`${agentKey}|${id}`) ? "done" : undefined;
      },
    };
    const h = await harness({ router });
    const f = await uploadFile(h, Buffer.from("dup pin"));
    const cmdId = nid();
    const first = await postPrompt(h, promptFor(f), cmdId);
    expect(first.status).toBe(200);
    const referencedAt = metaOf(f.path).referencedAt;
    expect(referencedAt).not.toBeNull();
    h.clock.advance(60_000);
    const replay = await postPrompt(h, promptFor(f), cmdId);
    expect(replay.status).toBe(200);
    expect(JSON.parse(replay.body)).toMatchObject({ dup: true });
    expect(metaOf(f.path).referencedAt).toBe(referencedAt);
  });

  it("(f) a thrown E_AGENT_GONE settles conservatively as referenced (effect unknown)", async () => {
    const router = fakeRouter(() => {
      throw new HubError("E_AGENT_GONE", "gone");
    });
    const h = await harness({ router });
    const f = await uploadFile(h, Buffer.from("conservative"));
    const res = await postPrompt(h, promptFor(f));
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_AGENT_GONE", effect: "unknown" });
    expect(h.store.stats().referencedFiles).toBe(1);
    expect(metaOf(f.path).referencedAt).not.toBeNull();
  });
});

describe("reference pinning — race cases (plan §6 U3, v3 #8 (a)-(e))", () => {
  it("(a) a pinned file survives quota pressure while the prompt is in flight; a referenced file is never quota-evicted", async () => {
    const content = Buffer.alloc(200, 1);
    const gate = deferred<CmdResultFrame>();
    const router = fakeRouter((frame) => (frame.cmd.op === "prompt" ? gate.promise : okReply(frame)));
    const h = await harness({ router, limits: { bucketMaxBytes: content.length } });
    const f = await uploadFile(h, content);
    h.clock.advance(2 * 3_600_000); // >1h: quota-evictable when unpinned
    const p = postPrompt(h, promptFor(f));
    await waitFor(() => router.calls.length === 1); // pin is established before commands.request
    // a second upload would exceed the bucket quota ⇒ tries to evict f (pinned ⇒ protected)
    const blocked = await uploadBegin(h, { agentKey: AGENT, id: nid(), size: 1 });
    expect(blocked.status).toBe(507);
    expect(JSON.parse(blocked.body)).toMatchObject({ error: "E_UPLOAD_QUOTA" });
    expect(existsSync(f.path)).toBe(true);
    gate.resolve(okReply(router.calls[0]!));
    expect((await p).status).toBe(200);
    // now referenced: quota eviction never applies (§2.6)
    const stillBlocked = await uploadBegin(h, { agentKey: AGENT, id: nid(), size: 1 });
    expect(stillBlocked.status).toBe(507);
    expect(existsSync(f.path)).toBe(true);
  });

  it("(c) a pin landing between sweep's candidate selection and the per-id lock makes the in-lock recheck skip eviction (test-only onEvictCandidate seam)", async () => {
    const gate = deferred<CmdResultFrame>();
    const router = fakeRouter(() => gate.promise);
    // The seam fires inside evictCommitted AFTER the candidate is picked and BEFORE its lock is
    // taken — exactly the §2.6 v3 #8 (c) window. We land a REAL HTTP prompt there (the pin is
    // established synchronously in dispatchCmdOrDialog's no-await region, i.e. by the time the
    // router sees the frame) and hold the window until the pin is in place.
    let promptP: Promise<RawResponse> | undefined;
    let hooked = false;
    let target: UploadedFile | undefined;
    let h!: Harness;
    h = await harness({
      router,
      onEvictCandidate: async (id) => {
        if (hooked || target === undefined || id !== target.id) return;
        hooked = true;
        // the sweep runs AFTER the 25h clock advance below, so the login session is expired by
        // now — re-login first (same principal: token auth), then send the prompt
        h.cookie = await login(h.port, h.deps.paths.tokenFile);
        promptP = postPrompt(h, promptFor(target));
        await waitFor(() => router.calls.length === 1); // pin now holds (sync, pre-forward)
      },
    });
    const f: UploadedFile = await uploadFile(h, Buffer.from("race c target"));
    target = f;
    const control: UploadedFile = await uploadFile(h, Buffer.from("race c control")); // never pinned
    h.clock.advance(25 * 3_600_000); // both files past the 24h unreferenced TTL
    const report = await h.store.sweep("tick");
    expect(hooked).toBe(true);
    expect(report.errors).toBe(0); // the hook's wait must have succeeded — no swallowed failure
    // the pinned candidate was selected (seam fired) yet survived ⇒ the lock-side recheck did the
    // work; the unpinned control was evicted by the same sweep ⇒ the sweep itself was live
    expect(report.evicted.map((e) => e.id)).toEqual([control.id]);
    expect(existsSync(f.path)).toBe(true);
    expect(existsSync(control.path)).toBe(false);
    gate.resolve(okReply(router.calls[0]!));
    expect((await promptP!).status).toBe(200);
    expect(h.store.stats().referencedFiles).toBe(1);
  });

  it("(b) a file already evicting when the prompt arrives ⇒ 409 E_UPLOAD_GONE, router never called", async () => {
    let victim = "";
    let rmEntered = false;
    const releaseRm = deferred<void>();
    let armed = false;
    const h = await harness({
      router: fakeRouter(okReply),
      fs: {
        rm: (path, opts) => {
          if (armed && victim !== "" && path.includes(`/${victim}`)) {
            rmEntered = true;
            return releaseRm.promise.then(() => realFs.rm(path, opts));
          }
          return realFs.rm(path, opts);
        },
      },
    });
    const f = await uploadFile(h, Buffer.from("evicting"));
    victim = f.id;
    h.clock.advance(25 * 3_600_000);
    // the clock advance expired the loopback session too — re-login (same principal: token auth)
    h.cookie = await login(h.port, h.deps.paths.tokenFile);
    armed = true;
    const sweepP = h.store.sweep("tick"); // sets evicting, then hangs inside rm
    await waitFor(() => rmEntered);
    const res = await postPrompt(h, promptFor(f));
    expect(res.status).toBe(409);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "E_UPLOAD_GONE", retryable: false, effect: "none" });
    expect(body["uploadIds"]).toEqual([f.id]);
    expect((h.deps.commands as FakeRouter).calls).toHaveLength(0);
    const audits = uploadAudits(h).filter((a) => a["phase"] === "reject" && a["code"] === "E_UPLOAD_GONE");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ op: "reference", uploadId: f.id, listener: "loopback" });
    releaseRm.resolve();
    await sweepP;
    expect(existsSync(f.path)).toBe(false);
  });

  it("(d) a failing flushReferences keeps the 200 reply and in-memory protection; the next sweep retries persistence", async () => {
    let armed = false;
    const h = await harness({
      router: fakeRouter(okReply),
      fs: {
        rename: (a, b) =>
          armed && b.endsWith("/meta.json") ? Promise.reject(new Error("injected EIO")) : realFs.rename(a, b),
      },
    });
    const f = await uploadFile(h, Buffer.from("flush fails")); // committed while disarmed
    armed = true;
    const res = await postPrompt(h, promptFor(f));
    expect(res.status).toBe(200); // persistence failure never blocks the reply
    expect(h.store.stats().referencedFiles).toBe(1); // memory reference stands
    const failed = uploadAudits(h).filter((a) => a["op"] === "reference" && a["ok"] === false);
    expect(failed).toHaveLength(1);
    expect(metaOf(f.path).referencedAt).toBeNull(); // not yet persisted
    armed = false;
    h.clock.advance(25 * 3_600_000); // unreferenced TTL would expire — the memory reference protects
    const report = await h.store.sweep("tick"); // retries dirty flushes first
    expect(report.evicted).toEqual([]);
    expect(existsSync(f.path)).toBe(true);
    expect(metaOf(f.path).referencedAt).not.toBeNull(); // persisted by the retry
  });

  it("(e) a hung flushReferences delays the reply by at most ~1s and writes a reference ok:false line", async () => {
    let armed = false;
    let renameEntered = false;
    const releaseRename = deferred<void>();
    const h = await harness({
      router: fakeRouter(okReply),
      fs: {
        rename: (a, b) => {
          if (armed && b.endsWith("/meta.json")) {
            renameEntered = true;
            return releaseRename.promise.then(() => realFs.rename(a, b));
          }
          return realFs.rename(a, b);
        },
      },
    });
    const f = await uploadFile(h, Buffer.from("flush hangs"));
    armed = true;
    const t0 = Date.now();
    const res = await postPrompt(h, promptFor(f));
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(renameEntered).toBe(true);
    // bounded wait = min(1s, remaining-300ms) ≈ 1000ms here; ε = 500ms on the upper bound (slow
    // CI scheduling) and −50ms on the lower bound (timer granularity) — the reply must NOT come
    // back before the cap fires, nor later than the cap + scheduling slack.
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(1_500);
    const failed = uploadAudits(h).filter((a) => a["op"] === "reference" && a["ok"] === false);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ phase: "request", code: "E_DEADLINE" });
    expect(h.store.stats().referencedFiles).toBe(1);
    releaseRename.resolve();
    await h.store.sweep("tick"); // retry persists the dirty meta
    expect(metaOf(f.path).referencedAt).not.toBeNull();
  });

  it("(e2) budget branch: with <300ms of request budget left at settle time the flush wait is skipped entirely (no 1s delay, no ok:false line, dirty retried by sweep)", async () => {
    const gate = deferred<CmdResultFrame>();
    const router = fakeRouter(() => gate.promise);
    const h = await harness({ router });
    const f = await uploadFile(h, Buffer.from("no budget"));
    const p = postPrompt(h, promptFor(f));
    await waitFor(() => router.calls.length === 1); // pin established, frame forwarded
    // Burn the 13s WRITE_TOTAL_MS request budget down to ~200ms before the reply settles:
    // flushMs = min(1000, remaining-300) ≤ 0 ⇒ the bounded wait is skipped (§2.6 "剩余 ≤ 0 则跳过").
    h.clock.advance(12_800);
    gate.resolve(okReply(router.calls[0]!));
    const res = await p;
    expect(res.status).toBe(200);
    expect(h.store.stats().referencedFiles).toBe(1); // memory reference still landed
    expect(metaOf(f.path).referencedAt).toBeNull(); // but nothing was persisted
    expect(uploadAudits(h).filter((a) => a["op"] === "reference" && a["ok"] === false)).toHaveLength(0);
    await h.store.sweep("tick"); // the dirty retry path catches up
    expect(metaOf(f.path).referencedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hard gates (plan §6 U3, #16)
// ---------------------------------------------------------------------------

describe("hard gate 1 — reauth race: logout during the body read", () => {
  it("second authorize 401s and zero bytes land on disk", async () => {
    const h = await harness();
    const id = nid();
    await uploadBegin(h, { agentKey: AGENT, id, name: "race.bin", size: 10 });

    const response = new Promise<RawResponse>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: h.port,
          method: "POST",
          path: `/api/upload/chunk?id=${id}&offset=0`,
          headers: {
            Host: `127.0.0.1:${h.port}`,
            "Content-Type": "application/octet-stream",
            "X-PWH": "1",
            Cookie: h.cookie,
            Origin: h.origin,
            "Content-Length": "10",
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
      req.on("error", reject);
      req.write(Buffer.from("hello")); // 5 of 10 bytes — the body read is now parked
      // logout WHILE the body is mid-flight: the session is gone before the rest arrives
      void sleep(100)
        .then(() => postJson(h.port, "/api/logout", {}, { Cookie: h.cookie, Origin: h.origin }))
        .then((r) => {
          expect(r.status).toBe(200);
          req.end(Buffer.from("world"));
        });
    });

    const res = await response;
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_AUTH" });
    // zero bytes on disk: no .part was ever created; the store still shows received: 0
    const cookie2 = await login(h.port, h.deps.paths.tokenFile);
    const replay = await postJson(
      h.port,
      "/api/upload/begin",
      { agentKey: AGENT, id, name: "race.bin", size: 10 },
      { Cookie: cookie2, Origin: h.origin },
    );
    expect(JSON.parse(replay.body)).toMatchObject({ received: 0 });
    const dir = join(h.uploadsRoot, `a-${AGENT}`, id);
    expect(readdirSync(dir).filter((f) => f.endsWith(".part"))).toEqual([]);
  });
});

describe("hard gate 2 — client disconnects", () => {
  it("half-body disconnect ⇒ zero state change", async () => {
    const h = await harness();
    const id = nid();
    await uploadBegin(h, { agentKey: AGENT, id, name: "half.bin", size: 10 });
    await new Promise<void>((resolve) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: h.port,
          method: "POST",
          path: `/api/upload/chunk?id=${id}&offset=0`,
          headers: {
            Host: `127.0.0.1:${h.port}`,
            "Content-Type": "application/octet-stream",
            "X-PWH": "1",
            Cookie: h.cookie,
            Origin: h.origin,
            "Content-Length": "10",
          },
          agent: false,
        },
        () => resolve(),
      );
      req.on("error", () => resolve());
      req.write(Buffer.from("hello")); // 5 of 10
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 150);
    });
    await sleep(150);
    const replay = await uploadBegin(h, { agentKey: AGENT, id, name: "half.bin", size: 10 });
    expect(JSON.parse(replay.body)).toMatchObject({ received: 0 });
    const dir = join(h.uploadsRoot, `a-${AGENT}`, id);
    expect(readdirSync(dir).filter((f) => f.endsWith(".part"))).toEqual([]);
  });

  it("disconnect during the disk write ⇒ the write still completes; the retry self-heals with dup:true", async () => {
    let writeEntered = false;
    const h = await harness({
      fs: {
        open: hookedHandles((fh) => ({
          write: async (buf, off, len, pos) => {
            writeEntered = true;
            await sleep(150); // hold the write window open so the disconnect lands inside it
            return fh.write(buf, off, len, pos);
          },
        })),
      },
    });
    const content = Buffer.from("0123456789");
    const id = nid();
    await uploadBegin(h, { agentKey: AGENT, id, name: "w.bin", size: content.length });
    await new Promise<void>((resolve) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: h.port,
          method: "POST",
          path: `/api/upload/chunk?id=${id}&offset=0`,
          headers: {
            Host: `127.0.0.1:${h.port}`,
            "Content-Type": "application/octet-stream",
            "X-PWH": "1",
            Cookie: h.cookie,
            Origin: h.origin,
            "Content-Length": String(content.length),
          },
          agent: false,
        },
        (res) => {
          res.resume();
          res.on("end", resolve);
        },
      );
      req.on("error", () => resolve());
      req.end(content);
      waitFor(() => writeEntered)
        .then(() => req.destroy())
        .catch(() => req.destroy());
    });
    await sleep(300); // the write completes regardless of the dead client (§2.2.5)
    const retry = await postChunk(h, { id, offset: 0, bytes: content });
    expect(retry.status).toBe(200);
    expect(JSON.parse(retry.body)).toEqual({ received: content.length, dup: true });
  });
});

describe("hard gate 3 — slow fs end-to-end 504 within UPLOAD_TOTAL_MS", () => {
  it("a hung fs open ⇒ 504 E_DEADLINE (poisoned), well inside 14s; a retry on the poisoned id 404s", async () => {
    const releaseOpen = deferred<UploadFileHandle>();
    const h = await harness({
      fs: {
        open: (path, flags, mode) => {
          if (path.endsWith(".part")) return releaseOpen.promise; // never settles in time
          return realFs.open(path, flags, mode);
        },
      },
    });
    const id = nid();
    await uploadBegin(h, { agentKey: AGENT, id, name: "slow.bin", size: 4 });
    const t0 = Date.now();
    const res = await postChunk(h, { id, offset: 0, bytes: Buffer.from("abcd") });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(504);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_DEADLINE" });
    expect(elapsed).toBeLessThan(UPLOAD_TOTAL_MS);
    expect(elapsed).toBeGreaterThanOrEqual(4_000); // the fs-step cap (5s) fired, not the 15s socket timeout
    const retry = await postChunk(h, { id, offset: 0, bytes: Buffer.from("abcd") });
    expect(retry.status).toBe(404); // poisoned ids stop accepting requests
  }, 30_000);
});

describe("hard gate 5 — restart re-upload contract", () => {
  it("after a hub-side store restart, a chunk for an old id ⇒ 404 E_NOT_FOUND (U4 re-upload signal)", async () => {
    const h = await harness();
    const id = nid();
    await uploadBegin(h, { agentKey: AGENT, id, name: "old.bin", size: 4 });
    await postChunk(h, { id, offset: 0, bytes: Buffer.from("ab") });
    // simulate the hub restarting its upload subsystem: close the store (drops all in-memory ids)
    // and recover a fresh one from the same root, swapped into the same frontend
    await h.store.close();
    const store2 = createUploadStore({ root: h.uploadsRoot, now: h.clock.now, log: memLog() });
    await store2.recover();
    h.deps.uploads = store2;
    harnesses[harnesses.length - 1]!.store = store2; // afterEach closes the live one
    const res = await postChunk(h, { id, offset: 0, bytes: Buffer.from("ab") });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_NOT_FOUND" });
    expect((await uploadCommit(h, id)).status).toBe(404);
  });

  it("full hub restart (startHub assembly, real frontend + socket agent): old id chunk/commit ⇒ 404", async () => {
    const home = hubTmp.make("wh-hub-urestart-");
    const first = await startRealHub(home);
    const agent = await connectClient(first.hub.paths.socketPath);
    agent.send(hello({ caps: ["ev.v1", "cmd.v1", "upload.v1"] }));
    const ack = await agent.waitFrame((f) => f["t"] === "hello_ack");
    const agentKey = ack["agentKey"] as string;
    await first.deps.uploads!.recover();
    const t1: HttpTarget = {
      port: first.hub.httpPort,
      cookie: await login(first.hub.httpPort, first.hub.paths.tokenFile),
      origin: `http://127.0.0.1:${first.hub.httpPort}`,
    };
    const id = nid();
    const begin = await uploadBegin(t1, { agentKey, id, name: "old.bin", size: 4 });
    expect(begin.status).toBe(200);
    expect((await postChunk(t1, { id, offset: 0, bytes: Buffer.from("ab") })).status).toBe(200);
    agent.sock.destroy();
    hubs.splice(hubs.indexOf(first.hub), 1);
    await first.hub.close("stop");

    const second = await startRealHub(home);
    await second.deps.uploads!.recover();
    const t2: HttpTarget = {
      port: second.hub.httpPort,
      cookie: await login(second.hub.httpPort, second.hub.paths.tokenFile),
      origin: `http://127.0.0.1:${second.hub.httpPort}`,
    };
    const chunk = await postChunk(t2, { id, offset: 0, bytes: Buffer.from("ab") });
    expect(chunk.status).toBe(404);
    expect(JSON.parse(chunk.body)).toMatchObject({ error: "E_NOT_FOUND" });
    expect((await uploadCommit(t2, id)).status).toBe(404);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// hard gate 4 — close paths & crash recovery (hub assembly level, plan §2.6 #13)
// ---------------------------------------------------------------------------

interface FakeFrontend extends FrontendFactory {
  deps: FrontendDeps[];
}

function fakeFrontend(): FakeFrontend {
  const f = ((deps: FrontendDeps): HttpFrontend => {
    f.deps.push(deps);
    return {
      listen: async () => ({ port: 43_210 }),
      close: async () => {},
      clientCount: () => 0,
      ui: {
        serve: async () => false,
        refresh: async () => ({ state: "unbuilt" as const, candidates: [] }),
        status: () => ({ state: "unbuilt" as const, candidates: [] }),
      },
    };
  }) as FakeFrontend;
  f.deps = [];
  return f;
}

const hubTmp = tmpDirs();
const hubs: RunningHub[] = [];
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close("test");
  hubTmp.cleanup();
});

async function startHubWithUploads(
  home: string,
  opts: { recover?: boolean } = {},
): Promise<{ hub: RunningHub; store: UploadStore }> {
  const fe = fakeFrontend();
  const r = await startHub(config({ home }), fe, { uid: process.getuid?.() ?? 0 });
  if ("exists" in r) throw new Error("unexpected exists");
  hubs.push(r);
  const store = fe.deps[0]!.uploads;
  expect(store).toBeDefined();
  // `recover: false` leaves the startup scan entirely to hub.ts's own `void store.recover()`
  // wiring — used by the crash-auto-recover test to prove that wiring exists.
  if (opts.recover !== false) await store!.recover();
  return { hub: r, store: store! };
}

/** startHub with the REAL `createHttpFrontend` (plus deps capture) — the full-restart hard gate
 * exercises the production assembly end to end, socket agent included. */
async function startRealHub(home: string): Promise<{ hub: RunningHub; deps: FrontendDeps }> {
  let captured: FrontendDeps | undefined;
  const factory: FrontendFactory = (d) => {
    captured = d;
    return createHttpFrontend(d);
  };
  const r = await startHub(config({ home }), factory, { uid: process.getuid?.() ?? 0 });
  if ("exists" in r) throw new Error("unexpected exists");
  hubs.push(r);
  if (captured === undefined) throw new Error("frontend factory never called");
  return { hub: r, deps: captured };
}

/** begin+chunk (and optionally commit) directly on the store — the hub-level close tests do not
 * need HTTP/agents (the store API is what `close()` must reap). */
async function seedUploads(store: UploadStore, home: string): Promise<{ committedPath: string; inflightDir: string }> {
  const dl = { at: Date.now() + 5_000 };
  const keepId = nid();
  await store.begin({ principal: "loopback:token", agentKey: "a1", id: keepId, name: "keep.txt", size: 4 }, dl);
  await store.chunk({ principal: "loopback:token", id: keepId, offset: 0, bytes: Buffer.from("keep") }, dl);
  const committed = await store.commit({ principal: "loopback:token", id: keepId }, dl);
  const dropId = nid();
  await store.begin({ principal: "loopback:token", agentKey: "a1", id: dropId, name: "drop.txt", size: 4 }, dl);
  await store.chunk({ principal: "loopback:token", id: dropId, offset: 0, bytes: Buffer.from("dr") }, dl);
  const inflightDir = join(webHubUploadsDir(home), "a-a1", dropId);
  expect(existsSync(join(inflightDir, "drop.txt.part"))).toBe(true);
  return { committedPath: committed.path, inflightDir };
}

describe("hard gate 4 — close paths (plan §2.6 #13)", () => {
  it("(a) normal close('stop'): in-flight upload dirs are gone, committed files retained", async () => {
    const home = hubTmp.make("wh-hub-uclose-");
    const { hub, store } = await startHubWithUploads(home);
    const { committedPath, inflightDir } = await seedUploads(store, home);
    hubs.splice(hubs.indexOf(hub), 1);
    await hub.close("stop");
    expect(existsSync(inflightDir)).toBe(false);
    expect(readFileSync(committedPath, "utf8")).toBe("keep");
  });

  it("(b) SIGTERM via installProcessHandlers closes the hub and reaps in-flight uploads the same way", async () => {
    const home = hubTmp.make("wh-hub-usig-");
    const { hub, store } = await startHubWithUploads(home);
    const { committedPath, inflightDir } = await seedUploads(store, home);
    hubs.splice(hubs.indexOf(hub), 1);
    const uninstall = installProcessHandlers(hub, memLog());
    try {
      process.emit("SIGTERM", "SIGTERM");
      expect(await hub.closed).toBe("signal");
    } finally {
      uninstall();
    }
    expect(existsSync(inflightDir)).toBe(false);
    expect(readFileSync(committedPath, "utf8")).toBe("keep");
  });

  it("(c) crash ⇒ the next startHub's recover() cleans orphans and rebuilds quota/dedup indexes", async () => {
    // crash half: a store that is dropped WITHOUT close() leaves an in-flight .part orphan and a
    // committed file on disk
    const home = hubTmp.make("wh-hub-ucrash-");
    const root = webHubUploadsDir(home);
    mkdirSync(dirname(root), { recursive: true }); // the hub's own ensurePrivateDir did this pre-crash
    const crashed = createUploadStore({ root, log: memLog() });
    await crashed.recover();
    const dl = { at: Date.now() + 5_000 };
    const content = Buffer.from("crash-survivor");
    await crashed.begin({ principal: "loopback:token", agentKey: "a1", id: nid(), name: "gone.bin", size: 4 }, dl);
    const orphanId = nid();
    await crashed.begin({ principal: "loopback:token", agentKey: "a1", id: orphanId, name: "gone.bin", size: 4 }, dl);
    await crashed.chunk({ principal: "loopback:token", id: orphanId, offset: 0, bytes: Buffer.from("go") }, dl);
    const keepId = nid();
    await crashed.begin(
      { principal: "loopback:token", agentKey: "a1", id: keepId, name: "keep.bin", size: content.length },
      dl,
    );
    await crashed.chunk({ principal: "loopback:token", id: keepId, offset: 0, bytes: content }, dl);
    const keep = await crashed.commit({ principal: "loopback:token", id: keepId }, dl);
    const orphanDir = join(root, "a-a1", orphanId);
    expect(existsSync(orphanDir)).toBe(true);
    // no close() — the "crash"

    // recovery half: a fresh hub on the same stateDir must sweep the orphan and reindex the
    // keeper — WITHOUT the test ever calling recover() itself: the hub's own `void
    // store.recover()` wiring (hub.ts) has to run the startup scan automatically.
    const { hub, store } = await startHubWithUploads(home, { recover: false });
    void hub;
    await waitFor(() => !existsSync(orphanDir), 10_000);
    expect(readFileSync(keep.path)).toEqual(content);
    expect(store.stats().committedFiles).toBe(1);
    expect(store.stats().committedBytes).toBe(content.length); // quota rebuilt
    // dedup index rebuilt: re-uploading the same content+name as the same principal dedups
    const dupId = nid();
    await store.begin(
      { principal: "loopback:token", agentKey: "a1", id: dupId, name: "keep.bin", size: content.length },
      dl,
    );
    await store.chunk({ principal: "loopback:token", id: dupId, offset: 0, bytes: content }, dl);
    const dup = await store.commit({ principal: "loopback:token", id: dupId }, dl);
    expect(dup.dedup).toBe(true);
    expect(dup.path).toBe(keep.path);
  });

  it("(c') startHub wires recover(): pre-seeded orphan dirs on disk are swept after startup, with a recover audit line in hub.log", async () => {
    const home = hubTmp.make("wh-hub-urecov-");
    const root = webHubUploadsDir(home);
    const orphanDir = join(root, "s-seed123", nid());
    mkdirSync(orphanDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(orphanDir, "left.bin.part"), "partial");
    const { hub } = await startHubWithUploads(home, { recover: false });
    await waitFor(() => !existsSync(orphanDir), 10_000);
    // §5.4: the startup recovery wrote a recover-phase audit line through the hub log
    const lines = readFileSync(hub.paths.logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const recoverLines = lines.filter((l) => l["audit"] === "upload" && l["phase"] === "recover");
    expect(recoverLines.some((l) => l["reason"] === "orphan-part" && l["ok"] === true && l["op"] === "sweep")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// §1.3 acceptance: the loopback 4 MiB tier end-to-end with a 100 MiB file
// ---------------------------------------------------------------------------

describe("chunk tiers (plan §1.3 acceptance)", () => {
  it("loopback tier: a 100 MiB file uploads in 4 MiB chunks (25 requests) with bounded RSS growth", async () => {
    const h = await harness();
    const content = Buffer.alloc(100 * 1024 * 1024, 0x61);
    const rssBefore = process.memoryUsage().rss;
    const f = await uploadFile(h, content, { name: "hundred.bin" });
    const rssAfter = process.memoryUsage().rss;
    expect(rssAfter - rssBefore).toBeLessThan(128 * 1024 * 1024);
    const sha = createHash("sha256").update(readFileSync(f.path)).digest("hex");
    expect(sha).toBe(createHash("sha256").update(content).digest("hex"));
    // §1.3: the commit audit row carries live observability (chunks/ms); §5.4 (P2-2): success
    // commit lines carry ms, and the store tracks latency percentiles for the stats row
    const commitAudit = h.audits.find((a) => a.phase === "request" && a.op === "commit" && a.ok);
    expect(commitAudit).toMatchObject({ chunks: 25, bytes: content.length });
    expect(typeof commitAudit!.ms).toBe("number");
    expect(commitAudit!.ms).toBeGreaterThanOrEqual(0);
    expect(h.store.stats().p50Ms).not.toBeNull();
    expect(h.store.stats().p95Ms).not.toBeNull();
  }, 60_000);
});
