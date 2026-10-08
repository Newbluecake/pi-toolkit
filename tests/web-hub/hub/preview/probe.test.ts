/**
 * web-hub content-preview — the batch existence probe (2026-10-07 修订「先探测后标记」).
 *
 * Direct `PreviewRoutes.handleProbe()` calls over a fake req/res pair (the loopback HTTP
 * dispatch matrix lives in `tests/web-hub/http/api-preview-probe.test.ts`). The cwd
 * admitter runs REAL (real tmpdir + real fs) exactly like `routes.test.ts` — the point of
 * this suite is that every entry walks the SAME admission chain a real preview walks
 * (shared `open.ts` pipeline), so: exists+text ⇒ `text`, exists+image ⇒ `image`, and every
 * failure class (missing, outside-root, denylist, virtual-fs, upload-store refusal, malformed
 * entry) ⇒ `missing` — never a per-entry 4xx. Request-level rejects (CSRF / auth / agent /
 * session / caps) mirror preview's ⓪–④ answers byte-for-byte.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPreviewRoutes } from "../../../../src/web-hub/hub/preview/routes.js";
import { createFsAdmitter, denyCtxOf } from "../../../../src/web-hub/hub/preview/admit.js";
import type { FsAdmitter, PreviewFs } from "../../../../src/web-hub/hub/preview/admit.js";
import { createPreviewIoTracker, defaultPreviewFs } from "../../../../src/web-hub/hub/preview/fs.js";
import { createReqDeadline } from "../../../../src/web-hub/hub/req-deadline.js";
import type { PreviewRouteIo, PreviewRoutes, RegistryView } from "../../../../src/web-hub/hub/ports.js";
import type { OpenForPreviewResult, UploadStore } from "../../../../src/web-hub/hub/uploads.js";
import { PREVIEW_PROBE_MAX_PATHS } from "../../../../src/web-hub/protocol/preview.js";
import { parseProbeBody } from "../../../../src/web-hub/hub/preview/probe.js";
import { FakeHandle } from "./helpers.js";
import { memLog, type MemLog } from "../helpers.js";
import { hookedFs } from "./helpers.js";

// ---------------------------------------------------------------------------
// fakes (same shapes as routes.test.ts; a req that can deliver a JSON body)
// ---------------------------------------------------------------------------

class FakeReq extends EventEmitter {
  readonly headers: Record<string, string>;
  private readonly body: string | undefined;
  private delivered = false;

  constructor(headers: Record<string, string>, body?: string) {
    super();
    this.headers = { ...headers, ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }) };
    this.body = body;
  }

  /** Deliver after the handler attached its listeners (authorize resolves in a microtask). */
  deliver(): void {
    setImmediate(() => {
      if (this.delivered) return;
      this.delivered = true;
      if (this.body !== undefined && this.body.length > 0) this.emit("data", Buffer.from(this.body));
      this.emit("end");
    });
  }
}

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

  end(chunk?: Buffer): void {
    if (chunk !== undefined) this.chunks.push(chunk);
    this.finished = true;
    this.emit("close");
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }

  json<T = unknown>(): T {
    return JSON.parse(Buffer.concat(this.chunks).toString("utf8")) as T;
  }
}

function makeIo(opts: { user?: string | null } = {}): PreviewRouteIo {
  return {
    listener: "loopback",
    ip: "127.0.0.1",
    expectedOrigin: "http://127.0.0.1:1",
    authorize: async () => {
      if (opts.user === null) return { handled: true, code: "E_AUTH" };
      return { ip: "127.0.0.1", ...(opts.user === undefined ? {} : { user: opts.user }) };
    },
    sendJson: (res, status, body, headers) => {
      const r = res as unknown as FakeRes;
      if (r.headersSent || r.destroyed) return;
      r.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...(headers ?? {}) });
      r.end(Buffer.from(JSON.stringify(body), "utf8"));
    },
  };
}

function makeRegistry(s: { agentKey: string; sessionId: string; cwd: string }): Pick<RegistryView, "get"> {
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
            session: { sessionId: s.sessionId, cwd: s.cwd, reason: "test", leafId: null, mode: "tui" as const },
          } as unknown as ReturnType<RegistryView["get"]>)
        : undefined,
  };
}

function pngBytes(w: number, h: number): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "ascii");
  head.writeUInt32BE(w, 16);
  head.writeUInt32BE(h, 20);
  return head;
}

const probeQuery = (agentKey: string, sessionId: string): URLSearchParams =>
  new URLSearchParams({ agentKey, sessionId });

const probeAudits = (log: MemLog): Array<Record<string, unknown>> =>
  log.lines.filter((l) => l.msg === "preview").map((l) => (l.data as Record<string, unknown>) ?? {});

// ---------------------------------------------------------------------------

let dir: string;
let log: MemLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wh-pv-probe-"));
  log = memLog();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const agentKey = "a4242-nonce12";
const sessionId = "sess123";

function fixture(): {
  cwd: string;
  uploadsRoot: string;
  file(rel: string, content: string | Buffer): string;
  registry: Pick<RegistryView, "get">;
} {
  const cwd = join(dir, "cwd");
  mkdirSync(cwd, { recursive: true });
  return {
    cwd,
    uploadsRoot: join(dir, "uploads-root"),
    file(rel, content) {
      const p = join(cwd, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content);
      return p;
    },
    registry: makeRegistry({ agentKey, sessionId, cwd }),
  };
}

function routes(
  fx: ReturnType<typeof fixture>,
  over: {
    uploads?: Pick<UploadStore, "openForPreview">;
    admitter?: FsAdmitter;
  } = {},
): PreviewRoutes {
  return createPreviewRoutes({
    mode: "on",
    denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
    uploadsRoot: fx.uploadsRoot,
    registry: fx.registry,
    log,
    now: Date.now,
    ...(over.uploads === undefined ? {} : { uploads: over.uploads }),
    ...(over.admitter === undefined ? {} : { admitter: over.admitter }),
  });
}

async function probe(
  r: PreviewRoutes,
  body: unknown,
  opts: { headers?: Record<string, string>; io?: PreviewRouteIo } = {},
): Promise<FakeRes> {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = new FakeReq({ "x-pwh": "1", ...(opts.headers ?? {}) }, raw);
  const res = new FakeRes();
  const p = r.handleProbe(req as unknown as IncomingMessage, res, probeQuery(agentKey, sessionId), opts.io ?? makeIo());
  req.deliver();
  await p;
  return res;
}

// ---------------------------------------------------------------------------
// the per-entry contract (SHARED admission chain — open.ts)
// ---------------------------------------------------------------------------

describe("POST /api/preview/probe — per-entry kinds (2026-10-07 修订)", () => {
  it("exists text ⇒ text; exists image ⇒ image; absent ⇒ missing — order preserved", async () => {
    const fx = fixture();
    const text = fx.file("a.ts", "hello probe\n");
    const png = fx.file("img.png", pngBytes(4, 5));
    const gone = join(fx.cwd, "gone.ts");
    const r = routes(fx);
    const res = await probe(r, { paths: [text, png, gone] });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({
      results: [{ kind: "text" }, { kind: "image" }, { kind: "missing" }],
    });
  });

  it("empty file ⇒ text; binary ⇒ missing (a preview click could not have succeeded)", async () => {
    const fx = fixture();
    const empty = fx.file("empty.txt", "");
    const bin = fx.file("blob.bin", Buffer.from([0, 1, 2, 0, 3, 4, 0, 5]));
    const res = await probe(routes(fx), { paths: [empty, bin] });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ results: [{ kind: "text" }, { kind: "missing" }] });
  });

  it("U4: a cwd-OUTSIDE file probes its REAL kind now (was missing pre-dir-plan); denylist / virtual-fs stay missing", async () => {
    const fx = fixture();
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "no\n"); // U4: outside-cwd no longer folds to missing — real answer
    const secret = join(fx.cwd, ".ssh", "id_rsa");
    mkdirSync(join(fx.cwd, ".ssh"), { recursive: true });
    writeFileSync(secret, "k");
    const res = await probe(routes(fx), {
      paths: [outside, secret, "/proc/self/status"],
    });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({
      results: [{ kind: "text" }, { kind: "missing" }, { kind: "missing" }],
    });
  });

  it("a malformed entry (invalid path shape) answers missing for ITSELF, not a 400 for the batch", async () => {
    const fx = fixture();
    const good = fx.file("ok.md", "# ok\n");
    const res = await probe(routes(fx), { paths: ["relative/no-slash-root.ts", good] });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ results: [{ kind: "missing" }, { kind: "text" }] });
  });

  it("upload-class entries run the store chain: ok ⇒ sniffed kind; store refusal ⇒ missing", async () => {
    const fx = fixture();
    const up = join(fx.uploadsRoot, "u1", "file.txt");
    const denied = join(fx.uploadsRoot, "u9", "gone.txt");
    const calls: string[] = [];
    const uploads: Pick<UploadStore, "openForPreview"> = {
      openForPreview: async (p): Promise<OpenForPreviewResult> => {
        calls.push(p.path);
        if (p.path === up) {
          return {
            ok: true,
            fh: {
              fd: 7,
              read: async (buf, off, len, pos) => ({
                bytesRead: Buffer.from("upload body").copy(buf, off, pos, pos + len),
              }),
              stat: async () => ({ dev: 1, ino: 2, size: 11, isFile: () => true }),
              close: async () => {},
            } as never,
            size: 11,
            uploadId: "u1",
            sha256: "0".repeat(64),
            layout: "generated",
            shared: false,
          };
        }
        return { ok: false, code: "E_NOT_FOUND" };
      },
    };
    const res = await probe(routes(fx, { uploads }), { paths: [up, denied] });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ results: [{ kind: "text" }, { kind: "missing" }] });
    expect(calls).toEqual([up, denied]);
  });

  it("upload-class with NO store wired ⇒ missing (mirrors preview's 404)", async () => {
    const fx = fixture();
    const res = await probe(routes(fx), { paths: [join(fx.uploadsRoot, "x", "y.png")] });
    expect(res.json()).toEqual({ results: [{ kind: "missing" }] });
  });
});

// ---------------------------------------------------------------------------
// request-level rejects (⓪–④: answers byte-align with GET /api/preview)
// ---------------------------------------------------------------------------

describe("POST /api/preview/probe — request-level answers", () => {
  it("closing ⇒ 503 E_HUB_RESTARTING", async () => {
    const fx = fixture();
    const r = routes(fx);
    await r.dispose("close", createReqDeadline(Date.now, 1_000));
    const res = await probe(r, { paths: [] });
    expect(res.status).toBe(503);
    expect(res.json()).toEqual({ error: "E_HUB_RESTARTING" });
  });

  it("no X-PWH ⇒ 403 E_CSRF (CSRF precedes auth — an unauthenticated probe learns nothing)", async () => {
    const fx = fixture();
    const res = await probe(routes(fx), { paths: [] }, { headers: { "x-pwh": "" } });
    expect(res.status).toBe(403);
    expect(res.json()).toEqual({ error: "E_CSRF" });
  });

  it("auth failure ⇒ 401-shaped handled answer (authorize already answered; acc mirrors E_AUTH)", async () => {
    const fx = fixture();
    const res = await probe(routes(fx), { paths: [] }, { io: makeIo({ user: null }) });
    expect(res.status).toBe(0); // authorize() in the fake answers nothing — hub-level 401 covered by http tests
    expect(probeAudits(log).some((l) => l.code === "E_AUTH")).toBe(true);
  });

  it("bad agentKey/sessionId params ⇒ 400 E_BAD_REQUEST", async () => {
    const fx = fixture();
    const req = new FakeReq({ "x-pwh": "1" }, JSON.stringify({ paths: [] }));
    const res = new FakeRes();
    const p = routes(fx).handleProbe(
      req as unknown as IncomingMessage,
      res,
      new URLSearchParams({ agentKey: "bad key!", sessionId }),
      makeIo(),
    );
    req.deliver();
    await p;
    expect(res.status).toBe(400);
    expect(res.json()).toEqual({ error: "E_BAD_REQUEST" });
  });

  it("unknown agent ⇒ 404 E_NOT_FOUND; session mismatch ⇒ 409 E_SESSION_CHANGED", async () => {
    const fx = fixture();
    const r = routes(fx);
    const req1 = new FakeReq({ "x-pwh": "1" }, JSON.stringify({ paths: [] }));
    const res1 = new FakeRes();
    const p1 = r.handleProbe(
      req1 as unknown as IncomingMessage,
      res1,
      new URLSearchParams({ agentKey: "nope", sessionId }),
      makeIo(),
    );
    req1.deliver();
    await p1;
    expect(res1.status).toBe(404);
    expect(res1.json()).toEqual({ error: "E_NOT_FOUND" });

    const req2 = new FakeReq({ "x-pwh": "1" }, JSON.stringify({ paths: [] }));
    const res2 = new FakeRes();
    const p2 = r.handleProbe(
      req2 as unknown as IncomingMessage,
      res2,
      new URLSearchParams({ agentKey, sessionId: "other" }),
      makeIo(),
    );
    req2.deliver();
    await p2;
    expect(res2.status).toBe(409);
    expect(res2.json()).toEqual({ error: "E_SESSION_CHANGED" });
  });

  it("paths over PREVIEW_PROBE_MAX_PATHS ⇒ 400 E_BAD_REQUEST reason too-many", async () => {
    const fx = fixture();
    const res = await probe(routes(fx), {
      paths: Array.from({ length: PREVIEW_PROBE_MAX_PATHS + 1 }, (_, i) => `/p/f${i}.ts`),
    });
    expect(res.status).toBe(400);
    expect(res.json()).toEqual({ error: "E_BAD_REQUEST", reason: "too-many" });
  });

  it("body over 8 KiB ⇒ 413 E_BAD_REQUEST reason body (declared content-length precheck)", async () => {
    const fx = fixture();
    const res = await probe(routes(fx), {
      paths: Array.from({ length: 40 }, (_, i) => `/p/${String(i).padStart(6, "0")}-${"x".repeat(200)}.ts`),
    });
    expect(res.status).toBe(413);
    expect(res.json()).toEqual({ error: "E_BAD_REQUEST", reason: "body" });
  });

  it("invalid JSON ⇒ 400 reason json; non-array paths ⇒ 400 reason shape; empty body ⇒ 400 shape", async () => {
    const fx = fixture();
    const r = routes(fx);
    expect(await probe(r, "{nope")).toMatchObject({ status: 400 });
    expect((await probe(r, { paths: "x" })).json()).toEqual({ error: "E_BAD_REQUEST", reason: "shape" });
    expect((await probe(r, { nope: 1 })).json()).toEqual({ error: "E_BAD_REQUEST", reason: "shape" });
    const res = await probe(r, "");
    expect(res.json()).toEqual({ error: "E_BAD_REQUEST", reason: "shape" });
    expect(probeAudits(log).filter((l) => l.phase === "probe" && l.code === "E_BAD_REQUEST").length).toBe(4);
  });

  it("an EMPTY paths array is a legal no-op probe (200, [])", async () => {
    const fx = fixture();
    const res = await probe(routes(fx), { paths: [] });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ results: [] });
  });
});

// ---------------------------------------------------------------------------
// lifecycle + audit
// ---------------------------------------------------------------------------

describe("POST /api/preview/probe — lifecycle & audit", () => {
  it("dispose('close') mid-probe ⇒ 503 E_HUB_RESTARTING, fd still recovered", async () => {
    const fx = fixture();
    const f = fx.file("slow.ts", "slow content\n");
    const counts: Record<string, number> = {};
    const fs: PreviewFs = hookedFs({ counts, delayMs: { realpath: 40 } });
    const admitter = createFsAdmitter({
      denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
      tracker: createPreviewIoTracker(),
      log,
      now: Date.now,
      fs,
    });
    const r = routes(fx, { admitter });
    const req = new FakeReq({ "x-pwh": "1" }, JSON.stringify({ paths: [f] }));
    const res = new FakeRes();
    const p = r.handleProbe(req as unknown as IncomingMessage, res, probeQuery(agentKey, sessionId), makeIo());
    req.deliver();
    await new Promise((resolve) => setTimeout(resolve, 5).unref?.());
    await r.dispose("close", createReqDeadline(Date.now, 500));
    await p;
    expect(res.status).toBe(503);
    expect(res.json()).toEqual({ error: "E_HUB_RESTARTING" });
  });

  it("one audit line per probe request — phase probe, count in total, NEVER a raw path", async () => {
    const fx = fixture();
    const a = fx.file("a.ts", "x");
    const b = fx.file("b.md", "y");
    await probe(routes(fx), { paths: [a, b, join(fx.cwd, "gone.zsh")] });
    const lines = probeAudits(log).filter((l) => l.phase === "probe");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ok: true, total: 3, listener: "loopback", agentKey });
    const raw = JSON.stringify(lines[0]);
    expect(raw.includes("a.ts")).toBe(false);
    expect(raw.includes("gone")).toBe(false);
  });

  it("admitter-step budget: a batch that outruns the shared deadline answers missing for the stragglers, still 200", async () => {
    const fx = fixture();
    const a = fx.file("a.ts", "x");
    const b = fx.file("b.ts", "y");
    // A call-counting fake clock: the first two `now()` calls (startedAt, the ReqDeadline's
    // own `at = now() + 8000`) see REAL time so the deadline anchors normally; every later
    // call jumps 100s ahead ⇒ `remaining() === 0` for every fs step ⇒ both entries degrade
    // to missing while the request itself still answers 200.
    const realNow = Date.now;
    let calls = 0;
    const now = (): number => {
      calls += 1;
      return calls <= 2 ? realNow() : realNow() + 100_000;
    };
    const r = createPreviewRoutes({
      mode: "on",
      denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
      uploadsRoot: fx.uploadsRoot,
      registry: fx.registry,
      log,
      now,
      admitter: createFsAdmitter({
        denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
        tracker: createPreviewIoTracker(),
        log,
        now,
        fs: defaultPreviewFs() as PreviewFs,
      }),
    });
    const res = await probe(r, { paths: [a, b] });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ results: [{ kind: "missing" }, { kind: "missing" }] });
  });
});

// ---------------------------------------------------------------------------
// dir-plan v3.1 P1a: global admission (U4) + §2.4 busy + the §1.3 UI-parser contract
// ---------------------------------------------------------------------------

describe("P1a probe — global admission, busy, UI-parser contract", () => {
  it("U4: an outside-cwd IMAGE answers image (the real result, not missing)", async () => {
    const fx = fixture();
    const img = join(dir, "elsewhere", "shot.png");
    mkdirSync(join(dir, "elsewhere"), { recursive: true });
    writeFileSync(img, pngBytes(3, 4));
    const res = await probe(routes(fx), { paths: [img] });
    expect(res.json()).toEqual({ results: [{ kind: "image" }] });
  });

  it("U4: a single-segment absolute path is a valid probe entry now (minSegments 1)", async () => {
    const fx = fixture();
    const res = await probe(routes(fx), { paths: ["/etc/hostname", "/only"] });
    expect(res.json()).toEqual({ results: [{ kind: "text" }, { kind: "missing" }] });
  });

  it("§2.4 busy: a tripped tracker folds to missing (probe 中熔断降级为 missing, never a 4xx)", async () => {
    const fx = fixture();
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
    const dl = createReqDeadline(Date.now, 8000);
    const sig = new AbortController().signal;
    await expect(tripped.admit({ path: "/etc/hostname" }, dl, sig)).resolves.toMatchObject({ ok: false, status: 504 });
    await expect(tripped.admit({ path: "/etc/hostname" }, dl, sig)).resolves.toMatchObject({ ok: false, status: 504 });
    expect(tracker.zombies).toBe(2);

    const admitter = createFsAdmitter({ denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")), tracker, log, now: Date.now });
    const good = fx.file("ok.md", "# ok\n");
    const res = await probe(routes(fx, { admitter }), { paths: [good] });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ results: [{ kind: "missing" }] }); // busy ⇒ missing, batch lives
  });

  it("§1.3 runtime contract: the hub's real answer body passes the UI's parseProbeResults", async () => {
    const fx = fixture();
    const a = fx.file("a.ts", "x");
    const img = join(fx.cwd, "p.png");
    writeFileSync(img, pngBytes(2, 2));
    const res = await probe(routes(fx), { paths: [a, img, join(fx.cwd, "gone.zsh")] });
    const { parseProbeResults } = await import("../../../../src/web-hub/ui/src/logic/previewProbe.js");
    const parsed = parseProbeResults(res.json(), 3);
    expect(parsed).toEqual({ ok: true, kinds: ["text", "image", "missing"] });
  });
});

// ---------------------------------------------------------------------------
// dir-plan v3.1 §1.1/§3.5 (P1b) — `dirs:true`: directories answer "dir"
// ---------------------------------------------------------------------------

describe("P1b probe — dirs:true", () => {
  it("parseProbeBody: dirs accepted ONLY as the literal true (anything else is dropped)", () => {
    expect(parseProbeBody({ paths: ["/a/b"], dirs: true })).toEqual({ ok: true, paths: ["/a/b"], dirs: true });
    expect(parseProbeBody({ paths: ["/a/b"] })).toEqual({ ok: true, paths: ["/a/b"] });
    expect(parseProbeBody({ paths: ["/a/b"], dirs: false })).toEqual({ ok: true, paths: ["/a/b"] });
    expect(parseProbeBody({ paths: ["/a/b"], dirs: "yes" })).toEqual({ ok: true, paths: ["/a/b"] });
    expect(parseProbeBody({ paths: ["/a/b"], dirs: 1 })).toEqual({ ok: true, paths: ["/a/b"] });
  });

  it('dirs:true ⇒ a real directory answers "dir"; without dirs the SAME directory stays missing', async () => {
    const fx = fixture();
    const d = join(fx.cwd, "pkg");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "x.txt"), "x");

    const withDirs = await probe(routes(fx), { paths: [d], dirs: true });
    expect(withDirs.status).toBe(200);
    expect(withDirs.json()).toEqual({ results: [{ kind: "dir" }] });

    const without = await probe(routes(fx), { paths: [d] });
    expect(without.json()).toEqual({ results: [{ kind: "missing" }] }); // 415 folds to missing

    const explicitFalse = await probe(routes(fx), { paths: [d], dirs: false });
    expect(explicitFalse.json()).toEqual({ results: [{ kind: "missing" }] });
  });

  it("dirs:true mixes with files in request order (dir/file/text/missing preserved)", async () => {
    const fx = fixture();
    const d = join(fx.cwd, "pkg");
    mkdirSync(d, { recursive: true });
    const f = fx.file("note.txt", "hi");
    const res = await probe(routes(fx), { paths: [d, f, join(fx.cwd, "gone.txt")], dirs: true });
    expect(res.json()).toEqual({ results: [{ kind: "dir" }, { kind: "text" }, { kind: "missing" }] });
  });

  it("a directory entry's fd is released through the BOUNDED close (§3.3 directory-fd rule)", async () => {
    const fx = fixture();
    let closes = 0;
    const neverSettle = new FakeHandle(Buffer.alloc(0), { ino: 77, dev: 3 });
    neverSettle.close = (): Promise<void> => {
      closes += 1;
      return new Promise(() => undefined);
    };
    const admitter: FsAdmitter = {
      admit: async (input) =>
        input.allowDir === true
          ? { ok: true, fh: neverSettle, size: 4096, realpath: "/srv/d", dir: true }
          : { ok: false, status: 415, code: "E_PREVIEW_UNSUPPORTED", reason: "not-regular" },
    };
    const t0 = Date.now();
    const res = await probe(routes(fx, { admitter }), { paths: ["/srv/d"], dirs: true });
    expect(res.json()).toEqual({ results: [{ kind: "dir" }] });
    // probeOne answered "dir" but the handle's release waited the bounded 1 s before giving up
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(closes).toBe(1);
  });

  it("an empty batch with dirs:true is still a legal no-op (200, [])", async () => {
    const fx = fixture();
    const res = await probe(routes(fx), { paths: [], dirs: true });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ results: [] });
  });
});
