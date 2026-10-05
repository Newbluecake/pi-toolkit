/**
 * web-hub @文件补全 — the hub search endpoint (`GET /api/files/search?agentKey=&q=&limit=`).
 *
 * Backs the web composer's file mention zone (the TUI's `@` cwd-file completion, web-hub
 * edition): recursive filename fuzzy matching (subsequence, scored) inside the session's cwd.
 *
 * Security posture deliberately rides the content-preview line (plan v3 §4.3/§4.7 precedents):
 * - root = the agent's LIVE session cwd (registry lookup; unknown agent ⇒ 404, agent without
 *   session ⇒ E_SESSION_CHANGED), `realpath`'d once, never `/`/virtual-fs (steps 1–4 of the
 *   preview cwd-class literal decision, zero fs);
 * - the walk NEVER follows symlinks (a symlinked directory is not descended, a symlinked file
 *   is not offered) — nothing reachable can escape the root, and each collected result is
 *   belt-and-braces re-checked segment-aligned `withinRoot` (reused from `hub/spawn/dirs.ts`);
 * - depth ≤ `FILE_SEARCH_MAX_DEPTH`, dirents visited ≤ `FILE_SEARCH_SCAN_BUDGET`, per-request
 *   wall budget `FILE_SEARCH_TOTAL_MS` via `previewFsStep` (reused — unref'd timers, lazy
 *   initiation, abort-aware), every readdir error (EACCES/ENOENT/…) just skips that directory;
 * - `X-PWH: 1` CSRF + the listener's own `authorize()` BEFORE any fs work (preview §3.1 ①②
 *   order — an unauthenticated cross-origin probe learns nothing);
 * - rate limit on its OWN `CmdLimit` instance (§7-D14 discipline: bucket churn here can never
 *   evict the cmd/upload/preview lines' buckets) + in-flight caps ⇒ 503 E_BUSY;
 * - audit whitelist (this module's own `auditFileSearch`, preview's `audit` discipline): the
 *   single log line carries lengths and counts only — `qlen` (query length) + `hits` (result
 *   count) + `scanned`, NEVER the raw query or any path.
 *
 * Token round-trip rule: a result whose path contains whitespace/quotes/brackets/backtick can
 * never survive the web `@<abs path>` token syntax (the composer inserts `@<path> `, the
 * send-time detector re-tokenizes on the same terminator set), so such paths are skipped here —
 * everything the panel offers is guaranteed re-detectable at send.
 *
 * No dispose(): unlike preview (open fds + single-flight verify tasks), a search holds nothing
 * beyond in-flight readdir promises; the per-request deadline (≤4s) and the res-close abort
 * (server `closeAllConnections()` destroys the response ⇒ walk aborts) bound every shutdown
 * path.
 */

import { readdir, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { canonicalOrigin, parseOrigin } from "../protocol/lan.js";
import { createCmdLimit, type CmdLimit } from "./cmd-limit.js";
import type { HubLog, PreviewRouteIo, RegistryView } from "./ports.js";
import { createReqDeadline } from "./req-deadline.js";
import { isVirtualFsPath } from "./preview/admit.js";
import { isPreviewIoError, previewFsStep } from "./preview/fs.js";
import { withinRoot } from "./spawn/dirs.js";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

export const FILE_SEARCH_PATH = "/api/files/search";

/** Directory names never descended into (the constant skip table — VCS/dependency/build caches). */
export const FILE_SEARCH_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".gradle",
  ".idea",
  ".next",
  ".nuxt",
  ".turbo",
  ".venv",
  ".mypy_cache",
  ".pytest_cache",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "venv",
]);

export const FILE_SEARCH_MAX_DEPTH = 8;
export const FILE_SEARCH_MAX_RESULTS = 50;
export const FILE_SEARCH_DEFAULT_LIMIT = 20;

/** Whole-request wall budget (auth + walk + answer). Typing latency budget: debounce 200ms. */
export const FILE_SEARCH_TOTAL_MS = 4_000;

/** §4.7-style LAN auth reserve: at least this much of the total budget must survive auth. */
export const FILE_SEARCH_AUTH_RESERVE_MS = 2_000;

/** Dirent-visit cap — bounds a pathological tree even with the skip table. */
export const FILE_SEARCH_SCAN_BUDGET = 20_000;

/** Query cap (UTF-16 units); longer queries are E_BAD_REQUEST, never walked against. */
export const FILE_SEARCH_Q_MAX = 256;

/** Token bucket: capacity 30, +1 token / 100ms (typing at a 200ms debounce ⇒ ≤5/s sustained). */
const FILE_SEARCH_BUCKET_CAPACITY = 30;
const FILE_SEARCH_BUCKET_REFILL_MS = 100;

/** In-flight caps (concurrency ⇒ 503 E_BUSY, same class as preview's). */
const FILE_SEARCH_INFLIGHT_PER_PRINCIPAL = 2;
const FILE_SEARCH_INFLIGHT_GLOBAL = 8;

/** §3.1 ③ (preview precedent): `agentKey` must match the registry's key shape. */
const AGENT_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 429-audit throttle (same discipline as preview's RATE_AUDIT_WINDOW_MS). */
const RATE_AUDIT_WINDOW_MS = 60_000;

export const FILE_SEARCH_STATUS: Readonly<Record<string, number>> = {
  E_BAD_REQUEST: 400,
  E_AUTH: 401,
  E_CSRF: 403,
  E_PREVIEW_DENIED: 403,
  E_NOT_FOUND: 404,
  E_SESSION_CHANGED: 409,
  E_RATE: 429,
  E_INTERNAL: 500,
  E_BUSY: 503,
  E_DEADLINE: 504,
};

// ---------------------------------------------------------------------------
// pure matching
// ---------------------------------------------------------------------------

/**
 * Case-insensitive subsequence match of `query` against `name` (the file BASENAME), scored —
 * lower is better, `undefined` = no match. Scoring shape follows pi-tui's `fuzzyMatch` in
 * spirit (consecutive-run and word-boundary bonuses, gap and position penalties, exact-match
 * bonus) so "rea" ranks `README.md` over `stream-parser.ts`.
 */
export function subsequenceScore(rawQuery: string, rawName: string): number | undefined {
  const query = rawQuery.toLowerCase();
  const name = rawName.toLowerCase();
  if (query.length === 0) return 0;
  if (query.length > name.length) return undefined;
  let qi = 0;
  let last = -2;
  let score = 0;
  let run = 0;
  for (let i = 0; i < name.length && qi < query.length; i += 1) {
    if (name[i] !== query[qi]) continue;
    const boundary = i === 0 || /[-_.\s/]/.test(name[i - 1] ?? "");
    if (last === i - 1) {
      run += 1;
      score -= run * 4;
    } else {
      run = 0;
      if (last >= 0) score += (i - last - 1) * 2;
    }
    if (boundary) score -= 8;
    if (i === 0) score -= 12; // the name STARTS with the query's first matched char
    score += i * 0.05;
    last = i;
    qi += 1;
  }
  if (qi < query.length) return undefined;
  if (query === name) score -= 50;
  return score;
}

/** Result paths that cannot round-trip the `@<abs path>` token syntax are never offered. */
const TOKEN_UNSAFE_RE = /[\s"'`()[\]{}<>]/;

// ---------------------------------------------------------------------------
// injectable fs surface (the ONLY disk boundary; fakes for tests)
// ---------------------------------------------------------------------------

export interface DirentLike {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface FileSearchFs {
  realpath(p: string): Promise<string>;
  readdir(dir: string): Promise<readonly DirentLike[]>;
}

export function defaultFileSearchFs(): FileSearchFs {
  return {
    realpath: (p) => realpath(p),
    readdir: async (dir) => {
      const out = await readdir(dir, { withFileTypes: true });
      return out as unknown as readonly DirentLike[];
    },
  };
}

// ---------------------------------------------------------------------------
// the walk (pure over an injected fs; every readdir budget/abort-aware via previewFsStep)
// ---------------------------------------------------------------------------

export interface FileHit {
  readonly path: string;
  readonly rel: string;
}

export interface WalkOutcome {
  readonly hits: readonly FileHit[];
  readonly scanned: number;
  /** true when the scan/deadline budget ran out before the tree was exhausted. */
  readonly partial: boolean;
}

/**
 * Breadth-first, lexicographically-sorted-per-directory walk (deterministic regardless of fs
 * order): depth ≤ `FILE_SEARCH_MAX_DEPTH`, skip table, symlinks never followed, scan budget,
 * deadline/abort via `previewFsStep`. Every hit passes the subsequence score against its
 * BASENAME and the token round-trip guard; hits come back sorted (score asc, then rel asc) but
 * NOT limited — the caller slices. An empty `query` scores 0 for every file (deterministic
 * name order — the UI never asks, but a bare browse must still be sane).
 */
export async function walkFileSearch(
  rootReal: string,
  query: string,
  fs: FileSearchFs,
  deadline: ReqDeadlineLike,
  signal: AbortSignal,
  opts: { now(): number; stepCapMs?: number },
): Promise<WalkOutcome> {
  const step = <T>(lazy: () => Promise<T>): Promise<T> =>
    previewFsStep(lazy, deadline, signal, {
      now: opts.now,
      ...(opts.stepCapMs === undefined ? {} : { stepCapMs: opts.stepCapMs }),
    });

  interface Candidate extends FileHit {
    readonly score: number;
  }
  const candidates: Candidate[] = [];
  let scanned = 0;
  let partial = false;

  interface Frame {
    readonly dir: string;
    readonly depth: number;
  }
  const queue: Frame[] = [{ dir: rootReal, depth: 0 }];

  while (queue.length > 0) {
    const frame = queue.shift()!;
    let entries: readonly DirentLike[];
    try {
      entries = await step(() => fs.readdir(frame.dir));
    } catch (err) {
      if (isPreviewIoError(err)) {
        if (err.ioFail === "abort") throw err; // caller aborted — propagate (不应答)
        partial = true; // deadline: stop walking, answer with what we have
        queue.length = 0;
        break;
      }
      continue; // unreadable/gone directory ⇒ it simply matches nothing
    }
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of sorted) {
      scanned += 1;
      if (scanned > FILE_SEARCH_SCAN_BUDGET) {
        partial = true;
        queue.length = 0;
        break;
      }
      if (e.isSymbolicLink()) continue; // never followed — dirs AND files (escape-proof)
      if (e.isDirectory()) {
        if (frame.depth < FILE_SEARCH_MAX_DEPTH && !FILE_SEARCH_SKIP_DIRS.has(e.name)) {
          queue.push({ dir: `${frame.dir}/${e.name}`, depth: frame.depth + 1 });
        }
        continue;
      }
      if (!e.isFile()) continue;
      const score = subsequenceScore(query, e.name);
      if (score === undefined) continue;
      const path = `${frame.dir}/${e.name}`;
      if (TOKEN_UNSAFE_RE.test(path)) continue; // cannot round-trip the @token syntax
      if (!withinRoot(rootReal, path)) continue; // belt-and-braces (walk is in-root by construction)
      candidates.push({ path, rel: path.slice(rootReal.length + 1), score });
    }
  }

  candidates.sort((a, b) => (a.score !== b.score ? a.score - b.score : a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { hits: candidates, scanned, partial };
}

// `previewFsStep`'s own structural deadline shape (avoids importing `req-deadline` here just
// for a type the step function never uses beyond `remaining()`).
interface ReqDeadlineLike {
  remaining(): number;
}

// ---------------------------------------------------------------------------
// audit (preview's whitelist discipline, scoped to this module)
// ---------------------------------------------------------------------------

interface FileSearchAuditRecord {
  listener: "loopback" | "lan";
  ip: string;
  user?: string | undefined;
  agentKey?: string | undefined;
  ok: boolean;
  code?: string | undefined;
  reason?: string | undefined;
  qlen?: number | undefined;
  hits?: number | undefined;
  scanned?: number | undefined;
  partial?: boolean | undefined;
  ms?: number | undefined;
}

/** Runtime whitelist — anything not listed here is dropped, even if passed. */
const FILE_SEARCH_AUDIT_KEYS = [
  "listener",
  "ip",
  "user",
  "agentKey",
  "ok",
  "code",
  "reason",
  "qlen",
  "hits",
  "scanned",
  "partial",
  "ms",
] as const;

function auditFileSearch(log: HubLog, record: FileSearchAuditRecord): void {
  const out: Record<string, unknown> = { audit: "filesearch" };
  const raw = record as unknown as Record<string, unknown>;
  for (const key of FILE_SEARCH_AUDIT_KEYS) {
    const v = raw[key];
    if (v !== undefined) out[key] = v;
  }
  log.info("filesearch", out);
}

// ---------------------------------------------------------------------------
// the route frontend
// ---------------------------------------------------------------------------

export interface FileSearchRoutesDeps {
  mode: "on" | "loopback";
  registry: Pick<RegistryView, "get">;
  log: HubLog;
  now(): number;
  /** §7-D14: own limiter — absent ⇒ a private `createCmdLimit` instance is created here. */
  limit?: CmdLimit | undefined;
  fs?: Partial<FileSearchFs>;
}

/** The frontend surface `createHttpFrontend` carries (declared in `hub/ports.ts`). */
export interface FileSearchRoutes {
  readonly mode: "on" | "loopback";
  handle(req: IncomingMessage, res: ServerResponse, query: URLSearchParams, io: PreviewRouteIo): Promise<void>;
}

/** §3.1 ① CSRF — the preview discipline verbatim (X-PWH mandatory, Sec-Fetch-Site/Origin when present). */
function fileSearchCsrfOk(req: IncomingMessage, expectedOrigin: string): boolean {
  if (req.headers["x-pwh"] !== "1") return false;
  const sfs = req.headers["sec-fetch-site"];
  if (typeof sfs === "string" && sfs.toLowerCase() !== "same-origin") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const parsed = parseOrigin(origin);
  if (parsed === undefined) return false;
  return canonicalOrigin(parsed.scheme, parsed.hostKey) === expectedOrigin;
}

export function createFileSearchRoutes(deps: FileSearchRoutesDeps): FileSearchRoutes {
  const { mode, registry, log, now } = deps;
  const rateLimiter: CmdLimit = deps.limit ?? createCmdLimit(now);
  const fs: FileSearchFs = { ...defaultFileSearchFs(), ...deps.fs };

  const inflightByPrincipal = new Map<string, number>();
  let inflightGlobal = 0;
  const rateAuditedAt = new Map<string, number>();

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    query: URLSearchParams,
    io: PreviewRouteIo,
  ): Promise<void> {
    const ctl = new AbortController();
    const signal = ctl.signal;
    res.once("close", () => {
      if (!res.writableFinished) ctl.abort("client-abort");
    });
    const startedAt = now();
    const acc: FileSearchAuditRecord = { listener: io.listener, ip: io.ip, ok: false };
    let slotTaken = false;
    let principal = "";
    let skipAudit = false;

    const send = (code: string, body: unknown, headers?: Record<string, string>): void => {
      const status = FILE_SEARCH_STATUS[code] ?? 500;
      io.sendJson(res, status, body, headers);
    };

    try {
      // ① CSRF — BEFORE auth (an unauthenticated cross-origin probe learns nothing).
      if (!fileSearchCsrfOk(req, io.expectedOrigin)) {
        acc.code = "E_CSRF";
        send("E_CSRF", { error: "E_CSRF" });
        return;
      }

      // ② auth — the listener's own gate; on failure it has already answered itself.
      const r = createReqDeadline(now, FILE_SEARCH_TOTAL_MS);
      const authed = await io.authorize(r);
      if ("handled" in authed) {
        acc.code = authed.code;
        return;
      }
      acc.user = authed.user;
      principal = `${io.listener}:${authed.user ?? "token"}`;

      // ③ params
      const agentKey = query.get("agentKey") ?? "";
      const q = query.get("q") ?? "";
      const limitRaw = query.get("limit");
      let limit = FILE_SEARCH_DEFAULT_LIMIT;
      if (limitRaw !== null && limitRaw !== "") {
        const n = Number(limitRaw);
        if (!Number.isInteger(n)) {
          acc.code = "E_BAD_REQUEST";
          send("E_BAD_REQUEST", { error: "E_BAD_REQUEST", reason: "limit" });
          return;
        }
        limit = Math.max(1, Math.min(FILE_SEARCH_MAX_RESULTS, n));
      }
      if (!AGENT_KEY_RE.test(agentKey) || q.length > FILE_SEARCH_Q_MAX) {
        acc.code = "E_BAD_REQUEST";
        send("E_BAD_REQUEST", { error: "E_BAD_REQUEST" });
        return;
      }
      acc.agentKey = agentKey;
      acc.qlen = q.length;

      // ④ rate limit + in-flight caps
      const admitted = rateLimiter.admit(
        `${principal}:filesearch`,
        FILE_SEARCH_BUCKET_CAPACITY,
        FILE_SEARCH_BUCKET_REFILL_MS,
      );
      if (!admitted.ok) {
        const t = now();
        const last = rateAuditedAt.get(principal);
        if (last !== undefined && t - last < RATE_AUDIT_WINDOW_MS) skipAudit = true;
        else rateAuditedAt.set(principal, t);
        acc.code = "E_RATE";
        send(
          "E_RATE",
          { error: "E_RATE" },
          { "Retry-After": String(Math.max(1, Math.ceil(admitted.retryAfterMs / 1000))) },
        );
        return;
      }
      const mine = inflightByPrincipal.get(principal) ?? 0;
      if (mine >= FILE_SEARCH_INFLIGHT_PER_PRINCIPAL || inflightGlobal >= FILE_SEARCH_INFLIGHT_GLOBAL) {
        acc.code = "E_BUSY";
        acc.reason = "inflight";
        send("E_BUSY", { error: "E_BUSY" }, { "Retry-After": "1" });
        return;
      }
      slotTaken = true;
      inflightByPrincipal.set(principal, mine + 1);
      inflightGlobal += 1;

      // ⑤ session — the search root is the LIVE session cwd (preview §3.1 ⑤ semantics).
      const view = registry.get(agentKey);
      if (view === undefined) {
        acc.code = "E_NOT_FOUND";
        send("E_NOT_FOUND", { error: "E_NOT_FOUND" });
        return;
      }
      const session = view.session;
      if (session === undefined) {
        acc.code = "E_SESSION_CHANGED";
        send("E_SESSION_CHANGED", { error: "E_SESSION_CHANGED" });
        return;
      }

      // ⑥ literal root decisions (preview §4.3 steps 1–4 — zero fs on a hostile root)
      const cwd = session.cwd;
      if (typeof cwd !== "string" || !cwd.startsWith("/")) {
        acc.code = "E_PREVIEW_DENIED";
        acc.reason = "root-too-broad";
        send("E_PREVIEW_DENIED", { error: "E_PREVIEW_DENIED", reason: "root-too-broad" });
        return;
      }
      const root = cwd.length > 1 && cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
      if (root.length === 0 || root === "/" || isVirtualFsPath(root)) {
        acc.code = "E_PREVIEW_DENIED";
        acc.reason = "root-too-broad";
        send("E_PREVIEW_DENIED", { error: "E_PREVIEW_DENIED", reason: "root-too-broad" });
        return;
      }

      // ⑦ realpath(root) + the bounded walk
      let rootReal: string;
      try {
        rootReal = await previewFsStep(() => fs.realpath(root), r, signal, { now });
      } catch (err) {
        if (signal.aborted || (isPreviewIoError(err) && err.ioFail === "abort")) return; // 不应答
        if (isPreviewIoError(err)) {
          acc.code = "E_DEADLINE";
          send("E_DEADLINE", { error: "E_DEADLINE" });
          return;
        }
        acc.code = "E_NOT_FOUND";
        acc.reason = "root-gone";
        send("E_NOT_FOUND", { error: "E_NOT_FOUND", reason: "root-gone" });
        return;
      }
      if (rootReal === "/" || isVirtualFsPath(rootReal)) {
        acc.code = "E_PREVIEW_DENIED";
        acc.reason = "root-too-broad";
        send("E_PREVIEW_DENIED", { error: "E_PREVIEW_DENIED", reason: "root-too-broad" });
        return;
      }

      let outcome: WalkOutcome;
      try {
        outcome = await walkFileSearch(rootReal, q, fs, r, signal, { now });
      } catch (err) {
        if (signal.aborted || (isPreviewIoError(err) && err.ioFail === "abort")) return; // 不应答
        if (isPreviewIoError(err)) {
          acc.code = "E_DEADLINE";
          send("E_DEADLINE", { error: "E_DEADLINE" });
          return;
        }
        acc.code = "E_INTERNAL";
        log.error("file-search route: walk failed", { error: String(err) });
        send("E_INTERNAL", { error: "E_INTERNAL" });
        return;
      }
      if (signal.aborted) return; // 不应答

      // ⑧ answer — hits already sorted best-first, deterministic tie-break by rel.
      const results = outcome.hits.slice(0, limit).map((h) => ({ path: h.path, rel: h.rel }));
      acc.ok = true;
      acc.hits = results.length;
      acc.scanned = outcome.scanned;
      acc.partial = outcome.partial;
      io.sendJson(res, 200, { ok: true, results, partial: outcome.partial }, { "Cache-Control": "no-store" });
    } catch (err: unknown) {
      // handle() never throws; this belt-and-braces catch still guarantees it.
      acc.code = "E_INTERNAL";
      log.error("file-search route: unexpected pipeline failure", { error: String(err) });
      if (!res.headersSent && !res.destroyed) io.sendJson(res, 500, { error: "E_INTERNAL" });
      else res.destroy();
    } finally {
      if (slotTaken) {
        inflightGlobal = Math.max(0, inflightGlobal - 1);
        const left = (inflightByPrincipal.get(principal) ?? 1) - 1;
        if (left <= 0) inflightByPrincipal.delete(principal);
        else inflightByPrincipal.set(principal, left);
      }
      acc.ms = now() - startedAt;
      if (!skipAudit) auditFileSearch(log, acc);
    }
  }

  return { mode, handle };
}
