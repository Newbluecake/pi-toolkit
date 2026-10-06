/**
 * bash-jobs-panel plan §3.5 / D3-2 (包 A): the bounded tail sampler behind `StatusInfo.bashJobs`.
 *
 * Modeled on `worktree-sampler.ts` (single-flight, unref'd timers, generation discard) but
 * per-JOB, because a round covers the whole ≤20-row selection concurrently (R3-1: `perRound`
 * = the D1 row cap, per-job 2s deadline wrapping the WHOLE `readBashJobTail` call — both of its
 * internal `readOutput`s share the one deadline — so a batch's upper bound equals the per-job
 * bound and the "all ≤20 terminal rows current ≤3s" guarantee holds regardless of row count).
 *
 * Cadence (no resident interval of its own): `tick(now)` rides the wiring's existing 1Hz tick
 * and recomputes the needs-sample set from scratch every tick — pure memory, never kick memory
 * (D3-2). `kick(ids?)` (fingerprint edge / reconnect) only adds priority and requests a round.
 * Each row is read at most once per second (`minReadGapMs`, "每行 ≤1 次/秒、无忙等").
 *
 * Zombie discipline (v4 fix of R3 re-review #1): a read whose 2s deadline fired marks THAT JOB a
 * zombie; the job stays out of new rounds until its promise actually lands (landing results are
 * discarded by generation, but they clear the zombie and request a rerun). The zombie's I/O slot
 * has a HARD release at `hardReleaseMs` (10s) — the fs read cannot be cancelled, but the slot is
 * freed, so new generations can always make progress and only <10s-old reads count toward the
 * I/O bound: `maxZombies` (4) or more ACTIVE reads stop NEW rounds from starting.
 *
 * Source generations (D3-4 / R3-3): the port is NOT a captured manager — it is the late-bound
 * `source()` holder (`{gen, list, tail}`, `gen` = the manager instance, identity-compared). One
 * round takes the source ONCE and serves both its `list()` and every `tail()` from it (never
 * mixes generations); a landing whose generation no longer matches is dropped whole. Every
 * `tick`/`tails()`/`kick` reconciles the current source gen against the cache gen: on change the
 * cache is cleared, the generation is bumped (in-flight results die) and everything is re-kicked
 * (an old generation's zombies still count toward the I/O bound, per plan D3-4 ③). All sampling
 * I/O goes through the source (this module never imports `stack.ts`); `tails(gen)` is the
 * `readStatus`-time read and touches only the cache (hot path: zero I/O).
 */
import { isTerminalJobStatus, type JobRecord } from "../../bash/types.js";
import { selectJobs, type BashJobsTails, type SelectedBashJobs } from "./bash-jobs.js";
import { sanitizeTail } from "./redact.js";

/** What `readBashJobTail`-shaped ports return: `undefined` on failure, `text: undefined` on an
 *  empty-but-successful read. */
export interface BashJobsTailRead {
  readonly text: string | undefined;
  readonly logBytes: number;
}

/** D3-4's late-bound source: `gen` is the manager instance itself (identity comparison). */
export interface BashJobsSource {
  readonly gen: object;
  list(): readonly JobRecord[];
  tail(record: JobRecord): Promise<BashJobsTailRead | undefined>;
}

export interface BashJobsSamplerDeps {
  /** The holder port — NEVER a captured manager (`src/index.ts` re-reads `holder.current`). */
  source(): BashJobsSource | undefined;
  /** Store retention in ms (`() => settings.bashJobs.retentionMs`); `<= 0` disables the filter. */
  retentionMs(): number;
  now(): number;
  /** `conn?.status().state === "live"` — no fs reads while disconnected. */
  isLive(): boolean;
  /** Fired when a row's tail text / tailBytes / derived-current / unavailable flag changed. */
  onChange(): void;
  /** Per-job deadline wrapping the whole tail read (default 2s). */
  deadlineMs?: number;
  /** Running-row refresh cadence (default 10s). */
  runningEveryMs?: number;
  /** Rows per round (default 20 = the D1 cap, so one round covers the whole selection). */
  perRound?: number;
  /** ≥ this many ACTIVE (<hardReleaseMs) outstanding reads stop NEW rounds (default 4). */
  maxZombies?: number;
  /** Failed reads before `tailUnavailable` (default 3). */
  maxRetries?: number;
  /** Consecutive identical mismatching reads before `settled` (default 3). */
  settleRounds?: number;
  /** Per-row minimum gap between reads (default 1s — "每行 ≤1 次/秒"). */
  minReadGapMs?: number;
  /** Hard slot release age for a wedged read (default 10s). */
  hardReleaseMs?: number;
}

export interface BashJobsSampler {
  /** `readStatus`'s synchronous cache read for the given source generation. Zero I/O. On a gen
   *  mismatch it performs the D3-4 ③ reconcile (clear + generation bump + full re-kick) and
   *  returns `undefined`, so the projection's row set and tails can never mix generations. */
  tails(gen: object): BashJobsTails | undefined;
  /** Real change happened (fingerprint edge / reconnect): prioritize these rows and request a
   *  round now; in-flight or zombie-blocked ⇒ remembered as one pending rerun (immediate
   *  catch-up round on settlement, unref 0ms). */
  kick(ids?: Iterable<string>): void;
  /** Once per second from the host's 1Hz tick. Returns true iff this call synchronously changed
   *  observable cache state (source-generation reset) — completions publish through `onChange`. */
  tick(now: number): boolean;
  /** session_start: clear cache/kicks/generations and re-kick everything. */
  start(): void;
  /** session_shutdown / `/reload`-activation teardown: bump the generation (late results are
   *  discarded by generation, never applied), drop the cache and pending rerun. Outstanding
   *  reads' bookkeeping (zombie/active accounting) is left to decay on its own — their timers
   *  are unref'd and self-cleaning. */
  stop(): void;
}

interface CacheEntry {
  text?: string;
  /** File size the sample itself saw (footer-race sentinel). */
  logBytes: number;
  /** Agent clock when the sample landed; `undefined` on an unavailable-only entry. */
  at?: number;
  settled?: true;
  settledAtRecordLogBytes?: number;
  unavailableAtLogBytes?: number;
  /** Consecutive identical mismatching reads (settle accounting — internal only). */
  stableCount?: number;
}

interface ReadState {
  jobId: string;
  samplerGen: number;
  record: JobRecord;
  hardReleased: boolean;
  done: boolean;
  deadlineTimer?: { cancel(): void };
  hardTimer?: { cancel(): void };
}

interface Round {
  samplerGen: number;
  pending: Set<string>;
}

const DEFAULT_DEADLINE_MS = 2_000;
const DEFAULT_RUNNING_EVERY_MS = 10_000;
const DEFAULT_PER_ROUND = 20;
const DEFAULT_MAX_ZOMBIES = 4;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_SETTLE_ROUNDS = 3;
const DEFAULT_MIN_READ_GAP_MS = 1_000;
const DEFAULT_HARD_RELEASE_MS = 10_000;

export function createBashJobsSampler(deps: BashJobsSamplerDeps): BashJobsSampler {
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const runningEveryMs = deps.runningEveryMs ?? DEFAULT_RUNNING_EVERY_MS;
  const perRound = deps.perRound ?? DEFAULT_PER_ROUND;
  const maxZombies = deps.maxZombies ?? DEFAULT_MAX_ZOMBIES;
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
  const settleRounds = deps.settleRounds ?? DEFAULT_SETTLE_ROUNDS;
  const minReadGapMs = deps.minReadGapMs ?? DEFAULT_MIN_READ_GAP_MS;
  const hardReleaseMs = deps.hardReleaseMs ?? DEFAULT_HARD_RELEASE_MS;

  let generation = 0;
  let cache = new Map<string, CacheEntry>();
  let cacheGen: object | undefined;
  let kickAll = false;
  const kicked = new Set<string>();
  const failures = new Map<string, number>(); // consecutive failed reads, retry bookkeeping
  const lastReadAt = new Map<string, number>();
  let round: Round | undefined;
  const reads = new Map<string, ReadState>(); // every outstanding read, until it lands
  const zombies = new Map<string, number>(); // jobId → read startedAt; cleared only on landing
  let activeReads = 0; // outstanding reads younger than hardReleaseMs
  let pendingRerun = false;
  let stopped = false;
  let rerunTimer: { cancel(): void } | undefined;

  const unrefTimer = (ms: number, fn: () => void): { cancel(): void } => {
    const t = setTimeout(fn, ms);
    t.unref();
    return { cancel: () => clearTimeout(t) };
  };

  const clearRerunTimer = (): void => {
    rerunTimer?.cancel();
    rerunTimer = undefined;
  };

  /** D3-4 ③: source generation change — drop the cache, discard in-flight results (bump), and
   *  re-kick everything. The old round is DISSOLVED (single-flight is per-round, and the plan's
   * "新代永远能进展" means the new generation must not wait for the old round's settlement): its
   * reads stay tracked as zombies/active reads until they land, are discarded by generation, and
   * their landing requests the rerun. An old generation's zombies keep counting toward the I/O
   * bound until they land or hard-release. */
  const resetForGen = (gen: object): void => {
    generation += 1;
    cache = new Map();
    failures.clear();
    cacheGen = gen;
    kickAll = true;
    kicked.clear();
    pendingRerun = false;
    round = undefined;
  };

  const tryConsumeRerun = (): void => {
    if (!pendingRerun) return;
    pendingRerun = false;
    attemptRound();
  };

  /** D3-2 needs-sample verdict, recomputed from scratch every call (never kick memory). */
  const needsSample = (record: JobRecord, now: number): boolean => {
    const id = record.jobId;
    const c = cache.get(id);
    if (c?.unavailableAtLogBytes !== undefined) return record.logBytes !== c.unavailableAtLogBytes;
    if (failures.has(id)) return true; // retry pending after a failed read
    if (c === undefined) return true; // no cache
    if (c.settled) return record.logBytes !== c.settledAtRecordLogBytes;
    if (c.logBytes !== record.logBytes) return true; // file size seen ≠ record (footer race, R3-2)
    if (isTerminalJobStatus(record.status)) return (c.at ?? 0) < (record.endedAt ?? record.createdAt);
    return now - (c.at ?? 0) >= runningEveryMs;
  };

  /** Single-flight round attempt. Order: kicked rows → terminal not-current → running due. */
  const attemptRound = (src?: BashJobsSource, selected?: SelectedBashJobs): void => {
    if (stopped) return;
    if (round !== undefined || activeReads >= maxZombies) {
      pendingRerun = true; // remembered: catch-up round on settlement, or resume after landing
      return;
    }
    if (!deps.isLive()) return;
    const source = src ?? deps.source();
    if (source === undefined) return;
    if (source.gen !== cacheGen) resetForGen(source.gen);
    const now = deps.now();
    const sel = selected ?? selectJobs(source.list(), now, deps.retentionMs());
    const kickedRows: JobRecord[] = [];
    const terminalDue: JobRecord[] = [];
    const runningDue: JobRecord[] = [];
    for (const r of sel.rows) {
      if (zombies.has(r.jobId) || reads.has(r.jobId)) continue;
      const last = lastReadAt.get(r.jobId);
      if (last !== undefined && now - last < minReadGapMs) continue; // ≤1 read/s/row
      if (!needsSample(r, now)) continue;
      const bucket = isTerminalJobStatus(r.status) ? terminalDue : runningDue;
      (kickAll || kicked.has(r.jobId) ? kickedRows : bucket).push(r);
    }
    kickAll = false;
    kicked.clear();
    const batch = [...kickedRows, ...terminalDue, ...runningDue].slice(0, perRound);
    if (batch.length === 0) return;
    round = { samplerGen: generation, pending: new Set(batch.map((r) => r.jobId)) };
    for (const r of batch) {
      lastReadAt.set(r.jobId, now);
      launchRead(source, r);
    }
  };

  const launchRead = (source: BashJobsSource, record: JobRecord): void => {
    const jobId = record.jobId;
    const state: ReadState = { jobId, samplerGen: generation, record, hardReleased: false, done: false };
    state.deadlineTimer = unrefTimer(deadlineMs, () => {
      if (state.done) return;
      // 2s deadline: this JOB becomes a zombie until its promise lands; the round no longer
      // waits for it (per-batch bound = per-job bound = deadlineMs, R3-1).
      zombies.set(jobId, deps.now());
      round?.pending.delete(jobId);
      settleRoundIfEmpty();
    });
    state.hardTimer = unrefTimer(hardReleaseMs, () => {
      if (state.done) return;
      state.hardReleased = true; // hard slot release — the read still counts as a zombie
      activeReads -= 1;
    });
    reads.set(jobId, state);
    activeReads += 1;
    void Promise.resolve(source.tail(record)).then(
      (res) => onReadLanded(state, res),
      () => onReadLanded(state, undefined),
    );
  };

  const settleRoundIfEmpty = (): void => {
    if (round === undefined || round.pending.size > 0) return;
    round = undefined;
    if (pendingRerun) {
      pendingRerun = false;
      clearRerunTimer();
      // Immediate catch-up round (unref 0ms) — "轮结算后立即起追赶轮".
      rerunTimer = unrefTimer(0, () => {
        rerunTimer = undefined;
        attemptRound();
      });
    }
  };

  const onReadLanded = (state: ReadState, res: BashJobsTailRead | undefined): void => {
    if (state.done) return;
    state.done = true;
    state.deadlineTimer?.cancel();
    state.hardTimer?.cancel();
    reads.delete(state.jobId);
    if (!state.hardReleased) activeReads -= 1;
    zombies.delete(state.jobId);
    round?.pending.delete(state.jobId);
    settleRoundIfEmpty();
    if (state.samplerGen !== generation) {
      // Late result from a previous generation (source switch / stop): discard, but request a
      // rerun so the current generation makes progress.
      pendingRerun = true;
      tryConsumeRerun();
      return;
    }
    const jobId = state.jobId;
    if (res === undefined) {
      const count = (failures.get(jobId) ?? 0) + 1;
      if (count >= maxRetries) {
        failures.delete(jobId);
        const prev = cache.get(jobId);
        if (prev === undefined) {
          // Never had a good sample: an unavailable-only entry carries no at/tail — the wire row
          // shows just `tailUnavailable` (D3-2: the row is never tailCurrent).
          cache.set(jobId, { logBytes: 0, unavailableAtLogBytes: state.record.logBytes });
        } else {
          cache.set(jobId, { ...prev, unavailableAtLogBytes: state.record.logBytes });
        }
        deps.onChange(); // the row gains tailUnavailable
      } else {
        failures.set(jobId, count); // retry on a later tick (paced by minReadGapMs)
      }
      return;
    }
    failures.delete(jobId);
    const prev = cache.get(jobId);
    const newEntry: CacheEntry = {
      logBytes: res.logBytes,
      at: deps.now(),
      ...(res.text !== undefined ? { text: sanitizeTail(res.text, res.logBytes) } : {}),
    };
    // Settle accounting (D3-2): only a file-size MISMATCH can loop; `settleRounds` consecutive
    // identical outcomes (same sanitized text, same seen size) ⇒ settled — treated as current,
    // no more reads until record.logBytes moves again.
    if (res.logBytes !== state.record.logBytes) {
      const stable =
        prev !== undefined && prev.logBytes === res.logBytes && prev.text === newEntry.text
          ? (prev.stableCount ?? 0) + 1
          : 1;
      newEntry.stableCount = stable;
      if (stable >= settleRounds) {
        newEntry.settled = true;
        newEntry.settledAtRecordLogBytes = state.record.logBytes;
      }
    }
    const changed =
      prev === undefined ||
      prev.text !== newEntry.text ||
      prev.logBytes !== newEntry.logBytes ||
      prev.settled !== newEntry.settled ||
      prev.unavailableAtLogBytes !== undefined;
    cache.set(jobId, newEntry);
    if (changed) deps.onChange();
    // A landing (zombie or not) may be exactly what unblocked a remembered rerun (verifier W3
    // review #1 precedent): consume it here so the current generation keeps progressing.
    tryConsumeRerun();
  };

  return {
    tails(gen: object): BashJobsTails | undefined {
      if (gen !== cacheGen) {
        resetForGen(gen);
        return undefined;
      }
      return cache;
    },

    kick(ids?: Iterable<string>): void {
      if (ids === undefined) {
        kickAll = true;
        kicked.clear();
      } else {
        for (const id of ids) kicked.add(id);
      }
      attemptRound();
    },

    tick(now: number): boolean {
      const src = deps.source();
      if (src === undefined) return false;
      let changed = false;
      if (src.gen !== cacheGen) {
        resetForGen(src.gen);
        changed = true;
      }
      const selected = selectJobs(src.list(), now, deps.retentionMs());
      // Cache keeps ONLY currently selected jobIds — a retention-expired row's tail vanishes in
      // the same frame as the row itself (D1). `reads`/`zombies` are pruned too: a wedged fs
      // read that NEVER lands would otherwise keep its zombie entry forever, permanently
      // excluding that job from every new round (hardening; the slot itself still
      // hard-releases at `hardReleaseMs` via the read's own unref'd timer).
      const ids = new Set(selected.rows.map((r) => r.jobId));
      for (const id of [...cache.keys(), ...failures.keys(), ...lastReadAt.keys()]) {
        if (!ids.has(id)) {
          cache.delete(id);
          failures.delete(id);
          lastReadAt.delete(id);
        }
      }
      for (const id of [...reads.keys()]) {
        if (!ids.has(id)) {
          reads.delete(id);
          zombies.delete(id);
        }
      }
      attemptRound(src, selected);
      return changed;
    },

    start(): void {
      generation += 1;
      cache = new Map();
      failures.clear();
      cacheGen = undefined;
      kicked.clear();
      kickAll = true;
      pendingRerun = false;
      stopped = false;
      clearRerunTimer();
      attemptRound();
    },

    stop(): void {
      generation += 1;
      cache = new Map();
      failures.clear();
      cacheGen = undefined;
      kicked.clear();
      kickAll = false;
      pendingRerun = false;
      stopped = true;
      round = undefined;
      clearRerunTimer();
    },
  };
}
