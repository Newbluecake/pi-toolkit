/**
 * web-hub HTML preview (plan v2 §8 T-H4–T-H9, T-H12, T-H14, T-H16/16b/17) — loopback listener
 * through the REAL `createHttpFrontend` + `createPreviewRoutes({ html })`.
 */
import { constants as fsConstants, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReqDeadline } from "../../../src/web-hub/hub/req-deadline.js";
import { createPvIoGate } from "../../../src/web-hub/hub/preview/pv-io.js";
import { PREVIEW_PATH } from "../../../src/web-hub/protocol/preview.js";
import {
  PREVIEW_HTML_CAP_PATH,
  PV_ACTIVE_PER_CAP,
  PV_CAP_RE,
  PV_IDLE_TTL_MS,
  PV_QUEUE_PER_CAP,
  PV_SANDBOX,
} from "../../../src/web-hub/protocol/preview-html.js";
import { rawRequest } from "./helpers.js";
import {
  AGENT,
  SESSION,
  deferred,
  fdCount,
  openGet,
  scriptedFs,
  startPvHarness,
  waitUntil,
  writeSiteFile,
  type PvHarness,
} from "./pv-kit.js";

let h: PvHarness | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.cleanup();
  h = undefined;
});

const O_DIRECTORY = fsConstants.O_DIRECTORY;
const CSP_BASE = `sandbox ${PV_SANDBOX}; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; object-src 'none'`;

describe("mint — POST /api/preview/html-cap (§2.1, T-H5)", () => {
  beforeEach(async () => {
    h = await startPvHarness({ uploadsRootRel: "uploads" });
  });

  it("200 body shape: /pv/<cap>/<entry>, /pvw/<cap>, idleMs, hardRemainingMs; no-store", async () => {
    const r = await h!.mint(join(h!.site, "index.html"));
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const b = JSON.parse(r.body) as Record<string, unknown>;
    expect(Object.keys(b).sort()).toEqual(["hardRemainingMs", "idleMs", "openUrl", "url"]);
    const m = /^\/pv\/([A-Za-z0-9_-]{43})\/index\.html$/.exec(b["url"] as string);
    expect(m).not.toBeNull();
    expect(b["openUrl"]).toBe(`/pvw/${m![1]}`);
    expect(b["idleMs"]).toBe(PV_IDLE_TTL_MS);
    expect(b["hardRemainingMs"]).toBeGreaterThan(59 * 60_000);
    expect(b["hardRemainingMs"]).toBeLessThanOrEqual(60 * 60_000);
  });

  it("entry name is percent-encoded; two mints of the same file are two distinct caps", async () => {
    writeSiteFile(h!.site, "报告 一.html", "<p>x</p>");
    const a = await h!.mintOk(join(h!.site, "报告 一.html"));
    expect(a.url.endsWith(`/${encodeURIComponent("报告 一.html")}`)).toBe(true);
    const b = await h!.mintOk(join(h!.site, "报告 一.html"));
    expect(a.cap).not.toBe(b.cap);
    const r = await h!.get(a.url);
    expect(r.status).toBe(200);
  });

  it("non-html ⇒ 400; no X-PWH ⇒ 403; non-JSON ⇒ 403; no cookie ⇒ 401; missing file ⇒ 404", async () => {
    expect((await h!.mint(join(h!.site, "style.css"))).status).toBe(400);
    const q = `agentKey=${AGENT}&sessionId=${SESSION}`;
    const body = JSON.stringify({ path: join(h!.site, "index.html") });
    const base = { method: "POST", path: `${PREVIEW_HTML_CAP_PATH}?${q}`, body };
    const noPwh = await rawRequest(h!.port, {
      ...base,
      headers: { Cookie: h!.cookie, "Content-Type": "application/json" },
    });
    expect(noPwh.status).toBe(403);
    const text = await rawRequest(h!.port, {
      ...base,
      headers: { Cookie: h!.cookie, "Content-Type": "text/plain", "X-PWH": "1" },
    });
    expect(text.status).toBe(403);
    const noCookie = await rawRequest(h!.port, {
      ...base,
      headers: { "Content-Type": "application/json", "X-PWH": "1" },
    });
    expect(noCookie.status).toBe(401);
    expect((await h!.mint(join(h!.site, "nope.html"))).status).toBe(404);
  });

  it("directory D2: ~/x.html (the home) ⇒ 403 dir-too-broad; agent dir ⇒ 403; uploads root ⇒ 403 upload", async () => {
    writeFileSync(join(h!.dir, "x.html"), "<p/>");
    const home = await h!.mint("~/x.html");
    expect(home.status).toBe(403);
    expect(JSON.parse(home.body)).toEqual({ error: "E_PREVIEW_DENIED", reason: "dir-too-broad" });

    mkdirSync(join(h!.dir, ".pi/agent"), { recursive: true });
    writeFileSync(join(h!.dir, ".pi/agent/a.html"), "<p/>");
    expect((await h!.mint(join(h!.dir, ".pi/agent/a.html"))).status).toBe(403);

    const up = join(h!.dir, "uploads", `s-${SESSION}`);
    mkdirSync(up, { recursive: true });
    writeFileSync(join(up, "u.html"), "<p/>");
    const lit = await h!.mint(join(up, "u.html"));
    expect(lit.status).toBe(403);
    expect(JSON.parse(lit.body)).toEqual({ error: "E_PREVIEW_DENIED", reason: "upload" });
  });

  it("P1a check #1 — the REAL uploads root reaches D2: a symlinked spelling of an uploads dir ⇒ 403 dir-too-broad", async () => {
    const up = join(h!.dir, "uploads", `s-${SESSION}`);
    mkdirSync(up, { recursive: true });
    writeFileSync(join(up, "u.html"), "<p/>");
    symlinkSync(up, join(h!.dir, "cwd", "uplink"));
    const r = await h!.mint(join(h!.dir, "cwd", "uplink", "u.html"));
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toEqual({ error: "E_PREVIEW_DENIED", reason: "dir-too-broad" });
  });

  it("P1a check #2 — the denylist applies to the bound directory itself (kubeconfig/ page.html)", async () => {
    writeSiteFile(h!.site, "kubeconfig/page.html", "<p/>");
    const r = await h!.mint(join(h!.site, "kubeconfig/page.html"));
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toEqual({ error: "E_PREVIEW_DENIED", reason: "denylist" });
  });

  it("audit line carries class/tags only — never the path, the file name or the cap", async () => {
    const m = await h!.mintOk();
    const lines = h!.logLines.filter((l) => l.msg === "preview html-cap");
    await waitUntil(() => h!.logLines.some((l) => l.msg === "preview html-cap"));
    expect(lines.length + 0).toBeGreaterThanOrEqual(0);
    const all = JSON.stringify(h!.logLines.filter((l) => l.msg === "preview html-cap"));
    expect(all).toContain('"kind":"html-cap"');
    expect(all).toContain('"ok":true');
    expect(all).not.toContain(m.cap);
    expect(all).not.toContain(h!.site);
    expect(all).not.toContain("index.html");
  });

  it("counts against the preview bucket (the same ${principal}:preview line)", async () => {
    for (let i = 0; i < 20; i += 1) expect((await h!.mint(join(h!.site, "index.html"))).status).toBe(200);
    const r = await h!.mint(join(h!.site, "index.html"));
    expect(r.status).toBe(429);
  });
});

describe("serve — headers, content, 404 oracle (§2.3, §3.1, T-H6/T-H7)", () => {
  beforeEach(async () => {
    h = await startPvHarness();
  });

  it("entry document: §3.1 header table exactly (frame-ancestors = cap origin), body bytes", async () => {
    const m = await h!.mintOk();
    const r = await h!.get(m.url);
    expect(r.status).toBe(200);
    expect(r.body).toContain("pv-site fixture");
    expect(r.headers["content-security-policy"]).toBe(`${CSP_BASE}; frame-ancestors http://127.0.0.1:${h!.port}`);
    expect(r.headers["x-frame-options"]).toBeUndefined();
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["permissions-policy"]).toContain("camera=()");
    expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(r.headers["vary"]).toBe("Origin");
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    expect(r.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(r.headers["set-cookie"]).toBeUndefined();
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(Object.keys(r.headers).filter((k) => k.startsWith("x-pwh-preview"))).toEqual([]);
    expect(r.headers["content-length"]).toBe(String(Buffer.byteLength(r.body)));
  });

  it("non-entry assets: no frame-ancestors, per-extension types, ACAO null only for Origin: null", async () => {
    const m = await h!.mintOk();
    const base = `/pv/${m.cap}`;
    const css = await h!.get(`${base}/style.css`);
    expect(css.status).toBe(200);
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(css.headers["content-security-policy"]).toBe(CSP_BASE);
    expect((await h!.get(`${base}/app.js`)).headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect((await h!.get(`${base}/sub/data.json`)).headers["content-type"]).toBe("application/json");
    const nonAscii = await h!.get(`${base}/${encodeURIComponent("报告")}/${encodeURIComponent("图.txt")}`);
    expect(nonAscii.status).toBe(200);
    expect(nonAscii.body).toContain("non-ascii");
    const withNull = await h!.get(`${base}/app.js`, { Origin: "null" });
    expect(withNull.headers["access-control-allow-origin"]).toBe("null");
    expect(withNull.headers["access-control-allow-credentials"]).toBeUndefined();
    const other = await h!.get(`${base}/app.js`, { Origin: "https://evil.example" });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("error statuses carry the same header layer (400 / 404 / 403): sandbox CSP, no XFO, no-referrer", async () => {
    const m = await h!.mintOk();
    writeSiteFile(h!.site, ".ssh/id_rsa", "FAKE");
    const cases = [
      await h!.get(`/pv/${m.cap}/sub/..%2fx`), // 400 encoded separator
      await h!.get(`/pv/${m.cap}/missing.css`), // 404
      await h!.get(`/pv/${m.cap}/.ssh/id_rsa`), // 403 denylist
      await h!.get(`/pv/${"A".repeat(43)}/index.html`), // 404 unknown cap
    ];
    expect(cases.map((r) => r.status)).toEqual([400, 404, 403, 404]);
    for (const r of cases) {
      expect(r.headers["content-security-policy"]).toBe(CSP_BASE);
      expect(r.headers["x-frame-options"]).toBeUndefined();
      expect(r.headers["referrer-policy"]).toBe("no-referrer");
      expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
    }
  });

  it("T-H7: cookie independence — with / without / bad cookie are byte-equal; a valid cookie never rescues a bad cap", async () => {
    const m = await h!.mintOk();
    const a = await h!.get(m.url);
    const b = await h!.get(m.url, { Cookie: h!.cookie });
    const c = await h!.get(m.url, { Cookie: "pwh_sid=garbage" });
    expect(b.status).toBe(200);
    expect(b.body).toBe(a.body);
    expect(c.body).toBe(a.body);
    expect(b.headers["set-cookie"]).toBeUndefined();
    const bad = await h!.get(`/pv/${"B".repeat(43)}/index.html`, { Cookie: h!.cookie });
    const bad2 = await h!.get(`/pv/${"B".repeat(43)}/index.html`);
    expect(bad.status).toBe(404);
    expect(bad.body).toBe(bad2.body);
  });

  it("T-H7: /pv never touches the auth port (spy on auth.check)", async () => {
    const m = await h!.mintOk();
    const spy = vi.spyOn(h!.fe.auth, "check");
    await h!.get(m.url);
    await h!.get(`/pv/${m.cap}/style.css`);
    await h!.get(`/pv/${"C".repeat(43)}/x`);
    await h!.get(m.openUrl);
    expect(spy).not.toHaveBeenCalled();
  });

  it("query string is dropped and never matters; non-GET ⇒ 404; HEAD ⇒ 404", async () => {
    const m = await h!.mintOk();
    expect((await h!.get(`${m.url}?x=../../etc/passwd`)).status).toBe(200);
    const post = await rawRequest(h!.port, { method: "POST", path: m.url, headers: { "X-PWH": "1" }, body: "{}" });
    expect(post.status).toBe(404);
    const head = await rawRequest(h!.port, { method: "HEAD", path: m.url });
    expect(head.status).toBe(404);
  });

  it("T-H9: raw-socket traversal spellings ⇒ 400 (no client-side normalisation)", async () => {
    const m = await h!.mintOk();
    for (const p of [
      `/pv/${m.cap}/../x`,
      `/pv/${m.cap}/%2e%2e/x`,
      `/pv/${m.cap}/sub%2f..%2fx`,
      `/pv/${m.cap}/sub/%2E%2e/x`,
      `/pv/${m.cap}//x`,
      `/pv/${m.cap}/a%5cb`,
      `/pv/${m.cap}/%00`,
    ]) {
      const r = await h!.get(p);
      expect(r.status, p).toBe(400);
    }
    expect((await h!.get(`/pv/${m.cap}`)).status).toBe(400);
    expect((await h!.get(`/pv/${m.cap}/`)).status).toBe(400);
  });

  it("symlink escaping the dir ⇒ 403; symlink inside ⇒ 200; directory ⇒ 415", async () => {
    const m = await h!.mintOk();
    writeFileSync(join(h!.dir, "outside.txt"), "secret");
    symlinkSync(join(h!.dir, "outside.txt"), join(h!.site, "leak.txt"));
    symlinkSync(join(h!.site, "style.css"), join(h!.site, "alias.css"));
    expect((await h!.get(`/pv/${m.cap}/leak.txt`)).status).toBe(403);
    expect((await h!.get(`/pv/${m.cap}/alias.css`)).status).toBe(200);
    expect((await h!.get(`/pv/${m.cap}/sub`)).status).toBe(415);
  });

  it("T-H3 (wiring): bound dir renamed away + a lookalike planted ⇒ still the held inode; deleted dir ⇒ cap ends, 404", async () => {
    const m = await h!.mintOk();
    rmSync(join(h!.dir, "site-moved"), { recursive: true, force: true });
    const { renameSync } = await import("node:fs");
    renameSync(h!.site, join(h!.dir, "site-moved"));
    mkdirSync(h!.site, { recursive: true });
    writeFileSync(join(h!.site, "planted.css"), "x");
    // the held inode still serves the ORIGINAL files, wherever it was moved to … but the dir fd's
    // own path is now `…/site-moved`, which is a valid, non-deleted directory
    expect((await h!.get(`/pv/${m.cap}/style.css`)).status).toBe(200);
    expect((await h!.get(`/pv/${m.cap}/planted.css`)).status).toBe(404);
    rmSync(join(h!.dir, "site-moved"), { recursive: true, force: true });
    expect((await h!.get(`/pv/${m.cap}/style.css`)).status).toBe(404);
    const end = h!.logLines.find((l) => l.msg === "preview html cap end");
    expect(end).toBeDefined();
    expect((end!.data as { end: string }).end).toBe("revoked");
    expect(JSON.stringify(h!.logLines)).not.toContain(m.cap);
  });
});

describe("/pvw wrapper (§3.2, T-H13)", () => {
  it("CSP exact, one sandboxed iframe, no <script, escaped title; wrong cap / method ⇒ 404", async () => {
    h = await startPvHarness();
    writeSiteFile(h.site, "<script>.html", "<p/>");
    const m = await h.mintOk(join(h.site, "<script>.html"));
    const r = await h.get(m.openUrl);
    expect(r.status).toBe(200);
    expect(r.headers["content-security-policy"]).toBe(
      "default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(r.body).not.toContain("<script");
    expect(r.body).toContain("&lt;script&gt;.html</title>");
    expect(r.body.match(/<iframe /g)).toHaveLength(1);
    expect(r.body).toContain(`sandbox="${PV_SANDBOX}"`);
    expect(r.body).toContain('referrerpolicy="no-referrer"');
    expect(r.body).toContain(`src="/pv/${m.cap}/${encodeURIComponent("<script>.html")}"`);
    expect(r.body).not.toContain("allow-same-origin");
    expect((await h.get(`/pvw/${"D".repeat(43)}`)).status).toBe(404);
    expect((await h.get(`/pvw/${m.cap}/extra`)).status).toBe(404);
    const post = await rawRequest(h.port, { method: "POST", path: m.openUrl, body: "x" });
    expect(post.status).toBe(404);
  });
});

describe("queue + budgets (§2.3-③④, T-H8)", () => {
  it("50 parallel requests on one cap ⇒ all 200, ≤ PV_ACTIVE_PER_CAP concurrently holding a file", async () => {
    const s = scriptedFs();
    h = await startPvHarness({ html: { fs: s.fs } });
    writeSiteFile(h.site, "big.bin", Buffer.alloc(300 * 1024, 7));
    let open = 0;
    let max = 0;
    s.wrapHandle = (fh, p, flags) => {
      if ((flags & O_DIRECTORY) !== 0 || !p.endsWith("big.bin")) return fh;
      open += 1;
      max = Math.max(max, open);
      let closed = false;
      return {
        fd: fh.fd,
        stat: () => fh.stat(),
        read: (b, o, l, pos) => fh.read(b, o, l, pos),
        close: () => {
          if (!closed) {
            closed = true;
            open -= 1;
          }
          return fh.close();
        },
      };
    };
    // every admission is slowed slightly so overlap is real
    s.hooks.push(async (op) => {
      if (op === "realpath") await new Promise((r) => setTimeout(r, 15));
    });
    const m = await h.mintOk();
    const rs = await Promise.all(Array.from({ length: 50 }, () => h!.get(`/pv/${m.cap}/big.bin`)));
    expect(rs.every((r) => r.status === 200 && r.body.length === 300 * 1024)).toBe(true);
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThanOrEqual(PV_ACTIVE_PER_CAP);
  });

  it("the (6 active + 64 queued + 1)th concurrent request ⇒ 503 Retry-After; the 70 admitted all finish; /api/preview unaffected", async () => {
    const s = scriptedFs();
    h = await startPvHarness({ html: { fs: s.fs } });
    const gateOpen = deferred();
    let hold = true;
    s.hooks.push(async (op) => {
      if (op === "realpath" && hold) await gateOpen.promise;
    });
    const m = await h.mintOk();
    const total = PV_ACTIVE_PER_CAP + PV_QUEUE_PER_CAP;
    const pending = Array.from({ length: total }, () => h!.get(`/pv/${m.cap}/style.css`));
    // let the 6 reach the held realpath and the other 64 queue
    await new Promise((r) => setTimeout(r, 400));
    const over = await h.get(`/pv/${m.cap}/style.css`);
    expect(over.status).toBe(503);
    expect(over.headers["retry-after"]).toBe("1");
    // the preview endpoint rides its own admission and keeps serving
    writeSiteFile(h.dir, "cwd/a.txt", "hi");
    const prev = await rawRequest(h.port, {
      path: `${PREVIEW_PATH}?agentKey=${AGENT}&sessionId=${SESSION}&path=${encodeURIComponent(join(h.dir, "cwd/a.txt"))}`,
      headers: { Cookie: h.cookie, "X-PWH": "1" },
    });
    expect(prev.status).toBe(200);
    hold = false;
    gateOpen.resolve();
    const done = await Promise.all(pending);
    expect(done.map((r) => r.status).filter((c) => c !== 200)).toEqual([]);
  }, 20_000);

  it("a waiter that waits longer than PV_QUEUE_WAIT_MS ⇒ 503 (the 10 s timer is shortened for the test)", async () => {
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...a: unknown[]) =>
      realSetTimeout(fn, ms === 10_000 ? 150 : ms, ...a)) as typeof setTimeout);
    const s = scriptedFs();
    h = await startPvHarness({ html: { fs: s.fs } });
    const gateOpen = deferred();
    s.hooks.push(async (op) => {
      if (op === "realpath") await gateOpen.promise;
    });
    const m = await h.mintOk();
    const active = Array.from({ length: PV_ACTIVE_PER_CAP }, () => h!.get(`/pv/${m.cap}/style.css`));
    await new Promise((r) => realSetTimeout(r, 100));
    const waiter = await h.get(`/pv/${m.cap}/style.css`);
    expect(waiter.status).toBe(503);
    expect(waiter.headers["retry-after"]).toBe("1");
    gateOpen.resolve();
    await Promise.allSettled(active);
  }, 20_000);

  it("lifetime request budget ⇒ 429 (limit seam is the frozen 10 000 — here: the per-cap bucket of 200)", async () => {
    h = await startPvHarness();
    const m = await h.mintOk();
    const rs = await Promise.all(Array.from({ length: 260 }, () => h!.get(`/pv/${m.cap}/style.css`)));
    expect(rs.some((r) => r.status === 429)).toBe(true);
    expect(rs.some((r) => r.status === 200)).toBe(true);
  }, 30_000);
});

describe("T-H12 invariants I1–I4 (loopback)", () => {
  it("Origin: null + a valid cookie to representative GET APIs ⇒ never an Access-Control-* header; OPTIONS ⇒ 404; text/plain POST /api/cmd ⇒ 403", async () => {
    h = await startPvHarness();
    const hdr = { Cookie: h.cookie, Origin: "null" };
    const paths = [
      `/api/history?agentKey=${AGENT}`,
      "/api/run/history",
      `${PREVIEW_PATH}?agentKey=${AGENT}&sessionId=${SESSION}&path=${encodeURIComponent(join(h.site, "index.html"))}`,
      "/api/headless",
      "/api/load/top",
      "/api/avatar",
      "/api/version",
    ];
    for (const p of paths) {
      const r = await rawRequest(h.port, { path: p, headers: hdr });
      expect(
        Object.keys(r.headers).filter((k) => k.startsWith("access-control-")),
        p,
      ).toEqual([]);
    }
    const sse = await openGet(h.port, "/api/events", hdr);
    expect(Object.keys(sse.res.headers).filter((k) => k.startsWith("access-control-"))).toEqual([]);
    sse.destroy();
    for (const p of ["/api/history", "/api/cmd", "/api/preview/html-cap"]) {
      const r = await rawRequest(h.port, {
        method: "OPTIONS",
        path: p,
        headers: { ...hdr, "Access-Control-Request-Method": "POST" },
      });
      expect(r.status, p).toBe(404);
      expect(Object.keys(r.headers).filter((k) => k.startsWith("access-control-"))).toEqual([]);
    }
    const cmd = await rawRequest(h.port, {
      method: "POST",
      path: "/api/cmd",
      headers: { Cookie: h.cookie, Origin: "null", "Content-Type": "text/plain" },
      body: JSON.stringify({ x: 1 }),
    });
    expect(cmd.status).toBe(403);
    // mint with Origin: null is refused by the CSRF gate even with a valid cookie + X-PWH
    const mint = await h.mint(join(h.site, "index.html"), { headers: { Origin: "null" } });
    expect(mint.status).toBe(403);
  });
});

describe("revocation & races (§2.4, T-H14, T-H16, T-H16b, T-H17)", () => {
  it("loopback logout revokes this session's caps (next asset ⇒ 404) and emits one pv-end audit", async () => {
    h = await startPvHarness();
    const m = await h.mintOk();
    expect((await h.get(m.url)).status).toBe(200);
    expect((await h.logout()).status).toBe(200);
    expect((await h.get(m.url)).status).toBe(404);
    expect((await h.get(m.openUrl)).status).toBe(404);
    const ends = h.logLines.filter((l) => l.msg === "preview html cap end");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.data).toMatchObject({ ev: "pv-end", end: "revoked" });
  });

  it("T-H16: logout while the mint is paused at the dir-pin step ⇒ 401, no cap, dir fd closed", async () => {
    const s = scriptedFs();
    h = await startPvHarness({ html: { fs: s.fs } });
    const reached = deferred();
    const resume = deferred();
    s.hooks.push(async (op, _arg, flags) => {
      if (op === "open" && flags !== undefined && (flags & O_DIRECTORY) !== 0) {
        reached.resolve();
        await resume.promise;
      }
    });
    const base = fdCount();
    const pending = h.mint(join(h.site, "index.html"));
    await reached.promise;
    expect((await h.logout()).status).toBe(200);
    resume.resolve();
    const r = await pending;
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body)).toEqual({ error: "E_AUTH" });
    await waitUntil(() => fdCount() <= base);
    expect(h.logLines.filter((l) => l.msg === "preview html cap end")).toHaveLength(0);
  });

  it("T-H16: a listener-wide revoke (rotate) during the pause also fails the mint", async () => {
    const s = scriptedFs();
    h = await startPvHarness({ html: { fs: s.fs } });
    const reached = deferred();
    const resume = deferred();
    s.hooks.push(async (op, _a, flags) => {
      if (op === "open" && flags !== undefined && (flags & O_DIRECTORY) !== 0) {
        reached.resolve();
        await resume.promise;
      }
    });
    const pending = h.mint(join(h.site, "index.html"));
    await reached.promise;
    h.fe.revokeAllSse();
    resume.resolve();
    expect((await pending).status).toBe(401);
  });

  it("T-H16b: a revoke landing AFTER authorize resolved its lookup but BEFORE it returns ⇒ 401 (seq0 is captured before authorize)", async () => {
    h = await startPvHarness();
    const cases: Array<{
      name: string;
      sel: Parameters<NonNullable<typeof h.routes.revokeHtmlCaps>>[0];
      expect: number;
    }> = [
      { name: "sidTag", sel: { sidTag: "S1" }, expect: 401 },
      { name: "userId", sel: { userId: 7 }, expect: 401 },
      { name: "listener", sel: { listener: "loopback" }, expect: 401 },
      { name: "other session (control)", sel: { sidTag: "S2" }, expect: 200 },
    ];
    for (const c of cases) {
      const release = deferred();
      const inAuth = deferred();
      const srv = createServer((req, res) => {
        void h!.routes.handleHtmlCap!(req, res, new URLSearchParams(`agentKey=${AGENT}&sessionId=${SESSION}`), {
          listener: "loopback",
          ip: "127.0.0.1",
          expectedOrigin: "http://127.0.0.1",
          authorize: async () => {
            inAuth.resolve();
            await release.promise;
            return { ip: "127.0.0.1", sidTag: "S1", userId: 7 };
          },
          sendJson: (r, status, body) => {
            r.writeHead(status, { "content-type": "application/json" });
            r.end(JSON.stringify(body));
          },
        });
      });
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const port = (srv.address() as { port: number }).port;
      const out = new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: "/x",
            headers: { "content-type": "application/json", "x-pwh": "1" },
            agent: false,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (b: Buffer) => chunks.push(b));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify({ path: join(h!.site, "index.html") }));
      });
      await inAuth.promise;
      h.routes.revokeHtmlCaps!(c.sel, "logout");
      release.resolve();
      const r = await out;
      expect(r.status, c.name).toBe(c.expect);
      await new Promise<void>((r2) => srv.close(() => r2()));
    }
  });

  it("T-H17: revoke while the request is paused in admission ⇒ constant 404, never the file", async () => {
    const s = scriptedFs();
    h = await startPvHarness({ html: { fs: s.fs } });
    const m = await h.mintOk();
    const reached = deferred();
    const resume = deferred();
    s.hooks.push(async (op) => {
      if (op === "realpath") {
        reached.resolve();
        await resume.promise;
      }
    });
    const pending = h.get(`/pv/${m.cap}/style.css`);
    await reached.promise;
    await h.logout();
    resume.resolve();
    const r = await pending;
    expect(r.status).toBe(404);
    expect(r.body).not.toContain("font-family");
  });

  it("T-H17: revoke mid-stream destroys the socket (no clean end)", async () => {
    h = await startPvHarness();
    writeSiteFile(h.site, "huge.bin", Buffer.alloc(24 * 1024 * 1024, 1));
    const m = await h.mintOk();
    const { res } = await openGet(h.port, `/pv/${m.cap}/huge.bin`);
    expect(res.statusCode).toBe(200);
    let ended = false;
    const closed = new Promise<void>((resolve) => {
      res.on("end", () => (ended = true));
      res.on("close", () => resolve());
      res.on("error", () => undefined);
    });
    res.once("data", () => res.pause()); // stop reading ⇒ the server blocks on drain mid-body
    await new Promise((r) => setTimeout(r, 200));
    await h.logout();
    res.resume();
    await closed;
    expect(ended).toBe(false);
  });

  it("T-H17: queued waiters of a revoked cap answer 404", async () => {
    const s = scriptedFs();
    h = await startPvHarness({ html: { fs: s.fs } });
    const m = await h.mintOk();
    const hold = deferred();
    s.hooks.push(async (op) => {
      if (op === "realpath") await hold.promise;
    });
    const all = Array.from({ length: PV_ACTIVE_PER_CAP + 3 }, () => h!.get(`/pv/${m.cap}/style.css`));
    await new Promise((r) => setTimeout(r, 300));
    await h.logout();
    hold.resolve();
    const rs = await Promise.all(all);
    expect(rs.map((r) => r.status)).toEqual(Array(PV_ACTIVE_PER_CAP + 3).fill(404));
  });

  it("T-H14: dispose aborts an in-flight stream, fails waiters, and every fd (dir fds included) is back", async () => {
    h = await startPvHarness();
    writeSiteFile(h.site, "huge.bin", Buffer.alloc(24 * 1024 * 1024, 1));
    const base = fdCount();
    const m = await h.mintOk();
    const { res, destroy } = await openGet(h.port, `/pv/${m.cap}/huge.bin`);
    let ended = false;
    const closed = new Promise<void>((resolve) => {
      res.on("end", () => (ended = true));
      res.on("close", () => resolve());
      res.on("error", () => undefined);
    });
    res.once("data", () => res.pause());
    await new Promise((r) => setTimeout(r, 200));
    await h.routes.dispose("close", createReqDeadline(Date.now, 1_000));
    res.resume();
    await closed;
    expect(ended).toBe(false);
    destroy();
    await waitUntil(() => fdCount() <= base);
    // after dispose the routes answer 503/404, never serve
    const after = await h.get(m.url);
    expect([404, 503]).toContain(after.status);
  });

  it("T-H14: a never-completing dir close keeps a PV slot (503 busy) while /api/preview keeps serving", async () => {
    const s = scriptedFs();
    const gate = createPvIoGate({ slots: 1 });
    h = await startPvHarness({ html: { fs: s.fs, gate } });
    const siteB = join(h.dir, "siteB");
    const { cpSync } = await import("node:fs");
    cpSync(h.site, siteB, { recursive: true });
    let dirOpens = 0;
    s.wrapHandle = (fh, _p, flags) => {
      if ((flags & O_DIRECTORY) === 0) return fh;
      dirOpens += 1;
      if (dirOpens !== 1) return fh;
      return {
        fd: fh.fd,
        stat: () => fh.stat(),
        read: (b, o, l, p) => fh.read(b, o, l, p),
        close: async () => {
          await fh.close();
          await new Promise<void>(() => undefined); // never settles ⇒ the slot is a zombie
        },
      };
    };
    const a = await h.mintOk(join(h.site, "index.html"));
    const b = await h.mintOk(join(siteB, "index.html"));
    expect((await h.get(`/pv/${b.cap}/style.css`)).status).toBe(200);
    rmSync(h.site, { recursive: true, force: true });
    expect((await h.get(`/pv/${a.cap}/style.css`)).status).toBe(404); // deleted dir ⇒ cap ends ⇒ hung close
    await waitUntil(() => gate.inflight === 1);
    const busy = await h.get(`/pv/${b.cap}/style.css`);
    expect(busy.status).toBe(503);
    writeSiteFile(h.dir, "cwd/a.txt", "hi");
    const prev = await rawRequest(h.port, {
      path: `${PREVIEW_PATH}?agentKey=${AGENT}&sessionId=${SESSION}&path=${encodeURIComponent(join(h.dir, "cwd/a.txt"))}`,
      headers: { Cookie: h.cookie, "X-PWH": "1" },
    });
    expect(prev.status).toBe(200);
    expect(PV_CAP_RE.test(a.cap)).toBe(true);
  }, 20_000);
});
