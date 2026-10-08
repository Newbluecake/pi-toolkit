/**
 * web-hub session-history plan §4.5.3 (`generation.ts`) + v3.2 V1 / v3.3 W1-W2 amendments: the
 * continuable-enumeration scan generation. Directories are pinned by fd at first open (E8) and
 * NEVER re-walked by path; the cursor (`cursorDir` + `pending.next`) survives across requests so
 * a budget-truncated enumeration always converges instead of restarting; a per-gen FIFO
 * cancellable lock (`lock.ts`) serializes every state mutation, with "stage locally, recheck
 * `disposed()`, commit once" discipline (X3 #3) so a request whose wait/IO outlives the
 * service's `dispose()` can never write through a closed fd.
 *
 * Verifier rejection (round 2) fixes folded in here:
 * - Finding 1 (late fds): every `open()` call site (`createGen`'s root open, `runAdvance`'s dir
 *   open) routes through `budget.ts`'s `boundedFdOpen`; every `close()` routes through
 *   `boundedClose`.
 * - Finding 4 (c1): `runAdvance` never writes any `gen.*` field directly while its loop runs —
 *   every mutation accumulates into a local staged mirror, `isValid(gen)` is rechecked after
 *   every await (the SAME discipline the previous pass already had, now made explicit/auditable
 *   via a single `commit()` choke point), and a validity failure `abandon()`s the call writing
 *   NOTHING to `gen.*` (closing/releasing only the fd THIS call itself opened fresh — a
 *   pre-existing `gen.rootHandle`/`gen.pending` inherited from an earlier committed call is
 *   `dispose()`'s job, never this call's).
 * - Finding 4 (c2): `GenHandle.commitPaging()` gives `index.ts`'s per-file paging loop the SAME
 *   lock protection `runAdvance` already has — every `recordX()`/sort/`markPaged` mutation now
 *   goes through the gen lock instead of running completely unguarded.
 * - Finding 6 (half): `closeGenFds`/`GenStore.dispose()` route through `boundedClose`.
 *   `GenStore` additionally exposes `retireAll()`/`hasActiveLeases()` so `service.ts`'s
 *   dispose() can wait for active leases to drain under ONE shared hard deadline before forcing
 *   anything closed — `GenStore.dispose()` itself stays the simple, immediate, idempotent
 *   force-close primitive it always was (generation.test.ts calls it directly with no waiting).
 *
 * Verifier round 3 fixes folded in here:
 * - Defect 2: `commit()` itself rechecks `isValid(gen)` AFTER whatever await preceded it and
 *   BEFORE the first `gen.*` write — the commits that follow an awaited close (the pending
 *   close, the filesTruncated close) discard their entire staged mirror and end `partial busy`
 *   when a dispose()/closeGenFds() landed during that await, so a closed gen can never be
 *   observed half-advanced.
 * - Defect 3c: `closeGenFds` fires the root and pending closes IN PARALLEL behind the same
 *   `gen.closed` CAS — serially chained bounded closes could stack up to 2×HISTORY_CLOSE_MS
 *   per gen past a caller's hard deadline (`service.ts`'s dispose() additionally no longer
 *   awaits `GenStore.dispose()` past its own bound; see there).
 */
import { randomBytes } from "node:crypto";
import type { ReqDeadline } from "../../req-deadline.js";
import { errCodeOf, fdPath, HISTORY_DIR_OPEN_FLAGS, type HistoryFs, type HistoryHandle } from "./fs.js";
import { boundedClose, boundedFdOpen, historyStep, type HistoryIoGate } from "./budget.js";
import {
  HISTORY_DIR_LIMIT,
  HISTORY_ENUM_BUDGET_MS,
  HISTORY_ENUM_MIN_FILES,
  HISTORY_FILE_LIMIT,
  HISTORY_GEN_IDLE_MS,
  HISTORY_GEN_MAX,
  HISTORY_GEN_MAX_AGE_MS,
  HISTORY_GEN_REUSE_MS,
  HISTORY_IO_RETRY_MAX,
} from "./budget.js";
import { createGenLock, withGenLock, type GenLock } from "./lock.js";
import type { FdLedger } from "./fd-ledger.js";

export interface DirRef {
  readonly name: string;
  readonly dev: number;
  readonly ino: number;
}

export interface FileStat {
  readonly key: string; // "<dir>/<file>"
  readonly dir: DirRef;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

interface PendingDir {
  ref: DirRef;
  handle: HistoryHandle;
  names: readonly string[];
  next: number;
}

export interface GenEnumStats {
  complete: boolean;
  dirsDone: number;
  dirsTotal: number;
  dirsSkipped: number;
  dirsTruncated: boolean;
  filesTruncated: boolean;
}

export interface GenSnapshot {
  genId: string;
  createdAt: number;
  R: string;
  rootFd: number;
  files: readonly FileStat[];
  skipped: number;
  changed: number;
  invalid: number;
  vanished: number;
  enum: GenEnumStats;
}

interface Gen {
  genId: string;
  createdAt: number;
  lastUsed: number;
  R: string;
  rootHandle: HistoryHandle;
  root: { dev: number; ino: number };
  dirs: readonly string[];
  dirsTruncated: boolean;
  cursorDir: number;
  pending?: PendingDir | undefined;
  files: FileStat[];
  filesTruncated: boolean;
  complete: boolean;
  enumRetry: Map<string, number>;
  ioFailures: Map<string, number>;
  dirsSkipped: number;
  filesSkipped: number;
  changed: number;
  skipped: number;
  invalid: number;
  vanished: number;
  lock: GenLock;
  active: number;
  retired: boolean;
  closed: boolean;
  everPaged: boolean;
  sorted: boolean;
}

export type AdvanceResult = { partial?: { reason: "budget" | "io" | "zombie" | "busy" } };

export interface GenHandle {
  readonly genId: string;
  advance(deadline: ReqDeadline): Promise<AdvanceResult>;
  snapshot(): GenSnapshot;
  /** Record a successful header-index consumption of `files[pos]` style pagination state is
   * owned by `index.ts`; this file only tracks ENUMERATION-time `ioFailures` via
   * `recordPagingFailure`/`recordPagingSuccess` so the skip accounting (`stats.skipped`) stays
   * in one place. */
  recordPagingFailure(key: string): { skipped: boolean };
  recordPagingSuccess(key: string): void;
  recordInvalid(): void;
  recordVanished(): void;
  recordChanged(): void;
  /** PD23: sort `files[]` globally exactly once, and ONLY if this gen reached `complete` before
   * any page was ever emitted for it (`!everPaged`). A no-op otherwise (idempotent). */
  trySortIfFreshComplete(): void;
  /** Mark that a page has now been emitted for this gen — after this, `trySortIfFreshComplete`
   * can never fire (cursor positions already handed out must stay meaningful). */
  markPaged(): void;
  /** Finding 4 (c2) fix: the SAME per-gen lock `advance()` uses, for callers (`index.ts`'s
   * per-file paging loop) that need to mutate gen-owned counters/flags outside of `advance()`
   * itself. `mutate()` runs synchronously, inside the lock, ONLY if the gen is still valid at
   * that moment — `{ ok: false }` means it did NOT run (lock-acquire timed out, or the gen was
   * disposed/closed while queued): the caller must treat that exactly like a `busy` partial
   * (stop paging, do not advance its own cursor, do not claim the file as consumed). */
  commitPaging<T>(remainingMs: number, mutate: () => T): Promise<{ ok: true; value: T } | { ok: false }>;
  release(): void;
}

export interface GenStoreDeps {
  agentDir: string;
  uid: number;
  fs: HistoryFs;
  gate: HistoryIoGate;
  ledger: FdLedger;
  now(): number;
}

export type AcquireResult = { kind: "gen"; handle: GenHandle } | { kind: "expired" } | { kind: "create-failed" };

export interface GenStore {
  acquire(cursor: { genId: string; pos: number } | undefined, deadline: ReqDeadline): Promise<AcquireResult>;
  /** Finding 6 fix: sync, idempotent — mark every resident gen retired without closing
   * anything. `service.ts`'s dispose() calls this FIRST, then polls `hasActiveLeases()` under
   * its own shared hard deadline before eventually calling `dispose()` to force everything
   * closed. */
  retireAll(): void;
  /** Finding 6 fix: sync — `true` while any resident gen still has an unreleased lease
   * (`active > 0`), regardless of `retired`. */
  hasActiveLeases(): boolean;
  /** The simple, immediate, idempotent force-close primitive it always was — retires + closes
   * every resident gen RIGHT NOW, with no waiting for leases (a caller that wants to wait for
   * leases first does so itself, via `retireAll()`/`hasActiveLeases()`, before calling this). */
  dispose(): Promise<void>;
}

function randomGenId(): string {
  return randomBytes(8).toString("base64url").slice(0, 11);
}

export function createGenStore(deps: GenStoreDeps): GenStore {
  const gens = new Map<string, Gen>();
  let disposed = false;
  const closeDeps = { gate: deps.gate, now: deps.now };
  const openDeps = { gate: deps.gate, ledger: deps.ledger, now: deps.now };

  function isValid(gen: Gen): boolean {
    return !disposed && !gen.closed;
  }

  async function closeGenFds(gen: Gen): Promise<void> {
    if (gen.closed) return; // CAS: at most one caller ever flips this
    gen.closed = true;
    const pending = gen.pending;
    gen.pending = undefined;
    // Defect 3c: both closes fire AT ONCE — a serial root→pending chain could stack up to
    // 2×HISTORY_CLOSE_MS per gen past a caller's hard deadline. Each close is still individually
    // bounded (`boundedClose`) and each ledger reservation is released exactly once as its own
    // close settles.
    await Promise.all([
      boundedClose(() => gen.rootHandle.close(), closeDeps).then(() => {
        deps.ledger.release(1, "gen");
      }),
      pending !== undefined
        ? boundedClose(() => pending.handle.close(), closeDeps).then(() => {
            deps.ledger.release(1, "gen");
          })
        : Promise.resolve(),
    ]);
  }

  function sweepIdle(): void {
    const now = deps.now();
    for (const gen of gens.values()) {
      if (gen.retired || gen.active > 0) continue;
      const idle = now - gen.lastUsed > HISTORY_GEN_IDLE_MS;
      const aged = now - gen.createdAt > HISTORY_GEN_MAX_AGE_MS;
      if (idle || aged) {
        gen.retired = true;
        void closeGenFds(gen).then(() => gens.delete(gen.genId));
      }
    }
  }

  function evictOverLimit(): void {
    while (gens.size > HISTORY_GEN_MAX) {
      let lru: Gen | undefined;
      for (const gen of gens.values()) {
        if (gen.retired || gen.active > 0) continue;
        if (lru === undefined || gen.lastUsed < lru.lastUsed) lru = gen;
      }
      if (lru === undefined) break; // every gen still active — accept the transient overcount
      lru.retired = true;
      const victim = lru;
      void closeGenFds(victim).then(() => gens.delete(victim.genId));
    }
  }

  function latestGen(): Gen | undefined {
    let best: Gen | undefined;
    for (const gen of gens.values()) {
      if (gen.retired) continue;
      if (best === undefined || gen.createdAt > best.createdAt) best = gen;
    }
    return best;
  }

  async function createGen(deadline: ReqDeadline): Promise<Gen | undefined> {
    const budgetMs = Math.min(HISTORY_ENUM_BUDGET_MS, deadline.remaining());
    if (budgetMs <= 0) return undefined;
    const deadlineAt = deps.now() + budgetMs;
    const step = <T>(lazy: () => Promise<T>): Promise<T> => historyStep(deps.gate, lazy, deadlineAt, deps.now);

    let R: string;
    try {
      R = await step(() => deps.fs.realpath(`${deps.agentDir}/sessions`));
    } catch {
      return undefined;
    }

    const openRes = await boundedFdOpen(1, "gen", () => deps.fs.open(R, HISTORY_DIR_OPEN_FLAGS), deadlineAt, openDeps);
    if (!openRes.ok) return undefined; // busy/deadline/error — boundedFdOpen already released
    const rootHandle = openRes.handle;

    let root: { dev: number; ino: number };
    try {
      const st = await step(() => rootHandle.stat());
      if (!st.isDirectory() || st.uid !== deps.uid) throw new Error("sessionsRoot invalid");
      root = { dev: st.dev, ino: st.ino };
    } catch {
      await boundedClose(() => rootHandle.close(), closeDeps);
      deps.ledger.release(1, "gen");
      return undefined;
    }

    let dirs: string[];
    let dirsTruncated = false;
    try {
      const ents = await step(() => deps.fs.readdir(fdPath(rootHandle.fd), { withFileTypes: true }));
      dirs = ents.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      await boundedClose(() => rootHandle.close(), closeDeps);
      deps.ledger.release(1, "gen");
      return undefined;
    }
    if (dirs.length > HISTORY_DIR_LIMIT) {
      dirs = dirs.slice(0, HISTORY_DIR_LIMIT);
      dirsTruncated = true;
    }

    const gen: Gen = {
      genId: randomGenId(),
      createdAt: deps.now(),
      lastUsed: deps.now(),
      R,
      rootHandle,
      root,
      dirs,
      dirsTruncated,
      cursorDir: 0,
      files: [],
      filesTruncated: false,
      complete: dirs.length === 0,
      enumRetry: new Map(),
      ioFailures: new Map(),
      dirsSkipped: 0,
      filesSkipped: 0,
      changed: 0,
      skipped: 0,
      invalid: 0,
      vanished: 0,
      lock: createGenLock(),
      active: 0,
      retired: false,
      closed: false,
      everPaged: false,
      sorted: false,
    };
    gens.set(gen.genId, gen);
    evictOverLimit();
    return gen;
  }

  function toSnapshot(gen: Gen): GenSnapshot {
    return {
      genId: gen.genId,
      createdAt: gen.createdAt,
      R: gen.R,
      rootFd: gen.rootHandle.fd,
      files: gen.files,
      skipped: gen.skipped + gen.filesSkipped,
      changed: gen.changed,
      invalid: gen.invalid,
      vanished: gen.vanished,
      enum: {
        complete: gen.complete,
        dirsDone: gen.cursorDir,
        dirsTotal: gen.dirs.length,
        dirsSkipped: gen.dirsSkipped,
        dirsTruncated: gen.dirsTruncated,
        filesTruncated: gen.filesTruncated,
      },
    };
  }

  /** One continuable enumeration step, guarded end-to-end by `gen.lock`. */
  async function advanceLocked(gen: Gen, deadline: ReqDeadline): Promise<AdvanceResult> {
    const result = await withGenLock(gen.lock, deadline.remaining(), async () => {
      return runAdvance(gen, deadline);
    });
    if (!result.ok) return { partial: { reason: "busy" } };
    return result.value;
  }

  /** `true` ⇒ consumed by 3rd consecutive failure (caller should advance past it); `false` ⇒
   * the count was recorded but has not yet reached the threshold (caller must NOT advance). */
  function recordRecoverable(map: Map<string, number>, key: string): boolean {
    const n = (map.get(key) ?? 0) + 1;
    if (n >= HISTORY_IO_RETRY_MAX) {
      map.delete(key);
      return true;
    }
    map.set(key, n);
    return false;
  }

  /**
   * Finding 4 (c1) fix: every mutation this function would otherwise make directly on `gen.*`
   * instead accumulates into the local vars declared here, through the whole loop. `isValid(gen)`
   * is rechecked after every await — UNCHANGED from the previous pass — but a failure now
   * `abandon()`s (closes/releases ONLY a fresh-opened, not-yet-committed dir fd; writes nothing
   * to `gen.*`) instead of mutating partway through. Every OTHER return path routes through
   * `commit()`, which writes the entire staged mirror back onto `gen.*` in one synchronous
   * block — functionally equivalent to the previous pass's incremental-but-rechecked writes
   * (the observable end state at each return point is identical), but with a single auditable
   * commit boundary instead of writes scattered through the function body.
   */
  async function runAdvance(gen: Gen, deadline: ReqDeadline): Promise<AdvanceResult> {
    if (gen.complete) return {};
    const overallBudget = Math.min(HISTORY_ENUM_BUDGET_MS, deadline.remaining());
    const deadlineAt = deps.now() + overallBudget;
    const step = <T>(lazy: () => Promise<T>): Promise<T> => historyStep(deps.gate, lazy, deadlineAt, deps.now);
    let dirsDone = 0;
    let filesDone = 0;
    let errors = 0;

    // ---- staged mirror of every gen.* field this call may change ----
    let cursorDir = gen.cursorDir;
    let complete: boolean = gen.complete;
    let filesTruncated = gen.filesTruncated;
    let changed = gen.changed;
    let invalid = gen.invalid;
    let vanished = gen.vanished;
    let dirsSkipped = gen.dirsSkipped;
    let filesSkipped = gen.filesSkipped;
    const newFiles: FileStat[] = [];
    const enumRetry = new Map(gen.enumRetry);
    // A value-copy of `gen.pending` — `next` is tracked as its OWN local var so advancing it
    // never mutates a pre-existing, not-yet-committed `gen.pending` object in place.
    let pendingRef = gen.pending?.ref;
    let pendingHandle = gen.pending?.handle;
    let pendingNames = gen.pending?.names;
    let pendingNext = gen.pending?.next ?? 0;
    let pendingFresh = false; // true once THIS call opened a NEW dir (not inherited)

    const minimumMet = (): boolean => dirsDone >= 1 || filesDone >= HISTORY_ENUM_MIN_FILES || errors >= 1;
    const overBudget = (): boolean => deps.now() >= deadlineAt || deadline.expired();

    const recordRecoverableStaged = (key: string): boolean => recordRecoverable(enumRetry, key);

    // Pre-existing `gen.rootHandle`/`gen.pending` (inherited, never reassigned by THIS call
    // unless committed) is dispose()'s job — never touched here. Only a FRESH dir handle this
    // call itself opened is ours to clean up on abandonment.
    const abandon = async (): Promise<AdvanceResult> => {
      if (pendingFresh && pendingHandle !== undefined) {
        const h = pendingHandle;
        pendingHandle = undefined;
        pendingFresh = false;
        await boundedClose(() => h.close(), closeDeps);
        deps.ledger.release(1, "gen");
      }
      return { partial: { reason: "busy" } };
    };

    const commit = (result: AdvanceResult): AdvanceResult => {
      // Defect 2: the validity recheck happens HERE — after whatever await preceded this call
      // (in particular the awaited closes below: the pending-dir close and the filesTruncated
      // close) and BEFORE the first `gen.*` write. A dispose()/closeGenFds() that landed while
      // such an await was pending makes this call discard the ENTIRE staged mirror (nothing is
      // written to `gen.*`) and end `partial busy`; the one fd this call opened fresh is still
      // cleaned up fire-and-forget via abandon() (the store is being torn down anyway).
      if (!isValid(gen)) {
        void abandon();
        return { partial: { reason: "busy" } };
      }
      gen.cursorDir = cursorDir;
      gen.complete = complete;
      gen.filesTruncated = filesTruncated;
      gen.changed = changed;
      gen.invalid = invalid;
      gen.vanished = vanished;
      gen.dirsSkipped = dirsSkipped;
      gen.filesSkipped = filesSkipped;
      if (newFiles.length > 0) gen.files.push(...newFiles);
      gen.enumRetry = enumRetry;
      gen.pending =
        pendingHandle === undefined || pendingRef === undefined || pendingNames === undefined
          ? undefined
          : { ref: pendingRef, handle: pendingHandle, names: pendingNames, next: pendingNext };
      return result;
    };

    while (!complete) {
      if (!isValid(gen)) return abandon();
      if (overBudget() && minimumMet()) return commit({ partial: { reason: "budget" } });

      if (pendingHandle === undefined) {
        const dirName = gen.dirs[cursorDir];
        if (dirName === undefined) {
          complete = true;
          break;
        }
        const openRes = await boundedFdOpen(
          1,
          "gen",
          () => deps.fs.open(fdPath(gen.rootHandle.fd, dirName), HISTORY_DIR_OPEN_FLAGS),
          deadlineAt,
          openDeps,
        );
        if (!isValid(gen)) {
          if (openRes.ok) {
            const h = openRes.handle;
            await boundedClose(() => h.close(), closeDeps);
            deps.ledger.release(1, "gen");
          }
          return abandon();
        }
        if (!openRes.ok) {
          if (openRes.reason === "busy") return commit({ partial: { reason: "busy" } });
          const code = openRes.reason === "error" ? errCodeOf(openRes.err) : undefined;
          if (code === "ENOENT") {
            cursorDir += 1;
            dirsDone += 1;
            continue;
          }
          if (code === "ENOTDIR" || code === "ELOOP") {
            cursorDir += 1;
            changed += 1;
            dirsDone += 1;
            continue;
          }
          // `reason === "deadline"` (boundedFdOpen's own race timed out) is treated the same as
          // any other unrecognized transient error — the same consecutive-retry-then-consume
          // semantics apply (unchanged from the previous pass).
          if (recordRecoverableStaged(dirName)) {
            cursorDir += 1;
            dirsSkipped += 1;
            dirsDone += 1;
            continue;
          }
          errors += 1;
          return commit({ partial: { reason: "io" } });
        }
        const handle = openRes.handle;
        let ref: DirRef;
        let names: string[];
        try {
          const st = await step(() => handle.stat());
          if (!st.isDirectory() || st.uid !== deps.uid) {
            throw Object.assign(new Error("dir replaced"), { code: "ENOTDIR" });
          }
          ref = { name: dirName, dev: st.dev, ino: st.ino };
          if (!isValid(gen)) {
            await boundedClose(() => handle.close(), closeDeps);
            deps.ledger.release(1, "gen");
            return abandon();
          }
          const ents = await step(() => deps.fs.readdir(fdPath(handle.fd), { withFileTypes: true }));
          names = ents.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => e.name);
        } catch (err) {
          await boundedClose(() => handle.close(), closeDeps);
          deps.ledger.release(1, "gen");
          if (!isValid(gen)) return abandon();
          const code = errCodeOf(err);
          if (code === "ENOENT") {
            cursorDir += 1;
            dirsDone += 1;
            continue;
          }
          if (code === "ENOTDIR" || code === "ELOOP") {
            cursorDir += 1;
            changed += 1;
            dirsDone += 1;
            continue;
          }
          if (recordRecoverableStaged(dirName)) {
            cursorDir += 1;
            dirsSkipped += 1;
            dirsDone += 1;
            continue;
          }
          errors += 1;
          return commit({ partial: { reason: "io" } });
        }
        if (!isValid(gen)) {
          await boundedClose(() => handle.close(), closeDeps);
          deps.ledger.release(1, "gen");
          return abandon();
        }
        pendingRef = ref;
        pendingHandle = handle;
        pendingNames = names;
        pendingNext = 0;
        pendingFresh = true;
      }

      const names = pendingNames;
      while (names !== undefined && pendingNext < names.length) {
        if (!isValid(gen)) return abandon();
        if (gen.files.length + newFiles.length >= HISTORY_FILE_LIMIT) {
          filesTruncated = true;
          const h = pendingHandle;
          pendingHandle = undefined;
          if (h !== undefined) {
            await boundedClose(() => h.close(), closeDeps);
            deps.ledger.release(1, "gen");
          }
          cursorDir = gen.dirs.length; // stop enumerating further dirs entirely
          complete = true;
          return commit({});
        }
        const name = names[pendingNext];
        if (name === undefined || pendingHandle === undefined || pendingRef === undefined) break;
        const dirFd = pendingHandle.fd;
        const dirRef = pendingRef;
        const key = `${dirRef.name}/${name}`;
        try {
          const st = await step(() => deps.fs.lstat(fdPath(dirFd, name)));
          if (!isValid(gen)) return abandon();
          if (st.isSymbolicLink() || !st.isFile()) {
            invalid += 1;
          } else {
            newFiles.push({ key, dir: dirRef, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs });
          }
          enumRetry.delete(key);
          pendingNext += 1;
          filesDone += 1;
        } catch (err) {
          if (!isValid(gen)) return abandon();
          const code = errCodeOf(err);
          if (code === "ENOENT") {
            vanished += 1;
            enumRetry.delete(key);
            pendingNext += 1;
            filesDone += 1;
            continue;
          }
          if (recordRecoverableStaged(key)) {
            filesSkipped += 1;
            pendingNext += 1;
            filesDone += 1;
            continue;
          }
          errors += 1;
          return commit({ partial: { reason: "io" } });
        }
        if (overBudget() && minimumMet()) return commit({ partial: { reason: "budget" } });
      }

      if (pendingHandle !== undefined && pendingNames !== undefined && pendingNext >= pendingNames.length) {
        const h = pendingHandle;
        await boundedClose(() => h.close(), closeDeps);
        deps.ledger.release(1, "gen");
        pendingHandle = undefined;
        cursorDir += 1;
        dirsDone += 1;
      }
      complete = cursorDir >= gen.dirs.length && pendingHandle === undefined;
    }
    return commit({});
  }

  function makeHandle(gen: Gen): GenHandle {
    let released = false;
    return {
      genId: gen.genId,
      advance: (deadline) => advanceLocked(gen, deadline),
      snapshot: () => toSnapshot(gen),
      recordPagingFailure(key: string): { skipped: boolean } {
        const skipped = recordRecoverable(gen.ioFailures, key);
        if (skipped) gen.skipped += 1;
        return { skipped };
      },
      recordPagingSuccess(key: string): void {
        gen.ioFailures.delete(key);
      },
      recordInvalid(): void {
        gen.invalid += 1;
      },
      recordVanished(): void {
        gen.vanished += 1;
      },
      recordChanged(): void {
        gen.changed += 1;
      },
      trySortIfFreshComplete(): void {
        if (gen.everPaged || gen.sorted || !gen.complete) return;
        gen.sorted = true;
        gen.files.sort((a, b) =>
          b.mtimeMs !== a.mtimeMs ? b.mtimeMs - a.mtimeMs : a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
        );
      },
      markPaged(): void {
        gen.everPaged = true;
      },
      async commitPaging<T>(remainingMs: number, mutate: () => T): Promise<{ ok: true; value: T } | { ok: false }> {
        const outcome = await withGenLock(gen.lock, remainingMs, () => {
          if (!isValid(gen)) return { invalid: true as const };
          return { invalid: false as const, value: mutate() };
        });
        if (!outcome.ok) return { ok: false };
        if (outcome.value.invalid) return { ok: false };
        return { ok: true, value: outcome.value.value };
      },
      release(): void {
        if (released) return;
        released = true;
        gen.active = Math.max(0, gen.active - 1);
        gen.lastUsed = deps.now();
        if (gen.retired && gen.active === 0) {
          void closeGenFds(gen).then(() => gens.delete(gen.genId));
        }
      },
    };
  }

  return {
    async acquire(cursor, deadline): Promise<AcquireResult> {
      sweepIdle();
      let gen: Gen | undefined;
      if (cursor !== undefined) {
        const found = gens.get(cursor.genId);
        if (found === undefined || found.retired || found.closed) return { kind: "expired" };
        gen = found;
      } else {
        const latest = latestGen();
        if (latest !== undefined && !latest.complete) {
          gen = latest;
        } else if (latest !== undefined && deps.now() - latest.createdAt < HISTORY_GEN_REUSE_MS) {
          gen = latest;
        } else {
          gen = await createGen(deadline);
          if (gen === undefined) return { kind: "create-failed" };
        }
      }
      gen.active += 1;
      gen.lastUsed = deps.now();
      return { kind: "gen", handle: makeHandle(gen) };
    },
    retireAll(): void {
      for (const gen of gens.values()) gen.retired = true;
    },
    hasActiveLeases(): boolean {
      for (const gen of gens.values()) {
        if (gen.active > 0) return true;
      }
      return false;
    },
    async dispose(): Promise<void> {
      disposed = true;
      for (const gen of gens.values()) gen.retired = true;
      await Promise.all(Array.from(gens.values()).map((gen) => closeGenFds(gen)));
      gens.clear();
    },
  };
}
