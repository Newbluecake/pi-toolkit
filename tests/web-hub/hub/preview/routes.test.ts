/**
 * web-hub content-preview — PV3 route-layer tests (`hub/preview/routes.ts`, plan v3 §3.1/§4.5).
 *
 * Direct `PreviewRoutes.handle()` calls over a fake req/res pair (the http-level matrix,
 * response headers and HP8 upload-tamper cases live in `tests/web-hub/http/api-preview.test.ts`
 * / `lan-preview.test.ts`; the hub-assembly wiring in `tests/web-hub/hub/hub-preview.test.ts`).
 * The fs admitter/verifier run REAL (real tmpdir + real fs) unless a case injects hooks —
 * same strategy as PV2a's suites. Covers: §3.1 steps ⓪–⑩ incl. every reject mapping, the
 * §4.5.1 three dispose paths (HP7), rate-limit + in-flight caps with 429-audit throttling,
 * the 4097-principal flood, fd-leak (HP6), the text-verify single-flight audit (1 hashed +
 * 2 joined), and the audit discipline (no raw path ever logged).
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPreviewRoutes } from "../../../../src/web-hub/hub/preview/routes.js";
import { createFsAdmitter, denyCtxOf } from "../../../../src/web-hub/hub/preview/admit.js";
import type { FsAdmitter, PreviewFs } from "../../../../src/web-hub/hub/preview/admit.js";
import { createPreviewIoTracker } from "../../../../src/web-hub/hub/preview/fs.js";
import { defaultPreviewFs } from "../../../../src/web-hub/hub/preview/fs.js";
import { createUploadVerifier } from "../../../../src/web-hub/hub/preview/verify.js";
import { createReqDeadline } from "../../../../src/web-hub/hub/req-deadline.js";
import type { PreviewRouteIo, PreviewRoutes, RegistryView } from "../../../../src/web-hub/hub/ports.js";
import type { OpenForPreviewParams, OpenForPreviewResult, UploadStore } from "../../../../src/web-hub/hub/uploads.js";
import { PREVIEW_IMAGE_MAX_PIXELS, PREVIEW_TEXT_MAX_BYTES } from "../../../../src/web-hub/protocol/preview.js";
import { memLog, type MemLog } from "../helpers.js";

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

function fakeReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

/** Minimal ServerResponse stand-in: exactly the surface `handle`/`resSink`/`io.sendJson` touch. */
class FakeRes extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  finished = false;
  destroyed = false;

  get headersSent(): boolean {
    return this.status !== 0;
  }

  get writableFinished(): boolean {
    return this.finished;
  }

  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    this.headers = { ...headers };
  }

  write(chunk: Buffer): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(chunk?: Buffer): void {
    if (chunk !== undefined) this.chunks.push(chunk);
    this.finished = true;
    this.emit("close");
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }

  body(): Buffer {
    return Buffer.concat(this.chunks);
  }

  json<T = unknown>(): T {
    return JSON.parse(this.body().toString("utf8")) as T;
  }
}

interface IoOpts {
  listener?: "loopback" | "lan";
  user?: string | null; // null ⇒ authorize answers 401 itself
  expectedOrigin?: string;
  users?: string[]; // per-call user sequence (in-flight tests)
}

function makeIo(opts: IoOpts = {}): PreviewRouteIo {
  let seq = 0;
  return {
    listener: opts.listener ?? "loopback",
    ip: "127.0.0.1",
    expectedOrigin: opts.expectedOrigin ?? "http://127.0.0.1:1",
    authorize: async () => {
      const user =
        opts.users !== undefined
          ? opts.users[Math.min(seq++, opts.users.length - 1)]
          : opts.user === null
            ? undefined
            : (opts.user ?? undefined);
      if (user === undefined && opts.user === null) {
        return { handled: true, code: "E_AUTH" };
      }
      return { ip: "127.0.0.1", ...(user === undefined ? {} : { user }) };
    },
    sendJson: (res, status, body, headers) => {
      const r = res as unknown as FakeRes;
      if (r.headersSent || r.destroyed) return;
      r.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...(headers ?? {}) });
      r.end(Buffer.from(JSON.stringify(body), "utf8"));
    },
  };
}

interface SessionFixture {
  agentKey: string;
  sessionId: string;
  cwd: string;
}

function makeRegistry(s: SessionFixture): Pick<RegistryView, "get"> & { withSession(v: boolean): void } {
  let withSession = true;
  let sessionId = s.sessionId;
  return {
    get: (k: string) =>
      k === s.agentKey
        ? ({
            agentKey: k,
            kind: "tui",
            pid: 1,
            cwd: s.cwd,
            state: "live",
            pluginVersion: "0",
            outdated: false,
            prompts: [],
            ...(withSession
              ? {
                  session: {
                    sessionId,
                    cwd: s.cwd,
                    reason: "test",
                    leafId: null,
                    mode: "tui" as const,
                  },
                }
              : {}),
          } as unknown as ReturnType<RegistryView["get"]>)
        : undefined,
    withSession(v: boolean): void {
      withSession = v;
    },
  };
}

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

function query(agentKey: string, sessionId: string, path: string): URLSearchParams {
  return new URLSearchParams({ agentKey, sessionId, path });
}

function previewAudits(log: MemLog): Array<Record<string, unknown>> {
  return log.lines.filter((l) => l.msg === "preview").map((l) => (l.data as Record<string, unknown>) ?? {});
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref?.());

// ---------------------------------------------------------------------------

let dir: string;
let log: MemLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wh-pv3-routes-"));
  log = memLog();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("PV3 routes — §3.1 pipeline", () => {
  const agentKey = "a4242-nonce12";
  const sessionId = "sess123";

  function fixture(): {
    cwd: string;
    file(rel: string, content: string | Buffer): string;
    registry: ReturnType<typeof makeRegistry>;
  } {
    const cwd = join(dir, "cwd");
    mkdirSync(cwd, { recursive: true });
    return {
      cwd,
      file(rel: string, content: string | Buffer): string {
        const p = join(cwd, rel);
        mkdirSync(join(p, ".."), { recursive: true });
        writeFileSync(p, content);
        return p;
      },
      registry: makeRegistry({ agentKey, sessionId, cwd }),
    };
  }

  function routes(
    registry: Pick<RegistryView, "get">,
    over: {
      uploads?: Pick<UploadStore, "openForPreview">;
      admitter?: FsAdmitter;
      verifier?: ReturnType<typeof createUploadVerifier>;
      now?: () => number;
      mode?: "on" | "loopback";
    } = {},
  ): PreviewRoutes {
    return createPreviewRoutes({
      mode: over.mode ?? "on",
      denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
      uploadsRoot: join(dir, "uploads-root"),
      registry,
      log,
      now: over.now ?? Date.now,
      ...(over.uploads === undefined ? {} : { uploads: over.uploads }),
      ...(over.admitter === undefined ? {} : { admitter: over.admitter }),
      ...(over.verifier === undefined ? {} : { verifier: over.verifier }),
    });
  }

  it("exposes its mode (ports' PreviewRoutes.mode)", () => {
    const fx = fixture();
    expect(routes(fx.registry).mode).toBe("on");
    expect(routes(fx.registry, { mode: "loopback" }).mode).toBe("loopback");
  });

  // ---- ⓪ closing ------------------------------------------------------------

  it("⓪ after dispose('close') every request answers 503 E_HUB_RESTARTING", async () => {
    const fx = fixture();
    const r = routes(fx.registry);
    await r.dispose("close", createReqDeadline(Date.now, 1_000));
    const res = new FakeRes();
    await r.handle(fakeReq({ "x-pwh": "1" }), res, query(agentKey, sessionId, "/x/y"), makeIo());
    expect(res.status).toBe(503);
    expect(res.json()).toEqual({ error: "E_HUB_RESTARTING" });
    expect(previewAudits(log).at(-1)).toMatchObject({ ok: false, code: "E_HUB_RESTARTING" });
  });

  it("⓪ dispose is idempotent and both reasons share one promise (§4.5.1)", async () => {
    const fx = fixture();
    const r = routes(fx.registry);
    const p1 = r.dispose("close", createReqDeadline(Date.now, 1_000));
    const p2 = r.dispose("startup-failure", createReqDeadline(Date.now, 1_000));
    expect(p2).toBe(p1);
    await Promise.all([p1, p2]);
    await r.dispose("close", createReqDeadline(Date.now, 1_000)); // still resolves
  });

  // ---- ① CSRF ---------------------------------------------------------------

  it("① missing X-PWH ⇒ 403 E_CSRF (before auth — an unauth probe learns nothing)", async () => {
    const fx = fixture();
    const res = new FakeRes();
    await routes(fx.registry).handle(fakeReq(), res, query(agentKey, sessionId, "/x/y"), makeIo({ user: null }));
    expect(res.status).toBe(403);
    expect(res.json()).toEqual({ error: "E_CSRF" });
    expect(previewAudits(log).at(-1)).toMatchObject({ code: "E_CSRF" });
  });

  it("① wrong Origin / cross-site Sec-Fetch-Site ⇒ 403; no Origin+no SFS passes", async () => {
    const fx = fixture();
    const p = fx.file("ok.txt", "hi");
    const r = routes(fx.registry);
    const io = makeIo({ expectedOrigin: "http://127.0.0.1:1" });

    const badOrigin = new FakeRes();
    await r.handle(
      fakeReq({ "x-pwh": "1", origin: "http://evil.example" }),
      badOrigin,
      query(agentKey, sessionId, p),
      io,
    );
    expect(badOrigin.status).toBe(403);

    const badSfs = new FakeRes();
    await r.handle(
      fakeReq({ "x-pwh": "1", origin: "http://127.0.0.1:1", "sec-fetch-site": "cross-site" }),
      badSfs,
      query(agentKey, sessionId, p),
      io,
    );
    expect(badSfs.status).toBe(403);

    // no Origin, no Sec-Fetch-Site (a plain same-origin fetch) ⇒ proceeds to a full 200
    const ok = new FakeRes();
    await r.handle(fakeReq({ "x-pwh": "1" }), ok, query(agentKey, sessionId, p), io);
    expect(ok.status).toBe(200);
    expect(ok.jsonError).toBeUndefined();
  });

  // ---- ② auth ---------------------------------------------------------------

  it("② authorize() that already answered mirrors only its code into the audit", async () => {
    const fx = fixture();
    const res = new FakeRes();
    await routes(fx.registry).handle(
      fakeReq({ "x-pwh": "1" }),
      res,
      query(agentKey, sessionId, "/x/y"),
      makeIo({ user: null }),
    );
    expect(res.status).toBe(0); // routes wrote nothing — authorize owned the 401
    expect(previewAudits(log).at(-1)).toMatchObject({ ok: false, code: "E_AUTH" });
  });

  // ---- ③ params -------------------------------------------------------------

  it.each([
    ["agentKey with bad char", { agentKey: "a/b", sessionId: "s1", path: "/x/y" }],
    ["agentKey too long", { agentKey: "a".repeat(65), sessionId: "s1", path: "/x/y" }],
    ["empty sessionId", { agentKey: "a1", sessionId: "", path: "/x/y" }],
    ["sessionId non-printable", { agentKey: "a1", sessionId: "s\n1", path: "/x/y" }],
    ["sessionId too long", { agentKey: "a1", sessionId: "s".repeat(129), path: "/x/y" }],
    ["relative path", { agentKey: "a1", sessionId: "s1", path: "x/y" }],
    ["dot segment", { agentKey: "a1", sessionId: "s1", path: "/x/../y" }],
    ["NUL in path", { agentKey: "a1", sessionId: "s1", path: "/x/y\0z" }],
  ])("③ %s ⇒ 400 E_BAD_REQUEST", async (_name, q) => {
    const fx = fixture();
    const res = new FakeRes();
    await routes(fx.registry).handle(
      fakeReq({ "x-pwh": "1" }),
      res,
      new URLSearchParams(q as Record<string, string>),
      makeIo(),
    );
    expect(res.status).toBe(400);
    expect(res.json()).toEqual({ error: "E_BAD_REQUEST" });
  });

  it("③ U4: a single-segment path now ENTERS admission (was 400 pre-dir-plan; §1.4 wire change)", async () => {
    const fx = fixture();
    const missing = new FakeRes();
    await routes(fx.registry).handle(
      fakeReq({ "x-pwh": "1" }),
      missing,
      new URLSearchParams({ agentKey, sessionId, path: "/only" }),
      makeIo(),
    );
    expect(missing.status).toBe(404); // realpath ENOTDIR/ENOENT — not the old 400
    expect(missing.json()).toEqual({ error: "E_NOT_FOUND" });

    // and a REAL single-segment file serves end-to-end (Linux CI fixture)
    const real = new FakeRes();
    await routes(fx.registry).handle(
      fakeReq({ "x-pwh": "1" }),
      real,
      new URLSearchParams({ agentKey, sessionId, path: "/etc/hostname" }),
      makeIo(),
    );
    expect(real.status).toBe(200);
    expect(real.headers["X-PWH-Preview-Kind"]).toBe("text");
  });

  // ---- ⑤ session ------------------------------------------------------------

  it("⑤ unknown agent ⇒ 404; missing session ⇒ 409; sessionId mismatch ⇒ 409", async () => {
    const fx = fixture();
    const r = routes(fx.registry);

    const unknown = new FakeRes();
    await r.handle(fakeReq({ "x-pwh": "1" }), unknown, query("nope", sessionId, "/x/y"), makeIo());
    expect(unknown.status).toBe(404);
    expect(unknown.json()).toEqual({ error: "E_NOT_FOUND" });

    fx.registry.withSession(false);
    const noSession = new FakeRes();
    await r.handle(fakeReq({ "x-pwh": "1" }), noSession, query(agentKey, sessionId, "/x/y"), makeIo());
    expect(noSession.status).toBe(409);
    expect(noSession.json()).toEqual({ error: "E_SESSION_CHANGED" });

    fx.registry.withSession(true);
    const mismatch = new FakeRes();
    await r.handle(fakeReq({ "x-pwh": "1" }), mismatch, query(agentKey, "other-session", "/x/y"), makeIo());
    expect(mismatch.status).toBe(409);
    expect(previewAudits(log).at(-1)).toMatchObject({ code: "E_SESSION_CHANGED" });
  });

  // ---- ⑦u upload class ------------------------------------------------------

  it("⑦u upload-class with no store wired ⇒ 404 (never 501 — §4.2)", async () => {
    const fx = fixture();
    const uploadsRoot = join(dir, "uploads-root");
    mkdirSync(uploadsRoot, { recursive: true });
    const res = new FakeRes();
    await routes(fx.registry).handle(
      fakeReq({ "x-pwh": "1" }),
      res,
      query(agentKey, sessionId, `${uploadsRoot}/s-sess123/upid1/f.txt`),
      makeIo(),
    );
    expect(res.status).toBe(404);
    expect(previewAudits(log).at(-1)).toMatchObject({ code: "E_NOT_FOUND", cls: "upload" });
  });

  it.each([
    ["E_BUSY", 503, { "Retry-After": "1" }],
    ["E_NOT_FOUND", 404, undefined],
    ["E_PREVIEW_CHANGED", 409, undefined],
    ["E_DEADLINE", 504, undefined],
  ] as const)("⑦u store code %s ⇒ %i", async (code, status, wantHeaders) => {
    const fx = fixture();
    const uploadsRoot = join(dir, "uploads-root");
    const uploads: Pick<UploadStore, "openForPreview"> = {
      openForPreview: async () => ({ ok: false, code }) as OpenForPreviewResult,
    };
    const res = new FakeRes();
    await routes(fx.registry, { uploads }).handle(
      fakeReq({ "x-pwh": "1" }),
      res,
      query(agentKey, sessionId, `${uploadsRoot}/s-sess123/x/f.txt`),
      makeIo(),
    );
    expect(res.status).toBe(status);
    expect(res.json()).toEqual({ error: code });
    if (wantHeaders !== undefined) expect(res.headers).toMatchObject(wantHeaders);
  });

  // ---- ⑧ sniff caps ---------------------------------------------------------

  it("⑧ binary ⇒ 415 {error,size,reason:binary}", async () => {
    const fx = fixture();
    const p = fx.file("blob.bin", Buffer.from([0, 1, 2, 3, 0, 5, 6, 7, 0, 9]));
    const res = new FakeRes();
    await routes(fx.registry).handle(fakeReq({ "x-pwh": "1" }), res, query(agentKey, sessionId, p), makeIo());
    expect(res.status).toBe(415);
    expect(res.json()).toEqual({ error: "E_PREVIEW_UNSUPPORTED", size: 10, reason: "binary" });
    expect(previewAudits(log).at(-1)).toMatchObject({ code: "E_PREVIEW_UNSUPPORTED", reason: "binary", cls: "cwd" });
  });

  it("⑧ oversized TEXT is served truncated at the 256 KiB display cap (§0: 截断不是拒绝)", async () => {
    const fx = fixture();
    const p = fx.file("big.txt", "a".repeat(PREVIEW_TEXT_MAX_BYTES + 100));
    const res = new FakeRes();
    await routes(fx.registry).handle(fakeReq({ "x-pwh": "1" }), res, query(agentKey, sessionId, p), makeIo());
    expect(res.status).toBe(200);
    expect(res.headers["X-PWH-Preview-Truncated"]).toBe("1");
    expect(res.headers["X-PWH-Preview-Size"]).toBe(String(PREVIEW_TEXT_MAX_BYTES + 100));
    expect(res.headers["Content-Length"]).toBe(String(PREVIEW_TEXT_MAX_BYTES));
    expect(res.body().length).toBe(PREVIEW_TEXT_MAX_BYTES);
    expect(previewAudits(log).at(-1)).toMatchObject({ ok: true, truncated: true, bytes: PREVIEW_TEXT_MAX_BYTES });
  });

  it("⑧ image over 40MP ⇒ 413 pixels with dims; dims-unknown JPEG ⇒ 415", async () => {
    const fx = fixture();
    const big = fx.file("huge.png", pngBytes(10_000, 5_000)); // 50MP, tiny file
    const res = new FakeRes();
    await routes(fx.registry).handle(fakeReq({ "x-pwh": "1" }), res, query(agentKey, sessionId, big), makeIo());
    expect(res.status).toBe(413);
    expect(res.json()).toEqual({
      error: "E_PREVIEW_TOO_LARGE",
      size: 24,
      max: PREVIEW_IMAGE_MAX_PIXELS,
      reason: "pixels",
      dims: { w: 10_000, h: 5_000 },
    });

    // JPEG whose SOF never appears within the 256 KiB scan window ⇒ dims-unknown
    const jpegJunk = fx.file("nosof.jpg", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(300 * 1024)]));
    const res2 = new FakeRes();
    await routes(fx.registry).handle(fakeReq({ "x-pwh": "1" }), res2, query(agentKey, sessionId, jpegJunk), makeIo());
    expect(res2.status).toBe(415);
    expect(res2.json()).toMatchObject({ error: "E_PREVIEW_UNSUPPORTED", reason: "dims-unknown" });
  });

  it("⑧ image byte cap rejects (413 bytes): loopback 16 MiB / lan 4 MiB (§4.1)", async () => {
    const fx = fixture();
    const over = fx.file("fat.png", pngBytes(4, 4, 16 * 1024 * 1024 + 1 - 24));
    const lan = new FakeRes();
    await routes(fx.registry).handle(
      fakeReq({ "x-pwh": "1" }),
      lan,
      query(agentKey, sessionId, over),
      makeIo({ listener: "lan" }),
    );
    expect(lan.status).toBe(413);
    expect((lan.json() as { reason: string }).reason).toBe("bytes");
    expect((lan.json() as { max: number }).max).toBe(4 * 1024 * 1024);

    const loopback = new FakeRes();
    await routes(fx.registry).handle(fakeReq({ "x-pwh": "1" }), loopback, query(agentKey, sessionId, over), makeIo());
    expect(loopback.status).toBe(413);
    expect((loopback.json() as { max: number }).max).toBe(16 * 1024 * 1024);
  });

  // ---- ⑨ happy paths --------------------------------------------------------

  it("⑨ cwd text: 200, X-PWH-Preview-* headers, exact bytes, audit ok", async () => {
    const fx = fixture();
    const content = "hello 预览\nline2";
    const p = fx.file("note.md", content);
    const res = new FakeRes();
    await routes(fx.registry).handle(fakeReq({ "x-pwh": "1" }), res, query(agentKey, sessionId, p), makeIo());
    expect(res.status).toBe(200);
    expect(res.headers["X-PWH-Preview-Kind"]).toBe("text");
    expect(res.headers["X-PWH-Preview-Size"]).toBe(String(Buffer.byteLength(content)));
    expect(res.headers["X-PWH-Preview-Truncated"]).toBe("0");
    expect(res.headers["Content-Disposition"]).toBe('attachment; filename="preview"');
    expect(res.headers["Cross-Origin-Resource-Policy"]).toBe("same-origin");
    expect(res.headers["Content-Type"]).toBe("text/plain; charset=utf-8");
    expect(res.body().toString("utf8")).toBe(content);
    expect(previewAudits(log).at(-1)).toMatchObject({
      ok: true,
      cls: "cwd",
      kind: "text",
      bytes: Buffer.byteLength(content),
      total: Buffer.byteLength(content),
      truncated: false,
      ext: "md",
    });
  });

  it("⑨ cwd image: 200 with dims header and raw bytes", async () => {
    const fx = fixture();
    const bytes = pngBytes(320, 200, 64);
    const p = fx.file("pic.png", bytes);
    const res = new FakeRes();
    await routes(fx.registry).handle(fakeReq({ "x-pwh": "1" }), res, query(agentKey, sessionId, p), makeIo());
    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toBe("image/png");
    expect(res.headers["X-PWH-Preview-Dims"]).toBe("320x200");
    expect(res.body().equals(bytes)).toBe(true);
  });

  it("⑦u upload happy path via a real file: 200, cls/shared/verify in the audit (U3)", async () => {
    const fx = fixture();
    const uploadsRoot = join(dir, "uploads-root");
    const content = "uploaded preview text";
    const path = join(uploadsRoot, "s-sess123/upid1/up.txt");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const base = defaultPreviewFs();
    const uploads: Pick<UploadStore, "openForPreview"> = {
      openForPreview: async (p: OpenForPreviewParams, ctx) => {
        expect(p.principal).toBe("loopback:u9");
        expect(p.listener).toBe("loopback");
        expect(p.agentKey).toBe(agentKey);
        expect(p.sessionId).toBe(sessionId);
        expect(ctx.signal.aborted).toBe(false);
        const fh = await base.open(path, 0);
        const st = await fh.stat();
        return {
          ok: true,
          fh: {
            fd: fh.fd,
            stat: async () => st,
            read: (buf: Buffer, off: number, len: number, pos: number) => fh.read(buf, off, len, pos),
            close: () => fh.close(),
          } as never,
          size: st.size,
          uploadId: "upid1",
          sha256,
          layout: "generated",
          shared: true,
        };
      },
    };
    const res = new FakeRes();
    await routes(fx.registry, { uploads }).handle(
      fakeReq({ "x-pwh": "1" }),
      res,
      query(agentKey, sessionId, path),
      makeIo({ user: "u9" }),
    );
    expect(res.status).toBe(200);
    expect(res.body().toString("utf8")).toBe(content);
    expect(previewAudits(log).at(-1)).toMatchObject({
      ok: true,
      cls: "upload",
      kind: "text",
      shared: true,
      verify: "hashed",
    });
  });

  // ---- ⑩ audit discipline ---------------------------------------------------

  it("⑩ the audit line never contains the raw path — only pathTag/ext (§4.5)", async () => {
    const fx = fixture();
    const secretRel = "deep/secret-name.txt";
    const p = fx.file(secretRel, "content");
    const res = new FakeRes();
    await routes(fx.registry).handle(fakeReq({ "x-pwh": "1" }), res, query(agentKey, sessionId, p), makeIo());
    expect(res.status).toBe(200);
    const line = previewAudits(log).at(-1)!;
    expect(line["pathTag"]).toMatch(/^[0-9a-f]{12}$/);
    expect(line["ext"]).toBe("txt");
    const dump = JSON.stringify(log.lines);
    expect(dump.includes(secretRel)).toBe(false);
    expect(dump.includes(p)).toBe(false);
    expect(dump.includes("content")).toBe(false);
  });

  // ---- abort paths ----------------------------------------------------------

  it("client disconnect mid-admission: no answer, audit E_ABORT/client-abort, fd released", async () => {
    const fx = fixture();
    const p = fx.file("slow.txt", "data");
    // slow realpath (step 5) so the abort lands mid-admission
    const base = defaultPreviewFs();
    const slowFs: PreviewFs = {
      ...base,
      realpath: async (x: string) => {
        await sleep(300);
        return base.realpath(x);
      },
    };
    const r = routes(fx.registry, {
      admitter: createFsAdmitter({
        denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
        tracker: createPreviewIoTracker(),
        log,
        now: Date.now,
        fs: slowFs,
      }),
    });
    const res = new FakeRes();
    const done = r.handle(fakeReq({ "x-pwh": "1" }), res, query(agentKey, sessionId, p), makeIo());
    await sleep(50);
    res.destroy(); // client went away before any head
    await done;
    expect(res.status).toBe(0);
    const a = previewAudits(log).at(-1)!;
    expect(a).toMatchObject({ ok: false, code: "E_ABORT", reason: "client-abort" });
  });

  it("hub-close mid-admission: 503 E_HUB_RESTARTING pre-head", async () => {
    const fx = fixture();
    const p = fx.file("slow.txt", "data");
    const base = defaultPreviewFs();
    const slowFs: PreviewFs = {
      ...base,
      realpath: async (x: string) => {
        await sleep(300);
        return base.realpath(x);
      },
    };
    const r = routes(fx.registry, {
      admitter: createFsAdmitter({
        denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
        tracker: createPreviewIoTracker(),
        log,
        now: Date.now,
        fs: slowFs,
      }),
    });
    const res = new FakeRes();
    const done = r.handle(fakeReq({ "x-pwh": "1" }), res, query(agentKey, sessionId, p), makeIo());
    await sleep(50);
    await r.dispose("close", createReqDeadline(Date.now, 1_000));
    await done;
    expect(res.status).toBe(503);
    expect(res.json()).toEqual({ error: "E_HUB_RESTARTING" });
    expect(previewAudits(log).at(-1)).toMatchObject({ code: "E_ABORT", reason: "hub-close" });
  });
});

// ---------------------------------------------------------------------------
// §3.1 ④ rate limit + in-flight caps
// ---------------------------------------------------------------------------

describe("PV3 routes — ④ rate limit and in-flight caps", () => {
  const agentKey = "a4242-nonce12";
  const sessionId = "sess123";

  function floodableRegistry(): Pick<RegistryView, "get"> {
    return makeRegistry({ agentKey, sessionId, cwd: join(dir, "cwd") });
  }

  it("21st request in a burst ⇒ 429 + Retry-After, one throttled audit line per 60s", async () => {
    const fx = floodableRegistry();
    const r = createPreviewRoutes({
      mode: "on",
      denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
      uploadsRoot: join(dir, "uploads-root"),
      registry: fx,
      log,
      now: Date.now,
    });
    const io = makeIo();
    const run = async (): Promise<FakeRes> => {
      const res = new FakeRes();
      // unknown agent ⇒ 404 — checked at ⑤, AFTER the ④ bucket, so no fs is touched
      await r.handle(fakeReq({ "x-pwh": "1" }), res, query("ghost", sessionId, "/x/y"), io);
      return res;
    };
    // sequential burst (the in-flight cap is a DIFFERENT limit — a concurrent flood would hit 503)
    const first: number[] = [];
    for (let i = 0; i < 20; i++) first.push((await run()).status);
    expect(first.every((s) => s === 404)).toBe(true);
    const rejected = await run();
    expect(rejected.status).toBe(429);
    expect(rejected.json()).toEqual({ error: "E_RATE" });
    expect(Number(rejected.headers["Retry-After"])).toBeGreaterThanOrEqual(1);

    // throttled: three more 429s, still exactly ONE E_RATE audit line
    await run();
    await run();
    const rates = previewAudits(log).filter((l) => l["code"] === "E_RATE");
    expect(rates).toHaveLength(1);
    expect(rates[0]).toMatchObject({ ok: false, code: "E_RATE", agentKey: "ghost" });

    // a DIFFERENT principal has its own bucket
    const other = new FakeRes();
    await r.handle(fakeReq({ "x-pwh": "1" }), other, query("ghost", sessionId, "/x/y"), makeIo({ user: "u2" }));
    expect(other.status).toBe(404);
  });

  it("the bucket refills (+1 / 250ms)", async () => {
    let t = 1_000_000;
    const now = (): number => t;
    const fx = floodableRegistry();
    const r = createPreviewRoutes({
      mode: "on",
      denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
      uploadsRoot: join(dir, "uploads-root"),
      registry: fx,
      log,
      now,
    });
    const io = makeIo();
    const run = async (): Promise<number> => {
      const res = new FakeRes();
      await r.handle(fakeReq({ "x-pwh": "1" }), res, query("ghost", sessionId, "/x/y"), io);
      return res.status;
    };
    for (let i = 0; i < 20; i++) await expect(run()).resolves.toBe(404);
    await expect(run()).resolves.toBe(429);
    t += 260;
    await expect(run()).resolves.toBe(404); // one token refilled
  });

  it("in-flight: 3rd concurrent request of a principal ⇒ 503 E_BUSY; a different principal still admits", async () => {
    const fx = floodableRegistry();
    const release = deferred();
    const uploads: Pick<UploadStore, "openForPreview"> = {
      openForPreview: (_p, ctx) =>
        new Promise((resolve) => {
          const onAbort = (): void => resolve({ ok: false, code: "E_DEADLINE" });
          if (ctx.signal.aborted) return onAbort();
          ctx.signal.addEventListener("abort", onAbort, { once: true });
          release.promise.then(() => resolve({ ok: false, code: "E_NOT_FOUND" }));
        }),
    };
    const r = createPreviewRoutes({
      mode: "on",
      denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
      uploadsRoot: join(dir, "uploads-root"),
      registry: fx,
      log,
      now: Date.now,
      uploads,
    });
    const io = makeIo();
    const start = (): FakeRes => {
      const res = new FakeRes();
      void r.handle(
        fakeReq({ "x-pwh": "1" }),
        res,
        query(agentKey, sessionId, `${join(dir, "uploads-root")}/s/x/f`),
        io,
      );
      return res;
    };
    const a = start();
    const b = start();
    await sleep(30);
    expect(a.status).toBe(0); // both still parked in ⑦u
    expect(b.status).toBe(0);
    const third = await start();
    expect(third.status).toBe(503);
    expect(third.json()).toEqual({ error: "E_BUSY" });
    expect(third.headers["Retry-After"]).toBe("1");
    // a second principal is under its own in-flight cap — fire without awaiting (it parks too)
    const other = new FakeRes();
    void r.handle(
      fakeReq({ "x-pwh": "1" }),
      other,
      query(agentKey, sessionId, `${join(dir, "uploads-root")}/s/x/f`),
      makeIo({ user: "someone-else" }),
    );
    await sleep(30);
    expect(other.status).toBe(0);
    release.resolve();
    await sleep(30);
  });

  it("in-flight global cap: 8 across principals, the 9th ⇒ 503", async () => {
    const fx = floodableRegistry();
    const release = deferred();
    const uploads: Pick<UploadStore, "openForPreview"> = {
      openForPreview: (_p, ctx) =>
        new Promise((resolve) => {
          const onAbort = (): void => resolve({ ok: false, code: "E_DEADLINE" });
          if (ctx.signal.aborted) return onAbort();
          ctx.signal.addEventListener("abort", onAbort, { once: true });
          release.promise.then(() => resolve({ ok: false, code: "E_NOT_FOUND" }));
        }),
    };
    const r = createPreviewRoutes({
      mode: "on",
      denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
      uploadsRoot: join(dir, "uploads-root"),
      registry: fx,
      log,
      now: Date.now,
      uploads,
    });
    const users = Array.from({ length: 8 }, (_, i) => `u${i}`);
    const ios = users.map((user) => makeIo({ user }));
    const parked: Promise<void>[] = [];
    for (let i = 0; i < 8; i++) {
      parked.push(
        r.handle(
          fakeReq({ "x-pwh": "1" }),
          new FakeRes(),
          query(agentKey, sessionId, `${join(dir, "uploads-root")}/s/x/f`),
          ios[i]!,
        ),
      );
    }
    await sleep(20);
    const ninth = new FakeRes();
    await r.handle(
      fakeReq({ "x-pwh": "1" }),
      ninth,
      query(agentKey, sessionId, `${join(dir, "uploads-root")}/s/x/f`),
      makeIo({ user: "u9" }),
    );
    expect(ninth.status).toBe(503);
    expect(previewAudits(log).at(-1)).toMatchObject({ code: "E_BUSY", reason: "inflight" });
    release.resolve();
    await Promise.all(parked);
  });

  it("4097 principals flood the private limiter (eviction path) without breaking later admits", async () => {
    const fx = floodableRegistry();
    const r = createPreviewRoutes({
      mode: "on",
      denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
      uploadsRoot: join(dir, "uploads-root"),
      registry: fx,
      log,
      now: Date.now,
    });
    for (let i = 0; i < 4097; i++) {
      const res = new FakeRes();
      await r.handle(fakeReq({ "x-pwh": "1" }), res, query("ghost", sessionId, "/x/y"), makeIo({ user: `flood-${i}` }));
      expect(res.status).toBe(404); // every fresh principal's bucket admits
    }
    const after = new FakeRes();
    await r.handle(fakeReq({ "x-pwh": "1" }), after, query("ghost", sessionId, "/x/y"), makeIo({ user: "post-flood" }));
    expect(after.status).toBe(404);
  });

  it("two routes instances never share a limiter (§7-D14 default is a private CmdLimit)", async () => {
    const fx = floodableRegistry();
    const mk = (): PreviewRoutes =>
      createPreviewRoutes({
        mode: "on",
        denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
        uploadsRoot: join(dir, "uploads-root"),
        registry: fx,
        log,
        now: Date.now,
      });
    const a = mk();
    const b = mk();
    const io = makeIo();
    const run = async (r: PreviewRoutes): Promise<number> => {
      const res = new FakeRes();
      await r.handle(fakeReq({ "x-pwh": "1" }), res, query("ghost", sessionId, "/x/y"), io);
      return res.status;
    };
    for (let i = 0; i < 20; i++) await run(a);
    await expect(run(a)).resolves.toBe(429);
    await expect(run(b)).resolves.toBe(404); // b's bucket untouched
  });
});

// ---------------------------------------------------------------------------
// HP6 fd leak + HP7 lifecycle
// ---------------------------------------------------------------------------

describe("PV3 routes — HP6 fd leak / HP7 lifecycle", () => {
  const agentKey = "a4242-nonce12";
  const sessionId = "sess123";

  function fdCount(): number | undefined {
    try {
      return readdirSync("/proc/self/fd").length;
    } catch {
      return undefined;
    }
  }

  it("HP6: N served requests leave no open fd behind", async () => {
    const skip = fdCount();
    if (skip === undefined) return; // non-Linux: R3 residual, no /proc
    const cwd = join(dir, "cwd");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "f.txt"), "x".repeat(4096));
    const registry = makeRegistry({ agentKey, sessionId, cwd });
    const r = createPreviewRoutes({
      mode: "on",
      denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
      uploadsRoot: join(dir, "uploads-root"),
      registry,
      log,
      now: Date.now,
    });
    const io = makeIo();
    for (let i = 0; i < 30; i++) {
      // rotate principals: 30 sequential reads of one principal would trip the ④ rate bucket
      const res = new FakeRes();
      await r.handle(
        fakeReq({ "x-pwh": "1" }),
        res,
        query(agentKey, sessionId, join(cwd, "f.txt")),
        makeIo({ user: `u${i}` }),
      );
      expect(res.status).toBe(200);
    }
    const after = fdCount();
    expect(after).toBeDefined();
    expect(after! - skip).toBeLessThanOrEqual(1);
  });

  it("HP7 runtime close: dispose aborts an in-flight request within ≤1s and settles", async () => {
    const cwd = join(dir, "cwd");
    mkdirSync(cwd, { recursive: true });
    const registry = makeRegistry({ agentKey, sessionId, cwd });
    const release = deferred();
    const uploads: Pick<UploadStore, "openForPreview"> = {
      openForPreview: (_p, ctx) =>
        new Promise((resolve) => {
          const onAbort = (): void => resolve({ ok: false, code: "E_DEADLINE" });
          if (ctx.signal.aborted) return onAbort();
          ctx.signal.addEventListener("abort", onAbort, { once: true });
          release.promise.then(() => resolve({ ok: false, code: "E_NOT_FOUND" }));
        }),
    };
    const r = createPreviewRoutes({
      mode: "on",
      denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
      uploadsRoot: join(dir, "uploads-root"),
      registry,
      log,
      now: Date.now,
      uploads,
    });
    const res = new FakeRes();
    const done = r.handle(
      fakeReq({ "x-pwh": "1" }),
      res,
      query(agentKey, sessionId, `${join(dir, "uploads-root")}/s/x/f`),
      makeIo(),
    );
    await sleep(30);
    const t0 = Date.now();
    await r.dispose("close", createReqDeadline(Date.now, 5_000));
    expect(Date.now() - t0).toBeLessThan(1_200);
    await done;
    expect(res.status).toBe(503);
    expect(previewAudits(log).at(-1)).toMatchObject({ code: "E_ABORT", reason: "hub-close" });
  });

  it("HP7 startup-failure reason reaches the same teardown (idempotence across reasons)", async () => {
    const cwd = join(dir, "cwd");
    mkdirSync(cwd, { recursive: true });
    const registry = makeRegistry({ agentKey, sessionId, cwd });
    const r = createPreviewRoutes({
      mode: "on",
      denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
      uploadsRoot: join(dir, "uploads-root"),
      registry,
      log,
      now: Date.now,
    });
    await r.dispose("startup-failure", createReqDeadline(Date.now, 1_000));
    const res = new FakeRes();
    await r.handle(fakeReq({ "x-pwh": "1" }), res, query(agentKey, sessionId, "/x/y"), makeIo());
    expect(res.status).toBe(503);
  });

  it("P1 regression: open settles OK after dispose aborted the request ⇒ the fd is reclaimed", async () => {
    // The exact §4.5.1 window the reviewer flagged: `openForPreview` resolves ok in the
    // microtask gap AFTER `dispose()` already aborted the request's controller. The store only
    // late-closes an open that lost ITS OWN race — once the promise resolved ok, ownership is
    // the route layer's, so the ⑩ finally must close `u.fh` (old code dropped it unregistered).
    const cwd = join(dir, "cwd");
    mkdirSync(cwd, { recursive: true });
    const registry = makeRegistry({ agentKey, sessionId, cwd });
    const realFile = join(dir, "payload.txt");
    writeFileSync(realFile, "payload");
    const base = defaultPreviewFs();

    let resolveOpen!: (v: OpenForPreviewResult) => void;
    let closeCount = 0;
    const uploads: Pick<UploadStore, "openForPreview"> = {
      // NOT raced against ctx.signal on purpose: models the open that already completed on the
      // fs side before the abort landed, so the promise settles ok regardless.
      openForPreview: () =>
        new Promise<OpenForPreviewResult>((resolve) => {
          resolveOpen = resolve;
        }),
    };
    const r = createPreviewRoutes({
      mode: "on",
      denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
      uploadsRoot: join(dir, "uploads-root"),
      registry,
      log,
      now: Date.now,
      uploads,
    });
    const res = new FakeRes();
    const done = r.handle(
      fakeReq({ "x-pwh": "1" }),
      res,
      query(agentKey, sessionId, `${join(dir, "uploads-root")}/s/x/f`),
      makeIo(),
    );
    await sleep(30); // parked inside ⑦u

    const fh = await base.open(realFile, 0);
    const st = await fh.stat();
    const countingHandle = {
      fd: fh.fd,
      stat: async () => st,
      read: (buf: Buffer, off: number, len: number, pos: number) => fh.read(buf, off, len, pos),
      close: (): Promise<void> => {
        closeCount += 1;
        return fh.close();
      },
    };

    // dispose FIRST (aborts the controller synchronously), THEN let the open settle ok
    const disposeP = r.dispose("close", createReqDeadline(Date.now, 50));
    resolveOpen({
      ok: true,
      fh: countingHandle as never,
      size: st.size,
      uploadId: "p1reg",
      sha256: createHash("sha256").update("payload").digest("hex"),
      layout: "generated",
      shared: false,
    });
    await done;
    await disposeP;

    expect(res.status).toBe(503); // hub-close answered pre-head
    expect(previewAudits(log).at(-1)).toMatchObject({ ok: false, code: "E_ABORT", reason: "hub-close" });
    expect(closeCount).toBe(1); // the fd was reclaimed — no leak
  });
});

// ---------------------------------------------------------------------------
// §4.5.3 text-verify single-flight through the routes (audit: 1 hashed + 2 joined)
// ---------------------------------------------------------------------------

describe("PV3 routes — text-verify single-flight (real store, slowed task open)", () => {
  const agentKey = "a4242-nonce12";
  const sessionId = "sess123";
  const principal = "loopback:token";

  /** Real UploadStore-style record laid down by hand (PV2b's `craft` pattern). */
  function craftUpload(root: string, content: string): { path: string; sha256: string } {
    const bucket = `s-${sessionId}`;
    const id = "upid" + String(Math.floor(Math.random() * 1e9)).padStart(9, "0") + "aa11";
    const dir = join(root, bucket, id);
    mkdirSync(dir, { recursive: true });
    const bytes = Buffer.from(content, "utf8");
    writeFileSync(join(dir, `${id}.txt`), bytes);
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        v: 1,
        id,
        principal,
        agentKey,
        bucket,
        safeName: "note.txt",
        diskName: `${id}.txt`,
        size: bytes.length,
        mime: null,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        committedAt: Date.now(),
        referencedAt: null,
      }),
    );
    return {
      path: join(dir, `${id}.txt`),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  it("3 concurrent readers of one 100 MiB text upload: 1 hashed + 2 joined in the audit", async () => {
    const uploadsRoot = join(dir, "uploads");
    // §6 PV3 acceptance verbatim: THREE concurrent readers of one 100 MiB text. Memory stays
    // bounded (HP3): the task streams 64 KiB chunks, the served body is the 256 KiB display cap.
    const crafted = craftUpload(uploadsRoot, "t".repeat(100 * 1024 * 1024)); // 100 MiB text
    const cwd = join(dir, "cwd");
    mkdirSync(cwd, { recursive: true });
    const registry = makeRegistry({ agentKey, sessionId, cwd });

    // slow the SINGLE-FLIGHT TASK's own fd open (500ms) so requests 2/3 reliably join
    const base = defaultPreviewFs();
    const slowFs: PreviewFs = {
      ...base,
      open: (p: string, flags: number) =>
        p.startsWith("/proc/self/fd/") ? sleep(500).then(() => base.open(p, flags)) : base.open(p, flags),
    };
    const verifier = createUploadVerifier({ log, now: Date.now, fs: slowFs });

    const uploads: Pick<UploadStore, "openForPreview"> = {
      openForPreview: async (p, ctx) => {
        expect(p.path).toBe(crafted.path);
        const fh = await base.open(crafted.path, 0);
        const st = await fh.stat();
        const handle = {
          fd: fh.fd,
          stat: async () => ({ ...st, ctimeMs: st.ctimeMs, nlink: 1, isFile: () => true }),
          read: (buf: Buffer, off: number, len: number, pos: number) => fh.read(buf, off, len, pos),
          close: () => fh.close(),
        };
        void ctx;
        return {
          ok: true,
          fh: handle as never,
          size: st.size,
          uploadId: "u1",
          sha256: crafted.sha256,
          layout: "generated",
          shared: false,
        };
      },
    };

    const r = createPreviewRoutes({
      mode: "on",
      denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
      uploadsRoot,
      registry,
      log,
      now: Date.now,
      uploads,
      verifier,
    });
    const start = (user: string): Promise<FakeRes> => {
      const res = new FakeRes();
      return r
        .handle(fakeReq({ "x-pwh": "1" }), res, query(agentKey, sessionId, crafted.path), makeIo({ user }))
        .then(() => res);
    };
    // three DISTINCT principals (the §3.1 ④ per-principal in-flight cap is 2 — the acceptance's
    // concurrent readers are e.g. the uploader + session peers, U3)
    const [r1, r2, r3] = await Promise.all([
      start("u1"),
      sleep(60).then(() => start("u2")),
      sleep(120).then(() => start("u3")),
    ]);
    for (const x of [r1, r2, r3]) expect(x.status).toBe(200);
    const tags = previewAudits(log)
      .filter((l) => l["ok"] === true && l["cls"] === "upload")
      .map((l) => l["verify"])
      .sort();
    expect(tags).toEqual(["hashed", "joined", "joined"]);
  });

  it("one waiter leaving mid-verify does not hurt the others (§4.5.3 引用计数)", async () => {
    const uploadsRoot = join(dir, "uploads");
    const crafted = craftUpload(uploadsRoot, "v".repeat(512 * 1024));
    const cwd = join(dir, "cwd");
    mkdirSync(cwd, { recursive: true });
    const registry = makeRegistry({ agentKey, sessionId, cwd });
    const base = defaultPreviewFs();
    const slowFs: PreviewFs = {
      ...base,
      open: (p: string, flags: number) =>
        p.startsWith("/proc/self/fd/") ? sleep(700).then(() => base.open(p, flags)) : base.open(p, flags),
    };
    const verifier = createUploadVerifier({ log, now: Date.now, fs: slowFs });
    const uploads: Pick<UploadStore, "openForPreview"> = {
      openForPreview: async () => {
        const fh = await base.open(crafted.path, 0);
        const st = await fh.stat();
        return {
          ok: true,
          fh: {
            fd: fh.fd,
            stat: async () => st,
            read: (buf: Buffer, off: number, len: number, pos: number) => fh.read(buf, off, len, pos),
            close: () => fh.close(),
          } as never,
          size: st.size,
          uploadId: "u2",
          sha256: crafted.sha256,
          layout: "generated",
          shared: false,
        };
      },
    };
    const r = createPreviewRoutes({
      mode: "on",
      denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
      uploadsRoot,
      registry,
      log,
      now: Date.now,
      uploads,
      verifier,
    });
    const start = (user: string): { res: FakeRes; done: Promise<void> } => {
      const res = new FakeRes();
      const done = r.handle(fakeReq({ "x-pwh": "1" }), res, query(agentKey, sessionId, crafted.path), makeIo({ user }));
      return { res, done };
    };
    const w1 = start("u1");
    await sleep(60);
    const w2 = start("u2");
    const w3 = start("u3");
    await sleep(60);
    // u2 disconnects while all three are joined on the in-flight task
    w2.res.destroy();
    await Promise.all([w1.done, w2.done, w3.done]);
    expect(w1.res.status).toBe(200);
    expect(w3.res.status).toBe(200); // the survivors still complete
    expect(w2.res.status).toBe(0); // the leaver was never answered
    const lines = previewAudits(log).filter((l) => l["cls"] === "upload");
    expect(lines.find((l) => l["user"] === "u2")).toMatchObject({ ok: false, code: "E_ABORT" });
    expect(lines.find((l) => l["user"] === "u1")).toMatchObject({ ok: true });
    expect(lines.find((l) => l["user"] === "u3")).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// dir-plan v3.1 P1a: global admission (U4) — cwd-OUTSIDE paths, audit cls:"abs", busy 503
// ---------------------------------------------------------------------------

describe("P1a routes — global admission (U4)", () => {
  const agentKey = "a4242-nonce12";
  const sessionId = "sess123";

  function fixture(): { cwd: string; registry: ReturnType<typeof makeRegistry> } {
    const cwd = join(dir, "cwd");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "inside.txt"), "inside\n");
    return { cwd, registry: makeRegistry({ agentKey, sessionId, cwd }) };
  }

  function routes(registry: Pick<RegistryView, "get">, over: { admitter?: FsAdmitter } = {}): PreviewRoutes {
    return createPreviewRoutes({
      mode: "on",
      denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
      uploadsRoot: join(dir, "uploads-root"),
      registry,
      log,
      now: Date.now,
      ...(over.admitter === undefined ? {} : { admitter: over.admitter }),
    });
  }

  it("U4: a cwd-OUTSIDE file serves 200 (was 403 outside pre-dir-plan)", async () => {
    const fx = fixture();
    const outside = join(dir, "elsewhere", "out.txt");
    mkdirSync(join(dir, "elsewhere"), { recursive: true });
    writeFileSync(outside, "outside content\n");
    const r = routes(fx.registry);
    const res = new FakeRes();
    await r.handle(fakeReq({ "x-pwh": "1" }), res, query(agentKey, sessionId, outside), makeIo());
    expect(res.status).toBe(200);
    expect(res.body().toString("utf8")).toContain("outside content");
    const audits = previewAudits(log).filter((l) => l.phase === "request" && l.ok === true);
    expect(audits.at(-1)).toMatchObject({ cls: "abs", kind: "text" });
    // audit discipline: the raw path never reaches the log
    expect(JSON.stringify(audits.at(-1))).not.toContain("elsewhere");
    expect(JSON.stringify(audits.at(-1))).not.toContain("out.txt");
  });

  it("cls audit classes: inside-cwd ⇒ cwd, uploads-root literal ⇒ upload, outside ⇒ abs", async () => {
    const fx = fixture();
    const r = routes(fx.registry);
    const res = new FakeRes();
    await r.handle(fakeReq({ "x-pwh": "1" }), res, query(agentKey, sessionId, join(fx.cwd, "inside.txt")), makeIo());
    expect(res.status).toBe(200);
    expect(previewAudits(log).at(-1)).toMatchObject({ ok: true, cls: "cwd" });

    // a denylisted outside path still audits cls:"abs" + the mapped code, no path
    const denied = new FakeRes();
    await r.handle(
      fakeReq({ "x-pwh": "1" }),
      denied,
      query(agentKey, sessionId, join(dir, "elsewhere", "id_rsa")),
      makeIo(),
    );
    expect(denied.status).toBe(403);
    expect(denied.json()).toEqual({ error: "E_PREVIEW_DENIED", reason: "denylist" });
    const last = previewAudits(log).at(-1);
    expect(last).toMatchObject({ ok: false, cls: "abs", code: "E_PREVIEW_DENIED", reason: "denylist" });
    expect(JSON.stringify(last)).not.toContain("id_rsa");
  });

  it("§2.4 busy: a tripped tracker maps through the admitter to 503 E_BUSY", async () => {
    const fx = fixture();
    // pre-trip a SHARED tracker with two raced-out realpath hangs (§2.4 max = 2)
    const tracker = createPreviewIoTracker();
    const hangFs = { ...defaultPreviewFs(), realpath: (): Promise<string> => new Promise<string>(() => undefined) };
    const tripped = createFsAdmitter({
      denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
      tracker,
      log,
      now: Date.now,
      fs: hangFs,
      stepCapMs: 40,
    });
    await expect(
      tripped.admit({ path: "/etc/hostname" }, createReqDeadline(Date.now, 8000), neverAbort2()),
    ).resolves.toMatchObject({ ok: false, status: 504 });
    await expect(
      tripped.admit({ path: "/etc/hostname" }, createReqDeadline(Date.now, 8000), neverAbort2()),
    ).resolves.toMatchObject({ ok: false, status: 504 });
    expect(tracker.zombies).toBe(2);

    // an injected admitter carrying that same tripped tracker ⇒ every fs-class request 503s
    const admitter = createFsAdmitter({
      denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
      tracker,
      log,
      now: Date.now,
    });
    const r = routes(fx.registry, { admitter });
    const res = new FakeRes();
    await r.handle(fakeReq({ "x-pwh": "1" }), res, query(agentKey, sessionId, join(fx.cwd, "inside.txt")), makeIo());
    expect(res.status).toBe(503);
    expect(res.json()).toEqual({ error: "E_BUSY" });
    expect(previewAudits(log).at(-1)).toMatchObject({ ok: false, code: "E_BUSY" });
  });
});

function neverAbort2(): AbortSignal {
  return new AbortController().signal;
}
