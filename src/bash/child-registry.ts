import type { RunExitFacts } from "../core/types.js";

/**
 * bash-timeout-grace plan §3.1 (P0b, frozen surface): the process-level
 * registry a child (subagent) session's bash job manager registers itself
 * into, and the runner's `sealBeforeTerminal` (src/runtime/runner.ts) reads
 * through the host side (`src/stack.ts`, a later package) to fold a run's
 * exit-time bash job facts into `diag.exitFacts` and to kill any jobs still
 * running when the run ends.
 *
 * **No pi imports** (I1-style layering, mirrors `src/core/`) — this module
 * only coordinates plain objects supplied by the caller (`ChildBashEntry`,
 * `HostRunView`); the actual bash process/job-store machinery lives entirely
 * in `src/bash/manager.ts` + `src/bash/child.ts` (later packages).
 *
 * **No module-scope mutable state** (AGENTS.md: the extension re-activates on
 * `/reload` in the same process without busting Node's module cache). The
 * registry singleton lives behind `CHILD_BASH_REGISTRY_KEY` on `globalThis`
 * (the same `Symbol.for` pattern as the worktree-origin registry and the
 * shared job-store write chains) so every session (main + every child) that
 * imports this module in the same process shares exactly one instance,
 * survives `/reload`, and is trivially inert when the feature is off (nobody
 * ever registers an entry). `getChildBashRegistry()` builds it lazily and
 * caches it on that global slot; there is deliberately no `reset()` — a
 * `/reload` must NOT drop bookkeeping for sessions that are still alive
 * across the reload (their entries would otherwise silently vanish from the
 * registry while their manager/process is still running).
 */
export const CHILD_BASH_REGISTRY_KEY = Symbol.for("pi-subagent:child-bash-jobs");

/**
 * host-view host-capability diagnostics (child-bash no-host-view diag plan,
 * L1 todo #20): the process-global name a HOST stack (`src/stack.ts`)
 * declares once its `attachHost` wiring is live (i.e. it is running code new
 * enough to ever call `registry.attachHost(...)`). A child session that
 * cannot find its host view checks this flag first: if the host never
 * declared it, the host is simply old, un-reloaded code with no wiring at
 * all — expected, not a bug, nothing worth recording. Only when the flag IS
 * declared but the view is still missing is that a genuine timing/wiring
 * problem worth a diagnostic. Versioned (not just a boolean) so a future
 * capability-shape change can be told apart from this one without a second
 * name.
 */
export const HOST_VIEW_CAPABILITY = "host-view";
export const HOST_VIEW_CAPABILITY_VERSION = 1;

/** Aggregate result of killing every non-terminal job of a sealed session (§3.3 S3). */
export interface KillAllReport {
  killed: string[];
  alreadyDone: string[];
  orphaned: string[];
  pending: string[];
}

/**
 * One child session's bash job manager, as registered into the registry.
 * Implemented by `src/bash/child.ts` (a later package) — this module only
 * calls these three methods, never reaches into bash manager internals.
 */
export interface ChildBashEntry {
  readonly sessionId: string;
  readonly generation: number;
  /** Synchronous, read-only snapshot of this session's bash jobs (running + not-yet-seen-by-the-agent finished ones). Must never throw (a throw is treated as "no facts"). */
  exitFacts(): RunExitFacts;
  /** Kill every non-terminal job of this session. Idempotent/memoized and internally bounded — the entry's own responsibility per §3.3 S3; the registry additionally applies a defensive backstop (see sealAndKill). Must never reject. */
  killAll(graceMs: number): Promise<KillAllReport>;
  /** Synchronous: stop admitting new jobs (`manager.reserve()`'s `admit()` check, §3.6 S1) and wake up any settle-hold wait (§3.5). Must never throw. */
  onSealed(): void;
}

/**
 * Read-only view of the parent (host) run driving a child session, attached
 * by the host side (`src/stack.ts`) once the child's `sessionId` is first
 * observed on `RunnerDeps.onStateChange`. Consumed by the (later) settle-hold
 * hook and the auto-background return-time budget (§3.5/§3.6) — this module
 * only stores and hands it back, it never calls through it itself.
 */
export interface HostRunView {
  readonly runId: string;
  /** Same source as the watchdog's own sub-phase due date (E2), combined with effectiveDeadlineAt — whichever is sooner. */
  watchdogDueAt(): number | undefined;
  /** state.deadlines.hardDeadlineAt (E32) — frozen at enqueue, the §3.5 round-budget's H. */
  hardDeadlineAt(): number | undefined;
  /** settings.budget.maxExtensions (E32) — the §3.5 round-budget's E. */
  maxExtensions(): number;
  stopping(): boolean;
  /** §3.6 boundary telemetry: the child bash tool reports the instant it returned control (R) for a given tool call; the host correlates it against that toolCallId's later tool_end to measure return lag. */
  noteToolReturn(toolCallId: string, at: number): void;
}

export interface ChildBashRegistry {
  /** Registers (or re-registers) this session's bash job manager. Generation is monotonic per sessionId (starts at 1, survives re-registration). Registering into an already-sealed sessionId immediately calls the new entry's `onSealed()` (defensive: the session is ending regardless of registration order) and does not retain the entry for a future `sealAndKill` -- UNLESS a resume has since attached a host view for that sessionId under a different runId than the one that sealed it (todo #30: `sealed` never auto-expires by itself, and a resumed run reuses its prior run's exact sessionId, so this is the only signal that tells "still the same, already-ending run" apart from "a brand-new run that happens to share this sessionId"), in which case the stale seal is cleared first and registration proceeds normally. */
  register(entry: Omit<ChildBashEntry, "generation">): { generation: number; unregister(): void };
  attachHost(sessionId: string, view: HostRunView): void;
  hostView(sessionId: string): HostRunView | undefined;
  /**
   * Declares a process-wide host capability (see `HOST_VIEW_CAPABILITY`
   * above). Reference-counted, not last-build-wins: `src/stack.ts` rebuilds
   * its stack sequentially (previous stack disposed at the top of the next
   * build, per AGENTS.md), but a defensive rebuild or a test harness that
   * builds more than one stack in the same process must not have the
   * SECOND build's dispose accidentally clear the capability out from under
   * a still-live FIRST stack (or vice versa) — counting handles that
   * correctly regardless of build/dispose interleaving, whereas "last build
   * wins" would not. Returns a release function; calling it more than once
   * is a no-op (idempotent, matching every other dispose() in this
   * codebase).
   */
  declareHostCapability(name: string, version: number): () => void;
  /** True once ANY currently-live declaration of `name` exists (see `declareHostCapability`). */
  hasHostCapability(name: string): boolean;
  /** True once `sessionId` is sealed AND no fresher (resumed) run has since attached a host view for it (todo #30: same stale-seal check as `register()` -- a resume's own `admit()` closure calls this directly, so the check has to live here too, not only in `register()`). A stale hit clears the seal as a side effect (permanent unseal, not a one-off answer). */
  isSealed(sessionId: string): boolean;
  /** Resolves once this sessionId is sealed (immediately if already sealed). Never rejects.
   *
   * Bounded degradation (review follow-up): the waiter map is FIFO-capped at
   * `REGISTRY_CAP` sessionIds like every other bookkeeping map here — a
   * sessionId that never seals (or seals only after its tombstone was itself
   * evicted, see `sealAndKill`) must not pin waiters for the life of the
   * process. When the oldest key is evicted, its waiters are RESOLVED early:
   * a `whenSealed` promise never stays pending forever (zero-hang). Consumers
   * must treat resolution as a wake-up to re-check, never as proof that the
   * session actually sealed (the §3.5 settle-hold race does exactly that). */
  whenSealed(sessionId: string): Promise<void>;
  /**
   * Synchronous, idempotent per sessionId: the FIRST call seals the session
   * (irreversible for THIS run), synchronously reads `exitFacts()` + calls
   * `onSealed()` on the registered entry (if any) and starts `killAll` (NOT
   * awaited -- the returned `done` promise is for the caller to observe,
   * never to block on). Every subsequent call for the same sessionId AND the
   * same run returns `undefined`.
   * A sessionId with no registered entry still becomes sealed on first call
   * (so a late `register()` for it is treated as already-sealed) but the
   * call itself returns `undefined` (nothing to report or kill).
   * `runId` (todo #30, optional for back-compat) records which run caused
   * this seal; a LATER call for the same sessionId under a DIFFERENT runId
   * (a resume reusing this sessionId) is treated as a fresh seal for that
   * new run -- not the idempotent no-op above -- since `register()`/
   * `isSealed()` already unseal a resumed run's session as soon as its own
   * host view attaches, well before it would ever reach here.
   * P1 review fix (§3.3/§3.9): the opposite direction is ALSO guarded --
   * when THIS CALL's own `runId` no longer matches the runId currently
   * `attachHost`-ed for `sessionId` (i.e. a fresher run has since attached,
   * so this call itself is the stale one -- the classic shape is `onReaped`'s
   * defensive fan-out for an old run arriving after a resume's host view is
   * already live), the call is a total no-op: it returns `undefined` without
   * touching `sealed`/`entries`/`sealedRunId` for `sessionId` at all, never
   * re-sealing or killing whatever is currently registered there (which, by
   * then, can only ever be the NEWER run's own entry).
   */
  sealAndKill(
    sessionId: string,
    graceMs: number,
    runId?: string,
  ): { facts: RunExitFacts; done: Promise<KillAllReport> } | undefined;
  /** Best-effort fan-out of sealAndKill to every currently-registered (not yet sealed) entry, bounded by graceMs (session_shutdown, S6). Never rejects. */
  sealAll(graceMs: number): Promise<void>;
}

/** Bounds every FIFO-capped bookkeeping map below (unbounded growth over a long-lived process is the failure mode being capped, not a functional requirement — see the module doc). */
export const REGISTRY_CAP = 512;
/** §3.3 S3's own bound is per-job; this is the registry's defensive backstop on the aggregate `killAll` call so a misbehaving entry can never hang sealAndKill's caller forever (AGENTS.md zero-hang). */
export const KILL_ALL_BACKSTOP_MARGIN_MS = 3_000;

const EMPTY_REPORT: KillAllReport = { killed: [], alreadyDone: [], orphaned: [], pending: [] };

/** Insertion-ordered Map used as a FIFO-capped cache: evicts the oldest entry(ies) once `cap` is exceeded. Returns the evicted `[key, value]` pairs (empty when nothing was evicted) so callers can land bounded degradation safely (e.g. resolving evicted seal waiters instead of leaving them pending). */
function fifoSet<V>(map: Map<string, V>, key: string, value: V, cap: number): Array<[string, V]> {
  const evicted: Array<[string, V]> = [];
  if (map.has(key)) map.delete(key); // re-insert to refresh recency order
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    evicted.push([oldest.value, map.get(oldest.value)!]);
    map.delete(oldest.value);
  }
  return evicted;
}

class ChildBashRegistryImpl implements ChildBashRegistry {
  private readonly entries = new Map<string, { entry: ChildBashEntry; generation: number }>();
  private readonly generations = new Map<string, number>();
  private readonly hosts = new Map<string, HostRunView>();
  private readonly sealed = new Set<string>();
  // todo #30 fix: the runId that CAUSED sealAndKill(sessionId) to seal, so a
  // later register()/isSealed() for the SAME sessionId can tell apart "still
  // the same (already-sealed) run" from "a brand-new run that reused this
  // sessionId" (resume — pi's `SessionManager.open()` reads the session file's
  // own header `id`, so resuming a session file always reproduces the exact
  // same sessionId the prior run had). `sealed` itself deliberately stays a
  // simple Set (isSealed()/whenSealed() keep their existing O(1) semantics for
  // the still-live/still-sealed case) — this map is consulted ONLY at the two
  // points that would otherwise treat a resumed run as permanently sealed.
  private readonly sealedRunId = new Map<string, string>();
  private readonly sealResults = new Map<string, { facts: RunExitFacts; done: Promise<KillAllReport> }>();
  private readonly sealWaiters = new Map<string, Array<() => void>>();
  private readonly capabilities = new Map<string, { version: number; count: number }>();

  /**
   * todo #30 fix: true when `sessionId` is sealed but a DIFFERENT runId has
   * since attached a host view for it (`attachHost`, called from
   * `onSessionSeen` on every state change of the run that owns that
   * sessionId, always with a fresh runId per spawn — including resume). That
   * combination is only possible when the run that caused the seal has ended
   * and a genuinely new run (a resume reusing the same session file/sessionId)
   * has since started; `sealBeforeTerminal`/`sealAndKill` never fire twice for
   * the SAME run (I-SEAL idempotency), so a same-run late register can never
   * observe a different runId here. Undefined `sealedRunId` (a seal recorded
   * before this fix shipped, or one whose bookkeeping entry was FIFO-evicted)
   * conservatively answers false — the pre-fix behavior — rather than risk
   * unsealing a session that might still be the same run.
   */
  private isStaleSealFromPriorRun(sessionId: string): boolean {
    const sealedFor = this.sealedRunId.get(sessionId);
    if (sealedFor === undefined) return false;
    const currentRunId = this.hosts.get(sessionId)?.runId;
    return currentRunId !== undefined && currentRunId !== sealedFor;
  }

  /** todo #30 fix: clears every sealed-bookkeeping trace of `sessionId` so it is admitted exactly like a never-sealed one. */
  private clearStaleSeal(sessionId: string): void {
    this.sealed.delete(sessionId);
    this.sealedRunId.delete(sessionId);
    this.sealResults.delete(sessionId);
  }

  register(entry: Omit<ChildBashEntry, "generation">): { generation: number; unregister(): void } {
    const generation = (this.generations.get(entry.sessionId) ?? 0) + 1;
    fifoSet(this.generations, entry.sessionId, generation, REGISTRY_CAP);
    const full: ChildBashEntry = { ...entry, generation };
    if (this.sealed.has(entry.sessionId) && this.isStaleSealFromPriorRun(entry.sessionId)) {
      // todo #30: a resume reusing this sessionId — the seal belongs to the
      // PRIOR run that already ended; this run is brand new and must be
      // admitted normally (fall through to the unsealed registration path
      // below), not treated as already-ending.
      this.clearStaleSeal(entry.sessionId);
    }
    if (this.sealed.has(entry.sessionId)) {
      // Already sealed (a race: the run ended before/while this session's
      // manager finished starting up) — this entry is never retained for a
      // future sealAndKill (there will not be one), but it must still stop
      // admitting new jobs immediately.
      try {
        full.onSealed();
      } catch {
        /* onSealed must never break registration */
      }
      return { generation, unregister: () => undefined };
    }
    // Bounded degradation (review follow-up): a very-late register whose
    // sealed tombstone was already FIFO-evicted (see sealAndKill) falls
    // through to here and IS retained. Safe, deliberately: sessionIds are
    // never reused, so this entry can never alias a different live session;
    // the only new observable is a possible SECOND sealAndKill for this id,
    // whose killAll the entry contractually memoizes (§3.3 S3/S4) — the
    // entry's own memoization, not registry bookkeeping, is what guarantees
    // at-most-one actual kill. unregister() keeps working unchanged.
    fifoSet(this.entries, entry.sessionId, { entry: full, generation }, REGISTRY_CAP);
    return {
      generation,
      unregister: () => {
        const current = this.entries.get(entry.sessionId);
        if (current && current.generation === generation) this.entries.delete(entry.sessionId);
      },
    };
  }

  attachHost(sessionId: string, view: HostRunView): void {
    // A pre-#30 host (or the quit-time sealAll fan-out) can leave a seal
    // without sealedRunId metadata. In that compatibility case, the old host
    // view is the only surviving evidence of which run owned the seal. A
    // different run attaching for the same sessionId is therefore sufficient
    // to prove a resume and must clear the legacy tombstone before the child
    // can lazily register its manager. This is deliberately done before
    // storing the new view so the same-run late-register rule remains sticky.
    const previous = this.hosts.get(sessionId);
    if (
      this.sealed.has(sessionId) &&
      previous?.runId !== undefined &&
      previous.runId !== view.runId &&
      this.sealedRunId.get(sessionId) === undefined
    ) {
      this.clearStaleSeal(sessionId);
    }
    fifoSet(this.hosts, sessionId, view, REGISTRY_CAP);
  }
  hostView(sessionId: string): HostRunView | undefined {
    return this.hosts.get(sessionId);
  }
  declareHostCapability(name: string, version: number): () => void {
    const current = this.capabilities.get(name);
    if (current) {
      current.count += 1;
      current.version = version;
    } else {
      this.capabilities.set(name, { version, count: 1 });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const entry = this.capabilities.get(name);
      if (!entry) return; // already dropped (e.g. by a defensive extra release) — nothing to do
      entry.count -= 1;
      if (entry.count <= 0) this.capabilities.delete(name);
    };
  }
  hasHostCapability(name: string): boolean {
    return (this.capabilities.get(name)?.count ?? 0) > 0;
  }
  isSealed(sessionId: string): boolean {
    // todo #30 fix: mirrors register()'s stale-seal detection so a resumed
    // run's manager (whose `admit()` closure calls this directly, not
    // through register()) never gets stuck refusing every job forever
    // because a prior run of this same sessionId sealed it. Mutates the
    // registry (clears the stale seal) so the effect is a permanent unseal,
    // not just a one-off answer — subsequent calls (from either the resumed
    // run's own admit() or a later register()) stay consistent.
    if (this.sealed.has(sessionId) && this.isStaleSealFromPriorRun(sessionId)) {
      this.clearStaleSeal(sessionId);
      return false;
    }
    return this.sealed.has(sessionId);
  }
  whenSealed(sessionId: string): Promise<void> {
    if (this.sealed.has(sessionId)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.sealWaiters.get(sessionId) ?? [];
      waiters.push(resolve);
      // Same FIFO cap as every other map (review follow-up): without it an
      // unknown sessionId's waiters accumulate forever. Eviction RESOLVES the
      // evicted waiters synchronously — no timer is involved anywhere in this
      // path (the module's only timer is boundedKillAll's unref'd backstop),
      // and a resolved-early waiter is the wake-only degradation documented
      // on ChildBashRegistry.whenSealed.
      for (const [, evictedWaiters] of fifoSet(this.sealWaiters, sessionId, waiters, REGISTRY_CAP)) {
        for (const w of evictedWaiters) {
          try {
            w();
          } catch {
            /* a waiter must never break registration */
          }
        }
      }
    });
  }

  sealAndKill(
    sessionId: string,
    graceMs: number,
    runId?: string,
  ): { facts: RunExitFacts; done: Promise<KillAllReport> } | undefined {
    // P1 review fix (todo #30 follow-up, §3.3/§3.9): if THIS CALL's own
    // runId no longer matches the runId currently attached for this
    // sessionId (`attachHost`, driven by `onSessionSeen` on every state
    // change — always ahead of any tool call/registration for that run),
    // the caller itself is stale: a resume has already attached a fresher
    // run's host view for this sessionId. This only happens for the
    // defensive, asynchronous `onReaped` fan-out (`src/stack.ts`) racing a
    // resume that started in the meantime — `sealBeforeTerminal` (the
    // runner's `finally` block) calls `sealSession`/`sealAndKill`
    // SYNCHRONOUSLY, strictly before the async `runReap().then(() =>
    // notifyReaped(...))` chain that fires `onReaped`, so the run's OWN
    // on-time seal (below, taken with the runId that WAS current at that
    // moment) has already sealed and killed its own entry/jobs by the time
    // this stale, redundant call could ever arrive. A stale caller is
    // therefore a total no-op: it must NOT touch `sealed`/`entries`/
    // `sealedRunId` for this sessionId at all — those now belong to the
    // newer, live run — and it must be checked BEFORE the stale-SEAL (as
    // opposed to stale-CALLER) handling below, which answers a different
    // question (whether the FLAG is stale, not whether THIS CALL is).
    // There is deliberately no attempt to salvage/kill the old run's own
    // entry here: by the time a newer host is attached, `entries` (keyed
    // only by sessionId) may already have been overwritten by the new run's
    // own `register()`, so reading it now could only ever observe the NEW
    // run's entry — never the old one — and touching it would risk exactly
    // the corruption this fix prevents.
    const currentRunId = this.hosts.get(sessionId)?.runId;
    if (runId !== undefined && currentRunId !== undefined && currentRunId !== runId) return undefined;
    // todo #30 fix: same stale-seal-from-a-prior-run check as isSealed()/
    // register() -- a direct sealAndKill call (session_shutdown's sealAll,
    // or the defensive onReaped/sealSession fan-out) must not treat a
    // resumed run's OWN termination as a no-op just because the sessionId
    // it reused was sealed by the run it resumed from.
    if (this.sealed.has(sessionId) && this.isStaleSealFromPriorRun(sessionId)) this.clearStaleSeal(sessionId);
    if (this.sealed.has(sessionId)) return undefined;
    this.sealed.add(sessionId);
    if (runId !== undefined) fifoSet(this.sealedRunId, sessionId, runId, REGISTRY_CAP);
    // Cap the sealed-set the same way as the live bookkeeping — a sessionId
    // is never reused, so evicting the oldest one only means a very old,
    // long-finished run's isSealed()/whenSealed() would (harmlessly) answer
    // as if it were never sealed; nothing still running can observe that.
    // The one second-order effect: an EXTREMELY late register() for that same
    // session (later than 512 other seals) is then retained as if fresh —
    // see register()'s retain-path comment for why that is still safe.
    if (this.sealed.size > REGISTRY_CAP) {
      const oldest = this.sealed.values().next();
      if (!oldest.done) this.sealed.delete(oldest.value);
    }
    const waiters = this.sealWaiters.get(sessionId);
    this.sealWaiters.delete(sessionId);
    for (const w of waiters ?? []) {
      try {
        w();
      } catch {
        /* a waiter must never break sealing */
      }
    }
    const registered = this.entries.get(sessionId);
    this.entries.delete(sessionId);
    if (!registered) return undefined;
    const { entry } = registered;
    try {
      entry.onSealed();
    } catch {
      /* onSealed must never break sealAndKill */
    }
    let facts: RunExitFacts;
    try {
      facts = entry.exitFacts();
    } catch {
      facts = { bashJobs: [] };
    }
    const done = this.boundedKillAll(entry, facts, graceMs);
    const result = { facts, done };
    fifoSet(this.sealResults, sessionId, result, REGISTRY_CAP);
    void done.finally(() => {
      // "条目在 done 后删除" (§3.1): once the kill settles there is nothing
      // left to report through this bookkeeping slot.
      const current = this.sealResults.get(sessionId);
      if (current === result) this.sealResults.delete(sessionId);
    });
    return result;
  }

  async sealAll(graceMs: number): Promise<void> {
    const sessionIds = [...this.entries.keys()];
    await Promise.all(
      sessionIds.map(async (id) => {
        const result = this.sealAndKill(id, graceMs);
        if (result) await result.done.catch(() => undefined);
      }),
    );
  }

  /**
   * Defensive backstop on top of the entry's own (already-bounded, per §3.3
   * S3) killAll: if it still has not settled within `graceMs +
   * KILL_ALL_BACKSTOP_MARGIN_MS`, this resolves anyway using the pre-seal
   * `facts` snapshot to classify every job that was non-terminal at seal
   * time ("terminating") as `pending`, everything else as `alreadyDone`.
   * `entry.killAll` keeps running in the background; its own eventual
   * settlement is not observed by anyone once this backstop has already
   * resolved (matches the rest of this codebase's "best-effort, never hang
   * the caller" posture for anything crossing a process boundary).
   */
  private boundedKillAll(entry: ChildBashEntry, facts: RunExitFacts, graceMs: number): Promise<KillAllReport> {
    const bound = Math.max(0, graceMs) + KILL_ALL_BACKSTOP_MARGIN_MS;
    return new Promise<KillAllReport>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const pending: string[] = [];
        const alreadyDone: string[] = [];
        for (const job of facts.bashJobs) (job.state === "terminating" ? pending : alreadyDone).push(job.jobId);
        resolve({ ...EMPTY_REPORT, alreadyDone, pending });
      }, bound);
      timer.unref?.();
      entry
        .killAll(graceMs)
        .then(
          (report) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(report);
          },
          () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(EMPTY_REPORT);
          },
        )
        .catch(() => undefined);
    });
  }
}

/** Lazily builds (or reuses, across `/reload`) the single process-wide registry instance. */
export function getChildBashRegistry(): ChildBashRegistry {
  const g = globalThis as Record<symbol, ChildBashRegistry | undefined>;
  const existing = g[CHILD_BASH_REGISTRY_KEY];
  if (existing) return existing;
  const created = new ChildBashRegistryImpl();
  g[CHILD_BASH_REGISTRY_KEY] = created;
  return created;
}

/**
 * Defensive host-side declare (child-bash no-host-view diag plan, L1 todo
 * #20): `registry` is the `Symbol.for` global singleton, so a host stack
 * running NEW code can still end up holding an OLD-shaped registry object
 * (whichever side called `getChildBashRegistry()` first in this process won
 * the singleton's shape). A missing method must never throw — it just means
 * this capability cannot be declared at all, which degrades to exactly the
 * old (no capability, always-silent) behavior everywhere that reads it.
 */
export function declareHostBashViewCapability(registry: ChildBashRegistry): () => void {
  const withCap = registry as Partial<ChildBashRegistry>;
  try {
    return typeof withCap.declareHostCapability === "function"
      ? withCap.declareHostCapability(HOST_VIEW_CAPABILITY, HOST_VIEW_CAPABILITY_VERSION)
      : () => undefined;
  } catch {
    return () => undefined;
  }
}

/**
 * Defensive child-side read counterpart to `declareHostBashViewCapability`
 * — same "old-shaped object, missing method" concern, this time on the read
 * path (§ per the plan: "子会话读取时用可选调用/typeof 检查"). Never throws;
 * an old/absent method reads as "not declared" (silent, matches an
 * un-reloaded host with no `attachHost` wiring at all).
 */
export function hostBashViewCapabilityDeclared(registry: ChildBashRegistry): boolean {
  const withCap = registry as Partial<ChildBashRegistry>;
  try {
    return typeof withCap.hasHostCapability === "function" ? withCap.hasHostCapability(HOST_VIEW_CAPABILITY) : false;
  } catch {
    return false;
  }
}
