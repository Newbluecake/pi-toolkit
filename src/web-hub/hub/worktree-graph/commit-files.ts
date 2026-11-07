/**
 * worktree-graph commit-files (`wtgraph.files.v1`): `GET /api/worktree-graph/files` — one
 * commit's changed files (status + numstat), fetched when the user expands a graph row.
 *
 * Security spine — the graph route's pipeline, reused piece by piece (nothing reimplemented):
 * ⓪ closing → ① CSRF (`wtCsrfOk`) → ② `io.authorize` → ③ params (agentKey/sessionId/wt + `h`,
 * a full-length lowercase-hex oid) → ④ this endpoint's OWN rate bucket + in-flight caps →
 * ⑤ session visibility → ⑥ `createMembership` (the same three-fd pin as wtdiff/graph) →
 * ⑦ **served-window gate**: `h` must be a commit THIS routes instance served in a graph window
 * for the SAME pinned repository (common-dir dev:ino) within `WTGRAPH_SERVED_TTL_MS` — otherwise
 * 409 `E_STALE_CTX{reason:"commit"}` BEFORE any git spawn. That keeps the asset exactly as wide
 * as the graph itself (A1: server-computed, never an arbitrary-history oracle) →
 * S1 shallow stat → Cc driver scan + `info/attributes` read (⇒ the L2 driver set + attribute
 * signature, the M phase's head step) → Gf under `ps.withLoan`, single-flight + cached per commit
 * → post-Gf `info/attributes` recheck (changed ⇒ discard, 503 `E_BUSY{reason:"attr-changed"}`;
 * a value is only stored after the recheck passed) → denylist filter (D14: hidden everywhere,
 * never counted) → byte/entry caps → `sendJson`.
 *
 * Gf — the only new git command — is `log --no-walk --max-count=1 -z --format= --raw --numstat`
 * over the explicit oid, built ONLY by `wtGraphFilesArgs` below. Why `log` and not `diff-tree`:
 * git 2.53's `diff-tree` reads the index and, through `reuse_worktree_file`, READS WORK-TREE
 * FILES whose stat matches the index (measured with strace) — `log` loads no index, so with
 * `--ignore-submodules=none` (no `.gitmodules`/index lookup) it never touches the work tree or
 * the index, the graph's standing rule. It reads commit/tree/blob objects (numstat + rename
 * detection), so it carries Gm's neutralization: L1 empty-tree `--attr-source` +
 * `core.attributesFile=/dev/null`, L2 every known driver blanked, `diff.external=`,
 * `--no-textconv --no-ext-diff`, fixed `core.bigFileThreshold`, `-O/dev/null` (no
 * `diff.orderFile` read), `--no-lazy-fetch` (a promisor repo never fetches missing blobs).
 *
 * Merge semantics (fixed): `--diff-merges=first-parent` — a merge commit lists what it brought
 * onto its FIRST parent; a root commit (and a shallow boundary commit) diffs against the empty
 * tree (`log.showRoot=true` pinned).
 *
 * Cache: commit content is immutable, so the PARSED entries (never raw stdout) are cached per
 * `(repo identity, oid, attribute signature)` — TTL 10 min, LRU, total/per-item byte bounds.
 * The denylist is applied AFTER the cache, per request.
 */

import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { classifyGraphExit, wtGraphArgs } from "../../../git/graph.js";
import {
  WTDIFF_DRIVER_NAME_RE,
  WT_PINNED_PREFIX,
  attrSourceArgs,
  driverNamesFromAttributes,
  neutralizeArgs,
  parseDriverScan,
} from "../../../git/diff.js";
import type { GitRunner } from "../../../git/run.js";
import { normalizePreviewPath, validatePreviewPath } from "../../protocol/preview.js";
import {
  WTGRAPH_FILES_BODY_MAX_BYTES,
  WTGRAPH_FILES_CMD_MS,
  WTGRAPH_FILES_GIT_PHASE_MS,
  WTGRAPH_FILES_LOG_MAX_BYTES,
  WTGRAPH_FILES_MAX,
  WTGRAPH_FILES_QUERY,
  WTGRAPH_PATH_MAX_BYTES,
  type WtGraphCommitFiles,
  type WtGraphFileEntry,
  type WtGraphFileStatus,
} from "../../protocol/worktree-graph.js";
import { WTDIFF_ADMIT_MS, WTDIFF_DRIVERS_MAX, WTDIFF_STEP_MS } from "../../protocol/worktree-diff.js";
import { auditWorktreeGraph, type WtGraphAuditRecord } from "../audit.js";
import type { CmdLimit } from "../cmd-limit.js";
import type { HubLog, PreviewRouteIo, RegistryView } from "../ports.js";
import { createReqDeadline, type ReqDeadline } from "../req-deadline.js";
import { denyListHit, type PreviewDenyContext, type PreviewFs } from "../preview/admit.js";
import { isPreviewIoError, previewFsStep, type PreviewIoTracker } from "../preview/fs.js";
import { SingleFlightCache } from "../worktree-diff/changeset.js";
import type { createMembership } from "../worktree-diff/membership.js";
import { wtCsrfOk } from "../worktree-diff/routes.js";
import { attrSigOf, createPinnedGit, readProcFdFile, type PinSet } from "../worktree-diff/git.js";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const FILES_BUCKET_CAPACITY = 20;
const FILES_BUCKET_REFILL_MS = 250;
/** Row switching aborts the previous fetch client-side; 2 tolerates the hub-side tail. */
const FILES_INFLIGHT_PER_PRINCIPAL = 2;
const FILES_INFLIGHT_GLOBAL = 4;
const RATE_AUDIT_WINDOW_MS = 60_000;
/** Cc stdout / info/attributes bounds — the same numbers as wtdiff's and the M phase's. */
const DRIVER_SCAN_MAX_BYTES = 64 * 1024;
const INFO_ATTRS_MAX_BYTES = 64 * 1024;
/** Gf's fixed `core.bigFileThreshold` (git's default; pinned so config cannot move binary verdicts). */
const FILES_BIG_FILE_THRESHOLD = "512m";
/** Gf's fixed rename-detection limit (git's default; pinned so config cannot raise the cost). */
const FILES_RENAME_LIMIT = "1000";

/** Served-window gate bounds: an oid stays requestable this long after the graph last served it. */
export const WTGRAPH_SERVED_TTL_MS = 30 * 60_000;
/** Per repository: the newest this-many served oids (20 windows of 200). */
export const WTGRAPH_SERVED_PER_REPO_MAX = 4_000;
/** Repositories remembered (LRU). */
export const WTGRAPH_SERVED_REPOS_MAX = 64;

/** Per-commit cache bounds: commit content is immutable, the attribute signature keys the rest. */
export const WTGRAPH_FILES_CACHE_TTL_MS = 10 * 60_000;
export const WTGRAPH_FILES_CACHE_LRU = 256;
export const WTGRAPH_FILES_CACHE_BYTES = 4 * 1024 * 1024;
export const WTGRAPH_FILES_CACHE_ITEM_BYTES = 512 * 1024;

const AGENT_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID_RE = /^[\x21-\x7e]{1,128}$/;
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const WTGRAPH_FILES_STATUS: Readonly<Record<string, number>> = {
  E_BAD_REQUEST: 400,
  E_CSRF: 403,
  E_WTDIFF_DENIED: 403,
  E_NOT_FOUND: 404,
  E_SESSION_CHANGED: 409,
  E_STALE_CTX: 409,
  E_WTDIFF_UNSUPPORTED: 503, // filter-config answers 415 (see the catch below)
  E_RATE: 429,
  E_INTERNAL: 500,
  E_BUSY: 503,
  E_HUB_RESTARTING: 503,
  E_DEADLINE: 504,
};

// ---------------------------------------------------------------------------
// Gf argv (frozen) + parser — pure
// ---------------------------------------------------------------------------

/**
 * Gf — the commit-files command. `h` must be full-length lowercase hex for `format` and every
 * driver name must satisfy `WTDIFF_DRIVER_NAME_RE`; anything else THROWS (caller bug — fail
 * closed). The oid is the only request-derived value and sits before the `--` terminator.
 */
export function wtGraphFilesArgs(h: string, format: "sha1" | "sha256", drivers: readonly string[]): string[] {
  const hexRe = format === "sha1" ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
  if (!hexRe.test(h)) throw new Error("wtGraphFilesArgs: h is not a full-length lowercase hex oid");
  for (const name of drivers) {
    if (!WTDIFF_DRIVER_NAME_RE.test(name)) throw new Error("wtGraphFilesArgs: unsafe driver name");
  }
  return [
    ...WT_PINNED_PREFIX,
    "--no-lazy-fetch",
    "--no-replace-objects",
    "--no-pager",
    "-c",
    "core.hooksPath=/dev/null",
    ...attrSourceArgs(format),
    ...neutralizeArgs(drivers),
    "-c",
    "diff.external=",
    "-c",
    `core.bigFileThreshold=${FILES_BIG_FILE_THRESHOLD}`,
    "-c",
    `diff.renameLimit=${FILES_RENAME_LIMIT}`,
    "-c",
    "log.showRoot=true",
    "-c",
    "log.showSignature=false",
    "-c",
    "log.mailmap=false",
    "log",
    "--no-walk",
    "--max-count=1",
    "--no-show-signature",
    "--no-use-mailmap",
    "--no-notes",
    "--no-decorate",
    "--no-color",
    "--no-relative",
    "-z",
    "--format=",
    "--raw",
    "--numstat",
    "-M",
    "-O/dev/null",
    "--diff-merges=first-parent",
    "--ignore-submodules=none",
    "--no-textconv",
    "--no-ext-diff",
    h,
    "--",
  ];
}

/** One parsed Gf pair (pre-denylist, pre-cap). */
export interface CommitFileRaw {
  path: string;
  orig?: string;
  status: WtGraphFileStatus;
  add?: number;
  del?: number;
  binary?: true;
}

export interface CommitFilesParsed {
  entries: CommitFileRaw[];
  /** stdout was cut (the partial tail dropped) — counts may be missing, the list a lower bound. */
  capped: boolean;
}

const NUMSTAT_RE = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/;

function statusOf(letter: string): WtGraphFileStatus {
  if (letter === "A" || letter === "D" || letter === "M" || letter === "R" || letter === "T") return letter;
  if (letter === "C") return "A"; // never produced without -C; a copy's post-image is new
  // Unknown/unmodelled letters (a future git status class) deliberately fail-safe to "M": a
  // wrong-but-renderable badge (modified) beats dropping the entry — counts and total stay whole.
  return "M";
}

/**
 * Parse Gf's `-z --raw --numstat` stream (git 2.53, verified): ALL raw records first —
 * `:<sm> <dm> <ss> <ds> <X[score]>` NUL `<path>` NUL (R/C: `<orig>` NUL `<path>` NUL) — then ALL
 * numstat records — `<add>\t<del>\t<path>` NUL, renames `<add>\t<del>\t` NUL `<orig>` NUL `<path>`
 * NUL, binary `-\t-`. Numstat attaches to raw pairs POSITIONALLY and only while the post-image
 * paths agree (a mismatch stops attaching — counts stay absent, never misattributed). Paths
 * longer than `WTGRAPH_PATH_MAX_BYTES` are dropped. Never throws.
 */
export function parseCommitFilesZ(stdout: string, capped: boolean): CommitFilesParsed {
  const tokens = stdout.split("\0");
  if (capped) tokens.pop(); // a cut stream's tail is a partial token
  const entries: CommitFileRaw[] = [];
  const raws: CommitFileRaw[] = [];
  let ni = 0;
  let attaching = true;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "") continue;
    if (token.startsWith(":")) {
      const fields = token.split(" ");
      const st = fields[4];
      if (fields.length < 5 || st === undefined || st === "") continue;
      const letter = st[0]!;
      if (letter === "R" || letter === "C") {
        const orig = tokens[i + 1];
        const path = tokens[i + 2];
        i += 2;
        if (orig === undefined || path === undefined || orig === "" || path === "") continue;
        const e: CommitFileRaw = { path, status: statusOf(letter) };
        if (letter === "R") e.orig = orig;
        raws.push(e);
      } else {
        const path = tokens[i + 1];
        i += 1;
        if (path === undefined || path === "") continue;
        raws.push({ path, status: statusOf(letter) });
      }
      continue;
    }
    const m = token.match(NUMSTAT_RE);
    if (m === null) continue;
    let path = m[3]!;
    if (path === "") {
      const newPath = tokens[i + 2];
      i += 2;
      if (newPath === undefined) continue;
      path = newPath;
    }
    const target = raws[ni];
    ni += 1;
    if (!attaching || target === undefined || target.path !== path) {
      attaching = false;
      continue;
    }
    if (m[1] === "-" || m[2] === "-") target.binary = true;
    else {
      target.add = Number(m[1]);
      target.del = Number(m[2]);
    }
  }
  for (const e of raws) {
    if (Buffer.byteLength(e.path, "utf8") > WTGRAPH_PATH_MAX_BYTES) continue;
    if (e.orig !== undefined && Buffer.byteLength(e.orig, "utf8") > WTGRAPH_PATH_MAX_BYTES) continue;
    entries.push(e);
  }
  return { entries, capped };
}

/**
 * Wire projection: denylist filter (hidden, never counted), entry cap, then the complete-body
 * byte cap (drop from the tail). Pure — `hidden(path)` is the caller's denylist predicate.
 */
export function projectCommitFiles(
  h: string,
  parsed: CommitFilesParsed,
  hidden: (path: string) => boolean,
  shallow: boolean,
  maxBytes: number = WTGRAPH_FILES_BODY_MAX_BYTES,
): WtGraphCommitFiles {
  const visible: WtGraphFileEntry[] = [];
  for (const e of parsed.entries) {
    if (hidden(e.path) || (e.orig !== undefined && hidden(e.orig))) continue;
    const w: WtGraphFileEntry = { path: e.path, status: e.status };
    if (e.orig !== undefined) w.orig = e.orig;
    if (e.binary === true) w.binary = true;
    else if (e.add !== undefined && e.del !== undefined) {
      w.add = e.add;
      w.del = e.del;
    }
    visible.push(w);
  }
  const total = visible.length;
  let entries = visible.slice(0, WTGRAPH_FILES_MAX);
  const limits = { files: visible.length > WTGRAPH_FILES_MAX, bytes: false, output: parsed.capped };
  const build = (): WtGraphCommitFiles => ({
    v: 1,
    h,
    entries,
    total,
    truncated: entries.length < total || limits.output,
    limits: { ...limits },
    ...(shallow ? { shallow: true as const } : {}),
  });
  let out = build();
  if (Buffer.byteLength(JSON.stringify(out), "utf8") <= maxBytes) return out;
  // over the cap: binary-search the longest prefix that fits
  limits.bytes = true;
  let lo = 0;
  let hi = entries.length;
  const all = entries;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    entries = all.slice(0, mid);
    if (Buffer.byteLength(JSON.stringify(build()), "utf8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  entries = all.slice(0, lo);
  out = build();
  return out;
}

// ---------------------------------------------------------------------------
// the served-window gate
// ---------------------------------------------------------------------------

/** Commits the graph route served, per pinned repository identity. One instance per routes. */
export class ServedCommitWindows {
  private readonly repos = new Map<string, Map<string, number>>();

  constructor(
    private readonly opts: { ttlMs: number; perRepoMax: number; reposMax: number } = {
      ttlMs: WTGRAPH_SERVED_TTL_MS,
      perRepoMax: WTGRAPH_SERVED_PER_REPO_MAX,
      reposMax: WTGRAPH_SERVED_REPOS_MAX,
    },
  ) {}

  record(repoKey: string, oids: readonly string[], now: number): void {
    let m = this.repos.get(repoKey);
    if (m !== undefined) this.repos.delete(repoKey);
    else m = new Map();
    for (const oid of oids) {
      m.delete(oid);
      m.set(oid, now);
    }
    while (m.size > this.opts.perRepoMax) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
    this.repos.set(repoKey, m);
    while (this.repos.size > this.opts.reposMax) {
      const oldest = this.repos.keys().next().value;
      if (oldest === undefined) break;
      this.repos.delete(oldest);
    }
  }

  has(repoKey: string, oid: string, now: number): boolean {
    const at = this.repos.get(repoKey)?.get(oid);
    return at !== undefined && now - at <= this.opts.ttlMs;
  }

  clear(): void {
    this.repos.clear();
  }
}

/** The served-window / cache repository identity: the pinned common dir's dev:ino. */
export function repoKeyOf(ids: PinSet["ids"]): string {
  return `${ids.common.dev}:${ids.common.ino}`;
}

// ---------------------------------------------------------------------------
// typed pipeline errors
// ---------------------------------------------------------------------------

class FilesAbort extends Error {}
class FilesError extends Error {
  constructor(
    readonly code: string,
    readonly reason?: string,
  ) {
    super(reason ?? code);
  }
}

// ---------------------------------------------------------------------------
// the route
// ---------------------------------------------------------------------------

export interface CommitFilesRouteDeps {
  denyCtx: PreviewDenyContext;
  registry: Pick<RegistryView, "get">;
  run: GitRunner;
  log: HubLog;
  now(): number;
  limit: CmdLimit;
  fs: PreviewFs;
  tracker: PreviewIoTracker;
  membership: ReturnType<typeof createMembership>;
  served: ServedCommitWindows;
}

export interface CommitFilesRoute {
  handle(req: IncomingMessage, res: ServerResponse, query: URLSearchParams, io: PreviewRouteIo): Promise<void>;
  /** Stop admitting, abort every active request + shared execution, wait ≤ `waitMs`. */
  dispose(waitMs: number): Promise<void>;
}

interface FilesValue {
  parsed: CommitFilesParsed;
}

interface ActiveRequest {
  readonly ctl: AbortController;
  done: Promise<void>;
}

function unrefDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    t.unref();
  });
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new FilesAbort());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new FilesAbort());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export function createCommitFilesRoute(deps: CommitFilesRouteDeps): CommitFilesRoute {
  const { registry, run, log, now, limit, fs, tracker, membership, served } = deps;
  const cache = new SingleFlightCache<FilesValue>({
    ttlMs: WTGRAPH_FILES_CACHE_TTL_MS,
    lruMax: WTGRAPH_FILES_CACHE_LRU,
    totalBytes: WTGRAPH_FILES_CACHE_BYTES,
    itemMaxBytes: WTGRAPH_FILES_CACHE_ITEM_BYTES,
    store: true,
    now,
  });
  let closing = false;
  let disposePromise: Promise<void> | undefined;
  const active = new Set<ActiveRequest>();
  const inflightByPrincipal = new Map<string, number>();
  let inflightGlobal = 0;
  const rateAuditedAt = new Map<string, number>();
  const pathKey = randomBytes(16);
  const tagOf = (s: string): string => createHmac("sha256", pathKey).update(s).digest("hex").slice(0, 12);

  async function serve(
    req: IncomingMessage,
    res: ServerResponse,
    query: URLSearchParams,
    io: PreviewRouteIo,
  ): Promise<void> {
    const ctl = new AbortController();
    const signal = ctl.signal;
    const entry: ActiveRequest = { ctl, done: Promise.resolve() };
    active.add(entry);
    res.once("close", () => {
      if (!res.writableFinished) ctl.abort("client-abort");
    });
    const startedAt = now();
    const acc: Record<string, unknown> = { phase: "files", listener: io.listener, ip: io.ip, ok: false };
    let slotTaken = false;
    let principal = "";
    let pinSet: PinSet | undefined;
    let skipAudit = false;

    const send = (code: string, body: Record<string, unknown>, headers?: Record<string, string>): void => {
      acc.code = code;
      if (typeof body.reason === "string") acc.reason = body.reason;
      io.sendJson(res, WTGRAPH_FILES_STATUS[code] ?? 500, body, headers);
    };
    const abortAnswer = (): void => {
      acc.code = "E_ABORT";
      acc.reason = signal.reason === "hub-close" ? "hub-close" : "client-abort";
      if (signal.reason === "hub-close" && !res.headersSent) {
        io.sendJson(res, 503, { error: "E_HUB_RESTARTING" });
      }
    };

    entry.done = (async (): Promise<void> => {
      if (closing) {
        send("E_HUB_RESTARTING", { error: "E_HUB_RESTARTING" });
        return;
      }
      if (!wtCsrfOk(req, io.expectedOrigin)) {
        send("E_CSRF", { error: "E_CSRF" });
        return;
      }
      const A = createReqDeadline(now, WTDIFF_ADMIT_MS);
      const authed = await io.authorize(A);
      if ("handled" in authed) {
        acc.code = authed.code;
        return;
      }
      acc.user = authed.user;
      principal = `${io.listener}:${authed.user ?? "token"}`;

      const agentKey = query.get("agentKey") ?? "";
      const sessionId = query.get("sessionId") ?? "";
      const wt = normalizePreviewPath(query.get("wt") ?? "");
      const h = query.get(WTGRAPH_FILES_QUERY) ?? "";
      if (
        !AGENT_KEY_RE.test(agentKey) ||
        !SESSION_ID_RE.test(sessionId) ||
        !validatePreviewPath(wt, { minSegments: 1 }) ||
        !OID_RE.test(h)
      ) {
        send("E_BAD_REQUEST", { error: "E_BAD_REQUEST" });
        return;
      }
      acc.agentKey = agentKey;

      const admitted = limit.admit(`${principal}:wtgraph-files`, FILES_BUCKET_CAPACITY, FILES_BUCKET_REFILL_MS);
      if (!admitted.ok) {
        const key = `wtgraph-files:${principal}`;
        const t = now();
        const last = rateAuditedAt.get(key);
        if (last !== undefined && t - last < RATE_AUDIT_WINDOW_MS) skipAudit = true;
        else rateAuditedAt.set(key, t);
        send(
          "E_RATE",
          { error: "E_RATE" },
          { "Retry-After": String(Math.max(1, Math.ceil(admitted.retryAfterMs / 1000))) },
        );
        return;
      }
      const mine = inflightByPrincipal.get(principal) ?? 0;
      if (mine >= FILES_INFLIGHT_PER_PRINCIPAL || inflightGlobal >= FILES_INFLIGHT_GLOBAL) {
        send("E_BUSY", { error: "E_BUSY", reason: "inflight" }, { "Retry-After": "1" });
        return;
      }
      slotTaken = true;
      inflightByPrincipal.set(principal, mine + 1);
      inflightGlobal += 1;

      try {
        const view = registry.get(agentKey);
        if (view === undefined) throw new FilesError("E_NOT_FOUND");
        const session = view.session;
        if (session === undefined || session.sessionId !== sessionId) throw new FilesError("E_SESSION_CHANGED");

        const m = await membership({ cwd: session.cwd, wtReq: wt, deadline: A, signal });
        if (!m.ok) {
          if (m.kind === "abort") throw new FilesAbort();
          if (m.kind === "git-unavailable") throw new FilesError("E_WTDIFF_UNSUPPORTED", "git-unavailable");
          if (m.kind === "deadline") throw new FilesError("E_DEADLINE");
          if (m.kind === "busy") throw new FilesError("E_BUSY", "fs");
          throw new FilesError("E_WTDIFF_DENIED", m.reason);
        }
        const ps = m.pinSet;
        pinSet = ps;
        const W = m.W;
        acc.wtTag = tagOf(W);
        const repoKey = repoKeyOf(ps.ids);

        // ⑦ served-window gate — BEFORE any git-phase spawn
        if (!served.has(repoKey, h, now())) throw new FilesError("E_STALE_CTX", "commit");

        const G = createReqDeadline(now, WTGRAPH_FILES_GIT_PHASE_MS);
        const pinned = createPinnedGit({ run, pinSet: ps, fs, tracker, log, now });
        const ioDeps = { tracker, now };
        const commonFd = ps.pins.common.fd;
        const format: "sha1" | "sha256" = h.length === 40 ? "sha1" : "sha256";

        // S1: shallow stat (no spawn)
        let shallow = false;
        try {
          await previewFsStep(() => fs.stat(`/proc/self/fd/${commonFd}/shallow`), G, signal, {
            now,
            tracker,
            stepCapMs: WTDIFF_STEP_MS,
          });
          shallow = true;
        } catch (err) {
          if (isPreviewIoError(err)) {
            if (err.ioFail === "abort") throw new FilesAbort();
            if (err.ioFail === "busy") throw new FilesError("E_BUSY", "fs");
            throw new FilesError("E_DEADLINE");
          }
        }

        // Cc + info/attributes ⇒ the L2 driver set and the attribute signature
        const cc = await pinned.run("Cc", wtGraphArgs.driverScan(), {
          deadline: G,
          signal,
          capMs: WTDIFF_STEP_MS,
          maxStdoutBytes: DRIVER_SCAN_MAX_BYTES,
        });
        if (!cc.ok) {
          if (cc.kind === "abort") throw new FilesAbort();
          if (cc.kind === "deadline") throw new FilesError("E_DEADLINE");
          if (cc.kind === "busy") throw new FilesError("E_BUSY", "fs");
          if (cc.kind === "git-unavailable") throw new FilesError("E_WTDIFF_UNSUPPORTED", "git-unavailable");
          throw new FilesError("E_INTERNAL");
        }
        if (cc.code === 129) throw new FilesError("E_WTDIFF_UNSUPPORTED", "git-too-old");
        if (cc.code !== 0 && cc.code !== 1) throw new FilesError("E_INTERNAL", "git-failed");
        const scan = parseDriverScan(cc.stdout, cc.capped);
        if ("unsafe" in scan) throw new FilesError("E_WTDIFF_UNSUPPORTED", "filter-config");
        const readInfo = async (deadline: ReqDeadline, sig: AbortSignal): Promise<Buffer> => {
          const r = await readProcFdFile(
            fs,
            ioDeps,
            `/proc/self/fd/${commonFd}/info/attributes`,
            INFO_ATTRS_MAX_BYTES,
            deadline,
            sig,
          );
          if (r.ok) {
            if (!r.complete) throw new FilesError("E_WTDIFF_UNSUPPORTED", "filter-config");
            return r.bytes;
          }
          if (r.kind === "enoent") return Buffer.alloc(0);
          if (r.kind === "abort") throw new FilesAbort();
          if (r.kind === "busy") throw new FilesError("E_BUSY", "fs");
          if (r.kind === "deadline") throw new FilesError("E_DEADLINE");
          throw new FilesError("E_WTDIFF_UNSUPPORTED", "filter-config");
        };
        const info0 = await readInfo(G, signal);
        const attrNames = driverNamesFromAttributes(info0.toString("utf8"));
        if ("unsafe" in attrNames) throw new FilesError("E_WTDIFF_UNSUPPORTED", "filter-config");
        const drivers = [...new Set([...scan.names, ...attrNames.names])].sort();
        // wtGraphFilesArgs THROWS on an unsafe name — validate the whole union first
        if (drivers.length > WTDIFF_DRIVERS_MAX || !drivers.every((d) => WTDIFF_DRIVER_NAME_RE.test(d))) {
          throw new FilesError("E_WTDIFF_UNSUPPORTED", "filter-config");
        }
        const sig0 = attrSigOf(info0, drivers);

        // Gf — single-flight + cached per (repo, oid, attribute signature)
        const key = [repoKey, h, sig0].join("\0");
        const acquired = cache.acquire(key, G, (exec) =>
          ps.withLoan(async () => {
            let argv: string[];
            try {
              argv = wtGraphFilesArgs(h, format, drivers);
            } catch {
              throw new FilesError("E_INTERNAL"); // caller bug — fail closed, never "skip and run"
            }
            const r = await pinned.run("Gf", argv, {
              captureStderr: true,
              deadline: exec.deadline,
              signal: exec.signal,
              capMs: WTGRAPH_FILES_CMD_MS,
              maxStdoutBytes: WTGRAPH_FILES_LOG_MAX_BYTES,
            });
            if (!r.ok) {
              if (r.kind === "abort") throw new FilesAbort();
              if (r.kind === "deadline") throw new FilesError("E_DEADLINE");
              if (r.kind === "busy") throw new FilesError("E_BUSY", "fs");
              if (r.kind === "git-unavailable") throw new FilesError("E_WTDIFF_UNSUPPORTED", "git-unavailable");
              throw new FilesError("E_INTERNAL"); // pin-mismatch tripwire
            }
            // capped BEFORE the exit code: an overflow kill's status must never be misread
            if (!r.capped && r.code !== 0) {
              const reason = classifyGraphExit(r.code, r.stderr ?? "");
              if (reason === "git-too-old") throw new FilesError("E_WTDIFF_UNSUPPORTED", "git-too-old");
              if (reason === "missing-object") throw new FilesError("E_WTDIFF_UNSUPPORTED", "missing-object");
              throw new FilesError("E_INTERNAL", "git-failed");
            }
            const parsed = parseCommitFilesZ(r.stdout, r.capped);
            // detect-and-discard: an attribute source changing during Gf ⇒ never returned/stored
            const info1 = await readInfo(exec.deadline, exec.signal);
            if (!info1.equals(info0)) throw new FilesError("E_BUSY", "attr-changed");
            return { parsed };
          }),
        );
        if (acquired.cached) acc.cached = true;
        let value: FilesValue;
        try {
          value = await raceAbort(acquired.promise, signal);
        } finally {
          acquired.release();
        }

        const hidden = (p: string): boolean =>
          denyListHit(`${W}/${p}`, deps.denyCtx) || denyListHit(`${wt}/${p}`, deps.denyCtx);
        const payload = projectCommitFiles(h, value.parsed, hidden, shallow);
        acc.ok = true;
        acc.files = payload.entries.length;
        acc.bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
        io.sendJson(res, 200, payload, {
          "Cache-Control": "no-store",
          "Cross-Origin-Resource-Policy": "same-origin",
        });
      } catch (err) {
        if (signal.aborted || err instanceof FilesAbort) {
          abortAnswer();
          return;
        }
        if (err instanceof FilesError) {
          const body: Record<string, unknown> = { error: err.code };
          if (err.reason !== undefined) body.reason = err.reason;
          if (err.code === "E_WTDIFF_UNSUPPORTED" && err.reason === "filter-config") {
            // same status as wtdiff's filter-config answer (a config condition, not a hub outage)
            acc.code = err.code;
            acc.reason = err.reason;
            io.sendJson(res, 415, body);
            return;
          }
          send(err.code, body, err.code === "E_BUSY" ? { "Retry-After": "1" } : undefined);
          return;
        }
        log.error("wtgraph files route: unexpected pipeline failure", { error: String(err) });
        acc.code = "E_INTERNAL";
        if (!res.headersSent && !res.destroyed) io.sendJson(res, 500, { error: "E_INTERNAL" });
        else res.destroy();
      }
    })().catch(() => {
      if (!res.headersSent && !res.destroyed) io.sendJson(res, 500, { error: "E_INTERNAL" });
      else res.destroy();
    });

    try {
      await entry.done;
    } finally {
      if (pinSet !== undefined) await pinSet.release();
      if (slotTaken) {
        inflightGlobal = Math.max(0, inflightGlobal - 1);
        const left = (inflightByPrincipal.get(principal) ?? 1) - 1;
        if (left <= 0) inflightByPrincipal.delete(principal);
        else inflightByPrincipal.set(principal, left);
      }
      active.delete(entry);
      acc.ms = now() - startedAt;
      if (!skipAudit) {
        const record: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(acc)) if (v !== undefined) record[k] = v;
        auditWorktreeGraph(log, record as unknown as WtGraphAuditRecord);
      }
    }
  }

  return {
    handle: (req, res, query, io) => serve(req, res, query, io),
    dispose(waitMs: number): Promise<void> {
      if (disposePromise !== undefined) return disposePromise;
      closing = true;
      disposePromise = (async (): Promise<void> => {
        cache.abortAll("hub-close");
        for (const e of [...active]) e.ctl.abort("hub-close");
        if (active.size > 0) {
          await Promise.race([Promise.allSettled([...active].map((e) => e.done)), unrefDelay(waitMs)]);
        }
        cache.clear();
      })();
      disposePromise.catch(() => undefined);
      return disposePromise;
    },
  };
}
