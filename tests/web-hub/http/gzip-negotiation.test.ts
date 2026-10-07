/**
 * web-hub dynamic-response gzip negotiation tests (hub/gzip.ts wiring):
 *
 * - `/api/*` JSON (through `http.ts`'s single `sendJson` exit, exercised here via
 *   `GET /api/history` — the multi-hundred-KB page payload class): ≥2 KiB body + gzip-offering
 *   client ⇒ `Content-Encoding: gzip` + `Vary: Accept-Encoding` + post-compression
 *   `Content-Length`, gunzip round-trips to the exact original bytes; every non-eligible
 *   combination (no header, `gzip;q=0`, sub-floor body) stays byte-identical identity.
 * - SSE (`/api/events`) never carries `Content-Encoding` (flush semantics are out of scope).
 * - `/api/preview`: TEXT responses compress post-verify with the metadata headers still
 *   describing the original bytes; IMAGES (already-compressed formats) never compress.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HistoryPayload } from "../../../src/web-hub/protocol/http-contract.js";
import { webHubUploadsDir } from "../../../src/web-hub/protocol/paths.js";
import { PREVIEW_PATH } from "../../../src/web-hub/protocol/preview.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { createPreviewRoutes } from "../../../src/web-hub/hub/preview/routes.js";
import type { HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { fakeDeps, login, makeAgent, makeTmp, type FakeDeps } from "./helpers.js";
import { memLog } from "../hub/helpers.js";

// ---------------------------------------------------------------------------
// local harness (raw BYTES — helpers.ts's rawRequest utf8-decodes, useless for gunzip)
// ---------------------------------------------------------------------------

interface RawBytesResponse {
  status: number;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

function rawBytesRequest(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; timeoutMs?: number },
): Promise<RawBytesResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) };
    const req = httpRequest(
      { host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(opts.timeoutMs ?? 5_000, () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.end();
  });
}

/** Opens `/api/events`, captures the response HEADERS (before any frame), then drops the conn. */
function sseResponseHeaders(port: number, cookie: string): Promise<IncomingMessage["headers"]> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/api/events",
        headers: {
          Host: `127.0.0.1:${port}`,
          Cookie: cookie,
          Accept: "text/event-stream",
          "Accept-Encoding": "gzip",
        },
        agent: false,
      },
      (res) => {
        resolve(res.headers);
        req.destroy();
      },
    );
    req.on("error", () => undefined); // the deliberate destroy after resolve
    req.end();
  });
}

function bigHistory(agentKey: string, entryCount = 300, pad = 200): HistoryPayload {
  return {
    agentKey,
    entries: Array.from({ length: entryCount }, (_, i) => ({
      id: `e${i}`,
      parentId: i === 0 ? null : `e${i - 1}`,
      type: "message" as const,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", text: `history entry ${i} `.padEnd(pad, "x") },
    })),
    tailMessages: [],
    fromSeq: 1,
    hasMore: false,
    source: "file",
  };
}

// ---------------------------------------------------------------------------
// /api JSON negotiation
// ---------------------------------------------------------------------------

describe("api json gzip negotiation", () => {
  let tmp: ReturnType<typeof makeTmp>;
  let deps: FakeDeps;
  let fe: HttpFrontend;
  let port: number;
  let cookie: string;
  let big: HistoryPayload;

  beforeEach(async () => {
    tmp = makeTmp("pwh-gzip-");
    deps = fakeDeps(tmp.dir);
    deps.agents.set("a1", makeAgent("a1"));
    big = bigHistory("a1");
    deps.setPage(async () => big);
    fe = createHttpFrontend(deps);
    port = (await fe.listen()).port;
    cookie = await login(port, deps.paths.tokenFile);
  });

  afterEach(async () => {
    await fe.close();
    tmp.cleanup();
  });

  const history = (headers: Record<string, string>): Promise<RawBytesResponse> =>
    rawBytesRequest(port, {
      path: "/api/history?agent=a1&before=b1",
      headers: { Cookie: cookie, ...headers },
    });

  it("compresses a >2KiB JSON body for a gzip client (round-trip + Vary + Content-Length)", async () => {
    const r = await history({ "Accept-Encoding": "gzip" });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(r.headers["content-encoding"]).toBe("gzip");
    expect(r.headers["vary"]).toBe("Accept-Encoding");
    // Content-Length must name the COMPRESSED length (and actually be delivered in full)
    expect(Number(r.headers["content-length"])).toBe(r.body.length);
    expect(gunzipSync(r.body).toString("utf8")).toBe(JSON.stringify(big));
    // "体积显著缩小": 300 repetitive ~220B entries compress far below half
    expect(r.body.length).toBeLessThan(Buffer.byteLength(JSON.stringify(big)) / 2);
  });

  it("br, gzip, deflate is accepted too", async () => {
    const r = await history({ "Accept-Encoding": "br, gzip, deflate" });
    expect(r.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(r.body).toString("utf8")).toBe(JSON.stringify(big));
  });

  it("stays byte-identical identity without an Accept-Encoding header", async () => {
    const r = await history({});
    expect(r.status).toBe(200);
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(r.headers["vary"]).toBeUndefined();
    expect(Number(r.headers["content-length"])).toBe(Buffer.byteLength(JSON.stringify(big)));
    expect(r.body.toString("utf8")).toBe(JSON.stringify(big));
  });

  it("stays identity for gzip;q=0", async () => {
    const r = await history({ "Accept-Encoding": "gzip;q=0" });
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(r.body.toString("utf8")).toBe(JSON.stringify(big));
  });

  it("stays identity for a sub-floor (<2KiB) body even with gzip offered", async () => {
    const small = {
      agentKey: "a1",
      entries: [],
      tailMessages: [],
      fromSeq: 1,
      hasMore: false,
      source: "file",
    } as const;
    deps.setPage(async () => small);
    const r = await history({ "Accept-Encoding": "gzip" });
    expect(r.status).toBe(200);
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(r.headers["vary"]).toBeUndefined();
    expect(r.body.toString("utf8")).toBe(JSON.stringify(small));
  });

  it("never compresses SSE responses, even for a gzip client", async () => {
    const headers = await sseResponseHeaders(port, cookie);
    expect(headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(headers["content-encoding"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// /api/preview text vs image
// ---------------------------------------------------------------------------

const AGENT = "gzip-agent";
const SESSION = "sess-gzip";

function pngBytes(w: number, h: number, pad: number): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "ascii");
  head.writeUInt32BE(w, 16);
  head.writeUInt32BE(h, 20);
  return Buffer.concat([head, Buffer.alloc(pad)]);
}

describe("api preview gzip negotiation", () => {
  let tmp: ReturnType<typeof makeTmp>;
  let deps: FakeDeps;
  let fe: HttpFrontend;
  let port: number;
  let cookie: string;
  let cwd: string;

  beforeEach(async () => {
    tmp = makeTmp("pwh-gzip-pv-");
    deps = fakeDeps(tmp.dir);
    cwd = join(tmp.dir, "cwd");
    mkdirSync(cwd, { recursive: true });
    deps.agents.set(
      AGENT,
      makeAgent(AGENT, {
        session: { sessionId: SESSION, cwd, reason: "test", leafId: null, mode: "tui" } as never,
      }),
    );
    deps.preview = createPreviewRoutes({
      mode: "on",
      home: deps.config.home,
      uploadsRoot: webHubUploadsDir(tmp.dir),
      registry: deps.registry,
      log: memLog(),
      now: deps.now,
    });
    fe = createHttpFrontend(deps);
    port = (await fe.listen()).port;
    cookie = await login(port, deps.paths.tokenFile);
  });

  afterEach(async () => {
    await fe.close();
    tmp.cleanup();
  });

  const preview = (p: string, headers: Record<string, string>): Promise<RawBytesResponse> =>
    rawBytesRequest(port, {
      path: `${PREVIEW_PATH}?agentKey=${AGENT}&sessionId=${SESSION}&path=${encodeURIComponent(p)}`,
      headers: { "X-PWH": "1", Cookie: cookie, ...headers },
    });

  it("compresses a >2KiB TEXT preview; metadata headers still describe the original bytes", async () => {
    const content = "preview text line with some repetition\n".repeat(200); // ~7 KiB
    const p = join(cwd, "big.txt");
    writeFileSync(p, content);
    const r = await preview(p, { "Accept-Encoding": "gzip" });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(r.headers["x-pwh-preview-kind"]).toBe("text");
    expect(r.headers["x-pwh-preview-size"]).toBe(String(Buffer.byteLength(content)));
    expect(r.headers["x-pwh-preview-truncated"]).toBe("0");
    expect(r.headers["content-encoding"]).toBe("gzip");
    expect(r.headers["vary"]).toBe("Accept-Encoding");
    expect(Number(r.headers["content-length"])).toBe(r.body.length);
    expect(r.body.length).toBeLessThan(Buffer.byteLength(content) / 2);
    expect(gunzipSync(r.body).toString("utf8")).toBe(content);
  });

  it("keeps a small TEXT preview identity", async () => {
    const content = "tiny preview\n";
    const p = join(cwd, "small.txt");
    writeFileSync(p, content);
    const r = await preview(p, { "Accept-Encoding": "gzip" });
    expect(r.status).toBe(200);
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(r.headers["vary"]).toBeUndefined();
    expect(r.body.toString("utf8")).toBe(content);
  });

  it("keeps a TEXT preview identity without gzip offered", async () => {
    const content = "preview text line with some repetition\n".repeat(200);
    const p = join(cwd, "big2.txt");
    writeFileSync(p, content);
    const r = await preview(p, {});
    expect(r.status).toBe(200);
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(r.body.toString("utf8")).toBe(content);
  });

  it("never compresses an IMAGE preview (>2KiB png offered gzip)", async () => {
    const bytes = pngBytes(4, 4, 4096); // >2 KiB, dims parseable
    const p = join(cwd, "img.png");
    writeFileSync(p, bytes);
    const r = await preview(p, { "Accept-Encoding": "gzip" });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.headers["x-pwh-preview-kind"]).toBe("image");
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(r.headers["vary"]).toBeUndefined();
    expect(Number(r.headers["content-length"])).toBe(bytes.length);
    expect(r.body.equals(bytes)).toBe(true);
  });
});
