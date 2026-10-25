/**
 * merged-plan r3 §3 (P2): the hub-side "merged branch" (M) phase of `GET /api/worktree-graph?merged=1`.
 *
 * Runs AFTER `projectGraph` in the same request, with its own independent budget `M`
 * (`WTGRAPH_MERGED_PHASE_MS`, split head / loop / tail — §3.4). Everything git-facing goes through
 * the shared pinned executor (`PinnedGit`) with argv from `wtGraphArgs.*` only:
 *
 * - head: Cc driver scan + `info/attributes` read ⇒ `sig0` (the L2 driver set and the cache key's
 *   attribute signature). Any head failure ⇒ whole-phase `skipped`.
 * - loop: per DISTINCT selected tip (≤ `WTGRAPH_MERGED_MAX`), a `SingleFlightCache` lookup. A miss
 *   runs Gm (`rev-list --cherry-mark --right-only <HEAD>...<tip> --`) under `ps.withLoan`, then
 *   re-checks `info/attributes` bytes + the `shallow` boundary BEFORE the value may be cached
 *   (the check is "detect and discard": it cannot undo an execution that already happened).
 * - tail: one more info/attributes + shallow check over the whole phase (cache hits included);
 *   a change or an unconfirmable step discards every verdict (`skipped`) and evicts this
 *   request's cache keys. Skipped when no tip produced a verdict (nothing to discard).
 *
 * Every failure is UNKNOWN, never "merged". Pure helpers (`mergedCandidates`, `buildMergedBranches`,
 * `finalizeMergedPayload`) carry no fs/git so they can be tested without a runner.
 */

import { attrSigOf, readProcFdFile, type PinnedGit, type PinSet } from "../worktree-diff/git.js";
import type { SingleFlightCache, SharedExec } from "../worktree-diff/changeset.js";
import type { HubLog } from "../ports.js";
import { createReqDeadline, type ReqDeadline } from "../req-deadline.js";
import type { PreviewFs } from "../preview/admit.js";
import { isPreviewIoError, previewFsStep, type PreviewIoTracker } from "../preview/fs.js";
import { classifyGraphExit, parseCherryMark, wtGraphArgs } from "../../../git/graph.js";
import { WTDIFF_DRIVER_NAME_RE, driverNamesFromAttributes, parseDriverScan } from "../../../git/diff.js";
import {
  WTGRAPH_BODY_MAX_BYTES,
  WTGRAPH_CHERRY_MAX_BYTES,
  WTGRAPH_CHERRY_MS,
  WTGRAPH_MERGED_E_MAX,
  WTGRAPH_MERGED_MAX,
  WTGRAPH_MERGED_PHASE_MS,
  WTGRAPH_MERGED_TAIL_MS,
  type WtGraphCommit,
  type WtGraphMerged,
  type WtGraphMergedEntry,
  type WtGraphMergedSkip,
  type WtGraphMergedUnknown,
  type WtGraphPayload,
} from "../../protocol/worktree-graph.js";
import { WTDIFF_DRIVERS_MAX, WTDIFF_STEP_MS } from "../../protocol/worktree-diff.js";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** §3.6 cache bounds: TTL 10 min, LRU 1024, 1 MiB total, 16 KiB per item. */
export const WTGRAPH_MERGED_CACHE_TTL_MS = 10 * 60_000;
export const WTGRAPH_MERGED_CACHE_LRU = 1024;
export const WTGRAPH_MERGED_CACHE_BYTES = 1024 * 1024;
export const WTGRAPH_MERGED_CACHE_ITEM_BYTES = 16 * 1024;
/** §3.4 loop: fewer than this much loop budget left ⇒ the candidate is `unk:"budget"`. */
export const WTGRAPH_MERGED_MIN_STEP_MS = 250;
/** Cc stdout and info/attributes read bounds — same numbers as wtdiff's local constants. */
const DRIVER_SCAN_MAX_BYTES = 64 * 1024;
const INFO_ATTRS_MAX_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// pure: candidates (§3.2)
// ---------------------------------------------------------------------------

export interface MergedCandidate {
  n: string;
  h: string;
  /** checked out by ANY worktree row (self included) — labelled, never excluded */
  co: boolean;
}

/** Commits reachable from `start` inside the window (exact: date-order prefixes are closed under
 * children, so any path between two in-window nodes stays in-window). `start ∉ window` ⇒ ∅. */
export function ancestorsInWindow(commits: readonly WtGraphCommit[], start: string): Set<string> {
  const byOid = new Map<string, WtGraphCommit>();
  for (const c of commits) byOid.set(c.h, c);
  const seen = new Set<string>();
  if (!byOid.has(start)) return seen;
  const stack = [start];
  seen.add(start);
  while (stack.length > 0) {
    const c = byOid.get(stack.pop()!);
    if (c === undefined) continue;
    for (const p of c.p) {
      if (!seen.has(p) && byOid.has(p)) {
        seen.add(p);
        stack.push(p);
      }
    }
  }
  return seen;
}

/**
 * §3.2: candidates are the POST-projection payload's branch refs whose tip is a window commit,
 * minus the HEAD branch / HEAD oid / window ancestors of HEAD; ordered by window row (newest
 * first). The first `WTGRAPH_MERGED_MAX` are selected, the rest only counted in `omitted`.
 */
export function mergedCandidates(
  payload: WtGraphPayload,
  rows: readonly { branch?: string | undefined }[],
): { selected: MergedCandidate[]; omitted: number } {
  const head = payload.head;
  if (head === undefined) return { selected: [], omitted: 0 };
  const rowOf = new Map<string, number>();
  payload.commits.forEach((c, i) => rowOf.set(c.h, i));
  const anc = ancestorsInWindow(payload.commits, head.h);
  const checkedOut = new Set<string>();
  for (const r of rows) if (r.branch !== undefined) checkedOut.add(r.branch);
  const all: Array<MergedCandidate & { row: number; order: number }> = [];
  payload.refs.forEach((r, order) => {
    if (r.k !== "branch") return;
    const row = rowOf.get(r.h);
    if (row === undefined) return;
    if (r.n === head.b || r.h === head.h || anc.has(r.h)) return;
    all.push({ n: r.n, h: r.h, co: checkedOut.has(r.n), row, order });
  });
  all.sort((a, b) => a.row - b.row || a.order - b.order);
  const selected = all.slice(0, WTGRAPH_MERGED_MAX).map(({ n, h, co }) => ({ n, h, co }));
  return { selected, omitted: all.length - selected.length };
}

// ---------------------------------------------------------------------------
// pure: entries + byte policy (§3.4 判定 / 字节)
// ---------------------------------------------------------------------------

/** What one Gm run (or cache hit) yields: `eq` = patch-equivalent right-side oids, `plus` = count. */
export interface MergedValue {
  eq: string[];
  plus: number;
}

export type TipOutcome = { ok: true; value: MergedValue } | { ok: false; why: WtGraphMergedUnknown };

/**
 * Verdict per selected candidate. `t = |eq|+|plus|`, `k = |eq|`: t=0 ⇒ anc; k=t ⇒ eq; 0<k<t ⇒
 * part (+ `e` = eq ∩ window, only on the FIRST entry of the tip, globally ≤ `WTGRAPH_MERGED_E_MAX`
 * elements — a truncated list is marked `eP`); k=0 ⇒ none. A tip without an outcome is `unk`.
 */
export function buildMergedBranches(
  selected: readonly MergedCandidate[],
  outcomes: ReadonlyMap<string, TipOutcome>,
  commits: ReadonlySet<string>,
): WtGraphMergedEntry[] {
  const out: WtGraphMergedEntry[] = [];
  const firstOfTip = new Map<string, WtGraphMergedEntry>();
  let eBudget = WTGRAPH_MERGED_E_MAX;
  for (const c of selected) {
    const o = outcomes.get(c.h);
    let entry: WtGraphMergedEntry;
    if (o === undefined || !o.ok) {
      entry = { n: c.n, h: c.h, v: "unk", why: o === undefined ? "budget" : o.why };
    } else {
      const k = o.value.eq.length;
      const t = k + o.value.plus;
      if (t === 0) entry = { n: c.n, h: c.h, v: "anc" };
      else if (k === t) entry = { n: c.n, h: c.h, v: "eq", k, t };
      else if (k === 0) entry = { n: c.n, h: c.h, v: "none", k, t };
      else {
        entry = { n: c.n, h: c.h, v: "part", k, t };
        const first = firstOfTip.get(c.h);
        if (first === undefined) {
          const inWindow = o.value.eq.filter((oid) => commits.has(oid));
          const kept = inWindow.slice(0, eBudget);
          eBudget -= kept.length;
          if (kept.length > 0) entry.e = kept;
          if (kept.length < inWindow.length) entry.eP = true;
        } else if (first.eP === true) {
          entry.eP = true;
        }
      }
    }
    if (c.co) entry.co = true;
    if (!firstOfTip.has(c.h)) firstOfTip.set(c.h, entry);
    out.push(entry);
  }
  return out;
}

function bodyBytes(p: WtGraphPayload): number {
  return Buffer.byteLength(JSON.stringify(p), "utf8");
}

/**
 * R2-2: attach `merged` to the payload and enforce the 512 KiB cap on the COMPLETE response. Over
 * the cap ⇒ drop every `e` (part entries marked `eP`), still over ⇒ `skipped:"bytes"`.
 */
export function finalizeMergedPayload(
  payload: WtGraphPayload,
  merged: WtGraphMerged,
  maxBytes: number = WTGRAPH_BODY_MAX_BYTES,
): WtGraphPayload {
  let candidate: WtGraphPayload = { ...payload, merged };
  if (bodyBytes(candidate) <= maxBytes) return candidate;
  const stripped: WtGraphMerged = {
    ...merged,
    branches: merged.branches.map((b) => {
      if (b.v !== "part") return b;
      const { e: _e, ...rest } = b;
      return { ...rest, eP: true as const };
    }),
  };
  candidate = { ...payload, merged: stripped };
  if (bodyBytes(candidate) <= maxBytes) return candidate;
  const skipped: WtGraphMerged = {
    v: 1,
    ...(merged.base === undefined ? {} : { base: merged.base }),
    skipped: "bytes",
    branches: [],
  };
  return { ...payload, merged: skipped };
}

// ---------------------------------------------------------------------------
// internal typed signals
// ---------------------------------------------------------------------------

/** A per-tip failure ⇒ `unk:<why>`; never cached (the cache stores only on compute success). */
class MergedTipFailure extends Error {
  constructor(readonly why: WtGraphMergedUnknown) {
    super(why);
  }
}
/** Gm's per-tip recheck failed (info/attributes changed / `shallow` appeared / unreadable). */
export class MergedRecheckError extends MergedTipFailure {
  constructor() {
    super("attr-changed");
  }
}
/** A whole-phase failure raised from inside a (possibly shared) execution. */
class MergedSkipError extends Error {
  constructor(readonly skip: WtGraphMergedSkip) {
    super(skip);
  }
}
/** The request itself was aborted (client disconnect / hub close) — the route answers it. */
export class MergedAbortError extends Error {}
class MergedOwnTimeout extends Error {}

// ---------------------------------------------------------------------------
// fs probes (all through previewFsStep, never a raw fs call)
// ---------------------------------------------------------------------------

type ProbeFail = "io" | "deadline" | "abort" | "busy";
type InfoRead = { ok: true; bytes: Buffer; complete: boolean } | { ok: false; kind: ProbeFail };

async function readInfoAttrs(
  fs: PreviewFs,
  deps: { tracker: PreviewIoTracker; now(): number },
  commonFd: number,
  deadline: ReqDeadline,
  signal: AbortSignal | undefined,
): Promise<InfoRead> {
  const r = await readProcFdFile(
    fs,
    deps,
    `/proc/self/fd/${commonFd}/info/attributes`,
    INFO_ATTRS_MAX_BYTES,
    deadline,
    signal,
  );
  if (r.ok) return { ok: true, bytes: r.bytes, complete: r.complete };
  if (r.kind === "enoent") return { ok: true, bytes: Buffer.alloc(0), complete: true }; // ENOENT = empty file
  return { ok: false, kind: r.kind };
}

type ShallowProbe = { state: "absent" | "present" } | { state: "fail"; kind: ProbeFail };

async function probeShallow(
  fs: PreviewFs,
  deps: { tracker: PreviewIoTracker; now(): number },
  commonFd: number,
  deadline: ReqDeadline,
  signal: AbortSignal | undefined,
): Promise<ShallowProbe> {
  try {
    await previewFsStep(() => fs.stat(`/proc/self/fd/${commonFd}/shallow`), deadline, signal, {
      now: deps.now,
      tracker: deps.tracker,
      stepCapMs: WTDIFF_STEP_MS,
    });
    return { state: "present" };
  } catch (err) {
    if (isPreviewIoError(err)) return { state: "fail", kind: err.ioFail };
    if ((err as { code?: unknown }).code === "ENOENT") return { state: "absent" };
    return { state: "fail", kind: "io" };
  }
}

// ---------------------------------------------------------------------------
// the phase
// ---------------------------------------------------------------------------

export interface MergedStats {
  /** selected candidates */
  cand: number;
  omitted: number;
  /** Gm spawns made by THIS request as the leader */
  run: number;
  /** cache hits */
  hit: number;
  unk: number;
  skip: 0 | 1;
  ms: number;
}

export interface MergedPhaseDeps {
  pinned: PinnedGit;
  ps: PinSet;
  fs: PreviewFs;
  tracker: PreviewIoTracker;
  now(): number;
  signal: AbortSignal;
  cache: SingleFlightCache<MergedValue>;
  log: Pick<HubLog, "warn">;
}

export interface MergedPhaseInput {
  /** the POST-`projectGraph` payload (only what is really sent is considered) */
  payload: WtGraphPayload;
  rows: readonly { branch?: string | undefined }[];
  shallow: boolean;
}

export interface MergedPhaseResult {
  merged: WtGraphMerged;
  stats: MergedStats;
}

function loopDeadline(m: ReqDeadline, reserveMs: number): ReqDeadline {
  return {
    at: m.at - reserveMs,
    remaining: () => Math.max(0, m.remaining() - reserveMs),
    expired: () => m.remaining() <= reserveMs,
  };
}

/** Join/lead wait: resolves with the shared result, rejects on the caller's OWN deadline
 * (`MergedOwnTimeout`) or request abort (`MergedAbortError`). Timers are unref'd. */
function awaitShared<T>(p: Promise<T>, own: ReqDeadline, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new MergedAbortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = (): void => finish(() => reject(new MergedAbortError()));
    const timer = setTimeout(() => finish(() => reject(new MergedOwnTimeout())), own.remaining());
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => finish(() => resolve(v)),
      (e: unknown) => finish(() => reject(e)),
    );
  });
}

export async function runMergedPhase(deps: MergedPhaseDeps, input: MergedPhaseInput): Promise<MergedPhaseResult> {
  const { pinned, ps, fs, tracker, now, signal, cache, log } = deps;
  const { payload, rows, shallow } = input;
  const startedAt = now();
  const stats: MergedStats = { cand: 0, omitted: 0, run: 0, hit: 0, unk: 0, skip: 0, ms: 0 };
  const done = (merged: WtGraphMerged): MergedPhaseResult => {
    stats.skip = merged.skipped === undefined ? 0 : 1;
    stats.unk = merged.branches.filter((b) => b.v === "unk").length;
    stats.ms = Math.max(0, now() - startedAt);
    return { merged, stats };
  };
  const skip = (reason: WtGraphMergedSkip, base?: string): MergedPhaseResult =>
    done({ v: 1, ...(base === undefined ? {} : { base }), skipped: reason, branches: [] });

  // §3.1 triggers: no head / empty ⇒ no-head (no base); shallow ⇒ shallow (with base)
  const head = payload.head;
  if (head === undefined || payload.empty === true) return skip("no-head");
  const base = head.h;
  if (shallow) return skip("shallow", base);

  const { selected, omitted } = mergedCandidates(payload, rows);
  stats.cand = selected.length;
  stats.omitted = omitted;
  if (selected.length === 0) return done({ v: 1, base, branches: [] });

  const format = payload.format;
  const M = createReqDeadline(now, WTGRAPH_MERGED_PHASE_MS);
  const L = loopDeadline(M, WTGRAPH_MERGED_TAIL_MS);
  const commonFd = ps.pins.common.fd;
  const io = { tracker, now };

  // ---- head: Cc + info/attributes ⇒ driver set + sig0 ---------------------------------------
  const cc = await pinned.run("Cc", wtGraphArgs.driverScan(), {
    deadline: L,
    signal,
    capMs: WTDIFF_STEP_MS,
    maxStdoutBytes: DRIVER_SCAN_MAX_BYTES,
  });
  if (!cc.ok) {
    if (cc.kind === "abort" || signal.aborted) throw new MergedAbortError();
    return skip("unconfirmed", base);
  }
  if (cc.code === 129) return skip("git-too-old", base);
  if (cc.code !== 0 && cc.code !== 1) return skip("unconfirmed", base); // exit 1 = "no match"
  const scan = parseDriverScan(cc.stdout, cc.capped);
  if ("unsafe" in scan) return skip("filter-config", base);
  const info0r = await readInfoAttrs(fs, io, commonFd, L, signal);
  if (!info0r.ok) {
    if (info0r.kind === "abort" || signal.aborted) throw new MergedAbortError();
    return skip(info0r.kind === "io" ? "filter-config" : "unconfirmed", base);
  }
  if (!info0r.complete) return skip("filter-config", base); // > 64 KiB
  const info0 = info0r.bytes;
  const attrNames = driverNamesFromAttributes(info0.toString("utf8"));
  if ("unsafe" in attrNames) return skip("filter-config", base);
  const drivers = [...new Set([...scan.names, ...attrNames.names])].sort();
  // wtGraphArgs.cherry THROWS on an unsafe name — validate the whole union first (never widened here)
  if (drivers.length > WTDIFF_DRIVERS_MAX || !drivers.every((d) => WTDIFF_DRIVER_NAME_RE.test(d))) {
    return skip("filter-config", base);
  }
  const sig0 = attrSigOf(info0, drivers);

  // ---- loop ---------------------------------------------------------------------------------
  const keyOf = (tip: string): string =>
    [`${ps.ids.common.dev}:${ps.ids.common.ino}`, format, base, tip, sig0].join("\0");

  /** per-Gm recheck: info/attributes bytes unchanged AND no `shallow` boundary — only then may the
   * value be returned (and so cached). */
  const recheck = async (exec: SharedExec): Promise<void> => {
    const info = await readInfoAttrs(fs, io, commonFd, exec.deadline, exec.signal);
    // an unreadable / unconfirmable recheck step: budget-limited ⇒ "budget", else "timeout"
    const unconfirmed = (): MergedTipFailure =>
      new MergedTipFailure(exec.deadline.remaining() <= 0 ? "budget" : "timeout");
    if (!info.ok) throw info.kind === "io" ? new MergedRecheckError() : unconfirmed();
    if (!info.complete || !info.bytes.equals(info0)) throw new MergedRecheckError();
    const sh = await probeShallow(fs, io, commonFd, exec.deadline, exec.signal);
    if (sh.state === "present") throw new MergedRecheckError();
    if (sh.state === "fail") throw sh.kind === "io" ? new MergedRecheckError() : unconfirmed();
  };

  const computeFor =
    (tip: string) =>
    (exec: SharedExec): Promise<MergedValue> =>
      ps.withLoan(async () => {
        if (exec.deadline.remaining() < WTGRAPH_MERGED_MIN_STEP_MS) throw new MergedTipFailure("budget");
        let argv: string[];
        try {
          argv = wtGraphArgs.cherry(base, tip, format, drivers);
        } catch {
          throw new MergedTipFailure("git-failed"); // caller bug — fail closed, never "skip and run"
        }
        stats.run += 1;
        const r = await pinned.run("Gm", argv, {
          captureStderr: true,
          deadline: exec.deadline,
          signal: exec.signal,
          capMs: WTGRAPH_CHERRY_MS,
          maxStdoutBytes: WTGRAPH_CHERRY_MAX_BYTES,
        });
        if (!r.ok) {
          if (r.kind === "deadline") throw new MergedTipFailure(exec.deadline.remaining() <= 0 ? "budget" : "timeout");
          if (r.kind === "busy") throw new MergedTipFailure("budget");
          if (r.kind === "abort") throw new MergedTipFailure("timeout");
          throw new MergedSkipError("unconfirmed"); // git-unavailable / pin-mismatch
        }
        // capped BEFORE exit code: an overflow kill's exit status must never be misread
        if (r.capped) throw new MergedTipFailure("too-many");
        if (r.code !== 0) {
          const reason = classifyGraphExit(r.code, r.stderr ?? "");
          if (reason === "git-too-old") throw new MergedSkipError("git-too-old");
          throw new MergedTipFailure(reason === "missing-object" ? "missing-object" : "git-failed");
        }
        const parsed = parseCherryMark(r.stdout, false, format);
        if ("bad" in parsed) throw new MergedTipFailure("git-failed");
        await recheck(exec);
        return { eq: parsed.eq, plus: parsed.plus.length };
      });

  const outcomes = new Map<string, TipOutcome>();
  const touched: string[] = [];
  const throwIfAborted = (): void => {
    if (signal.aborted) throw new MergedAbortError();
  };
  for (const cand of selected) {
    if (outcomes.has(cand.h)) continue; // same tip ⇒ one Gm
    throwIfAborted();
    const key = keyOf(cand.h);
    const acquired = cache.acquire(key, L, computeFor(cand.h));
    touched.push(key);
    if (acquired.cached) stats.hit += 1;
    try {
      const value = await awaitShared(acquired.promise, L, signal);
      outcomes.set(cand.h, { ok: true, value });
    } catch (err) {
      throwIfAborted();
      if (err instanceof MergedSkipError) return skip(err.skip, base);
      if (err instanceof MergedTipFailure) outcomes.set(cand.h, { ok: false, why: err.why });
      else if (err instanceof MergedOwnTimeout) outcomes.set(cand.h, { ok: false, why: "timeout" });
      else outcomes.set(cand.h, { ok: false, why: "git-failed" });
    } finally {
      acquired.release(); // exactly once per acquire; the last leaver aborts an abandoned execution
    }
  }

  // ---- tail: whole-phase recheck (cache hits included) -------------------------------------
  if ([...outcomes.values()].some((o) => o.ok)) {
    const discard = (reason: "attr-changed" | "shallow" | "unconfirmed"): MergedPhaseResult => {
      for (const k of touched) cache.drop(k);
      log.warn("wtgraph merged results discarded", { event: "wtgraph.merged_discarded", reason });
      return skip(reason, base);
    };
    const t1 = await readInfoAttrs(fs, io, commonFd, M, signal);
    if (!t1.ok) {
      if (t1.kind === "abort" || signal.aborted) throw new MergedAbortError();
      return discard("unconfirmed");
    }
    if (!t1.complete || !t1.bytes.equals(info0)) return discard("attr-changed");
    const t2 = await probeShallow(fs, io, commonFd, M, signal);
    if (t2.state === "fail") {
      if (t2.kind === "abort" || signal.aborted) throw new MergedAbortError();
      return discard("unconfirmed");
    }
    if (t2.state === "present") return discard("shallow");
  }

  const commits = new Set(payload.commits.map((c) => c.h));
  const branches = buildMergedBranches(selected, outcomes, commits);
  return done({ v: 1, base, branches, ...(omitted > 0 ? { omitted } : {}) });
}
