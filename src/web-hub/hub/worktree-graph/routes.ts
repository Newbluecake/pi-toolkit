/**
 * worktree-graph plan v2 §2.6 (P2): `GET /api/worktree-graph` — the single route pipeline.
 *
 * Wired into `FrontendDeps.worktreeGraph` exactly like worktree-diff (loopback always; LAN only
 * `mode === "on"`, same `webHub.preview` gate — §0.2 Q1). The security spine mirrors wtdiff's
 * (`worktree-diff/routes.ts`) ⓪–⑬ pipeline, reusing its exported `wtCsrfOk` and `createMembership`
 * (membership + the three-fd pin is the ONLY path to a pinned repo identity, and it is NOT
 * reimplemented here):
 *
 * ⓪ closing → ① CSRF (`wtCsrfOk`) → ② `io.authorize` → ③ params (agentKey/sessionId/wt, same
 * regex as wtdiff) → ④ this module's OWN rate bucket + in-flight caps (§2.5: 10 tok/500ms,
 * per-principal 1 / global 2 — smaller than wtdiff's, Gl is the heavier of the two features) →
 * ⑤ session visibility (registry + sessionId match) → ⑥ `createMembership` (same wtdiff import) →
 * S1 shallow stat (`previewFsStep`, no spawn — a stat on `/proc/self/fd/<common.fd>/shallow`) →
 * S2–S5 Gr then (tips permitting) Gl through the shared `createPinnedGit` executor,
 * with bounded stderr capture for exit classification only (never logs/audits).
 * `projectGraph` → `sendJson` → finally: pin release (`PinSet.release`,
 * idempotent, a single-flight `withLoan` may defer the actual close) → slots → active → one
 * audit line (`auditWorktreeGraph`, 429 throttled per principal per 60 s like wtdiff).
 *
 * Single-flight (§2.5): Gr runs individually per request (cheap, ≤2 s); only Gl — "a pure
 * function of tips" once Gr/tips are known — is joined across concurrent requests computing the
 * SAME tips set, via `SingleFlightCache` (reused unmodified from `worktree-diff/changeset.ts`,
 * `store:false` — join-only, never cached, I6) keyed on `pin ids \0 sha256(sorted tips) \0
 * shallow`. The shared execution runs under `PinSet.withLoan` so it may outlive the leader
 * request's own ⑬ (`worktree-diff/git.ts`'s `PinSet.withLoan` precedent).
 *
 * merged-plan r3 §3 (P2): with `mergedEnabled` AND a `merged=1` query the request additionally
 * runs the independent M phase (`./merged.ts`) after `projectGraph` and attaches the optional
 * `merged` payload field. Any other request takes EXACTLY the baseline path above (same git call
 * sequence, same `projectGraph` arguments, same response bytes).
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { classifyGraphExit, tipsFromRefs, parseForEachRefZ, parseGraphLogZ, wtGraphArgs } from "../../../git/graph.js";
import type { GitRunner } from "../../../git/run.js";
import { canonicalOrigin, parseOrigin } from "../../protocol/lan.js";
import { normalizePreviewPath, validatePreviewPath } from "../../protocol/preview.js";
import {
  WTGRAPH_BODY_MAX_BYTES,
  WTGRAPH_GIT_PHASE_MS,
  WTGRAPH_LOG_MAX_BYTES,
  WTGRAPH_LOG_MS,
  WTGRAPH_MERGED_MAX_BYTES,
  WTGRAPH_MERGED_QUERY,
  WTGRAPH_REFS_MAX_BYTES,
  WTGRAPH_REFS_SCAN_MAX,
  type WtGraphMerged,
  type WtGraphPayload,
} from "../../protocol/worktree-graph.js";
import { WTDIFF_ADMIT_MS, WTDIFF_STEP_MS, type WtDiffDenyReason } from "../../protocol/worktree-diff.js";
import { auditWorktreeGraph, type WtGraphAuditRecord } from "../audit.js";
import { createCmdLimit, type CmdLimit } from "../cmd-limit.js";
import type { HubLog, PreviewRouteIo, RegistryView, WorktreeGraphRoutes } from "../ports.js";
import { createReqDeadline, type ReqDeadline } from "../req-deadline.js";
import type { PreviewDenyContext, PreviewFs } from "../preview/admit.js";
import {
  createPreviewIoTracker,
  defaultPreviewFs,
  isPreviewIoError,
  previewFsStep,
  type PreviewIoTracker,
} from "../preview/fs.js";
import { SingleFlightCache } from "../worktree-diff/changeset.js";
import { createMembership } from "../worktree-diff/membership.js";
import { wtCsrfOk } from "../worktree-diff/routes.js";
import { createPinnedGit, type PinnedGitOutcome, type PinSet } from "../worktree-diff/git.js";
import {
  MergedAbortError,
  WTGRAPH_MERGED_CACHE_BYTES,
  WTGRAPH_MERGED_CACHE_ITEM_BYTES,
  WTGRAPH_MERGED_CACHE_LRU,
  WTGRAPH_MERGED_CACHE_TTL_MS,
  finalizeMergedPayload,
  runMergedPhase,
  type MergedStats,
  type MergedValue,
} from "./merged.js";
import { isValidHead, projectGraph, type WtHeadCandidate } from "./project.js";

// ---------------------------------------------------------------------------
// route constants (§2.5)
// ---------------------------------------------------------------------------

const WTGRAPH_BUCKET_CAPACITY = 10;
const WTGRAPH_BUCKET_REFILL_MS = 500;
const WTGRAPH_INFLIGHT_PER_PRINCIPAL = 1;
const WTGRAPH_INFLIGHT_GLOBAL = 2;
const WTGRAPH_DISPOSE_WAIT_MS = 1_000;
const RATE_AUDIT_WINDOW_MS = 60_000;

const AGENT_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID_RE = /^[\x21-\x7e]{1,128}$/;

export const WTGRAPH_STATUS: Readonly<Record<string, number>> = {
  E_BAD_REQUEST: 400,
  E_CSRF: 403,
  E_WTDIFF_DENIED: 403,
  E_NOT_FOUND: 404,
  E_SESSION_CHANGED: 409,
  E_WTDIFF_UNSUPPORTED: 415,
  E_RATE: 429,
  E_INTERNAL: 500,
  E_BUSY: 503,
  E_HUB_RESTARTING: 503,
  E_DEADLINE: 504,
};

// ---------------------------------------------------------------------------
// typed pipeline errors (mapped in ONE catch, mirrors worktree-diff/routes.ts §1.5)
// ---------------------------------------------------------------------------

class WtgAbortError extends Error {}
class WtgBadRequestError extends Error {}
class WtgNotFoundError extends Error {}
class WtgSessionChangedError extends Error {}
class WtgDeniedError extends Error {
  constructor(readonly reason: WtDiffDenyReason | "git-unavailable") {
    super(reason);
  }
}
class WtgUnsupportedError extends Error {
  constructor(
    readonly reason: "missing-object" | "git-too-old" | "git-unavailable",
    readonly status: 415 | 503,
  ) {
    super(reason);
  }
}
class WtgDeadlineError extends Error {
  constructor(readonly reason?: "log-timeout") {
    super(reason ?? "deadline");
  }
}
class WtgBusyError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
class WtgInternalError extends Error {
  constructor(readonly reason?: "git-failed") {
    super(reason ?? "internal");
  }
}

function unrefDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    t.unref();
  });
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

// ---------------------------------------------------------------------------
// shallow detection (§2.2: "浅克隆：不 spawn —— hub 在 /proc/self/fd/<common.fd>/shallow 上一次
// previewFsStep stat") — best-effort: ENOENT (or any other errno) ⇒ not shallow.
// ---------------------------------------------------------------------------

async function detectShallow(
  fs: PreviewFs,
  commonFd: number,
  deadline: ReqDeadline,
  signal: AbortSignal | undefined,
  tracker: PreviewIoTracker,
  now: () => number,
): Promise<{ shallow: boolean } | { fail: "abort" | "deadline" | "busy" }> {
  try {
    await previewFsStep(() => fs.stat(`/proc/self/fd/${commonFd}/shallow`), deadline, signal, {
      now,
      tracker,
      stepCapMs: WTDIFF_STEP_MS,
    });
    return { shallow: true };
  } catch (err) {
    if (isPreviewIoError(err)) {
      if (err.ioFail === "abort") return { fail: "abort" };
      if (err.ioFail === "busy") return { fail: "busy" };
      return { fail: "deadline" };
    }
    return { shallow: false };
  }
}

// ---------------------------------------------------------------------------
// single-flight key (§2.5: "键 = pin ids \0 sha256(sorted tips) \0 shallow")
// ---------------------------------------------------------------------------

function glKeyOf(ids: PinSet["ids"], tips: readonly string[], shallow: boolean): string {
  const digest = createHash("sha256")
    .update([...tips].sort().join(","))
    .digest("hex");
  return [
    `${ids.wt.dev}:${ids.wt.ino}`,
    `${ids.git.dev}:${ids.git.ino}`,
    `${ids.common.dev}:${ids.common.ino}`,
    digest,
    shallow ? "1" : "0",
  ].join("\0");
}

// ---------------------------------------------------------------------------
// deps + instance state
// ---------------------------------------------------------------------------

export interface WorktreeGraphRoutesDeps {
  mode: "on" | "loopback";
  /** hub.ts's preview deny context — the SAME resolved object preview/wtdiff's admitter uses. */
  denyCtx: PreviewDenyContext;
  registry: Pick<RegistryView, "get">;
  /** D15: the hub-side git runner (`deps.gitRunner ?? createGitRunner()` in hub.ts). */
  run: GitRunner;
  log: HubLog;
  now(): number;
  limit?: CmdLimit | undefined;
  fs?: Partial<PreviewFs> | undefined;
  /** merged-plan §3.1: honour `merged=1`. hub.ts passes `true` under exactly the condition that
   * declares `wtgraph.merged.v1`; absent/false ⇒ the query key is ignored (baseline path). */
  mergedEnabled?: boolean | undefined;
}

interface ActiveRequest {
  readonly ctl: AbortController;
  done: Promise<void>;
}

export function createWorktreeGraphRoutes(deps: WorktreeGraphRoutesDeps): WorktreeGraphRoutes {
  const { mode, registry, run, log, now } = deps;
  const limit: CmdLimit = deps.limit ?? createCmdLimit(now);
  const fs: PreviewFs = { ...defaultPreviewFs(), ...deps.fs };
  const tracker = createPreviewIoTracker();
  const membership = createMembership({ run, fs, tracker, denyCtx: deps.denyCtx, log, now });
  /** §2.5: Gl join-only (git output bodies are NEVER cached — I6, same as wtdiff's C4). */
  const glInflight = new SingleFlightCache<PinnedGitOutcome & { ok: true }>({
    ttlMs: 0,
    lruMax: 0,
    totalBytes: 0,
    store: false,
    now,
  });

  /** merged-plan §3.6: Gm results are a pure function of (HEAD, tip, attribute signature) — cached
   * with TTL/LRU/total-bytes/per-item bounds; one instance per `createWorktreeGraphRoutes` (I4). */
  const mergedCache = new SingleFlightCache<MergedValue>({
    ttlMs: WTGRAPH_MERGED_CACHE_TTL_MS,
    lruMax: WTGRAPH_MERGED_CACHE_LRU,
    totalBytes: WTGRAPH_MERGED_CACHE_BYTES,
    itemMaxBytes: WTGRAPH_MERGED_CACHE_ITEM_BYTES,
    store: true,
    now,
  });

  let closing = false;
  let disposePromise: Promise<void> | undefined;
  const active = new Set<ActiveRequest>();
  const inflightByPrincipal = new Map<string, number>();
  let inflightGlobal = 0;
  const pathKey = randomBytes(16);
  const rateAuditedAt = new Map<string, number>();

  const tagOf = (s: string): string => createHmac("sha256", pathKey).update(s).digest("hex").slice(0, 12);

  interface AuditAcc {
    listener: "loopback" | "lan";
    ip: string;
    user?: string | undefined;
    agentKey?: string | undefined;
    ok: boolean;
    code?: string | undefined;
    reason?: string | undefined;
    commits?: number | undefined;
    refs?: number | undefined;
    tips?: number | undefined;
    complete?: boolean | undefined;
    bytes?: number | undefined;
    ms?: number | undefined;
    joined?: boolean | undefined;
    wtTag?: string | undefined;
    mergedReq?: number | undefined;
    mergedCand?: number | undefined;
    mergedOmitted?: number | undefined;
    mergedRun?: number | undefined;
    mergedHit?: number | undefined;
    mergedUnk?: number | undefined;
    mergedSkip?: number | undefined;
    mergedMs?: number | undefined;
  }

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
    const acc: AuditAcc = { listener: io.listener, ip: io.ip, ok: false };
    let slotTaken = false;
    let principal = "";
    let pinSet: PinSet | undefined;
    let skipAudit = false;

    entry.done = (async (): Promise<void> => {
      const send = (code: string, body: unknown, headers?: Record<string, string>): void => {
        io.sendJson(res, WTGRAPH_STATUS[code] ?? 500, body, headers);
      };
      const abortAnswer = (): boolean => {
        if (!signal.aborted) return false;
        acc.code = "E_ABORT";
        acc.reason = signal.reason === "hub-close" ? "hub-close" : "client-abort";
        if (signal.reason === "hub-close" && !res.headersSent) send("E_HUB_RESTARTING", { error: "E_HUB_RESTARTING" });
        return true;
      };

      // ⓪ closing
      if (closing) {
        acc.code = "E_HUB_RESTARTING";
        send("E_HUB_RESTARTING", { error: "E_HUB_RESTARTING" });
        return;
      }
      // ① CSRF — before auth (reused verbatim from worktree-diff)
      if (!wtCsrfOk(req, io.expectedOrigin)) {
        acc.code = "E_CSRF";
        send("E_CSRF", { error: "E_CSRF" });
        return;
      }
      // ② auth
      const A = createReqDeadline(now, WTDIFF_ADMIT_MS);
      const authed = await io.authorize(A);
      if ("handled" in authed) {
        acc.code = authed.code;
        return;
      }
      acc.user = authed.user;
      principal = `${io.listener}:${authed.user ?? "token"}`;

      // ③ params
      const agentKey = query.get("agentKey") ?? "";
      const sessionId = query.get("sessionId") ?? "";
      const wt = normalizePreviewPath(query.get("wt") ?? "");
      if (
        !AGENT_KEY_RE.test(agentKey) ||
        !SESSION_ID_RE.test(sessionId) ||
        !validatePreviewPath(wt, { minSegments: 1 })
      ) {
        acc.code = "E_BAD_REQUEST";
        send("E_BAD_REQUEST", { error: "E_BAD_REQUEST" });
        return;
      }
      acc.agentKey = agentKey;

      // ④ rate limit + in-flight (§2.5: own smaller bucket/caps)
      const admittedLimit = limit.admit(`${principal}:wtgraph`, WTGRAPH_BUCKET_CAPACITY, WTGRAPH_BUCKET_REFILL_MS);
      if (!admittedLimit.ok) {
        const throttleKey = `wtgraph:${principal}`;
        const t = now();
        const last = rateAuditedAt.get(throttleKey);
        if (last !== undefined && t - last < RATE_AUDIT_WINDOW_MS) skipAudit = true;
        else rateAuditedAt.set(throttleKey, t);
        acc.code = "E_RATE";
        send(
          "E_RATE",
          { error: "E_RATE" },
          { "Retry-After": String(Math.max(1, Math.ceil(admittedLimit.retryAfterMs / 1000))) },
        );
        return;
      }
      const mine = inflightByPrincipal.get(principal) ?? 0;
      if (mine >= WTGRAPH_INFLIGHT_PER_PRINCIPAL || inflightGlobal >= WTGRAPH_INFLIGHT_GLOBAL) {
        acc.code = "E_BUSY";
        acc.reason = "inflight";
        send("E_BUSY", { error: "E_BUSY", reason: "inflight" }, { "Retry-After": "1" });
        return;
      }
      slotTaken = true;
      inflightByPrincipal.set(principal, mine + 1);
      inflightGlobal += 1;

      try {
        // ⑤ session visibility
        const view = registry.get(agentKey);
        if (view === undefined) throw new WtgNotFoundError();
        const session = view.session;
        if (session === undefined || session.sessionId !== sessionId) throw new WtgSessionChangedError();

        // ⑥ membership + the three-fd pin
        const m = await membership({ cwd: session.cwd, wtReq: wt, deadline: A, signal });
        if (!m.ok) {
          if (m.kind === "abort") {
            if (abortAnswer()) return;
            throw new WtgInternalError();
          }
          if (m.kind === "git-unavailable") throw new WtgUnsupportedError("git-unavailable", 503);
          if (m.kind === "deadline") throw new WtgDeadlineError();
          if (m.kind === "busy") throw new WtgBusyError("fs");
          throw new WtgDeniedError(m.reason);
        }
        const ps: PinSet = m.pinSet;
        pinSet = ps;
        const W = m.W;
        acc.wtTag = tagOf(W);

        // —— git phase: G is created at admission end, INDEPENDENT of A (§2.4) ——
        const G = createReqDeadline(now, WTGRAPH_GIT_PHASE_MS);
        const pinned = createPinnedGit({ run, pinSet: ps, fs, tracker, log, now });

        // S1: shallow stat (no spawn)
        const sh = await detectShallow(fs, ps.pins.common.fd, G, signal, tracker, now);
        if ("fail" in sh) {
          if (sh.fail === "abort") {
            if (abortAnswer()) return;
            throw new WtgInternalError();
          }
          if (sh.fail === "busy") throw new WtgBusyError("fs");
          throw new WtgDeadlineError();
        }
        const shallow = sh.shallow;

        // S2/S3: Gr — one bounded snapshot, never joined (cheap, request-scoped)
        const gr = await pinned.run("Gr", wtGraphArgs.refs(), {
          captureStderr: true,
          deadline: G,
          signal,
          capMs: WTDIFF_STEP_MS,
          maxStdoutBytes: WTGRAPH_REFS_MAX_BYTES,
        });
        if (!gr.ok) {
          if (gr.kind === "abort") {
            if (abortAnswer()) return;
            throw new WtgInternalError();
          }
          if (gr.kind === "deadline") throw new WtgDeadlineError();
          if (gr.kind === "busy") throw new WtgBusyError("fs");
          if (gr.kind === "git-unavailable") throw new WtgUnsupportedError("git-unavailable", 503);
          throw new WtgInternalError(); // pin-mismatch — the implementation-defect tripwire
        }
        // §2.3 "结果分类顺序": capped is checked BEFORE exit-code classification — an overflow
        // kill's exit code (often -1/none) must never be misread as missing-object/git-failed.
        if (!gr.capped && gr.code !== 0) {
          const reason = classifyGraphExit(gr.code, gr.stderr ?? "");
          if (reason === "git-too-old") throw new WtgUnsupportedError("git-too-old", 503);
          if (reason === "missing-object") throw new WtgUnsupportedError("missing-object", 503);
          throw new WtgInternalError("git-failed");
        }
        const refRows = parseForEachRefZ(gr.stdout, gr.capped);
        const refsTruncated = gr.capped || refRows.length > WTGRAPH_REFS_SCAN_MAX;

        // §2.2: worktree-HEAD candidates from membership's OWN porcelain rows — never re-fetched
        const wtHeadCandidates: WtHeadCandidate[] = [];
        m.rows.forEach((row, i) => {
          if (row.head === undefined || !isValidHead(row.head)) return;
          if (i === m.selfIndex) {
            wtHeadCandidates.push({
              h: row.head,
              path: row.path,
              ...(row.branch !== undefined ? { b: row.branch } : {}),
              self: true,
            });
          } else if (row.detached === true) {
            wtHeadCandidates.push({ h: row.head, path: row.path });
          }
        });

        const tips = tipsFromRefs(
          refRows,
          wtHeadCandidates.map((c) => c.h),
        );

        let glOutcome: (PinnedGitOutcome & { ok: true }) | undefined;
        let joined = false;
        if (tips.tips.length > 0) {
          const key = glKeyOf(ps.ids, tips.tips, shallow);
          const acquired = glInflight.acquire(key, G, (exec) =>
            ps.withLoan(async () => {
              const r = await pinned.run("Gl", wtGraphArgs.log(tips.tips), {
                captureStderr: true,
                deadline: exec.deadline,
                signal: exec.signal,
                capMs: WTGRAPH_LOG_MS,
                maxStdoutBytes: WTGRAPH_LOG_MAX_BYTES,
              });
              if (!r.ok) throw new GlFailure(r.kind);
              // same capped-before-exit-code discipline as Gr above
              if (!r.capped && r.code !== 0) {
                const reason = classifyGraphExit(r.code, r.stderr ?? "");
                throw new GlExitFailure(reason);
              }
              return r;
            }),
          );
          joined = acquired.joined;
          try {
            glOutcome = await raceSignal(acquired.promise, signal);
          } catch (err) {
            if (err instanceof GlFailure) {
              if (err.kind === "abort") {
                if (abortAnswer()) return;
                throw new WtgInternalError();
              }
              if (err.kind === "deadline") throw new WtgDeadlineError("log-timeout");
              if (err.kind === "busy") throw new WtgBusyError("fs");
              if (err.kind === "git-unavailable") throw new WtgUnsupportedError("git-unavailable", 503);
              throw new WtgInternalError(); // pin-mismatch
            }
            if (err instanceof GlExitFailure) {
              if (err.reason === "git-too-old") throw new WtgUnsupportedError("git-too-old", 503);
              if (err.reason === "missing-object") throw new WtgUnsupportedError("missing-object", 503);
              throw new WtgInternalError("git-failed");
            }
            if (err instanceof WtgAbortError || signal.aborted) {
              if (abortAnswer()) return;
            }
            throw err;
          } finally {
            acquired.release();
          }
        }

        let glParsed: ReturnType<typeof parseGraphLogZ> | undefined;
        if (glOutcome !== undefined) {
          glParsed = parseGraphLogZ(glOutcome.stdout, glOutcome.capped, tips.format ?? "sha1");
        }
        const wantMerged = deps.mergedEnabled === true && query.get(WTGRAPH_MERGED_QUERY) === "1";
        let payload: WtGraphPayload = projectGraph({
          refRows,
          refsTruncated,
          tips,
          gl:
            glParsed === undefined
              ? undefined
              : {
                  commits: glParsed.commits,
                  badRecords: glParsed.badRecords,
                  parentsTruncated: glParsed.parentsTruncated,
                  logCapped: glOutcome!.capped,
                },
          shallow,
          wtHeadCandidates,
          // merged=1 only: reserve the merged block's share of the unchanged 512 KiB total
          ...(wantMerged ? { maxBodyBytes: WTGRAPH_BODY_MAX_BYTES - WTGRAPH_MERGED_MAX_BYTES } : {}),
        });

        if (wantMerged) {
          acc.mergedReq = 1;
          let merged: WtGraphMerged;
          let stats: MergedStats | undefined;
          try {
            const r = await runMergedPhase(
              { pinned, ps, fs, tracker, now, signal, cache: mergedCache, log },
              { payload, rows: m.rows, shallow },
            );
            merged = r.merged;
            stats = r.stats;
          } catch (err) {
            if (signal.aborted || err instanceof MergedAbortError) {
              if (abortAnswer()) return;
              throw new WtgInternalError();
            }
            // a defect inside the M phase must never take the graph itself down
            log.error("wtgraph merged phase failed", { error: String(err) });
            merged = {
              v: 1,
              ...(payload.head === undefined ? {} : { base: payload.head.h }),
              skipped: payload.head === undefined ? "no-head" : "unconfirmed",
              branches: [],
            };
          }
          payload = finalizeMergedPayload(payload, merged);
          if (stats !== undefined) {
            acc.mergedCand = stats.cand;
            acc.mergedOmitted = stats.omitted;
            acc.mergedRun = stats.run;
            acc.mergedHit = stats.hit;
            acc.mergedUnk = stats.unk;
            acc.mergedSkip = payload.merged?.skipped === undefined ? 0 : 1;
            acc.mergedMs = stats.ms;
          }
        }

        acc.ok = true;
        acc.commits = payload.commits.length;
        acc.refs = payload.refs.length;
        acc.tips = tips.tips.length;
        acc.complete = payload.complete;
        acc.joined = joined || undefined;
        const body = JSON.stringify(payload);
        acc.bytes = byteLen(body);
        io.sendJson(res, 200, payload, { "Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin" });
      } catch (err) {
        if (signal.aborted || err instanceof WtgAbortError) {
          if (abortAnswer()) return;
        }
        if (err instanceof WtgBadRequestError) {
          acc.code = "E_BAD_REQUEST";
          send("E_BAD_REQUEST", { error: "E_BAD_REQUEST" });
        } else if (err instanceof WtgNotFoundError) {
          acc.code = "E_NOT_FOUND";
          send("E_NOT_FOUND", { error: "E_NOT_FOUND" });
        } else if (err instanceof WtgSessionChangedError) {
          acc.code = "E_SESSION_CHANGED";
          send("E_SESSION_CHANGED", { error: "E_SESSION_CHANGED" });
        } else if (err instanceof WtgDeniedError) {
          acc.code = "E_WTDIFF_DENIED";
          acc.reason = err.reason;
          send("E_WTDIFF_DENIED", { error: "E_WTDIFF_DENIED", reason: err.reason });
        } else if (err instanceof WtgUnsupportedError) {
          acc.code = "E_WTDIFF_UNSUPPORTED";
          acc.reason = err.reason;
          io.sendJson(res, err.status, { error: "E_WTDIFF_UNSUPPORTED", reason: err.reason });
        } else if (err instanceof WtgDeadlineError) {
          acc.code = "E_DEADLINE";
          acc.reason = err.reason;
          send(
            "E_DEADLINE",
            err.reason === undefined ? { error: "E_DEADLINE" } : { error: "E_DEADLINE", reason: err.reason },
          );
        } else if (err instanceof WtgBusyError) {
          acc.code = "E_BUSY";
          acc.reason = err.reason;
          send("E_BUSY", { error: "E_BUSY", reason: err.reason }, { "Retry-After": "1" });
        } else if (err instanceof WtgInternalError) {
          acc.code = "E_INTERNAL";
          acc.reason = err.reason;
          send("E_INTERNAL", { error: "E_INTERNAL", ...(err.reason === undefined ? {} : { reason: err.reason }) });
        } else {
          acc.code = "E_INTERNAL";
          log.error("wtgraph route: unexpected pipeline failure", { error: String(err) });
          if (!res.headersSent && !res.destroyed) io.sendJson(res, 500, { error: "E_INTERNAL" });
          else res.destroy();
        }
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
        const record: Record<string, unknown> = { phase: "graph" };
        for (const [k, v] of Object.entries(acc)) if (v !== undefined) record[k] = v;
        auditWorktreeGraph(log, record as unknown as WtGraphAuditRecord);
      }
    }
  }

  const routes: WorktreeGraphRoutes = {
    mode,
    handle: (req, res, query, io) => serve(req, res, query, io),
    dispose(reason: "close" | "startup-failure", deadline: ReqDeadline): Promise<void> {
      if (disposePromise !== undefined) return disposePromise;
      closing = true;
      const waitMs = Math.max(0, Math.min(WTGRAPH_DISPOSE_WAIT_MS, deadline.remaining()));
      disposePromise = (async (): Promise<void> => {
        glInflight.abortAll("hub-close");
        mergedCache.abortAll("hub-close");
        for (const e of [...active]) e.ctl.abort("hub-close");
        if (active.size > 0) {
          await Promise.race([Promise.allSettled([...active].map((e) => e.done)), unrefDelay(waitMs)]);
        }
        mergedCache.clear();
      })();
      disposePromise.catch(() => undefined);
      return disposePromise;
    },
  };
  return routes;
}

// ---------------------------------------------------------------------------
// small internal signal helpers
// ---------------------------------------------------------------------------

class GlFailure extends Error {
  constructor(readonly kind: "abort" | "deadline" | "busy" | "git-unavailable" | "pin-mismatch") {
    super(kind);
  }
}
class GlExitFailure extends Error {
  constructor(readonly reason: "missing-object" | "git-too-old" | "git-failed" | null) {
    super(reason ?? "git-failed");
  }
}

function raceSignal<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return p;
  if (signal.aborted) return Promise.reject(new WtgAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new WtgAbortError());
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
