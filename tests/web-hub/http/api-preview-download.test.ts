/**
 * preview-download 验收: `GET /api/preview?download=1` on the LOOPBACK listener — the REAL
 * `createPreviewRoutes` through the real `createHttpFrontend` HTTP stack (repo style), real
 * tmp-dir files (incl. one SPARSE file just over the 256 MiB cap — no real 256 MiB write).
 *
 * Covers: raw-byte round-trip of a binary (.zip) file (bytes equal the on-disk file, no
 * sniff gate), a >256 KiB TEXT served FULL (the preview flow would truncate it — download
 * does not), the Content-Disposition `filename*` shape (ASCII + percent-encoded non-ASCII),
 * the header contract (`X-PWH-Preview-Kind: download`, Content-Length, octet-stream,
 * nosniff), denylist 403 (the full admission chain stays — credentials never download), a
 * DIRECTORY with download=1 ⇒ 415 not-regular (pinned choice), `dir=1`+`download=1` ⇒ 400,
 * over-cap ⇒ 413 E_PREVIEW_TOO_LARGE{reason:"bytes"} BEFORE the head, unauthenticated ⇒ 401.
 */

import { ftruncateSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PREVIEW_DOWNLOAD_MAX_BYTES, PREVIEW_HDR, PREVIEW_PATH } from "../../../src/web-hub/protocol/preview.js";
import { webHubUploadsDir } from "../../../src/web-hub/protocol/paths.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import type { HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { createPreviewRoutes } from "../../../src/web-hub/hub/preview/routes.js";
import { denyCtxOf } from "../../../src/web-hub/hub/preview/admit.js";
import { fakeDeps, login, makeAgent, makeTmp, type FakeDeps } from "./helpers.js";
import { memLog } from "../hub/helpers.js";

const AGENT = "a4242-nonce12";
const SESSION = "sess123";

interface Harness {
  tmp: ReturnType<typeof makeTmp>;
  fe: HttpFrontend;
  port: number;
  cookie: string;
  cwd: string;
  file(rel: string, content: string | Buffer): string;
  get(p: string, extraQuery?: string, headers?: Record<string, string>): Promise<RawDlResponse>;
  cleanup(): Promise<void>;
}

interface RawDlResponse {
  status: number;
  headers: IncomingMessage["headers"];
  bytes: Buffer;
}

const harnesses: Harness[] = [];

async function harness(): Promise<Harness> {
  const tmp = makeTmp("pwh-download-");
  const deps: FakeDeps = fakeDeps(tmp.dir);
  const cwd = join(tmp.dir, "cwd");
  mkdirSync(cwd, { recursive: true });
  deps.agents.set(
    AGENT,
    makeAgent(AGENT, {
      session: { sessionId: SESSION, cwd, reason: "test", leafId: null, mode: "tui" },
    } as Parameters<typeof makeAgent>[1]),
  );
  const previewLog = memLog();
  deps.preview = createPreviewRoutes({
    mode: "on",
    denyCtx: denyCtxOf(tmp.dir, join(tmp.dir, ".pi/agent")),
    uploadsRoot: webHubUploadsDir(tmp.dir),
    registry: deps.registry,
    log: previewLog,
    now: deps.now,
  });
  const fe = createHttpFrontend(deps);
  const port = (await fe.listen()).port;
  const cookie = await login(port, deps.paths.tokenFile);
  const h: Harness = {
    tmp,
    fe,
    port,
    cookie,
    cwd,
    file(rel: string, content: string | Buffer): string {
      const p = join(cwd, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content);
      return p;
    },
    get(p: string, extraQuery = "", headers: Record<string, string> = {}): Promise<RawDlResponse> {
      const qs =
        `${PREVIEW_PATH}?agentKey=${encodeURIComponent(AGENT)}&sessionId=${encodeURIComponent(SESSION)}` +
        `&path=${encodeURIComponent(p)}${extraQuery}`;
      return new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            method: "GET",
            path: qs,
            headers: { "X-PWH": "1", Cookie: cookie, ...headers },
            agent: false,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes: Buffer.concat(chunks) }),
            );
            res.on("error", () =>
              resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes: Buffer.concat(chunks) }),
            );
          },
        );
        req.setTimeout(20_000, () => req.destroy(new Error("request timeout")));
        req.on("error", reject);
        req.end();
      });
    },
    async cleanup(): Promise<void> {
      await fe.close();
      tmp.cleanup();
    },
  };
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

describe("GET /api/preview?download=1 (preview-download)", () => {
  it("200: a binary (.zip) file round-trips byte-identically with the download header contract", async () => {
    const h = await harness();
    // 0x50 0x4B zip magic + non-text bytes — the preview flow would 415 this as binary
    const content = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(4096, 0x7f)]);
    const p = h.file("bundle.zip", content);
    const r = await h.get(p, "&download=1");
    expect(r.status).toBe(200);
    expect(r.bytes.equals(content)).toBe(true);
    expect(r.headers[PREVIEW_HDR.kind.toLowerCase()]).toBe("download");
    expect(r.headers["content-type"]).toBe("application/octet-stream");
    expect(r.headers["content-length"]).toBe(String(content.length));
    expect(r.headers["content-disposition"]).toBe(`attachment; filename*=UTF-8''bundle.zip`);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    // no sniff metadata leaks into a download answer
    expect(r.headers[PREVIEW_HDR.dims.toLowerCase()]).toBeUndefined();
    expect(r.headers[PREVIEW_HDR.truncated.toLowerCase()]).toBeUndefined();
  });

  it("200: a >256 KiB text downloads FULL (the preview flow would serve it truncated)", async () => {
    const h = await harness();
    const content = "x".repeat(300 * 1024); // over PREVIEW_TEXT_MAX_BYTES (256 KiB)
    const p = h.file("big.txt", content);
    const dl = await h.get(p, "&download=1");
    expect(dl.status).toBe(200);
    expect(dl.bytes.length).toBe(300 * 1024);
    // …and the SAME path without download=1 is the truncated text preview (256 KiB cap)
    const pv = await h.get(p);
    expect(pv.status).toBe(200);
    expect(pv.headers[PREVIEW_HDR.kind.toLowerCase()]).toBe("text");
    expect(pv.headers[PREVIEW_HDR.truncated.toLowerCase()]).toBe("1");
    expect(pv.bytes.length).toBeLessThan(300 * 1024);
  });

  it("200: a non-ASCII basename rides RFC 5987 filename* percent-encoding", async () => {
    const h = await harness();
    const p = h.file("报告 2026.bin", Buffer.from([1, 2, 3]));
    const r = await h.get(p, "&download=1");
    expect(r.status).toBe(200);
    expect(r.headers["content-disposition"]).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent("报告 2026.bin")}`,
    );
    expect(r.bytes.equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it("403 on a denylist hit — the admission chain is intact for downloads (credentials never download)", async () => {
    const h = await harness();
    const p = h.file(".ssh/id_rsa", "not-a-real-key");
    const r = await h.get(p, "&download=1");
    expect(r.status).toBe(403);
    expect(JSON.parse(r.bytes.toString("utf8")).error).toBe("E_PREVIEW_DENIED");
    expect(r.bytes.toString("utf8")).not.toContain("id_rsa");
  });

  it("415 not-regular for a DIRECTORY with download=1 (pinned choice), 400 for dir=1+download=1", async () => {
    const h = await harness();
    mkdirSync(join(h.cwd, "somedir"));
    const dir = await h.get(join(h.cwd, "somedir"), "&download=1");
    expect(dir.status).toBe(415);
    expect(JSON.parse(dir.bytes.toString("utf8"))).toMatchObject({
      error: "E_PREVIEW_UNSUPPORTED",
      reason: "not-regular",
    });
    const both = await h.get(join(h.cwd, "somedir"), "&dir=1&download=1");
    expect(both.status).toBe(400);
    expect(JSON.parse(both.bytes.toString("utf8")).error).toBe("E_BAD_REQUEST");
  });

  it("413 E_PREVIEW_TOO_LARGE{bytes} for a file over the 256 MiB cap (sparse file — no real write)", async () => {
    const h = await harness();
    const p = join(h.cwd, "huge.bin");
    const fd = openSync(p, "w");
    ftruncateSync(fd, PREVIEW_DOWNLOAD_MAX_BYTES + 1); // sparse: instant, no 256 MiB IO
    closeSync(fd);
    const r = await h.get(p, "&download=1");
    expect(r.status).toBe(413);
    const body = JSON.parse(r.bytes.toString("utf8"));
    expect(body).toMatchObject({ error: "E_PREVIEW_TOO_LARGE", reason: "bytes", max: PREVIEW_DOWNLOAD_MAX_BYTES });
  });

  it("401 unauthenticated; the download flag changes nothing about the auth gate", async () => {
    const h = await harness();
    const p = h.file("a.bin", Buffer.from([1]));
    const qs =
      `${PREVIEW_PATH}?agentKey=${encodeURIComponent(AGENT)}&sessionId=${encodeURIComponent(SESSION)}` +
      `&path=${encodeURIComponent(p)}&download=1`;
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: h.port, method: "GET", path: qs, headers: { "X-PWH": "1" }, agent: false },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(401);
    void readFileSync; // (fixture import sanity — no download happened)
  });
});
