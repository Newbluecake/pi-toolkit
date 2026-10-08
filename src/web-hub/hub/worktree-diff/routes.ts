/**
 * worktree-diff plan §1.7/§2 (D3): the two route pipelines.
 *
 * `GET /api/worktree-diff/files` (清单) and `GET /api/worktree-diff/file` (单文件) share ONE
 * pipeline shape (§1.7 ⓪–⑬), wired into `FrontendDeps.worktreeDiff` and dispatched by http.ts
 * exactly like preview (loopback always; LAN only `mode === "on"`, D6 — no new setting, the cap
 * and the routes both ride `config.preview` + the /proc probe).
 *
 * The security spine, in order:
 * - ⓪ closing / ① CSRF (preview's exact rule) / ② listener auth / ③ params / ④ token bucket +
 *   in-flight (per-principal 2, global 4 ⇒ ≤4 git processes hub-wide) / ⑤ session visibility;
 * - ⑥ membership + the three-fd pin (membership.ts) — the ONLY path to a pinned repo identity,
 *   with the file endpoint's LITERAL denylist check on `W/path`×`wtReq/path` (± orig) before
 *   any git-phase command runs;
 * - ⑦ C0 — the request's SINGLE HEAD resolution on the pinned chain (I15). `file`'s `base` is
 *   compared against THIS C0 (never a cached value); every later command takes the explicit oid;
 * - ⑧ Cc + info/attributes → the L2 neutralization set + attrSig (§2.6.2);
 * - ⑨ the ≤5 s TTL single-flight changeset (changeset.ts) — key carries this request's C0 oid;
 * - ⑩f/⑩p numstat merge / entry binding + C4-or-untracked — a `file` ask outside the current
 *   changeset is 409 `entry` (zero oracle, §2.8), C4's argv oid is always this request's C0;
 * - ⑪ L3 post-hoc recheck (attr/driver set moved during execution ⇒ discard + 503);
 * - ⑫ send / ⑬ finally: three parallel boundedClose (own 1 s deadlines, no signal) → slots →
 *   active → the single audit line (429 throttled per principal per 60 s, §2.9).
 */

import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  attrSourceArgs,
  combinedStatus,
  driverNamesFromAttributes,
  neutralizeArgs,
  parseCheckAttrZ,
  parseDriverScan,
  parseHeadProbe,
  parseNumstatZ,
  parseStatusV2Z,
  wtDiffArgs,
} from "../../../git/diff.js";
import type { GitRunner } from "../../../git/run.js";
import { canonicalOrigin, parseOrigin } from "../../protocol/lan.js";
import { validatePreviewPath } from "../../protocol/preview.js";
import {
  isWtRequestableEntry,
  WTDIFF_ADMIT_MS,
  WTDIFF_BASE_RE,
  WTDIFF_DRIVERS_MAX,
  WTDIFF_FILES_MAX,
  WTDIFF_FILE_BODY_MAX_BYTES,
  WTDIFF_GIT_CMD_MS,
  WTDIFF_GIT_PHASE_MS,
  WTDIFF_LIST_BODY_MAX_BYTES,
  WTDIFF_NUMSTAT_MAX_BYTES,
  WTDIFF_PATCH_MAX_BYTES,
  WTDIFF_STATUS_MAX_BYTES,
  WTDIFF_STEP_MS,
  validateWtRelPath,
  type WtDiffDenyReason,
  type WtDiffFileEntry,
  type WtDiffFileList,
  type WtDiffFilePayload,
  type WtDiffStatus,
  type WtDiffUnsupportedReason,
} from "../../protocol/worktree-diff.js";
import { auditWorktreeDiff, type WtDiffAuditRecord } from "../audit.js";
import { createCmdLimit, type CmdLimit } from "../cmd-limit.js";
import type { HubLog, PreviewRouteIo, RegistryView, WorktreeDiffRoutes } from "../ports.js";
import { createReqDeadline, type ReqDeadline } from "../req-deadline.js";
import {
  createFsAdmitter,
  denyListHit,
  type FsAdmitter,
  type PreviewDenyContext,
  type PreviewFs,
} from "../preview/admit.js";
import { createPreviewIoTracker, defaultPreviewFs } from "../preview/fs.js";
import {
  changesetKeyOf,
  createChangesetCache,
  type ChangesetValue,
  type SharedExec,
  SingleFlightCache,
} from "./changeset.js";
import {
  attrSigOf,
  createPinnedGit,
  indexStatOf,
  isGitTooOldExit,
  readProcFdFile,
  warnGitFailed,
  type PinSet,
  type PinnedGitOutcome,
  type WtGitCmd,
} from "./git.js";
import { createMembership } from "./membership.js";
import { createUntrackedReader } from "./untracked.js";

// ---------------------------------------------------------------------------
// route constants (§1.2 / §1.7 / §2.9)
// ---------------------------------------------------------------------------

/** §1.7 ②: LAN `authorize()` races against
 * `deriveBudget(remaining, LAN_AUTH_CAP_MS, WTDIFF_AUTH_RESERVE_MS)` — after auth at least 5 s
 * of the 8 s admission budget remains for membership (`ADMIT − AUTH_RESERVE ≥ LAN_AUTH_CAP`,
 * the §1.9 relation pin). */
export const WTDIFF_AUTH_RESERVE_MS = 5_000;

/** §1.7 ④: wtdiff's own token bucket (same figures as preview's). */
const WTDIFF_BUCKET_CAPACITY = 20;
const WTDIFF_BUCKET_REFILL_MS = 250;

/** §1.7 ④: in-flight caps (⇒ 503 E_BUSY{inflight}) — global 4 ⇒ ≤4 git processes hub-wide. */
const WTDIFF_INFLIGHT_PER_PRINCIPAL = 2;
const WTDIFF_INFLIGHT_GLOBAL = 4;

/** §4.5.1-style dispose wait bound (≤1 s). */
const WTDIFF_DISPOSE_WAIT_MS = 1_000;

/** §2.9: 429 audit throttle — one line per `wtdiff:${principal}` per 60 s window. */
const RATE_AUDIT_WINDOW_MS = 60_000;

const AGENT_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID_RE = /^[\x21-\x7e]{1,128}$/;

/** Cc stdout cap (§1.8) — over ⇒ 415 `filter-config`. */
const WTDIFF_DRIVER_SCAN_MAX_BYTES = 64 * 1024;
/** info/attributes read cap (§2.6.2 L2) — over/unreadable ⇒ 415 `filter-config`. */
const WTDIFF_INFO_ATTRS_MAX_BYTES = 64 * 1024;
const WTDIFF_CHECKATTR_MAX_BYTES = 256 * 1024;
/** ⑩: below this much git-phase budget C3 is skipped (numstatPartial) / C4+untracked answer 504. */
const GIT_PHASE_MIN_FOR_CONTENT_MS = 1_000;

/** The single response-status table routes answer from (never throws; §4.5 discipline). */
export const WTDIFF_STATUS: Readonly<Record<string, number>> = {
  E_BAD_REQUEST: 400,
  E_CSRF: 403,
  E_WTDIFF_DENIED: 403,
  E_PREVIEW_DENIED: 403, // untracked-read passthrough (§3.1.1 mapping)
  E_NOT_FOUND: 404,
  E_SESSION_CHANGED: 409,
  E_STALE_CTX: 409,
  E_PREVIEW_CHANGED: 409, // untracked-read passthrough
  E_WTDIFF_UNSUPPORTED: 415,
  E_PREVIEW_UNSUPPORTED: 415, // untracked-read passthrough
  E_RATE: 429,
  E_INTERNAL: 500,
  E_BUSY: 503,
  E_HUB_RESTARTING: 503,
  E_DEADLINE: 504,
};

// ---------------------------------------------------------------------------
// typed pipeline errors (mapped in ONE catch, §1.5)
// ---------------------------------------------------------------------------

class WtAbortError extends Error {}
class WtBadRequestError extends Error {}
class WtNotFoundError extends Error {}
class WtSessionChangedError extends Error {}
class WtDeniedError extends Error {
  constructor(readonly reason: WtDiffDenyReason) {
    super(reason);
  }
}
class WtUnsupportedError extends Error {
  constructor(
    readonly reason: WtDiffUnsupportedReason,
    readonly status: 415 | 503,
  ) {
    super(reason);
  }
}
class WtStaleError extends Error {
  constructor(readonly reason: "base" | "entry") {
    super(reason);
  }
}
class WtGitTooOldError extends Error {}
class WtGitExitError extends Error {
  constructor(
    readonly cmd: WtGitCmd,
    readonly code: number,
    readonly stderrBytes: number,
  ) {
    super(`git ${cmd} failed`);
  }
}
class WtBusyError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
class WtDeadlineError extends Error {}
class WtInternalError extends Error {}

/** The non-exit pinned-git failure kinds ⇒ their §1.5 rows. */
function throwGitFail(kind: "abort" | "deadline" | "busy" | "git-unavailable" | "pin-mismatch"): never {
  if (kind === "abort") throw new WtAbortError();
  if (kind === "deadline") throw new WtDeadlineError();
  if (kind === "busy") throw new WtBusyError("fs");
  if (kind === "git-unavailable") throw new WtUnsupportedError("git-unavailable", 503);
  throw new WtInternalError(); // pin-mismatch — the implementation-defect tripwire (I14)
}

/** Non-zero exit with no more specific mapping: the git-failed warn + 500 (§1.5 last rows). */
function throwGitExit(cmd: WtGitCmd, r: { code: number; stderrBytes: number }, log: HubLog): never {
  warnGitFailed(log, cmd, { exit: r.code });
  throw new WtGitExitError(cmd, r.code, r.stderrBytes);
}

/** Race `p` against `signal` — a WtAbortError never leaks the raw signal reason. */
function raceSignal<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return p;
  if (signal.aborted) return Promise.reject(new WtAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new WtAbortError());
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

/** §3.1 ① CSRF — preview's exact rule (X-PWH mandatory; Sec-Fetch-Site same-origin when
 * present; Origin must equal the listener's expected origin when present). */
function wtCsrfOk(req: IncomingMessage, expectedOrigin: string): boolean {
  if (req.headers["x-pwh"] !== "1") return false;
  const sfs = req.headers["sec-fetch-site"];
  if (typeof sfs === "string" && sfs.toLowerCase() !== "same-origin") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const parsed = parseOrigin(origin);
  if (parsed === undefined) return false;
  return canonicalOrigin(parsed.scheme, parsed.hostKey) === expectedOrigin;
}

/** §2.9 audit `ext`: sanitized ≤16-char ASCII extension of the basename, never more path. */
function extOf(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ext = base.slice(dot + 1);
  return /^[A-Za-z0-9]{1,16}$/.test(ext) ? ext.toLowerCase() : undefined;
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
// deps + instance state
// ---------------------------------------------------------------------------

export interface WorktreeDiffRoutesDeps {
  mode: "on" | "loopback";
  /** hub.ts's preview deny context — the SAME resolved object preview's admitter uses (§2.5). */
  denyCtx: PreviewDenyContext;
  registry: Pick<RegistryView, "get">;
  /** D15: the hub-side git runner (`deps.gitRunner ?? createGitRunner()` in hub.ts). */
  run: GitRunner;
  log: HubLog;
  now(): number;
  /** §7-D14-style: wtdiff's OWN limiter; absent ⇒ a private CmdLimit instance. */
  limit?: CmdLimit | undefined;
  fs?: Partial<PreviewFs> | undefined;
  admitter?: FsAdmitter | undefined;
}

interface ActiveRequest {
  readonly ctl: AbortController;
  done: Promise<void>;
}

/** The C4 single-flight product — raw stdout + cap flag ONLY (joiners classify themselves). */
interface C4Outcome {
  stdout: string;
  capped: boolean;
}

export function createWorktreeDiffRoutes(deps: WorktreeDiffRoutesDeps): WorktreeDiffRoutes {
  const { mode, registry, run, log, now } = deps;
  const limit: CmdLimit = deps.limit ?? createCmdLimit(now);
  const fs: PreviewFs = { ...defaultPreviewFs(), ...deps.fs };
  const tracker = createPreviewIoTracker();
  const membership = createMembership({ run, fs, tracker, denyCtx: deps.denyCtx, log, now });
  const admitter: FsAdmitter =
    deps.admitter ??
    createFsAdmitter({ denyCtx: deps.denyCtx, tracker, log, now, ...(deps.fs === undefined ? {} : { fs: deps.fs }) });
  const readUntracked = createUntrackedReader({ admitter, tracker, now, log });
  const changesetCache = createChangesetCache(now);
  /** §1.10: C4 join-only (git output bodies are NEVER cached — I6). */
  const c4Inflight = new SingleFlightCache<C4Outcome>({ ttlMs: 0, lruMax: 0, totalBytes: 0, store: false, now });

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
    status?: WtDiffStatus | undefined;
    kind?: string | undefined;
    files?: number | undefined;
    truncated?: boolean | undefined;
    bytes?: number | undefined;
    ms?: number | undefined;
    ext?: string | undefined;
    wtTag?: string | undefined;
    pathTag?: string | undefined;
    joined?: boolean | undefined;
    cached?: boolean | undefined;
    drivers?: number | undefined;
  }

  // -------------------------------------------------------------------------
  // the shared pipeline (§1.7)
  // -------------------------------------------------------------------------

  async function serve(
    phase: "files" | "file",
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
    let skipAudit = false; // 429 repeats within the throttle window still answer, just don't re-log

    entry.done = (async (): Promise<void> => {
      const send = (code: string, body: unknown, headers?: Record<string, string>): void => {
        io.sendJson(res, WTDIFF_STATUS[code] ?? 500, body, headers);
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
      // ① CSRF — before auth
      if (!wtCsrfOk(req, io.expectedOrigin)) {
        acc.code = "E_CSRF";
        send("E_CSRF", { error: "E_CSRF" });
        return;
      }
      // ② auth (the admission budget A; the LAN adapter derives its auth slice from A.remaining)
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
      const wt = query.get("wt") ?? "";
      const untrackedRaw = query.get("untracked");
      if (
        !AGENT_KEY_RE.test(agentKey) ||
        !SESSION_ID_RE.test(sessionId) ||
        !validatePreviewPath(wt, { minSegments: 1 }) ||
        (untrackedRaw !== null && untrackedRaw !== "no")
      ) {
        acc.code = "E_BAD_REQUEST";
        send("E_BAD_REQUEST", { error: "E_BAD_REQUEST" });
        return;
      }
      const untrackedMode: "all" | "no" = untrackedRaw === "no" ? "no" : "all";
      acc.agentKey = agentKey;
      const base = phase === "file" ? (query.get("base") ?? "") : "";
      const path = phase === "file" ? (query.get("path") ?? "") : "";
      const origRaw = phase === "file" ? query.get("orig") : null;
      const orig = origRaw === null ? undefined : origRaw;
      if (phase === "file") {
        if (
          !WTDIFF_BASE_RE.test(base) ||
          !validateWtRelPath(path) ||
          (orig !== undefined && !validateWtRelPath(orig))
        ) {
          acc.code = "E_BAD_REQUEST";
          send("E_BAD_REQUEST", { error: "E_BAD_REQUEST" });
          return;
        }
        acc.pathTag = tagOf(`${wt}\0${path}`);
        acc.ext = extOf(path);
      } else {
        acc.wtTag = tagOf(wt);
      }

      // ④ rate limit + in-flight
      const admittedLimit = limit.admit(`${principal}:wtdiff`, WTDIFF_BUCKET_CAPACITY, WTDIFF_BUCKET_REFILL_MS);
      if (!admittedLimit.ok) {
        const throttleKey = `wtdiff:${principal}`;
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
      if (mine >= WTDIFF_INFLIGHT_PER_PRINCIPAL || inflightGlobal >= WTDIFF_INFLIGHT_GLOBAL) {
        acc.code = "E_BUSY";
        acc.reason = "inflight";
        send("E_BUSY", { error: "E_BUSY", reason: "inflight" }, { "Retry-After": "1" });
        return;
      }
      slotTaken = true;
      inflightByPrincipal.set(principal, mine + 1);
      inflightGlobal += 1;

      // ⑤–⑫: everything below maps its failures through typed errors (the single catch below)
      try {
        // ⑤ session visibility (preview ⑤ exactly)
        const view = registry.get(agentKey);
        if (view === undefined) throw new WtNotFoundError();
        const session = view.session;
        if (session === undefined || session.sessionId !== sessionId) throw new WtSessionChangedError();

        // ⑥ membership + the three-fd pin (all inside A)
        const m = await membership({ cwd: session.cwd, wtReq: wt, deadline: A, signal });
        if (!m.ok) {
          if (m.kind === "abort") {
            if (abortAnswer()) return;
            throw new WtInternalError();
          }
          if (m.kind === "git-unavailable") throw new WtUnsupportedError("git-unavailable", 503);
          if (m.kind === "deadline") throw new WtDeadlineError();
          if (m.kind === "busy") throw new WtBusyError("fs");
          throw new WtDeniedError(m.reason);
        }
        const ps: PinSet = m.pinSet;
        pinSet = ps;
        const W = m.W;
        acc.wtTag = tagOf(W);
        if (phase === "file") {
          acc.pathTag = tagOf(`${W}\0${path}`);
          // §2.5 row 3: the LITERAL denylist check before any git-phase command, plus §2.4's
          // combined validatePreviewPath re-check of W + rel
          if (
            denyListHit(`${W}/${path}`, deps.denyCtx) ||
            denyListHit(`${wt}/${path}`, deps.denyCtx) ||
            (orig !== undefined &&
              (denyListHit(`${W}/${orig}`, deps.denyCtx) || denyListHit(`${wt}/${orig}`, deps.denyCtx)))
          ) {
            throw new WtDeniedError("denylist");
          }
          if (!validatePreviewPath(`${W}/${path}`, { minSegments: 1 })) throw new WtBadRequestError();
        }

        // —— git phase: G is created at admission end, INDEPENDENT of A (§1.9) ——
        const G = createReqDeadline(now, WTDIFF_GIT_PHASE_MS);
        const pinned = createPinnedGit({ run, pinSet: ps, fs, tracker, log, now });
        const okRun = (cmd: WtGitCmd, r: PinnedGitOutcome): Exclude<PinnedGitOutcome, { ok: false }> => {
          if (!r.ok) throwGitFail(r.kind);
          return r;
        };

        // ⑦ C0 — the request's single HEAD resolution on the pinned chain (I15)
        const c0r = okRun(
          "C0",
          await pinned.run("C0", wtDiffArgs.head(), {
            deadline: G,
            signal,
            capMs: WTDIFF_STEP_MS,
            maxStdoutBytes: 8 * 1024,
          }),
        );
        if (c0r.code !== 0) throw new WtUnsupportedError("unborn", 415);
        const c0 = parseHeadProbe(c0r.stdout);
        if (c0 === null) {
          warnGitFailed(log, "C0", { exit: c0r.code });
          throw new WtInternalError();
        }
        // #1: base is judged against THIS request's C0 — never a cached value
        if (phase === "file" && base !== c0.oid) throw new WtStaleError("base");

        // ⑧ Cc driver scan + info/attributes → L1 + N + attrSig (§2.6.2); re-runnable for ⑪ L3
        const attrsPath = `/proc/self/fd/${ps.pins.common.fd}/info/attributes`;
        const scanDriverSet = async (): Promise<{ infoBytes: Buffer; drivers: string[] }> => {
          const ccr = okRun(
            "Cc",
            await pinned.run("Cc", wtDiffArgs.driverScan(), {
              deadline: G,
              signal,
              capMs: WTDIFF_STEP_MS,
              maxStdoutBytes: WTDIFF_DRIVER_SCAN_MAX_BYTES,
            }),
          );
          if (ccr.code !== 0 && ccr.code !== 1) throwGitExit("Cc", ccr, log); // exit 1 = "no match"
          const scan = parseDriverScan(ccr.stdout, ccr.capped);
          if ("unsafe" in scan) throw new WtUnsupportedError("filter-config", 415);
          const infoRead = await readProcFdFile(
            fs,
            { tracker, now },
            attrsPath,
            WTDIFF_INFO_ATTRS_MAX_BYTES,
            G,
            signal,
          );
          let infoBytes: Buffer = Buffer.alloc(0);
          if (infoRead.ok) {
            if (!infoRead.complete) throw new WtUnsupportedError("filter-config", 415); // >64 KiB
            infoBytes = infoRead.bytes;
          } else if (infoRead.kind === "io") throw new WtUnsupportedError("filter-config", 415);
          else if (infoRead.kind === "deadline") throw new WtDeadlineError();
          else if (infoRead.kind === "abort") throw new WtAbortError();
          else if (infoRead.kind === "busy") throw new WtBusyError("fs");
          // enoent ⇒ the empty file (§2.6.2)
          const attrNames = driverNamesFromAttributes(infoBytes.toString("utf8"));
          if ("unsafe" in attrNames) throw new WtUnsupportedError("filter-config", 415);
          const union = [...new Set([...scan.names, ...attrNames.names])].sort();
          if (union.length > WTDIFF_DRIVERS_MAX) throw new WtUnsupportedError("filter-config", 415);
          return { infoBytes, drivers: union };
        };
        const { infoBytes, drivers } = await scanDriverSet();
        const l1 = attrSourceArgs(c0.format);
        const n = neutralizeArgs(drivers);
        const attrSig = attrSigOf(infoBytes, drivers);
        acc.drivers = drivers.length;
        const indexStat = await indexStatOf(fs, { tracker, now }, ps.pins.git.fd, G, signal);

        // ⑨ changeset — ≤5 s TTL single-flight; the key carries THIS request's C0 oid
        const key = changesetKeyOf(ps.ids, c0.oid, indexStat, attrSig, untrackedMode);
        const hiddenNow = (p: string): boolean =>
          denyListHit(`${W}/${p}`, deps.denyCtx) || denyListHit(`${wt}/${p}`, deps.denyCtx);
        const computeChangeset = async (exec: SharedExec): Promise<ChangesetValue> =>
          ps.withLoan(async () => {
            const argv = wtDiffArgs.status(l1, n, untrackedMode);
            const r = okRun(
              "C2",
              await pinned.run("C2", argv, {
                deadline: exec.deadline,
                signal: exec.signal,
                capMs: WTDIFF_GIT_CMD_MS,
                maxStdoutBytes: WTDIFF_STATUS_MAX_BYTES,
              }),
            );
            if (isGitTooOldExit(argv, r.code)) throw new WtGitTooOldError();
            if (r.code !== 0) throwGitExit("C2", r, log);
            const parsed = parseStatusV2Z(r.stdout, r.capped);
            // I15: C2's `# branch.oid` is a CONSISTENCY CHECK only — a mismatch means HEAD
            // moved inside this very request window ⇒ 409 base (§1.7 ⑨)
            if (parsed.oid !== undefined && parsed.oid !== c0.oid) throw new WtStaleError("base");
            const entries: WtDiffFileEntry[] = [];
            let totalVisible = 0;
            for (const e of parsed.entries) {
              const st = combinedStatus(e);
              if (st === null) continue;
              // D14: hidden entries never enter the list, the count or any derived field
              if (hiddenNow(e.path) || (e.orig !== undefined && hiddenNow(e.orig))) continue;
              totalVisible += 1;
              if (entries.length < WTDIFF_FILES_MAX) {
                entries.push({ path: e.path, status: st, ...(e.orig !== undefined ? { orig: e.orig } : {}) });
              }
            }
            let attrPartial = false;
            if (drivers.length > 0 && entries.length > 0) {
              const driverSet = new Set(drivers);
              const paths = entries.filter((e) => validateWtRelPath(e.path)).map((e) => e.path);
              const filterValues = new Map<string, string>();
              for (const caArgv of wtDiffArgs.checkAttr(c0.oid, paths)) {
                const br = await pinned.run("Ca", caArgv, {
                  deadline: exec.deadline,
                  signal: exec.signal,
                  capMs: WTDIFF_STEP_MS,
                  maxStdoutBytes: WTDIFF_CHECKATTR_MAX_BYTES,
                });
                // D21 fail-closed FIRST: `check-attr --source` unknown to the installed git ⇒ 129 —
                // the same WtGitTooOldError every other attr-source command throws (never a degrade)
                if (br.ok && isGitTooOldExit(caArgv, br.code)) throw new WtGitTooOldError();
                // other check-attr failures are NEVER errors — uncovered paths degrade fail-closed
                if (!br.ok || br.code !== 0 || br.capped) {
                  attrPartial = true;
                  continue;
                }
                for (const [p, v] of parseCheckAttrZ(br.stdout)) filterValues.set(p, v);
              }
              for (const e of entries) {
                if (!validateWtRelPath(e.path)) continue; // not requestable anyway (§2.4)
                const v = filterValues.get(e.path);
                if (v === undefined) {
                  e.filtered = true;
                  attrPartial = true;
                } else if (driverSet.has(v)) e.filtered = true;
              }
            }
            return {
              base: c0.oid,
              entries,
              totalVisible,
              limitsStatus: parsed.capped,
              limitsFiles: totalVisible > WTDIFF_FILES_MAX,
              ...(untrackedMode === "no" ? { untrackedSkipped: true as const } : {}),
              ...(attrPartial ? { attrPartial: true as const } : {}),
            } satisfies ChangesetValue;
          });
        const acquired = changesetCache.acquire(key, G, computeChangeset);
        let csValue: ChangesetValue;
        try {
          csValue = await raceSignal(acquired.promise, signal);
        } finally {
          acquired.release();
        }
        acc.joined = acquired.joined || undefined;
        acc.cached = acquired.cached || undefined;
        // per-request D14 re-filter: a cached value may have been built under another spelling
        // of the same W inode — a hidden item must never become visible through it
        csValue = {
          ...csValue,
          entries: csValue.entries.filter((e) => !hiddenNow(e.path) && !(e.orig !== undefined && hiddenNow(e.orig))),
        };
        const ranContentGit = !acquired.cached; // C2 executed for this key now (led or joined)

        /** ⑪ L3: re-read info/attributes + re-run Cc on THIS request's chain; any change —
         * or any non-abort failure to re-verify (budget exhausted included, fail-closed §1.9)
         * — is treated as a change: discard + 503 attr-changed. */
        const l3Recheck = async (ran: boolean): Promise<void> => {
          if (!ran) return;
          let again: { infoBytes: Buffer; drivers: string[] };
          try {
            again = await scanDriverSet();
          } catch (err) {
            if (err instanceof WtAbortError) throw err;
            log.warn("wtdiff attr changed", { event: "wtdiff.attr_changed" }); // no path, no driver names
            throw new WtBusyError("attr-changed");
          }
          if (attrSigOf(again.infoBytes, again.drivers) !== attrSig) {
            log.warn("wtdiff attr changed", { event: "wtdiff.attr_changed" });
            throw new WtBusyError("attr-changed");
          }
        };

        if (phase === "files") {
          // ⑩f numstat merge (<1 s left ⇒ skip; any failure degrades to numstatPartial)
          let numstatPartial = false;
          let c3Ran = false;
          const numstat = new Map<string, { add: number | null; del: number | null }>();
          if (G.remaining() < GIT_PHASE_MIN_FOR_CONTENT_MS) {
            numstatPartial = true;
          } else {
            c3Ran = true;
            const argv = wtDiffArgs.numstat(l1, n, c0.oid);
            const r = await pinned.run("C3", argv, {
              deadline: G,
              signal,
              capMs: WTDIFF_GIT_CMD_MS,
              maxStdoutBytes: WTDIFF_NUMSTAT_MAX_BYTES,
            });
            // D21 fail-closed FIRST: `--attr-source` unknown to the installed git ⇒ 129 — the
            // same WtGitTooOldError C2/C4 throw (never a numstat degrade; §1.5's "numstat 失败
            // 不是错误" covers REAL numstat failures, not an unusable git)
            if (r.ok && isGitTooOldExit(argv, r.code)) throw new WtGitTooOldError();
            if (!r.ok || r.code !== 0 || r.capped) {
              numstatPartial = true; // §1.5: numstat failure is a degrade, never an error
            } else {
              for (const e of parseNumstatZ(r.stdout, r.capped)) {
                numstat.set(`${e.path}\0${e.orig ?? ""}`, { add: e.add, del: e.del });
              }
            }
          }
          await l3Recheck(ranContentGit || c3Ran);
          // ⑫ send — the byte-budgeted list
          const payload = buildListPayload(csValue, numstat, numstatPartial);
          acc.ok = true;
          acc.files = payload.entries.length;
          acc.truncated = payload.truncated || undefined;
          io.sendJson(res, 200, payload, {
            "Cache-Control": "no-store",
            "Cross-Origin-Resource-Policy": "same-origin",
          });
          return;
        }

        // ⑩p file — the entry must be a requestable member of the CURRENT changeset (D8/#1)
        const target = csValue.entries.find((e) => e.path === path && e.orig === orig);
        if (target === undefined || !isWtRequestableEntry(target)) throw new WtStaleError("entry");
        acc.status = target.status;
        let payloadOut: WtDiffFilePayload;
        if (target.status === "?") {
          if (G.remaining() < GIT_PHASE_MIN_FOR_CONTENT_MS) throw new WtDeadlineError();
          const un = await readUntracked({ W, rel: path, deadline: G, signal });
          if (!un.ok) {
            if (un.kind === "abort") {
              if (abortAnswer()) return;
              throw new WtInternalError();
            }
            acc.code = un.code;
            acc.reason = un.reason;
            io.sendJson(res, un.status, { error: un.code, ...(un.reason === undefined ? {} : { reason: un.reason }) });
            return;
          }
          await l3Recheck(ranContentGit);
          acc.kind = "untracked";
          payloadOut = {
            base: c0.oid,
            path,
            ...(orig !== undefined ? { orig } : {}),
            kind: un.kind,
            patch: un.patch,
            bytes: un.bytes,
            truncated: un.truncated,
            untracked: true,
          };
        } else {
          if (G.remaining() < GIT_PHASE_MIN_FOR_CONTENT_MS) throw new WtDeadlineError();
          const c4key = `${key}\0${path}\0${orig ?? ""}`;
          const acquired4 = c4Inflight.acquire(c4key, G, (exec) =>
            ps.withLoan(async () => {
              const argv = wtDiffArgs.diff(l1, n, c0.oid, path, orig);
              const r = okRun(
                "C4",
                await pinned.run("C4", argv, {
                  deadline: exec.deadline,
                  signal: exec.signal,
                  capMs: WTDIFF_GIT_CMD_MS,
                  maxStdoutBytes: WTDIFF_PATCH_MAX_BYTES,
                }),
              );
              if (isGitTooOldExit(argv, r.code)) throw new WtGitTooOldError();
              if (r.code !== 0) throwGitExit("C4", r, log);
              return { stdout: r.stdout, capped: r.capped };
            }),
          );
          let c4: C4Outcome;
          try {
            c4 = await raceSignal(acquired4.promise, signal);
          } finally {
            acquired4.release();
          }
          await l3Recheck(true); // C2 ran for this key and C4 executed (led or joined)
          payloadOut = buildFilePayload(c0.oid, path, orig, c4);
        }
        acc.ok = true;
        // the untracked branch already claimed `kind:"untracked"` — keep it (§2.9)
        if (acc.kind === undefined) acc.kind = payloadOut.kind;
        acc.bytes = payloadOut.bytes;
        acc.truncated = payloadOut.truncated || undefined;
        io.sendJson(res, 200, payloadOut, {
          "Cache-Control": "no-store",
          "Cross-Origin-Resource-Policy": "same-origin",
        });
      } catch (err) {
        if (signal.aborted || err instanceof WtAbortError) {
          if (abortAnswer()) return;
        }
        if (err instanceof WtBadRequestError) {
          acc.code = "E_BAD_REQUEST";
          send("E_BAD_REQUEST", { error: "E_BAD_REQUEST" });
        } else if (err instanceof WtNotFoundError) {
          acc.code = "E_NOT_FOUND";
          send("E_NOT_FOUND", { error: "E_NOT_FOUND" });
        } else if (err instanceof WtSessionChangedError) {
          acc.code = "E_SESSION_CHANGED";
          send("E_SESSION_CHANGED", { error: "E_SESSION_CHANGED" });
        } else if (err instanceof WtDeniedError) {
          acc.code = "E_WTDIFF_DENIED";
          acc.reason = err.reason;
          send("E_WTDIFF_DENIED", { error: "E_WTDIFF_DENIED", reason: err.reason });
        } else if (err instanceof WtUnsupportedError) {
          acc.code = "E_WTDIFF_UNSUPPORTED";
          acc.reason = err.reason;
          io.sendJson(res, err.status, { error: "E_WTDIFF_UNSUPPORTED", reason: err.reason }); // 415 unborn/symlink/filter-config · 503 git-unavailable/git-too-old
        } else if (err instanceof WtStaleError) {
          acc.code = "E_STALE_CTX";
          acc.reason = err.reason;
          send("E_STALE_CTX", { error: "E_STALE_CTX", reason: err.reason });
        } else if (err instanceof WtGitTooOldError) {
          acc.code = "E_WTDIFF_UNSUPPORTED";
          acc.reason = "git-too-old";
          io.sendJson(res, 503, { error: "E_WTDIFF_UNSUPPORTED", reason: "git-too-old" }); // §1.5: 129 ⇒ 503, not the table's 415
        } else if (err instanceof WtGitExitError) {
          acc.code = "E_INTERNAL";
          send("E_INTERNAL", { error: "E_INTERNAL" });
        } else if (err instanceof WtBusyError) {
          acc.code = "E_BUSY";
          acc.reason = err.reason;
          send("E_BUSY", { error: "E_BUSY", reason: err.reason }, { "Retry-After": "1" });
        } else if (err instanceof WtDeadlineError) {
          acc.code = "E_DEADLINE";
          send("E_DEADLINE", { error: "E_DEADLINE" });
        } else {
          acc.code = "E_INTERNAL";
          log.error("wtdiff route: unexpected pipeline failure", { error: String(err) });
          if (!res.headersSent && !res.destroyed) io.sendJson(res, 500, { error: "E_INTERNAL" });
          else res.destroy();
        }
      }
    })().catch(() => {
      // belt-and-braces: serve() never throws (every path above answers or destroys)
      if (!res.headersSent && !res.destroyed) io.sendJson(res, 500, { error: "E_INTERNAL" });
      else res.destroy();
    });

    try {
      await entry.done;
    } finally {
      // ⑬ 收尾 (fixed order): answer → bounded pin close (own 1 s each, no signal — a loan may
      // defer the actual close past this point, §1.10) → slots → active → the single audit line
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
        const record: Record<string, unknown> = { phase };
        for (const [k, v] of Object.entries(acc)) if (v !== undefined) record[k] = v;
        auditWorktreeDiff(log, record as unknown as WtDiffAuditRecord);
      }
    }
  }

  // -------------------------------------------------------------------------
  // payload builders (§3.1)
  // -------------------------------------------------------------------------

  function buildListPayload(
    value: ChangesetValue,
    numstat: Map<string, { add: number | null; del: number | null }>,
    numstatPartial: boolean,
  ): WtDiffFileList {
    let limitsBytes = false;
    const withCounts: WtDiffFileEntry[] = value.entries.map((e) => {
      if (e.status === "?" || e.filtered === true) return { ...e };
      const m = numstat.get(`${e.path}\0${e.orig ?? ""}`);
      if (m === undefined) return { ...e };
      if (m.add === null || m.del === null) return { ...e, binary: true as const };
      return { ...e, add: m.add, del: m.del };
    });
    // ⑫ byte budget: binary-search the longest prefix whose serialized body fits, then drop
    // the rest from the tail (limits.bytes) — the fit is judged on the COMPLETE payload shape
    // (limits/truncated/untrackedSkipped ride along and their bytes count too)
    const payloadBytes = (entries: WtDiffFileEntry[]): number =>
      byteLen(
        JSON.stringify({
          base: value.base,
          entries,
          total: value.totalVisible,
          truncated: true,
          limits: { status: value.limitsStatus, files: value.limitsFiles, bytes: true },
          ...(value.untrackedSkipped === true ? { untrackedSkipped: true } : {}),
        }),
      );
    const fits = (entries: WtDiffFileEntry[]): boolean => payloadBytes(entries) <= WTDIFF_LIST_BODY_MAX_BYTES;
    let entries = withCounts;
    if (!fits(entries)) {
      limitsBytes = true;
      let lo = 0;
      let hi = entries.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fits(entries.slice(0, mid))) lo = mid;
        else hi = mid - 1;
      }
      entries = entries.slice(0, Math.max(0, lo));
    }
    return {
      base: value.base,
      entries,
      total: value.totalVisible,
      truncated: entries.length < value.totalVisible || value.limitsStatus,
      limits: { status: value.limitsStatus, files: value.limitsFiles, bytes: limitsBytes },
      ...(value.untrackedSkipped === true ? { untrackedSkipped: true as const } : {}),
      ...(value.attrPartial === true ? { attrPartial: true as const } : {}),
      ...(numstatPartial ? { numstatPartial: true as const } : {}),
    };
  }

  function buildFilePayload(oid: string, path: string, orig: string | undefined, c4: C4Outcome): WtDiffFilePayload {
    let kind: "patch" | "binary" | "empty" = "empty";
    let patch = "";
    let truncated = false;
    if (c4.stdout.length > 0) {
      const firstHunk = c4.stdout.indexOf("@@");
      const head = firstHunk === -1 ? c4.stdout : c4.stdout.slice(0, firstHunk);
      if (/^Binary files .+ differ$/m.test(head) || /^GIT binary patch$/m.test(head)) {
        kind = "binary";
      } else if (firstHunk === -1) {
        kind = "empty"; // zero hunks: pure rename / mode-only / stat-reverted (§3.3)
      } else {
        kind = "patch";
        patch = c4.stdout;
        if (c4.capped) {
          truncated = true;
          const at = patch.lastIndexOf("\n");
          patch = at > 0 ? patch.slice(0, at) : patch;
          if (patch.endsWith("\uFFFD")) patch = patch.slice(0, -1); // the cap's half character
        }
      }
    }
    let payload: WtDiffFilePayload = {
      base: oid,
      path,
      ...(orig !== undefined ? { orig } : {}),
      kind,
      patch,
      bytes: byteLen(patch),
      truncated,
    };
    // ⑫ serialization cap — trim the patch from the tail, halving, until the body fits
    if (byteLen(JSON.stringify(payload)) > WTDIFF_FILE_BODY_MAX_BYTES) {
      let lines = patch.split("\n");
      while (lines.length > 1) {
        lines = lines.slice(0, Math.ceil(lines.length / 2));
        const cut = lines.join("\n");
        payload = { ...payload, patch: cut, bytes: byteLen(cut), truncated: true };
        if (byteLen(JSON.stringify(payload)) <= WTDIFF_FILE_BODY_MAX_BYTES) break;
      }
    }
    return payload;
  }

  const routes: WorktreeDiffRoutes = {
    mode,
    handleFiles: (req, res, query, io) => serve("files", req, res, query, io),
    handleFile: (req, res, query, io) => serve("file", req, res, query, io),
    dispose(reason: "close" | "startup-failure", deadline: ReqDeadline): Promise<void> {
      if (disposePromise !== undefined) return disposePromise; // idempotent; both paths share it
      closing = true;
      const waitMs = Math.max(0, Math.min(WTDIFF_DISPOSE_WAIT_MS, deadline.remaining()));
      disposePromise = (async (): Promise<void> => {
        changesetCache.abortAll("hub-close");
        c4Inflight.abortAll("hub-close");
        for (const e of [...active]) e.ctl.abort("hub-close");
        if (active.size > 0) {
          await Promise.race([Promise.allSettled([...active].map((e) => e.done)), unrefDelay(waitMs)]);
        }
      })();
      disposePromise.catch(() => undefined);
      return disposePromise;
    },
  };
  return routes;
}
