/**
 * web-hub @文件补全 — hub search endpoint tests (`hub/file-search.ts`).
 *
 * Direct `FileSearchRoutes.handle()` calls over a fake req/res pair (the same harness strategy
 * as `tests/web-hub/hub/preview/routes.test.ts`), plus pure-matcher and walk units against a
 * REAL tmpdir. Covers: the CSRF/auth/param pipeline and every reject mapping, the skip table /
 * depth cap / symlink-no-follow / token-unsafe skip, deterministic ordering + limit, the
 * deadline partial / abort silent paths, rate limit (own bucket) + in-flight 503, and the
 * audit whitelist (no raw query, no paths, ever).
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileSearchRoutes,
  defaultFileSearchFs,
  FILE_SEARCH_MAX_DEPTH,
  FILE_SEARCH_PATH,
  FILE_SEARCH_SKIP_DIRS,
  subsequenceScore,
  walkFileSearch,
  type DirentLike,
  type FileSearchRoutes,
} from "../../../src/web-hub/hub/file-search.js";
import { createReqDeadline } from "../../../src/web-hub/hub/req-deadline.js";
import type { AgentView, PreviewRouteIo, RegistryView } from "../../../src/web-hub/hub/ports.js";
import { memLog, type MemLog } from "./helpers.js";

// ---------------------------------------------------------------------------
// fakes (same shape as the preview route tests)
// ---------------------------------------------------------------------------

function fakeReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
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

  body(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }

  json<T = unknown>(): T {
    return JSON.parse(this.body()) as T;
  }
}

interface IoOpts {
  listener?: "loopback" | "lan";
  user?: string | null; // null ⇒ authorize answers 401 itself
  expectedOrigin?: string;
}

function makeIo(opts: IoOpts = {}): PreviewRouteIo {
  const sendJson: PreviewRouteIo["sendJson"] = (res, status, body, headers) => {
    const r = res as unknown as FakeRes;
    if (r.headersSent || r.destroyed) return;
    r.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...(headers ?? {}) });
    r.end(Buffer.from(JSON.stringify(body), "utf8"));
  };
  return {
    listener: opts.listener ?? "loopback",
    ip: "127.0.0.1",
    expectedOrigin: opts.expectedOrigin ?? "http://127.0.0.1:1",
    // mirrors the real listeners: an auth failure is ANSWERED here (401), then mirror-backed
    authorize: async () => {
      if (opts.user === null) {
        sendJson(resHolder[0]! as unknown as ServerResponse, 401, { error: "E_AUTH" });
        return { handled: true, code: "E_AUTH" };
      }
      return { ip: "127.0.0.1", ...(opts.user === undefined ? {} : { user: opts.user }) };
    },
    sendJson,
  };
}
/** The io is built per-request after `call()` captures its res (see makeResIo). */
const resHolder: Array<FakeRes | undefined> = [undefined];

/** A registry whose single agent has the given session cwd (undefined ⇒ no live session). */
function registryWith(cwd: string | undefined): Pick<RegistryView, "get"> {
  const view: { session?: { sessionId: string; cwd: string } } =
    cwd === undefined ? {} : { session: { sessionId: "s1", cwd } };
  return {
    get: () => view as unknown as AgentView,
  };
}

function qs(pairs: Record<string, string | undefined>): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(pairs)) if (v !== undefined) out.set(k, v);
  return out;
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let root = "";
let log: MemLog;

function file(rel: string, content = "x"): string {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
  return p;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pwh-filesearch-"));
  log = memLog();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function routes(cwd: string | null = root): FileSearchRoutes {
  return createFileSearchRoutes({
    mode: "on",
    registry: registryWith(cwd === null ? undefined : cwd),
    log,
    now: () => 0,
  });
}

async function call(
  rt: FileSearchRoutes,
  params: Record<string, string | undefined>,
  headers: Record<string, string> = { "x-pwh": "1" },
  ioOpts: IoOpts = {},
): Promise<{ status: number; headers: Record<string, string>; body: any; res: FakeRes }> {
  const res = new FakeRes();
  resHolder[0] = res;
  await rt.handle(fakeReq(headers), res as unknown as ServerResponse, qs(params), makeIo(ioOpts));
  return { status: res.status, headers: res.headers, body: res.json(), res };
}

// ---------------------------------------------------------------------------
// pure matcher
// ---------------------------------------------------------------------------

describe("subsequenceScore", () => {
  it("matches subsequences case-insensitively, rejects non-subsequences", () => {
    expect(subsequenceScore("rea", "README.md")).toBeDefined();
    expect(subsequenceScore("REA", "readme.md")).toBeDefined();
    expect(subsequenceScore("rmd", "README.md")).toBeDefined();
    expect(subsequenceScore("readmee", "README.md")).toBeUndefined();
    expect(subsequenceScore("xyz", "README.md")).toBeUndefined();
  });

  it("ranks a basename prefix over a scattered subsequence (rea: README beats stream)", () => {
    const readme = subsequenceScore("rea", "README.md")!;
    const stream = subsequenceScore("rea", "stream-parser.ts")!;
    expect(readme).toBeLessThan(stream);
  });

  it("exact (case-insensitive) match scores best", () => {
    const exact = subsequenceScore("readme.md", "README.md")!;
    const partial = subsequenceScore("read", "README.md")!;
    expect(exact).toBeLessThan(partial);
  });

  it("empty query scores 0 (bare browse)", () => {
    expect(subsequenceScore("", "anything.ts")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// the walk (real tmpdir)
// ---------------------------------------------------------------------------

async function walk(query: string): Promise<Awaited<ReturnType<typeof walkFileSearch>>> {
  return walkFileSearch(
    root,
    query,
    defaultFileSearchFs(),
    createReqDeadline(Date.now, 60_000),
    new AbortController().signal,
    { now: Date.now },
  );
}

describe("walkFileSearch", () => {
  it("collects files by basename subsequence, sorted best-first, deterministic ties", async () => {
    file("README.md");
    file("src/stream-parser.ts");
    file("docs/reading-list.txt");
    const out = await walk("read");
    const rels = out.hits.map((h) => h.rel);
    expect(rels).toContain("README.md");
    expect(rels).toContain("docs/reading-list.txt");
    expect(rels).not.toContain("src/stream-parser.ts");
    expect(rels[0]).toBe("README.md"); // prefix beats scattered (ties break by rel)
    expect(out.partial).toBe(false);
  });

  it("never descends the constant skip table", async () => {
    file("node_modules/hidden.js");
    file(".git/config");
    file("dist/bundle.js");
    file("real.ts");
    const out = await walk("");
    expect(out.hits.map((h) => h.rel)).toEqual(["real.ts"]);
    expect(FILE_SEARCH_SKIP_DIRS.has("node_modules")).toBe(true);
  });

  it("respects the depth cap (files deeper than the max are invisible)", async () => {
    const deep = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].join("/");
    file(`${deep}/deep.ts`);
    file("shallow.ts");
    const out = await walk("");
    expect(out.hits.map((h) => h.rel)).toEqual(["shallow.ts"]); // depth 9 > 8
    expect(FILE_SEARCH_MAX_DEPTH).toBe(8);
  });

  it("never follows symlinks — dirs are not descended, files are not offered", async () => {
    file("real/target.ts");
    file("outside.ts");
    mkdirSync(join(root, "elsewhere"), { recursive: true });
    writeFileSync(join(root, "elsewhere", "secret.ts"), "s");
    symlinkSync(join(root, "elsewhere"), join(root, "linkdir"));
    symlinkSync(join(root, "elsewhere", "secret.ts"), join(root, "linked.ts"));
    const out = await walk("");
    expect(out.hits.map((h) => h.rel)).toEqual(["elsewhere/secret.ts", "outside.ts", "real/target.ts"]);
  });

  it("skips token-unsafe paths (whitespace/quotes/brackets never round-trip)", async () => {
    file("has space.ts");
    file("has(bracket).ts");
    file("fine.ts");
    const out = await walk("");
    expect(out.hits.map((h) => h.rel)).toEqual(["fine.ts"]);
  });

  it("absolute paths are root-joined and rel is relative", async () => {
    const p = file("src/a.ts");
    const out = await walk("a.ts");
    expect(out.hits[0]!.path).toBe(p);
    expect(out.hits[0]!.rel).toBe("src/a.ts");
  });

  it("a deadline-exhausted readdir stops the walk and marks partial; an abort propagates", async () => {
    let calls = 0;
    const never: Promise<readonly DirentLike[]> = new Promise(() => {});
    const stalled: Partial<import("../../../src/web-hub/hub/file-search.js").FileSearchFs> = {
      realpath: async (p: string) => p,
      readdir: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve([
              { name: "sub", isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false },
            ])
          : never;
      },
    };
    // stepCapMs 25 ⇒ the second readdir's budget burns out after the root dir
    const out = await walkFileSearch(
      "/r",
      "",
      stalled as never,
      createReqDeadline(Date.now, 60_000),
      new AbortController().signal,
      {
        now: Date.now,
        stepCapMs: 25,
      },
    );
    expect(out.partial).toBe(true);

    const ctl = new AbortController();
    ctl.abort();
    await expect(
      walkFileSearch("/r", "", stalled as never, createReqDeadline(Date.now, 60_000), ctl.signal, { now: Date.now }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// the route pipeline
// ---------------------------------------------------------------------------

describe("file-search route", () => {
  it("requires X-PWH (403 E_CSRF before auth, no fs)", async () => {
    const r = await call(routes(), { agentKey: "a", q: "x" }, {}, { user: null });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("E_CSRF");
  });

  it("rejects Sec-Fetch-Site: cross-site", async () => {
    const r = await call(routes(), { agentKey: "a", q: "x" }, { "x-pwh": "1", "sec-fetch-site": "cross-site" });
    expect(r.status).toBe(403);
  });

  it("auth failure is the listener's own answer (the route mirrors back, never answers twice)", async () => {
    const r = await call(routes(), { agentKey: "a", q: "x" }, { "x-pwh": "1" }, { user: null });
    expect(r.status).toBe(401); // the io's authorize sent it
    expect(r.body.error).toBe("E_AUTH");
    const audit = log.lines.find((l) => l.msg === "filesearch")!.data as Record<string, unknown>;
    expect(audit["code"]).toBe("E_AUTH"); // mirror-back reaches the audit only
  });

  it("bad agentKey / oversized q / non-integer limit ⇒ 400", async () => {
    expect((await call(routes(), { agentKey: "bad key", q: "x" })).status).toBe(400);
    expect((await call(routes(), { agentKey: "a", q: "x".repeat(257) })).status).toBe(400);
    expect((await call(routes(), { agentKey: "a", q: "x", limit: "abc" })).status).toBe(400);
  });

  it("unknown agent ⇒ 404; agent without session ⇒ 409", async () => {
    const r = await call(routes(null), { agentKey: "a", q: "x" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("E_SESSION_CHANGED");
    const rt = createFileSearchRoutes({ mode: "on", registry: { get: () => undefined }, log, now: () => 0 });
    expect((await call(rt, { agentKey: "a", q: "x" })).status).toBe(404);
  });

  it("cwd '/' or virtual-fs roots are refused before any fs work", async () => {
    expect((await call(routes("/"), { agentKey: "a", q: "x" })).status).toBe(403);
    expect((await call(routes("/proc"), { agentKey: "a", q: "x" })).status).toBe(403);
    expect((await call(routes("relative/path"), { agentKey: "a", q: "x" })).status).toBe(403);
  });

  it("a gone root (realpath fails) ⇒ 404 root-gone", async () => {
    const r = await call(routes(join(root, "nope")), { agentKey: "a", q: "x" });
    expect(r.status).toBe(404);
    expect(r.body.reason).toBe("root-gone");
  });

  it("happy path: results carry path+rel, sorted, limit-sliced, no-store", async () => {
    file("README.md");
    file("src/rea-utils.ts");
    const r = await call(routes(), { agentKey: "a", q: "rea", limit: "1" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.results).toEqual([{ path: join(root, "README.md"), rel: "README.md" }]);
    expect(r.headers["Cache-Control"]).toBe("no-store");
  });

  it("limit defaults to 20 and clamps into 1..50", async () => {
    file("a1.ts");
    const r = await call(routes(), { agentKey: "a", q: "", limit: "999" });
    expect(r.status).toBe(200); // clamped, not rejected
    expect(r.body.results.length).toBe(1);
  });

  it("writes exactly ONE whitelist audit line — never the query, never a path", async () => {
    file("README.md");
    const r = await call(routes(), { agentKey: "ag", q: "README" });
    expect(r.status).toBe(200);
    const lines = log.lines.filter((l) => l.msg === "filesearch");
    expect(lines).toHaveLength(1);
    const data = lines[0]!.data as Record<string, unknown>;
    expect(data["qlen"]).toBe("README".length);
    expect(data["hits"]).toBe(1);
    expect(data["ok"]).toBe(true);
    const logged = JSON.stringify(log.lines);
    expect(logged).not.toContain("README"); // neither the raw query nor any path — qlen only
    expect(Object.keys(data).sort()).toEqual(
      ["agentKey", "audit", "hits", "ip", "listener", "ms", "ok", "partial", "qlen", "scanned"].sort(),
    );
  });

  it("rate limit: capacity 30 then 429 with Retry-After (own bucket)", async () => {
    file("a.ts");
    const rt = routes();
    let last = 200;
    for (let i = 0; i < 35; i += 1) {
      last = (await call(rt, { agentKey: "a", q: "" })).status;
    }
    expect(last).toBe(429);
    const r = await call(rt, { agentKey: "a", q: "" });
    expect(r.headers["Retry-After"]).toBeDefined();
    // 429 audit lines are throttled to one per 60s window (frozen clock ⇒ exactly 1)
    const rateLines = log.lines.filter((l) => (l.data as Record<string, unknown> | undefined)?.["code"] === "E_RATE");
    expect(rateLines).toHaveLength(1);
  });

  it("per-principal in-flight cap ⇒ 503 E_BUSY while a stalled walk holds the slot; the stall itself lands partial-200", async () => {
    file("a.ts");
    // One walk over a tree whose ROOT readdir stalls — the per-step cap (2s) eventually burns
    // out, so the stalled request settles as a partial 200; until then it holds the principal's
    // in-flight slot and the second request is answered 503.
    const rt = createFileSearchRoutes({
      mode: "on",
      registry: registryWith(root),
      log,
      now: () => 0,
      fs: {
        realpath: async (p: string) => p,
        readdir: () => new Promise(() => {}) as never,
      },
    });
    const slowRes: FakeRes[] = [];
    const slows = [0, 1].map(async () => {
      const res = new FakeRes();
      slowRes.push(res);
      resHolder[0] = res;
      await rt.handle(
        fakeReq({ "x-pwh": "1" }),
        res as unknown as ServerResponse,
        qs({ agentKey: "a", q: "" }),
        makeIo(),
      );
    });
    await new Promise((r) => setTimeout(r, 20)); // both stalled walks hold the principal's 2 slots
    const r3 = await call(rt, { agentKey: "a", q: "" });
    expect(r3.status).toBe(503);
    expect(r3.body.error).toBe("E_BUSY");
    await Promise.all(slows);
    for (const res of slowRes) {
      expect(res.status).toBe(200); // per-step cap (2s) burns out ⇒ partial, hits so far
      expect((res.json() as { partial: boolean }).partial).toBe(true);
    }
  });

  it("client disconnect mid-walk: no answer, no throw", async () => {
    let releaseReaddir: (() => void) | undefined;
    const rt = createFileSearchRoutes({
      mode: "on",
      registry: registryWith(root),
      log,
      now: () => 0,
      fs: {
        realpath: async (p: string) => p,
        readdir: () =>
          new Promise((resolve) => {
            releaseReaddir = () => resolve([]);
          }) as never,
      },
    });
    const res = new FakeRes();
    resHolder[0] = res;
    const done = rt.handle(
      fakeReq({ "x-pwh": "1" }),
      res as unknown as ServerResponse,
      qs({ agentKey: "a", q: "" }),
      makeIo(),
    );
    await new Promise((r) => setTimeout(r, 10));
    res.emit("close"); // client went away before writableFinished
    releaseReaddir?.();
    await done;
    expect(res.status).toBe(0); // 不应答
  });
});

describe("FILE_SEARCH constants", () => {
  it("is the documented endpoint (pinned by the UI contract mirror)", () => {
    expect(FILE_SEARCH_PATH).toBe("/api/files/search");
  });
});
