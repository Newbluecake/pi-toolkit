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
  /** Registers (or re-registers) this session's bash job manager. Generation is monotonic per sessionId (starts at 1, survives re-registration). Registering into an already-sealed sessionId immediately calls the new entry's `onSealed()` (defensive: the session is ending regardless of registration order) and does not retain the entry for a future `sealAndKill`. */
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
   * (irreversible), synchronously reads `exitFacts()` + calls `onSealed()` on
   * the registered entry (if any) and starts `killAll` (NOT awaited — the
   * returned `done` promise is for the caller to observe, never to block
   * on). Every subsequent call for the same sessionId returns `undefined`.
   * A sessionId with no registered entry still becomes sealed on first call
   * (so a late `register()` for it is treated as already-sealed) but the
   * call itself returns `undefined` (nothing to report or kill).
   */
  sealAndKill(sessionId: string, graceMs: number): { facts: RunExitFacts; done: Promise<KillAllReport> } | undefined;
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
  private readonly sealResults = new Map<string, { facts: RunExitFacts; done: Promise<KillAllReport> }>();
  private readonly sealWaiters = new Map<string, Array<() => void>>();
  private readonly capabilities = new Map<string, { version: number; count: number }>();

  register(entry: Omit<ChildBashEntry, "generation">): { generation: number; unregister(): void } {
    const generation = (this.generations.get(entry.sessionId) ?? 0) + 1;
    fifoSet(this.generations, entry.sessionId, generation, REGISTRY_CAP);
    const full: ChildBashEntry = { ...entry, generation };
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

  sealAndKill(sessionId: string, graceMs: number): { facts: RunExitFacts; done: Promise<KillAllReport> } | undefined {
    if (this.sealed.has(sessionId)) return undefined;
    this.sealed.add(sessionId);
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
